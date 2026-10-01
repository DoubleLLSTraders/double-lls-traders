import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import { apiPlugin } from "./server/vitePlugin";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), ["XAI_", "ADMIN_", "PAYPAL_", "PAYHERO_", "SITE_"]);
  return {
    plugins: [react(), apiPlugin(env)],
    server: { port: 5180 },
  };
});
