import { z } from 'zod';

import { cleanText } from '../domain/patient.js';

/**
 * Campos opcionales de un formulario, normalizados a `null`.
 *
 * Los formularios y los clientes JSON mandan `null` o `''` para «vacío», y las
 * cajas de texto llegan con espacios de más: se normaliza todo eso a `null` en
 * lugar de rechazarlo con un 400 (hallazgo de la Fase 2). Un número de un campo
 * de texto vacío **no** es un cero: también es «sin dato», que es distinto de un
 * cero medido.
 */

export const optionalText = (max: number) =>
  z
    .union([z.null(), z.literal(''), z.string().overwrite(cleanText).max(max)])
    .optional()
    .transform((value) => (value === '' || value === null || value === undefined ? null : value));

export const optionalDate = z
  .union([z.null(), z.literal(''), z.iso.date()])
  .optional()
  .transform((value) => (value === '' || value === null || value === undefined ? null : value));

export interface OptionalNumberOptions {
  min: number;
  max: number;
  /** Máximo de decimales admitidos (peso y temperatura los usan). */
  decimals?: number;
  /** Texto que aparece en el error de rango («La temperatura debe estar entre 30 y 45»). */
  label?: string;
}

export const optionalNumber = (options: OptionalNumberOptions) => {
  const decimals = options.decimals ?? 0;
  const label = options.label ?? 'El valor';
  const factor = 10 ** decimals;
  const entero = z.coerce
    .number()
    .refine((value) => Number.isFinite(value), { message: `${label} no es un número` })
    .refine((value) => value >= options.min && value <= options.max, {
      message: `${label} debe estar entre ${String(options.min)} y ${String(options.max)}`,
    })
    .refine((value) => Math.abs(value * factor - Math.round(value * factor)) < 1e-9, {
      message: `${label} admite como mucho ${String(decimals)} decimales`,
    });

  return z
    .union([z.null(), z.literal(''), entero])
    .optional()
    .transform((value) => (value === '' || value === null || value === undefined ? null : value));
};
