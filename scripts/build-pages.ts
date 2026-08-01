/**
 * Production build for GitHub Pages (base path /double-lls-traders/).
 * Does not read .env secrets into git — inject via CI secrets or local .env at build time.
 */
import { execSync } from "node:child_process";

process.env.GITHUB_PAGES = "true";
execSync("tsc -b", { stdio: "inherit" });
execSync("vite build", { stdio: "inherit", env: process.env });
