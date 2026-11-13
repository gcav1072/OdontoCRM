import type { OutboundDocument } from '@odontocrm/contracts';
import { eq, like } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createAdapterRegistry, type AdapterRegistry } from './canales/adaptador.js';
import { createSimulatedAdapter } from './canales/simulado.js';
import { loadNotificationsConfig, type NotificationsConfig } from './config.js';
import { createNotificationsDatabase } from './db/client.js';
import { botConversations, notifications, patientChannels } from './db/schema.js';
import {
  DocumentoNoDisponibleError,
  enqueue,
  ensureDefaultTemplates,
  linkChat,
  notificationByDedupe,
  processQueue,
} from './messaging.js';

/**
 * Envío de documentos digitales y opciones numeradas en avisos proactivos (v1.2).
 * Contra PostgreSQL real y con los adaptadores simulados: el PDF **no** se copia a la
 * base, se pide al cargador en el momento de enviar (Req 5).
 */
const databaseUrl = process.env['TEST_NOTIFICATIONS_DATABASE_URL'];
const ready = databaseUrl !== undefined;
const describeWithDatabase = ready ? describe : describe.skip;

const MARK = `PRUEBA-DOCS-${String(Date.now()).slice(-6)}`;
const PDF = Buffer.from('%PDF-1.4\n% documento de prueba\n', 'utf8');

const loaderOk = (esperado: string) => async (): Promise<OutboundDocument> => ({
  nombre: esperado,
  contenido: PDF,
  mime: 'application/pdf',
});

