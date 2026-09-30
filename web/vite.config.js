import path from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The teacher dashboard and the classroom-PC agent are the same app: the agent is
 * simply the `/device` route, which is why one build serves both. In development
 * Vite serves the UI and proxies the API and the WebSocket to the Node server, so
 * there is a single origin for cookies, tokens and `window.location`.
 */
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: false,
    proxy: {
      '/api': { target: 'http://localhost:4000', changeOrigin: true },
      '/live': { target: 'ws://localhost:4000', ws: true },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
    chunkSizeWarningLimit: 900,
  },
  resolve: {
    alias: {
      '@': path.resolve(repoRoot, 'web', 'src'),
    },
  },
});
