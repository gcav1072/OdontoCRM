import {
  BRAND,
  CLINIC,
  clinicDentistFor,
  type ClinicDentist,
  type ClinicIdentityView,
  type ClinicProfile,
  type CompleteOnboardingInput,
  type DentistProfile,
  type DentistView,
  type LetterheadSnapshot,
  type UpdateClinicProfileInput,
  type UpdateDentistProfileInput,
} from '@odontocrm/contracts';
import { NotFoundError, readImageDataUri } from '@odontocrm/kernel';
import type { BlobStore } from '@odontocrm/storage';
import { and, asc, eq } from 'drizzle-orm';

import type { IdentityDb } from '../db/client.js';
import { clinicProfiles, dentistProfiles, userRoles, users } from '../db/schema.js';

/**
 * La identidad del consultorio en la base de datos (ADR 0056).
 *
 * `clinic.ts` dejó de ser el único sitio de la identidad: el **titular** la completa en
 * su primer acceso y a partir de ahí **la base manda**. `CLINIC` (el código) queda como
 * **semilla y respaldo**: si no hay fila —una instalación recién migrada, la base
 * caída—, el membrete sigue saliendo con esos valores, así que nada se rompe.
 *
 * Este módulo es el único que sabe leer/escribir esas dos tablas y el que resuelve la
 * identidad **efectiva** (una sola vez, para todos los que la pidan).
 */

/** El único rol que necesita perfil profesional: es el que firma documentos. */
const ROL_ODONTOLOGO = 'odontologo';

/** Prefijo del logo en el almacén compartido: `identity/clinic/logo.svg`. */
const LOGO_KEY = 'identity/clinic/logo.svg';

/* ──────────────────────────────────────────────────────────────────────────
   Lectura
   ────────────────────────────────────────────────────────────────────────── */

const readClinicRow = async (db: IdentityDb) => {
  const rows = await db.select().from(clinicProfiles).where(eq(clinicProfiles.id, 1)).limit(1);
  return rows[0] ?? null;
};

/** El perfil profesional de un usuario, o `null` si aún no lo completó. */
export const readDentistProfile = async (db: IdentityDb, userId: string) => {
  const rows = await db
    .select()
    .from(dentistProfiles)
    .where(eq(dentistProfiles.userId, userId))
    .limit(1);
  return rows[0] ?? null;
};

/** Usuarios con rol odontólogo **con** perfil, en orden de antigüedad. */
const listDentistRows = async (db: IdentityDb) =>
  db
    .select({
      username: users.username,
      fullName: users.fullName,
      mpps: dentistProfiles.mpps,
      specialty: dentistProfiles.specialty,
      licenseNumber: dentistProfiles.licenseNumber,
      contactEmail: dentistProfiles.contactEmail,
      completedAt: dentistProfiles.completedAt,
    })
    .from(users)
    .innerJoin(userRoles, eq(userRoles.userId, users.id))
    .innerJoin(dentistProfiles, eq(dentistProfiles.userId, users.id))
    .where(and(eq(userRoles.role, ROL_ODONTOLOGO), eq(users.isActive, true)))
    .orderBy(asc(users.createdAt), asc(users.username));

/**
 * El **titular**: el primer usuario con rol odontólogo, aunque todavía no haya
 * completado su perfil. Es quien llena los datos del consultorio y quien firma por
 * defecto cuando emite un documento alguien que no está en la lista.
 */
export const findTitular = async (db: IdentityDb) => {
  const rows = await db
    .select({ id: users.id, username: users.username, fullName: users.fullName })
    .from(users)
    .innerJoin(userRoles, eq(userRoles.userId, users.id))
    .where(and(eq(userRoles.role, ROL_ODONTOLOGO), eq(users.isActive, true)))
    .orderBy(asc(users.createdAt), asc(users.username))
    .limit(1);
  return rows[0] ?? null;
};

/** ¿Este usuario es el titular? (decisión de quién llena el consultorio). */
export const isTitular = async (db: IdentityDb, userId: string): Promise<boolean> => {
  const titular = await findTitular(db);
  return titular !== null && titular.id === userId;
};

