import {
  clinicalSessionContentSchema,
  createPrescriptionSchema,
  type CreatePrescriptionInput,
} from '@odontocrm/contracts';
import {
  consumerQueueName,
  createBoss,
  createOutboxRunner,
  ensureDomainEventsQueue,
  registerDomainEventHandler,
  startBoss,
  stopBoss,
} from '@odontocrm/db';
import { ConflictError } from '@odontocrm/kernel';
import { createDiskBlobStore, type BlobStore } from '@odontocrm/storage';
import { eq, sql } from 'drizzle-orm';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { PgBoss } from 'pg-boss';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { handleDomainEvent } from '../../identity/dist/audit/event-consumer.js';
import { loadIdentityConfig } from '../../identity/dist/config.js';
import { createIdentityDatabase } from '../../identity/dist/db/client.js';
import * as identitySchema from '../../identity/dist/db/schema.js';
import {
  deleteAttachment,
  getAttachmentFile,
  listAttachments,
  saveAttachment,
} from './clinical/attachment-service.js';
import {
  annulPrescription,
  issuePrescription,
  listMedications,
  listPrescriptionsByPatient,
  readPrescriptionPdf,
  registerPrescriptionPrint,
  saveDraft,
  verifyPrescription,
} from './clinical/prescription-service.js';
import { closeSession, openSession, saveSession } from './clinical/session-service.js';
import { loadClinicalConfig } from './config.js';
import { createClinicalDatabase } from './db/client.js';
import { prescriptions } from './db/schema.js';
import { createPdfRenderer, type PdfRenderer } from './prescriptions/pdf-renderer.js';

/**
 * Pruebas de integración de la Fase 7 (sesión B) contra PostgreSQL real y **con
 * Chromium de verdad**:
 *  1. el catálogo de medicamentos se lee y se busca;
 *  2. el borrador del récipe se guarda por sesión y se reemplaza entero;
 *  3. la emisión toma un número de la secuencia, **genera el PDF A5**, lo archiva y
 *     deja el código de verificación;
 *  4. la verificación pública confirma el récipe **sin** datos clínicos;
 *  5. la reimpresión se cuenta y se audita, y el récipe se anula con motivo (nunca
 *     se borra);
 *  6. dos emisiones simultáneas reciben números distintos;
 *  7. los adjuntos van al almacén en disco y solo se borran mientras la sesión es
 *     borrador.
 *
 * Los módulos de identity se importan desde su `dist` compilado (es lo que corre en
 * producción); por eso `npm run test:integration` exige `npm run build` antes.
 */
const clinicalUrl = process.env['TEST_CLINICAL_DATABASE_URL'];
const identityUrl = process.env['TEST_IDENTITY_DATABASE_URL'];
const eventsUrl = process.env['TEST_EVENTS_DATABASE_URL'];

const ready = clinicalUrl !== undefined && identityUrl !== undefined && eventsUrl !== undefined;
const describeWithDatabases = ready ? describe : describe.skip;

const suffix = String(Date.now()).slice(-7);
const MARKER = `prueba-fase7b-${suffix}`;
const colaDePrueba = consumerQueueName('prueba-recipes');

const actor = {
  actorId: null,
  actorUsername: MARKER,
  ip: '127.0.0.1',
  userAgent: 'vitest',
  requestId: `req-${suffix}`,
};

const patientId = globalThis.crypto.randomUUID();
const paciente = {
  id: patientId,
  fullName: 'María Pérez Gómez',
  document: 'V-12345678',
  birthDate: '1988-04-12',
  age: 38,
  sex: 'F',
  phone: '+584121234567',
  address: null,
  occupation: null,
};

const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8AARAAB/wD/AH8hAAAAAElFTkSuQmCC',
  'base64',
);

/** Clave que usa el servicio dentro del almacén para un adjunto de la sesión. */
const attachmentKey = (sessionId: string, attachmentId: string): string =>
  ['clinical', sessionId, `${attachmentId}.png`].join('/');

