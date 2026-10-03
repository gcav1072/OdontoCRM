import {
  createPatientSchema,
  formatDocument,
  updatePatientSchema,
  type CreatePatientInput,
  type DocType,
  type PatientFilters,
} from '@odontocrm/contracts';
import {
  createBoss,
  createOutboxRunner,
  ensureDomainEventsQueue,
  registerDomainEventHandler,
  startBoss,
  stopBoss,
} from '@odontocrm/db';
import { EVENT_TOPICS, createDomainEvent } from '@odontocrm/events';
import { and, eq, like } from 'drizzle-orm';
import type { PgBoss } from 'pg-boss';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { handleDomainEvent } from '../../identity/dist/audit/event-consumer.js';
import { loadIdentityConfig } from '../../identity/dist/config.js';
import { createIdentityDatabase } from '../../identity/dist/db/client.js';
import * as identitySchema from '../../identity/dist/db/schema.js';
import { loadPatientsConfig } from './config.js';
import { createPatientsDatabase } from './db/client.js';
import { patients } from './db/schema.js';
import {
  createPatient,
  listPatients,
  lookupByDocumentText,
  updatePatient,
} from './patients/patient-service.js';

/**
 * Pruebas de integración de la Fase 2 contra PostgreSQL real:
 *  1. el cambio de un paciente viaja por el outbox y la **cola compartida** hasta
 *     la auditoría de identity, con los campos que cambiaron y el motivo;
 *  2. la búsqueda responde en menos de 300 ms con 5.000 pacientes.
 *
 * Los módulos de identity se importan desde su `dist` compilado (es lo que corre
 * en producción); por eso `npm run test:integration` exige `npm run build` antes.
 */
const patientsUrl = process.env['TEST_PATIENTS_DATABASE_URL'];
const identityUrl = process.env['TEST_IDENTITY_DATABASE_URL'];
const eventsUrl = process.env['TEST_EVENTS_DATABASE_URL'];

const ready = patientsUrl !== undefined && identityUrl !== undefined && eventsUrl !== undefined;
const describeWithDatabases = ready ? describe : describe.skip;

const suffix = String(Date.now()).slice(-7);
const MARKER = `prueba-fase2-${suffix}`;

const actor = {
  actorId: null,
  actorUsername: MARKER,
  ip: '127.0.0.1',
  userAgent: 'vitest',
  requestId: `req-${suffix}`,
};

/**
 * Igual que el borde HTTP: la prueba pasa por los esquemas del contrato, que son
 * los que normalizan el documento, el teléfono y los textos. El servicio confía en
 * datos ya validados, así que saltarse el esquema probaría algo que no ocurre en
 * producción.
 */
const aPatient = (overrides: Partial<CreatePatientInput> = {}): CreatePatientInput =>
  createPatientSchema.parse({
    docType: 'V' as DocType,
    docNumber: `8${suffix}`,
    fullName: `Paciente de Prueba ${suffix}`,
    birthDate: '1990-05-15',
    sex: 'F',
    phone: '+584121234567',
    phoneAlt: null,
    email: null,
    address: 'Calle de prueba, casa 1',
    occupation: 'Docente',
    notes: null,
    ...overrides,
  });

