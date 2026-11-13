import {
  acceptConsentSchema,
  clinicalSessionContentSchema,
  createAmendmentSchema,
  hasPenicillinAllergy,
  missingSignatureSections,
  type AcceptConsentInput,
  type CreateAmendmentInput,
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
import { TEST_WAIT_MS } from '@odontocrm/testing';
import { ConflictError } from '@odontocrm/kernel';
import { and, eq } from 'drizzle-orm';
import type { PgBoss } from 'pg-boss';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { handleDomainEvent } from '../../identity/dist/audit/event-consumer.js';
import { loadIdentityConfig } from '../../identity/dist/config.js';
import { createIdentityDatabase } from '../../identity/dist/db/client.js';
import * as identitySchema from '../../identity/dist/db/schema.js';
import {
  acceptConsent,
  createAmendment,
  getRecordDetail,
  openRecord,
  registerPrint,
  saveSection,
  signRecord,
} from './clinical/record-service.js';
import { closeSession, openSession, saveSession } from './clinical/session-service.js';
import { loadClinicalConfig } from './config.js';
import { createClinicalDatabase } from './db/client.js';
import { medicalRecords } from './db/schema.js';

/**
 * Pruebas de integración de la Fase 6 (sesión A) contra PostgreSQL real:
 *  1. cada transición de la historia (apertura, guardado, consentimiento, firma,
 *     adenda e impresión) viaja por el outbox y la **cola compartida** hasta la
 *     auditoría de identity con su acción y su motivo;
 *  2. el bloqueo de firma sin secciones obligatorias y la inmutabilidad de una
 *     historia firmada se comprueban contra la base, no contra el contrato.
 *
 * Los módulos de identity se importan desde su `dist` compilado (es lo que corre
 * en producción); por eso `npm run test:integration` exige `npm run build` antes.
 */
const clinicalUrl = process.env['TEST_CLINICAL_DATABASE_URL'];
const identityUrl = process.env['TEST_IDENTITY_DATABASE_URL'];
const eventsUrl = process.env['TEST_EVENTS_DATABASE_URL'];

const ready = clinicalUrl !== undefined && identityUrl !== undefined && eventsUrl !== undefined;
const describeWithDatabases = ready ? describe : describe.skip;

const suffix = String(Date.now()).slice(-7);
const MARKER = `prueba-fase6a-${suffix}`;

/** Cola propia de esta suite: se borra al terminar. */
const colaDePrueba = consumerQueueName('prueba-clinical');

const actor = {
  actorId: null,
  actorUsername: MARKER,
  ip: '127.0.0.1',
  userAgent: 'vitest',
  requestId: `req-${suffix}`,
};

const patientId = globalThis.crypto.randomUUID();

/**
 * UUIDs de los ítems de diagnóstico (v1.2.1). El plan de tratamiento se enlaza a ellos
 * por `diagnosticoId`; el servidor los valida como cualquier uuid real.
 */
const diagnosticoCariesId = globalThis.crypto.randomUUID();
const diagnosticoGingivitisId = globalThis.crypto.randomUUID();
const diagnosticoNuevoId = globalThis.crypto.randomUUID();

const seccionesCompletas = {
  motivo_consulta: { relato: 'Dolor en el molar inferior derecho desde hace tres días' },
  anamnesis: {
    sinAntecedentes: false,
    alergias: { items: ['penicilina'], otros: null },
    patologicos: { items: [], otros: null },
    medicamentos: { items: [], otros: null },
    cirugias: { items: [], otros: null },
    familiares: { items: [], otros: null },
    habitos: { items: [], otros: null },
  },
  examen_extraoral: {
    tejidosBlandos: 'normal',
    ganglios: 'normal',
    atm: 'normal',
    musculatura: 'normal',
  },
  examen_intraoral: {
    encias: 'alterado',
    relacionMolar: 'tipo_i',
    relacionCanina: 'tipo_ii',
    hallazgos: 'Sangrado leve al sondaje',
  },
  diagnostico: {
    items: [
      { id: diagnosticoCariesId, descripcion: 'Pulpitis irreversible en 46', piezas: '46' },
      {
        id: diagnosticoGingivitisId,
        descripcion: 'Gingivitis marginal localizada',
        piezas: 'sector anterosuperior',
      },
    ],
    saludBucalGeneral: 'regular',
    observaciones: null,
  },
  plan_tratamiento: {
    procedimientos: [
      {
        diagnosticoId: diagnosticoCariesId,
        descripcion: 'Endodoncia 46',
        prioridad: 'alta',
        pieza: '46',
        presupuesto: null,
      },
      {
        diagnosticoId: diagnosticoGingivitisId,
        descripcion: 'Detartraje y control de placa',
        prioridad: 'media',
        pieza: 'sector anterosuperior',
        presupuesto: null,
      },
      {
        diagnosticoId: null,
        descripcion: 'Profilaxis y control semestral',
        prioridad: 'baja',
        pieza: null,
        presupuesto: null,
      },
    ],
    alternativas: null,
    aceptacionPaciente: null,
    observaciones: null,
  },
} as const;

const consentimiento: AcceptConsentInput = acceptConsentSchema.parse({
  accepted: true,
  acceptedByName: `Paciente de Prueba ${suffix}`,
  acceptedByDocument: '12345678',
  relationship: 'paciente',
  witnessName: null,
  notes: null,
});

const adenda: CreateAmendmentInput = createAmendmentSchema.parse({
  sectionKey: 'diagnostico',
  reason: 'Se confirmó el diagnóstico con la radiografía',
  content: 'El diagnóstico definitivo es necrosis pulpar en 46',
});

describeWithDatabases('historia clínica: auditoría por outbox y reglas de firma', () => {
  let handle: Awaited<ReturnType<typeof createClinicalDatabase>>;
  let identityHandle: Awaited<ReturnType<typeof createIdentityDatabase>>;
  let boss: PgBoss;
  let recordId = '';

  const auditRows = async () =>
    identityHandle.db
      .select({
        action: identitySchema.auditEvents.action,
        actorUsername: identitySchema.auditEvents.actorUsername,
        changedFields: identitySchema.auditEvents.changedFields,
        reason: identitySchema.auditEvents.reason,
        entityType: identitySchema.auditEvents.entityType,
      })
      .from(identitySchema.auditEvents)
      .where(
        and(
          eq(identitySchema.auditEvents.entityType, 'medical_record'),
          eq(identitySchema.auditEvents.entityId, recordId),
        ),
      );

  /**
   * Vacía el outbox **por completo**: un solo ciclo reclama como mucho 50 eventos
   * (`dispatchOutbox`) y esta suite produce más, así que un único ciclo dejaba
   * eventos pendientes al azar y la auditoría aparecía incompleta. Se repite hasta
   * que no quede nada reclamable, como hace el publicador real cada pocos segundos.
   */
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

    boss = createBoss({ connectionString: eventsUrl, applicationName: 'odontocrm-test-fase6a' });
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
    await handle.db.delete(medicalRecords).where(eq(medicalRecords.patientId, patientId));
    await boss.deleteQueue(colaDePrueba).catch(() => undefined);
    await stopBoss(boss).catch(() => undefined);
    await handle.close();
    await identityHandle.close();
  });

  it('no se puede firmar sin las secciones obligatorias ni sin consentimiento', async () => {
    const abierta = await openRecord(handle.db, patientId, actor);
    recordId = abierta.detail.id;
    expect(abierta.created).toBe(true);

    // Abrirla otra vez es idempotente: devuelve la misma historia.
    const repetida = await openRecord(handle.db, patientId, actor);
    expect(repetida.created).toBe(false);
    expect(repetida.detail.id).toBe(recordId);

    const sinSecciones = await signRecord(handle.db, recordId, actor).catch(
      (error: unknown) => error,
    );
    expect(sinSecciones).toBeInstanceOf(ConflictError);
    expect((sinSecciones as ConflictError).extensions['missingSections']).toContain(
      'motivo_consulta',
    );

    for (const [sectionKey, content] of Object.entries(seccionesCompletas)) {
      await saveSection(handle.db, recordId, sectionKey as never, content as never, actor);
    }

    const sinConsentimiento = await signRecord(handle.db, recordId, actor).catch(
      (error: unknown) => error,
    );
    expect(sinConsentimiento).toBeInstanceOf(ConflictError);
    expect((sinConsentimiento as ConflictError).extensions['missingSections']).toEqual([
      'consentimiento',
    ]);
  }, 40_000);

  it('guardar el diagnóstico abre en el plan un procedimiento por ítem, sin perder los libres', async () => {
    const guardado = await saveSection(
      handle.db,
      recordId,
      'diagnostico',
      {
        items: [
          { id: diagnosticoCariesId, descripcion: 'Pulpitis irreversible en 46', piezas: '46' },
          {
            id: diagnosticoGingivitisId,
            descripcion: 'Gingivitis marginal localizada',
            piezas: 'sector anterosuperior',
          },
          {
            id: diagnosticoNuevoId,
            descripcion: 'Caries oclusal en la 36',
            piezas: '36',
          },
        ],
        saludBucalGeneral: 'regular',
        observaciones: null,
      },
      actor,
    );

    const procedimientos = (guardado.sections['plan_tratamiento']?.['procedimientos'] ??
      []) as Array<Record<string, unknown>>;
    const enlazados = procedimientos.filter(
      (procedimiento) => procedimiento['diagnosticoId'] !== null,
    );
    // Un procedimiento por ítem, en el orden del diagnóstico y con su pieza.
    expect(enlazados.map((procedimiento) => procedimiento['diagnosticoId'])).toEqual([
      diagnosticoCariesId,
      diagnosticoGingivitisId,
      diagnosticoNuevoId,
    ]);
    expect(enlazados.map((procedimiento) => procedimiento['pieza'])).toEqual([
      '46',
      'sector anterosuperior',
      '36',
    ]);
    // Los ya escritos se conservan; el ítem nuevo nace por completar (descripción vacía).
    expect(enlazados.map((procedimiento) => procedimiento['descripcion'])).toEqual([
      'Endodoncia 46',
      'Detartraje y control de placa',
      '',
    ]);
    expect(enlazados[2]?.['prioridad']).toBe('media');
    // El procedimiento libre sigue intacto al final.
    expect(
      procedimientos
        .filter((procedimiento) => procedimiento['diagnosticoId'] === null)
        .map((procedimiento) => procedimiento['descripcion']),
    ).toEqual(['Profilaxis y control semestral']);
  }, 40_000);

  it('la firma se bloquea mientras un diagnóstico no tenga su tratamiento descrito', async () => {
    const bloqueada = await signRecord(handle.db, recordId, actor).catch((error: unknown) => error);
    expect(bloqueada).toBeInstanceOf(ConflictError);
    expect((bloqueada as ConflictError).extensions['missingSections']).toContain(
      'plan_tratamiento',
    );
  }, 40_000);

  it('guardar el plan sanea enlaces huérfanos y borrar un diagnóstico elimina su procedimiento', async () => {
    const completado = await saveSection(
      handle.db,
      recordId,
      'plan_tratamiento',
      {
        procedimientos: [
          {
            diagnosticoId: diagnosticoCariesId,
            descripcion: 'Endodoncia 46',
            prioridad: 'alta',
            pieza: '46',
            presupuesto: 250,
          },
          {
            diagnosticoId: diagnosticoGingivitisId,
            descripcion: 'Detartraje y control de placa',
            prioridad: 'media',
            pieza: 'sector anterosuperior',
            presupuesto: null,
          },
          {
            diagnosticoId: diagnosticoNuevoId,
            descripcion: 'Obturación oclusal en la 36',
            prioridad: 'media',
            pieza: '36',
            presupuesto: 90,
          },
        ],
        alternativas: null,
        aceptacionPaciente: null,
        observaciones: null,
      },
      actor,
    );
    const planCompleto = (completado.sections['plan_tratamiento']?.['procedimientos'] ??
      []) as Array<Record<string, unknown>>;
    expect(planCompleto).toHaveLength(3);
    // La pieza la sigue mandando el diagnóstico, no el plan que llegó.
    expect(planCompleto[0]?.['pieza']).toBe('46');

    // Una petición fuera de orden con un `diagnosticoId` que ya no existe se descarta.
    const saneado = await saveSection(
      handle.db,
      recordId,
      'plan_tratamiento',
      {
        procedimientos: [
          ...planCompleto,
          {
            diagnosticoId: globalThis.crypto.randomUUID(),
            descripcion: 'Procedimiento de un diagnóstico borrado',
            prioridad: 'media',
            pieza: null,
            presupuesto: null,
          },
        ],
        alternativas: null,
        aceptacionPaciente: null,
        observaciones: null,
      },
      actor,
    );
    const planSaneado = (saneado.sections['plan_tratamiento']?.['procedimientos'] ?? []) as Array<
      Record<string, unknown>
    >;
    expect(planSaneado).toHaveLength(3);
    expect(
      planSaneado.some((procedimiento) =>
        String(procedimiento['descripcion']).includes('diagnóstico borrado'),
      ),
    ).toBe(false);

    // Al borrar el ítem de diagnóstico, su procedimiento enlazado se va con él.
    const borrado = await saveSection(
      handle.db,
      recordId,
      'diagnostico',
      {
        items: [
          { id: diagnosticoCariesId, descripcion: 'Pulpitis irreversible en 46', piezas: '46' },
          {
            id: diagnosticoGingivitisId,
            descripcion: 'Gingivitis marginal localizada',
            piezas: 'sector anterosuperior',
          },
        ],
        saludBucalGeneral: 'regular',
        observaciones: null,
      },
      actor,
    );
    const planTrasBorrar = (borrado.sections['plan_tratamiento']?.['procedimientos'] ??
      []) as Array<Record<string, unknown>>;
    expect(planTrasBorrar).toHaveLength(2);
    expect(
      planTrasBorrar.some((procedimiento) => procedimiento['diagnosticoId'] === diagnosticoNuevoId),
    ).toBe(false);
    // La historia vuelve a estar en condiciones de firmarse.
    expect(borrado.missingSections).toEqual([]);
  }, 60_000);

  it('la historia guardada detecta la alergia y queda auditada sección a sección', async () => {
    const detalle = await acceptConsent(handle.db, recordId, consentimiento, actor).then(() =>
      signRecord(handle.db, recordId, actor),
    );

    expect(detalle.status).toBe('firmada');
    expect(hasPenicillinAllergy(detalle.sections)).toBe(true);
    expect(missingSignatureSections(detalle.sections)).toEqual([]);

    await flushOutbox();
    const rows = await waitForAudit((current) =>
      current.some((row) => row.action === 'medical_record_signed'),
    );
    const acciones = rows.map((row) => row.action);

    expect(acciones).toContain('medical_record_created');
    expect(acciones).toContain('medical_record_updated');
    expect(acciones).toContain('medical_record_consent_accepted');
    expect(acciones).toContain('medical_record_signed');
    expect(rows.every((row) => row.actorUsername === MARKER)).toBe(true);
  }, 40_000);

  it('una historia firmada no se edita: solo admite adendas con motivo', async () => {
    const edicion = await saveSection(
      handle.db,
      recordId,
      'diagnostico',
      { items: [], saludBucalGeneral: null, observaciones: null },
      actor,
    ).catch((error: unknown) => error);
    expect(edicion).toBeInstanceOf(ConflictError);

    const detalle = await createAmendment(handle.db, recordId, adenda, actor);
    expect(detalle.amendments).toHaveLength(1);
    expect(detalle.amendmentCount).toBe(1);

    await flushOutbox();
    const rows = await waitForAudit((current) =>
      current.some((row) => row.action === 'medical_record_amended'),
    );
    const amendment = rows.find((row) => row.action === 'medical_record_amended');
    expect(amendment?.reason).toBe(adenda.reason);
  }, 40_000);

  it('la impresión deja constancia con su actor (la secretaría solo lee)', async () => {
    const printed = await registerPrint(handle.db, recordId, actor);
    expect(printed.printCount).toBe(1);

    await flushOutbox();
    const rows = await waitForAudit((current) =>
      current.some((row) => row.action === 'medical_record_printed'),
    );
    expect(rows.map((row) => row.action)).toContain('medical_record_printed');
  }, 40_000);

  it('la evolución proyecta las sesiones cerradas aunque la historia ya esté firmada', async () => {
    const contenido = clinicalSessionContentSchema.parse({
      motivo: 'Control de la endodoncia de la 46',
      procedimientos: [{ code: 'control_postoperatorio', toothNumber: 46 }],
      diagnostico: 'Evolución favorable, sin dolor',
      observaciones: 'Paciente sin dolor a la percusión; se indica control en seis meses.',
    });

    const abierta = await openSession(
      handle.db,
      patientId,
      { appointmentId: null, motivo: 'Control de la endodoncia de la 46' },
      actor,
    );
    await saveSession(handle.db, abierta.detail.id, { content: contenido });
    const cerrada = await closeSession(
      handle.db,
      abierta.detail.id,
      { confirm: true, closureNote: 'Control cerrado en la prueba' },
      actor,
    );
    expect(cerrada.status).toBe('cerrada');

    // Una segunda sesión que sigue abierta no puede aparecer en la evolución.
    const borrador = await openSession(
      handle.db,
      patientId,
      { appointmentId: null, motivo: 'Sesión que sigue abierta' },
      actor,
    );

    const detalle = await getRecordDetail(handle.db, recordId);
    expect(detalle.status).toBe('firmada');
    const resumen = detalle.evolutionSessions.find((session) => session.id === abierta.detail.id);
    expect(resumen).toBeDefined();
    expect(resumen?.sessionNumber).toBe(1);
    expect(resumen?.fecha).toBe(cerrada.closedAt);
    expect(resumen?.diagnostico).toBe('Evolución favorable, sin dolor');
    expect(resumen?.tratamientos).toEqual(['Control postoperatorio · pieza 46']);
    expect(resumen?.observaciones).toBe(
      'Paciente sin dolor a la percusión; se indica control en seis meses.',
    );
    // La sesión sin cerrar todavía no es evolución.
    expect(detalle.evolutionSessions.some((session) => session.id === borrador.detail.id)).toBe(
      false,
    );
  }, 60_000);
});
