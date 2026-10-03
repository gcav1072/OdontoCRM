import { defineConfig } from 'drizzle-kit';

/**
 * Configuración de drizzle-kit para el servicio de identidad.
 *
 * ⚠️ Las rutas son **relativas a la raíz del repositorio**: drizzle-kit las
 * resuelve contra el directorio de trabajo, así que este comando se ejecuta
 * siempre desde la raíz:
 *
 *   npm run db:generate:identity
 *
 * Las migraciones se versionan en `services/identity/migrations/` y se aplican
 * con `npm run db:migrate`.
 */
export default defineConfig({
  dialect: 'postgresql',
  schema: ['./services/identity/src/db/schema.ts', './packages/db/src/schema/outbox.ts'],
  out: './services/identity/migrations',
  verbose: true,
  strict: true,
});
