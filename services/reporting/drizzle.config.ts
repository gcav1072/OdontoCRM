import { defineConfig } from 'drizzle-kit';

/**
 * Configuración de drizzle-kit del servicio de reportes.
 *
 * ⚠️ Las rutas son **relativas a la raíz del repositorio**: drizzle-kit las
 * resuelve contra el directorio de trabajo, así que se ejecuta desde la raíz:
 *
 *   npm run db:generate:reporting
 */
export default defineConfig({
  dialect: 'postgresql',
  schema: ['./services/reporting/src/db/schema.ts', './packages/db/src/schema/outbox.ts'],
  out: './services/reporting/migrations',
  verbose: true,
  strict: true,
});
