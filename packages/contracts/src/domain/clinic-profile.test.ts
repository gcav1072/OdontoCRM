import { describe, expect, it } from 'vitest';

import { BRAND } from '../brand.js';
import { CLINIC, letterheadMissingFields } from '../clinic.js';
import { clinicIdentityFromView, clinicIdentityViewSchema } from './clinic-profile.js';

/** Una identidad ya guardada en la base, con el logo subido y el titular con perfil. */
const identidadCompleta = clinicIdentityViewSchema.parse({
  clinic: {
    name: 'Consultorio Sonrisa',
    legalName: 'R. Pérez',
    address: 'Calle 1, Local 2',
    city: 'Puerto La Cruz',
    phones: ['(+58) 281 123 45 67'],
    email: 'citas@sonrisa.local',
    rif: 'J-12345678-9',
    website: null,
  },
  dentists: [
    {
      username: 'egomez',
      fullName: 'Od. Erika Gómez',
      mpps: 'MPPS 12345',
      specialty: 'Endodoncia',
      licenseNumber: null,
      contactEmail: 'erika@sonrisa.local',
    },
  ],
  titularUsername: 'egomez',
  logoDataUri: 'data:image/svg+xml;base64,PHN2Zy8+',
  fromDatabase: true,
});

describe('la identidad de la vista en la forma del contrato', () => {
  it('traduce el correo del odontólogo (`contactEmail` → `email`)', () => {
    const clinic = clinicIdentityFromView(identidadCompleta);
    expect(clinic.dentists[0]?.email).toBe('erika@sonrisa.local');
    expect(clinic.dentists[0]?.mpps).toBe('MPPS 12345');
  });

  it('una identidad completa no deja nada por avisar en el membrete', () => {
    expect(letterheadMissingFields(clinicIdentityFromView(identidadCompleta))).toEqual([]);
  });

  it('sin logo, el membrete lo echa en falta', () => {
    const sinLogo = clinicIdentityViewSchema.parse({ ...identidadCompleta, logoDataUri: null });
    const clinic = clinicIdentityFromView(sinLogo);
    expect(clinic.logoPath).toBeNull();
    expect(letterheadMissingFields(clinic)).toContain('logo');
  });

  it('con logo, la señal es la ruta del repositorio (nunca una del servidor)', () => {
    const clinic = clinicIdentityFromView(identidadCompleta);
    expect(clinic.logoPath).toBe(BRAND.logoPath);
    expect(letterheadMissingFields(clinic)).not.toContain('logo');
  });

  it('sin perfiles en la base, cae a los odontólogos del respaldo del código', () => {
    // La vista trae `dentists: []` aunque el consultorio exista: el servidor compone el
    // membrete con el respaldo y el aviso de la interfaz tiene que decir lo mismo.
    const sinDentistas = clinicIdentityViewSchema.parse({ ...identidadCompleta, dentists: [] });
    const clinic = clinicIdentityFromView(sinDentistas);
    expect(clinic.dentists).toEqual(CLINIC.dentists);
    expect(letterheadMissingFields(clinic)).not.toContain('odontólogo');
  });
});
