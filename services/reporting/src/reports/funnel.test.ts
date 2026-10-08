import { reportFiltersSchema } from '@odontocrm/contracts';
import { describe, expect, it } from 'vitest';

import { agruparEmbudo, componerEmbudo, totalesDe, type FilaDiaEmbudo } from './funnel.js';
import type { ReportContext } from './shared.js';

const contexto = (
  filtros: Record<string, unknown> = {},
  range = { from: '2026-10-01', to: '2026-10-31' },
): ReportContext => ({
  filters: reportFiltersSchema.parse(filtros),
  range,
  generatedAt: '2026-10-31T12:00:00.000Z',
});

const dia = (day: string, valores: Partial<Omit<FilaDiaEmbudo, 'day'>> = {}): FilaDiaEmbudo => ({
  day,
  requests: 0,
  scheduled: 0,
  notified: 0,
  confirmed: 0,
  attended: 0,
  noShow: 0,
  cancelled: 0,
  cancelledByPatient: 0,
  ...valores,
});

/**
 * El embudo es el reporte con más aritmética: agrupa por período, suma etapas y
 * calcula dos tasas. Todo eso se prueba aquí, sin base de datos.
 */
describe('embudo e inasistencia', () => {
  it('agrupa por semana sumando cada etapa', () => {
    const filas = [
      dia('2026-10-05', { requests: 3, scheduled: 2, notified: 2, attended: 1 }),
      dia('2026-10-07', { requests: 1, scheduled: 3, notified: 1, attended: 2, noShow: 1 }),
      dia('2026-10-13', { requests: 2, scheduled: 1, attended: 1 }),
    ];

    const porSemana = agruparEmbudo(filas, 'week');
    expect(porSemana.get('2026-10-05')).toEqual({
      solicitudes: 4,
      programadas: 5,
      notificadas: 3,
      confirmadas: 0,
      atendidas: 3,
      inasistencias: 1,
      canceladas: 0,
      canceladasPaciente: 0,
    });
    expect(porSemana.get('2026-10-12')?.atendidas).toBe(1);

    const porMes = agruparEmbudo(filas, 'month');
    expect(porMes.get('2026-10')).toEqual({
      solicitudes: 6,
      programadas: 6,
      notificadas: 3,
      confirmadas: 0,
      atendidas: 4,
      inasistencias: 1,
      canceladas: 0,
      canceladasPaciente: 0,
    });
  });

  it('compone la tabla por período con las semanas sin datos en cero', () => {
    const documento = componerEmbudo(
      [
        dia('2026-10-05', { requests: 4, scheduled: 3, notified: 3, attended: 2, noShow: 1 }),
        dia('2026-10-20', { requests: 1, scheduled: 1, notified: 1, attended: 1 }),
      ],
      contexto(),
    );

    // Del 1 al 31 de octubre de 2026 caen cinco semanas (la primera empieza en
    // septiembre): las que no tienen citas salen con ceros.
    expect(documento.table.rows.map((fila) => fila['periodo'])).toEqual([
      'semana del 2026-09-28',
      'semana del 2026-10-05',
      'semana del 2026-10-12',
      'semana del 2026-10-19',
      'semana del 2026-10-26',
    ]);
    expect(documento.table.rows[0]).toMatchObject({
      solicitudes: 0,
      programadas: 0,
      atendidas: 0,
      tasa: 0,
    });
    expect(documento.table.rows[1]).toMatchObject({
      solicitudes: 4,
      programadas: 3,
      notificadas: 3,
      atendidas: 2,
      inasistencias: 1,
      tasa: 33.3,
    });
  });

  it('la tasa de inasistencia no cuenta las canceladas', () => {
    const totales = totalesDe([
      dia('2026-10-01', { scheduled: 10, attended: 6, noShow: 2, cancelled: 2 }),
    ]);
    expect(totales.canceladas).toBe(2);

    const documento = componerEmbudo(
      [dia('2026-10-01', { scheduled: 10, attended: 6, noShow: 2, cancelled: 2 })],
      contexto(),
    );
    // 2 inasistencias sobre 8 citas que debían ocurrir.
    expect(documento.kpis.find((kpi) => kpi.label === 'Tasa de inasistencia')?.value).toBe(25);
    expect(documento.kpis.find((kpi) => kpi.label === 'Conseguir cita')?.value).toBe(0);
  });

  it('el embudo diario sale por día y avisa cuando no hay datos', () => {
    const documento = componerEmbudo(
      [],
      contexto({ granularity: 'day' }, { from: '2026-10-01', to: '2026-10-03' }),
    );
    expect(documento.table.rows).toHaveLength(3);
    expect(documento.notes.join(' ')).toContain('Sin datos');
    // Cinco etapas por cada uno de los tres días.
    expect(documento.series.find((serie) => serie.id === 'embudo')?.points).toHaveLength(15);
  });

  it('la serie del embudo lleva las cinco etapas por período', () => {
    const documento = componerEmbudo(
      [dia('2026-10-05', { requests: 2, scheduled: 1, notified: 1, confirmed: 1, attended: 1 })],
      contexto({ granularity: 'day' }, { from: '2026-10-05', to: '2026-10-05' }),
    );
    const puntos = documento.series.find((serie) => serie.id === 'embudo')?.points ?? [];
    expect(puntos.map((punto) => punto.group)).toEqual([
      'solicitudes',
      'programadas',
      'notificadas',
      'confirmadas',
      'atendidas',
    ]);
    expect(documento.series.find((serie) => serie.id === 'inasistencia')?.kind).toBe('line');
  });

  it('las cancelaciones del paciente salen en KPI, columna y serie propias (ADR 0053)', () => {
    const documento = componerEmbudo(
      [
        dia('2026-10-05', {
          requests: 3,
          scheduled: 2,
          notified: 2,
          attended: 1,
          cancelled: 1,
          cancelledByPatient: 1,
        }),
      ],
      contexto({ granularity: 'day' }, { from: '2026-10-05', to: '2026-10-05' }),
    );

    // KPI card con la cifra (no se mezcla con las canceladas por la secretaría).
    expect(documento.kpis.find((kpi) => kpi.label === 'Canceladas por el paciente')?.value).toBe(1);
    // Columna de la tabla (y por tanto del CSV).
    expect(documento.table.columns.some((columna) => columna.key === 'canceladasPaciente')).toBe(
      true,
    );
    expect(documento.table.rows[0]?.['canceladasPaciente']).toBe(1);
    // Serie propia, separada de la del embudo.
    const serie = documento.series.find((serie) => serie.id === 'canceladas_paciente');
    expect(serie?.kind).toBe('bar');
    expect(serie?.points.map((punto) => punto.y)).toEqual([1]);
  });
});
