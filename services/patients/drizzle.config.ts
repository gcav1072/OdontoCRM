import { defineConfig } from 'drizzle-kit';

/**
 * Configuración de drizzle-kit para el servicio de pacientes.
 *
 * ⚠️ Las rutas son **relativas a la raíz del repositorio**: drizzle-kit las
 * resuelve contra el directorio de trabajo, así que este comando se ejecuta
 * siempre desde la raíz:
 *
 *   npm run db:generate:patients
 */
export default defineConfig({
  dialect: 'postgresql',
  schema: ['./services/patients/src/db/schema.ts', './packages/db/src/schema/outbox.ts'],
  out: './services/patients/migrations',
  verbose: true,
  strict: true,
});
