import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// GitHub Pages serves from /repo-name/ — set GITHUB_PAGES=true in CI.
const base = process.env.GITHUB_PAGES === 'true' ? '/brick-trader/' : '/'

// https://vite.dev/config/
export default defineConfig({
  base,
  plugins: [react()],
})
