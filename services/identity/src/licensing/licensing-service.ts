import {
  LICENSE_KIND_LABELS,
  encodeLicenseRequest,
  licenseClaimsSchema,
  permissionsForRoles,
  readOnlyPermissions,
  resolveLicensing,
  type AdminLicensingView,
  type LicenseClaims,
  type LicenseRequest,
  type LicensingLicenseView,
  type LicensingStatus,
  type Permission,
  type PublicLicensingView,
  type Role,
} from '@odontocrm/contracts';
import { AppError, verifyLicenseToken, type PublicKey } from '@odontocrm/kernel';
import { eq } from 'drizzle-orm';

import { writeAuditEvent } from '../audit/audit-service.js';
import { readEffectiveClinicSummary } from '../clinic/identity-service.js';
import type { IdentityDb } from '../db/client.js';
import { installation, type InstallationRow } from '../db/schema.js';

/**
 * Estado de **licenciamiento offline** de la instalación ([ADR 0075](../../../docs/adr/0075-licenciamiento-offline-y-modo-consulta.md)).
 *
 * Una instalación es un consultorio. El estado vive en la fila única `installation`
 * y se compone con la función **pura** `resolveLicensing` de los contratos, la misma
 * que usan el emisor y las herramientas del consultorio. Aquí solo se leen fechas,
 * se verifica la licencia al activarla y se guarda.
 *
 * Lo importante: con la licencia (o la prueba) vencida **no se toca ningún
 * servicio**. Basta con que el token de acceso salga con menos permisos
 * (`sessionPermissions` filtra con `readOnlyPermissions`): los 9 servicios ya
 * comprueban permisos y responden 403 a las escrituras. La lectura, la impresión y
 * la exportación siguen funcionando.
 */

/** La fila única de la instalación (mismo patrón que `app_settings` o `clinic_profiles`). */
const FILA = 1;

/** Tope del JWT de licencia: es un texto firmado pequeño (~1 KiB); 16 KiB sobra. */
export const MAX_LICENSE_TOKEN_LENGTH = 16_384;

/**
 * Cada cuánto se reescribe `last_seen_at`. No hace falta en cada petición: la
 * detección de atraso tolera horas, así que refrescar el marcador cada cinco
 * minutos evita escribir en cada login o cada carga de la pantalla de acceso.
 */
const LAST_SEEN_UPDATE_MS = 5 * 60_000;

/* ── La fila de la instalación ────────────────────────────────────────────── */

const selectInstallation = async (db: IdentityDb): Promise<InstallationRow | null> => {
  const rows = await db.select().from(installation).where(eq(installation.id, FILA)).limit(1);
  return rows[0] ?? null;
};

/**
 * La fila de la instalación. La siembra la migración; esto solo crea la fila si
 * falta (una base migrada a mano, una carrera entre dos peticiones), con los
 * valores por defecto que arrancan la prueba.
 */
export const readInstallation = async (db: IdentityDb): Promise<InstallationRow> => {
  const existente = await selectInstallation(db);
  if (existente !== null) return existente;

  const creadas = await db
    .insert(installation)
    .values({ id: FILA })
    .onConflictDoNothing()
    .returning();
  const creada = creadas[0];
  if (creada !== undefined) return creada;

  const otra = await selectInstallation(db);
  if (otra !== null) return otra;

  throw new AppError({
    status: 503,
    code: 'installation_unavailable',
    message: 'No se pudo leer la instalación. Revisa que la migración de identity esté aplicada.',
    expose: true,
  });
};

/** Los claims guardados, ya validados; `null` si no hay licencia (está en prueba). */
export const parseStoredLicense = (
  row: Pick<InstallationRow, 'licenseClaims'>,
): LicenseClaims | null => {
  if (row.licenseClaims === null) return null;
  const parsed = licenseClaimsSchema.safeParse(row.licenseClaims);
  return parsed.success ? parsed.data : null;
};

/** La licencia en la forma que ve el administrador, o `null` en prueba. */
export const toLicenseView = (row: InstallationRow): LicensingLicenseView | null => {
  const claims = parseStoredLicense(row);
  if (claims === null) return null;
  return {
    id: claims.lic,
    tipo: claims.tipo,
    cliente: claims.cliente,
    emitidaEn: claims.emitidaEn,
    venceEn: claims.venceEn,
    activadaEn: row.licenseActivatedAt?.toISOString() ?? null,
  };
};

/* ── Estado actual ────────────────────────────────────────────────────────── */

