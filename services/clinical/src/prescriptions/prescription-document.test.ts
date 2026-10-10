import { describe, expect, it } from 'vitest';

import {
  birthLine,
  prescriptionHtml,
  routeText,
  type PrescriptionDocumentInput,
} from './prescription-document.js';
import { qrSvg } from './qr.js';

/**
 * El texto del récipe, comprobado donde se lee: la línea del paciente.
 *
 * El documento lo firma una persona real y lo lee el paciente; decirle «nacido» a una
 * paciente es un error que se ve en el papel (pasó: «María … nacido el 1988-04-12»).
 */

const base: PrescriptionDocumentInput = {
  number: 'RX-000007',
  issuedAt: new Date('2026-10-04T14:30:00Z'),
  patientName: 'María Pérez Gómez',
  patientDocument: 'V-12345678',
  patientBirthDate: '1988-04-12',
  patientSex: 'F',
  patientAge: 38,
  dentist: {
    username: 'prueba',
    fullName: 'Odontólogo prueba',
    mpps: 'MPPS 12345',
    specialty: 'Odontología general',
    licenseNumber: null,
    email: null,
  },
  items: [
    {
      medicationName: 'Amoxicilina',
      presentation: 'Tabletas 500 mg',
      route: 'Vía oral',
      dose: '500 mg',
      frequency: 'cada 8 horas',
      duration: '7 días',
      instructions: 'Después de las comidas',
      quantity: '21 tabletas',
    },
  ],
  generalInstructions: 'Volver si el dolor no cede en 48 horas.',
  verificationUrl: 'http://127.0.0.1:5173/verificar/ABCDE-FGHJK',
  verifyCode: 'ABCDE-FGHJK',
  logoPath: null,
};

describe('la línea del paciente', () => {
  it('una paciente dice «nacida»', () => {
    expect(birthLine('1988-04-12', 'F')).toBe('nacida el 12/04/1988');
  });

  it('un paciente dice «nacido»', () => {
    expect(birthLine('1988-04-12', 'M')).toBe('nacido el 12/04/1988');
  });

  it('sin sexo (o «otro») se usa la forma que sirve para cualquiera', () => {
    expect(birthLine('1988-04-12', null)).toBe('nació el 12/04/1988');
    expect(birthLine('1988-04-12', 'O')).toBe('nació el 12/04/1988');
    expect(birthLine('1988-04-12', '')).toBe('nació el 12/04/1988');
  });

  it('sin fecha de nacimiento no se imprime la línea', () => {
    expect(birthLine(null, 'F')).toBeNull();
    expect(birthLine('  ', 'F')).toBeNull();
  });

  it('una fecha que no viene en ISO se imprime tal cual, sin inventar', () => {
    expect(birthLine('12/04/1988', 'F')).toBe('nacida el 12/04/1988');
    expect(birthLine('abril de 1988', 'M')).toBe('nacido el abril de 1988');
  });
});

describe('el récipe impreso', () => {
  it('lleva la marca de agua del consultorio, con el contenido por encima', async () => {
    const html = await prescriptionHtml(base);
    expect(html).toContain('class="brand-watermark"');
    expect(html).toContain('class="brand-doc"');
  });
  it('la paciente sale con su edad y su nacimiento concordados', async () => {
    const html = await prescriptionHtml(base);
    expect(html).toContain('Paciente:');
    expect(html).toContain('María Pérez Gómez');
    expect(html).toContain('38 años');
    expect(html).toContain('nacida el 12/04/1988');
    expect(html).not.toContain('nacido el');
  });

  it('el paciente hombre sale concordado al revés', async () => {
    const html = await prescriptionHtml({ ...base, patientName: 'José Pérez', patientSex: 'M' });
    expect(html).toContain('nacido el 12/04/1988');
    expect(html).not.toContain('nacida el');
  });

  it('sin sexo conocido el papel no supone nada', async () => {
    const html = await prescriptionHtml({ ...base, patientSex: null });
    expect(html).toContain('nació el 12/04/1988');
    expect(html).not.toContain('nacido');
    expect(html).not.toContain('nacida');
  });

  it('el récipe no lleva diagnóstico ni datos clínicos de más', async () => {
    const html = await prescriptionHtml(base);
    // Lo que sí lleva: medicamento, dosis, frecuencia, indicaciones y la firma.
    expect(html).toContain('Amoxicilina');
    expect(html).toContain('500 mg');
    expect(html).toContain('cada 8 horas');
    expect(html).toContain('Odontólogo prueba');
    expect(html).toContain('MPPS 12345');
    expect(html).toContain('RX-000007');
    // El QR lleva dentro el enlace de verificación: se compara con el que genera
    // el propio módulo del QR (el enlace no se imprime como texto a propósito: lo
    // lee el teléfono, y quien no tenga teléfono usa el número de arriba).
    expect(html).toContain(qrSvg('http://127.0.0.1:5173/verificar/ABCDE-FGHJK'));
  });
});