/**
 * ¿Le falta el perfil? Solo a un odontólogo sin `dentist_profiles.completed_at`.
 * Es el gate del primer acceso: mientras sea `true`, el usuario no tiene permisos.
 */
export const needsDentistProfile = async (
  db: IdentityDb,
  userId: string,
  roles: readonly string[],
): Promise<boolean> => {
  if (!roles.includes(ROL_ODONTOLOGO)) return false;
  const perfil = await readDentistProfile(db, userId);
  return perfil === null || perfil.completedAt === null;
};

/* ──────────────────────────────────────────────────────────────────────────
   Identidad efectiva (base → respaldo del código)
   ────────────────────────────────────────────────────────────────────────── */

/** El perfil del consultorio en la forma del contrato, con `CLINIC` de respaldo. */
const effectiveClinicProfile = (row: Awaited<ReturnType<typeof readClinicRow>>): ClinicProfile =>
  row === null
    ? {
        name: CLINIC.name,
        legalName: CLINIC.legalName,
        address: CLINIC.address,
        city: CLINIC.city,
        phones: [...CLINIC.phones],
        email: CLINIC.email,
        rif: CLINIC.rif,
        website: CLINIC.website,
      }
    : {
        name: row.name,
        legalName: row.legalName,
        address: row.address,
        city: row.city,
        phones: row.phones,
        email: row.email,
        rif: row.rif,
        website: row.website,
      };

/** Los odontólogos con perfil; si no hay ninguno, los del código (respaldo). */
const effectiveDentists = (
  rows: Awaited<ReturnType<typeof listDentistRows>>,
): readonly ClinicDentist[] =>
  rows.length === 0
    ? CLINIC.dentists
    : rows.map((row) => ({
        username: row.username,
        fullName: row.fullName,
        mpps: row.mpps,
        specialty: row.specialty,
        licenseNumber: row.licenseNumber,
        email: row.contactEmail,
      }));

const toDentistView = (row: Awaited<ReturnType<typeof listDentistRows>>[number]): DentistView => ({
  username: row.username,
  fullName: row.fullName,
  mpps: row.mpps,
  specialty: row.specialty,
  licenseNumber: row.licenseNumber,
  contactEmail: row.contactEmail,
});

/**
 * La identidad **efectiva** para la interfaz: lo guardado o, si aún no hay, el
 * respaldo del código. `fromDatabase` dice cuál de las dos es; `logoDataUri` trae el
 * logo ya listo para pintar (el subido o el del repositorio).
 */
export const resolveEffectiveIdentity = async (
  db: IdentityDb,
  blobStore: BlobStore | null,
): Promise<ClinicIdentityView> => {
  const [clinicRow, dentistRows, titular, logoDataUri] = await Promise.all([
    readClinicRow(db),
    listDentistRows(db),
    findTitular(db),
    effectiveLogoDataUri(db, blobStore),
  ]);

  return {
    clinic: effectiveClinicProfile(clinicRow),
    dentists: dentistRows.map(toDentistView),
    titularUsername: titular?.username ?? null,
    logoDataUri,
    fromDatabase: clinicRow !== null,
  };
};

/* ──────────────────────────────────────────────────────────────────────────
   Logo (almacén compartido)
   ────────────────────────────────────────────────────────────────────────── */

const bufferABase64 = (buffer: Buffer, mime: string): string =>
  `data:${mime};base64,${buffer.toString('base64')}`;

/**
 * El logo **efectivo** como `data:` URI: el subido por el consultorio o, si no hay,
 * el del repositorio (`BRAND.logoPath`). Devuelve `null` si no hay ninguno: el
 * documento sale sin logo, no roto.
 *
 * El logo subido viaja ya como `data:` URI —y no como URL— porque los PDF se archivan
 * y no pueden depender de rutas ni de que la base esté arriba al reabrirlos.
 */
