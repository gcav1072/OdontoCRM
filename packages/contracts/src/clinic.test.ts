import { describe, expect, it } from 'vitest';

import {
  CLINIC,
  clinicContactLine,
  clinicContactReady,
  clinicDentistFor,
  clinicFullAddress,
  clinicLeadDentist,
  letterheadMissingFields,
  type ClinicIdentity,
} from './clinic.js';

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
