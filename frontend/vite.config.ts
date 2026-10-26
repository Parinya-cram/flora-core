import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// https://vite.dev/config/
export default defineConfig({
  base: "./",
  plugins: [react(), tailwindcss()],
  server: {
    // Dev server sits behind nginx / Cloudflare tunnel, so accept any Host
    // (leaf.flora.local, *.trycloudflare.com, etc.) instead of Vite's default allowlist.
    allowedHosts: true,
    proxy: {
      // Live stream WebSocket (leaf-live). Must come before '/api' so the
      // upgrade is proxied with ws:true.
      '/api/live': {
        target: process.env.VITE_LIVE_PROXY_TARGET || process.env.VITE_API_PROXY_TARGET || 'http://localhost:6893',
        ws: true,
        changeOrigin: true,
      },
      '/api': process.env.VITE_API_PROXY_TARGET || 'http://localhost:6893',
      '/health': process.env.VITE_API_PROXY_TARGET || 'http://localhost:6893',
    },
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes("node_modules")) return;
          if (id.includes("react") || id.includes("scheduler")) return "react-vendor";
          if (id.includes("tailwindcss")) return "ui-vendor";
          return "vendor";
        },
      },
    },
  },
})
