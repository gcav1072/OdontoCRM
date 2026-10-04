import { AGE_BUCKETS, REPORT_LABELS, reportFiltersSchema } from '@odontocrm/contracts';
import { describe, expect, it } from 'vitest';

import { hoyEnElConsultorio } from './index.js';
import {
  condicionesDePaciente,
  hayFiltrosDePaciente,
  notaDeFiltros,
  porcentaje,
  periodosDelRango,
  periodoDe,
  recortarTabla,
  tasaInasistencia,
  type ReportContext,
} from './shared.js';

/** Contexto de prueba: filtros por defecto (semanal) y un rango de un mes. */
const contextoDePrueba = (
  filtros: Record<string, unknown> = {},
  range = { from: '2026-10-01', to: '2026-10-31' },
): ReportContext => ({
  filters: reportFiltersSchema.parse(filtros),
  range,
  generatedAt: '2026-10-31T12:00:00.000Z',
});

describe('períodos del reporte', () => {
  it('agrupa por día, semana (desde el lunes) y mes', () => {
    expect(periodoDe('2026-10-07', 'day')).toBe('2026-10-07');
    expect(periodoDe('2026-10-07', 'month')).toBe('2026-10');
    // El 7 de octubre de 2026 es miércoles: su semana empieza el lunes 5.
    expect(periodoDe('2026-10-07', 'week')).toBe('2026-10-05');
    // El domingo pertenece a la semana que empezó el lunes anterior.
    expect(periodoDe('2026-10-11', 'week')).toBe('2026-10-05');
    expect(periodoDe('2026-10-12', 'week')).toBe('2026-10-12');
  });

  it('rellena los períodos sin actividad: una semana sin citas no desaparece', () => {
    const semanas = periodosDelRango({ from: '2026-10-01', to: '2026-10-31' }, 'week');
    expect(semanas).toEqual(['2026-09-28', '2026-10-05', '2026-10-12', '2026-10-19', '2026-10-26']);

    const meses = periodosDelRango({ from: '2026-01-15', to: '2026-03-02' }, 'month');
    expect(meses).toEqual(['2026-01', '2026-02', '2026-03']);

    const dias = periodosDelRango({ from: '2026-10-01', to: '2026-10-03' }, 'day');
    expect(dias).toEqual(['2026-10-01', '2026-10-02', '2026-10-03']);
  });
});

describe('tasas y porcentajes', () => {
  it('calcula el porcentaje con un decimal y sin dividir por cero', () => {
    expect(porcentaje(1, 3)).toBe(33.3);
    expect(porcentaje(0, 0)).toBe(0);
    expect(porcentaje(7, 7)).toBe(100);
  });

  it('la tasa de inasistencia deja fuera las citas canceladas', () => {
    // 2 inasistencias de 10 citas que debían ocurrir.
    expect(tasaInasistencia(8, 2)).toBe(20);
    expect(tasaInasistencia(0, 0)).toBe(0);
  });
});

describe('filtros de paciente', () => {
  it('la nota del documento deja constancia de los filtros aplicados', () => {
    const ctx = contextoDePrueba({ ageMin: 18, ageMax: 40, sex: 'F', status: 'activo' });
    expect(notaDeFiltros(ctx.filters, ctx.range.to)).toBe(
      'Filtros aplicados: edad de 18 a 40 años (cumplidos al 2026-10-31), sexo F, estado activo.',
    );
    expect(notaDeFiltros(contextoDePrueba().filters, '2026-10-31')).toBeNull();
  });

  it('solo cuenta como filtro de paciente la edad, el sexo y el estado', () => {
    expect(hayFiltrosDePaciente(reportFiltersSchema.parse({ granularity: 'month' }))).toBe(false);
    expect(hayFiltrosDePaciente(reportFiltersSchema.parse({ sex: 'F' }))).toBe(true);
    expect(hayFiltrosDePaciente(reportFiltersSchema.parse({ ageMin: 18 }))).toBe(true);
  });

  it('combina los tres filtros (Y lógico) y exige fecha de nacimiento para la edad', () => {
    const condiciones = condicionesDePaciente(
      reportFiltersSchema.parse({ sex: 'F', status: 'activo', ageMin: 18, ageMax: 40 }),
      '2026-10-31',
    );
    // sexo + estado + fecha de nacimiento no nula + dos comparaciones de edad.
    expect(condiciones).toHaveLength(5);
    expect(hayFiltrosDePaciente(reportFiltersSchema.parse({}))).toBe(false);
    expect(condicionesDePaciente(reportFiltersSchema.parse({}), '2026-10-31')).toHaveLength(0);
  });
});

describe('tablas recortadas', () => {
  it('recorta al top y dice cuántas filas había', () => {
    const filas = Array.from({ length: 25 }, (_, indice) => ({ n: indice }));
    const recortada = recortarTabla(filas, 20, 'medicamentos');
    expect(recortada.filas).toHaveLength(20);
    expect(recortada.total).toBe(25);
    expect(recortada.recortada).toBe(true);
    expect(recortada.nota).toContain('20 de 25');
  });

  it('sin recorte no hay nota', () => {
    const recortada = recortarTabla([{ n: 1 }], 20, 'medicamentos');
    expect(recortada.nota).toBeNull();
    expect(recortada.recortada).toBe(false);
  });
});

describe('catálogo y fecha del consultorio', () => {
  it('los tramos de edad son los del contrato', () => {
    expect(AGE_BUCKETS.map((tramo) => tramo.key)).toEqual([
      '0-12',
      '13-17',
      '18-40',
      '41-65',
      '66+',
    ]);
  });

  it('usa el título del contrato para cada reporte', () => {
    expect(REPORT_LABELS['oral-health']).toBe('Salud bucal');
  });

  it('la fecha de hoy es la del consultorio, no la de UTC', () => {
    // 02:00 UTC del 5 de octubre son las 22:00 del 4 en Caracas (UTC−4).
    expect(hoyEnElConsultorio('America/Caracas', new Date('2026-10-05T02:00:00.000Z'))).toBe(
      '2026-10-04',
    );
    expect(hoyEnElConsultorio('America/Caracas', new Date('2026-10-05T14:00:00.000Z'))).toBe(
      '2026-10-05',
    );
  });
});
