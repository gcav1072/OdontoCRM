import {
  REPORT_DEFAULT_DAYS,
  REPORT_GRANULARITIES,
  REPORT_LABELS,
  REPORT_ORDER,
  REPORT_SERIES_KINDS,
  SEXES,
  reportPermissionFor,
  shiftIsoDate,
  type PatientStatus,
  type Permission,
  type ReportCellValue,
  type ReportColumnType,
  type ReportDocument,
  type ReportExportFormat,
  type ReportGranularity,
  type ReportKey,
  type ReportKpi,
  type ReportKpiTone,
  type ReportRange,
  type ReportSeries,
  type ReportSeriesKind,
  type ReportSummary,
  type Sex,
} from '@odontocrm/contracts';

import { TIME_ZONE, formatDate, formatNumber } from './format';
import { SEX_LABELS, t } from './i18n';

import type { ReportQueryParams } from './endpoints';

/**
 * Lógica pura del módulo `/reportes` (Fase 9, [ADR 0019](../../../../docs/adr/0019-reportes-y-kpis.md)).
 *
 * Aquí está todo lo que se puede probar sin navegador: las claves de consulta de
 * TanStack Query, el estado del formulario de filtros con sus valores por
 * defecto, qué reportes ve cada rol y las transformaciones que necesitan las
 * gráficas y la tabla. Los componentes de `components/reports/**` solo pintan lo
 * que sale de aquí y la página solo los conecta.
 *
 * Nada de este archivo toca el DOM ni `document`: las pruebas corren en node.
 */

/* ── Claves de consulta ────────────────────────────────────────────────────── */

/**
 * Claves de `useQuery`. La raíz `['reportes']` permite invalidar el módulo
 * entero de una vez (por ejemplo cuando el read model se refresca por evento).
 */
export const reportKeys = {
  all: ['reportes'] as const,
  /** Tablero del día (`GET /reports/summary`), sin filtros. */
  summary: () => [...reportKeys.all, 'resumen'] as const,
  /** Documento de un reporte con sus filtros: cada combinación es una entrada. */
  document: (key: ReportKey, filtros: ReportQueryParams) =>
    [...reportKeys.all, 'documento', key, filtros] as const,
};

/* ── Filtros ───────────────────────────────────────────────────────────────── */

/**
 * Estado del formulario de filtros. Se guardan **cadenas** (lo que escribe el
 * usuario en un `<input>`) y no números ni `undefined`: así el campo vacío se
 * distingue de un cero y el formulario no necesita estados intermedios.
 */
export interface ReportFiltersState {
  from: string;
  to: string;
  ageMin: string;
  ageMax: string;
  sex: '' | Sex;
  status: '' | PatientStatus;
  granularity: ReportGranularity;
}

const FORMATO_ISO = new Intl.DateTimeFormat('en-CA', {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  timeZone: TIME_ZONE,
});

/**
 * Fecha de hoy (`aaaa-mm-dd`) en la zona del consultorio. Se arma con las partes
 * del formateador y no con `toISOString()`: el servidor resuelve el rango por
 * defecto con la fecha de `America/Caracas`, y a las 8 de la noche en Caracas ya
 * es «mañana» en UTC.
 */
export const isoDateInClinic = (date: Date = new Date()): string => {
  let anio = '';
  let mes = '';
  let dia = '';
  for (const parte of FORMATO_ISO.formatToParts(date)) {
    if (parte.type === 'year') anio = parte.value;
    else if (parte.type === 'month') mes = parte.value;
    else if (parte.type === 'day') dia = parte.value;
  }
  return `${anio}-${mes}-${dia}`;
};

/**
 * Filtros por defecto: la ventana de 30 días del contrato (`REPORT_DEFAULT_DAYS`)
 * que termina hoy y agrupación semanal, que es lo que quiere ver quien abre la
 * pantalla. El resto de los filtros entra vacío.
 */
export const defaultReportFilters = (today: string = isoDateInClinic()): ReportFiltersState => ({
  from: shiftIsoDate(today, -(REPORT_DEFAULT_DAYS - 1)),
  to: today,
  ageMin: '',
  ageMax: '',
  sex: '',
  status: '',
  granularity: 'week',
});

export const GRANULARITY_LABELS: Readonly<Record<ReportGranularity, string>> = {
  day: t('reportes.granularidad.day'),
  week: t('reportes.granularidad.week'),
  month: t('reportes.granularidad.month'),
};

