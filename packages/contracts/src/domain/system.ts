import { z } from 'zod';

/**
 * Modo test (ADR 0020): datos ficticios, banner rojo y envíos simulados.
 *
 * Las **reglas** viven aquí, en una función pura, para que las usen por igual el
 * kernel (esquema de entorno), el gateway (lo que publica en `/api/v1/meta`), los
 * servicios (bloqueo de envíos) y la interfaz (banner). Un solo sitio donde
 * mirar si el modo test está activo y por qué.
 */

/**
 * Semilla del seed determinista: con ella se obtienen los mismos pacientes,
 * horas y tickets en cualquier máquina (ADR 0020). **Cambiarla invalida las
 * comparaciones históricas** de `seed:verify`.
 */
export const TEST_MODE_SEED = 'odontocrm-2026';

/** Rango de cédulas reservado para datos ficticios: 90.000.000+ (ADR 0020). */
export const FICTITIOUS_DOCUMENT_MIN = 90_000_000;
export const FICTITIOUS_DOCUMENT_MAX = 99_999_999;

/** Texto del banner. En un vistazo tiene que decir qué pasa y qué no hacer. */
export const TEST_MODE_BANNER = 'MODO TEST';
export const TEST_MODE_BANNER_DETAIL =
  'Datos ficticios y envíos simulados: no uses esta instalación con pacientes reales.';

export const TEST_MODE_STATES = [
  'disabled',
  'enabled',
  'needs_allow',
  'blocked_in_production',
] as const;
export type TestModeState = (typeof TEST_MODE_STATES)[number];

export interface TestModeInput {
  nodeEnv: string;
  /** `TEST_MODE`: alguien pidió el modo test. */
  testMode: boolean;
  /** `ALLOW_TEST_MODE`: la instalación lo permite explícitamente. */
  allowTestMode: boolean;
}

export interface TestModeStatus {
  enabled: boolean;
  state: TestModeState;
  /** Explicación legible; nunca lleva secretos. */
  message: string;
}

/**
 * Decide si el modo test está activo. **En producción nunca lo está**, ni con
 * `TEST_MODE=true` y `ALLOW_TEST_MODE=true`: es el criterio de aceptación de la
 * Fase 10 («el modo test no puede activarse en producción»). Fuera de producción
 * hacen falta las dos variables: pedirlo y permitirlo.
 */
export const resolveTestMode = (input: TestModeInput): TestModeStatus => {
  if (input.nodeEnv === 'production') {
    return {
      enabled: false,
      state: 'blocked_in_production',
      message: 'El modo test está bloqueado con NODE_ENV=production.',
    };
  }

  if (!input.testMode) {
    return {
      enabled: false,
      state: 'disabled',
      message: 'Modo test desactivado (TEST_MODE=false).',
    };
  }

  if (!input.allowTestMode) {
    return {
      enabled: false,
      state: 'needs_allow',
      message: 'Se pidió el modo test (TEST_MODE=true) pero falta el permiso ALLOW_TEST_MODE=true.',
    };
  }

  return {
    enabled: true,
    state: 'enabled',
    message: 'Modo test activo: datos ficticios, banner en la interfaz y envíos simulados.',
  };
};

export const testModeStatusSchema = z.object({
  enabled: z.boolean(),
  state: z.enum(TEST_MODE_STATES),
  message: z.string().min(1),
});

/**
 * Lo que el gateway publica en `GET /api/v1/meta`: sin sesión, sin secretos y
 * sin datos de pacientes. Lo consume la interfaz (banner) y, más adelante, el
 * tablero de estado de la Fase 10.
 */
export interface SystemMeta {
  service: string;
  version: string;
  environment: string;
  /** ISO 8601 del momento en que se respondió. */
  timestamp: string;
  testMode: TestModeStatus;
  /** Marcas de los datos ficticios, para poder enseñarlas en la interfaz. */
  fixtures: {
    seed: string;
    documentMin: number;
    documentMax: number;
  };
}

export const systemMetaSchema = z.object({
  service: z.string().min(1),
  version: z.string().min(1),
  environment: z.string().min(1),
  timestamp: z.string().min(1),
  testMode: testModeStatusSchema,
  fixtures: z.object({
    seed: z.string().min(1),
    documentMin: z.number().int(),
    documentMax: z.number().int(),
  }),
});

/**
 * ¿Esta cédula está en el rango reservado para datos ficticios? Vale para
 * cualquier tipo de documento (V, E, P, SC): el número es lo que se reserva.
 */
export const isFictitiousDocument = (document: string | number): boolean => {
  const digits = String(document).replace(/\D/g, '');
  if (digits === '') return false;

  const value = Number(digits);
  return (
    Number.isInteger(value) && value >= FICTITIOUS_DOCUMENT_MIN && value <= FICTITIOUS_DOCUMENT_MAX
  );
};