describe('el récipe en dos mitades apaisadas', () => {
  it('parte la hoja en dos mitades, cada una con su membrete y su firma', async () => {
    const html = await prescriptionHtml(base);
    expect(html).toContain('class="sheet"');
    // Dos medias hojas: la farmacia (izquierda) y el paciente (derecha).
    expect(html.match(/class="half"/g)).toHaveLength(2);
    // El membrete y la firma se repiten en las dos.
    expect(html.match(/class="letterhead"/g)).toHaveLength(2);
    expect(html.match(/class="signature-name"/g)).toHaveLength(2);
  });

  it('la copia de la farmacia lleva medicamento (negrita y subrayado), presentación, vía y dosis', async () => {
    const html = await prescriptionHtml(base);
    expect(html).toContain('RÉCIPE');
    expect(html).toContain('rp-med');
    expect(html).toContain('Presentación:');
    expect(html).toContain('Vía:');
    expect(html).toContain('Dosis:');
    // El código de verificación se imprime como texto en esta mitad (allí no va QR).
    expect(html).toContain('Código de verificación');
    expect(html).toContain('ABCDE-FGHJK');
  });

  it('la copia del paciente lleva la tabla de indicaciones y el QR', async () => {
    const html = await prescriptionHtml(base);
    expect(html).toContain('INDICACIONES');
    expect(html).toContain('<th>Medicamento</th><th>Dosis</th><th>Frecuencia</th>');
    // El QR va **solo** en la mitad del paciente.
    const qr = qrSvg('http://127.0.0.1:5173/verificar/ABCDE-FGHJK');
    expect(html.split(qr)).toHaveLength(2);
  });

  it('el especialista va en el membrete, no bajo la firma', async () => {
    const html = await prescriptionHtml(base);
    expect(html).toContain('class="clinic-dentist"');
    expect(html).toContain('Odontólogo prueba · Odontología general · MPPS 12345');
    // Se quitó el detalle que estaba bajo el nombre del firmante.
    expect(html).not.toContain('signature-detail');
  });

  it('sin odontólogo el membrete no añade la línea del especialista', async () => {
    const html = await prescriptionHtml({ ...base, dentist: null });
    expect(html).not.toContain('class="clinic-dentist"');
    // La firma sigue saliendo (la raya para firmar a mano).
    expect(html.match(/class="signature-line"/g)).toHaveLength(2);
  });
});

describe('la vía como se imprime', () => {
  it('traduce el código del catálogo a su etiqueta', () => {
    expect(routeText('oral')).toBe('Vía oral');
    expect(routeText('topica')).toBe('Vía tópica');
  });

  it('deja tal cual un valor que no es del catálogo (récipes ya emitidos)', () => {
    expect(routeText('subcutánea')).toBe('subcutánea');
  });

  it('vacío o nulo no imprime nada', () => {
    expect(routeText(null)).toBeNull();
    expect(routeText('  ')).toBeNull();
  });
});