const receta = (
  sessionId: string,
  items?: CreatePrescriptionInput['items'],
): CreatePrescriptionInput =>
  createPrescriptionSchema.parse({
    sessionId,
    items: items ?? [
      {
        medicationName: 'Amoxicilina',
        presentation: 'Tabletas 500 mg',
        route: 'oral',
        dose: '500 mg',
        frequency: 'cada 8 horas',
        duration: '7 días',
        instructions: 'Tomar después de las comidas',
        quantity: '21 tabletas',
      },
      {
        medicationName: 'Ibuprofeno',
        presentation: 'Tabletas 400 mg',
        route: 'oral',
        dose: '400 mg',
        frequency: 'cada 8 horas',
        duration: '3 días',
      },
    ],
    generalInstructions: 'Volver si el dolor no cede en 48 horas.',
  });

describeWithDatabases('récipes y adjuntos: número, PDF A5, QR y auditoría', () => {
  let handle: Awaited<ReturnType<typeof createClinicalDatabase>>;
  let identityHandle: Awaited<ReturnType<typeof createIdentityDatabase>>;
  let boss: PgBoss;
  let blobStore: BlobStore;
  let pdfRenderer: PdfRenderer;
  let storageDir = '';
  let sessionId = '';
  let draftId = '';
  /** Segundo borrador de la misma sesión (el que se prepara tras anular el primero). */
  let draftId2 = '';

  const auditRows = async () =>
    identityHandle.db
      .select({
        action: identitySchema.auditEvents.action,
        summary: identitySchema.auditEvents.summary,
        reason: identitySchema.auditEvents.reason,
        entityType: identitySchema.auditEvents.entityType,
      })
      .from(identitySchema.auditEvents)
      .where(eq(identitySchema.auditEvents.actorUsername, MARKER));

  const flushOutbox = async (): Promise<void> => {
    const runner = createOutboxRunner({ pool: handle.pool, boss, consumerQueue: colaDePrueba });
    for (let ciclo = 0; ciclo < 10; ciclo += 1) {
      const result = await runner.flush();
      if (result.claimed === 0) return;
    }
  };

  const waitForAudit = async (
    predicate: (rows: Awaited<ReturnType<typeof auditRows>>) => boolean,
  ): Promise<Awaited<ReturnType<typeof auditRows>>> => {
    const deadline = Date.now() + 15_000;
    let rows = await auditRows();
    while (!predicate(rows) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      rows = await auditRows();
    }
    return rows;
  };

  const emitir = (id: string, patient: string = patientId) =>
    issuePrescription(handle.db, blobStore, pdfRenderer, id, actor, {
      publicAppUrl: 'http://127.0.0.1:5173',
      logoPath: resolve('assets/clinic/logo.png'),
      patientLookup: async (consultado) => (consultado === patient ? paciente : null),
    });

  /** Abre y cierra una sesión con contenido para el paciente indicado. */
  const sesionCerrada = async (pacienteId: string): Promise<string> => {
    const abierta = await openSession(
      handle.db,
      pacienteId,
      { appointmentId: null, motivo: null },
      actor,
    );
    await saveSession(handle.db, abierta.detail.id, {
      content: clinicalSessionContentSchema.parse({
        motivo: 'Dolor en la 26',
        procedimientos: [
          { code: 'endodoncia_multirradicular', toothNumber: 26, surfaces: ['occlusal'] },
        ],
        diagnostico: 'Pulpitis irreversible en 26',
      }),
    });
    await closeSession(handle.db, abierta.detail.id, { confirm: true, closureNote: null }, actor);
    return abierta.detail.id;
  };

  const borrarPaciente = async (pacienteId: string): Promise<void> => {
    await handle.db.delete(prescriptions).where(eq(prescriptions.patientId, pacienteId));
    await handle.db.execute(sql`delete from clinical_sessions where patient_id = ${pacienteId}`);
    await handle.db.execute(sql`delete from medical_records where patient_id = ${pacienteId}`);
  };

  beforeAll(async () => {
    if (!ready) throw new Error('faltan las variables TEST_* de bases de datos');

    handle = createClinicalDatabase(
      loadClinicalConfig({
        DATABASE_URL: clinicalUrl,
        EVENTS_DATABASE_URL: eventsUrl,
        LOG_LEVEL: 'silent',
      }),
    );
    identityHandle = createIdentityDatabase(
      loadIdentityConfig({
        DATABASE_URL: identityUrl,
        EVENTS_DATABASE_URL: eventsUrl,
        LOG_LEVEL: 'silent',
      }),
    );

    storageDir = await mkdtemp(join(tmpdir(), 'odonto-clinical-'));
    blobStore = createDiskBlobStore({ rootDir: storageDir });
    pdfRenderer = createPdfRenderer({ timeoutMs: 30_000 });

    boss = createBoss({ connectionString: eventsUrl, applicationName: 'odontocrm-test-fase7b' });
    await startBoss(boss);
    await ensureDomainEventsQueue(boss);

    await registerDomainEventHandler(
      boss,
      async (events) => {
        for (const event of events) {
          await handleDomainEvent(identityHandle.db, event);
        }
      },
      { queue: colaDePrueba },
    );

    sessionId = await sesionCerrada(patientId);
  }, 90_000);

  afterAll(async () => {
    if (!ready) return;

    await identityHandle.db
      .delete(identitySchema.auditEvents)
      .where(eq(identitySchema.auditEvents.actorUsername, MARKER));
    await identityHandle.db.delete(identitySchema.processedEvents);
    await borrarPaciente(patientId);
    await pdfRenderer.close();
    await rm(storageDir, { recursive: true, force: true });
    await boss.deleteQueue(colaDePrueba).catch(() => undefined);
    await stopBoss(boss).catch(() => undefined);
    await handle.close();
    await identityHandle.close();
  }, 60_000);

  it('el catálogo de medicamentos trae los de odontología y se puede buscar', async () => {
    const todos = await listMedications(handle.db, undefined, 100);
    expect(todos.total).toBeGreaterThanOrEqual(20);
    const nombres = todos.items.map((medication) => medication.name);
    expect(nombres).toContain('Amoxicilina');
    expect(nombres).toContain('Ibuprofeno');

    const amoxi = await listMedications(handle.db, 'amoxi');
    // Amoxicilina y amoxicilina + ácido clavulánico: las dos son «amoxi».
    expect(amoxi.total).toBe(2);
    expect(amoxi.items.every((medication) => /amoxi/i.test(medication.name))).toBe(true);
    expect(amoxi.items[0]?.presentations.length).toBeGreaterThan(0);
    expect(amoxi.items[0]?.usualDose).not.toBeNull();
  }, 30_000);

  it('el borrador del récipe se guarda por sesión y se reemplaza entero', async () => {
    const borrador = await saveDraft(handle.db, sessionId, receta(sessionId), actor);
    draftId = borrador.id;
    expect(borrador.status).toBe('borrador');
    expect(borrador.number).toBeNull();
    expect(borrador.itemCount).toBe(2);

    const conUno = await saveDraft(
      handle.db,
      sessionId,
      receta(sessionId, [receta(sessionId).items[0]!]),
      actor,
    );
    expect(conUno.id).toBe(draftId);
    expect(conUno.itemCount).toBe(1);

    const definitivo = await saveDraft(handle.db, sessionId, receta(sessionId), actor);
    expect(definitivo.items.map((item) => item.medicationName)).toEqual([
      'Amoxicilina',
      'Ibuprofeno',
    ]);
    expect(definitivo.items[0]?.position).toBe(1);
  }, 40_000);

  it('emitir toma un número, genera el PDF A5, lo archiva y deja el código', async () => {
    const emitido = await emitir(draftId);

    expect(emitido.status).toBe('emitida');
    expect(emitido.number).toMatch(/^RX-\d{6}$/);
    expect(emitido.verifyCode).toMatch(/^[A-Z0-9]{5}-[A-Z0-9]{5}$/);
    expect(emitido.hasPdf).toBe(true);
    expect(emitido.issuedAt).not.toBeNull();

    const pdf = await readPrescriptionPdf(handle.db, blobStore, draftId);
    expect(pdf.filename).toBe(`${emitido.number ?? ''}.pdf`);
    expect(pdf.buffer.subarray(0, 5).toString()).toBe('%PDF-');
    expect(pdf.buffer.byteLength).toBeGreaterThan(15_000);
    expect(pdf.sha256).toMatch(/^[a-f0-9]{64}$/);

    await flushOutbox();
    const rows = await waitForAudit((current) =>
      current.some((row) => row.action === 'prescription_issued'),
    );
    const evento = rows.find((row) => row.action === 'prescription_issued');
    expect(evento?.entityType).toBe('prescription');
    expect(evento?.summary).toContain(emitido.number ?? '');
  }, 90_000);

  it('la verificación pública confirma el récipe sin exponer datos clínicos', async () => {
    const filas = await handle.db
      .select({ verifyCode: prescriptions.verifyCode })
      .from(prescriptions)
      .where(eq(prescriptions.id, draftId))
      .limit(1);
    const code = filas[0]?.verifyCode ?? '';
    expect(code).toHaveLength(10);

    // Como lo escribe una persona: con guion y en minúsculas.
    const escrito = `${code.slice(0, 5)}-${code.slice(5)}`.toLowerCase();
    const verificacion = await verifyPrescription(handle.db, escrito, 'Consultorio de prueba');
    expect(verificacion.valid).toBe(true);
    if (verificacion.valid) {
      expect(verificacion.code).toBe(escrito.toUpperCase());
      expect(verificacion.patientReference).toBe('María P.');
      expect(verificacion.dentistName).toBe('Od. Erika Gómez');
      expect(verificacion.itemCount).toBe(2);
      expect(verificacion.status).toBe('emitida');
      // Ni diagnóstico ni medicamentos: la página pública no los lleva.
      expect(JSON.stringify(verificacion)).not.toContain('Amoxicilina');
      expect(JSON.stringify(verificacion)).not.toContain('Pulpitis');
    }

    const inventado = await verifyPrescription(handle.db, 'ZZZZZ-ZZZZZ', 'Consultorio de prueba');
    expect(inventado.valid).toBe(false);
  }, 40_000);

  it('no se emite dos veces y la reimpresión queda contada y auditada', async () => {
    const otraVez = await emitir(draftId).catch((error: unknown) => error);
    expect(otraVez).toBeInstanceOf(ConflictError);

    expect((await registerPrescriptionPrint(handle.db, draftId, actor)).printCount).toBe(1);
    expect((await registerPrescriptionPrint(handle.db, draftId, actor)).printCount).toBe(2);

    await flushOutbox();
    const rows = await waitForAudit(
      (current) => current.filter((row) => row.action === 'prescription_reprinted').length === 2,
    );
    expect(rows.filter((row) => row.action === 'prescription_reprinted')).toHaveLength(2);
  }, 60_000);

  it('un récipe emitido se anula con motivo y su PDF sigue archivado', async () => {
    const anulado = await annulPrescription(
      handle.db,
      draftId,
      { reason: 'El paciente ya estaba tomando el antibiótico' },
      actor,
    );
    expect(anulado.status).toBe('anulada');
    expect(anulado.annulReason).toContain('antibiótico');

    const pdf = await readPrescriptionPdf(handle.db, blobStore, draftId);
    expect(pdf.buffer.byteLength).toBeGreaterThan(15_000);

    const verificacion = await verifyPrescription(
      handle.db,
      String(anulado.verifyCode).replace('-', ''),
      'Consultorio de prueba',
    );
    expect(verificacion.valid).toBe(true);
    if (verificacion.valid) expect(verificacion.status).toBe('anulada');

    // Y se puede preparar otro récipe para la misma sesión.
    const nuevo = await saveDraft(handle.db, sessionId, receta(sessionId), actor);
    expect(nuevo.id).not.toBe(draftId);
    expect(nuevo.status).toBe('borrador');
    draftId2 = nuevo.id;

    await flushOutbox();
    const rows = await waitForAudit((current) =>
      current.some((row) => row.action === 'prescription_annulled'),
    );
    const anulacion = rows.find((row) => row.action === 'prescription_annulled');
    expect(anulacion?.reason).toContain('antibiótico');
  }, 60_000);

  it('dos emisiones simultáneas reciben números distintos', async () => {
    const otroPaciente = globalThis.crypto.randomUUID();
    try {
      const primera = sessionId;
      const segunda = await sesionCerrada(otroPaciente);

      const borradores = await Promise.all([
        saveDraft(handle.db, primera, receta(primera), actor),
        saveDraft(handle.db, segunda, receta(segunda), actor),
      ]);
      // Uno de los dos usa el borrador nuevo de la sesión principal y el otro el suyo.
      const emitidos = await Promise.all([
        emitir(borradores[0]!.id),
        emitir(borradores[1]!.id, otroPaciente),
      ]);

      const numeros = emitidos.map((emitido) => emitido.number);
      expect(new Set(numeros).size).toBe(2);
      expect(numeros.every((numero) => /^RX-\d{6}$/.test(numero ?? ''))).toBe(true);
    } finally {
      await borrarPaciente(otroPaciente);
    }
  }, 150_000);

  it('el historial del paciente lista los récipes con su número y su PDF', async () => {
    const historial = await listPrescriptionsByPatient(handle.db, patientId);
    expect(historial.total).toBeGreaterThanOrEqual(2);

    const conNumero = historial.items.filter((item) => item.number !== null);
    expect(conNumero.length).toBeGreaterThanOrEqual(2);
    expect(conNumero.every((item) => item.hasPdf)).toBe(true);
    // La sesión lleva dos récipes: el anulado y el que lo reemplazó.
    expect(conNumero.some((item) => item.status === 'anulada')).toBe(true);
    expect(conNumero.some((item) => item.id === draftId2 && item.status === 'emitida')).toBe(true);

    // Del más reciente al más antiguo.
    const [primero, segundo] = historial.items;
    expect(
      primero !== undefined && segundo !== undefined && primero.createdAt >= segundo.createdAt,
    ).toBe(true);
  }, 60_000);

  it('los adjuntos viven en el almacén y solo se borran en una sesión en borrador', async () => {
    const abierta = await openSession(
      handle.db,
      patientId,
      { appointmentId: null, motivo: null },
      actor,
    );
    const sesionBorrador = abierta.detail.id;

    const subida = await saveAttachment(
      handle.db,
      blobStore,
      {
        sessionId: sesionBorrador,
        kind: 'radiografia',
        originalName: 'periapical 26.png',
        mime: 'image/png',
        data: PNG_1X1,
        caption: 'Periapical de la 26',
        toothNumber: 26,
      },
      actor,
    );
    expect(subida.size).toBe(PNG_1X1.byteLength);
    expect(subida.toothNumber).toBe(26);
    expect(subida.uploadedByUsername).toBe(MARKER);
    expect(await blobStore.exists(attachmentKey(sesionBorrador, subida.id))).toBe(true);

    const listado = await listAttachments(handle.db, sesionBorrador);
    expect(listado.total).toBe(1);

    const { absolutePath } = await getAttachmentFile(
      handle.db,
      blobStore,
      sesionBorrador,
      subida.id,
    );
    expect(absolutePath).toContain(storageDir);

    // Un adjunto de otra sesión no se sirve por esta ruta.
    const ajeno = await getAttachmentFile(handle.db, blobStore, sessionId, subida.id).catch(
      (error: unknown) => error,
    );
    expect((ajeno as { status?: number }).status).toBe(404);

    // Un tipo que no se admite se rechaza antes de escribir nada.
    const exe = await saveAttachment(
      handle.db,
      blobStore,
      {
        sessionId: sesionBorrador,
        kind: 'documento',
        originalName: 'virus.exe',
        mime: 'application/x-msdownload',
        data: Buffer.from('MZ'),
      },
      actor,
    ).catch((error: unknown) => error);
    expect((exe as { status?: number }).status).toBe(415);

    // Borrarla en borrador se puede; en una sesión cerrada, no.
    await deleteAttachment(handle.db, blobStore, sesionBorrador, subida.id, actor);
    expect((await listAttachments(handle.db, sesionBorrador)).total).toBe(0);
    expect(await blobStore.exists(attachmentKey(sesionBorrador, subida.id))).toBe(false);

    const rechazado = await deleteAttachment(
      handle.db,
      blobStore,
      sessionId,
      subida.id,
      actor,
    ).catch((error: unknown) => error);
    expect(rechazado).toBeInstanceOf(ConflictError);

    await flushOutbox();
    const rows = await waitForAudit((current) =>
      current.some((row) => row.action === 'clinical_session_file_uploaded'),
    );
    expect(rows.map((row) => row.action)).toContain('clinical_session_file_removed');

    // Al borrar la sesión de borrador, sus adjuntos se van con ella (cascada).
    await handle.db.execute(sql`delete from clinical_sessions where id = ${sesionBorrador}`);
    expect((await listAttachments(handle.db, sesionBorrador)).total).toBe(0);
  }, 90_000);
});
