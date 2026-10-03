import { z } from 'zod';

/**
 * Formato de error uniforme de toda la API (RFC 7807, «Problem Details»).
 * Los servicios nunca devuelven pilas de error ni detalles internos.
 */
export const PROBLEM_CONTENT_TYPE = 'application/problem+json';

export const problemFieldErrorSchema = z.object({
  path: z.string(),
  message: z.string(),
  code: z.string().optional(),
});

export const problemDetailsSchema = z.object({
  type: z.string().default('about:blank'),
  title: z.string(),
  status: z.number().int().min(400).max(599),
  detail: z.string().optional(),
  instance: z.string().optional(),
  requestId: z.string().optional(),
  errors: z.array(problemFieldErrorSchema).optional(),
});

export type ProblemFieldError = z.infer<typeof problemFieldErrorSchema>;
export type ProblemDetails = z.infer<typeof problemDetailsSchema>;