describeWithDatabase('documentos por chat y opciones de cita (PostgreSQL real)', () => {
  let handle: ReturnType<typeof createNotificationsDatabase>;
  let config: NotificationsConfig;
  let registry: AdapterRegistry;
  let telegram: ReturnType<typeof createSimulatedAdapter>;
  let whatsapp: ReturnType<typeof createSimulatedAdapter>;
  const direcciones: string[] = [];

  const conPaciente = async (
    canal: 'telegram' | 'whatsapp',
  ): Promise<{
    patientId: string;
    direccion: string;
  }> => {
    const patientId = globalThis.crypto.randomUUID();
    const direccion = `${MARK}-${String(direcciones.length)}`;
    direcciones.push(direccion);
    await linkChat(handle.db, { patientId, canal, direccion });
    return { patientId, direccion };
  };

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
    telegram = createSimulatedAdapter('telegram');
    whatsapp = createSimulatedAdapter('whatsapp', { botones: false });
    registry = createAdapterRegistry([telegram, whatsapp]);
  }, 30_000);

  afterAll(async () => {
    if (!ready) return;
    await handle.db.delete(notifications).where(like(notifications.dedupeKey, `%${MARK}%`));
    for (const direccion of direcciones) {
      await handle.db.delete(botConversations).where(eq(botConversations.direccion, direccion));
      await handle.db.delete(patientChannels).where(eq(patientChannels.direccion, direccion));
    }
    await handle.close();
  });

  it('envía el PDF en un solo mensaje y no guarda los bytes en la base', async () => {
    const { patientId, direccion } = await conPaciente('whatsapp');
    const entityId = globalThis.crypto.randomUUID();
    const record = await enqueue(handle.db, {
      patientId,
      patientName: `Paciente ${MARK}`,
      templateKey: 'documento_factura',
      payload: { variables: { numero: 'A-000001' } },
      text: 'Te compartimos tu factura digital.',
      dedupeKey: `${MARK}:factura:${entityId}`,
      document: {
        kind: 'invoice',
        entityId,
        label: 'Factura A-000001',
        filename: 'factura-A-000001.pdf',
      },
    });
    expect(record).not.toBeNull();
    // Solo se guarda **qué** documento es: nunca el binario.
    const guardado = record?.payload['document'] as Record<string, unknown>;
    expect(guardado['kind']).toBe('invoice');
    expect(guardado['entityId']).toBe(entityId);
    expect(record?.payload).not.toHaveProperty('documento');

    const resultado = await processQueue(handle.db, registry, config, {
      limit: 20,
      documentLoader: loaderOk('factura-A-000001.pdf'),
    });
    expect(resultado.sent).toBeGreaterThanOrEqual(1);

    const enviados = whatsapp.sent.filter((mensaje) => mensaje.direccion === direccion);
    expect(enviados).toHaveLength(1);
    expect(enviados[0]?.texto).toContain('factura digital');
    expect(enviados[0]?.documento).toEqual({
      nombre: 'factura-A-000001.pdf',
      size: PDF.byteLength,
      mime: 'application/pdf',
    });

    const actualizado = await notificationByDedupe(handle.db, `${MARK}:factura:${entityId}`);
    expect(actualizado?.status).toBe('sent');
  });

  it('recorta el pie de foto al límite de 1024 caracteres de Baileys', async () => {
    const { patientId, direccion } = await conPaciente('whatsapp');
    const entityId = globalThis.crypto.randomUUID();
    await enqueue(handle.db, {
      patientId,
      patientName: `Paciente ${MARK}`,
      templateKey: 'documento_recipe',
      payload: {},
      text: `Hola: ${'x'.repeat(2000)}`,
      dedupeKey: `${MARK}:recipe:${entityId}`,
      document: {
        kind: 'prescription',
        entityId,
        label: 'Récipe',
        filename: 'recipe.pdf',
      },
    });
    await processQueue(handle.db, registry, config, {
      limit: 20,
      documentLoader: loaderOk('recipe.pdf'),
    });
    const enviado = whatsapp.sent.find((mensaje) => mensaje.direccion === direccion);
    expect(enviado?.texto.length).toBeLessThanOrEqual(1024);
    expect(enviado?.texto.endsWith('…')).toBe(true);
  });

  it('un documento que ya no se puede descargar falla sin agotar reintentos', async () => {
    const { patientId } = await conPaciente('telegram');
    const entityId = globalThis.crypto.randomUUID();
    await enqueue(handle.db, {
      patientId,
      patientName: `Paciente ${MARK}`,
      templateKey: 'documento_recibo',
      payload: {},
      text: 'Te compartimos el recibo.',
      dedupeKey: `${MARK}:recibo:${entityId}`,
      document: {
        kind: 'receipt',
        entityId,
        label: 'Recibo',
        filename: 'recibo.pdf',
      },
    });
    const resultado = await processQueue(handle.db, registry, config, {
      limit: 20,
      documentLoader: async () => {
        throw new DocumentoNoDisponibleError('El récipe fue anulado');
      },
    });
    expect(resultado.failed).toBeGreaterThanOrEqual(1);
    const fallido = await notificationByDedupe(handle.db, `${MARK}:recibo:${entityId}`);
    expect(fallido?.status).toBe('failed');
    expect(fallido?.attempts).toBe(fallido?.maxAttempts);
    expect(fallido?.lastError).toContain('anulado');
  });

  it('en WhatsApp, el aviso de cita añade opciones numeradas y las guarda', async () => {
    const { patientId, direccion } = await conPaciente('whatsapp');
    const appointmentId = globalThis.crypto.randomUUID();
    await enqueue(handle.db, {
      patientId,
      patientName: `Paciente ${MARK}`,
      appointmentId,
      templateKey: 'cita_confirmada',
      payload: {
        appointment: { id: appointmentId, status: 'programada' },
        variables: {},
      },
      text: 'Hola: te esperamos el 01/12/2026 a las 9:30 a. m.',
      dedupeKey: `${MARK}:aviso:${appointmentId}`,
      offerAppointmentActions: true,
    });
    await processQueue(handle.db, registry, config, { limit: 20 });

    const enviado = whatsapp.sent.find((mensaje) => mensaje.direccion === direccion);
    expect(enviado?.texto).toContain('1) Confirmar asistencia');
    expect(enviado?.texto).toContain('2) Cancelar cita');

    const [conversacion] = await handle.db
      .select()
      .from(botConversations)
      .where(eq(botConversations.direccion, direccion));
    expect(conversacion?.state).toBe('inicio');
    expect(conversacion?.opciones).toEqual({
      '1': `confirmar_cita:${appointmentId}`,
      '2': `cancelar_cita:${appointmentId}`,
    });
  });

  it('no pisa las opciones de una conversación a medio formulario', async () => {
    const { patientId, direccion } = await conPaciente('whatsapp');
    await handle.db.insert(botConversations).values({
      canal: 'whatsapp',
      direccion,
      state: 'documento',
      draft: { docType: 'V' },
      opciones: { '1': 'doc:V' },
    });
    const appointmentId = globalThis.crypto.randomUUID();
    await enqueue(handle.db, {
      patientId,
      patientName: `Paciente ${MARK}`,
      appointmentId,
      templateKey: 'cita_reprogramada',
      payload: {
        appointment: { id: appointmentId, status: 'programada' },
        variables: {},
      },
      text: 'Tu cita cambió de fecha.',
      dedupeKey: `${MARK}:reprogramada:${appointmentId}`,
      offerAppointmentActions: true,
    });
    await processQueue(handle.db, registry, config, { limit: 20 });

    const enviado = whatsapp.sent.find((mensaje) => mensaje.direccion === direccion);
    expect(enviado?.texto).not.toContain('Confirmar asistencia');
    const [conversacion] = await handle.db
      .select()
      .from(botConversations)
      .where(eq(botConversations.direccion, direccion));
    expect(conversacion?.state).toBe('documento');
    expect(conversacion?.opciones).toEqual({ '1': 'doc:V' });
  });
});