/** Entero del campo de edad, o `undefined` si está vacío o no es un número. */
const numeroDeEdad = (valor: string): number | undefined => {
  const limpio = valor.trim();
  if (limpio === '') return undefined;
  const numero = Number.parseInt(limpio, 10);
  return Number.isNaN(numero) ? undefined : numero;
};

/** Edad mínima mayor que la máxima: se avisa en el formulario y no se envía. */
export const isAgeRangeInverted = (state: ReportFiltersState): boolean => {
  const min = numeroDeEdad(state.ageMin);
  const max = numeroDeEdad(state.ageMax);
  return min !== undefined && max !== undefined && min > max;
};

/**
 * Fecha inicial posterior a la final. El contrato **rechaza** ese rango
 * (`resolveReportRange`), así que la pantalla lo detecta antes de consultar en
 * vez de mandar una petición que va a fallar.
 */
export const isDateRangeInverted = (state: ReportFiltersState): boolean => {
  const desde = state.from.trim();
  const hasta = state.to.trim();
  return desde !== '' && hasta !== '' && desde > hasta;
};

/**
 * Filtros del formulario al contrato de la API. Los campos vacíos **se omiten**
 * (no se mandan cadenas vacías ni ceros) y un rango de edad invertido se deja
 * fuera: la tabla sigue mostrando resultados útiles mientras se corrige, con el
 * aviso puesto en el campo (misma decisión que en `/pacientes`).
 */
export const toQueryParams = (state: ReportFiltersState): ReportQueryParams => {
  const parametros: ReportQueryParams = {};

  const desde = state.from.trim();
  const hasta = state.to.trim();
  if (desde !== '') parametros.from = desde;
  if (hasta !== '') parametros.to = hasta;

  if (!isAgeRangeInverted(state)) {
    const min = numeroDeEdad(state.ageMin);
    const max = numeroDeEdad(state.ageMax);
    if (min !== undefined) parametros.ageMin = min;
    if (max !== undefined) parametros.ageMax = max;
  }

  if (state.sex !== '') parametros.sex = state.sex;
  if (state.status !== '') parametros.status = state.status;
  if ((REPORT_GRANULARITIES as readonly string[]).includes(state.granularity)) {
    parametros.granularity = state.granularity;
  }

  return parametros;
};

/** ¿El usuario tocó algún filtro? (el botón «Limpiar» se apaga si no hay nada que limpiar). */
export const hasActiveFilters = (
  state: ReportFiltersState,
  base: ReportFiltersState = defaultReportFilters(),
): boolean =>
  state.from !== base.from ||
  state.to !== base.to ||
  state.ageMin !== base.ageMin ||
  state.ageMax !== base.ageMax ||
  state.sex !== base.sex ||
  state.status !== base.status ||
  state.granularity !== base.granularity;

/* ── Catálogo visible por rol ──────────────────────────────────────────────── */

const esVisible = (key: ReportKey, hasPermission: (permission: Permission) => boolean): boolean => {
  const permiso = reportPermissionFor(key);
  // Los operativos van con `reports:read`, que es el permiso que abre el módulo;
  // los clínicos (perfil clínico, salud bucal y récipes) exigen `reports:clinical`
  // (ADR 0039), que solo tienen el odontólogo y el administrador.
  return permiso === 'reports:read' || hasPermission(permiso);
};

/**
 * Reportes que puede abrir quien tiene esos permisos, en el orden del contrato
 * (`REPORT_ORDER`). Las pestañas se pintan con esta lista.
 */
export const visibleReportKeys = (
  hasPermission: (permission: Permission) => boolean,
): readonly ReportKey[] => REPORT_ORDER.filter((key) => esVisible(key, hasPermission));

/**
 * Reportes que existen pero quedan bloqueados por permiso: la pantalla los
 * muestra deshabilitados y explica por qué en vez de esconderlos (si no, la
 * secretaría no sabría que el sistema tiene reportes clínicos).
 */
export const blockedReportKeys = (
  hasPermission: (permission: Permission) => boolean,
): readonly ReportKey[] => REPORT_ORDER.filter((key) => !esVisible(key, hasPermission));

/* ── Gráficas ──────────────────────────────────────────────────────────────── */

