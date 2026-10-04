import { describe, expect, it } from 'vitest';

import {
  CLINIC,
  clinicContactLine,
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

describe('la sección editable del consultorio', () => {
  it('está completa en lo indispensable para arrancar', () => {
    expect(CLINIC.name.trim()).not.toBe('');
    expect(CLINIC.address.trim()).not.toBe('');
    expect(CLINIC.dentists.length).toBeGreaterThan(0);
  });

  it('cada odontólogo tiene usuario y nombre, y los usuarios no se repiten', () => {
    const usuarios = CLINIC.dentists.map((dentist) => dentist.username);
    expect(usuarios.every((usuario) => usuario.trim() !== '')).toBe(true);
    expect(new Set(usuarios).size).toBe(usuarios.length);
    expect(CLINIC.dentists.every((dentist) => dentist.fullName.trim() !== '')).toBe(true);
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

  it('el consultorio de fábrica dice qué le falta para el récipe', () => {
    // No es un fallo: es el recordatorio de que hay que completar la sección.
    expect(letterheadMissingFields()).toContain('MPPS del odontólogo');
  });
});
