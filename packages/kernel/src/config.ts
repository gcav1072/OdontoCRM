import { resolveTestMode, type TestModeStatus } from '@odontocrm/contracts';
import { z } from 'zod';

/**
 * Banderas del `.env` escritas como texto (`true`/`false`). Un valor distinto
 * **no** se interpreta como verdadero: revienta al arrancar, que es lo que se
 * quiere con una bandera de seguridad.
 */
const flag = (defaultValue: 'true' | 'false') =>
  z
    .enum(['true', 'false'])
    .default(defaultValue)
    .transform((value) => value === 'true');

/**
 * Variables comunes a todos los servicios. Cada servicio extiende este esquema
 * con las suyas; si falta una variable obligatoria, el servicio **no arranca**.
 */
export const baseEnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  LOG_PRETTY: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
  TZ: z.string().min(1).default('America/Caracas'),
  /** Pide el modo test (ADR 0020): datos ficticios, banner y envíos simulados. */
  TEST_MODE: flag('false'),
  /**
   * Permiso explícito para el modo test. Es el segundo cerrojo: en la instalación
   * de la clínica queda en `false` y ningún `TEST_MODE=true` suelto enciende nada.
   */
  ALLOW_TEST_MODE: flag('false'),
});

export type BaseEnv = z.infer<typeof baseEnvSchema>;

export class ConfigError extends Error {
  readonly missing: string[];

  constructor(message: string, missing: string[] = []) {
    super(message);
    this.name = 'ConfigError';
    this.missing = missing;
  }
}

interface IssueLike {
  code?: string;
  path?: PropertyKey[];
  expected?: unknown;
  values?: unknown[];
  message?: string;
}

/**
 * Describe un problema de configuración **sin repetir el valor recibido**: si
 * alguien pegó un secreto en la variable equivocada, no queremos verlo en los
 * logs ni en la consola.
 */
const describeIssue = (issue: unknown): string => {
  const { code, path, expected, values, message } = issue as IssueLike;
  const where = path && path.length > 0 ? path.join('.') : '(raíz)';

  switch (code) {
    case 'invalid_type':
      return `${where}: falta la variable o el tipo no es válido (se esperaba ${String(expected)})`;
    case 'invalid_value':
      return values && values.length > 0
        ? `${where}: valor no permitido (opciones: ${values.map(String).join(', ')})`
        : `${where}: valor no permitido`;
    case 'too_small':
      return `${where}: el valor es más corto o menor de lo permitido`;
    case 'too_big':
      return `${where}: el valor es más largo o mayor de lo permitido`;
    case 'invalid_format':
      return `${where}: el formato del valor no es válido`;
    default:
      return `${where}: ${code ?? message ?? 'valor inválido'}`;
  }
};

export interface LoadConfigOptions<TSchema extends z.ZodType> {
  /** Nombre del servicio, solo para el mensaje de error. */
  service: string;
  schema: TSchema;
  /** Fuente de variables; por defecto `process.env`. Se inyecta en las pruebas. */
  env?: Record<string, string | undefined>;
}

/**
 * Valida la configuración del servicio al arrancar. Falla rápido y con un
 * mensaje útil en lugar de arrancar a medias con valores por defecto peligrosos.
 */
export const loadConfig = <TSchema extends z.ZodType>(
  options: LoadConfigOptions<TSchema>,
): z.infer<TSchema> => {
  const parsed = options.schema.safeParse(options.env ?? process.env);

  if (!parsed.success) {
    const problems = parsed.error.issues.map(describeIssue);
    const missing = parsed.error.issues
      .filter((issue) => issue.code === 'invalid_type')
      .map((issue) => (issue.path.length > 0 ? issue.path.join('.') : '(raíz)'));

    throw new ConfigError(
      `Configuración inválida para el servicio "${options.service}":\n  - ${problems.join('\n  - ')}\n` +
        'Revisa tu archivo .env (ver .env.example y docs/SEGURIDAD_SECRETOS.md).',
      missing,
    );
  }

  return parsed.data;
};

export const isProduction = (config: { NODE_ENV: string }): boolean =>
  config.NODE_ENV === 'production';

export const isTest = (config: { NODE_ENV: string }): boolean => config.NODE_ENV === 'test';

/**
 * Estado del modo test a partir de la configuración cargada. Las reglas están en
 * `@odontocrm/contracts` (`resolveTestMode`) para que el gateway, los servicios
 * y la interfaz decidan con la misma función; aquí solo se traducen los nombres
 * del `.env`.
 */
export const testModeStatus = (config: {
  NODE_ENV: string;
  TEST_MODE: boolean;
  ALLOW_TEST_MODE: boolean;
}): TestModeStatus =>
  resolveTestMode({
    nodeEnv: config.NODE_ENV,
    testMode: config.TEST_MODE,
    allowTestMode: config.ALLOW_TEST_MODE,
  });

/** Atajo legible: ¿está activo el modo test en esta configuración? */
export const testModeEnabled = (config: {
  NODE_ENV: string;
  TEST_MODE: boolean;
  ALLOW_TEST_MODE: boolean;
}): boolean => testModeStatus(config).enabled;
