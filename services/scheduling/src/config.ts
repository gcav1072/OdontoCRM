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
  /**
   * Nombre y dirección del consultorio para el aviso al paciente. **No vienen del
   * código** (`CLINIC` es neutro): los sirve el registro del titular vía identity
   * (`aplicarDatosDelConsultorio`). Mientras no estén, quedan sin valor y el aviso se
   * **difiere** hasta que el consultorio esté configurado.
   */
  CLINIC_ADDRESS: z.string().min(1).optional(),
  CLINIC_NAME: z.string().min(1).optional(),

  /**
   * Servicio de identidad: al arrancar (y cada pocos minutos) se lee de ahí el nombre y
   * la dirección del consultorio para el aviso (ADR 0056).
   */
  IDENTITY_URL: z.string().min(1).default('http://127.0.0.1:4001'),

  /**
   * Servicio clínico (red interna). La agenda lo consulta para comprobar que la
   * sesión clínica esté **cerrada** antes de dejar marcar «atendido» sin motivo.
   */
  CLINICAL_URL: z.string().min(1).default('http://127.0.0.1:4005'),

  /** Secreto compartido con los demás servicios para las rutas internas. */
  INTERNAL_SERVICE_SECRET: z.string().min(16).optional(),
});

export type SchedulingConfig = z.infer<typeof schedulingEnvSchema>;

export const loadSchedulingConfig = (env: Record<string, string | undefined> = process.env) =>
  loadConfig({ service: 'scheduling', schema: schedulingEnvSchema, env });
