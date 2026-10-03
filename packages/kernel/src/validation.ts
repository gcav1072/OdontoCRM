import type { ProblemFieldError } from '@odontocrm/contracts';
import type { z } from 'zod';

import { ValidationError } from './errors.js';

interface IssueLike {
  path?: PropertyKey[];
  message?: string;
  code?: string;
}

const toFieldErrors = (issues: readonly unknown[]): ProblemFieldError[] =>
  issues.map((issue) => {
    const { path, message, code } = issue as IssueLike;
    return {
      path: path !== undefined && path.length > 0 ? path.join('.') : '(cuerpo)',
      message: message ?? 'valor inválido',
      ...(code === undefined ? {} : { code }),
    };
  });

/**
 * Valida datos de entrada contra un esquema Zod y lanza `ValidationError`
 * (400, formato RFC 7807) con el detalle por campo. Todos los servicios validan
 * en el borde con esto: ninguna consulta recibe datos sin comprobar.
 */
export const parseOrThrow = <TSchema extends z.ZodType>(
  schema: TSchema,
  value: unknown,
  message = 'Los datos enviados no son válidos',
): z.infer<TSchema> => {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new ValidationError(message, toFieldErrors(parsed.error.issues));
  }
  return parsed.data;
};

/** Igual que `parseOrThrow`, pero para parámetros de consulta de la URL. */
export const parseQuery = <TSchema extends z.ZodType>(
  schema: TSchema,
  value: unknown,
  message = 'Los filtros de la consulta no son válidos',
): z.infer<TSchema> => parseOrThrow(schema, value, message);
