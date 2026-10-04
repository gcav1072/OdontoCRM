/**
 * Datos del consultorio: **el único archivo que hay que editar para poner este
 * sistema con otro odontólogo**.
 *
 * Aquí viven el nombre, la dirección, los teléfonos, el RIF, el logo y los
 * odontólogos que firman (con su MPPS y su especialidad). Los leen los ocho
 * servicios y la interfaz: el aviso de la cita del bot, la voz y el membrete de
 * las pantallas, el récipe A5 y la página pública de verificación.
 *
 * **¿Por qué aquí y no en otro sitio?** Porque no hay que mover cableado:
 *  - todos los servicios y la web **ya** importan `@odontocrm/contracts`, así que
 *    leerlo es un `import` que existe; no añade rutas, ni endpoints, ni migración,
 *    ni pantalla de ajustes;
 *  - un `.env` por servicio obligaría a repetir el mismo dato en tres archivos
 *    (agenda, notificaciones y pantallas ya lo hacían) y a reiniciar para cambiarlo;
 *  - una tabla de ajustes traería consultas, permisos y pantalla para un dato que
 *    cambia una vez cada varios años.
 *
 * Cambiar algo aquí exige recompilar (`npm run build`), que es justo lo que se hace
 * al desplegar. Si una instalación concreta necesita otro valor **sin** tocar el
 * código, las variables `CLINIC_NAME`, `CLINIC_ADDRESS` y `CLINIC_EMAIL` del `.env`
 * siguen mandando sobre estos valores por defecto (y quedan documentadas en
 * `.env.example`).
 *
 * Lo que falte se deja en `null` y **no se imprime**: un récipe sin MPPS es un
 * récipe incompleto, así que el membrete avisa de lo que falta en vez de inventarlo
 * (`letterheadMissingFields`).
 */

/** Quién firma los documentos del consultorio. */
export interface ClinicDentist {
  /** Usuario con el que entra al sistema: `npm run seed:users` crea una cuenta por odontólogo. */
  username: string;
  /** Nombre como debe salir impreso («Od. Erika Gómez»). */
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
   * (`assets/clinic/logo.png`). Si el archivo no existe, el membrete sale sin logo.
   */
  logoPath: string | null;
  /** Odontólogos del consultorio; el primero es el titular. */
  dentists: readonly ClinicDentist[];
}

/* ══════════════════════════════════════════════════════════════════════════════
   ▼▼▼  EDITA AQUÍ  ▼▼▼   Lo que esté en `null` no se imprime.
   ══════════════════════════════════════════════════════════════════════════════ */

export const CLINIC: ClinicIdentity = {
  name: 'Consultorio - Od. Erika Gómez',
  legalName: null,
  address: 'Av. Luis del Valle García, C.E. Nueva Esparta, Planta Baja, Local 1-2',
  city: null,
  // Teléfonos como se leen en el papel. Ejemplo: ['(+58) 281 123 45 67', '0414-1234567']
  phones: [],
  email: 'citas@odontocrm.local',
  rif: null,
  website: null,
  // Deja el logo en esa ruta y aparece en el récipe; si no está, el membrete sale sin él.
  logoPath: 'assets/clinic/logo.png',

  dentists: [
    {
      username: 'egomez',
      fullName: 'Od. Erika Gómez',
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

/** Dirección completa en una línea: «…, Planta Baja, Local 1-2, Puerto La Cruz». */
export const clinicFullAddress = (clinic: ClinicIdentity = CLINIC): string =>
  clinic.city === null ? clinic.address : `${clinic.address}, ${clinic.city}`;

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
