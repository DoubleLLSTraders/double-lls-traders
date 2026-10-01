import type { IncomingMessage, ServerResponse } from "node:http";
import { resolve } from "node:path";
import type { Connect, Plugin } from "vite";
import { createApp } from "./app";
import { fileKv } from "./kv";

const BODY_LIMIT = 64_000;

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((ok, fail) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > BODY_LIMIT) {
        fail(Object.assign(new Error("Request too large."), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => ok(Buffer.concat(chunks)));
    req.on("error", fail);
  });
}

/** Serves the same /api routes as the Netlify function during `vite` and `vite preview`, stored in data/kv.json. */
export function apiPlugin(env: Record<string, string>): Plugin {
  const app = createApp(env, fileKv(resolve(env.ADMIN_DATA_DIR || resolve(process.cwd(), "data"), "kv.json")));

  const handler: Connect.NextHandleFunction = (req, res: ServerResponse, next) => {
    if (!req.url?.startsWith("/api/")) return next();
    void (async () => {
      try {
        const headers = new Headers();
        for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers.set(k, v);
        const hasBody = req.method !== "GET" && req.method !== "HEAD";
        const request = new Request(`http://${req.headers.host ?? "localhost"}${req.url}`, {
          method: req.method,
          headers,
          body: hasBody ? new Uint8Array(await readBody(req)) : undefined,
        });
        const response = await app(request, req.socket.remoteAddress ?? "local");
        if (!response) return next();
        res.statusCode = response.status;
        response.headers.forEach((v, k) => res.setHeader(k, v));
        res.end(Buffer.from(await response.arrayBuffer()));
      } catch (err) {
        const status = (err as { status?: number }).status ?? 500;
        res.statusCode = status;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ error: err instanceof Error ? err.message : "Request failed." }));
      }
    })();
  };

  return {
    name: "double-lls-api",
    configureServer(server) {
      server.middlewares.use(handler);
    },
    configurePreviewServer(server) {
      server.middlewares.use(handler);
    },
  };
}
