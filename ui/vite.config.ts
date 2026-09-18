import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))

/**
 * The API is proxied rather than called cross-origin so that EventSource and
 * <img src> stay same-origin — one less thing that behaves differently in dev than
 * it would behind a built bundle.
 */
export default defineConfig({
  root: here,
  cacheDir: resolve(here, '..', 'node_modules', '.vite'),
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:3000',
        changeOrigin: true,
        // SSE must not be buffered by the proxy, or the live log arrives in lumps.
        configure: (proxy) => {
          proxy.on('proxyRes', (res) => {
            if (res.headers['content-type']?.includes('text/event-stream')) {
              res.headers['cache-control'] = 'no-cache, no-transform'
            }
          })
        },
      },
    },
  },
  build: { outDir: resolve(here, '..', 'data', 'ui-dist'), emptyOutDir: true },
})