export interface LicensingState {
  row: InstallationRow;
  claims: LicenseClaims | null;
  status: LicensingStatus;
}

/**
 * Lee el estado y **avanza** el marcador anti-atraso (`last_seen_at`): solo hacia
 * adelante y como mucho cada cinco minutos. Si alguien atrasa el reloj para estirar
 * la prueba, el marcador conserva la última hora real y `resolveLicensing` devuelve
 * `reloj_atrasado` (modo consulta).
 */
export const readLicensingState = async (
  db: IdentityDb,
  options: { ahora?: Date } = {},
): Promise<LicensingState> => {
  const ahora = options.ahora ?? new Date();
  const row = await readInstallation(db);
  const claims = parseStoredLicense(row);

  const status = resolveLicensing({
    ahora,
    instaladaEn: row.installedAt,
    ultimaVezVisto: row.lastSeenAt,
    licencia: claims,
  });

  const avance = ahora.getTime() - row.lastSeenAt.getTime();
  if (avance >= LAST_SEEN_UPDATE_MS) {
    await db.update(installation).set({ lastSeenAt: ahora }).where(eq(installation.id, FILA));
  }

  return { row, claims, status };
};

/** Lo que se publica **sin sesión** (banner del login y del shell). */
export const toPublicView = (status: LicensingStatus): PublicLicensingView => ({
  estado: status.estado,
  soloLectura: status.soloLectura,
  origen: status.origen,
  tipo: status.tipo,
  diasRestantes: status.diasRestantes,
  venceEn: status.venceEn,
  mensaje: status.mensaje,
});

/* ── Solicitud de licencia (consultorio → proveedor) ──────────────────────── */

/**
 * Arma el texto y el código `ODO-REQ1.…` que el consultorio le reenvía al
 * proveedor. Es el mismo en la web, en el bot de administración y en la ruta
 * interna: un solo sitio lo compone. **No está firmado**: es un mensaje
 * comercial, no una credencial; el proveedor verifica y emite la licencia.
 */
export const buildLicenseRequest = (
  instalacion: string,
  cliente: { nombre: string; rif: string | null },
  ahora: Date = new Date(),
): { codigo: string; texto: string } => {
  /**
   * El consultorio que todavía no completó su identidad (ADR 0056) no tiene
   * nombre: la solicitud se arma igual con un texto neutro. El proveedor
   * identifica la instalación por el UUID, y sin esto `/licencia` reventaría en
   * una instalación recién creada.
   */
  const nombre = cliente.nombre.trim() === '' ? 'Consultorio sin nombre' : cliente.nombre;
  const rif = cliente.rif === null || cliente.rif.trim() === '' ? '—' : cliente.rif;

  const solicitud: LicenseRequest = {
    v: 1,
    instalacion,
    cliente: {
      nombre,
      ...(rif === '—' ? {} : { rif }),
    },
    tipoSolicitado: 'no_se',
    generadaEn: ahora.toISOString(),
  };

  const codigo = encodeLicenseRequest(solicitud);

  const texto = [
    'Solicitud de licencia de OdontoCRM',
    `Consultorio: ${nombre}`,
    `RIF: ${rif}`,
    `Instalación: ${instalacion}`,
    '',
    'Reenvía este mensaje al proveedor: con el código de abajo emite la licencia.',
    codigo,
  ].join('\n');

  return { codigo, texto };
};

/** La vista completa del administrador (web `/licencia` y rutas internas del bot). */
export const toAdminView = async (
  db: IdentityDb,
  state: LicensingState,
  options: { ahora?: Date } = {},
): Promise<AdminLicensingView> => {
  const ahora = options.ahora ?? new Date();
  const consultorio = await readEffectiveClinicSummary(db);

  return {
    ...toPublicView(state.status),
    instalacion: state.row.installationId,
    instaladaEn: state.row.installedAt.toISOString(),
    ultimaVezVisto: state.row.lastSeenAt.toISOString(),
    licencia: toLicenseView(state.row),
    consultorio: { nombre: consultorio.nombre, rif: consultorio.rif },
    solicitud: buildLicenseRequest(state.row.installationId, consultorio, ahora),
  };
};

/* ── Permisos de la sesión (el «modo consulta») ───────────────────────────── */

/**
 * Los permisos que lleva el token de acceso. En modo consulta se quedan solo los
 * de lectura (+ `licensing:manage`, que es lo que permite activar la licencia).
 * Se usa al emitir **cualquier** token: login, refresco, cambio de contraseña y
 * `/auth/me`.
 */
