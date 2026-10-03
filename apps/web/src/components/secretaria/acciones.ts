import type { AppointmentSummary } from '@odontocrm/contracts';

import { isApiError } from '../../lib/api';
import { t, type TranslationKey } from '../../lib/i18n';
import { appointmentActions, type ActionContext } from '../../lib/scheduling';

/**
 * Piezas puras de la secretaría del día (Fase 5): las cinco transiciones del
 * flujo con su etiqueta y su aviso, el filtro del buscador y la lectura de los
 * códigos de error que el servidor manda dentro del `type` del problema
 * RFC 7807 (`https://odontocrm.local/errors/<código>`).
 *
 * La máquina de estados sigue siendo la de `@odontocrm/contracts`: aquí solo se
 * elige cuáles de esas transiciones son del mostrador y en qué orden se ven.
 */

/** Transiciones del flujo diario, en el orden en que se ofrecen. */
export const ACCIONES_SECRETARIA = ['check-in', 'call', 'start', 'attend', 'no-show'] as const;

export type AccionSecretaria = (typeof ACCIONES_SECRETARIA)[number];

const ETIQUETAS: Readonly<Record<AccionSecretaria, TranslationKey>> = {
  'check-in': 'secretaria.acciones.checkIn',
  call: 'secretaria.acciones.llamar',
  start: 'secretaria.acciones.pasar',
  attend: 'secretaria.acciones.atendido',
  'no-show': 'secretaria.acciones.noAsistio',
};

const HECHOS: Readonly<Record<AccionSecretaria, TranslationKey>> = {
  'check-in': 'secretaria.hecho.checkIn',
  call: 'secretaria.hecho.llamado',
  start: 'secretaria.hecho.enConsulta',
  attend: 'secretaria.hecho.atendido',
  'no-show': 'secretaria.hecho.noAsistio',
};

/**
 * Acciones que se ofrecen para una cita. Decide la máquina de estados por estado
 * y rol (`appointmentActions`); encima, y porque las cinco rutas del flujo
 * exigen `scheduling:write` en la API, sin ese permiso no se ofrece ninguna: el
 * odontólogo entra al módulo a consultar la jornada y el servidor le respondería
 * 403. El estado se recorta a las transiciones del mostrador: asignar,
 * notificar, cancelar y reprogramar viven en `/programacion`.
 */
export const accionesDeFila = (
  appointment: AppointmentSummary,
  context: ActionContext,
): AccionSecretaria[] => {
  if (!context.hasPermission('scheduling:write')) return [];
  const permitidas = appointmentActions(appointment, context);
  return ACCIONES_SECRETARIA.filter((accion) => permitidas.includes(accion));
};

/**
 * ¿Toca llamar fuera de orden? Cuando el estado no admite `call` pero sí la
 * llegada: el diálogo lo confirma y encadena `check-in` y `call`, que son las
 * dos transiciones que la máquina sí permite desde ahí.
 */
export const requiereLlamadoFueraDeOrden = (acciones: readonly AccionSecretaria[]): boolean =>
  !acciones.includes('call') && acciones.includes('check-in');

/** Etiqueta de la acción; el segundo llamado se distingue del primero. */
export const etiquetaDeAccion = (
  accion: AccionSecretaria,
  appointment: AppointmentSummary,
): string =>
  accion === 'call' && appointment.callCount > 0
    ? t('programacion.accion.llamado2')
    : t(ETIQUETAS[accion]);

/** Aviso de éxito de una transición, con el nombre del paciente. */
export const hechoDeAccion = (accion: AccionSecretaria, paciente: string): string =>
  t(HECHOS[accion], { paciente });

/** Sin acentos ni mayúsculas: «María» encuentra «maria» y al revés. */
const sinAcentos = (valor: string): string =>
  valor
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();

/** Solo los dígitos: el teléfono y el documento se escriben con separadores. */
const soloDigitos = (valor: string): string => valor.replace(/\D/g, '');

/**
 * Filtro del buscador: nombre, documento, teléfono o ticket, por coincidencia
 * parcial. Documento y teléfono se comparan además sin separadores, para que
 * «+58 412-000-0000» aparezca escribiendo «4120000000».
 */
export const coincideBusqueda = (appointment: AppointmentSummary, termino: string): boolean => {
  const aguja = sinAcentos(termino);
  if (aguja.length === 0) return true;

  const digitos = soloDigitos(aguja);
  const campos = [
    appointment.patientName,
    appointment.patientDocument,
    appointment.patientPhone,
    appointment.ticket,
  ];

  return campos.some((valor) => {
    if (valor === null) return false;
    const texto = sinAcentos(valor);
    return texto.includes(aguja) || (digitos.length > 0 && soloDigitos(texto).includes(digitos));
  });
};

/** Orden de la jornada: por hora y, a igual hora, por orden de creación. */
export const porHoraDeInicio = (
  izquierda: AppointmentSummary,
  derecha: AppointmentSummary,
): number =>
  izquierda.startTime.localeCompare(derecha.startTime) ||
  izquierda.createdAt.localeCompare(derecha.createdAt);

/* ── Códigos del RFC 7807 ──────────────────────────────────────────────────── */

/** «Atendido» sin sesión clínica cerrada: el servidor exige el motivo. */
export const CODIGO_SESION_CLINICA = 'clinical_session_required';
/** Inasistencia antes de la tolerancia (hora de la cita + 15 minutos). */
export const CODIGO_INASISTENCIA_PRONTO = 'no_show_too_early';

/**
 * Código del problema a partir del `type` del cuerpo RFC 7807, que es donde
 * viaja (`.../errors/clinical_session_required`). El cliente HTTP no expone un
 * campo `code`, así que se lee del último segmento del tipo.
 */
export const codigoDeProblema = (error: unknown): string | null => {
  if (!isApiError(error)) return null;

  const tipo = error.payload?.['type'];
  if (typeof tipo !== 'string') return null;

  const partes = tipo.split('/');
  const codigo = partes[partes.length - 1];
  return codigo !== undefined && codigo.length > 0 ? codigo : null;
};
