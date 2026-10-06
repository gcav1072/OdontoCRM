import {
  collectPaymentSchema,
  issueInvoiceSchema,
  replaceDraftItemsSchema,
  voidInvoiceSchema,
  voidPaymentSchema,
} from '@odontocrm/contracts';
import { parseOrThrow, requirePermission } from '@odontocrm/kernel';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { discardDraft, voidInvoice } from '../billing/credit-note-service.js';
import { issueInvoice } from '../billing/issue-service.js';
import { collectPayment, listInvoicePayments, voidPayment } from '../billing/payment-service.js';
import {
  getDraft,
  getInvoice,
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
  const collect = requirePermission('billing:collect');
  const voidInvoicePermission = requirePermission('billing:void');

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

  /**
   * **Cobrar**: registra el recibo con la **tasa del pago** y la política de imputación (B6). Si la
   * tasa vigente arrastra más días de los tolerados, hay que confirmar (M8).
   */
  app.post('/api/v1/billing/invoices/:id/payments', { preHandler: collect }, async (request) => {
    const { id } = parseOrThrow(invoiceParamsSchema, request.params);
    const input = parseOrThrow(collectPaymentSchema, request.body);
    const resultado = await collectPayment(
      { db, blobStore: services.blobStore, pdf: services.pdf },
      id,
      input,
      actorFrom(request),
    );
    kickOutbox?.();
    return resultado;
  });

  /** Anular un cobro: vuelve el saldo y el estado retrocede, con motivo (B8). */
  app.post('/api/v1/billing/payments/:id/void', { preHandler: collect }, async (request) => {
    const { id } = parseOrThrow(invoiceParamsSchema, request.params);
    const input = parseOrThrow(voidPaymentSchema, request.body);
    const resultado = await voidPayment({ db }, id, input, actorFrom(request));
    kickOutbox?.();
    return resultado;
  });

  /** La factura con sus cobros: para reimprimir el recibo o ver el saldo. */
  app.get('/api/v1/billing/invoices/:id', { preHandler: read }, async (request) => {
    const { id } = parseOrThrow(invoiceParamsSchema, request.params);
    return { ...(await getInvoice(db, id)), payments: await listInvoicePayments(db, id) };
  });

  /**
   * **Anular una factura emitida**: exige motivo y emite su **nota de crédito** (Art. 22 y 23), que
   * es un documento aparte con su número y su PDF archivado. La factura no se borra ni se edita.
   */
  app.post(
    '/api/v1/billing/invoices/:id/void',
    { preHandler: voidInvoicePermission },
    async (request) => {
      const { id } = parseOrThrow(invoiceParamsSchema, request.params);
      const input = parseOrThrow(voidInvoiceSchema, request.body);
      const resultado = await voidInvoice(
        { db, blobStore: services.blobStore, pdf: services.pdf },
        id,
        input,
        actorFrom(request),
      );
      kickOutbox?.();
      return resultado;
    },
  );

  /** Descartar un **borrador**: no consumió número fiscal, así que no lleva nota de crédito. */
  app.post('/api/v1/billing/drafts/:id/discard', { preHandler: write }, async (request) => {
    const { id } = parseOrThrow(invoiceParamsSchema, request.params);
    const input = parseOrThrow(voidInvoiceSchema, request.body);
    const resultado = await discardDraft(db, id, input, actorFrom(request));
    kickOutbox?.();
    return resultado;
  });

  /** El arancel: lo que la caja puede añadir a mano (un cepillo, un gel). */
  app.get('/api/v1/billing/catalog', { preHandler: read }, async () => ({
    items: await listCatalog(db),
  }));
};
