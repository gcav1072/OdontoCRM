import { describe, expect, it } from 'vitest';

import {
  CLINIC,
  clinicContactLine,
  clinicContactReady,
  clinicDentistFor,
  clinicDentistLine,
  clinicFullAddress,
  clinicLeadDentist,
  clinicNameFromLines,
  clinicNameLines,
  clinicNameOneLine,
  letterheadMissingFields,
  type ClinicIdentity,
} from './clinic.js';
import { clinicProfileSchema } from './domain/clinic-profile.js';

const consultorioCompleto: ClinicIdentity = {
  name: 'Consultorio Sonrisa',
  legalName: 'R. Pérez',
  address: 'Calle 1, Local 2',
  city: 'Puerto La Cruz',
  phones: ['(+58) 281 123 45 67'],
  email: 'citas@sonrisa.local',
  rif: 'J-12345678-9',
  website: null,
  logoPath: 'assets/clinic/logo.png',
  dentists: [
    {
      username: 'jperez',
      fullName: 'Od. José Pérez',
      mpps: 'MPPS 12345',
      specialty: 'Endodoncia',
      licenseNumber: null,
      email: null,
    },
  ],
};

describe('los valores neutros de arranque del consultorio', () => {
  it('no lleva datos personales: nada que imprimir hasta que el titular lo complete', () => {
    expect(CLINIC.name.trim()).toBe('');
    expect(CLINIC.address.trim()).toBe('');
    expect(CLINIC.rif).toBeNull();
    expect(CLINIC.email).toBeNull();
    expect(clinicContactReady(CLINIC)).toBe(false);
  });

  it('trae una cuenta de odontólogo de prueba para el seed, con usuario y nombre', () => {
    expect(CLINIC.dentists).toHaveLength(1);
    const prueba = CLINIC.dentists[0];
    expect(prueba?.username.trim()).toBe('prueba');
    expect(prueba?.fullName.trim()).not.toBe('');
  });

  it('el titular es el primero de la lista', () => {
    expect(clinicLeadDentist()?.username).toBe(CLINIC.dentists[0]?.username);
  });

  it('el odontólogo de un usuario se busca por su nombre de usuario', () => {
    const titular = clinicLeadDentist(CLINIC);
    expect(clinicDentistFor(titular?.username, CLINIC)?.fullName).toBe(titular?.fullName);
    // Un usuario que no es odontólogo (secretaría, admin) firma con el titular.
    expect(clinicDentistFor('recepcion', CLINIC)?.fullName).toBe(titular?.fullName);
    expect(clinicDentistFor(null, CLINIC)?.fullName).toBe(titular?.fullName);
    expect(clinicDentistFor('jperez', { ...CLINIC, dentists: [] })).toBeNull();
  });
});

describe('ayudas de lectura del consultorio', () => {
  it('la dirección añade la ciudad solo si está puesta', () => {
    expect(clinicFullAddress(consultorioCompleto)).toBe('Calle 1, Local 2, Puerto La Cruz');
    expect(clinicFullAddress({ ...consultorioCompleto, city: null })).toBe('Calle 1, Local 2');
  });

  it('la línea de contacto junta teléfonos y correo sin dejar separadores sueltos', () => {
    expect(clinicContactLine(consultorioCompleto)).toBe(
      '(+58) 281 123 45 67 · citas@sonrisa.local',
    );
    expect(clinicContactLine({ ...consultorioCompleto, phones: [], email: null })).toBe('');
    expect(clinicContactLine({ ...consultorioCompleto, email: null })).toBe('(+58) 281 123 45 67');
  });

  it('un membrete completo no tiene nada pendiente', () => {
    expect(letterheadMissingFields(consultorioCompleto)).toEqual([]);
  });

  it('lo que falta se enumera: es lo que el récipe avisa en vez de inventarlo', () => {
    const aMedias: ClinicIdentity = {
      ...consultorioCompleto,
      rif: null,
      phones: [],
      logoPath: null,
      dentists: [{ ...consultorioCompleto.dentists[0]!, mpps: null, specialty: null }],
    };
    expect(letterheadMissingFields(aMedias)).toEqual([
      'RIF',
      'teléfono',
      'logo',
      'MPPS del odontólogo',
      'especialidad del odontólogo',
    ]);

    const sinNada = letterheadMissingFields({
      ...aMedias,
      name: '  ',
      address: '',
      dentists: [],
    });
    expect(sinNada).toContain('nombre del consultorio');
    expect(sinNada).toContain('dirección');
    expect(sinNada).toContain('odontólogo');
  });

  it('el consultorio de fábrica avisa de todo lo que le falta para el récipe', () => {
    // No es un fallo: es el recordatorio de que hay que completarlo desde la aplicación.
    const faltantes = letterheadMissingFields();
    expect(faltantes).toContain('nombre del consultorio');
    expect(faltantes).toContain('dirección');
    expect(faltantes).toContain('MPPS del odontólogo');
  });
});

