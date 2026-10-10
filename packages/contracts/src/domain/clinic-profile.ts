import { z } from 'zod';

import { BRAND } from '../brand.js';
import type { ClinicDentist, ClinicIdentity } from '../clinic.js';

/**
 * La **identidad del consultorio** cuando vive en la base de datos (ADR 0056).
 *
 * Hasta ahora el nombre, el RIF, los teléfonos y los odontólogos que firman vivían en
 * el código (`packages/contracts/src/clinic.ts`) y cambiar el consultorio exigía
 * recompilar. Con el onboarding, el **titular** los escribe la primera vez que entra y
 * a partir de ahí la base manda; `clinic.ts` queda como **respaldo neutro** (sin datos
 * personales) para cuando todavía no hay perfil guardado —una instalación recién
 * migrada—, y en ese caso los servicios difieren el `.ics` y los avisos.
 *
 * Aquí no vive nada de la **marca** (paleta, tipografías, medidas del membrete): eso
 * sigue siendo solo-código (`brand.ts`), como el logo por defecto del repositorio.
 */

/**
 * Perfil **profesional** de un odontólogo: lo que firma sus documentos. No lleva el
 * nombre —ese es el del usuario (`users.full_name`), que el administrador ya define al
 * crear la cuenta— ni su usuario.
 */
export const dentistProfileSchema = z.object({
  /** Número de MPPS: **obligatorio** en el récipe. */
  mpps: z.string().trim().min(1, 'El MPPS es obligatorio en el récipe').max(40),
  /** Especialidad que se imprime bajo el nombre. */
  specialty: z.string().trim().min(1, 'Indica la especialidad').max(80),
  /** Colegiatura o cédula profesional, si el consultorio la usa. */
  licenseNumber: z.string().trim().max(60).nullable().default(null),
  /** Correo del odontólogo para el membrete, si se quiere. */
  contactEmail: z
    .union([z.email(), z.literal('')])
    .nullable()
    .default(null),
});

export type DentistProfile = z.infer<typeof dentistProfileSchema>;

/** Datos del consultorio que alimentan el membrete de todos los imprimibles. */
export const clinicProfileSchema = z.object({
  /** Nombre visible: membrete, bot y pantallas de sala. */
  name: z.string().trim().min(1, 'Escribe el nombre del consultorio').max(120),
  /** Razón social o nombre del propietario, si el documento lo lleva aparte. */
  legalName: z.string().trim().max(160).nullable().default(null),
  /** Dirección en una línea. */
  address: z.string().trim().min(1, 'Escribe la dirección').max(200),
  /** Ciudad y estado, si se quieren aparte de la dirección. */
  city: z.string().trim().max(80).nullable().default(null),
  /** Teléfonos tal como deben leerse en el papel. */
  phones: z.array(z.string().trim().min(1).max(40)).max(6).default([]),
  email: z
    .union([z.email(), z.literal('')])
    .nullable()
    .default(null),
  /** RIF, con o sin guiones («J-12345678-9»). */
  rif: z.string().trim().max(20).nullable().default(null),
  website: z.string().trim().max(160).nullable().default(null),
});

export type ClinicProfile = z.infer<typeof clinicProfileSchema>;

/**
 * Completar el perfil en el **primer acceso**.
 *
 * El **titular** (el primer odontólogo creado) llena también los datos del
 * consultorio; los demás odontólogos solo envían `dentist`. El servidor decide si se
 * acepta `clinic` según quién entra: no basta con que el cliente lo mande.
 */
export const completeOnboardingSchema = z.object({
  dentist: dentistProfileSchema,
  /** Solo el titular: los datos del consultorio. Los demás lo omiten. */
  clinic: clinicProfileSchema.optional(),
});

export type CompleteOnboardingInput = z.infer<typeof completeOnboardingSchema>;

/**
 * Editar un perfil ya existente. El **motivo es obligatorio** (`reason`): cada cambio
 * de identidad queda auditado con su justificación, igual que los usuarios y los
 * pacientes. La **creación** (onboarding) no lo pide: es un alta, no un cambio.
 */
export const updateDentistProfileSchema = dentistProfileSchema.extend({
  reason: z.string().trim().min(3, 'Indica el motivo del cambio').max(300),
});

export type UpdateDentistProfileInput = z.infer<typeof updateDentistProfileSchema>;

export const updateClinicProfileSchema = clinicProfileSchema.extend({
  reason: z.string().trim().min(3, 'Indica el motivo del cambio').max(300),
});

export type UpdateClinicProfileInput = z.infer<typeof updateClinicProfileSchema>;

/** Un odontólogo con su usuario y su nombre, como lo devuelve el API público. */
export const dentistViewSchema = dentistProfileSchema.extend({
  /** Id del usuario en identity: la agenda guarda `dentist_id` con este valor. */
  id: z.uuid(),
  username: z.string(),
  fullName: z.string(),
});

export type DentistView = z.infer<typeof dentistViewSchema>;

/**
 * La identidad **efectiva** que ve la interfaz: el perfil guardado o, si aún no hay,
 * el respaldo del código (`CLINIC`). `fromDatabase` distingue las dos situaciones para
 * que la pantalla pueda avisar de que falta completarla.
 */
