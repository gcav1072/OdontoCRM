/**
 * Forma de los datos del consultorio y **valores neutros de arranque**.
 *
 * La identidad real (nombre, dirección, teléfonos, RIF, logo y odontólogos que
 * firman) **no vive aquí**: el odontólogo titular la completa en su primer acceso y
 * se guarda en la base (`clinic_profiles`, ADR 0056). Este archivo solo declara el
 * **tipo** (`ClinicIdentity`/`ClinicDentist`), los **ayudantes** que la leen y un
 * `CLINIC` de relleno **sin datos personales**, que sirve únicamente para dos cosas:
 *
 *  - el **seed** de cuentas crea un odontólogo por cada entrada de `CLINIC.dentists`
 *    (hoy, «Odontólogo prueba»): es personal de prueba, no del consultorio;
 *  - el **respaldo** cuando la base todavía no tiene identidad: los campos van vacíos
 *    o en `null`, así que **nada se imprime** y `clinicContactReady` avisa de que aún
 *    no hay datos del consultorio con los que componer un documento o un aviso.
 *
 * No hay atajos por entorno: las variables `CLINIC_NAME`, `CLINIC_ADDRESS` y
 * `CLINIC_EMAIL` **se eliminaron**. La identidad del consultorio se sirve **solo**
 * desde el registro del titular; lo que falte se deja en `null` y **no se imprime**,
 * y el membrete avisa de lo que falta en vez de inventarlo (`letterheadMissingFields`).
 */

/** Quién firma los documentos del consultorio. */
export interface ClinicDentist {
  /** Usuario con el que entra al sistema: `npm run seed:users` crea una cuenta por odontólogo. */
  username: string;
  /** Nombre como debe salir impreso («Od. Nombre Apellido»). */
  fullName: string;
  /** Número de MPPS (Ministerio del Poder Popular para la Salud). Obligatorio en el récipe. */
  mpps: string | null;
  /** Especialidad que se imprime bajo el nombre («Odontología general», «Endodoncia»…). */
  specialty: string | null;
  /** Colegiatura o cédula profesional, si el consultorio la usa. */
  licenseNumber: string | null;
  /** Correo del odontólogo, si se quiere en el membrete. */
  email: string | null;
}

/** Identidad y datos de contacto del consultorio. */
export interface ClinicIdentity {
  /** Nombre visible: bot, pantallas y encabezado del récipe. */
  name: string;
  /** Razón social o nombre del propietario, si el récipe lo lleva aparte. */
  legalName: string | null;
  /** Dirección (una línea). */
  address: string;
  /** Ciudad y estado, si se quieren aparte de la dirección. */
  city: string | null;
  /** Teléfonos que se imprimen en el membrete, tal como deben leerse. */
  phones: readonly string[];
  email: string | null;
  /** RIF del consultorio, con o sin guiones («J-12345678-9»). */
  rif: string | null;
  website: string | null;
  /**
   * Logo del membrete: ruta **relativa a la raíz del repositorio**
   * (`assets/clinic/logo.svg`). Si el archivo no existe, el membrete sale sin logo.
   */
  logoPath: string | null;
  /** Odontólogos del consultorio; el primero es el titular. */
  dentists: readonly ClinicDentist[];
}

/* ══════════════════════════════════════════════════════════════════════════════
   ▼▼▼  VALORES NEUTROS DE ARRANQUE  ▼▼▼  Sin datos personales: no editar aquí.
   ══════════════════════════════════════════════════════════════════════════════ */

export const CLINIC: ClinicIdentity = {
  name: '',
  legalName: null,
  address: '',
  city: null,
  phones: [],
  email: null,
  rif: null,
  website: null,
  // Logo por defecto de la instalación; si el consultorio sube uno, ese manda.
  // La paleta y las tipografías del membrete viven en `brand.ts`.
  logoPath: 'assets/clinic/logo.svg',

  dentists: [
    {
      username: 'prueba',
      fullName: 'Odontólogo prueba',
      mpps: null,
      specialty: null,
      licenseNumber: null,
      email: null,
    },
  ],
};

