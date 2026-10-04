import { defineConfig } from 'drizzle-kit';

/**
 * Configuración de drizzle-kit para el servicio de odontograma.
 *
 * ⚠️ Las rutas son **relativas a la raíz del repositorio**: drizzle-kit las
 * resuelve contra el directorio de trabajo, así que este comando se ejecuta
 * siempre desde la raíz:
 *
 *   npm run db:generate:odontogram
 */
export default defineConfig({
  dialect: 'postgresql',
  schema: ['./services/odontogram/src/db/schema.ts', './packages/db/src/schema/outbox.ts'],
  out: './services/odontogram/migrations',
  verbose: true,
  strict: true,
});
