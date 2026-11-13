import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    allowedHosts: true,
    proxy: {
      '/api': {
        target: process.env.KAVRON_API_PROXY_TARGET?.trim() || 'http://127.0.0.1:8000',
        changeOrigin: false,
      },
    },
  },
  preview: { host: '0.0.0.0', allowedHosts: true },
});
