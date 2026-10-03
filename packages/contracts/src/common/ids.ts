import { z } from 'zod';

/** Identificador único universal en formato canónico (con guiones). */
export const uuidSchema = z.uuid();

export type Uuid = z.infer<typeof uuidSchema>;

/** Comprueba si un texto es un UUID válido sin lanzar excepción. */
export const isUuid = (value: string): boolean => uuidSchema.safeParse(value).success;

/**
 * Los servicios nunca generan ids "a mano": usan `gen_random_uuid()` de
 * PostgreSQL o `crypto.randomUUID()` en el proceso. Esta función existe para
 * que los contratos y las pruebas compartan el mismo formato.
 */
export const newUuid = (): Uuid => globalThis.crypto.randomUUID();
