import { EVENT_TOPICS, createDomainEvent } from '@odontocrm/events';
import { eq, like } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { loadNotificationsConfig, type NotificationsConfig } from './config.js';
import { handleDomainEvent } from './consumer.js';
import { createNotificationsDatabase } from './db/client.js';
import { notifications, patientChannels } from './db/schema.js';
import type {
  InternalClients,
  InvoiceDocumentMeta,
  PaymentDocumentMeta,
} from './internal-client.js';
import { ensureDefaultTemplates, linkChat } from './messaging.js';
import { updateNotificationSettings } from './settings.js';

/**
 * Disparador **automático** de documentos (Req 5, v1.2): los eventos de emisión se
 * convierten en envíos en cola solo si el consultorio lo activó **y** el paciente
 * tiene un chat vinculado. Sin chat no se deja fila de llamada manual (regla
 * anti-ruido).
 */
const databaseUrl = process.env['TEST_NOTIFICATIONS_DATABASE_URL'];
const ready = databaseUrl !== undefined;
const describeWithDatabase = ready ? describe : describe.skip;

const MARK = `PRUEBA-AUTODOC-${String(Date.now()).slice(-6)}`;

describeWithDatabase('envío automático de documentos por evento (PostgreSQL real)', () => {
  let handle: ReturnType<typeof createNotificationsDatabase>;
  let config: NotificationsConfig;
  const direcciones: string[] = [];
  const patientIds: string[] = [];

  const invoiceId = globalThis.crypto.randomUUID();
  const paymentId = globalThis.crypto.randomUUID();

  const clients = (): InternalClients =>
    ({
      listPatientSummaries: async () => [
        {
          id: patientIds[0] ?? globalThis.crypto.randomUUID(),
          fullName: `Paciente ${MARK}`,
        },
      ],
      getInvoiceMeta: async (id: string): Promise<InvoiceDocumentMeta | null> =>
        id === invoiceId
          ? {
              id,
              patientId: patientIds[0] ?? globalThis.crypto.randomUUID(),
              patientName: `Paciente ${MARK}`,
              status: 'emitida',
              number: 'A-000123',
              filename: 'factura-A-000123.pdf',
              issuedAt: '2026-11-13T14:00:00.000Z',
            }
          : null,
      getPaymentMeta: async (id: string): Promise<PaymentDocumentMeta | null> =>
        id === paymentId
          ? {
              id,
              invoiceId,
              patientId: patientIds[0] ?? globalThis.crypto.randomUUID(),
              receiptNumber: 'REC-000123',
              filename: 'recibo-REC-000123.pdf',
              paidAt: '2026-11-13T15:00:00.000Z',
            }
          : null,
    }) as unknown as InternalClients;

  const eventoFactura = () =>
    createDomainEvent({
      topic: EVENT_TOPICS.invoiceIssued,
      aggregateId: invoiceId,
      producer: 'billing',
      payload: {
        invoice: { invoiceId, number: 'A-000123', patientId: patientIds[0], status: 'emitida' },
      },
    });

  const eventoPago = () =>
    createDomainEvent({
      topic: EVENT_TOPICS.paymentReceived,
      aggregateId: paymentId,
      producer: 'billing',
      // Emisor anterior a v1.2: sin patientId en el payload; se resuelve por meta.
      payload: { payment: { paymentId, invoiceId, receiptNumber: 'REC-000123' } },
    });

  beforeAll(async () => {
    if (databaseUrl === undefined) throw new Error('falta TEST_NOTIFICATIONS_DATABASE_URL');
    config = loadNotificationsConfig({
      DATABASE_URL: databaseUrl,
      LOG_LEVEL: 'silent',
      TELEGRAM_MODE: 'simulado',
      CLINIC_NAME: 'Consultorio de prueba',
      CLINIC_ADDRESS: 'Calle de prueba 123',
    });
    handle = createNotificationsDatabase(config);
    await ensureDefaultTemplates(handle.db);
  }, 30_000);

  afterAll(async () => {
    if (!ready) return;
    await handle.db.delete(notifications).where(like(notifications.dedupeKey, `%${MARK}%`));
    for (const direccion of direcciones) {
      await handle.db.delete(patientChannels).where(eq(patientChannels.direccion, direccion));
    }
    if (patientIds.length > 0) {
      await handle.db.delete(notifications).where(eq(notifications.patientId, patientIds[0] ?? ''));
      for (const patientId of patientIds) {
        await handle.db.delete(patientChannels).where(eq(patientChannels.patientId, patientId));
      }
    }
    await updateNotificationSettings(handle.db, { autoSendDocuments: false }, null);
    await handle.close();
  });

  it('con autoSendDocuments apagado no encola nada', async () => {
    await updateNotificationSettings(handle.db, { autoSendDocuments: false }, null);
    const resultado = await handleDomainEvent(handle.db, config, eventoFactura(), {
      clients: clients(),
    });
    expect(resultado.status).toBe('ignorado');
    const filas = await handle.db
      .select()
      .from(notifications)
      .where(eq(notifications.dedupeKey, `documento:invoice:${invoiceId}:${patientIds[0]}`));
    expect(filas).toHaveLength(0);
  });

  it('activado pero sin chat vinculado no deja fila de llamada manual', async () => {
    await updateNotificationSettings(handle.db, { autoSendDocuments: true }, null);
    const resultado = await handleDomainEvent(handle.db, config, eventoFactura(), {
      clients: clients(),
    });
    expect(resultado.status).toBe('ignorado');
    const filas = await handle.db
      .select()
      .from(notifications)
      .where(like(notifications.dedupeKey, `documento:%:${invoiceId}%`));
    expect(filas).toHaveLength(0);
  });

  it('activado y con chat encola la factura y el recibo; el mismo evento no duplica', async () => {
    const patientId = globalThis.crypto.randomUUID();
    patientIds.push(patientId);
    const direccion = `${MARK}-1`;
    direcciones.push(direccion);
    await linkChat(handle.db, { patientId, canal: 'telegram', direccion });

    // El meta del doble usa el primer patientId registrado; se registra antes de emitir.
    const evento = eventoFactura();
    const factura = await handleDomainEvent(handle.db, config, evento, {
      clients: clients(),
    });
    expect(factura.status).toBe('encolado');
    expect(factura.templateKey).toBe('documento_factura');

    const fila = await handle.db
      .select()
      .from(notifications)
      .where(like(notifications.dedupeKey, `documento:invoice:${invoiceId}:%`));
    expect(fila).toHaveLength(1);
    expect(fila[0]?.status).toBe('queued');
    expect(fila[0]?.recipient).toBe(direccion);
    const documentPayload = fila[0]?.payload['document'] as Record<string, unknown>;
    expect(documentPayload['kind']).toBe('invoice');
    expect(documentPayload['entityId']).toBe(invoiceId);
    expect(documentPayload['filename']).toBe('factura-A-000123.pdf');

    // Reintento del mismo evento (misma idempotencia por eventId) → duplicado.
    const repetido = await handleDomainEvent(handle.db, config, evento, {
      clients: clients(),
    });
    expect(repetido.status).toBe('duplicado');
    expect(
      await handle.db
        .select()
        .from(notifications)
        .where(like(notifications.dedupeKey, `documento:invoice:${invoiceId}:%`)),
    ).toHaveLength(1);

    // Cobro sin patientId en el payload: el paciente se resuelve por los metadatos.
    const recibo = await handleDomainEvent(handle.db, config, eventoPago(), {
      clients: clients(),
    });
    expect(recibo.status).toBe('encolado');
    expect(recibo.templateKey).toBe('documento_recibo');
    expect(
      await handle.db
        .select()
        .from(notifications)
        .where(like(notifications.dedupeKey, `documento:receipt:${paymentId}:%`)),
    ).toHaveLength(1);
  });
});