/**
 * Fila de la gráfica: la etiqueta del eje X (`x`) más una clave por grupo. Es la
 * forma que quiere Recharts (`[{ x: 'Semana 1', atendidas: 5, no_asistio: 2 }]`).
 */
export interface ReportChartDatum {
  x: string;
  [grupo: string]: string | number;
}

export interface ReportChartData {
  /** Filas listas para pintar, en el orden en que llegan los puntos. */
  data: ReportChartDatum[];
  /** Claves de grupo en orden de aparición: una serie de la gráfica por grupo. */
  groups: string[];
}

/**
 * Convierte los puntos del contrato en las filas que espera Recharts.
 *
 * Acepta una serie o varias: el documento trae un array (`ReportDocument.series`)
 * y una gráfica puede querer juntar dos series del mismo período. El grupo de
 * cada punto es `point.group`; cuando viene nulo, el punto pertenece a la propia
 * serie y se agrupa con su etiqueta (así una serie sin grupos se dibuja igual).
 */
export const seriesToChartData = (
  series: ReportSeries | readonly ReportSeries[],
): ReportChartData => {
  const lista: readonly ReportSeries[] = Array.isArray(series) ? series : [series];
  const groups: string[] = [];
  const filas = new Map<string, ReportChartDatum>();

  for (const serie of lista) {
    for (const punto of serie.points) {
      const grupo = punto.group ?? serie.label;
      if (!groups.includes(grupo)) groups.push(grupo);
      const fila = filas.get(punto.x) ?? { x: punto.x };
      fila[grupo] = punto.y;
      filas.set(punto.x, fila);
    }
  }

  return { data: [...filas.values()], groups };
};

const esTipoDeGrafica = (valor: string): valor is ReportSeriesKind =>
  (REPORT_SERIES_KINDS as readonly string[]).includes(valor);

/**
 * Tipo de gráfica de una serie. El contrato lo trae cerrado, pero el servidor
 * podría añadir uno nuevo: en vez de dejar el hueco en blanco se pintan barras.
 */
export const chartKindFor = (series: Pick<ReportSeries, 'kind'>): ReportSeriesKind =>
  esTipoDeGrafica(series.kind) ? series.kind : 'bar';

const esSexo = (valor: string): valor is Sex => (SEXES as readonly string[]).includes(valor);

/**
 * Nombre legible de un grupo de la gráfica: `M`, `F` y `O` son sexos (la
 * pirámide demográfica los usa) y cualquier otro grupo se deja tal cual, porque
 * lo escribe el servicio en español (`atendidas`, `no_asistio`, …).
 */
export const reportGroupLabel = (group: string): string =>
  esSexo(group) ? SEX_LABELS[group] : group;

/**
 * Clase Tailwind del tono de un KPI. Los tonos son semánticos (`ReportKpiTone`)
 * y los colores salen de los tokens del tema, así que funcionan en claro y en
 * oscuro. Un tono desconocido cae en neutro.
 */
export const kpiToneClass = (tone: ReportKpiTone): string => {
  switch (tone) {
    case 'good':
      return 'text-success';
    case 'warn':
      return 'text-warning';
    case 'bad':
      return 'text-danger';
    default:
      return 'text-ink';
  }
};

/* ── Tabla ─────────────────────────────────────────────────────────────────── */

const SOLO_FECHA = /^\d{4}-\d{2}-\d{2}$/;

/**
 * `aaaa-mm-dd` → `dd/mm/aaaa` sin pasar por `Date`. Una fecha sin hora se
 * interpreta como medianoche UTC y el consultorio está en `America/Caracas`
 * (UTC-4): formatearla con `formatDate` mostraría el día anterior.
 */
export const formatIsoDay = (valor: string): string => {
  const [anio, mes, dia] = valor.split('-');
  return anio === undefined || mes === undefined || dia === undefined
    ? formatDate(valor)
    : `${dia}/${mes}/${anio}`;
};

/**
 * Texto de una celda según el tipo que declara la columna del contrato. Los
 * porcentajes llegan como número ya escalado (12,5 → «12,5 %») y los números y
 * las fechas se formatean en es-VE igual que en el resto de la interfaz.
 */
