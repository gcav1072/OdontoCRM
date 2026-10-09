import { describe, expect, it } from 'vitest';

import { BRAND } from '../brand.js';
import { letterheadMissingFields } from '../clinic.js';
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
      username: 'prueba',
      fullName: 'Odontólogo prueba',
      mpps: 'MPPS 12345',
      specialty: 'Endodoncia',
      licenseNumber: null,
      contactEmail: 'prueba@sonrisa.local',
    },
  ],
  titularUsername: 'prueba',
  logoDataUri: 'data:image/svg+xml;base64,PHN2Zy8+',
  fromDatabase: true,
});

describe('la identidad de la vista en la forma del contrato', () => {
  it('traduce el correo del odontólogo (`contactEmail` → `email`)', () => {
    const clinic = clinicIdentityFromView(identidadCompleta);
    expect(clinic.dentists[0]?.email).toBe('prueba@sonrisa.local');
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

  it('sin perfiles en la base, la lista de odontólogos queda vacía (no se inventa)', () => {
    // La vista trae `dentists: []`: el respaldo del código es neutro, así que no aporta
    // ningún odontólogo de relleno y el aviso del membrete echa en falta uno.
    const sinDentistas = clinicIdentityViewSchema.parse({ ...identidadCompleta, dentists: [] });
    const clinic = clinicIdentityFromView(sinDentistas);
    expect(clinic.dentists).toEqual([]);
    expect(letterheadMissingFields(clinic)).toContain('odontólogo');
  });
});
