import { z } from 'zod';

import type { Permission } from './enums.js';

/**
 * Licenciamiento **offline** de la instalación ([ADR 0075](../../../docs/adr/0075-licenciamiento-offline-y-modo-consulta.md)).
 *
 * Una instalación es un consultorio: el estado vive en identity y la app lo
 * convierte en dos cosas a la vez:
 *
 *   · un **aviso** (banner y página `/licencia`), y
 *   · un **límite de permisos**: con la licencia (o la prueba) vencida, el token
 *     de acceso conserva solo los permisos de lectura y la instalación entra en
 *     «modo consulta». Los datos clínicos se pueden leer, imprimir y exportar
 *     siempre; lo que deja de poder hacerse es escribir.
 *
 * La licencia es un **JWT de EdDSA** firmado con la clave del proveedor. El
 * formato y las reglas viven aquí, en funciones puras, para que los usen igual
 * el emisor (CLI y bot del proveedor), la app (identity/web) y las herramientas
 * del consultorio (bot de administración y `npm run estado`). La verificación
 * criptográfica está en `@odontocrm/kernel`; aquí solo se describe el contenido.
 */

/* ── Constantes del producto ───────────────────────────────────────────────── */

/** Días de prueba desde la instalación. */
export const TRIAL_DAYS = 30;

/** Tipos de licencia que se venden. La prueba no es un tipo: la da la instalación. */
export const LICENSE_KINDS = ['mensual', 'trimestral', 'anual'] as const;
export type LicenseKind = (typeof LICENSE_KINDS)[number];

/** Duración de cada tipo, en días fijos (decisión del 2026-11-11). */
export const LICENSE_KIND_DAYS: Readonly<Record<LicenseKind, number>> = {
  mensual: 30,
  trimestral: 90,
  anual: 365,
};

export const LICENSE_KIND_LABELS: Readonly<Record<LicenseKind, string>> = {
  mensual: 'Mensual',
  trimestral: 'Trimestral',
  anual: 'Anual',
};

/** Días que faltan para vencer a partir de los cuales se avisa. */
export const LICENSE_WARN_DAYS = 7;

/** Emisor y audiencia del JWT de licencia (distintos de los del token de sesión). */
export const LICENSE_ISSUER = 'odontocrm-licencias';
export const LICENSE_AUDIENCE = 'odontocrm-instalacion';

/** Versión del formato de licencia. Si cambia, la app vieja no la acepta. */
export const LICENSE_VERSION = 1;

/** Atraso del reloj tolerado antes de dar la licencia por sospechosa (horas). */
export const LICENSE_CLOCK_TOLERANCE_HOURS = 24;

/** Prefijo del código de solicitud que viaja por WhatsApp entre consultorio y proveedor. */
export const LICENSE_REQUEST_PREFIX = 'ODO-REQ1.';

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

/* ── Claims de la licencia (el JWT firmado) ───────────────────────────────── */

export const licenseClientSchema = z.object({
  /** Nombre del consultorio o de la persona que contrata. */
  nombre: z.string().trim().min(1).max(120),
  /** RIF del consultorio, si se conoce (se imprime en el recibo y en el panel). */
  rif: z.string().trim().max(20).optional(),
});
export type LicenseClient = z.infer<typeof licenseClientSchema>;

/**
 * Contenido firmado de una licencia. `lic` es el identificador legible
 * (`LIC-2026-0001`) que también guarda el registro del proveedor.
 *
 * `emitidaEn` y `venceEn` son ISO 8601 con zona. No se usa la caducidad del JWT
 * (`exp`) a propósito: la app tiene que poder distinguir «firma mala» de
 * «licencia vencida», y una firma sigue siendo válida aunque haya vencido.
 */
export const licenseClaimsSchema = z.object({
  v: z.literal(LICENSE_VERSION),
  lic: z.string().trim().min(1).max(40),
  tipo: z.enum(LICENSE_KINDS),
  /** UUID de la instalación a la que está atada. */
  instalacion: z.uuid(),
  cliente: licenseClientSchema,
  emitidaEn: z.string().datetime({ offset: true }),
  venceEn: z.string().datetime({ offset: true }),
  /** Módulos licenciados; `['*']` = producto completo (hoy siempre). */
  modulos: z.array(z.string().trim().min(1).max(40)).min(1).default(['*']),
  /** Nota libre del proveedor (no se muestra al consultorio salvo en el detalle). */
  notas: z.string().trim().max(300).optional(),
});
export type LicenseClaims = z.infer<typeof licenseClaimsSchema>;

