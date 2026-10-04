import { TEST_WAIT_MS } from '@odontocrm/testing';
import { clinicalSessionContentSchema, type ClinicalSessionContent } from '@odontocrm/contracts';
import {
  consumerQueueName,
  createBoss,
  createOutboxRunner,
  ensureDomainEventsQueue,
  registerDomainEventHandler,
  startBoss,
  stopBoss,
} from '@odontocrm/db';
import { ConflictError, NotFoundError } from '@odontocrm/kernel';
import { and, eq } from 'drizzle-orm';
import type { PgBoss } from 'pg-boss';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { handleDomainEvent } from '../../identity/dist/audit/event-consumer.js';
import { loadIdentityConfig } from '../../identity/dist/config.js';
import { createIdentityDatabase } from '../../identity/dist/db/client.js';
import * as identitySchema from '../../identity/dist/db/schema.js';
import {
  amendSession,
  closeSession,
  findOpenSession,
  getSessionDetail,
  getSessionStatus,
  listSessionsByAppointment,
  listSessionsByPatient,
  openSession,
  saveSession,
} from './clinical/session-service.js';
import { loadClinicalConfig } from './config.js';
import { createClinicalDatabase } from './db/client.js';
import { clinicalSessions, medicalRecords } from './db/schema.js';

/**
 * Pruebas de integración de la Fase 7 (sesión A) contra PostgreSQL real:
 *  1. la sesión se numera por paciente y abrirla dos veces devuelve el mismo
 *     borrador (idempotencia con índice único parcial por cita incluido);
 *  2. el borrador se autoguarda sin escribir cuando no cambia nada;
 *  3. no se cierra una sesión vacía, y una vez cerrada **no se edita**;
 *  4. el cierre y la enmienda viajan por el outbox hasta la auditoría de identity;
 *  5. el estado que consulta la agenda para el «atendido» sale de aquí.
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
const MARKER = `prueba-fase7a-${suffix}`;

/** Cola propia de esta suite: se borra al terminar. */
const colaDePrueba = consumerQueueName('prueba-sesiones');

const actor = {
  actorId: null,
  actorUsername: MARKER,
  ip: '127.0.0.1',
  userAgent: 'vitest',
  requestId: `req-${suffix}`,
};

const patientId = globalThis.crypto.randomUUID();
const otroPaciente = globalThis.crypto.randomUUID();
const appointmentId = globalThis.crypto.randomUUID();

const contenidoConProcedimientos = (): ClinicalSessionContent =>
  clinicalSessionContentSchema.parse({
    ...clinicalSessionContentSchema.parse({}),
    motivo: 'Control de la obturación de la 26',
    vitals: { taSistolica: 120, taDiastolica: 80, fc: 72, temperatura: 36.5, spo2: 98, peso: 68.4 },
    exam: { encias: 'normal', higiene: 'buena' },
    procedimientos: [
      { code: 'obturacion_resina', toothNumber: 26, surfaces: ['occlusal', 'mesial'] },
      { code: 'profilaxis' },
    ],
    materiales: [{ code: 'resina_compuesta', cantidad: '1 tubo' }],
    diagnostico: 'Caries oclusal en 26',
    indicaciones: 'No comer hasta que pase el efecto de la anestesia',
    proximaCitaNota: 'Control en seis meses',
  });

