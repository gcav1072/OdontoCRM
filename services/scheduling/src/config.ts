import { baseEnvSchema, loadConfig } from '@odontocrm/kernel';
import {
  DEFAULT_DAY_CAPACITY,
  DEFAULT_NO_SHOW_GRACE_MINUTES,
  DEFAULT_SLOT_MINUTES,
} from '@odontocrm/contracts';
import { z } from 'zod';

export const schedulingEnvSchema = baseEnvSchema.extend({
  SERVICE_VERSION: z.string().min(1).default('0.1.0'),
  SCHEDULING_HOST: z.string().min(1).default('127.0.0.1'),
  SCHEDULING_PORT: z.coerce.number().int().min(1).max(65_535).default(4003),
  DATABASE_URL: z.string().min(1),
  /** Base de la cola de eventos compartida (la escribe `npm run db:bootstrap`). */
  EVENTS_DATABASE_URL: z.string().min(1).optional(),
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(50).default(10),

  /** Cupo cuando el día no tiene cupo explícito ni plantilla. */
  DEFAULT_DAY_CAPACITY: z.coerce.number().int().min(0).max(200).default(DEFAULT_DAY_CAPACITY),
  /** Duración por defecto de una cita cuando no hay franja que la defina. */
  DEFAULT_APPOINTMENT_MINUTES: z.coerce
    .number()
    .int()
    .min(5)
    .max(240)
    .default(DEFAULT_SLOT_MINUTES),
  /** Minutos de tolerancia antes de poder marcar una inasistencia. */
  NO_SHOW_GRACE_MINUTES: z.coerce
    .number()
    .int()
    .min(0)
    .max(240)
    .default(DEFAULT_NO_SHOW_GRACE_MINUTES),
  /** Dirección que aparece en el aviso al paciente. */
  CLINIC_ADDRESS: z
    .string()
    .min(1)
    .default('Av. Luis del Valle García, C.E. Nueva Esparta, Planta Baja, Local 1-2'),
  CLINIC_NAME: z.string().min(1).default('Consultorio - Od. Erika Gómez'),

  /** Secreto compartido con los demás servicios para las rutas internas. */
  INTERNAL_SERVICE_SECRET: z.string().min(16).optional(),
});

export type SchedulingConfig = z.infer<typeof schedulingEnvSchema>;

export const loadSchedulingConfig = (env: Record<string, string | undefined> = process.env) =>
  loadConfig({ service: 'scheduling', schema: schedulingEnvSchema, env });