export const clinicIdentityViewSchema = z.object({
  clinic: clinicProfileSchema,
  dentists: z.array(dentistViewSchema),
  /** El usuario del **titular** (el que llena el consultorio): `null` si aún no hay. */
  titularUsername: z.string().nullable(),
  /** El logo efectivo como `data:` URI, listo para pintar (`null` si no hay ninguno). */
  logoDataUri: z.string().nullable(),
  /** `false` mientras el membrete siga saliendo del respaldo del código. */
  fromDatabase: z.boolean(),
});

export type ClinicIdentityView = z.infer<typeof clinicIdentityViewSchema>;

/**
 * Un odontólogo en la forma del contrato `ClinicDentist` (la que ya usan las
 * plantillas y `letterheadMissingFields`): el que firma, con su usuario y su nombre.
 */
export const clinicDentistSchema = z.object({
  username: z.string(),
  fullName: z.string(),
  mpps: z.string().nullable(),
  specialty: z.string().nullable(),
  licenseNumber: z.string().nullable(),
  email: z.string().nullable(),
});

/**
 * La identidad del consultorio en la forma de `ClinicIdentity`. Se declara aquí (y no
 * en `clinic.ts`, que es dato puro sin zod) para poder **validar** lo que devuelve la
 * ruta interna y lo que consume la interfaz.
 */
export const clinicIdentitySchema = z.object({
  name: z.string(),
  legalName: z.string().nullable(),
  address: z.string(),
  city: z.string().nullable(),
  phones: z.array(z.string()),
  email: z.string().nullable(),
  rif: z.string().nullable(),
  website: z.string().nullable(),
  logoPath: z.string().nullable(),
  dentists: z.array(clinicDentistSchema),
});

/**
 * Lo que devuelve la ruta **interna** a los servicios que componen documentos: la
 * identidad en la forma de `ClinicIdentity` (para reutilizar `clinicFullAddress`,
 * `clinicContactLine`, `letterheadMissingFields`…) más el **logo ya resuelto** como
 * `data:` URI.
 *
 * El logo viaja incrustado —y no como ruta— por la misma razón que en los PDF: el
 * documento se archiva y no puede depender de rutas. Y es el logo **efectivo**: el
 * subido por el consultorio o, si no hay, el del repositorio.
 */
export const letterheadSchema = z.object({
  clinic: clinicIdentitySchema,
  /** El odontólogo que firma, ya resuelto (o `null` si no hay ninguno con perfil). */
  dentist: clinicDentistSchema.nullable(),
  /** Logo efectivo como `data:` URI, o `null` si no hay ninguno. */
  logoDataUri: z.string().nullable(),
  /** Versión (máx. `updated_at`): los consumidores la usan para invalidar su caché. */
  version: z.string(),
});

export type LetterheadSnapshot = z.infer<typeof letterheadSchema>;

/**
 * Comprueba, en tiempo de compilación, que el esquema describe exactamente
 * `ClinicIdentity`: si alguien añade un campo al contrato y no aquí, esto no compila.
 */
const _identidadCubreElContrato = (snapshot: LetterheadSnapshot): ClinicIdentity => snapshot.clinic;
void _identidadCubreElContrato;

/**
 * La identidad efectiva que ve la interfaz (`ClinicIdentityView`) en la forma del
 * contrato `ClinicIdentity`, para reutilizar los ayudantes del membrete
 * (`clinicFullAddress`, `clinicContactLine`, **`letterheadMissingFields`**…).
 *
 * Compone lo mismo que el servidor para un imprimible (`letterheadSnapshot`): el perfil
 * guardado o, si no hay ninguno, el respaldo **neutro** del código (`CLINIC`, ya sin
 * datos personales). Cuando no hay odontólogos con perfil, la lista sale **vacía**: ya no
 * se rellena con el odontólogo de prueba del código, que solo existe para el seed.
 *
 * El **logo** es lo único que no viaja igual: la vista trae el `data:` URI ya resuelto
 * y aquí solo importa *si hay* logo, así que se deja `BRAND.logoPath` (una ruta del
 * repositorio, nunca una del servidor) como señal cuando existe y `null` cuando no.
 */
export const clinicIdentityFromView = (view: ClinicIdentityView): ClinicIdentity => {
  // `DentistView` llama `contactEmail` al correo del odontólogo; el contrato lo llama `email`.
  const dentists: readonly ClinicDentist[] = view.dentists.map((dentist) => ({
    username: dentist.username,
    fullName: dentist.fullName,
    mpps: dentist.mpps,
    specialty: dentist.specialty,
    licenseNumber: dentist.licenseNumber,
    email: dentist.contactEmail,
  }));

  return {
    name: view.clinic.name,
    legalName: view.clinic.legalName,
    address: view.clinic.address,
    city: view.clinic.city,
    phones: [...view.clinic.phones],
    email: view.clinic.email,
    rif: view.clinic.rif,
    website: view.clinic.website,
    logoPath: view.logoDataUri === null ? null : BRAND.logoPath,
    dentists,
  };
};
