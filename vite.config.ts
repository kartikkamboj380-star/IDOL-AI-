import { defineConfig } from 'vite';
import path from 'node:path';

/**
 * The client is a vanilla-TS SPA with no framework runtime: it builds to a few
 * hashed assets and talks to the same origin under /api. In development, Vite
 * proxies /api to the Express server so cookies, SSE, and relative URLs all
 * behave exactly as they do in production.
 */
export default defineConfig({
  root: path.resolve(process.cwd(), 'web'),
  publicDir: path.resolve(process.cwd(), 'web/public'),
  build: {
    outDir: path.resolve(process.cwd(), 'dist'),
    emptyOutDir: true,
    sourcemap: false,
    target: 'es2020',
    assetsInlineLimit: 4096,
    rollupOptions: {
      output: {
        manualChunks: {
          markdown: ['marked', 'dompurify'],
          highlight: ['highlight.js/lib/core'],
        },
      },
    },
  },
  server: {
    host: '0.0.0.0',
    port: 5173,
    strictPort: false,
    // The preview host is not localhost, so the proxy must not be restricted.
    allowedHosts: true,
    proxy: {
      '/api': {
        target: process.env.IDOL_API_URL ?? 'http://127.0.0.1:8787',
        changeOrigin: false,
        ws: false,
        // SSE must not be buffered by the proxy.
        configure: (proxy) => {
          proxy.on('proxyRes', (proxyRes) => {
            if (proxyRes.headers['content-type']?.includes('text/event-stream')) {
              proxyRes.headers['cache-control'] = 'no-cache, no-transform';
            }
          });
        },
      },
    },
  },
  esbuild: {
    target: 'es2020',
  },
});
