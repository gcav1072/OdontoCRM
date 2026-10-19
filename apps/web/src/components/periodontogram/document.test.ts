import {
  analyzePeriodontalChart,
  buildPeriodontalChart,
  emptyPeriodontalRiskFactors,
  type PeriodontalExamDetail,
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