describeWithDatabases('sesiones clínicas: numeración, autoguardado y cierre', () => {
  let handle: Awaited<ReturnType<typeof createClinicalDatabase>>;
  let identityHandle: Awaited<ReturnType<typeof createIdentityDatabase>>;
  let boss: PgBoss;
  let sessionId = '';
  let enmendadaId = '';

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
    const deadline = Date.now() + TEST_WAIT_MS;
    let rows = await auditRows();
    while (!predicate(rows) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      rows = await auditRows();
    }
    return rows;
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

    boss = createBoss({ connectionString: eventsUrl, applicationName: 'odontocrm-test-fase7a' });
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
  }, 30_000);

  afterAll(async () => {
    if (!ready) return;

    await identityHandle.db
      .delete(identitySchema.auditEvents)
      .where(eq(identitySchema.auditEvents.actorUsername, MARKER));
    await identityHandle.db.delete(identitySchema.processedEvents);
    await handle.db.delete(clinicalSessions).where(eq(clinicalSessions.patientId, patientId));
    await handle.db.delete(clinicalSessions).where(eq(clinicalSessions.patientId, otroPaciente));
    await handle.db.delete(medicalRecords).where(eq(medicalRecords.patientId, patientId));
    await handle.db.delete(medicalRecords).where(eq(medicalRecords.patientId, otroPaciente));
    await boss.deleteQueue(colaDePrueba).catch(() => undefined);
    await stopBoss(boss).catch(() => undefined);
    await handle.close();
    await identityHandle.close();
  });

  it('abre la sesión (y la historia si no existía) y la numera por paciente', async () => {
    const primera = await openSession(
      handle.db,
      patientId,
      { appointmentId, motivo: 'Dolor en la 26' },
      actor,
    );
    sessionId = primera.detail.id;
    expect(primera.created).toBe(true);
    expect(primera.detail.sessionNumber).toBe(1);
    expect(primera.detail.status).toBe('borrador');
    expect(primera.detail.appointmentId).toBe(appointmentId);
    expect(primera.detail.content.motivo).toBe('Dolor en la 26');

    // Abrir otra vez devuelve el mismo borrador: el doctor no pierde lo escrito.
    const repetida = await openSession(
      handle.db,
      patientId,
      { appointmentId, motivo: 'Otro' },
      actor,
    );
    expect(repetida.created).toBe(false);
    expect(repetida.detail.id).toBe(sessionId);
    expect(repetida.detail.content.motivo).toBe('Dolor en la 26');

    // Otro paciente estrena la numeración en 1.
    const otro = await openSession(
      handle.db,
      otroPaciente,
      { appointmentId: null, motivo: null },
      actor,
    );
    expect(otro.detail.sessionNumber).toBe(1);

    const abierta = await findOpenSession(handle.db, patientId);
    expect(abierta?.id).toBe(sessionId);
  }, 40_000);

  it('el borrador se autoguarda y no se ensucia cuando no cambia nada', async () => {
    const contenido = contenidoConProcedimientos();
    const guardado = await saveSession(handle.db, sessionId, { content: contenido });
    expect(guardado.changed).toBe(true);
    expect(guardado.detail.procedureCount).toBe(2);
    expect(guardado.detail.summary).toContain('Obturación con resina compuesta');

    const otraVez = await saveSession(handle.db, sessionId, { content: contenido });
    expect(otraVez.changed).toBe(false);

    const detalle = await getSessionDetail(handle.db, sessionId);
    expect(detalle.content.vitals.taSistolica).toBe(120);
    expect(detalle.content.procedimientos[0]?.surfaces).toEqual(['occlusal', 'mesial']);
  }, 40_000);

  it('no se cierra una sesión vacía y, cerrada, no se edita', async () => {
    const vacia = await openSession(
      handle.db,
      otroPaciente,
      { appointmentId: null, motivo: null },
      actor,
    );
    const sinContenido = await closeSession(
      handle.db,
      vacia.detail.id,
      { confirm: true, closureNote: null },
      actor,
    ).catch((error: unknown) => error);
    expect(sinContenido).toBeInstanceOf(ConflictError);
    expect((sinContenido as ConflictError).extensions['missing']).toEqual(['contenido']);
  }, 40_000);

  it('cerrar deja la sesión inmutable y el acto en la auditoría', async () => {
    const cerrada = await closeSession(
      handle.db,
      sessionId,
      { confirm: true, closureNote: 'Paciente sin molestias' },
      actor,
    );
    expect(cerrada.status).toBe('cerrada');
    expect(cerrada.closedAt).not.toBeNull();
    expect(cerrada.closedByUsername).toBe(MARKER);
    expect(cerrada.closureNote).toBe('Paciente sin molestias');

    // Ya no se autoguarda: la corrección pasa por una enmienda con motivo.
    const edicion = await saveSession(handle.db, sessionId, {
      content: contenidoConProcedimientos(),
    }).catch((error: unknown) => error);
    expect(edicion).toBeInstanceOf(ConflictError);
    expect((edicion as ConflictError).extensions['status']).toBe('cerrada');

    const estado = await getSessionStatus(handle.db, sessionId);
    expect(estado).toMatchObject({ status: 'cerrada', patientId, appointmentId });

    await flushOutbox();
    const rows = await waitForAudit((current) =>
      current.some((row) => row.action === 'clinical_session_closed'),
    );
    const cierre = rows.find((row) => row.action === 'clinical_session_closed');
    expect(cierre?.entityType).toBe('clinical_session');
    expect(cierre?.summary).toContain('cerrada');
    expect(cierre?.reason).toBe('Paciente sin molestias');
    expect(rows.map((row) => row.action)).toContain('clinical_session_created');
  }, 40_000);

  it('la enmienda abre una sesión nueva en borrador sin tocar la cerrada', async () => {
    const enmendada = await amendSession(
      handle.db,
      sessionId,
      { reason: 'El procedimiento era en la 27, no en la 26' },
      actor,
    );
    enmendadaId = enmendada.id;

    expect(enmendada.status).toBe('borrador');
    expect(enmendada.sessionNumber).toBe(2);
    expect(enmendada.amendedFromId).toBe(sessionId);
    expect(enmendada.amendmentReason).toContain('la 27');
    expect(enmendada.procedureCount).toBe(2);

    // La original sigue cerrada y con su contenido intacto.
    const original = await getSessionDetail(handle.db, sessionId);
    expect(original.status).toBe('cerrada');
    expect(original.content.procedimientos[0]?.toothNumber).toBe(26);

    // Y la enmendada se puede editar y cerrar por su cuenta.
    const editada = await saveSession(handle.db, enmendadaId, {
      content: clinicalSessionContentSchema.parse({
        ...enmendada.content,
        procedimientos: [{ code: 'obturacion_resina', toothNumber: 27, surfaces: ['occlusal'] }],
      }),
    });
    expect(editada.changed).toBe(true);
    expect(editada.detail.procedureCount).toBe(1);

    await flushOutbox();
    const rows = await waitForAudit((current) =>
      current.some((row) => row.action === 'clinical_session_amended'),
    );
    const enmienda = rows.find((row) => row.action === 'clinical_session_amended');
    expect(enmienda?.reason).toContain('la 27');
  }, 40_000);

  it('el historial del paciente y el de la cita se listan de la última a la primera', async () => {
    const porPaciente = await listSessionsByPatient(handle.db, patientId);
    expect(porPaciente.total).toBe(2);
    expect(porPaciente.items.map((item) => item.sessionNumber)).toEqual([2, 1]);
    expect(porPaciente.items[0]?.amendedFromId).toBe(sessionId);

    const porCita = await listSessionsByAppointment(handle.db, appointmentId);
    expect(porCita.items.map((item) => item.id)).toEqual([enmendadaId, sessionId]);

    // Una sesión que no existe responde con un error explícito, no con `null`.
    await expect(
      getSessionDetail(handle.db, globalThis.crypto.randomUUID()),
    ).rejects.toBeInstanceOf(NotFoundError);
  }, 40_000);

  it('el cierre con la sesión ya cerrada no se repite', async () => {
    const otraVez = await closeSession(
      handle.db,
      sessionId,
      { confirm: true, closureNote: null },
      actor,
    ).catch((error: unknown) => error);
    expect(otraVez).toBeInstanceOf(ConflictError);

    const filas = await handle.db
      .select({ id: clinicalSessions.id })
      .from(clinicalSessions)
      .where(
        and(eq(clinicalSessions.patientId, patientId), eq(clinicalSessions.status, 'cerrada')),
      );
    expect(filas).toHaveLength(1);
  }, 40_000);
});
