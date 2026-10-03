import { defineConfig } from 'drizzle-kit';

/**
 * Configuración de drizzle-kit del servicio de notificaciones.
 *
 * ⚠️ Rutas relativas a la raíz del repositorio (drizzle-kit las resuelve contra el
 * directorio de trabajo), así que se ejecuta desde la raíz:
 *
 *   npm run db:generate:notifications
 */
export default defineConfig({
  dialect: 'postgresql',
  schema: ['./services/notifications/src/db/schema.ts', './packages/db/src/schema/outbox.ts'],
  out: './services/notifications/migrations',
  verbose: true,
  strict: true,
});
