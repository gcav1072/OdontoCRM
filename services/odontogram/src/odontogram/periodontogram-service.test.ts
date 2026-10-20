import {
  PERIODONTAL_SCHEMA_VERSION,
  buildPeriodontalChart,
  emptyPeriodontalRiskFactors,
  periodontalMetrics,
  type PeriodontalChart,
  type PeriodontalTooth,
} from '@odontocrm/contracts';
import { describe, expect, it } from 'vitest';

import type { PeriodontogramExamRow } from '../db/schema.js';
import {
  changedFieldsBetween,
  describeExam,
  formatExamDate,
  samePeriodontalDocument,
  toExamDetail,
  toExamSummary,
  todayIsoDate,
  type PeriodontalDocument,
} from './periodontogram-service.js';

/**
 * Reglas **puras** del servicio del periodontograma: la fecha clínica, la línea de
 * auditoría, el diff del documento (qué piezas y campos cambiaron) y el mapeo de la
 * fila a los DTOs. Nada de esto necesita base de datos, y es justo lo que no debe
 * depender de la interfaz ni envejecer en silencio.
 */

const chart = (): PeriodontalChart => buildPeriodontalChart();

const pieza = (boca: PeriodontalChart, fdi: number): PeriodontalTooth => {
  const tooth = boca.find((candidata) => candidata.fdi === fdi);
  if (tooth === undefined) throw new Error(`La pieza ${String(fdi)} no está en la boca`);
  return tooth;
};

/** Escribe un sitio medido en la boca, en la cara e índice visual indicados. */
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

const documento = (overrides: Partial<PeriodontalDocument> = {}): PeriodontalDocument => ({
  examDate: '2026-10-18',
  chart: chart(),
  riskFactors: emptyPeriodontalRiskFactors(),
  diagnosis: null,
  notes: null,
  ...overrides,
});

/** Fila de la base con la forma exacta de `$inferSelect`, sin tocar PostgreSQL. */
const fila = (overrides: Partial<PeriodontogramExamRow> = {}): PeriodontogramExamRow => ({
  id: '0f5c0a2e-6a4b-4c1e-9a8e-2b1f7d3c4e5a',
  patientId: '7c9d1e2f-3a4b-4c5d-8e9f-0a1b2c3d4e5f',
  status: 'borrador',
  examDate: '2026-10-18',
  teethData: chart(),
  riskFactors: emptyPeriodontalRiskFactors(),
  diagnosis: null,
  metrics: periodontalMetrics(chart()),
  notes: null,
  revision: 0,
  schemaVersion: PERIODONTAL_SCHEMA_VERSION,
  sessionId: null,
  recordedBy: null,
  recordedByUsername: 'odontologo',
  finalizedBy: null,
  finalizedByUsername: null,
  finalizedAt: null,
  printCount: 0,
  lastPrintedAt: null,
  createdAt: new Date('2026-10-18T13:00:00.000Z'),
  updatedAt: new Date('2026-10-18T14:30:00.000Z'),
  ...overrides,
});

describe('fecha clínica del examen', () => {
  it('usa la fecha local del servidor, no la de UTC', () => {
    // Las 21:00 locales del 18 en un servidor en Caracas (UTC−4) son las 01:00 UTC
    // del 19: el documento tiene que seguir fechado el 18.
    expect(todayIsoDate(new Date(2026, 9, 18, 21, 0, 0))).toBe('2026-10-18');
    expect(todayIsoDate(new Date(2026, 0, 2, 8, 5, 0))).toBe('2026-01-02');
    expect(todayIsoDate(new Date(2026, 11, 31, 23, 59, 0))).toBe('2026-12-31');
  });

  it('presenta la fecha como se lee en español', () => {
    expect(formatExamDate('2026-10-18')).toBe('18/10/2026');
    // Si algún día llega algo que no es una fecha ISO, no se inventa una traducción.
    expect(formatExamDate('sin-fecha')).toBe('sin-fecha');
  });
});

describe('línea legible de auditoría', () => {
  it('un borrador sin sondar lo dice sin inventar porcentajes', () => {
    expect(describeExam(toExamSummary(fila()))).toBe(
      'Periodontograma del 18/10/2026 · borrador · sin sitios sondados',
    );
  });

  it('resume BOP y sitios sondados con coma decimal', () => {
    const boca = chart();
    medir(boca, 16, 'vestibular', 0, { pd: 3, gm: 0, bop: true });

    expect(
      describeExam(toExamSummary(fila({ teethData: boca, metrics: periodontalMetrics(boca) }))),
    ).toBe('Periodontograma del 18/10/2026 · borrador · BOP 100 % · 1 sitio sondado');
  });

  it('añade el retratamiento y la clasificación firmada', () => {
    const boca = chart();
    medir(boca, 16, 'vestibular', 0, { pd: 5, gm: 0, bop: true });

    expect(
      describeExam(
        toExamSummary(
          fila({
            status: 'finalizado',
            metrics: periodontalMetrics(boca),
            diagnosis: { stage: 3, grade: 'B', notes: null },
          }),
        ),
      ),
    ).toBe(
      'Periodontograma del 18/10/2026 · finalizado · BOP 100 % · 1 sitio sondado · 1 sitio de retratamiento · estadio 3 · grado B',
    );
  });
});