/* ── Estado de la instalación ─────────────────────────────────────────────── */

export const LICENSING_ESTADOS = [
  'trial',
  'trial_por_vencer',
  'trial_vencida',
  'licencia_vigente',
  'licencia_por_vencer',
  'licencia_vencida',
  'reloj_atrasado',
] as const;
export type LicensingEstado = (typeof LICENSING_ESTADOS)[number];

export type LicensingOrigen = 'trial' | 'licencia';

export interface LicensingStatus {
  estado: LicensingEstado;
  /** `true` cuando el sistema está en modo consulta (solo lectura). */
  soloLectura: boolean;
  origen: LicensingOrigen | null;
  tipo: LicenseKind | null;
  /** Días que quedan (0 cuando ya venció). `null` solo si no hay origen. */
  diasRestantes: number | null;
  /** ISO del vencimiento del trial o de la licencia. */
  venceEn: string | null;
  /** Mensaje legible, en español, listo para pintar sin más lógica. */
  mensaje: string;
}

export interface ResolveLicensingInput {
  ahora: Date;
  instaladaEn: Date;
  /** Última vez que la instalación vio un reloj coherente (anti-atraso). */
  ultimaVezVisto: Date | null;
  /** Licencia verificada; `null` mientras está en prueba. */
  licencia: LicenseClaims | null;
  /** Tolerancia de atraso del reloj; por defecto `LICENSE_CLOCK_TOLERANCE_HOURS`. */
  toleranciaRelojHoras?: number;
}

const fechaCorta = new Intl.DateTimeFormat('es-VE', {
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  timeZone: 'America/Caracas',
});

const fecha = (valor: Date): string => fechaCorta.format(valor);

const dias = (cantidad: number): string => `${String(cantidad)} ${cantidad === 1 ? 'día' : 'días'}`;

/** Días que faltan para un vencimiento, redondeando hacia arriba y sin bajar de 0. */
const diasHasta = (vencimiento: Date, ahora: Date): number => {
  const restantes = vencimiento.getTime() - ahora.getTime();
  return restantes <= 0 ? 0 : Math.ceil(restantes / DAY_MS);
};

const mensajeTrial = (
  estado: 'trial' | 'trial_por_vencer' | 'trial_vencida',
  diasRestantes: number,
  venceEn: Date,
): string => {
  switch (estado) {
    case 'trial':
      return `Estás en el periodo de prueba: quedan ${dias(diasRestantes)} (hasta el ${fecha(venceEn)}).`;
    case 'trial_por_vencer':
      return `La prueba vence en ${dias(diasRestantes)} (el ${fecha(venceEn)}). Solicita la licencia para seguir editando.`;
    case 'trial_vencida':
      return `La prueba de ${String(TRIAL_DAYS)} días terminó el ${fecha(venceEn)}. El sistema está en modo consulta: se puede ver, imprimir y exportar, pero no editar.`;
  }
};

const mensajeLicencia = (
  estado: 'licencia_vigente' | 'licencia_por_vencer' | 'licencia_vencida',
  tipo: LicenseKind,
  diasRestantes: number,
  venceEn: Date,
): string => {
  switch (estado) {
    case 'licencia_vigente':
      return `Licencia ${LICENSE_KIND_LABELS[tipo].toLowerCase()} vigente hasta el ${fecha(venceEn)}.`;
    case 'licencia_por_vencer':
      return `La licencia vence en ${dias(diasRestantes)} (el ${fecha(venceEn)}). Renuévala para no pasar a modo consulta.`;
    case 'licencia_vencida':
      return `La licencia venció el ${fecha(venceEn)}. El sistema está en modo consulta: se puede ver, imprimir y exportar, pero no editar.`;
  }
};

/**
 * Decide el estado de licenciamiento de la instalación. Es **pura**: no toca la
 * base ni el reloj real; todo entra por parámetros para poder probarla con una
 * tabla de fechas (prueba, por vencer, vencida, licencia y reloj atrasado).
 */
