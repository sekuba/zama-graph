import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// biome-ignore lint/style/noDefaultExport: Vite requires default export
export default defineConfig({
  root: 'web',
  plugins: [react()],
  build: {
    outDir: '../dist/web',
    emptyOutDir: true,
  },
  server: {
    proxy: {
      '/api': {
        target: process.env.API_PROXY ?? 'http://localhost:3021',
        changeOrigin: true,
      },
    },
  },
})
