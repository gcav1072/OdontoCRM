import {
  analyzePeriodontalChart,
  buildPeriodontalChart,
  comparePeriodontalCharts,
  emptyPeriodontalRiskFactors,
  type PeriodontalExamDetail,
  type PeriodontalExamSummary,
  type PeriodontalPatientSnapshot,
} from '@odontocrm/contracts';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { PeriodontogramDocument } from './PeriodontogramDocument';

/**
 * Pruebas del **papel** del periodontograma: paginación y cifras.
 *
 * Existen por el PDF real de la clínica: cuatro hojas para cuatro dientes sondeados,
 * la mandíbula con su título huérfano al pie de la página 1, el diente 22 partido
 * entre la 2 y la 3 (Vestibular en una hoja y Palatino en la siguiente) y los
 * promedios impresos como `5.8 mm`. El documento se renderiza a HTML con
 * `renderToStaticMarkup` y se leen las marcas de paginación y los textos.
 */

const chart = buildPeriodontalChart();
for (const fdi of [16, 46]) {
  const tooth = chart.find((item) => item.fdi === fdi);
  if (tooth === undefined) continue;
  tooth.vestibular[0] = { ...tooth.vestibular[0], pd: 5, gm: 0, bop: true };
  tooth.vestibular[1] = { ...tooth.vestibular[1], pd: 4, gm: 0 };
  tooth.lingual[0] = { ...tooth.lingual[0], pd: 3, gm: -1 };
  tooth.mobility = 1;
}
const conFurca = chart.find((item) => item.fdi === 16);
if (conFurca !== undefined) conFurca.furcation = { vestibular: 2, mesiopalatina: 1 };

const riskFactors = { ...emptyPeriodontalRiskFactors(), hba1c: 6.8 };
const analisis = analyzePeriodontalChart(chart, riskFactors);

const detail = {
  id: '11111111-1111-4111-8111-111111111111',
  patientId: '22222222-2222-4222-8222-222222222222',
  status: 'finalizado',
  examDate: '2026-10-19',
  revision: 1,
  metrics: analisis.metrics,
  diagnosis: { stage: 3, grade: 'B', notes: null },
  createdAt: '2026-10-19T14:00:00.000Z',
  updatedAt: '2026-10-19T14:30:00.000Z',
  finalizedAt: '2026-10-19T14:30:00.000Z',
  recordedByUsername: 'odonto',
  finalizedByUsername: 'odonto',
  printCount: 0,
  lastPrintedAt: null,
  notes: null,
  chart,
  riskFactors,
  schemaVersion: 1,
  sessionId: null,
} as unknown as PeriodontalExamDetail;

const patient = {
  id: detail.patientId,
  fullName: 'María Fernanda Pérez',
  document: 'V-12345678',
  birthDate: '1990-05-04',
  age: 36,
  sex: 'F',
  phone: null,
  address: null,
  occupation: null,
} as PeriodontalPatientSnapshot;

const html = renderToStaticMarkup(createElement(PeriodontogramDocument, { detail, patient }));

const contar = (patron: RegExp): number => [...html.matchAll(patron)].length;

describe('paginación del informe', () => {
  it('ninguna arcada se parte: cada figura se protege con break-inside', () => {
    // Dos arcadas, dos figuras protegidas (el título huérfano de la mandíbula).
    expect(contar(/<figure class="m-0 [^"]*break-inside-avoid/g)).toBe(2);
  });

  it('las dos caras de una pieza van en el mismo tbody, que no se parte', () => {
    // Solo la 16 (maxilar) y la 46 (mandíbula) tienen datos: un tbody por pieza.
    const tbodies = [...html.matchAll(/<tbody[^>]*>/g)].map((match) => match[0]);
    expect(tbodies).toHaveLength(2);
    for (const tbody of tbodies) expect(tbody).toContain('break-inside-avoid');
    // Cada pieza evaluated ocupa una sola celda de número con rowSpan=2.
    expect(contar(/scope="rowgroup"/g)).toBe(2);
  });

  it('no imprime las piezas sin sondar y dice cuántas omite', () => {
    // 16 piezas por arcada menos la sondeada: 15 en cada una.
    expect(contar(/No se listan 15 piezas/g)).toBe(2);
    expect(contar(/scope="rowgroup"/g)).toBe(2);
  });

  it('las dos arcadas se imprimen en dos columnas', () => {
    expect(html).toContain('print:grid-cols-2');
  });
});

