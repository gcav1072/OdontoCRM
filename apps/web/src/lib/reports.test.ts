import { REPORT_KEYS, type ReportSeries, type ReportSeriesKind } from '@odontocrm/contracts';
import type { ReportSummary } from '@odontocrm/contracts';
import { describe, expect, it } from 'vitest';

import {
  blockedReportKeys,
  chartKindFor,
  defaultReportFilters,
  formattedCell,
  isAgeRangeInverted,
  isDateRangeInverted,
  kpiToneClass,
  reportRangeLabel,
  seriesToChartData,
  summaryKpis,
  toQueryParams,
  visibleReportKeys,
  type ReportFiltersState,
} from './reports';
import { t } from './i18n';

/**
 * Pruebas de la lógica pura del módulo de reportes (entorno node, sin DOM).
 *
 * Lo que se comprueba aquí es lo que se puede romper en silencio: que los
 * filtros vacíos no viajen a la API, que un rango de edad invertido no se mande,
 * que la secretaría no vea los reportes clínicos y que las cifras de la tabla
 * salgan en formato es-VE (con coma decimal).
 */

const filtros = (parcial: Partial<ReportFiltersState> = {}): ReportFiltersState => ({
  ...defaultReportFilters('2026-10-31'),
  ...parcial,
});

const serie = (parcial: Partial<ReportSeries> = {}): ReportSeries => ({
  id: 'funnel',
  label: 'Embudo',
  kind: 'bar',
  xLabel: 'Semana',
  yLabel: 'Citas',
  points: [],
  ...parcial,
});

describe('el resumen del día lee las confirmadas (ADR 0052)', () => {
  it('pinta la cifra de confirmadas que trae el reporte', () => {
    const resumen: ReportSummary = {
      date: '2026-10-07',
      generatedAt: '2026-10-07T12:00:00.000Z',
      appointments: {
        scheduled: 10,
        confirmed: 4,
        attended: 3,
        noShow: 1,
        pending: 6,
        cancelled: 0,
      },
      capacity: { capacity: 16, assigned: 10, freeSlots: 6 },
      patients: { active: 20, waiting: 2, newThisMonth: 5 },
      notifications: { sent: 8, failed: 0 },
      refreshedAt: null,
    };

    const kpi = summaryKpis(resumen).find(
      (item) => item.label === t('reportes.resumen.confirmadas'),
    );
    expect(kpi?.value).toBe(4);

    // El tono acompaña: sin confirmaciones no se pinta en verde.
    const sinConfirmar = summaryKpis({
      ...resumen,
      appointments: { ...resumen.appointments, confirmed: 0 },
    }).find((item) => item.label === t('reportes.resumen.confirmadas'));
    expect(sinConfirmar?.tone).toBe('neutral');
  });
});

describe('los filtros por defecto son la ventana de 30 días del contrato', () => {
  it('termina hoy y empieza 29 días antes', () => {
    const base = defaultReportFilters('2026-10-31');
    expect(base.from).toBe('2026-10-02');
    expect(base.to).toBe('2026-10-31');
    expect(base.granularity).toBe('week');
    expect(base.sex).toBe('');
    expect(base.status).toBe('');
    expect(base.ageMin).toBe('');
    expect(base.ageMax).toBe('');
  });
});

describe('toQueryParams', () => {
  it('omite los campos vacíos en vez de mandarlos en blanco', () => {
    const parametros = toQueryParams({
      from: '',
      to: '',
      ageMin: '',
      ageMax: '',
      sex: '',
      status: '',
      granularity: 'week',
    });

    expect(parametros).toEqual({ granularity: 'week' });
  });

  it('manda las edades como números, no como texto', () => {
    const parametros = toQueryParams(filtros({ ageMin: '18', ageMax: '40' }));

    expect(parametros.ageMin).toBe(18);
    expect(parametros.ageMax).toBe(40);
    expect(typeof parametros.ageMin).toBe('number');
  });

  it('acepta un solo extremo del rango de edad', () => {
    expect(toQueryParams(filtros({ ageMin: '66' }))).not.toHaveProperty('ageMax');
    expect(toQueryParams(filtros({ ageMin: '66' })).ageMin).toBe(66);
    expect(toQueryParams(filtros({ ageMax: '12' }))).not.toHaveProperty('ageMin');
  });

  it('manda el sexo, el estado, las fechas y la agrupación cuando están puestos', () => {
    const parametros = toQueryParams(
      filtros({
        from: '2026-01-01',
        to: '2026-03-31',
        sex: 'F',
        status: 'activo',
        granularity: 'month',
      }),
    );

    expect(parametros).toEqual({
      from: '2026-01-01',
      to: '2026-03-31',
      sex: 'F',
      status: 'activo',
      granularity: 'month',
    });
  });

  it('no manda un rango de edad invertido (la tabla sigue mostrando datos)', () => {
    const invertido = filtros({ ageMin: '70', ageMax: '20' });

    expect(isAgeRangeInverted(invertido)).toBe(true);
    expect(toQueryParams(invertido)).not.toHaveProperty('ageMin');
    expect(toQueryParams(invertido)).not.toHaveProperty('ageMax');
    // El resto de los filtros viaja igual: solo se descarta lo que no tiene sentido.
    expect(toQueryParams(invertido).granularity).toBe('week');
  });

  it('detecta el rango de fechas invertido antes de consultar', () => {
    expect(isDateRangeInverted(filtros({ from: '2026-10-31', to: '2026-10-01' }))).toBe(true);
    expect(isDateRangeInverted(filtros({ from: '2026-10-01', to: '2026-10-31' }))).toBe(false);
    expect(isDateRangeInverted(filtros({ from: '2026-10-01', to: '' }))).toBe(false);
  });
});

