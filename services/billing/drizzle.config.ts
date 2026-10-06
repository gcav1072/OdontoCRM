import { defineConfig } from 'drizzle-kit';

/**
 * Configuración de drizzle-kit del servicio de facturación.
 *
 * ⚠️ Las rutas son **relativas a la raíz del repositorio**: drizzle-kit las
 * resuelve contra el directorio de trabajo, así que se ejecuta desde la raíz:
 *
 *   npm run db:generate:billing
 */
export default defineConfig({
  dialect: 'postgresql',
  schema: ['./services/billing/src/db/schema.ts', './packages/db/src/schema/outbox.ts'],
  out: './services/billing/migrations',
  verbose: true,
  strict: true,
});