export const effectiveLogoDataUri = async (
  db: IdentityDb,
  blobStore: BlobStore | null,
): Promise<string | null> => {
  const row = await readClinicRow(db);
  if (row?.logoBlobKey != null && blobStore !== null) {
    try {
      const buffer = await blobStore.read(row.logoBlobKey);
      return bufferABase64(buffer, row.logoMime ?? 'image/svg+xml');
    } catch {
      // Si el archivo no se puede leer (almacén movido, clave distinta), se cae al
      // logo del repositorio en vez de dejar el membrete sin nada.
    }
  }
  return readRepositoryLogoDataUri();
};

/** El logo del repositorio (`BRAND.logoPath`), como `data:` URI, o `null`. */
const readRepositoryLogoDataUri = async (): Promise<string | null> => {
  try {
    return await readImageDataUri(BRAND.logoPath);
  } catch {
    return null;
  }
};

/** Guarda el logo subido (SVG) en el almacén y devuelve su clave. */
export const saveClinicLogo = async (
  db: IdentityDb,
  blobStore: BlobStore,
  file: { data: Buffer; originalName: string; mime: string },
): Promise<string> => {
  const { path } = await blobStore.save({ key: LOGO_KEY, data: file.data });
  await db
    .update(clinicProfiles)
    .set({ logoBlobKey: path, logoMime: file.mime, updatedAt: new Date() })
    .where(eq(clinicProfiles.id, 1));
  return path;
};

/** El logo subido para servirlo por HTTP, o `null` si el consultorio no ha subido uno. */
export const readStoredLogo = async (
  db: IdentityDb,
  blobStore: BlobStore,
): Promise<{ data: Buffer; mime: string } | null> => {
  const row = await readClinicRow(db);
  if (row?.logoBlobKey == null) return null;
  try {
    return { data: await blobStore.read(row.logoBlobKey), mime: row.logoMime ?? 'image/svg+xml' };
  } catch {
    return null;
  }
};

/* ──────────────────────────────────────────────────────────────────────────
   La instantánea del membrete (ruta interna)
   ────────────────────────────────────────────────────────────────────────── */

/**
 * Todo lo que un servicio necesita para componer un membrete: la identidad en la forma
 * de `ClinicIdentity`, **el odontólogo que firma ya resuelto** y el logo incrustado.
 *
 * Se resuelve aquí, en identity, y no en cada servicio: así la regla «quién firma» y el
 * respaldo viven en un solo sitio, y los consumidores solo pintan.
 */
export const letterheadSnapshot = async (
  db: IdentityDb,
  blobStore: BlobStore | null,
  username: string | null,
): Promise<LetterheadSnapshot> => {
  const [clinicRow, dentistRows, logoDataUri] = await Promise.all([
    readClinicRow(db),
    listDentistRows(db),
    effectiveLogoDataUri(db, blobStore),
  ]);

  const dentists = effectiveDentists(dentistRows);
  const perfil = effectiveClinicProfile(clinicRow);
  // Copias mutables: el esquema de la instantánea (contrato) no es `readonly`. La
  // forma sigue siendo la de `ClinicIdentity`, que es lo que consumen las plantillas.
  const clinic = {
    ...perfil,
    phones: [...perfil.phones],
    dentists: dentists.map((dentist) => ({ ...dentist })),
    // El logo va incrustado aparte (`logoDataUri`); `logoPath` se deja como señal de
    // «hay logo» para `letterheadMissingFields`, sin exponer una ruta del servidor.
    logoPath: logoDataUri === null ? null : (clinicRow?.logoBlobKey ?? BRAND.logoPath),
  };

  const version = identityVersion(clinicRow);

  return {
    clinic,
    dentist: clinicDentistFor(username, clinic),
    logoDataUri,
    version,
  };
};

/** El más reciente `updated_at` de la identidad, para invalidar cachés de los consumidores. */
const identityVersion = (clinicRow: Awaited<ReturnType<typeof readClinicRow>>): string =>
  clinicRow === null ? 'seed' : clinicRow.updatedAt.toISOString();

