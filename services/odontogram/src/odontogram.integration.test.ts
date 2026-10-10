import type {
  ClinicalState,
  OdontogramDetail,
  RecordFindingInput,
  ToothCondition,
  ToothSurface,
} from '@odontocrm/contracts';
import {
  consumerQueueName,
  countPendingEvents,
  createBoss,
  createOutboxRunner,
  ensureDomainEventsQueue,
  outboxEvents,
  registerDomainEventHandler,
  startBoss,
  stopBoss,
} from '@odontocrm/db';
import { TEST_WAIT_MS } from '@odontocrm/testing';
import { ConflictError, NotFoundError } from '@odontocrm/kernel';
import { and, eq, inArray, isNotNull, isNull } from 'drizzle-orm';
import type { PgBoss } from 'pg-boss';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { handleDomainEvent } from '../../identity/dist/audit/event-consumer.js';
import { loadIdentityConfig } from '../../identity/dist/config.js';
import { createIdentityDatabase } from '../../identity/dist/db/client.js';
import * as identitySchema from '../../identity/dist/db/schema.js';
import { loadOdontogramConfig } from './config.js';
import { createOdontogramDatabase } from './db/client.js';
import { odontograms, toothFindingHistory, toothFindings } from './db/schema.js';
import {
  MAX_HISTORY_LIMIT,
  clearSurface,
  completeProcedure,
  deleteFinding,
  getHistory,
  getInternalSummary,
  getOdontogramByPatient,
  recordFinding,
  recordFindingsBatch,
  registerPrint,
} from './odontogram/chart-service.js';

/**
 * Pruebas de integración de la Fase 6 (sesión B) contra PostgreSQL real:
 *
 *  1. se carga una boca por la vía de la **carga rápida** (lote transaccional) y se
 *     lee bien el **patrón por excepción** (la pieza sana es la ausencia de fila);
 *  2. cada cambio deja fila en `tooth_finding_history` (append-only) y viaja por el
 *     outbox y la **cola compartida** hasta la auditoría de identity;
 *  3. las reglas que el servidor no delega en la interfaz: sin cambios no se
 *     escribe, la pieza completa manda sobre las caras (ADR 0031), la cara no
 *     convive con una pieza completa vigente y el lote es atómico.
 *
 * Los módulos de identity se importan desde su `dist` compilado (es lo que corre
 * en producción); por eso `npm run test:integration` exige `npm run build` antes.
 */
const odontogramUrl = process.env['TEST_ODONTOGRAM_DATABASE_URL'];
const identityUrl = process.env['TEST_IDENTITY_DATABASE_URL'];
const eventsUrl = process.env['TEST_EVENTS_DATABASE_URL'];

const ready = odontogramUrl !== undefined && identityUrl !== undefined && eventsUrl !== undefined;
const describeWithDatabases = ready ? describe : describe.skip;

const suffix = String(Date.now()).slice(-7);
const MARKER = `prueba-fase6b-${suffix}`;

/** Cola propia de esta suite: se borra al terminar. */
const colaDePrueba = consumerQueueName('prueba-odontogram');

const actor = {
  actorId: null,
  actorUsername: MARKER,
  ip: '127.0.0.1',
  userAgent: 'vitest',
  requestId: `req-${suffix}`,
};

/** Paciente de la boca principal y dos pacientes de borde (sin odontograma). */
const patientId = globalThis.crypto.randomUUID();
const pacienteTemporal = globalThis.crypto.randomUUID();
const pacienteSinBoca = globalThis.crypto.randomUUID();
/** Boca propia de las pruebas de procedimientos: no altera los conteos de la principal. */
const pacienteProcedimientos = globalThis.crypto.randomUUID();

const hallazgo = (input: {
  toothNumber: number;
  condition: ToothCondition;
  surface?: ToothSurface | null;
  state?: ClinicalState;
  notes?: string | null;
}): RecordFindingInput => ({
  toothNumber: input.toothNumber,
  surface: input.surface ?? null,
  condition: input.condition,
  state: input.state ?? 'pendiente',
  notes: input.notes ?? null,
  sessionId: null,
});

