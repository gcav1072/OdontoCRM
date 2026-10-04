import { AGE_BUCKETS, reportFiltersSchema } from '@odontocrm/contracts';
import { describe, expect, it } from 'vitest';

import { componerDemografia, type FilaDemografia } from './demographics.js';
import type { ReportContext } from './shared.js';

const contexto = (
  filtros: Record<string, unknown> = {},
  range = { from: '2026-10-01', to: '2026-10-31' },
): ReportContext => ({
  filters: reportFiltersSchema.parse(filtros),
  range,
  generatedAt: '2026-10-31T12:00:00.000Z',
});

const fila = (valores: Partial<FilaDemografia> = {}): FilaDemografia => ({
  day: '2026-10-05',
  bucket: '18-40',
  sex: 'F',
  status: 'activo',
  patients: 1,
  ...valores,
});

describe('pirámide demográfica', () => {
  it('arma la pirámide con los tramos del contrato y el grupo por sexo', () => {
    const documento = componerDemografia(
      [
        fila({ bucket: '0-12', sex: 'M', patients: 3 }),
        fila({ bucket: '18-40', sex: 'F', patients: 5 }),
        fila({ bucket: '18-40', sex: 'M', patients: 2 }),
        fila({ bucket: '66+', sex: 'F', patients: 1 }),
      ],
      0,
      contexto(),
    );

    const piramide = documento.series.find((serie) => serie.id === 'piramide');
    expect(piramide?.kind).toBe('pyramid');
    // Un punto por tramo y sexo presente: los grupos son `M`/`F`/`O` porque la
    // interfaz los traduce a «Masculino»/«Femenino»/«Otro».
    expect(piramide?.points.map((punto) => [punto.x, punto.group, punto.y])).toEqual([
      ['0 a 12 años', 'F', 0],
      ['0 a 12 años', 'M', 3],
      ['13 a 17 años', 'F', 0],
      ['13 a 17 años', 'M', 0],
      ['18 a 40 años', 'F', 5],
      ['18 a 40 años', 'M', 2],
      ['41 a 65 años', 'F', 0],
      ['41 a 65 años', 'M', 0],
      ['66 años o más', 'F', 1],
      ['66 años o más', 'M', 0],
    ]);
  });

  it('la tabla suma por tramo y calcula el porcentaje sobre los clasificados', () => {
    const documento = componerDemografia(
      [
        fila({ bucket: '0-12', sex: 'M', patients: 1 }),
        fila({ bucket: '18-40', sex: 'F', patients: 2 }),
        fila({ bucket: '18-40', sex: 'M', patients: 1 }),
      ],
      0,
      contexto(),
    );

    const porTramo = new Map(documento.table.rows.map((fila) => [fila['tramo'], fila]));
    expect(porTramo.get('18 a 40 años')).toMatchObject({
      masculino: 1,
      femenino: 2,
      total: 3,
      porcentaje: 75,
    });
    expect(porTramo.get('0 a 12 años')).toMatchObject({ total: 1, porcentaje: 25 });
    expect(porTramo.get('66 años o más')).toMatchObject({ total: 0, porcentaje: 0 });
    expect(documento.table.rows.map((fila) => fila['tramo'])).toEqual(
      AGE_BUCKETS.map((tramo) => tramo.label),
    );
  });

  it('los pacientes sin fecha de nacimiento salen aparte y se avisa', () => {
    const documento = componerDemografia(
      [fila({ bucket: 'sin-fecha', patients: 2 }), fila({ bucket: '66+', patients: 3 })],
      0,
      contexto(),
    );

    const ultima = documento.table.rows.at(-1);
    expect(ultima).toMatchObject({ tramo: 'Sin fecha de nacimiento', total: 2 });
    expect(documento.kpis.find((kpi) => kpi.label === 'Sin fecha de nacimiento')?.value).toBe(2);
    // La pirámide solo tiene los tramos del contrato —no inventa uno «sin fecha»— y
    // solo los sexos que aparecen en los datos (aquí, uno): cinco puntos.
    expect(documento.series.find((serie) => serie.id === 'piramide')?.points).toHaveLength(5);
    expect(documento.notes.join(' ')).toContain('no tienen fecha de nacimiento');
  });

  it('los porcentajes de menores y mayores salen de los tramos del contrato', () => {
    const documento = componerDemografia(
      [
        fila({ bucket: '0-12', patients: 1 }),
        fila({ bucket: '13-17', patients: 1 }),
        fila({ bucket: '18-40', patients: 2 }),
        fila({ bucket: '66+', patients: 1 }),
      ],
      3,
      contexto(),
    );

    expect(documento.kpis.find((kpi) => kpi.label === 'Menores de 18')?.value).toBe(40);
    expect(documento.kpis.find((kpi) => kpi.label === 'De 66 años o más')?.value).toBe(20);
    // El modo test se avisa: sus pacientes están dentro de las cifras.
    expect(documento.notes.join(' ')).toContain('modo test');
  });

  it('sin pacientes avisa y no deja series sin puntos', () => {
    const documento = componerDemografia([], 0, contexto());
    expect(documento.notes.join(' ')).toContain('Sin datos');
    expect(documento.kpis.find((kpi) => kpi.label === 'Pacientes')?.value).toBe(0);
    // Aun sin datos, la pirámide trae los cinco tramos con cero: la gráfica tiene
    // forma y se ve que el período está vacío, no roto.
    expect(documento.series.find((serie) => serie.id === 'piramide')?.points).toHaveLength(5);
  });
});