describeWithDatabases('auditoría de pacientes por el outbox (PostgreSQL real)', () => {
  let patientsHandle: Awaited<ReturnType<typeof createPatientsDatabase>>;
  let identityHandle: Awaited<ReturnType<typeof createIdentityDatabase>>;
  let boss: PgBoss;
  let patientId = '';

  const auditRows = async (): Promise<
    Array<{
      action: string;
      actorUsername: string | null;
      changedFields: string[];
      before: Record<string, unknown> | null;
      after: Record<string, unknown> | null;
      reason: string | null;
    }>
  > => {
    const rows = await identityHandle.db
      .select({
        action: identitySchema.auditEvents.action,
        actorUsername: identitySchema.auditEvents.actorUsername,
        changedFields: identitySchema.auditEvents.changedFields,
        before: identitySchema.auditEvents.before,
        after: identitySchema.auditEvents.after,
        reason: identitySchema.auditEvents.reason,
      })
      .from(identitySchema.auditEvents)
      .where(
        and(
          eq(identitySchema.auditEvents.entityType, 'patient'),
          eq(identitySchema.auditEvents.entityId, patientId),
        ),
      );
    return rows as never;
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

    patientsHandle = createPatientsDatabase(
      loadPatientsConfig({
        DATABASE_URL: patientsUrl,
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

    boss = createBoss({ connectionString: eventsUrl, applicationName: 'odontocrm-test-fase2' });
    await startBoss(boss);
    await ensureDomainEventsQueue(boss);

    // El mismo trabajador que corre en identity: convierte los eventos de la cola
    // compartida en registros de auditoría.
    await registerDomainEventHandler(boss, async (events) => {
      for (const event of events) {
        await handleDomainEvent(identityHandle.db, event);
      }
    });
  }, 30_000);

  afterAll(async () => {
    if (!ready) return;

    if (patientId !== '') {
      await identityHandle.db
        .delete(identitySchema.auditEvents)
        .where(eq(identitySchema.auditEvents.entityId, patientId));
    }
    await identityHandle.db.delete(identitySchema.processedEvents);
    await patientsHandle.db.delete(patients).where(like(patients.fullName, `%${suffix}%`));
    await stopBoss(boss).catch(() => undefined);
    await patientsHandle.close();
    await identityHandle.close();
  });

  it('el alta del paciente queda auditada con sus campos y el motivo', async () => {
    const created = await createPatient(patientsHandle.db, aPatient(), {
      ...actor,
      reason: 'alta desde registro',
    });
    patientId = created.id;

    const runner = createOutboxRunner({ pool: patientsHandle.pool, boss });
    const result = await runner.flush();
    expect(result.published).toBeGreaterThanOrEqual(1);

    // El consumidor de identity convierte el evento en auditoría (trabajador de la cola).
    const rows = await waitForAudit((current) => current.length > 0);
    const row = rows.find((item) => item.action === 'patient_created');

    expect(row).toBeDefined();
    expect(row?.actorUsername).toBe(MARKER);
    expect(row?.changedFields).toContain('fullName');
    expect(row?.after).toMatchObject({ fullName: `Paciente de Prueba ${suffix}` });
    expect(row?.reason).toBe('alta desde registro');
  }, 40_000);

  it('la edición queda auditada con el valor anterior, el nuevo y el motivo', async () => {
    await updatePatient(
      patientsHandle.db,
      patientId,
      updatePatientSchema.parse({
        phone: '0414-9998877',
        reason: 'cambió de número de teléfono',
      }),
      actor,
    );

    const runner = createOutboxRunner({ pool: patientsHandle.pool, boss });
    await runner.flush();

    const rows = await waitForAudit((current) =>
      current.some((item) => item.action === 'patient_updated'),
    );
    const update = rows.find((item) => item.action === 'patient_updated');

    expect(update?.changedFields).toEqual(['phone']);
    expect(update?.before).toMatchObject({ phone: '+584121234567' });
    expect(update?.after).toMatchObject({ phone: '+584149998877' });
    expect(update?.reason).toBe('cambió de número de teléfono');
  }, 40_000);

  it('un evento con carga inválida no se audita ni se marca como procesado', async () => {
    const broken = createDomainEvent({
      topic: EVENT_TOPICS.patientCreated,
      aggregateId: globalThis.crypto.randomUUID(),
      producer: 'patients',
      payload: { algo: 'incompleto' },
    });

    const summary = await handleDomainEvent(identityHandle.db, broken);
    expect(summary).toEqual({ processed: false, reason: 'carga_invalida' });
  });

  it('un evento repetido no duplica la auditoría (idempotencia)', async () => {
    const event = createDomainEvent({
      topic: EVENT_TOPICS.patientUpdated,
      aggregateId: patientId,
      producer: 'patients',
      payload: {
        patientId,
        document: formatDocument('V', `8${suffix}`),
        fullName: `Paciente de Prueba ${suffix}`,
        action: 'updated',
        changedFields: ['address'],
        before: { address: 'vieja' },
        after: { address: 'nueva' },
        reason: 'prueba de idempotencia',
        actorId: null,
        actorUsername: MARKER,
        ip: null,
        userAgent: null,
        requestId: null,
      },
    });

    const first = await handleDomainEvent(identityHandle.db, event);
    const second = await handleDomainEvent(identityHandle.db, event);

    expect(first.processed).toBe(true);
    expect(second).toEqual({ processed: false, reason: 'duplicado' });

    const rows = await identityHandle.db
      .select({ id: identitySchema.auditEvents.id })
      .from(identitySchema.auditEvents)
      .where(
        and(
          eq(identitySchema.auditEvents.entityId, patientId),
          eq(identitySchema.auditEvents.reason, 'prueba de idempotencia'),
        ),
      );
    expect(rows).toHaveLength(1);
  });

  it('el documento repetido devuelve conflicto con el paciente existente', async () => {
    await expect(
      createPatient(patientsHandle.db, aPatient({ fullName: `Otro ${suffix}` }), actor),
    ).rejects.toMatchObject({ status: 409, extensions: { existingPatientId: patientId } });
  });

  it('buscar por el documento escrito de tres formas devuelve al mismo paciente', async () => {
    const byPlain = await lookupByDocumentText(patientsHandle.db, `8${suffix}`);
    const byFormatted = await lookupByDocumentText(patientsHandle.db, `V-8${suffix}`);
    const byDotted = await lookupByDocumentText(patientsHandle.db, `v 8.${suffix}`);

    expect(byPlain?.id).toBe(patientId);
    expect(byFormatted?.id).toBe(patientId);
    expect(byDotted?.id).toBe(patientId);
  });
});

describeWithDatabases('búsqueda con 5.000 pacientes', () => {
  let handle: Awaited<ReturnType<typeof createPatientsDatabase>>;
  const TOTAL = 5_000;
  const marker = `carga-${suffix}`;

  beforeAll(async () => {
    if (patientsUrl === undefined) throw new Error('falta TEST_PATIENTS_DATABASE_URL');
    handle = createPatientsDatabase(
      loadPatientsConfig({ DATABASE_URL: patientsUrl, LOG_LEVEL: 'silent' }),
    );

    const rows: (typeof patients.$inferInsert)[] = [];
    for (let index = 0; index < TOTAL; index += 1) {
      rows.push({
        docType: 'V',
        docNumber: `97${String(index).padStart(6, '0')}`,
        fullName: `${marker} Paciente ${String(index).padStart(5, '0')}`,
        birthDate: `19${String(60 + (index % 40)).padStart(2, '0')}-0${String((index % 9) + 1)}-1${String(index % 9)}`,
        sex: index % 3 === 0 ? 'M' : 'F',
        phone: `+58414${String(index).padStart(7, '0')}`,
        status: 'activo',
        isFictitious: true,
      });
    }

    const BATCH = 1000;
    for (let offset = 0; offset < rows.length; offset += BATCH) {
      await handle.db.insert(patients).values(rows.slice(offset, offset + BATCH));
    }
  }, 90_000);

  afterAll(async () => {
    if (patientsUrl === undefined) return;
    await handle.db.delete(patients).where(like(patients.fullName, `${marker}%`));
    await handle.close();
  });

  const measure = async (filters: Partial<PatientFilters>): Promise<number> => {
    const startedAt = performance.now();
    const page = await listPatients(handle.db, {
      page: 1,
      pageSize: 25,
      ...filters,
    } as PatientFilters);
    const elapsed = performance.now() - startedAt;
    expect(page.items.length).toBeGreaterThan(0);
    return elapsed;
  };

  it('por nombre, documento, teléfono, edad y filtros combinados: todas < 300 ms', async () => {
    // Los datos se generan como `92` + índice de 7 dígitos y `+58414` + lo mismo:
    // la búsqueda usa fragmentos que existen de verdad.
    const timings: Record<string, number> = {
      nombre: await measure({ search: `${marker} Paciente 04000` }),
      documento: await measure({ search: '97004000' }),
      documentoConPrefijo: await measure({ search: 'V-97004000' }),
      telefono: await measure({ search: '4140004000' }),
      rangoEdad: await measure({ ageMin: 30, ageMax: 45 }),
      combinados: await measure({ status: 'activo', sex: 'F', ageMin: 18, ageMax: 60 }),
    };

    for (const [name, elapsed] of Object.entries(timings)) {
      // eslint-disable-next-line no-console -- informe de la prueba de rendimiento
      console.log(`   · búsqueda por ${name}: ${elapsed.toFixed(1)} ms`);
      expect(elapsed, `la búsqueda por ${name} superó los 300 ms`).toBeLessThan(300);
    }
  }, 60_000);

  it('el documento exacto resuelve a un único paciente', async () => {
    const page = await listPatients(handle.db, {
      page: 1,
      pageSize: 25,
      search: 'V-97004000',
    } as PatientFilters);
    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.docNumber).toBe('97004000');
  });

  it('el rango de edad respeta los límites', async () => {
    const page = await listPatients(handle.db, {
      page: 1,
      pageSize: 200,
      ageMin: 64,
      ageMax: 65,
    } as PatientFilters);
    for (const item of page.items) {
      expect(item.age).toBeGreaterThanOrEqual(64);
      expect(item.age).toBeLessThanOrEqual(65);
    }
  });
});
