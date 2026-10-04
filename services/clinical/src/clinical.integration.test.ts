import {
  acceptConsentSchema,
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
  openRecord,
  registerPrint,
  saveSection,
  signRecord,
} from './clinical/record-service.js';
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
  examen_intraoral: { encias: 'alterado', hallazgos: 'Sangrado leve al sondaje' },
  diagnostico: { principal: 'Pulpitis irreversible en 46' },
  plan_tratamiento: { procedimientos: [{ descripcion: 'Endodoncia 46', prioridad: 'alta' }] },
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

  const flushOutbox = async (): Promise<void> => {
    const runner = createOutboxRunner({ pool: handle.pool, boss });
    await runner.flush();
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
      { principal: 'Otro diagnóstico' },
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
});