describe('visibleReportKeys', () => {
  it('con `reports:read` se ven los operativos y ningún clínico', () => {
    const visibles = visibleReportKeys((permiso) => permiso === 'reports:read');

    expect(visibles).toEqual(['funnel', 'capacity', 'demographics']);
    expect(blockedReportKeys((permiso) => permiso === 'reports:read')).toEqual([
      'clinical-profile',
      'oral-health',
      'prescriptions',
    ]);
  });

  it('con `reports:clinical` se ven los seis reportes del catálogo', () => {
    const conClinico = visibleReportKeys(
      (permiso) => permiso === 'reports:read' || permiso === 'reports:clinical',
    );

    expect(conClinico).toEqual([...REPORT_KEYS]);
    expect(blockedReportKeys(() => true)).toEqual([]);
  });

  it('los operativos no dependen del permiso clínico; los clínicos sí', () => {
    // A la ruta `/reportes` se entra con `reports:read`, así que lo que decide
    // este ayudante es el bloque clínico: sin `reports:clinical` quedan fuera el
    // perfil clínico, la salud bucal y los récipes.
    expect(visibleReportKeys(() => false)).toEqual(['funnel', 'capacity', 'demographics']);
    expect(blockedReportKeys(() => false)).toEqual([
      'clinical-profile',
      'oral-health',
      'prescriptions',
    ]);
  });
});

describe('seriesToChartData', () => {
  it('deja una clave por grupo y una fila por etiqueta del eje X', () => {
    const { data, groups } = seriesToChartData(
      serie({
        points: [
          { x: 'Semana 1', y: 10, group: 'atendidas' },
          { x: 'Semana 1', y: 2, group: 'no_asistio' },
          { x: 'Semana 2', y: 14, group: 'atendidas' },
          { x: 'Semana 2', y: 1, group: 'no_asistio' },
        ],
      }),
    );

    expect(groups).toEqual(['atendidas', 'no_asistio']);
    expect(data).toEqual([
      { x: 'Semana 1', atendidas: 10, no_asistio: 2 },
      { x: 'Semana 2', atendidas: 14, no_asistio: 1 },
    ]);
  });

  it('agrupa los puntos sin grupo con la etiqueta de la serie', () => {
    const { data, groups } = seriesToChartData(
      serie({
        label: 'Pacientes',
        points: [
          { x: '0-12', y: 4, group: null },
          { x: '13-17', y: 6, group: null },
        ],
      }),
    );

    expect(groups).toEqual(['Pacientes']);
    expect(data).toEqual([
      { x: '0-12', Pacientes: 4 },
      { x: '13-17', Pacientes: 6 },
    ]);
  });

  it('junta varias series del documento en una sola gráfica', () => {
    const { data, groups } = seriesToChartData([
      serie({ id: 'a', label: 'Solicitudes', points: [{ x: 'Semana 1', y: 30, group: null }] }),
      serie({
        id: 'b',
        label: 'Atendidas',
        points: [
          { x: 'Semana 1', y: 18, group: null },
          { x: 'Semana 2', y: 22, group: null },
        ],
      }),
    ]);

    expect(groups).toEqual(['Solicitudes', 'Atendidas']);
    expect(data).toEqual([
      { x: 'Semana 1', Solicitudes: 30, Atendidas: 18 },
      { x: 'Semana 2', Atendidas: 22 },
    ]);
  });

  it('sin puntos devuelve una gráfica vacía, no un error', () => {
    expect(seriesToChartData(serie())).toEqual({ data: [], groups: [] });
  });

  it('un tipo de gráfica desconocido cae en barras', () => {
    expect(chartKindFor({ kind: 'pie' })).toBe('pie');
    expect(chartKindFor({ kind: 'pirámide' as ReportSeriesKind })).toBe('bar');
  });
});

describe('formattedCell', () => {
  it('formatea los números en es-VE', () => {
    expect(formattedCell(1234.5, 'number')).toBe('1.234,5');
    expect(formattedCell(0, 'number')).toBe('0');
  });

  it('escribe el porcentaje con coma decimal y su signo', () => {
    expect(formattedCell(12.5, 'percent')).toBe('12,5 %');
    expect(formattedCell(100, 'percent')).toBe('100 %');
  });

  it('no adelanta ni atrasa un día las fechas sin hora', () => {
    expect(formattedCell('2026-10-02', 'date')).toBe('02/10/2026');
    expect(formattedCell('2026-01-09', 'date')).toBe('09/01/2026');
    // Una marca de tiempo completa sí pasa por la zona del consultorio.
    expect(formattedCell('2026-10-02T13:45:00.000Z', 'date')).toBe('02/10/2026');
  });

  it('deja el texto tal cual y marca la celda vacía con un guion', () => {
    expect(formattedCell('Femenino', 'text')).toBe('Femenino');
    expect(formattedCell('ya formateado', 'number')).toBe('ya formateado');
    expect(formattedCell(null, 'text')).toBe('—');
    expect(formattedCell(null, 'percent')).toBe('—');
  });
});

describe('kpiToneClass', () => {
  it('traduce cada tono a su color del tema', () => {
    expect(kpiToneClass('neutral')).toBe('text-ink');
    expect(kpiToneClass('good')).toBe('text-success');
    expect(kpiToneClass('warn')).toBe('text-warning');
    expect(kpiToneClass('bad')).toBe('text-danger');
  });
});

describe('reportRangeLabel', () => {
  it('escribe el período en formato local', () => {
    expect(reportRangeLabel({ from: '2026-10-01', to: '2026-10-31' })).toContain('01/10/2026');
    expect(reportRangeLabel({ from: '2026-10-01', to: '2026-10-31' })).toContain('31/10/2026');
  });
});
