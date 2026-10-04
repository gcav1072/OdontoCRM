import { reportFiltersSchema } from '@odontocrm/contracts';
import { describe, expect, it } from 'vitest';

import { componerCapacidad, type FilaDiaCapacidad, type HoraPico } from './capacity.js';
import type { ReportContext } from './shared.js';

const contexto = (
  filtros: Record<string, unknown> = {},
  range = { from: '2026-10-01', to: '2026-10-03' },
): ReportContext => ({
  filters: reportFiltersSchema.parse(filtros),
  range,
  generatedAt: '2026-10-03T12:00:00.000Z',
});

const diaFila = (valores: Partial<FilaDiaCapacidad> & { day: string }): FilaDiaCapacidad => ({
  capacity: null,
  assigned: 0,
  attended: 0,
  noShow: 0,
  ...valores,
});

describe('ocupación de la agenda', () => {
  it('calcula la ocupación sobre el cupo conocido y los días completos', () => {
    const documento = componerCapacidad(
      [
        diaFila({ day: '2026-10-01', capacity: 10, assigned: 8, attended: 6, noShow: 1 }),
        diaFila({ day: '2026-10-02', capacity: 4, assigned: 4, attended: 4 }),
      ],
      [],
      contexto(),
    );

    expect(documento.kpis.find((kpi) => kpi.label === 'Citas asignadas')?.value).toBe(12);
    expect(documento.kpis.find((kpi) => kpi.label === 'Cupo del período')?.value).toBe(14);
    // 12 asignadas sobre 14 de cupo.
    expect(documento.kpis.find((kpi) => kpi.label === 'Ocupación')?.value).toBe(85.7);
    expect(documento.kpis.find((kpi) => kpi.label === 'Días completos')?.value).toBe(1);
  });

  it('los días sin cupo fijado salen sin cupo ni ocupación, y se avisan', () => {
    const documento = componerCapacidad(
      [diaFila({ day: '2026-10-01', assigned: 2, attended: 2 })],
      [],
      contexto(),
    );

    const fila = documento.table.rows[0];
    expect(fila).toMatchObject({
      fecha: '2026-10-01',
      cupo: null,
      asignadas: 2,
      disponibles: null,
      ocupacion: null,
    });
    // El cupo efectivo de la agenda (plantillas de franjas) no viaja en los eventos:
    // en las cifras del resumen se cuenta con las citas asignadas como suelo.
    expect(documento.kpis.find((kpi) => kpi.label === 'Cupo del período')?.value).toBe(2);
    expect(documento.notes.join(' ')).toContain('no tienen cupo fijado a mano');
    expect(documento.notes.join(' ')).toContain('no viaja en los eventos');
  });

  it('detecta el día de mayor demanda y la hora pico', () => {
    const horas: HoraPico[] = [
      { hour: '08:00', citas: 3 },
      { hour: '09:00', citas: 7 },
      { hour: '14:00', citas: 2 },
    ];
    const documento = componerCapacidad(
      [
        diaFila({ day: '2026-10-01', capacity: 5, assigned: 2 }),
        diaFila({ day: '2026-10-02', capacity: 5, assigned: 5 }),
      ],
      horas,
      contexto(),
    );

    expect(documento.kpis.find((kpi) => kpi.label === 'Día de mayor demanda')?.value).toBe(
      '2026-10-02',
    );
    expect(documento.kpis.find((kpi) => kpi.label === 'Hora pico')?.value).toBe('09:00');
  });

  it('los días del rango sin actividad salen en la tabla y en la gráfica con ceros', () => {
    const documento = componerCapacidad(
      [diaFila({ day: '2026-10-02', capacity: 5, assigned: 1 })],
      [],
      contexto(),
    );

    expect(documento.table.rows.map((fila) => fila['fecha'])).toEqual([
      '2026-10-01',
      '2026-10-02',
      '2026-10-03',
    ]);
    const puntos = documento.series.find((serie) => serie.id === 'citas')?.points ?? [];
    expect(puntos).toHaveLength(9);
    expect(puntos.filter((punto) => punto.x === '2026-10-02')).toHaveLength(3);
  });

  it('sin datos avisa y deja las series vacías de contenido real', () => {
    const documento = componerCapacidad([], [], contexto());
    expect(documento.notes.join(' ')).toContain('Sin datos');
    expect(documento.kpis.find((kpi) => kpi.label === 'Hora pico')?.value).toBe('—');
  });
});
