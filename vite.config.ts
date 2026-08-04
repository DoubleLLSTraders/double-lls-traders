import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { copyFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Custom domain (doublellstraders.malimines.com) serves at site root → base "/".
// Project URL path /double-lls-traders/ only when building without a custom domain.
const PAGES_REPO = process.env.GITHUB_PAGES_REPO ?? "double-lls-traders";
const isPagesBuild = process.env.GITHUB_PAGES === "true";
const useCustomDomain =
  process.env.GITHUB_PAGES_CUSTOM_DOMAIN === "true" ||
  process.env.GITHUB_PAGES_CUSTOM_DOMAIN === "1";
const base =
  isPagesBuild && !useCustomDomain ? `/${PAGES_REPO}/` : "/";

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
        // SPA fallback for client deep links.
        copyFileSync(index, resolve(dist, "404.html"));
      }
      // Ensure /admin/ works on Pages (trailing slash).
      const adminHtml = resolve(dist, "admin.html");
      const adminIndex = resolve(dist, "admin", "index.html");
      if (existsSync(adminIndex) && !existsSync(adminHtml)) {
        try {
          copyFileSync(adminIndex, adminHtml);
        } catch {
          /* ignore */
        }
      }
    },
  };
}

/**
 * Redirect old bookmark paths.
 *
 * Local (base "/"): /double-lls-traders/* and /brick-trader/* → /*
 * Pages (base "/double-lls-traders/"): only /brick-trader/* → /double-lls-traders/*
 * Never redirect a path that is already the active base — that caused
 * ERR_TOO_MANY_REDIRECTS on localhost:/double-lls-traders/.
 */
function legacyPathRedirect(): Plugin {
  function rewrite(raw: string): string | null {
    const path = raw.split("?")[0] ?? "";
    const suffix = raw.includes("?") ? raw.slice(raw.indexOf("?")) : "";

    if (isPagesBuild) {
      if (!path.startsWith("/brick-trader")) return null;
      const rest = path.slice("/brick-trader".length) || "/";
      const root = `/${PAGES_REPO}`;
      return `${root}${rest.startsWith("/") ? rest : `/${rest}`}${suffix}`;
    }

    // Local dev / preview — strip both legacy prefixes to site root.
    if (path.startsWith("/brick-trader")) {
      const rest = path.slice("/brick-trader".length) || "/";
      return `${rest.startsWith("/") ? rest : `/${rest}`}${suffix}`;
    }
    if (path.startsWith("/double-lls-traders")) {
      const rest = path.slice("/double-lls-traders".length) || "/";
      return `${rest.startsWith("/") ? rest : `/${rest}`}${suffix}`;
    }
    return null;
  }

  function middleware(
    req: { url?: string },
    res: { writeHead: (code: number, headers: Record<string, string>) => void; end: () => void },
    next: () => void,
  ) {
    const target = rewrite(req.url ?? "");
    if (!target || target === (req.url ?? "")) {
      next();
      return;
    }
    res.writeHead(302, { Location: target });
    res.end();
  }

  return {
    name: "legacy-path-redirect",
    configureServer(server) {
      server.middlewares.use(middleware);
    },
    configurePreviewServer(server) {
      server.middlewares.use(middleware);
    },
  };
}

export default defineConfig({
  base,
  plugins: [react(), legacyPathRedirect(), githubPagesExtras()],
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, "index.html"),
        admin: resolve(__dirname, "admin/index.html"),
      },
    },
  },
  server: {
    port: 5173,
    strictPort: false,
    watch: {
      ignored: [
        "**/*recovery-codes*",
        "**/.env",
        "**/.env.*",
        "**/.deploy-gh-pages/**",
      ],
    },
  },
});
