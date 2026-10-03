import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * Configuración de la interfaz.
 *
 * En desarrollo, `/api` se reenvía al gateway (127.0.0.1:8090) para que el
 * navegador vea un solo origen: así la cookie de refresco viaja sin depender de
 * CORS y el comportamiento se parece al de producción (donde el reverse proxy
 * sirve la SPA y la API bajo el mismo dominio).
 */
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8090',
        changeOrigin: false,
      },
    },
  },
  preview: {
    host: '127.0.0.1',
    port: 4173,
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
    emptyOutDir: true,
    /**
     * La aplicación es interna (red local) y el paquete incluye React, el router,
     * TanStack Query, formularios y Zod: ~550 kB sin minificar por partes. Se deja
     * el aviso por encima de 700 kB para no ensuciar cada compilación; separar el
     * *vendor* es una optimización para la Fase 10.
     */
    chunkSizeWarningLimit: 700,
  },
});