/* ══════════════════════════════════════════════════════════════════════════════
   ▲▲▲  FIN DE LA SECCIÓN EDITABLE  ▲▲▲  Debajo solo hay ayudas de lectura.
   ══════════════════════════════════════════════════════════════════════════════ */

/** Dirección completa en una línea: «…, Planta Baja, Local 1-2, Ciudad». */
export const clinicFullAddress = (clinic: ClinicIdentity = CLINIC): string =>
  clinic.city === null ? clinic.address : `${clinic.address}, ${clinic.city}`;

/**
 * ¿Hay datos de consultorio suficientes para componer un documento o un aviso?
 *
 * Se exige **nombre y dirección** (lo que aparece en el membrete, el `.ics` y el texto
 * del aviso). Mientras falte, los servicios que los necesitan **no inventan nada**:
 * difieren la generación del `.ics` y el envío del aviso hasta que el titular complete
 * el consultorio en su primer acceso.
 */
export const clinicContactReady = (clinic: ClinicIdentity = CLINIC): boolean =>
  clinic.name.trim() !== '' && clinic.address.trim() !== '';

/** Teléfonos y correo en una línea, sin repetir el que falte. */
export const clinicContactLine = (clinic: ClinicIdentity = CLINIC): string =>
  [...clinic.phones, ...(clinic.email === null ? [] : [clinic.email])].join(' · ');

/** Odontólogo titular (el primero de la lista), o `null` si no hay ninguno. */
export const clinicLeadDentist = (clinic: ClinicIdentity = CLINIC): ClinicDentist | null =>
  clinic.dentists[0] ?? null;

/**
 * Odontólogo que corresponde a un usuario del sistema: es el que firma el récipe
 * cuando lo emite él. Si el usuario no está en la lista (una secretaria, un admin,
 * un usuario nuevo) se devuelve el titular, que es quien responde por el consultorio.
 */
export const clinicDentistFor = (
  username: string | null | undefined,
  clinic: ClinicIdentity = CLINIC,
): ClinicDentist | null => {
  const propio = clinic.dentists.find((dentist) => dentist.username === username);
  return propio ?? clinicLeadDentist(clinic);
};

/**
 * La línea del **especialista que emite** un imprimible, como se lee en el membrete,
 * debajo de la dirección y el teléfono: «Od. María Gómez · Endodoncia · MPPS 12345 ·
 * Colegiatura 6789».
 *
 * El nombre va primero porque es quien firma; la especialidad, el MPPS y la colegiatura
 * son el respaldo legal y salen **solo si están llenos** (nada se imprime en blanco).
 * El prefijo «MPPS » no se repite si el número ya lo trae («MPPS 12345»), y la
 * colegiatura se rotula para que no se confunda con el MPPS. Sin odontólogo devuelve
 * cadena vacía y el membrete no añade línea.
 */
export const clinicDentistLine = (dentist: ClinicDentist | null): string => {
  if (dentist === null) return '';
  const mpps = dentist.mpps?.trim() ?? '';
  const colegiatura = dentist.licenseNumber?.trim() ?? '';
  return [
    dentist.fullName.trim(),
    dentist.specialty?.trim() ?? '',
    mpps === '' ? '' : /^mpps\b/i.test(mpps) ? mpps : `MPPS ${mpps}`,
    colegiatura === '' ? '' : `Colegiatura ${colegiatura}`,
  ]
    .filter((parte) => parte !== '')
    .join(' · ');
};

/** Etiquetas de lo que le falta al membrete para salir completo, en orden de importancia. */
export const letterheadMissingFields = (clinic: ClinicIdentity = CLINIC): string[] => {
  const faltantes: string[] = [];
  if (clinic.name.trim() === '') faltantes.push('nombre del consultorio');
  if (clinic.address.trim() === '') faltantes.push('dirección');
  if (clinic.rif === null) faltantes.push('RIF');
  if (clinic.phones.length === 0) faltantes.push('teléfono');
  if (clinic.logoPath === null) faltantes.push('logo');

  const titular = clinicLeadDentist(clinic);
  if (titular === null) faltantes.push('odontólogo');
  else {
    if (titular.mpps === null) faltantes.push('MPPS del odontólogo');
    if (titular.specialty === null) faltantes.push('especialidad del odontólogo');
  }

  return faltantes;
};
