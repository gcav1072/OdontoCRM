import { reportFiltersSchema } from '@odontocrm/contracts';
import { describe, expect, it } from 'vitest';

import {
  componerRecetas,
  TOP_MEDICAMENTOS,
  type FilaMedicamento,
  type TotalesRecetas,
} from './prescriptions.js';
import type { ReportContext } from './shared.js';

const contexto = (filtros: Record<string, unknown> = {}): ReportContext => ({
  filters: reportFiltersSchema.parse(filtros),
  range: { from: '2026-10-01', to: '2026-10-31' },
  generatedAt: '2026-10-31T12:00:00.000Z',
});

const medicamento = (
  valores: Partial<FilaMedicamento> & { medicationName: string },
): FilaMedicamento => ({
  prescriptions: 1,
  items: 1,
  patients: 1,
  ...valores,
});

const totales = (valores: Partial<TotalesRecetas> = {}): TotalesRecetas => ({
  recetas: 1,
  anuladas: 0,
  ...valores,
});

describe('recetas por medicamento', () => {
  it('suma los renglones de los días y ordena por cantidad', () => {
    const documento = componerRecetas(
      [
        medicamento({ medicationName: 'Amoxicilina', prescriptions: 2, items: 2, patients: 2 }),
        medicamento({ medicationName: 'Amoxicilina', prescriptions: 1, items: 1, patients: 1 }),
        medicamento({ medicationName: 'Ibuprofeno', prescriptions: 1, items: 4, patients: 1 }),
      ],
      totales({ recetas: 4 }),
      contexto(),
    );

    // Ibuprofeno (4 renglones) por delante de Amoxicilina (2 + 1): el ranking es por
    // renglones, no por número de récipes.
    expect(documento.table.rows.map((fila) => fila['medicamento'])).toEqual([
      'Ibuprofeno',
      'Amoxicilina',
    ]);
    expect(documento.table.rows[1]).toMatchObject({ recetas: 3, renglones: 3, porcentaje: 42.9 });
    expect(documento.kpis.find((kpi) => kpi.label === 'Más recetado')?.value).toBe('Ibuprofeno');
    expect(documento.kpis.find((kpi) => kpi.label === 'Medicamentos distintos')?.value).toBe(2);
  });

  it('recorta la tabla al top y lo dice', () => {
    const filas = Array.from({ length: TOP_MEDICAMENTOS + 2 }, (_, indice) =>
      medicamento({ medicationName: `Medicamento ${String(indice)}`, items: 1 }),
    );
    const documento = componerRecetas(filas, totales(), contexto());

    expect(documento.table.rows).toHaveLength(TOP_MEDICAMENTOS);
    expect(documento.table.total).toBe(TOP_MEDICAMENTOS + 2);
    expect(documento.notes.join(' ')).toContain(
      `${String(TOP_MEDICAMENTOS)} de ${String(TOP_MEDICAMENTOS + 2)} medicamentos`,
    );
  });

  it('los anulados se avisan y no cuentan', () => {
    const documento = componerRecetas(
      [medicamento({ medicationName: 'Amoxicilina' })],
      totales({ recetas: 3, anuladas: 2 }),
      contexto(),
    );
    expect(documento.kpis.find((kpi) => kpi.label === 'Récipes emitidos')?.hint).toBe('2 anulados');
    expect(documento.notes.join(' ')).toContain('anulados');
  });

  it('sin recetas avisa y deja la tabla vacía', () => {
    const documento = componerRecetas([], totales({ recetas: 0 }), contexto());
    expect(documento.table.rows).toHaveLength(0);
    expect(documento.notes.join(' ')).toContain('Sin datos');
    expect(documento.kpis.find((kpi) => kpi.label === 'Más recetado')?.value).toBe('—');
  });
});
