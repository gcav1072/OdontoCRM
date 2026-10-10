import {
  billingInvoiceListQuerySchema,
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
  listInvoices,
  replaceDraftItems,
} from '../billing/invoice-service.js';
import { registerInvoicePrint, registerPaymentPrint } from '../billing/print-service.js';
import type { BillingServices } from '../services.js';
import { actorFrom } from '../shared/context.js';

const invoiceParamsSchema = z.object({ id: z.uuid() });

/**
 * La caja (Fase 11, sesiÃ³n A). Rutas pÃºblicas bajo `/api/v1/billing` â€”el gateway reenvÃ­a sin recortar
 * el prefijoâ€” y protegidas por RBAC: ver exige `billing:read` y preparar el borrador, `billing:write`.
 *
 * Cobrar, fijar la tasa y anular llegan con el dinero (sesiÃ³n B), con sus propios permisos.
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

  /**
   * El **historial**: los documentos del perÃ­odo, con filtros de estado, fecha y paciente. Es lo que se
   * mira cuando alguien vuelve con el papel en la mano.
   */
  app.get('/api/v1/billing/invoices', { preHandler: read }, async (request) => {
    const filtros = parseOrThrow(billingInvoiceListQuerySchema, request.query);
    return listInvoices(db, filtros);
  });

  app.get('/api/v1/billing/drafts/:id', { preHandler: read }, async (request) => {
    const { id } = parseOrThrow(invoiceParamsSchema, request.params);
    return getDraft(db, id);
  });

  /** Revisar el borrador: corregir cantidades, aÃ±adir un bien del catÃ¡logo o quitar una lÃ­nea. */
  app.put('/api/v1/billing/drafts/:id/items', { preHandler: write }, async (request) => {
    const { id } = parseOrThrow(invoiceParamsSchema, request.params);
    const input = parseOrThrow(replaceDraftItemsSchema, request.body);
    const totals = await replaceDraftItems(db, id, input.items);
    return { ...(await getDraft(db, id)), totals };
  });

  /**
   * **Emitir**: toma el correlativo y el control de la forma, congela la tasa, compone el PDF y lo
   * archiva (ADR 0048). Desde aquÃ­ la factura no se edita: se anula con nota de crÃ©dito.
   */
  app.post('/api/v1/billing/drafts/:id/issue', { preHandler: write }, async (request) => {
    const { id } = parseOrThrow(invoiceParamsSchema, request.params);
    parseOrThrow(issueInvoiceSchema, request.body);
    const emitida = await issueInvoice(
      {
        db,
        blobStore: services.blobStore,
        pdf: services.pdf,
        letterheadLookup: services.letterheadLookup,
        brandLookup: services.brandLookup,
      },
      id,
      actorFrom(request),
    );
    kickOutbox?.();
    return emitida;
  });

  /**
   * **Cobrar**: registra el recibo con la **tasa del pago** y la polÃ­tica de imputaciÃ³n (B6). Si la
   * tasa vigente arrastra mÃ¡s dÃ­as de los tolerados, hay que confirmar (M8).
   */
  app.post('/api/v1/billing/invoices/:id/payments', { preHandler: collect }, async (request) => {
    const { id } = parseOrThrow(invoiceParamsSchema, request.params);
    const input = parseOrThrow(collectPaymentSchema, request.body);
    const resultado = await collectPayment(
      {
        db,
        blobStore: services.blobStore,
        pdf: services.pdf,
        letterheadLookup: services.letterheadLookup,
        brandLookup: services.brandLookup,
      },
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
   * **Reimprimir** la factura: deja constancia de que el papel volviÃ³ a salir (cuÃ¡ntas veces y cuÃ¡ndo).
   * El PDF lo sirve `GET â€¦/pdf`, que es leer; esto es el acto que se cuenta.
   */
  app.post('/api/v1/billing/invoices/:id/printed', { preHandler: read }, async (request) => {
    const { id } = parseOrThrow(invoiceParamsSchema, request.params);
    const constancia = await registerInvoicePrint(db, id, actorFrom(request));
    kickOutbox?.();
    return constancia;
  });

  /** La constancia de impresiÃ³n del recibo de un cobro. */
  app.post('/api/v1/billing/payments/:id/printed', { preHandler: read }, async (request) => {
    const { id } = parseOrThrow(invoiceParamsSchema, request.params);
    const constancia = await registerPaymentPrint(db, id, actorFrom(request));
    kickOutbox?.();
    return constancia;
  });

  /**
   * **Anular una factura emitida**: exige motivo y emite su **nota de crÃ©dito** (Art. 22 y 23), que
   * es un documento aparte con su nÃºmero y su PDF archivado. La factura no se borra ni se edita.
   */
  app.post(
    '/api/v1/billing/invoices/:id/void',
    { preHandler: voidInvoicePermission },
    async (request) => {
      const { id } = parseOrThrow(invoiceParamsSchema, request.params);
      const input = parseOrThrow(voidInvoiceSchema, request.body);
      const resultado = await voidInvoice(
        {
          db,
          blobStore: services.blobStore,
          pdf: services.pdf,
          letterheadLookup: services.letterheadLookup,
          brandLookup: services.brandLookup,
        },
        id,
        input,
        actorFrom(request),
      );
      kickOutbox?.();
      return resultado;
    },
  );

  /** Descartar un **borrador**: no consumiÃ³ nÃºmero fiscal, asÃ­ que no lleva nota de crÃ©dito. */
  app.post('/api/v1/billing/drafts/:id/discard', { preHandler: write }, async (request) => {
    const { id } = parseOrThrow(invoiceParamsSchema, request.params);
    const input = parseOrThrow(voidInvoiceSchema, request.body);
    const resultado = await discardDraft(db, id, input, actorFrom(request));
    kickOutbox?.();
    return resultado;
  });

  /** El arancel: lo que la caja puede aÃ±adir a mano (un cepillo, un gel). */
  app.get('/api/v1/billing/catalog', { preHandler: read }, async () => ({
    items: await listCatalog(db),
  }));
};