export const resolveLicensing = (input: ResolveLicensingInput): LicensingStatus => {
  const { ahora, licencia } = input;
  const finTrial = new Date(input.instaladaEn.getTime() + TRIAL_DAYS * DAY_MS);

  let estado: LicensingEstado;
  let origen: LicensingOrigen;
  let tipo: LicenseKind | null = null;
  let venceEn: Date;
  let diasRestantes: number;

  if (licencia === null) {
    origen = 'trial';
    venceEn = finTrial;
    diasRestantes = diasHasta(finTrial, ahora);
    if (venceEn.getTime() <= ahora.getTime()) {
      estado = 'trial_vencida';
    } else if (diasRestantes <= LICENSE_WARN_DAYS) {
      estado = 'trial_por_vencer';
    } else {
      estado = 'trial';
    }
  } else {
    origen = 'licencia';
    tipo = licencia.tipo;
    venceEn = new Date(licencia.venceEn);
    diasRestantes = diasHasta(venceEn, ahora);
    if (venceEn.getTime() <= ahora.getTime()) {
      estado = 'licencia_vencida';
    } else if (diasRestantes <= LICENSE_WARN_DAYS) {
      estado = 'licencia_por_vencer';
    } else {
      estado = 'licencia_vigente';
    }
  }

  const soloLectura = estado === 'trial_vencida' || estado === 'licencia_vencida';
  const mensaje =
    origen === 'trial'
      ? mensajeTrial(
          estado as 'trial' | 'trial_por_vencer' | 'trial_vencida',
          diasRestantes,
          venceEn,
        )
      : mensajeLicencia(
          estado as 'licencia_vigente' | 'licencia_por_vencer' | 'licencia_vencida',
          tipo as LicenseKind,
          diasRestantes,
          venceEn,
        );

  const tolerancia = (input.toleranciaRelojHoras ?? LICENSE_CLOCK_TOLERANCE_HOURS) * HOUR_MS;
  const relojAtrasado =
    input.ultimaVezVisto !== null && ahora.getTime() + tolerancia < input.ultimaVezVisto.getTime();

  if (relojAtrasado) {
    return {
      estado: 'reloj_atrasado',
      soloLectura: true,
      origen,
      tipo,
      diasRestantes,
      venceEn: venceEn.toISOString(),
      mensaje:
        'El reloj del equipo está atrasado respecto al último uso del sistema. ' +
        'El sistema queda en modo consulta hasta que se corrija la hora.',
    };
  }

  return {
    estado,
    soloLectura,
    origen,
    tipo,
    diasRestantes,
    venceEn: venceEn.toISOString(),
    mensaje,
  };
};

/* ── Vistas de la API (sin secretos) ──────────────────────────────────────── */

/** Lo que publica el gateway/identity **sin sesión**: banner de acceso y del shell. */
export const publicLicensingViewSchema = z.object({
  estado: z.enum(LICENSING_ESTADOS),
  soloLectura: z.boolean(),
  origen: z.enum(['trial', 'licencia']).nullable(),
  tipo: z.enum(LICENSE_KINDS).nullable(),
  diasRestantes: z.number().int().min(0).nullable(),
  venceEn: z.string().nullable(),
  mensaje: z.string(),
});
export type PublicLicensingView = z.infer<typeof publicLicensingViewSchema>;

/** Los datos del contrato de la licencia, para el detalle del administrador. */
export const licensingLicenseViewSchema = z.object({
  id: z.string(),
  tipo: z.enum(LICENSE_KINDS),
  cliente: licenseClientSchema,
  emitidaEn: z.string(),
  venceEn: z.string(),
  activadaEn: z.string().nullable(),
});
export type LicensingLicenseView = z.infer<typeof licensingLicenseViewSchema>;

/**
 * Lo que ve el administrador en `/licencia` (y lo que devuelven las rutas
 * internas que usa el bot del consultorio). Incluye la **solicitud** ya armada:
 * un solo sitio compone el texto que se reenvía al proveedor.
 */
export const adminLicensingViewSchema = publicLicensingViewSchema.extend({
  instalacion: z.uuid(),
  instaladaEn: z.string(),
  ultimaVezVisto: z.string().nullable(),
  licencia: licensingLicenseViewSchema.nullable(),
  consultorio: z.object({
    nombre: z.string(),
    rif: z.string().nullable(),
  }),
  solicitud: z.object({
    /** `ODO-REQ1.…`: el texto que viaja al proveedor. */
    codigo: z.string(),
    /** Mensaje completo, listo para copiar y reenviar. */
    texto: z.string(),
  }),
});
export type AdminLicensingView = z.infer<typeof adminLicensingViewSchema>;

/* ── Código de solicitud (consultorio → proveedor) ────────────────────────── */