export const formattedCell = (value: ReportCellValue, type: ReportColumnType): string => {
  if (value === null) return t('comun.sinDato');

  switch (type) {
    case 'number':
      return typeof value === 'number' ? formatNumber(value) : value;
    case 'percent':
      return typeof value === 'number' ? `${formatNumber(value)} %` : value;
    case 'date':
      return typeof value === 'string' && SOLO_FECHA.test(value)
        ? formatIsoDay(value)
        : formatDate(value);
    default:
      return String(value);
  }
};

/* ── Documento y exportación ───────────────────────────────────────────────── */

/** «Del 01/10/2026 al 31/10/2026»: el período que el servidor resolvió de verdad. */
export const reportRangeLabel = (range: ReportRange): string =>
  t('reportes.rango', {
    desde: formattedCell(range.from, 'date'),
    hasta: formattedCell(range.to, 'date'),
  });

/**
 * ¿El documento trae algo que pintar? Un reporte sin datos llega con todo vacío
 * y con las notas del servicio explicando por qué («sin datos en el período»).
 */
export const hasReportData = (document: ReportDocument): boolean =>
  document.kpis.length > 0 ||
  document.series.some((serie) => serie.points.length > 0) ||
  document.table.rows.length > 0;

export const reportFormatLabel = (format: ReportExportFormat): string =>
  format === 'csv' ? t('reportes.formato.csv') : t('reportes.formato.pdf');

/**
 * Etiqueta del archivo que se descarga («Embudo y tasa de inasistencia en
 * formato CSV»). El **nombre** del archivo lo compone el contrato
 * (`reportFileName`); esto es el texto que lee el usuario en el botón.
 */
export const reportFileLabel = (key: ReportKey, format: ReportExportFormat): string =>
  t('reportes.export.etiqueta', {
    reporte: REPORT_LABELS[key],
    formato: reportFormatLabel(format),
  });

/* ── Tablero del día ───────────────────────────────────────────────────────── */

const tonoDeCero = (valor: number, tono: ReportKpiTone): ReportKpiTone =>
  valor === 0 ? 'neutral' : tono;

/**
 * KPIs del tablero del día (`GET /reports/summary`) con las etiquetas de la
 * interfaz y su tono. Los ocho que se pintan son los que se miran al abrir la
 * pantalla; el resto de las cifras del resumen viaja como pista de la tarjeta
 * relacionada para no llenar la primera fila de números.
 */
export const summaryKpis = (summary: ReportSummary): ReportKpi[] => [
  {
    label: t('reportes.resumen.citas'),
    value: summary.appointments.scheduled,
    unit: null,
    hint: t('reportes.resumen.citasCanceladas', {
      total: formatNumber(summary.appointments.cancelled),
    }),
    tone: 'neutral',
  },
  {
    label: t('reportes.resumen.atendidas'),
    value: summary.appointments.attended,
    unit: null,
    hint: null,
    tone: tonoDeCero(summary.appointments.attended, 'good'),
  },
  {
    label: t('reportes.resumen.inasistencias'),
    value: summary.appointments.noShow,
    unit: null,
    hint: null,
    tone: tonoDeCero(summary.appointments.noShow, 'bad'),
  },
  {
    label: t('reportes.resumen.pendientes'),
    value: summary.appointments.pending,
    unit: null,
    hint: null,
    tone: tonoDeCero(summary.appointments.pending, 'warn'),
  },
  {
    label: t('reportes.resumen.cupoLibre'),
    value: summary.capacity.freeSlots,
    unit: null,
    hint: t('reportes.resumen.cupoDetalle', {
      cupo: formatNumber(summary.capacity.capacity),
      asignados: formatNumber(summary.capacity.assigned),
    }),
    tone: summary.capacity.freeSlots > 0 ? 'good' : 'warn',
  },
  {
    label: t('reportes.resumen.activos'),
    value: summary.patients.active,
    unit: null,
    hint: null,
    tone: 'neutral',
  },
  {
    label: t('reportes.resumen.enEspera'),
    value: summary.patients.waiting,
    unit: null,
    hint: null,
    tone: tonoDeCero(summary.patients.waiting, 'warn'),
  },
  {
    label: t('reportes.resumen.nuevos'),
    value: summary.patients.newThisMonth,
    unit: null,
    hint: t('reportes.resumen.notificaciones', {
      enviadas: formatNumber(summary.notifications.sent),
      fallidas: formatNumber(summary.notifications.failed),
    }),
    tone: 'neutral',
  },
];
