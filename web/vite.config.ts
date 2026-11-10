import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const target = 'http://127.0.0.1:47821';

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  base: '/',
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  build: {
    outDir: fileURLToPath(new URL('../dist/web', import.meta.url)),
    emptyOutDir: true,
    chunkSizeWarningLimit: 900,
  },
  server: {
    proxy: {
      '/api': { target, changeOrigin: false },
      '/auth': { target, changeOrigin: false },
      '/ws': { target, ws: true, changeOrigin: false },
    },
  },
});
