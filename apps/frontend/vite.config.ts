import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * Конфигурация тестового frontend-стенда.
 *
 * Dev proxy позволяет открывать React на `localhost:5173`, но отправлять `/api`,
 * `/health` и `/internal` в backend на `localhost:5001`. Благодаря этому ручной
 * стенд не требует включать CORS в production backend и повторяет обычную
 * схему reverse proxy.
 */
export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: 5173,
    strictPort: true,
    hmr: {
      clientPort: Number(process.env['FRONTEND_HOST_PORT'] ?? 5173),
    },
    watch: {
      usePolling: process.env['CHOKIDAR_USEPOLLING'] === 'true',
      interval: 500,
    },
    proxy: {
      '/api': process.env['VITE_BACKEND_URL'] ?? 'http://localhost:5001',
      '/health': process.env['VITE_BACKEND_URL'] ?? 'http://localhost:5001',
      '/internal': process.env['VITE_BACKEND_URL'] ?? 'http://localhost:5001',
    },
  },
});