const base64Url = (texto: string): string => {
  const bytes = new TextEncoder().encode(texto);
  let binario = '';
  for (const byte of bytes) binario += String.fromCharCode(byte);
  return btoa(binario).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
};

const desdeBase64Url = (valor: string): string => {
  const normalizado = valor.replaceAll('-', '+').replaceAll('_', '/');
  const relleno = '='.repeat((4 - (normalizado.length % 4)) % 4);
  const binario = atob(normalizado + relleno);
  const bytes = Uint8Array.from(binario, (caracter) => caracter.charCodeAt(0));
  return new TextDecoder().decode(bytes);
};

/**
 * Lo que el consultorio manda al proveedor para pedir una licencia. **No está
 * firmado**: es un mensaje comercial, no una credencial. El proveedor verifica
 * los datos y emite el archivo firmado por su lado.
 */
export const licenseRequestSchema = z.object({
  v: z.literal(1),
  instalacion: z.uuid(),
  cliente: licenseClientSchema,
  /** Tipo pedido por el consultorio; el proveedor decide el definitivo. */
  tipoSolicitado: z.enum([...LICENSE_KINDS, 'no_se']).optional(),
  nota: z.string().trim().max(200).optional(),
  generadaEn: z.string().datetime({ offset: true }),
});
export type LicenseRequest = z.infer<typeof licenseRequestSchema>;

/** Convierte una solicitud en el texto `ODO-REQ1.…` que se pega en WhatsApp. */
export const encodeLicenseRequest = (request: LicenseRequest): string =>
  `${LICENSE_REQUEST_PREFIX}${base64Url(JSON.stringify(licenseRequestSchema.parse(request)))}`;

/** Lee un `ODO-REQ1.…`; devuelve `null` si el texto no es una solicitud válida. */
export const decodeLicenseRequest = (texto: string): LicenseRequest | null => {
  const limpio = texto.trim();
  if (!limpio.startsWith(LICENSE_REQUEST_PREFIX)) return null;
  try {
    const json = desdeBase64Url(limpio.slice(LICENSE_REQUEST_PREFIX.length));
    const parsed = licenseRequestSchema.safeParse(JSON.parse(json));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
};

/* ── Permisos en modo consulta ────────────────────────────────────────────── */

export type PermissionAccess = 'read' | 'write';

/**
 * Qué permisos son de **escritura**. Con la licencia vencida solo quedan los de
 * lectura, así que los 9 servicios (que ya comprueban permisos) no necesitan
 * saber nada de licencias. El `Record<Permission, …>` obliga a clasificar cada
 * permiso nuevo en compilación.
 */
export const PERMISSION_ACCESS: Readonly<Record<Permission, PermissionAccess>> = {
  'users:manage': 'write',
  'patients:read': 'read',
  'patients:write': 'write',
  'patients:edit_sensitive': 'write',
  'patients:delete': 'write',
  'scheduling:read': 'read',
  'scheduling:write': 'write',
  'scheduling:notify': 'write',
  'scheduling:overbook': 'write',
  'scheduling:cancel_policy': 'write',
  'scheduling:manage': 'write',
  'screens:manage': 'write',
  'screens:display': 'read',
  'clinical:read': 'read',
  'clinical:write': 'write',
  'odontogram:read': 'read',
  'odontogram:write': 'write',
  'reports:read': 'read',
  'reports:clinical': 'read',
  'billing:read': 'read',
  'billing:write': 'write',
  'billing:collect': 'write',
  'billing:rates': 'write',
  'billing:void': 'write',
  'audit:read': 'read',
  'settings:manage': 'write',
  'licensing:manage': 'write',
};

/**
 * Permisos de escritura que **sí** sobreviven al modo consulta: activar la
 * licencia es justo lo que hay que poder hacer cuando está vencida.
 */
export const PERMISSIONS_ALLOWED_IN_READ_ONLY: readonly Permission[] = ['licensing:manage'];

/** `true` si el permiso sigue disponible con la licencia vencida. */
export const isAllowedInReadOnly = (permission: Permission): boolean =>
  PERMISSION_ACCESS[permission] === 'read' || PERMISSIONS_ALLOWED_IN_READ_ONLY.includes(permission);

/** Filtra una lista de permisos dejando solo los de lectura (+ activar licencia). */
export const readOnlyPermissions = (permissions: readonly Permission[]): readonly Permission[] =>
  permissions.filter(isAllowedInReadOnly);
