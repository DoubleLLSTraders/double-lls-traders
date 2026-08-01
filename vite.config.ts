import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { copyFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

// GitHub Pages: https://doublellstraders.github.io/double-lls-traders/
const PAGES_REPO = process.env.GITHUB_PAGES_REPO ?? "double-lls-traders";
const isPagesBuild = process.env.GITHUB_PAGES === "true";
const base = isPagesBuild ? `/${PAGES_REPO}/` : "/";

/** Prevent stale index.html after deploys; SPA fallback for deep links. */
function githubPagesExtras(): Plugin {
  return {
    name: "github-pages-extras",
    transformIndexHtml(html) {
      if (!isPagesBuild) return html;
      const stamp = new Date().toISOString();
      const cacheMeta = [
        `<meta http-equiv="Cache-Control" content="no-cache, no-store, must-revalidate" />`,
        `<meta http-equiv="Pragma" content="no-cache" />`,
        `<meta name="build-stamp" content="${stamp}" />`,
      ].join("\n    ");
      return html.replace("<meta charset=\"UTF-8\" />", `<meta charset="UTF-8" />\n    ${cacheMeta}`);
    },
    closeBundle() {
      if (!isPagesBuild) return;
      const dist = resolve("dist");
      const index = resolve(dist, "index.html");
      if (existsSync(index)) {
        copyFileSync(index, resolve(dist, "404.html"));
      }
    },
  };
}

/** Redirect old bookmark paths to the current base path. */
function legacyPathRedirect(): Plugin {
  return {
    name: "legacy-path-redirect",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const raw = req.url ?? "";
        const path = raw.split("?")[0] ?? "";
        if (!path.startsWith("/brick-trader") && !path.startsWith("/double-lls-traders")) {
          next();
          return;
        }
        const rest =
          path.startsWith("/brick-trader")
            ? path.slice("/brick-trader".length) || "/"
            : path.slice("/double-lls-traders".length) || "/";
        const suffix = raw.includes("?") ? raw.slice(raw.indexOf("?")) : "";
        const root = base === "/" ? "" : base.replace(/\/$/, "");
        const target = `${root}${rest}${suffix}`;
        res.writeHead(302, { Location: target });
        res.end();
      });
    },
    configurePreviewServer(server) {
      server.middlewares.use((req, res, next) => {
        const raw = req.url ?? "";
        const path = raw.split("?")[0] ?? "";
        if (!path.startsWith("/brick-trader") && !path.startsWith("/double-lls-traders")) {
          next();
          return;
        }
        const rest =
          path.startsWith("/brick-trader")
            ? path.slice("/brick-trader".length) || "/"
            : path.slice("/double-lls-traders".length) || "/";
        const suffix = raw.includes("?") ? raw.slice(raw.indexOf("?")) : "";
        const root = base === "/" ? "" : base.replace(/\/$/, "");
        const target = `${root}${rest}${suffix}`;
        res.writeHead(302, { Location: target });
        res.end();
      });
    },
  };
}

export default defineConfig({
  base,
  plugins: [react(), legacyPathRedirect(), githubPagesExtras()],
});
