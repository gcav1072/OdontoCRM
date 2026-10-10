import { reportFiltersSchema } from '@odontocrm/contracts';
import { describe, expect, it } from 'vitest';

import {
  componerSaludBucal,
  TOP_PACIENTES,
  type FilaPacienteBucal,
  type FilaSaludBucal,
} from './oral-health.js';
import type { ReportContext } from './shared.js';

const contexto = (filtros: Record<string, unknown> = {}): ReportContext => ({
  filters: reportFiltersSchema.parse(filtros),
  range: { from: '2026-10-01', to: '2026-10-31' },
  generatedAt: '2026-10-31T12:00:00.000Z',
});

const hallazgo = (valores: Partial<FilaSaludBucal> & { toothNumber: number }): FilaSaludBucal => ({
  day: '2026-10-05',
  condition: 'caries',
  findings: 1,
  patients: 1,
  ...valores,
});

const paciente = (
  etiqueta: string,
  valores: Partial<Omit<FilaPacienteBucal, 'etiqueta' | 'patientId'>> = {},
): FilaPacienteBucal => ({
  patientId: globalThis.crypto.randomUUID(),
  etiqueta,
  caries: 0,
  restauracion: 0,
  ausente: 0,
  extraida: 0,
  total: 0,
  ...valores,
});

describe('salud bucal desde el odontograma', () => {
  it('ordena las piezas numéricamente (el FDI como texto dejaría la arcada al revés)', () => {
    const documento = componerSaludBucal(
      [
        hallazgo({ toothNumber: 46, condition: 'ausente' }),
        hallazgo({ toothNumber: 16, condition: 'caries' }),
        hallazgo({ toothNumber: 26, condition: 'restauracion' }),
      ],
      [],
      contexto(),
    );

    expect(documento.table.rows.map((fila) => fila['pieza'])).toEqual([16, 26, 46]);
    expect(documento.table.rows[0]).toMatchObject({ caries: 1, restauraciones: 0, ausentes: 0 });
    expect(documento.table.rows[2]).toMatchObject({ caries: 0, restauraciones: 0, ausentes: 1 });
  });

  it('la serie por pieza lleva las cuatro condiciones del contrato', () => {
    const documento = componerSaludBucal(
      [
        hallazgo({ toothNumber: 16, condition: 'caries', findings: 2 }),
        hallazgo({ toothNumber: 16, condition: 'restauracion' }),
      ],
      [],
      contexto(),
    );
    const puntos = documento.series.find((serie) => serie.id === 'piezas')?.points ?? [];
    expect(puntos.map((punto) => [punto.x, punto.group, punto.y])).toEqual([
      ['16', 'Caries', 2],
      ['16', 'Restauraciones', 1],
      ['16', 'Piezas ausentes', 0],
      ['16', 'Piezas extraídas', 0],
    ]);
    expect(documento.series.find((serie) => serie.id === 'piezas')?.kind).toBe('stacked-bar');
  });

  it('la tabla por pieza se queda con las tres condiciones del reporte', () => {
    const documento = componerSaludBucal(
      [
        hallazgo({ toothNumber: 16, condition: 'caries' }),
        hallazgo({ toothNumber: 16, condition: 'corona' }),
        hallazgo({ toothNumber: 16, condition: 'endodoncia' }),
      ],
      [],
      contexto(),
    );
    expect(documento.table.rows).toHaveLength(1);
    expect(documento.table.rows[0]).toMatchObject({ caries: 1, restauraciones: 0, ausentes: 0 });
  });

  it('recorta el top de pacientes y lo dice en las notas', () => {
    const pacientes = Array.from({ length: TOP_PACIENTES + 3 }, (_, indice) =>
      paciente(`Paciente ${String(indice)}`, { caries: 1, total: 1 }),
    );
    const documento = componerSaludBucal(
      [hallazgo({ toothNumber: 16, condition: 'caries' })],
      pacientes,
      contexto(),
    );

    expect(documento.notes.join(' ')).toContain(
      `${String(TOP_PACIENTES)} de ${String(TOP_PACIENTES + 3)}`,
    );
    const serie = documento.series.find((serie) => serie.id === 'pacientes');
    expect(serie?.points).toHaveLength(TOP_PACIENTES * 4);
    expect(documento.kpis.find((kpi) => kpi.label === 'Pacientes con hallazgos')?.value).toBe(
      TOP_PACIENTES + 3,
    );
  });

  it('sin hallazgos avisa y deja la tabla vacía', () => {
    const documento = componerSaludBucal([], [], contexto());
    expect(documento.table.rows).toHaveLength(0);
    expect(documento.notes.join(' ')).toContain('Sin datos');
    expect(documento.kpis.find((kpi) => kpi.label === 'Piezas afectadas')?.value).toBe(0);
  });
});
