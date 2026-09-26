import react from '@vitejs/plugin-react';
import path from 'node:path';
import { defineConfig } from 'vite';

// El frontend vive en web/ y compila a dist/web, que Express sirve en producción.
// En desarrollo, `pnpm dev:web` levanta Vite en :5173 y proxea /api al servidor.
export default defineConfig({
  root: path.resolve(import.meta.dirname, 'web'),
  plugins: [react()],
  build: {
    outDir: path.resolve(import.meta.dirname, 'dist', 'web'),
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      '/api': { target: `http://localhost:${process.env.PORT ?? 3000}`, changeOrigin: true },
    },
  },
});