export const sessionPermissions = async (
  db: IdentityDb,
  roles: readonly Role[],
  options: { ahora?: Date } = {},
): Promise<Permission[]> => {
  const base = permissionsForRoles(roles);
  const { status } = await readLicensingState(db, options);
  return status.soloLectura ? [...readOnlyPermissions(base)] : base;
};

/* ── Activación ───────────────────────────────────────────────────────────── */

export interface ActivationActor {
  actorId?: string | null;
  actorUsername?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  requestId?: string | null;
  /** Cómo se activó («activación desde la web», «bot de administración», …). */
  motivo?: string | null;
}

export interface ActivateLicenseOptions {
  token: string;
  /** Clave pública de licencias; `null` = esta instalación no puede activar. */
  publicKey: PublicKey | null;
  actor?: ActivationActor;
  ahora?: Date;
}

/**
 * Verifica y guarda una licencia. **Solo verifica**: la clave privada nunca está
 * en el consultorio, ni aquí ni en el bot de administración.
 *
 * Rechaza (y audita el rechazo) una licencia con firma inválida, de otra
 * instalación o ya vencida. Activarla es idempotente: volver a pegar la misma
 * licencia solo actualiza fechas.
 */
export const activateLicense = async (
  db: IdentityDb,
  options: ActivateLicenseOptions,
): Promise<AdminLicensingView> => {
  const ahora = options.ahora ?? new Date();
  const row = await readInstallation(db);
  const actor = options.actor ?? {};
  const motivo = actor.motivo ?? 'activación manual';

  const rechazar = async (code: string, message: string, motivoRechazo: string): Promise<never> => {
    await writeAuditEvent(db, {
      action: 'license_activation_rejected',
      entityType: 'license',
      actorId: actor.actorId ?? null,
      actorUsername: actor.actorUsername ?? null,
      ip: actor.ip ?? null,
      userAgent: actor.userAgent ?? null,
      requestId: actor.requestId ?? null,
      reason: `${motivo}: ${motivoRechazo}`,
    });
    throw new AppError({ status: 400, code, message, expose: true });
  };

  if (options.publicKey === null) {
    throw new AppError({
      status: 503,
      code: 'license_key_missing',
      message:
        'Esta instalación no tiene la clave pública de licencias (assets/licencias/licencia-publica.pem): ' +
        'no se puede activar. Avisa al proveedor.',
      expose: true,
    });
  }

  const claims = await verifyLicenseToken(options.token.trim(), options.publicKey);
  if (claims === null) {
    return rechazar(
      'license_invalid',
      'La licencia no es válida: la firma no corresponde o el archivo está dañado.',
      'firma inválida o formato desconocido',
    );
  }

  if (claims.instalacion !== row.installationId) {
    return rechazar(
      'license_installation_mismatch',
      `La licencia pertenece a otra instalación. Este equipo es la instalación ${row.installationId}: pide una licencia emitida para ella.`,
      `la licencia es de la instalación ${claims.instalacion}`,
    );
  }

  if (new Date(claims.venceEn).getTime() <= ahora.getTime()) {
    return rechazar(
      'license_expired',
      `La licencia ya venció (${claims.venceEn}): pide una renovación al proveedor.`,
      `vencida el ${claims.venceEn}`,
    );
  }

  await db
    .update(installation)
    .set({
      licenseToken: options.token.trim(),
      licenseClaims: claims,
      licenseActivatedAt: ahora,
      licenseActivatedBy: actor.actorId ?? null,
      licenseActivationReason: motivo,
      updatedAt: ahora,
    })
    .where(eq(installation.id, FILA));

  await writeAuditEvent(db, {
    action: 'license_activated',
    entityType: 'license',
    entityId: claims.lic,
    summary: `Licencia ${LICENSE_KIND_LABELS[claims.tipo].toLowerCase()} activada hasta el ${claims.venceEn}`,
    actorId: actor.actorId ?? null,
    actorUsername: actor.actorUsername ?? null,
    ip: actor.ip ?? null,
    userAgent: actor.userAgent ?? null,
    requestId: actor.requestId ?? null,
    reason: motivo,
    after: {
      tipo: claims.tipo,
      venceEn: claims.venceEn,
      instalacion: claims.instalacion,
    },
  });

  const estado = await readLicensingState(db, { ahora });
  return toAdminView(db, estado, { ahora });
};
