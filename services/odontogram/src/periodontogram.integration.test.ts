import {
  PERIODONTAL_SCHEMA_VERSION,
  buildPeriodontalChart,
  createPeriodontalExamSchema,
  finalizePeriodontalExamSchema,
  periodontalExamListQuerySchema,
  periodontalMetrics,
  savePeriodontalExamSchema,
  type PeriodontalChart,
  type PeriodontalPatientSnapshot,
} from '@odontocrm/contracts';
import { outboxEvents } from '@odontocrm/db';
import { EVENT_TOPICS } from '@odontocrm/events';
import { ConflictError, NotFoundError } from '@odontocrm/kernel';
import { and, eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { loadOdontogramConfig } from './config.js';
import { createOdontogramDatabase } from './db/client.js';
import { odontograms, periodontogramExams } from './db/schema.js';
import { recordFinding } from './odontogram/chart-service.js';
import {
  compareExams,
  createExam,
  discardDraft,
  finalizeExam,
  getExam,
  getInternalSummary,
  getLatestExam,
  listExams,
  registerPrint,
  saveExam,
} from './odontogram/periodontogram-service.js';
import type { ActorContext } from './shared/context.js';

/**
 * Pruebas de integración del periodontograma (v1.1) contra PostgreSQL real.
 *
 * Se comprueba lo que solo se ve con la base delante: que el examen se congela desde
 * el odontograma en la **misma base** (sin llamadas entre servicios), que el guardado
 * optimista devuelve la revisión vigente, que finalizar es inmutable e idempotente,
 * que la comparación se apoya en documentos congelados, que la impresión cuenta y
 * que los CHECK y el índice parcial de la tabla son el último guardián.
 *
 * Solo necesita la base del odontograma (y su outbox): no importa `identity` —la
 * entrega de eventos a la cola la cubren las suites del consumidor—. Sin
 * `TEST_ODONTOGRAM_DATABASE_URL` la suite se salta, pero compila igual.
 */
const odontogramUrl = process.env['TEST_ODONTOGRAM_DATABASE_URL'];
const ready = odontogramUrl !== undefined;
const describeWithDatabase = ready ? describe : describe.skip;

const suffix = String(Date.now()).slice(-7);
const MARKER = `prueba-periodonto-${suffix}`;

const actor: ActorContext = {
  actorId: null,
  actorUsername: MARKER,
  ip: '127.0.0.1',
  userAgent: 'vitest',
  requestId: `req-${suffix}`,
};

const patientId = globalThis.crypto.randomUUID();
const pacienteSinBoca = globalThis.crypto.randomUUID();
const pacientes = [patientId, pacienteSinBoca];

/** Identificadores de los agregados cuyos eventos hay que limpiar del outbox. */
const agregados = new Set<string>();

const pieza = (boca: PeriodontalChart, fdi: number): PeriodontalChart[number] => {
  const tooth = boca.find((candidata) => candidata.fdi === fdi);
  if (tooth === undefined) throw new Error(`La pieza ${String(fdi)} no está en la boca`);
  return tooth;
};

const medir = (
  boca: PeriodontalChart,
  fdi: number,
  side: 'vestibular' | 'lingual',
  index: 0 | 1 | 2,
  site: { pd: number; gm: number; bop?: boolean },
): void => {
  pieza(boca, fdi)[side][index] = {
    pd: site.pd,
    gm: site.gm,
    bop: site.bop ?? false,
    plaque: false,
    suppuration: false,
  };
};

/** Sobre del evento tal como se guarda en el outbox. */
interface EnvelopeResumen {
  eventType?: string;
  payload?: Record<string, unknown>;
}

describeWithDatabase('periodontograma: documento JSONB, revisión optimista y cierre', () => {
  let handle: Awaited<ReturnType<typeof createOdontogramDatabase>>;
  /** Examen creado en la primera prueba y clon finalizado en la de comparación. */
  let examId = '';
  let clonFinalizadoId = '';

  /** Crea un examen del paciente principal y registra su agregado para la limpieza. */
  const crear = async (
    input: Record<string, unknown> = {},
  ): Promise<Awaited<ReturnType<typeof createExam>>> => {
    const parsed = createPeriodontalExamSchema.parse({ examDate: '2026-10-18', ...input });
    const resultado = await createExam(handle.db, patientId, parsed, actor);
    agregados.add(resultado.exam.id);
    return resultado;
  };

  const guardar = async (
    id: string,
    input: Record<string, unknown> & { revision: number; chart: PeriodontalChart },
  ): Promise<Awaited<ReturnType<typeof saveExam>>> => {
    const parsed = savePeriodontalExamSchema.parse({ examDate: '2026-10-18', ...input });
    return saveExam(handle.db, patientId, id, parsed, actor);
  };

  const finalizar = async (
    id: string,
    revision: number,
  ): Promise<Awaited<ReturnType<typeof finalizeExam>>> =>
    finalizeExam(
      handle.db,
      patientId,
      id,
      finalizePeriodontalExamSchema.parse({ revision }),
      actor,
    );

  /** Eventos del outbox publicados por un agregado. */
  const eventosDe = async (aggregateId: string): Promise<EnvelopeResumen[]> => {
    const rows = await handle.db
      .select({ envelope: outboxEvents.envelope })
      .from(outboxEvents)
      .where(eq(outboxEvents.aggregateId, aggregateId));
    return rows.map((row) => row.envelope as EnvelopeResumen);
  };

  const accionesDe = async (aggregateId: string): Promise<unknown[]> =>
    (await eventosDe(aggregateId)).map((evento) => evento.payload?.['action']);

  const contarExamenes = async (): Promise<number> => {
    const rows = await handle.db
      .select({ id: periodontogramExams.id })
      .from(periodontogramExams)
      .where(eq(periodontogramExams.patientId, patientId));
    return rows.length;
  };

  const listar = async () =>
    listExams(handle.db, patientId, periodontalExamListQuerySchema.parse({}));

  beforeAll(async () => {
    if (!ready) throw new Error('falta TEST_ODONTOGRAM_DATABASE_URL');

    handle = createOdontogramDatabase(
      loadOdontogramConfig({ DATABASE_URL: odontogramUrl, LOG_LEVEL: 'silent' }),
    );

    // El odontograma del paciente ya sabe que la 36 falta y que la 46 es un implante:
    // el examen nuevo tiene que nacer con ese estado congelado.
    const diagnosticado = await recordFinding(
      handle.db,
      patientId,
      {
        toothNumber: 36,
        surface: null,
        condition: 'ausente',
        state: 'completado',
        notes: null,
        sessionId: null,
      },
      actor,
    );
    agregados.add(diagnosticado.odontogram.id);
    await recordFinding(
      handle.db,
      patientId,
      {
        toothNumber: 46,
        surface: null,
        condition: 'implante',
        state: 'completado',
        notes: null,
        sessionId: null,
      },
      actor,
    );
  }, 30_000);

  afterAll(async () => {
    if (!ready) return;

    // Solo los eventos de **esta** suite: las demás corren en paralelo contra la misma
    // base y borrar todo el outbox del productor les tumbaría la auditoría.
    const ids = [...agregados];
    if (ids.length > 0) {
      await handle.db
        .delete(outboxEvents)
        .where(
          and(eq(outboxEvents.producer, 'odontogram'), inArray(outboxEvents.aggregateId, ids)),
        );
    }
    await handle.db
      .delete(periodontogramExams)
      .where(inArray(periodontogramExams.patientId, pacientes));
    // Las tablas del odontograma caen en cascada con la fila del odontograma.
    await handle.db.delete(odontograms).where(inArray(odontograms.patientId, pacientes));
    await handle.close();
  });

  it('abre el examen desde el odontograma, congela la boca y deja el evento de alta', async () => {
    const resultado = await crear({ source: 'odontograma' });
    examId = resultado.exam.id;

    expect(resultado.unchanged).toBe(false);
    expect(resultado.exam.status).toBe('borrador');
    expect(resultado.exam.revision).toBe(0);
    expect(resultado.exam.examDate).toBe('2026-10-18');
    expect(resultado.exam.schemaVersion).toBe(PERIODONTAL_SCHEMA_VERSION);
    expect(resultado.exam.recordedByUsername).toBe(MARKER);
    expect(resultado.exam.riskFactors).toEqual({ smoking: 'no', diabetes: 'no', hba1c: null });
    expect(resultado.exam.diagnosis).toBeNull();

    // La boca nace de las 32 piezas y del estado del odontograma, sin mediciones.
    expect(resultado.exam.chart).toHaveLength(32);
    expect(pieza(resultado.exam.chart, 36).missing).toBe(true);
    expect(pieza(resultado.exam.chart, 46).implant).toBe(true);
    expect(pieza(resultado.exam.chart, 16).missing).toBe(false);
    expect(pieza(resultado.exam.chart, 16).vestibular[0]?.pd).toBeNull();
    expect(resultado.exam.metrics.sitesProbed).toBe(0);

    const eventos = await eventosDe(examId);
    expect(eventos).toHaveLength(1);
    expect(eventos[0]?.eventType).toBe(EVENT_TOPICS.periodontalExamSaved);
    expect(eventos[0]?.payload).toMatchObject({
      entityType: 'periodontogram',
      action: 'periodontogram_created',
      patientId,
      examId,
      status: 'borrador',
      examDate: '2026-10-18',
      source: 'odontograma',
    });

    // Segundo borrador del mismo paciente: 409 con el que ya está abierto.
    const choque = await crear({ source: 'blanco' }).catch((error: unknown) => error);
    expect(choque).toBeInstanceOf(ConflictError);
    expect((choque as ConflictError).extensions['existingExamId']).toBe(examId);
  }, 40_000);

  it('guarda con revisión optimista: 409 si la revisión no es la vigente y unchanged si no cambia nada', async () => {
    const abierto = await getExam(handle.db, patientId, examId);
    const boca = structuredClone(abierto.chart);
    medir(boca, 16, 'vestibular', 0, { pd: 5, gm: 0, bop: true });

    const documento = {
      revision: 0,
      chart: boca,
      riskFactors: { smoking: 'menos10', diabetes: 'no', hba1c: null },
      diagnosis: { stage: 2, grade: 'B', notes: null },
      notes: 'control de mantenimiento',
    } as const;

    const guardado = await guardar(examId, documento);
    expect(guardado.unchanged).toBe(false);
    expect(guardado.exam.revision).toBe(1);
    expect(guardado.exam.metrics.sitesProbed).toBe(1);
    expect(guardado.exam.metrics.bopPercent).toBe(100);
    expect(guardado.exam.metrics.retreatmentSites).toBe(1);
    expect(guardado.exam.riskFactors.smoking).toBe('menos10');
    expect(guardado.exam.diagnosis).toEqual({ stage: 2, grade: 'B', notes: null });

    // El evento de actualización lleva el diff legible (piezas y campos), no la boca.
    const actualizacion = (await eventosDe(examId)).find(
      (evento) => evento.payload?.['action'] === 'periodontogram_updated',
    );
    expect(actualizacion?.eventType).toBe(EVENT_TOPICS.periodontalExamSaved);
    expect(actualizacion?.payload?.['changedFields']).toEqual([
      'pieza 16',
      'factores de riesgo',
      'diagnóstico',
      'notas',
    ]);
    expect(actualizacion?.payload?.['metrics']).toMatchObject({ bopPercent: 100, sitesProbed: 1 });

    // Guardar con la revisión vieja no pisa las mediciones: 409 con la vigente.
    const conflicto = await guardar(examId, { ...documento, revision: 0 }).catch(
      (error: unknown) => error,
    );
    expect(conflicto).toBeInstanceOf(ConflictError);
    expect((conflicto as ConflictError).extensions['currentRevision']).toBe(1);

    // Repetir el mismo documento con la revisión vigente no escribe ni audita.
    const eventosAntes = (await eventosDe(examId)).length;
    const repetido = await guardar(examId, { ...documento, revision: 1 });
    expect(repetido.unchanged).toBe(true);
    expect(repetido.exam.revision).toBe(1);
    expect((await eventosDe(examId)).length).toBe(eventosAntes);

    // Un examen de otro paciente no se puede leer por la ruta equivocada.
    await expect(getExam(handle.db, pacienteSinBoca, examId)).rejects.toBeInstanceOf(NotFoundError);
  }, 40_000);

  it('finaliza inmutable e idempotente: el cierre no se edita ni se descarta', async () => {
    const cierre = await finalizar(examId, 1);
    expect(cierre.alreadyFinalized).toBe(false);
    expect(cierre.exam.status).toBe('finalizado');
    expect(cierre.exam.finalizedAt).not.toBeNull();
    expect(cierre.exam.finalizedByUsername).toBe(MARKER);
    expect(cierre.exam.revision).toBe(2);

    // Reintentar el cierre es idempotente: mismo documento, sin evento nuevo.
    const eventosAntes = (await eventosDe(examId)).length;
    const otraVez = await finalizar(examId, 2);
    expect(otraVez.alreadyFinalized).toBe(true);
    expect(otraVez.exam.revision).toBe(2);
    expect((await eventosDe(examId)).length).toBe(eventosAntes);
    expect(await accionesDe(examId)).toContain('periodontogram_finalized');

    // A partir de aquí no se edita ni se descarta.
    const boca = structuredClone(cierre.exam.chart);
    await expect(
      guardar(examId, {
        revision: 2,
        chart: boca,
        riskFactors: cierre.exam.riskFactors,
        diagnosis: cierre.exam.diagnosis,
        notes: cierre.exam.notes,
      }),
    ).rejects.toBeInstanceOf(ConflictError);
    await expect(discardDraft(handle.db, patientId, examId, actor)).rejects.toBeInstanceOf(
      ConflictError,
    );
  }, 40_000);

  it('compara contra el examen anterior con las bocas congeladas', async () => {
    const anterior = await getExam(handle.db, patientId, examId);
    // Un control de mantenimiento: se clona la boca del anterior y se guarda mejorada.
    const clon = await crear({ source: 'anterior', previousExamId: examId });
    expect(clon.exam.chart).toEqual(anterior.chart);
    expect(pieza(clon.exam.chart, 36).missing).toBe(true);
    expect(pieza(clon.exam.chart, 46).implant).toBe(true);

    const boca = structuredClone(clon.exam.chart);
    medir(boca, 16, 'vestibular', 0, { pd: 2, gm: 0 });
    const guardado = await guardar(clon.exam.id, { revision: 0, chart: boca });
    const cierre = await finalizar(clon.exam.id, guardado.exam.revision);
    clonFinalizadoId = cierre.exam.id;

    const comparacion = await compareExams(handle.db, patientId, cierre.exam.id, examId);
    expect(comparacion.previous.id).toBe(examId);
    expect(comparacion.current.id).toBe(cierre.exam.id);
    expect(comparacion.comparison.summary.sitesCompared).toBe(1);
    expect(comparacion.comparison.summary.improved).toBe(1);
    expect(comparacion.comparison.summary.worsened).toBe(0);
    // PS 5 → 2 en el mismo sitio: -3 mm de profundidad y -100 % de BOP.
    expect(comparacion.comparison.summary.meanPdDelta).toBe(-3);
    expect(comparacion.comparison.summary.bopPercentDelta).toBe(-100);
    expect(comparacion.comparison.summary.teethLost).toBe(0);

    // El documento anterior sigue congelado: comparar no reescribe la historia.
    const anteriorDespues = await getExam(handle.db, patientId, examId);
    expect(pieza(anteriorDespues.chart, 16).vestibular[0]?.pd).toBe(5);
  }, 40_000);

  it('la lectura del último examen trae la ficha del paciente y el finalizado anterior', async () => {
    const listado = await listar();
    expect(listado.items).toHaveLength(2);
    expect(listado.items.every((item) => item.status === 'finalizado')).toBe(true);

    const paciente: PeriodontalPatientSnapshot = {
      id: patientId,
      fullName: 'Paciente de prueba',
      document: 'V-12345678',
      birthDate: '1980-01-01',
      age: 45,
      sex: 'f',
      phone: null,
      address: null,
      occupation: null,
    };
    const ultimo = await getLatestExam(handle.db, patientId, paciente);
    expect(ultimo.exists).toBe(true);
    if (ultimo.exists) {
      expect(ultimo.patient).toEqual(paciente);
      expect(ultimo.exam.id).toBe(clonFinalizadoId);
      expect(ultimo.previousFinalized?.id).toBe(examId);
    }

    // Con `null` explícito: la ficha puede no venir si el servicio de pacientes falla.
    const sinFicha = await getLatestExam(handle.db, patientId, null);
    expect(sinFicha.exists).toBe(true);
    if (sinFicha.exists) expect(sinFicha.patient).toBeNull();

    expect(await getLatestExam(handle.db, pacienteSinBoca, null)).toEqual({
      exists: false,
      patientId: pacienteSinBoca,
      patient: null,
    });
  }, 40_000);

  it('el resumen interno usa el último finalizado y no el borrador', async () => {
    const resumen = await getInternalSummary(handle.db, patientId);
    expect(resumen).toMatchObject({
      patientId,
      hasExam: true,
      examId: clonFinalizadoId,
      examDate: '2026-10-18',
      status: 'finalizado',
    });
    expect(resumen.metrics?.sitesProbed).toBe(1);
    expect(resumen.diagnosis).toBeNull();

    expect(await getInternalSummary(handle.db, pacienteSinBoca)).toEqual({
      patientId: pacienteSinBoca,
      hasExam: false,
      examId: null,
      examDate: null,
      status: null,
      metrics: null,
      diagnosis: null,
    });
  }, 40_000);

  it('la impresión deja constancia con su actor y su contador', async () => {
    const primera = await registerPrint(handle.db, patientId, clonFinalizadoId, actor);
    expect(primera.printCount).toBe(1);
    expect(primera.examId).toBe(clonFinalizadoId);
    expect(Number.isNaN(Date.parse(primera.lastPrintedAt))).toBe(false);

    const segunda = await registerPrint(handle.db, patientId, clonFinalizadoId, actor);
    expect(segunda.printCount).toBe(2);

    expect(await accionesDe(clonFinalizadoId)).toContain('periodontogram_printed');
    expect((await getExam(handle.db, patientId, clonFinalizadoId)).printCount).toBe(2);
  }, 40_000);

  it('descarta el borrador: la fila desaparece y el hecho queda auditado', async () => {
    const filasAntes = await contarExamenes();
    const borrador = await crear({ source: 'blanco' });

    const descarte = await discardDraft(handle.db, patientId, borrador.exam.id, actor);
    expect(descarte.examId).toBe(borrador.exam.id);
    expect(await contarExamenes()).toBe(filasAntes);

    await expect(getExam(handle.db, patientId, borrador.exam.id)).rejects.toBeInstanceOf(
      NotFoundError,
    );
    // El alta y el descarte del mismo agregado: el borrador nació y se tiró.
    expect(await accionesDe(borrador.exam.id)).toEqual([
      'periodontogram_created',
      'periodontogram_discarded',
    ]);

    // Descartar dos veces la misma fila ya no existe: 404, no un borrado silencioso.
    await expect(
      discardDraft(handle.db, patientId, borrador.exam.id, actor),
    ).rejects.toBeInstanceOf(NotFoundError);
  }, 40_000);

  it('la base es el último guardián: CHECK de cierre, 32 piezas e índice del borrador', async () => {
    const boca = JSON.stringify(buildPeriodontalChart());
    const riesgo = JSON.stringify({ smoking: 'no', diabetes: 'no', hba1c: null });
    const metricas = JSON.stringify(periodontalMetrics(buildPeriodontalChart()));

    // `finalizado` exige `finalized_at`: el servicio no puede dejar un cierre a medias
    // y la base tampoco.
    await expect(
      handle.pool.query(
        `insert into periodontogram_exams
           (patient_id, status, exam_date, teeth_data, risk_factors, metrics)
         values ($1, 'finalizado', '2026-10-18', $2::jsonb, $3::jsonb, $4::jsonb)`,
        [pacienteSinBoca, boca, riesgo, metricas],
      ),
    ).rejects.toThrow(/chk_periodontogram_exams_finalized/);

    // Una boca incompleta no entra aunque venga de fuera del contrato.
    await expect(
      handle.pool.query(
        `insert into periodontogram_exams
           (patient_id, status, exam_date, teeth_data, risk_factors, metrics)
         values ($1, 'borrador', '2026-10-18', $2::jsonb, $3::jsonb, $4::jsonb)`,
        [pacienteSinBoca, JSON.stringify(buildPeriodontalChart().slice(0, 31)), riesgo, metricas],
      ),
    ).rejects.toThrow(/chk_periodontogram_exams_teeth_count/);

    // Un solo borrador abierto por paciente: el índice parcial lo garantiza.
    await handle.pool.query(
      `insert into periodontogram_exams
         (patient_id, status, exam_date, teeth_data, risk_factors, metrics)
       values ($1, 'borrador', '2026-10-18', $2::jsonb, $3::jsonb, $4::jsonb)`,
      [pacienteSinBoca, boca, riesgo, metricas],
    );
    await expect(
      handle.pool.query(
        `insert into periodontogram_exams
           (patient_id, status, exam_date, teeth_data, risk_factors, metrics)
         values ($1, 'borrador', '2026-10-19', $2::jsonb, $3::jsonb, $4::jsonb)`,
        [pacienteSinBoca, boca, riesgo, metricas],
      ),
    ).rejects.toThrow(/uq_periodontogram_exam_draft/);
  }, 40_000);
});
