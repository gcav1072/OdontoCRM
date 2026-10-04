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

/**
 * Valor de un campo de texto que llega en un `multipart/form-data`.
 *
 * Con `attachFieldsToBody: true`, `@fastify/multipart` deja **cada campo como un
 * objeto** (`{ fieldname, value, … }`) y solo el archivo es un `MultipartFile`. Pasar
 * esos objetos al esquema de Zod falla con «se esperaba string, se recibió object»,
 * así que aquí se saca el valor de dentro. Los campos vacíos devuelven `undefined`
 * —«no vino», que es distinto de la cadena vacía— para que el esquema aplique su
 * valor por defecto.
 *
 * Existe porque la subida de archivos del paciente estuvo enviando los objetos tal
 * cual y **nunca funcionó por HTTP** (la prueba de integración llamaba al servicio
 * directamente y por eso no lo vio): cualquier ruta con `multipart` tiene que pasar
 * sus campos por aquí.
 */
export const multipartFieldValue = (field: unknown): unknown => {
  if (field === null || field === undefined) return undefined;
  if (typeof field === 'object' && 'value' in field) {
    const value = (field as { value?: unknown }).value;
    return value === '' ? undefined : value;
  }
  return field === '' ? undefined : field;
};
