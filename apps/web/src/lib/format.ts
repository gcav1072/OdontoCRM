import { t } from './i18n';

/**
 * Formato de fechas, horas y duraciones (ADR 0025).
 *
 * Reglas: fechas `dd/mm/aaaa` y horas en formato de 12 h con `a. m.` / `p. m.`,
 * siempre en la zona del consultorio (`America/Caracas`) y locale `es-VE`, sin
 * importar dónde esté el servidor. Toda la interfaz formatea por aquí: es el
 * único sitio donde se convierte una fecha a texto.
 */

export const LOCALE = 'es-VE';
export const TIME_ZONE = 'America/Caracas';

const formateadorFecha = new Intl.DateTimeFormat(LOCALE, {
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  timeZone: TIME_ZONE,
});

// Se extraen las partes por separado en vez de usar el sufijo del locale: así
// el resultado es «9:30 a. m.» siempre, sin depender de cómo escriba ICU el
// marcador «a. m.» en cada versión (espacio fino, puntos, etc.).
const formateadorHora = new Intl.DateTimeFormat(LOCALE, {
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
  timeZone: TIME_ZONE,
});

const formateadorNumero = new Intl.NumberFormat(LOCALE);

/** Convierte el valor que llega de la API en fecha válida, o `null` si no lo es. */
export const toDate = (value: string | number | Date | null | undefined): Date | null => {
  if (value === null || value === undefined || value === '') return null;
  const fecha = value instanceof Date ? value : new Date(value);
  return Number.isNaN(fecha.getTime()) ? null : fecha;
};

/** `dd/mm/aaaa` (por ejemplo `02/10/2026`). */
export const formatDate = (value: string | number | Date | null | undefined): string => {
  const fecha = toDate(value);
  return fecha ? formateadorFecha.format(fecha) : t('comun.sinDato');
};

/** Hora en 12 h con `a. m.` / `p. m.` (por ejemplo `9:30 a. m.`). */
export const formatTime = (value: string | number | Date | null | undefined): string => {
  const fecha = toDate(value);
  if (!fecha) return t('comun.sinDato');

  let horas24 = 0;
  let minutos = '00';
  for (const parte of formateadorHora.formatToParts(fecha)) {
    if (parte.type === 'hour') horas24 = Number(parte.value);
    else if (parte.type === 'minute') minutos = parte.value;
  }

  const horas12 = horas24 % 12 === 0 ? 12 : horas24 % 12;
  const sufijo = horas24 < 12 ? 'a. m.' : 'p. m.';
  return `${horas12}:${minutos} ${sufijo}`;
};

/** Fecha y hora juntas: `02/10/2026 · 9:30 a. m.`. */
export const formatDateTime = (value: string | number | Date | null | undefined): string => {
  const fecha = toDate(value);
  return fecha ? `${formatDate(fecha)} · ${formatTime(fecha)}` : t('comun.sinDato');
};

/** Solo el día y el mes, para encabezados: `02/10`. */
export const formatDayMonth = (value: string | number | Date | null | undefined): string => {
  const fecha = formatDate(value);
  const partes = fecha.split('/');
  return partes.length === 3 ? `${partes[0]}/${partes[1]}` : fecha;
};

/** Número con separador de miles es-VE. */
export const formatNumber = (value: number): string => formateadorNumero.format(value);

const MINUTO = 60_000;
const HORA = 60 * MINUTO;
const DIA = 24 * HORA;

/**
 * Tiempo relativo corto: «hace 5 min», «en 2 h», «hace 3 días». Para distancias
 * mayores a una semana se cae a la fecha completa, que informa más.
 */
export const formatRelative = (
  value: string | number | Date | null | undefined,
  now: Date = new Date(),
): string => {
  const fecha = toDate(value);
  if (!fecha) return t('comun.sinDato');

  const diferencia = fecha.getTime() - now.getTime();
  const pasado = diferencia < 0;
  const absoluta = Math.abs(diferencia);

  if (absoluta < 45_000) return pasado ? t('tiempo.ahora') : t('tiempo.enAhora');
  if (absoluta < 90_000) {
    return pasado ? t('tiempo.haceMin', { n: 1 }) : t('tiempo.enMin', { n: 1 });
  }
  if (absoluta < HORA) {
    const minutos = Math.round(absoluta / MINUTO);
    return pasado ? t('tiempo.haceMin', { n: minutos }) : t('tiempo.enMin', { n: minutos });
  }
  if (absoluta < DIA) {
    const horas = Math.round(absoluta / HORA);
    return pasado ? t('tiempo.haceHoras', { n: horas }) : t('tiempo.enHoras', { n: horas });
  }
  if (absoluta < 7 * DIA) {
    const dias = Math.round(absoluta / DIA);
    if (dias <= 1) return pasado ? t('tiempo.haceUnDia') : t('tiempo.enUnDia');
    return pasado ? t('tiempo.haceDias', { n: dias }) : t('tiempo.enDias', { n: dias });
  }

  return formatDate(fecha);
};

/** Duración entre dos instantes en formato compacto: «1 h 25 min». */
export const formatDuration = (
  from: string | number | Date | null | undefined,
  to: string | number | Date | null | undefined = new Date(),
): string => {
  const inicio = toDate(from);
  const fin = toDate(to);
  if (!inicio || !fin) return t('comun.sinDato');

  const totalMinutos = Math.max(0, Math.round((fin.getTime() - inicio.getTime()) / MINUTO));
  if (totalMinutos < 1) return t('tiempo.menosDeUnMinuto');

  const horas = Math.floor(totalMinutos / 60);
  const minutos = totalMinutos % 60;

  if (horas === 0) return t('tiempo.duracionMinutos', { minutos });
  if (minutos === 0) return t('tiempo.duracionHoras', { horas });
  return t('tiempo.duracionHorasMinutos', { horas, minutos });
};

/** Iniciales para el avatar de la cabecera: «María Pérez» → «MP». */
export const formatInitials = (fullName: string | null | undefined): string => {
  if (!fullName) return '?';
  const palabras = fullName
    .trim()
    .split(/\s+/)
    .filter((palabra) => palabra.length > 0);
  const primera = palabras[0]?.[0] ?? '';
  const segunda = palabras.length > 1 ? (palabras[palabras.length - 1]?.[0] ?? '') : '';
  return `${primera}${segunda}`.toUpperCase() || '?';
};

/** Texto legible del agente de usuario; si no hay dato, un guion. */
export const formatUserAgent = (value: string | null | undefined): string => {
  if (!value) return t('comun.sinDato');
  return value.length > 60 ? `${value.slice(0, 57)}…` : value;
};
