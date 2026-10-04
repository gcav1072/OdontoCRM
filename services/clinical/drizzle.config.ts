import { defineConfig } from 'drizzle-kit';

/**
 * Configuración de drizzle-kit para el servicio clínico.
 *
 * ⚠️ Las rutas son **relativas a la raíz del repositorio**: drizzle-kit las
 * resuelve contra el directorio de trabajo, así que este comando se ejecuta
 * siempre desde la raíz:
 *
 *   npm run db:generate:clinical
 */
export default defineConfig({
  dialect: 'postgresql',
  schema: ['./services/clinical/src/db/schema.ts', './packages/db/src/schema/outbox.ts'],
  out: './services/clinical/migrations',
  verbose: true,
  strict: true,
});
