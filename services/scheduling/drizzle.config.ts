import { defineConfig } from 'drizzle-kit';

/**
 * Configuración de drizzle-kit del servicio de agenda.
 *
 * ⚠️ Las rutas son **relativas a la raíz del repositorio**: drizzle-kit las
 * resuelve contra el directorio de trabajo, así que se ejecuta desde la raíz:
 *
 *   npm run db:generate:scheduling
 */
export default defineConfig({
  dialect: 'postgresql',
  schema: ['./services/scheduling/src/db/schema.ts', './packages/db/src/schema/outbox.ts'],
  out: './services/scheduling/migrations',
  verbose: true,
  strict: true,
});
