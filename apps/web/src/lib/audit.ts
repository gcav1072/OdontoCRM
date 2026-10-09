import type { AuditEventsParams } from './endpoints';
import { formatNumber } from './format';
import { PATIENT_FIELD_LABELS, t, type TranslationKey } from './i18n';

/**
 * Piezas puras del módulo de auditoría (Fase 9): claves de consulta, estado de
 * los filtros traducido a parámetros de la API, el contador de resultados y los
 * catálogos de acciones y entidades.
 *
 * Lo que se puede probar sin navegador vive aquí, no en los componentes: la
 * pantalla solo pinta lo que devuelven estas funciones.
 */

/* ── Claves de consulta ────────────────────────────────────────────────────── */

/**
 * Claves de TanStack Query. `root` invalida todo el listado de una vez; los
 * filtros van dentro de la clave para que cada combinación tenga su propia
 * entrada (TanStack la serializa de forma estable, así que dos objetos con los
 * mismos filtros comparten caché).
 */
export const auditKeys = {
  root: ['auditoria'] as const,
  events: (params: AuditEventsParams) => ['auditoria', 'eventos', params] as const,
};

/* ── Filtros ───────────────────────────────────────────────────────────────── */

/**
 * Filtros de la pantalla, tal como los escribe la persona. Son **texto** y no
 * tipos del contrato a propósito: un `<input>` vacío es `''` y no `undefined`, y
 * así el formulario no necesita convertir nada al limpiarse.
 */
export interface AuditFilterState {
  /** `aaaa-mm-dd` del `<input type="date">`; vacío = sin límite. */
  desde: string;
  hasta: string;
  usuario: string;
  /** Código de `AUDIT_ACTIONS`; vacío = todas. */
  accion: string;
  tipoEntidad: string;
  identificador: string;
  campo: string;
}

export const EMPTY_AUDIT_FILTERS: AuditFilterState = {
  desde: '',
  hasta: '',
  usuario: '',
  accion: '',
  tipoEntidad: '',
  identificador: '',
  campo: '',
};

/** Copia limpia del estado vacío (evita compartir un objeto mutable entre pantallas). */
export const emptyAuditFilters = (): AuditFilterState => ({ ...EMPTY_AUDIT_FILTERS });

/**
 * Filtros → parámetros de `auditApi`. Los vacíos **no se envían** (el servidor
 * los trataría como un valor a comparar) y los textos se recortan.
 *
 * `desde` y `hasta` viajan tal cual los manda el `<input type="date">`
 * (`aaaa-mm-dd`): el servidor los interpreta como el día completo en Venezuela
 * (`auditInstantRange`), que es lo que espera quien escribe la fecha.
 *
 * No incluye `page` ni `pageSize`: la paginación de la tabla y la exportación
 * (que baja todo) son dos usos distintos de los mismos filtros.
 */
export const toQueryParams = (state: AuditFilterState): AuditEventsParams => {
  const params: AuditEventsParams = {};

  if (state.desde.trim() !== '') params.from = state.desde.trim();
  if (state.hasta.trim() !== '') params.to = state.hasta.trim();
  if (state.usuario.trim() !== '') params.actorUsername = state.usuario.trim();
  if (state.accion.trim() !== '') params.action = state.accion.trim();
  if (state.tipoEntidad.trim() !== '') params.entityType = state.tipoEntidad.trim();
  if (state.identificador.trim() !== '') params.entityId = state.identificador.trim();
  if (state.campo.trim() !== '') params.field = state.campo.trim();

  return params;
};

/** ¿Hay algo que filtrar? (los espacios en blanco no cuentan). */
export const hasActiveFilters = (state: AuditFilterState): boolean =>
  Object.keys(toQueryParams(state)).length > 0;

/* ── Contador de resultados ────────────────────────────────────────────────── */

export interface AuditSummaryPage {
  page: number;
  pageSize: number;
  total: number;
}

/**
 * Línea del contador: «1–50 de 320». Con el total en cero devuelve «Sin
 * resultados» en vez de «0–0 de 0», que no dice nada; y si la página quedó más
 * allá del final (alguien cambió los filtros), el extremo se recorta al total en
 * lugar de mostrar un rango imposible.
 */
export const summaryLine = ({ page, pageSize, total }: AuditSummaryPage): string => {
  if (total === 0) return t('auditoria.resumen.cero');

  const desde = Math.min((page - 1) * pageSize + 1, total);
  const hasta = Math.min(page * pageSize, total);

  return t('auditoria.resumen.linea', {
    desde: formatNumber(desde),
    hasta: formatNumber(hasta),
    total: formatNumber(total),
  });
};

/* ── Catálogos ─────────────────────────────────────────────────────────────── */

/**
 * Etiqueta en español de una acción de auditoría. El diccionario vive en
 * `i18n.ts` (único sitio con textos) y se reexporta aquí para que la pantalla
 * importe todo lo de auditoría desde un solo módulo. Si el servidor registra una
 * acción que el contrato aún no conoce, se muestra el código tal cual: mejor un
 * `patient_updated` que una celda vacía.
 */