/* ──────────────────────────────────────────────────────────────────────────
   Escritura
   ────────────────────────────────────────────────────────────────────────── */

const clinicProfileFromInput = (input: ClinicProfile) => ({
  name: input.name,
  legalName: input.legalName,
  address: input.address,
  city: input.city,
  phones: [...input.phones],
  email: input.email === '' ? null : input.email,
  rif: input.rif,
  website: input.website,
  updatedAt: new Date(),
});

/** Crea o actualiza la fila única del consultorio. */
export const upsertClinicProfile = async (
  db: IdentityDb,
  input: ClinicProfile,
  options: { completed: boolean },
): Promise<void> => {
  const valores = clinicProfileFromInput(input);
  const existing = await readClinicRow(db);

  if (existing === null) {
    await db.insert(clinicProfiles).values({
      id: 1,
      ...valores,
      completedAt: options.completed ? new Date() : null,
    });
    return;
  }

  await db
    .update(clinicProfiles)
    .set({
      ...valores,
      completedAt: existing.completedAt ?? (options.completed ? new Date() : null),
    })
    .where(eq(clinicProfiles.id, 1));
};

/** Crea o actualiza el perfil profesional de un odontólogo. */
export const upsertDentistProfile = async (
  db: IdentityDb,
  userId: string,
  input: DentistProfile,
  options: { completed: boolean },
): Promise<void> => {
  const valores = {
    mpps: input.mpps,
    specialty: input.specialty,
    licenseNumber: input.licenseNumber,
    contactEmail: input.contactEmail === '' ? null : input.contactEmail,
    updatedAt: new Date(),
  };
  const existing = await readDentistProfile(db, userId);

  if (existing === null) {
    await db.insert(dentistProfiles).values({
      userId,
      ...valores,
      completedAt: options.completed ? new Date() : null,
    });
    return;
  }

  await db
    .update(dentistProfiles)
    .set({
      ...valores,
      completedAt: existing.completedAt ?? (options.completed ? new Date() : null),
    })
    .where(eq(dentistProfiles.userId, userId));
};

/** El perfil de un odontólogo por usuario, con su nombre, para la edición del admin. */
export const getDentistProfileForUser = async (
  db: IdentityDb,
  userId: string,
): Promise<DentistProfile | null> => {
  const row = await readDentistProfile(db, userId);
  if (row === null) return null;
  return {
    mpps: row.mpps,
    specialty: row.specialty,
    licenseNumber: row.licenseNumber,
    contactEmail: row.contactEmail,
  };
};

/** El perfil del consultorio guardado (o `null` si aún no lo completó el titular). */
export const getStoredClinicProfile = async (db: IdentityDb): Promise<ClinicProfile | null> => {
  const row = await readClinicRow(db);
  return row === null ? null : effectiveClinicProfile(row);
};

/** Completar el perfil en el primer acceso: el titular manda también los datos del consultorio. */
export const completeOnboarding = async (
  db: IdentityDb,
  userId: string,
  input: CompleteOnboardingInput,
  options: { isTitular: boolean },
): Promise<void> => {
  if (options.isTitular && input.clinic !== undefined) {
    await upsertClinicProfile(db, input.clinic, { completed: true });
  }
  await upsertDentistProfile(db, userId, input.dentist, { completed: true });
};

/**
 * Actualiza el perfil de un odontólogo. Si el cambio es del **titular** y trae datos del
 * consultorio, estos se guardan también. Devuelve lo que cambió para la auditoría.
 */
export const updateDentistProfile = async (
  db: IdentityDb,
  userId: string,
  input: UpdateDentistProfileInput,
  options: { clinic?: Omit<UpdateClinicProfileInput, 'reason'> | undefined },
): Promise<void> => {
  const perfil = await readDentistProfile(db, userId);
  if (perfil === null) throw new NotFoundError('El perfil del odontólogo no existe');

  await upsertDentistProfile(db, userId, input, { completed: true });
  if (options.clinic !== undefined) {
    await upsertClinicProfile(db, options.clinic, { completed: true });
  }
};
