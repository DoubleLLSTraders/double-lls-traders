import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

// GitHub Pages: https://doublellstraders.github.io/double-lls-traders/
const PAGES_REPO = process.env.GITHUB_PAGES_REPO ?? "double-lls-traders";
const isPagesBuild =
  process.env.GITHUB_PAGES === "true" && process.env.npm_lifecycle_event === "build";
const base = isPagesBuild ? `/${PAGES_REPO}/` : "/";

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
  plugins: [react(), legacyPathRedirect()],
});
