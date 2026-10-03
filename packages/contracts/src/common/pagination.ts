import { z } from 'zod';

export const DEFAULT_PAGE_SIZE = 25;
export const MAX_PAGE_SIZE = 200;

/** Parámetros de paginación comunes a todos los listados. */
export const paginationQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
});

export type PaginationQuery = z.infer<typeof paginationQuerySchema>;

export interface Paginated<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

/** Envuelve una página de resultados con sus metadatos. */
export const paginate = <T>(items: T[], total: number, query: PaginationQuery): Paginated<T> => ({
  items,
  total,
  page: query.page,
  pageSize: query.pageSize,
  totalPages: Math.max(1, Math.ceil(total / query.pageSize)),
});

/** Desplazamiento (`OFFSET`) que corresponde a la página solicitada. */
export const toOffset = (query: PaginationQuery): number => (query.page - 1) * query.pageSize;
