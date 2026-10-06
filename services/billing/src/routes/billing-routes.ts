import { issueInvoiceSchema, replaceDraftItemsSchema } from '@odontocrm/contracts';
import { parseOrThrow, requirePermission } from '@odontocrm/kernel';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { issueInvoice } from '../billing/issue-service.js';
import {
  getDraft,
  listCatalog,
  listDrafts,
  replaceDraftItems,
} from '../billing/invoice-service.js';
import type { BillingServices } from '../services.js';
import { actorFrom } from '../shared/context.js';

const invoiceParamsSchema = z.object({ id: z.uuid() });

/**
 * La caja (Fase 11, sesión A). Rutas públicas bajo `/api/v1/billing` —el gateway reenvía sin recortar
 * el prefijo— y protegidas por RBAC: ver exige `billing:read` y preparar el borrador, `billing:write`.
 *
 * Cobrar, fijar la tasa y anular llegan con el dinero (sesión B), con sus propios permisos.
 */
export const registerBillingRoutes = (app: FastifyInstance, services: BillingServices): void => {
  const { db, kickOutbox } = services;
  const read = requirePermission('billing:read');
  const write = requirePermission('billing:write');

  /** Pendientes de caja: las sesiones cerradas cuyo borrador sigue sin emitir. */
  app.get('/api/v1/billing/drafts', { preHandler: read }, async () => ({
    items: await listDrafts(db),
  }));

  app.get('/api/v1/billing/drafts/:id', { preHandler: read }, async (request) => {
    const { id } = parseOrThrow(invoiceParamsSchema, request.params);
    return getDraft(db, id);
  });

  /** Revisar el borrador: corregir cantidades, añadir un bien del catálogo o quitar una línea. */
  app.put('/api/v1/billing/drafts/:id/items', { preHandler: write }, async (request) => {
    const { id } = parseOrThrow(invoiceParamsSchema, request.params);
    const input = parseOrThrow(replaceDraftItemsSchema, request.body);
    const totals = await replaceDraftItems(db, id, input.items);
    return { ...(await getDraft(db, id)), totals };
  });

  /**
   * **Emitir**: toma el correlativo y el control de la forma, congela la tasa, compone el PDF y lo
   * archiva (ADR 0048). Desde aquí la factura no se edita: se anula con nota de crédito.
   */
  app.post('/api/v1/billing/drafts/:id/issue', { preHandler: write }, async (request) => {
    const { id } = parseOrThrow(invoiceParamsSchema, request.params);
    parseOrThrow(issueInvoiceSchema, request.body);
    const emitida = await issueInvoice(
      { db, blobStore: services.blobStore, pdf: services.pdf },
      id,
      actorFrom(request),
    );
    kickOutbox?.();
    return emitida;
  });

  /** El arancel: lo que la caja puede añadir a mano (un cepillo, un gel). */
  app.get('/api/v1/billing/catalog', { preHandler: read }, async () => ({
    items: await listCatalog(db),
  }));
};