describe('cifras del informe', () => {
  it('los promedios y la HbA1c salen con coma decimal', () => {
    expect(html).toContain(`${String(analisis.metrics.meanPd).replace('.', ',')} mm`);
    expect(html).toContain('HbA1c 6,8 %');
    expect(html).not.toMatch(/\d\.\d mm/);
  });

  it('las furcas se listan con su sigla anatómica y su grado', () => {
    expect(html).toContain('V: II');
    expect(html).toContain('MP: I');
    expect(html).toContain('Furca por entrada: V vestibular');
  });
});

/**
 * Evolución impresa: la comparación se movió **antes** del cierre legal y dejó de
 * forzar página nueva, para que el sello de auditoría sea lo último y el PDF no
 * gaste una hoja en una comparación corta.
 */
describe('evolución respecto al examen anterior', () => {
  const anteriorChart = buildPeriodontalChart();
  const diente16 = anteriorChart.find((tooth) => tooth.fdi === 16);
  if (diente16 !== undefined) {
    diente16.vestibular[0] = { ...diente16.vestibular[0], pd: 3, gm: 0 };
  }
  const comparison = comparePeriodontalCharts({
    previousExamId: 'anterior',
    previous: anteriorChart,
    currentExamId: detail.id,
    current: chart,
  });
  const previousExam = {
    id: 'anterior',
    patientId: detail.patientId,
    status: 'finalizado',
    examDate: '2026-10-19',
    revision: 1,
    metrics: analisis.metrics,
    diagnosis: null,
    // 11:46 UTC = 7:46 a. m. en America/Caracas.
    createdAt: '2026-10-19T11:46:00.000Z',
    updatedAt: '2026-10-19T11:46:00.000Z',
    finalizedAt: '2026-10-19T11:46:00.000Z',
    recordedByUsername: 'odonto',
    finalizedByUsername: 'odonto',
    printCount: 0,
    lastPrintedAt: null,
    notes: null,
  } satisfies PeriodontalExamSummary;

  const conComparacion = renderToStaticMarkup(
    createElement(PeriodontogramDocument, { detail, patient, comparison, previousExam }),
  );

  it('se imprime antes de la clasificación firmada y del pie de auditoría', () => {
    const evolucion = conComparacion.indexOf('Evolución respecto al examen anterior');
    expect(evolucion).toBeGreaterThan(-1);
    expect(evolucion).toBeLessThan(conComparacion.indexOf('Clasificación firmada'));
    expect(evolucion).toBeLessThan(conComparacion.indexOf('Documento generado por OdontoCRM'));
  });

  it('no fuerza un salto de página: solo protege sus bloques', () => {
    expect(conComparacion).not.toContain('break-before-page');
    expect(conComparacion).toContain('<div class="break-inside-avoid">');
  });

  it('el subtítulo distingue los dos exámenes por estado y hora', () => {
    expect(conComparacion).toContain(
      'Comparación entre el examen del 19/10/2026 (Finalizado · 7:46 a. m.) y el actual del 19/10/2026 (Finalizado · 10:00 a. m.).',
    );
  });
});

describe('siluetas en el papel', () => {
  it('el informe sale con las piezas modeladas encendidas por defecto', () => {
    expect(html).toContain('data-silhouette="molar-upper"');
    expect(html).toContain('data-silhouette="molar-upper-palatal"');
    expect(html).toContain('data-silhouette="molar-lower"');
  });

  it('el switch de impresión las apaga sin tocar el resto del documento', () => {
    const sinSiluetas = renderToStaticMarkup(
      createElement(PeriodontogramDocument, { detail, patient, showSilhouettes: false }),
    );
    expect(sinSiluetas).not.toContain('data-silhouette');
    // El gráfico, la rejilla y las cifras siguen ahí.
    expect(sinSiluetas).toContain('Gráfico de las arcadas');
    expect(sinSiluetas).toContain('PS: profundidad de sondaje');
  });
});
