import { createApp } from "../../server/app";
import { blobKv } from "../../server/blobKv";

const app = createApp(process.env, blobKv());

export default async (req: Request, context: { ip?: string }) =>
  (await app(req, context.ip || "unknown")) ?? new Response(JSON.stringify({ error: "Not found." }), {
    status: 404,
    headers: { "Content-Type": "application/json" },
  });

export const config = { path: "/api/*" };
