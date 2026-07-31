import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// GitHub Pages: https://doublellstraders.github.io/brick-trader/
const PAGES_REPO = process.env.GITHUB_PAGES_REPO ?? "brick-trader";
const base = process.env.GITHUB_PAGES === "true" ? `/${PAGES_REPO}/` : "/";

export default defineConfig({
  base,
  plugins: [react()],
});