describeWithDatabases('odontograma FDI: patrón por excepción, histórico y auditoría', () => {
  let handle: Awaited<ReturnType<typeof createOdontogramDatabase>>;
  let identityHandle: Awaited<ReturnType<typeof createIdentityDatabase>>;
  let boss: PgBoss;
  let odontogramId = '';

  const auditRows = async () =>
    identityHandle.db
      .select({
        action: identitySchema.auditEvents.action,
        actorUsername: identitySchema.auditEvents.actorUsername,
        changedFields: identitySchema.auditEvents.changedFields,
        summary: identitySchema.auditEvents.summary,
        entityType: identitySchema.auditEvents.entityType,
        entityId: identitySchema.auditEvents.entityId,
        after: identitySchema.auditEvents.after,
      })
      .from(identitySchema.auditEvents)
      .where(
        and(
          eq(identitySchema.auditEvents.entityType, 'odontogram'),
          eq(identitySchema.auditEvents.entityId, odontogramId),
        ),
      );

  /**
   * Vacía el outbox **por completo**.
   *
   * Un solo ciclo reclama como mucho 50 eventos (`dispatchOutbox`), y esta suite
   * produce más: con un único ciclo quedaban pendientes al azar según el orden en
   * que corrieran las pruebas (el «outbox a cero» fallaba una de cada tres
   * corridas). Se repite hasta que no quede nada reclamable, que es lo que hace el
   * publicador real cada pocos segundos.
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

  const leerBoca = async (): Promise<OdontogramDetail> => {
    const lookup = await getOdontogramByPatient(handle.db, patientId);
    if (!lookup.exists) throw new Error('el paciente debería tener odontograma');
    return lookup.odontogram;
  };

  /**
   * Filas vigentes de una pieza. El `odontogram` se puede indicar: la suite tiene
   * **dos pacientes** (el de la boca por lotes y el de los procedimientos) y cada uno
   * tiene su propio odontograma; leer el equivocado devolvía listas vacías.
   */
  const filasDePieza = async (toothNumber: number, odontogram: string = odontogramId) =>
    handle.db
      .select()
      .from(toothFindings)
      .where(
        and(eq(toothFindings.odontogramId, odontogram), eq(toothFindings.toothNumber, toothNumber)),
      );

  const historial = async (odontogram: string = odontogramId) =>
    handle.db
      .select()
      .from(toothFindingHistory)
      .where(eq(toothFindingHistory.odontogramId, odontogram));

  /**
   * Resumen legible del histórico, para que un fallo diga **qué** había en la
   * tabla en vez de solo el número: estas suites corren en paralelo con las de los
   * demás servicios contra la misma base de la cola, y un «expected 1 to be 2» sin
   * contexto no permite distinguir un fallo real de una interferencia.
   */
  const historialResumen = async (odontogram: string = odontogramId): Promise<string> => {
    const filas = await historial(odontogram);
    return `odontograma=${odontogram} filas=${String(filas.length)} · ${filas
      .map((fila) => `${String(fila.toothNumber)}/${String(fila.surface)}/${fila.event}`)
      .join(', ')}`;
  };

  beforeAll(async () => {
    if (!ready) throw new Error('faltan las variables TEST_* de bases de datos');

    handle = createOdontogramDatabase(
      loadOdontogramConfig({
        DATABASE_URL: odontogramUrl,
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

    boss = createBoss({ connectionString: eventsUrl, applicationName: 'odontocrm-test-fase6b' });
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
    await identityHandle.db
      .delete(identitySchema.processedEvents)
      .where(eq(identitySchema.processedEvents.producer, 'odontogram'));
    await handle.db.delete(outboxEvents).where(eq(outboxEvents.producer, 'odontogram'));
    // Las tablas del odontograma caen en cascada con la fila del odontograma.
    await handle.db
      .delete(odontograms)
      .where(inArray(odontograms.patientId, [patientId, pacienteTemporal, pacienteSinBoca]));
    await boss.deleteQueue(colaDePrueba).catch(() => undefined);
    await stopBoss(boss).catch(() => undefined);
    await handle.close();
    await identityHandle.close();
  });

  it('carga la boca por lotes y la lee por excepción: lo que no tiene fila está sano', async () => {
    const lote: RecordFindingInput[] = [
      hallazgo({ toothNumber: 16, surface: 'occlusal', condition: 'caries' }),
      hallazgo({
        toothNumber: 16,
        surface: 'vestibular',
        condition: 'restauracion',
        state: 'completado',
      }),
      hallazgo({ toothNumber: 26, surface: 'occlusal', condition: 'caries' }),
      hallazgo({ toothNumber: 36, condition: 'ausente', state: 'completado' }),
      hallazgo({ toothNumber: 46, condition: 'corona', state: 'completado' }),
    ];

    const resultado = await recordFindingsBatch(handle.db, patientId, { findings: lote }, actor);
    odontogramId = resultado.odontogram.id;

    expect(resultado.unchanged).toBe(false);
    expect(resultado.resolvedSurfaces).toEqual([]);
    expect(resultado.odontogram.dentition).toBe('permanente');
    expect(resultado.odontogram.empty).toBe(false);
    expect(resultado.odontogram.affectedTeeth).toEqual([16, 26, 36, 46]);
    expect(Object.keys(resultado.odontogram.findings).sort()).toEqual(['16', '26', '36', '46']);
    // La pieza sana **no** aparece: ni la 11 ni la 21 tienen fila.
    expect(resultado.odontogram.findings['11']).toBeUndefined();
    expect(resultado.odontogram.findings['16']).toHaveLength(2);
    expect(resultado.odontogram.findings['36']?.[0]).toMatchObject({
      toothNumber: 36,
      surface: null,
      condition: 'ausente',
      state: 'completado',
      resolvedAt: null,
    });

    // Y al volver a leerla, el patrón se mantiene.
    const deNuevo = await leerBoca();
    expect(deNuevo.findings['26']).toHaveLength(1);

    const resumen = await getInternalSummary(handle.db, patientId);
    expect(resumen).toEqual({
      patientId,
      hasOdontogram: true,
      affectedTeeth: 4,
      conditionCounts: { caries: 2, restauracion: 1, ausente: 1, corona: 1 },
      pendingCount: 2,
      completedCount: 3,
    });

    const historialInicial = await historial();
    expect(historialInicial.length, await historialResumen()).toBe(5);
    expect(historialInicial.every((row) => row.event === 'registrado')).toBe(true);

    await flushOutbox();
    const rows = await waitForAudit((current) => current.length >= 5);
    expect(rows.filter((row) => row.action === 'tooth_finding_recorded')).toHaveLength(5);
    expect(rows.every((row) => row.actorUsername === MARKER)).toBe(true);
    expect(rows.every((row) => row.entityType === 'odontogram')).toBe(true);
  }, 40_000);

  it('la dentición se deriva de los hallazgos vigentes: aparece la mixta (ADR 0051)', async () => {
    const primera = await recordFinding(
      handle.db,
      pacienteTemporal,
      hallazgo({ toothNumber: 55, surface: 'occlusal', condition: 'caries' }),
      actor,
    );
    expect(primera.odontogram.dentition).toBe('temporal');

    // Al entrar una pieza permanente, la boca pasa a **mixta**: el paciente está
    // mudando. Ya no se queda fijada en la dentición del primer hallazgo.
    const segunda = await recordFinding(
      handle.db,
      pacienteTemporal,
      hallazgo({ toothNumber: 11, surface: 'occlusal', condition: 'caries' }),
      actor,
    );
    expect(segunda.odontogram.dentition).toBe('mixta');

    // Y al corregir la captura (se borra la permanente) vuelve a ser temporal: la
    // dentición sigue a los hallazgos **vigentes**, no a la historia.
    const tercera = await deleteFinding(
      handle.db,
      pacienteTemporal,
      { toothNumber: 11, surface: 'occlusal', condition: 'caries' },
      actor,
    );
    expect(tercera.odontogram.dentition).toBe('temporal');

    const sinBoca = await getOdontogramByPatient(handle.db, pacienteSinBoca);
    expect(sinBoca).toMatchObject({ exists: false, patientId: pacienteSinBoca, patient: null });
    expect(await getInternalSummary(handle.db, pacienteSinBoca)).toEqual({
      patientId: pacienteSinBoca,
      hasOdontogram: false,
      affectedTeeth: 0,
      conditionCounts: {},
      pendingCount: 0,
      completedCount: 0,
    });
  }, 40_000);

  it('sin cambios no se escribe ni se audita (el autoguardado repite a menudo)', async () => {
    const antesHistorial = (await historial()).length;
    const pendientesAntes = await countPendingEvents(handle.pool);

    const repetido = await recordFinding(
      handle.db,
      patientId,
      hallazgo({ toothNumber: 16, surface: 'occlusal', condition: 'caries' }),
      actor,
    );

    expect(repetido.unchanged).toBe(true);
    expect(repetido.resolvedSurfaces).toEqual([]);
    expect((await historial()).length).toBe(antesHistorial);
    expect(await countPendingEvents(handle.pool)).toBe(pendientesAntes);
  }, 40_000);

  it('cambiar el estado de un hallazgo queda como actualizado en el histórico y en la auditoría', async () => {
    // La restauración admite pendiente y completado (la caries solo pendiente, spec §2):
    // el cambio de estado se prueba sobre la restauración de la 16.
    const resultado = await recordFinding(
      handle.db,
      patientId,
      hallazgo({
        toothNumber: 16,
        surface: 'vestibular',
        condition: 'restauracion',
        state: 'pendiente',
      }),
      actor,
    );

    expect(resultado.unchanged).toBe(false);
    const restauracion = resultado.odontogram.findings['16']?.find(
      (row) => row.condition === 'restauracion',
    );
    expect(restauracion?.state).toBe('pendiente');

    const filas = (await historial()).filter((row) => row.event === 'actualizado');
    expect(filas).toHaveLength(1);
    expect(filas[0]).toMatchObject({
      toothNumber: 16,
      surface: 'vestibular',
      condition: 'restauracion',
      state: 'pendiente',
      actorUsername: MARKER,
    });

    await flushOutbox();
    const rows = await waitForAudit((current) =>
      current.some((row) => row.action === 'tooth_finding_updated'),
    );
    const actualizado = rows.find((row) => row.action === 'tooth_finding_updated');
    expect(actualizado?.changedFields).toEqual(['pieza 16', 'vestibular']);
    expect(actualizado?.summary).toContain('restauración');
  }, 40_000);

  it('`ausente` manda sobre las caras (ADR 0032) sin borrar el dato', async () => {
    const resultado = await recordFinding(
      handle.db,
      patientId,
      hallazgo({ toothNumber: 16, condition: 'ausente', state: 'completado' }),
      actor,
    );

    // Las dos caras vigentes de la 16 (vestibular y oclusal) quedan superadas.
    expect(resultado.resolvedSurfaces).toEqual(['vestibular', 'occlusal']);
    expect(resultado.odontogram.findings['16']).toHaveLength(1);
    expect(resultado.odontogram.findings['16']?.[0]?.condition).toBe('ausente');

    const filas = await filasDePieza(16);
    expect(filas).toHaveLength(3);
    const superadas = filas.filter((row) => row.resolvedAt !== null);
    expect(superadas.map((row) => row.surface).sort()).toEqual(['occlusal', 'vestibular']);
    // Las filas superadas siguen en la base: el histórico las conserva.
    expect(
      superadas.every((row) => row.condition === 'caries' || row.condition === 'restauracion'),
    ).toBe(true);

    const superados = (await historial()).filter((row) => row.event === 'superado');
    // El fallo tiene que decir **qué** filas de más hay: si aparece un `superado`
    // duplicado, el mensaje trae el odontograma y las filas completas.
    expect(
      superados.map((row) => `${String(row.toothNumber)}/${String(row.surface)}/${row.id}`),
      `odontograma ${odontogramId}`,
    ).toHaveLength(2);
    expect(superados.every((row) => row.reason?.includes('ausente'))).toBe(true);

    await flushOutbox();
    const rows = await waitForAudit((current) =>
      current.some((row) => row.action === 'tooth_finding_superseded'),
    );
    expect(rows.filter((row) => row.action === 'tooth_finding_superseded')).toHaveLength(2);
  }, 40_000);

  it('el conducto convive con la corona y con la caries; la corona cubre lo que había debajo', async () => {
    // A la 46 le añadimos caries y conducto sobre una pieza que ya tenía «corona»: la
    // caries va **después** de la corona, así que es la recurrente y se registra.
    const caries = await recordFinding(
      handle.db,
      patientId,
      hallazgo({ toothNumber: 46, surface: 'occlusal', condition: 'caries' }),
      actor,
    );
    expect(caries.resolvedSurfaces).toEqual([]);
    expect(caries.odontogram.findings['46']).toHaveLength(2);

    const conducto = await recordFinding(
      handle.db,
      patientId,
      hallazgo({ toothNumber: 46, condition: 'endodoncia' }),
      actor,
    );
    // Un conducto no recubre nada: ni supera la caries ni la corona.
    expect(conducto.resolvedSurfaces).toEqual([]);
    expect(conducto.odontogram.findings['46']?.map((row) => row.condition).sort()).toEqual([
      'caries',
      'corona',
      'endodoncia',
    ]);
    expect((await filasDePieza(46)).every((row) => row.resolvedAt === null)).toBe(true);

    // En un mismo lote, la corona con la caries que tenía debajo: la caries queda
    // **cubierta** (no se borra), y da igual el orden en que la interfaz las mande.
    const lote = await recordFindingsBatch(
      handle.db,
      patientId,
      {
        findings: [
          hallazgo({ toothNumber: 47, condition: 'corona', state: 'completado' }),
          hallazgo({ toothNumber: 47, surface: 'occlusal', condition: 'caries' }),
        ],
      },
      actor,
    );
    expect(lote.unchanged).toBe(false);
    expect(lote.resolvedSurfaces).toEqual(['occlusal']);
    // Vigente solo la corona: el gráfico enseña la corona, no el empaste de debajo.
    expect(lote.odontogram.findings['47']?.map((row) => row.condition)).toEqual(['corona']);
    // Y el dato sigue en la base, superado y con su motivo.
    const superada = (await filasDePieza(47)).find((row) => row.surface === 'occlusal');
    expect(superada?.resolvedAt).not.toBeNull();
  }, 40_000);

  it('`ausente` no admite nada más y las parejas imposibles se rechazan (409)', async () => {
    // La 16 quedó ausente: ni caries ni corona conviven con eso.
    const sobreAusente = await recordFinding(
      handle.db,
      patientId,
      hallazgo({ toothNumber: 16, surface: 'occlusal', condition: 'caries' }),
      actor,
    ).catch((error: unknown) => error);
    expect(sobreAusente).toBeInstanceOf(ConflictError);
    expect((sobreAusente as ConflictError).extensions['conflictingCondition']).toBe('ausente');

    // Un lote con `ausente` y cualquier otra cosa en la misma pieza se rechaza entero.
    const loteAusente = await recordFindingsBatch(
      handle.db,
      patientId,
      {
        findings: [
          hallazgo({ toothNumber: 21, condition: 'ausente' }),
          hallazgo({ toothNumber: 21, condition: 'corona' }),
        ],
      },
      actor,
    ).catch((error: unknown) => error);
    expect(loteAusente).toBeInstanceOf(ConflictError);

    // Un implante no tiene raíz que endodonciar: la pareja imposible se bloquea
    // tanto en la misma petición como en dos seguidas.
    const loteImposible = await recordFindingsBatch(
      handle.db,
      patientId,
      {
        findings: [
          hallazgo({ toothNumber: 22, condition: 'implante', state: 'completado' }),
          hallazgo({ toothNumber: 22, condition: 'endodoncia' }),
        ],
      },
      actor,
    ).catch((error: unknown) => error);
    expect(loteImposible).toBeInstanceOf(ConflictError);
    expect((await leerBoca()).findings['22']).toBeUndefined();

    const implante = await recordFinding(
      handle.db,
      patientId,
      hallazgo({ toothNumber: 22, condition: 'implante', state: 'completado' }),
      actor,
    );
    expect(implante.odontogram.findings['22']).toHaveLength(1);

    const conductoDespues = await recordFinding(
      handle.db,
      patientId,
      hallazgo({ toothNumber: 22, condition: 'endodoncia' }),
      actor,
    ).catch((error: unknown) => error);
    expect(conductoDespues).toBeInstanceOf(ConflictError);
    expect((conductoDespues as ConflictError).extensions['conflictingCondition']).toBe('implante');

    // Sin embargo, un conducto con corona sí convive: la otra pareja real.
    const coronaSobreConducto = await recordFinding(
      handle.db,
      patientId,
      hallazgo({ toothNumber: 23, condition: 'endodoncia' }),
      actor,
    ).then(() =>
      recordFinding(
        handle.db,
        patientId,
        hallazgo({ toothNumber: 23, condition: 'corona' }),
        actor,
      ),
    );
    expect(coronaSobreConducto.odontogram.findings['23']).toHaveLength(2);

    // Y si el choque aparece a mitad de la transacción, se deshace el lote entero.
    const atomico = await recordFindingsBatch(
      handle.db,
      patientId,
      {
        findings: [
          hallazgo({ toothNumber: 11, surface: 'occlusal', condition: 'caries' }),
          hallazgo({ toothNumber: 16, surface: 'vestibular', condition: 'caries' }),
        ],
      },
      actor,
    ).catch((error: unknown) => error);
    expect(atomico).toBeInstanceOf(ConflictError);
    expect((await leerBoca()).findings['11']).toBeUndefined();
  }, 40_000);

  it('borrar por clave natural y dejar la cara sana devuelven la pieza al estado sano', async () => {
    const borrado = await deleteFinding(
      handle.db,
      patientId,
      { toothNumber: 16, surface: null, condition: 'ausente' },
      actor,
    );
    expect(borrado.unchanged).toBe(false);
    expect((await leerBoca()).findings['16']).toBeUndefined();
    // Las caras superadas siguen ahí, con `resolved_at`, pero ya no se leen.
    const filas16 = await filasDePieza(16);
    expect(
      filas16.map((row) => [
        row.surface,
        row.condition,
        row.resolvedAt === null ? 'vigente' : 'superada',
      ]),
      `filas de la 16: ${JSON.stringify(filas16.map((row) => [row.surface, row.condition, row.resolvedAt === null ? 'vigente' : 'superada']))}`,
    ).toHaveLength(2);

    const caraSana = await clearSurface(
      handle.db,
      patientId,
      { toothNumber: 26, surface: 'occlusal' },
      actor,
    );
    expect(caraSana.unchanged).toBe(false);
    expect((await leerBoca()).findings['26']).toBeUndefined();
    expect(await filasDePieza(26)).toHaveLength(0);

    // Repetir no es un error: no había nada vigente que borrar.
    expect(
      (
        await deleteFinding(
          handle.db,
          patientId,
          { toothNumber: 16, surface: null, condition: 'ausente' },
          actor,
        )
      ).unchanged,
    ).toBe(true);
    expect(
      (await clearSurface(handle.db, patientId, { toothNumber: 26, surface: 'occlusal' }, actor))
        .unchanged,
    ).toBe(true);
    expect(
      (await clearSurface(handle.db, patientId, { toothNumber: 36, surface: 'vestibular' }, actor))
        .unchanged,
    ).toBe(true);

    const eliminados = (await historial()).filter((row) => row.event === 'eliminado');
    expect(eliminados.length, await historialResumen()).toBe(2);
    expect(eliminados.map((row) => row.condition).sort()).toEqual(['ausente', 'caries']);
    const ausente = eliminados.find((row) => row.condition === 'ausente');
    expect(ausente).toMatchObject({ toothNumber: 16, surface: null, state: 'completado' });
    expect(ausente?.reason).toContain('corrección de captura');

    await flushOutbox();
    /**
     * Se espera a los **dos** borrados, no a que llegue el primero: la cola puede
     * entregar el lote en dos tandas y la comprobación pasaba con uno solo (la
     * suite se caía cuando el segundo evento llegaba un poco más tarde).
     */
    const rows = await waitForAudit(
      (current) => current.filter((row) => row.action === 'tooth_finding_removed').length === 2,
    );
    expect(rows.filter((row) => row.action === 'tooth_finding_removed')).toHaveLength(2);
  }, 40_000);

  it('el histórico se lee ordenado y con su tope', async () => {
    const completo = await getHistory(handle.db, patientId, MAX_HISTORY_LIMIT);
    expect(completo.odontogramId).toBe(odontogramId);
    expect(completo.patientId).toBe(patientId);
    // 13 registros: los 5 del lote de carga rápida, `ausente` en la 16, caries y
    // conducto en la 46, corona con caries en la 47, el implante de la 22 y
    // conducto con corona en la 23. Más 1 actualización de estado, 2 caras
    // superadas por `ausente`, 1 superada por su corona (la caries del 47, que queda
    // cubierta) y 2 eliminaciones.
    expect(completo.entries).toHaveLength(19);
    const porEvento = completo.entries.reduce<Record<string, number>>((cuenta, entry) => {
      cuenta[entry.event] = (cuenta[entry.event] ?? 0) + 1;
      return cuenta;
    }, {});
    expect(porEvento).toEqual({ registrado: 13, actualizado: 1, superado: 3, eliminado: 2 });
    expect(completo.entries[0]?.event).toBe('eliminado');
    expect(completo.entries.at(-1)?.event).toBe('registrado');

    const uno = await getHistory(handle.db, patientId, 1);
    expect(uno.entries).toHaveLength(1);

    const sinOdontograma = await getHistory(handle.db, pacienteSinBoca).catch(
      (error: unknown) => error,
    );
    expect(sinOdontograma).toBeInstanceOf(NotFoundError);
  }, 40_000);

  it('la impresión deja constancia con su actor (la secretaría solo lee)', async () => {
    const printed = await registerPrint(handle.db, patientId, actor);
    expect(printed.id).toBe(odontogramId);
    expect(printed.printCount).toBe(1);
    expect(Number.isNaN(Date.parse(printed.lastPrintedAt))).toBe(false);

    const boca = await leerBoca();
    expect(boca.printCount).toBe(1);
    expect(boca.lastPrintedAt).toBe(printed.lastPrintedAt);

    await flushOutbox();
    const rows = await waitForAudit((current) =>
      current.some((row) => row.action === 'odontogram_printed'),
    );
    const impresion = rows.find((row) => row.action === 'odontogram_printed');
    expect(impresion?.actorUsername).toBe(MARKER);
    expect(impresion?.after).toMatchObject({ printCount: 1, patientId });
  }, 40_000);

  it('el outbox queda a cero después de publicar', async () => {
    await flushOutbox();

    // Si algo quedara pendiente, el fallo tiene que decir **qué** y **por qué**
    // (un `last_error` de pg-boss se lee solo; un «expected 1 to be 0» no).
    const pendientes = await handle.pool.query<{
      event_type: string;
      attempts: number;
      last_error: string | null;
    }>(
      `select event_type, attempts, last_error
         from outbox_events
        where published_at is null
        order by occurred_at`,
    );
    expect(
      await countPendingEvents(handle.pool),
      `pendientes: ${JSON.stringify(pendientes.rows)}`,
    ).toBe(0);

    const filas = await handle.db
      .select({ id: toothFindings.id })
      .from(toothFindings)
      .where(and(eq(toothFindings.odontogramId, odontogramId), isNull(toothFindings.resolvedAt)));
    // Quedan vigentes: 22 (implante), 23 (conducto + corona), 36 (ausente),
    // 46 (corona + caries + conducto) y 47 (corona) = 8 filas: la caries del 47 la
    // cubrió su corona, y lo cubierto **no se lee** (aunque siga en la base).
    expect(filas).toHaveLength(8);
    // Y 3 superadas: las 2 caras de la 16 que `ausente` dejó fuera de lectura, más la
    // caries del 47 que quedó debajo de la corona.
    expect(
      await handle.db
        .select({ id: toothFindings.id })
        .from(toothFindings)
        .where(
          and(eq(toothFindings.odontogramId, odontogramId), isNotNull(toothFindings.resolvedAt)),
        ),
    ).toHaveLength(3);
  }, 40_000);

  /**
   * El caso clínico que pidió el odontólogo: el diente y su soporte protésico pasan
   * por fases que no se pueden colapsar en un estado único.
   *
   * - **Fase quirúrgica:** `ausente` + `implante` — no hay corona natural y el
   *   implante ocupa su lugar. Antes esto se rechazaba y era imposible de registrar.
   * - **Fase rehabilitada:** `implante` + `corona` — la corona protésica ya está
   *   puesta, así que la ausencia **se quita**: una pieza no puede estar sin corona y
   *   con corona a la vez. El paso de una fase a otra es borrar `ausente` y marcar
   *   `corona`, que en la hoja son dos toques.
   */
  it('el implante convive con la pieza ausente (fase quirúrgica) y con la corona (rehabilitada)', async () => {
    // Fase quirúrgica: el implante colocado y la corona natural ausente, en la misma
    // transacción y sin conflicto.
    const quirofano = await recordFindingsBatch(
      handle.db,
      patientId,
      {
        findings: [
          hallazgo({ toothNumber: 24, condition: 'implante', state: 'completado' }),
          hallazgo({ toothNumber: 24, condition: 'ausente', state: 'completado' }),
        ],
      },
      actor,
    );
    expect((quirofano.odontogram.findings['24'] ?? []).map((row) => row.condition).sort()).toEqual([
      'ausente',
      'implante',
    ]);

    // Poner la corona sin quitar la ausencia es contradictorio y se rechaza.
    const coronaSobreAusente = await recordFinding(
      handle.db,
      patientId,
      hallazgo({ toothNumber: 24, condition: 'corona', state: 'completado' }),
      actor,
    ).catch((error: unknown) => error);
    expect(coronaSobreAusente).toBeInstanceOf(ConflictError);
    expect((coronaSobreAusente as ConflictError).extensions['conflictingCondition']).toBe(
      'ausente',
    );

    // Fase rehabilitada: se quita la ausencia (el diente ya tiene corona protésica) y
    // la corona convive con el implante que ya estaba.
    await deleteFinding(
      handle.db,
      patientId,
      { toothNumber: 24, surface: null, condition: 'ausente' },
      actor,
    );
    const rehabilitada = await recordFinding(
      handle.db,
      patientId,
      hallazgo({ toothNumber: 24, condition: 'corona', state: 'completado' }),
      actor,
    );
    expect(
      (rehabilitada.odontogram.findings['24'] ?? []).map((row) => row.condition).sort(),
    ).toEqual(['corona', 'implante']);

    // Lo que sigue prohibido: un conducto en una pieza con implante (409).
    const conducto = await recordFinding(
      handle.db,
      patientId,
      hallazgo({ toothNumber: 24, condition: 'endodoncia' }),
      actor,
    ).catch((error: unknown) => error);
    expect(conducto).toBeInstanceOf(ConflictError);
    expect((conducto as ConflictError).extensions['conflictingCondition']).toBe('implante');
  });

  /**
   * La excepción clínica que pidió el odontólogo: una corona **recubre el muñón en sus
   * 360°**, así que lo que hubiera debajo no se ve en boca (se supera, no se borra), y
   * una **caries recurrente** en el margen se registra *después* y sí se ve.
   */
  it('la caries recurrente sobre una corona se registra encima y el dato de debajo se conserva', async () => {
    // 1) Un diente con su restauración, antes de coronarlo.
    await recordFinding(
      handle.db,
      patientId,
      hallazgo({
        toothNumber: 44,
        surface: 'occlusal',
        condition: 'restauracion',
        state: 'completado',
      }),
      actor,
    );

    // 2) Se corona: la restauración queda cubierta y el gráfico se queda con la corona.
    const coronada = await recordFinding(
      handle.db,
      patientId,
      hallazgo({ toothNumber: 44, condition: 'corona', state: 'completado' }),
      actor,
    );
    expect(coronada.resolvedSurfaces).toEqual(['occlusal']);
    expect(coronada.odontogram.findings['44']?.map((row) => row.condition)).toEqual(['corona']);

    // La historia conserva las dos cosas con su fecha: es el respaldo médico legal de
    // lo que había debajo de la corona.
    const historial = await getHistory(handle.db, patientId, MAX_HISTORY_LIMIT);
    const deLa44 = historial.entries.filter((entry) => entry.toothNumber === 44);
    expect(deLa44.map((entry) => entry.event)).toEqual(
      expect.arrayContaining(['registrado', 'superado']),
    );
    const superada = deLa44.find((entry) => entry.event === 'superado');
    expect(superada?.reason).toContain('corona');
    expect(superada?.condition).toBe('restauracion');
    // Y en la base sigue la fila, con su `resolved_at`.
    const filaSuperada = (await filasDePieza(44)).find((row) => row.surface === 'occlusal');
    expect(filaSuperada?.resolvedAt).not.toBeNull();

    // 3) Años después, una filtración en el margen: caries sobre la corona. Se registra
    //    y se ve, porque la superación miró solo lo que había al poner la corona.
    const recurrente = await recordFinding(
      handle.db,
      patientId,
      hallazgo({ toothNumber: 44, surface: 'vestibular', condition: 'caries' }),
      actor,
    );
    expect(recurrente.resolvedSurfaces).toEqual([]);
    expect(recurrente.odontogram.findings['44']?.map((row) => row.condition).sort()).toEqual([
      'caries',
      'corona',
    ]);
  }, 40_000);

  it('el lote da el mismo resultado con las caras antes o después de la corona', async () => {
    // La hoja táctil manda el tratamiento con sus caras en una transacción; el orden en
    // que las mande no puede cambiar lo que se ve después.
    const coronaPrimero = await recordFindingsBatch(
      handle.db,
      patientId,
      {
        findings: [
          hallazgo({ toothNumber: 45, condition: 'corona', state: 'completado' }),
          hallazgo({ toothNumber: 45, surface: 'occlusal', condition: 'caries' }),
        ],
      },
      actor,
    );
    const carasPrimero = await recordFindingsBatch(
      handle.db,
      patientId,
      {
        findings: [
          hallazgo({ toothNumber: 43, surface: 'occlusal', condition: 'caries' }),
          hallazgo({ toothNumber: 43, condition: 'corona', state: 'completado' }),
        ],
      },
      actor,
    );

    for (const resultado of [coronaPrimero, carasPrimero]) {
      expect(resultado.resolvedSurfaces).toEqual(['occlusal']);
    }
    expect(coronaPrimero.odontogram.findings['45']?.map((row) => row.condition)).toEqual([
      'corona',
    ]);
    expect(carasPrimero.odontogram.findings['43']?.map((row) => row.condition)).toEqual(['corona']);
  }, 40_000);

  /**
   * El bug reportado: la pieza 13 quedó «extracción completada + implante», un estado
   * imposible. El servicio lo rechaza por partida doble —el estado no es válido para la
   * condición y la pareja no convive— y la base lo impide con su CHECK.
   */
  it('la pieza imposible del informe se rechaza: estados inválidos y extracción × implante', async () => {
    // 1) Estados que la condición no admite (spec §2).
    const extraccionCompletada = await recordFinding(
      handle.db,
      pacienteProcedimientos,
      hallazgo({ toothNumber: 13, condition: 'extraccion_indicada', state: 'completado' }),
      actor,
    ).catch((error: unknown) => error);
    expect(extraccionCompletada).toBeInstanceOf(ConflictError);
    expect((extraccionCompletada as ConflictError).extensions['state']).toBe('completado');

    expect(
      await recordFinding(
        handle.db,
        pacienteProcedimientos,
        hallazgo({
          toothNumber: 13,
          surface: 'occlusal',
          condition: 'caries',
          state: 'completado',
        }),
        actor,
      ).catch((error: unknown) => error),
    ).toBeInstanceOf(ConflictError);
    expect(
      await recordFinding(
        handle.db,
        pacienteProcedimientos,
        hallazgo({ toothNumber: 13, condition: 'ausente', state: 'pendiente' }),
        actor,
      ).catch((error: unknown) => error),
    ).toBeInstanceOf(ConflictError);

    // 2) La pareja imposible: extracción indicada + implante (spec §3).
    const extraccion = await recordFinding(
      handle.db,
      pacienteProcedimientos,
      hallazgo({ toothNumber: 13, condition: 'extraccion_indicada', state: 'pendiente' }),
      actor,
    );
    expect(extraccion.odontogram.findings['13']?.map((row) => row.condition)).toEqual([
      'extraccion_indicada',
    ]);

    const implante = await recordFinding(
      handle.db,
      pacienteProcedimientos,
      hallazgo({ toothNumber: 13, condition: 'implante', state: 'completado' }),
      actor,
    ).catch((error: unknown) => error);
    expect(implante).toBeInstanceOf(ConflictError);
    expect((implante as ConflictError).extensions['conflictingCondition']).toBe(
      'extraccion_indicada',
    );
  }, 40_000);

  /**
   * Los procedimientos del ciclo de vida (spec §5): no cambian un estado, **mutan** el
   * hallazgo de origen en el de destino, en una sola transacción.
   */
  it('los procedimientos mutan el hallazgo: extraer → extraída, obturar → restauración, rehabilitar → corona', async () => {
    // Extraer: la extracción indicada cumplida deja la pieza **ausente**.
    await recordFinding(
      handle.db,
      pacienteProcedimientos,
      hallazgo({ toothNumber: 33, condition: 'extraccion_indicada' }),
      actor,
    );
    const extraida = await completeProcedure(
      handle.db,
      pacienteProcedimientos,
      { toothNumber: 33, procedure: 'extraer', surface: null, notes: null, sessionId: null },
      actor,
    );
    expect(extraida.odontogram.findings['33']?.map((row) => [row.condition, row.state])).toEqual([
      ['ausente', 'completado'],
    ]);
    // El odontograma del paciente de procedimientos (distinto del de la boca por lotes).
    const odontogramProcedimientos = extraida.odontogram.id;
    // El origen no se borra: queda **resuelto** con su entrada en el histórico.
    const origen = (await filasDePieza(33, odontogramProcedimientos)).find(
      (row) => row.condition === 'extraccion_indicada',
    );
    expect(origen?.resolvedAt ?? null).not.toBeNull();
    expect(
      (await historial(odontogramProcedimientos)).some(
        (row) => row.event === 'resuelto' && row.toothNumber === 33,
      ),
      await historialResumen(odontogramProcedimientos),
    ).toBe(true);

    // Obturar: la caries tratada pasa a restauración completada en la misma cara.
    await recordFinding(
      handle.db,
      pacienteProcedimientos,
      hallazgo({ toothNumber: 34, surface: 'occlusal', condition: 'caries' }),
      actor,
    );
    const obturada = await completeProcedure(
      handle.db,
      pacienteProcedimientos,
      { toothNumber: 34, procedure: 'obturar', surface: null, notes: null, sessionId: null },
      actor,
    );
    expect(obturada.odontogram.findings['34']?.map((row) => [row.condition, row.state])).toEqual([
      ['restauracion', 'completado'],
    ]);

    // Rehabilitar: exige un implante vigente; resuelve la ausencia y pone la corona.
    await recordFinding(
      handle.db,
      pacienteProcedimientos,
      hallazgo({ toothNumber: 37, condition: 'ausente', state: 'completado' }),
      actor,
    );
    const sinImplante = await completeProcedure(
      handle.db,
      pacienteProcedimientos,
      { toothNumber: 37, procedure: 'rehabilitar', surface: null, notes: null, sessionId: null },
      actor,
    ).catch((error: unknown) => error);
    expect(sinImplante).toBeInstanceOf(ConflictError);
    expect((sinImplante as ConflictError).extensions['requires']).toBe('implante');

    await recordFinding(
      handle.db,
      pacienteProcedimientos,
      hallazgo({ toothNumber: 37, condition: 'implante', state: 'completado' }),
      actor,
    );
    const rehabilitada = await completeProcedure(
      handle.db,
      pacienteProcedimientos,
      { toothNumber: 37, procedure: 'rehabilitar', surface: null, notes: null, sessionId: null },
      actor,
    );
    expect(
      (rehabilitada.odontogram.findings['37'] ?? []).map((row) => row.condition).sort(),
    ).toEqual(['corona', 'implante']);
  }, 40_000);

  /**
   * La base es el último guardián: aunque alguien escriba a mano saltándose el
   * servicio, el CHECK de estado rechaza la fila imposible.
   */
  it('la base rechaza un estado imposible escrito a mano (CHECK)', async () => {
    await expect(
      handle.pool.query(
        `insert into tooth_findings (odontogram_id, patient_id, tooth_number, surface, condition, state)
         values ($1, $2, 12, null, 'extraccion_indicada', 'completado')`,
        [odontogramId, patientId],
      ),
    ).rejects.toThrow(/chk_tooth_findings_state_allowed/);
  }, 40_000);
});