export { auditActionLabel as actionLabel } from './i18n';

interface EntidadConocida {
  value: string;
  key: TranslationKey;
}

/** Tipos de entidad que existen hoy en el sistema (los que aparecen en la bitácora). */
const ENTIDADES: readonly EntidadConocida[] = [
  { value: 'patient', key: 'auditoria.entidad.patient' },
  { value: 'appointment', key: 'auditoria.entidad.appointment' },
  { value: 'request', key: 'auditoria.entidad.request' },
  { value: 'day_capacity', key: 'auditoria.entidad.day_capacity' },
  { value: 'slot_template', key: 'auditoria.entidad.slot_template' },
  { value: 'user', key: 'auditoria.entidad.user' },
  { value: 'device_token', key: 'auditoria.entidad.device_token' },
  { value: 'medical_record', key: 'auditoria.entidad.medical_record' },
  { value: 'clinical_session', key: 'auditoria.entidad.clinical_session' },
  { value: 'prescription', key: 'auditoria.entidad.prescription' },
  { value: 'tooth_finding', key: 'auditoria.entidad.tooth_finding' },
  { value: 'odontogram', key: 'auditoria.entidad.odontogram' },
  { value: 'refresh_token', key: 'auditoria.entidad.refresh_token' },
  { value: 'session', key: 'auditoria.entidad.session' },
  { value: 'dentist_profile', key: 'auditoria.entidad.dentist_profile' },
  { value: 'clinic_profile', key: 'auditoria.entidad.clinic_profile' },
];

/** Campos de la identidad del consultorio, con su nombre en español. */
const IDENTITY_FIELD_LABELS: Readonly<Record<string, string>> = {
  mpps: t('auditoria.campo.mpps'),
  specialty: t('auditoria.campo.specialty'),
  licenseNumber: t('auditoria.campo.licenseNumber'),
  contactEmail: t('auditoria.campo.contactEmail'),
  name: t('auditoria.campo.name'),
  legalName: t('auditoria.campo.legalName'),
  address: t('auditoria.campo.address'),
  city: t('auditoria.campo.city'),
  phones: t('auditoria.campo.phones'),
  rif: t('auditoria.campo.rif'),
  website: t('auditoria.campo.website'),
  logo: t('auditoria.campo.logo'),
};

export interface AuditEntityTypeOption {
  value: string;
  label: string;
}

/** Opciones del filtro por tipo de entidad, con su nombre en español. */
export const entityTypeOptions = (): AuditEntityTypeOption[] =>
  ENTIDADES.map((entidad) => ({ value: entidad.value, label: t(entidad.key) }));

/** Nombre legible de un tipo de entidad; uno nuevo del servidor se muestra tal cual. */
export const entityTypeLabel = (entityType: string): string => {
  const conocida = ENTIDADES.find((entidad) => entidad.value === entityType);
  return conocida === undefined ? entityType : t(conocida.key);
};

/**
 * Nombre legible del campo que cambió en el diff. Los campos del paciente ya
 * tienen etiqueta en el diccionario (`PATIENT_FIELD_LABELS`: `phone` → «Teléfono»);
 * en el resto de entidades el campo viaja con su nombre técnico y se muestra tal
 * cual, porque inventarle una traducción a cada servicio sería mentir sobre el dato.
 */
export const fieldLabel = (field: string, entityType?: string): string => {
  if (entityType === 'patient') return PATIENT_FIELD_LABELS[field] ?? field;
  if (entityType === 'dentist_profile' || entityType === 'clinic_profile') {
    return IDENTITY_FIELD_LABELS[field] ?? field;
  }
  return field;
};

/** Texto del indicador de campos cambiados: «1 campo» / «3 campos». */
export const changedFieldsLabel = (total: number): string =>
  total === 1
    ? t('auditoria.tabla.unCampo')
    : t('auditoria.tabla.variosCampos', { total: formatNumber(total) });

/* ── Descarga ──────────────────────────────────────────────────────────────── */

/**
 * Nombre del archivo exportado: el mismo que el servidor manda en
 * `content-disposition` (`auditoria-<desde>_<hasta>.csv`). Se calcula también
 * aquí porque `apiBinary` devuelve solo el `Blob` y es el atributo `download`
 * del enlace el que nombra el archivo en el navegador.
 */
export const exportFileName = (params: AuditEventsParams): string => {
  const parte = (valor: string | undefined, porDefecto: string): string => {
    if (valor === undefined || valor === '') return porDefecto;
    const limpio = valor.replace(/[^0-9A-Za-z._-]/g, '-');
    return limpio.length > 0 ? limpio : porDefecto;
  };
  return `auditoria-${parte(params.from, 'inicio')}_${parte(params.to, 'fin')}.csv`;
};
