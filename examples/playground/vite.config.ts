import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const host = process.env.TAURI_DEV_HOST

// Overridable so several checkouts (or a CI shard) can run their own
// photon-server + vite pair side by side without port collisions.
const devPort = Number(process.env.PHOTON_DEV_PORT ?? 5173)
const proxyTarget = process.env.PHOTON_PROXY_TARGET ?? 'http://localhost:3001'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  clearScreen: false,
  server: {
    host: host || false,
    port: devPort,
    strictPort: true,
    allowedHosts: true,
    hmr: host ? { protocol: 'ws', host, port: devPort + 1 } : undefined,
    watch: {
      ignored: ['**/src-tauri/**'],
    },
    proxy: {
      '/api': {
        target: proxyTarget,
      },
      '/ws': {
        target: proxyTarget,
        ws: true,
      },
    },
  },
})