/**
 * El nombre del consultorio se edita en **dos líneas**. El fallo del alta del titular era
 * que cada tecla recortaba la línea, así que el espacio entre dos palabras desaparecía y el
 * nombre «no admitía espacios». Estos ayudantes son el cable entre los dos campos y la
 * columna (una sola línea de texto con un salto en medio): **no recortan** al escribir; la
 * normalización la hace el esquema al guardar.
 */
describe('el nombre del consultorio en dos líneas', () => {
  it('parte el nombre en sus dos líneas, tal cual se escribieron', () => {
    expect(clinicNameLines('Clínica Sonrisa\nSucursal Centro')).toEqual([
      'Clínica Sonrisa',
      'Sucursal Centro',
    ]);
  });

  it('un nombre de una línea deja la segunda vacía', () => {
    expect(clinicNameLines('Clínica Sonrisa')).toEqual(['Clínica Sonrisa', '']);
    expect(clinicNameLines('')).toEqual(['', '']);
  });

  it('conserva el espacio que se está tecleando (no recorta al unir)', () => {
    // El bug: recortar en cada tecla borraba el espacio recién escrito.
    expect(clinicNameFromLines('Clínica Sonrisa', 'Sucursal Centro')).toBe(
      'Clínica Sonrisa\nSucursal Centro',
    );
    expect(clinicNameFromLines('Clínica ', '')).toBe('Clínica \n');
  });

  it('partir y volver a unir devuelve lo mismo', () => {
    const nombre = 'Clínica Sonrisa\nSucursal Centro';
    const [linea1, linea2] = clinicNameLines(nombre);
    expect(clinicNameFromLines(linea1, linea2)).toBe(nombre);
  });

  it('lo que se teclea se recorta al guardar, no antes', () => {
    const crudo = clinicNameFromLines('  Clínica Sonrisa ', 'Sucursal Centro');
    // Mientras se escribe se conserva tal cual (con los espacios de sobra)…
    expect(crudo).toBe('  Clínica Sonrisa \nSucursal Centro');
    // …y ya guardado por el esquema, recortado y en dos líneas.
    expect(clinicProfileSchema.shape.name.parse(crudo)).toBe('Clínica Sonrisa\nSucursal Centro');
  });

  it('teclear «Clínica Sonrisa» letra a letra conserva el espacio (regresión)', () => {
    // El bug del alta del titular: el formulario recortaba cada tecla, así que al escribir
    // el espacio entre «Clínica» y «Sonrisa» el espacio desaparecía y el nombre quedaba
    // «ClínicaSonrisa». Aquí se simula el formulario: el valor es el nombre en dos líneas y
    // cada tecla lo recompone; con el recorte viejo, este test fallaría.
    let valor = '';
    const teclear = (texto: string): void => {
      const [linea1, linea2] = clinicNameLines(valor);
      valor = clinicNameFromLines(linea1 + texto, linea2);
    };
    for (const caracter of 'Clínica Sonrisa') teclear(caracter);

    expect(clinicNameLines(valor)[0]).toBe('Clínica Sonrisa');
    expect(clinicProfileSchema.shape.name.parse(valor)).toBe('Clínica Sonrisa');
  });
});

describe('la línea del especialista en el membrete', () => {
  it('junta nombre, especialidad, MPPS y colegiatura en ese orden', () => {
    const dentista = {
      username: 'jperez',
      fullName: 'Od. José Pérez',
      mpps: '12345',
      specialty: 'Endodoncia',
      licenseNumber: '6789',
      email: null,
    };
    expect(clinicDentistLine(dentista)).toBe(
      'Od. José Pérez · Endodoncia · MPPS 12345 · Colegiatura 6789',
    );
  });

  it('no repite el prefijo «MPPS» si el número ya lo trae', () => {
    const dentista = {
      username: 'jperez',
      fullName: 'Od. José Pérez',
      mpps: 'MPPS 12345',
      specialty: 'Endodoncia',
      licenseNumber: null,
      email: null,
    };
    expect(clinicDentistLine(dentista)).toBe('Od. José Pérez · Endodoncia · MPPS 12345');
  });

  it('solo imprime lo que está lleno: nada sale en blanco', () => {
    const soloNombre = {
      username: 'jperez',
      fullName: 'Od. José Pérez',
      mpps: null,
      specialty: null,
      licenseNumber: null,
      email: null,
    };
    expect(clinicDentistLine(soloNombre)).toBe('Od. José Pérez');
  });

  it('sin odontólogo no hay línea que imprimir', () => {
    expect(clinicDentistLine(null)).toBe('');
  });
});

describe('el nombre del consultorio en una sola línea', () => {
  it('colapsa el salto de línea que parte el membrete en dos', () => {
    expect(clinicNameOneLine('Clínica Sonrisa\nSucursal Centro')).toBe(
      'Clínica Sonrisa Sucursal Centro',
    );
  });

  it('recorta los espacios sobrantes de cada línea', () => {
    expect(clinicNameOneLine('  Clínica  Sonrisa  \n  Sucursal  ')).toBe(
      'Clínica Sonrisa Sucursal',
    );
  });

  it('un nombre de una sola línea queda igual', () => {
    expect(clinicNameOneLine('Consultorio Sonrisa')).toBe('Consultorio Sonrisa');
  });
});