describe('diff del documento: piezas y campos tocados', () => {
  it('dos documentos con el mismo contenido no cambian nada', () => {
    // Se construyen por separado a propósito: Postgres devuelve el `jsonb` con las
    // claves en su propio orden y el autoguardado no puede creer que eso es un cambio.
    const anterior = documento();
    const siguiente = documento();

    expect(changedFieldsBetween(anterior, siguiente)).toEqual([]);
    expect(samePeriodontalDocument(anterior, siguiente)).toBe(true);
  });

  it('detecta las piezas cuyos sitios cambiaron, en orden canónico', () => {
    const anterior = documento();
    const siguiente = documento();
    medir(siguiente.chart, 26, 'lingual', 2, { pd: 4, gm: -1 });
    medir(siguiente.chart, 16, 'vestibular', 1, { pd: 3, gm: 0, bop: true });

    expect(changedFieldsBetween(anterior, siguiente)).toEqual(['pieza 16', 'pieza 26']);
    expect(samePeriodontalDocument(anterior, siguiente)).toBe(false);
  });

  it('detecta movilidad y estado ausente como cambio de la pieza', () => {
    const anterior = documento();
    const siguiente = documento();
    pieza(siguiente.chart, 46).mobility = 2;
    pieza(siguiente.chart, 36).missing = true;

    // Orden canónico: maxilar 18→28 y después mandíbula 48→38.
    expect(changedFieldsBetween(anterior, siguiente)).toEqual(['pieza 46', 'pieza 36']);
  });

  it('nombra los campos del documento después de las piezas', () => {
    const anterior = documento();
    const siguiente = documento({
      examDate: '2026-10-19',
      riskFactors: { smoking: 'mas10', diabetes: 'descontrolada', hba1c: 8.2 },
      diagnosis: { stage: 4, grade: 'C', notes: 'corregida' },
      notes: 'control de mantenimiento',
    });
    medir(siguiente.chart, 16, 'vestibular', 0, { pd: 6, gm: 0, bop: true });

    expect(changedFieldsBetween(anterior, siguiente)).toEqual([
      'pieza 16',
      'factores de riesgo',
      'diagnóstico',
      'notas',
      'fecha',
    ]);
  });

  it('no confunde una propiedad omitida con un cambio de valor nulo', () => {
    const anterior = documento({ diagnosis: { stage: 2, grade: 'A', notes: null } });
    const siguiente = documento({ diagnosis: { stage: 2, grade: 'A', notes: null } });

    expect(changedFieldsBetween(anterior, siguiente)).toEqual([]);
  });
});

describe('mapeo de fila a DTO con fechas ISO', () => {
  it('resume el examen con sus fechas y contadores', () => {
    const resumen = toExamSummary(
      fila({
        status: 'finalizado',
        revision: 3,
        notes: 'control de mantenimiento',
        recordedByUsername: 'odontologo',
        finalizedByUsername: 'odontologo',
        finalizedAt: new Date('2026-10-18T15:00:00.000Z'),
        printCount: 2,
        lastPrintedAt: new Date('2026-10-18T16:30:00.000Z'),
      }),
    );

    expect(resumen).toMatchObject({
      id: '0f5c0a2e-6a4b-4c1e-9a8e-2b1f7d3c4e5a',
      patientId: '7c9d1e2f-3a4b-4c5d-8e9f-0a1b2c3d4e5f',
      status: 'finalizado',
      examDate: '2026-10-18',
      revision: 3,
      notes: 'control de mantenimiento',
      recordedByUsername: 'odontologo',
      finalizedByUsername: 'odontologo',
      createdAt: '2026-10-18T13:00:00.000Z',
      updatedAt: '2026-10-18T14:30:00.000Z',
      finalizedAt: '2026-10-18T15:00:00.000Z',
      printCount: 2,
      lastPrintedAt: '2026-10-18T16:30:00.000Z',
    });
  });

  it('un borrador abierto no tiene fechas de cierre ni de impresión', () => {
    const resumen = toExamSummary(fila());

    expect(resumen.finalizedAt).toBeNull();
    expect(resumen.lastPrintedAt).toBeNull();
    expect(resumen.printCount).toBe(0);
    expect(resumen.revision).toBe(0);
    expect(resumen.status).toBe('borrador');
  });

  it('el detalle añade la boca, los factores, la versión de esquema y la sesión', () => {
    const boca = chart();
    medir(boca, 16, 'vestibular', 0, { pd: 5, gm: -2, bop: true });
    const detalle = toExamDetail(
      fila({
        teethData: boca,
        metrics: periodontalMetrics(boca),
        riskFactors: { smoking: 'menos10', diabetes: 'no', hba1c: null },
        schemaVersion: PERIODONTAL_SCHEMA_VERSION,
        sessionId: '3b2a1c0d-9e8f-4a7b-8c6d-5e4f3a2b1c0d',
      }),
    );

    expect(detalle.chart).toEqual(boca);
    expect(detalle.chart).toHaveLength(32);
    expect(detalle.riskFactors).toEqual({ smoking: 'menos10', diabetes: 'no', hba1c: null });
    expect(detalle.schemaVersion).toBe(PERIODONTAL_SCHEMA_VERSION);
    expect(detalle.sessionId).toBe('3b2a1c0d-9e8f-4a7b-8c6d-5e4f3a2b1c0d');
    // Los KPIs del detalle son los que se guardaron con el documento.
    expect(detalle.metrics).toEqual(periodontalMetrics(boca));
    expect(detalle.metrics.sitesProbed).toBe(1);
  });
});
