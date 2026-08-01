/**
 * Production build for GitHub Pages (base path /double-lls-traders/).
 * Does not read .env secrets into git — inject via CI secrets or local .env at build time.
 */
import { execSync } from "node:child_process";
import { copyFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

process.env.GITHUB_PAGES = "true";
execSync("tsc -b", { stdio: "inherit" });
execSync("vite build", { stdio: "inherit", env: process.env });

// SPA fallback for GitHub Pages deep links (plugin closeBundle can miss on some Vite builds).
const index = resolve("dist", "index.html");
const fallback = resolve("dist", "404.html");
if (existsSync(index)) {
  copyFileSync(index, fallback);
}
