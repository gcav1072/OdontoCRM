import { describe, expect, it } from 'vitest';

import { BRAND } from '@odontocrm/contracts';

import {
  birthLine,
  countPdfPages,
  prescriptionHtml,
  renderPrescriptionFitted,
  routeText,
  withPrescriptionFit,
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
  it('lleva una marca de agua por mitad, con el contenido por encima', async () => {
    const html = await prescriptionHtml(base);
    expect(html).toContain('class="brand-doc"');
    // Dos mitades ⇒ dos marcas de agua (una centrada en cada copia). Antes se emitía
    // **una sola** a nivel de cuerpo y quedaba centrada sobre la línea divisoria.
    expect(html.match(/class="brand-watermark"/g)).toHaveLength(2);
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
    // El membrete, la firma y la marca de agua se repiten en las dos.
    expect(html.match(/class="brand-lh brand-lh--rule"/g)).toHaveLength(2);
    expect(html.match(/class="signature-name"/g)).toHaveLength(2);
    expect(html.match(/class="brand-watermark"/g)).toHaveLength(2);
    // Cada marca va **dentro** de su mitad, no antes de `.brand-doc` en el cuerpo.
    expect(html).toContain('.half > .brand-watermark');
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
    expect(html).toContain('class="brand-lh-line brand-lh-dentist"');
    expect(html).toContain('Odontólogo prueba · Odontología general · MPPS 12345');
    // Se quitó el detalle que estaba bajo el nombre del firmante.
    expect(html).not.toContain('signature-detail');
  });

  it('sin odontólogo el membrete no añade la línea del especialista', async () => {
    const html = await prescriptionHtml({ ...base, dentist: null });
    expect(html).not.toContain('brand-lh-dentist"');
    // La firma sigue saliendo (la raya para firmar a mano).
    expect(html.match(/class="signature-line"/g)).toHaveLength(2);
  });

  it('el logo del récipe sigue el alto de la marca, no un valor fijo', async () => {
    // Regresión: el récipe tenía `.logo { height: 12mm }` y no seguía la marca. Ahora el
    // alto sale de `--brand-logo-height-mm` (el bloque compartido del membrete).
    const html = await prescriptionHtml(base);
    expect(html).toContain('--brand-logo-height-mm: 18mm');
    expect(html).toContain('.brand-lh-logo');
    expect(html).not.toContain('height: 12mm');
  });

  it('acepta la marca efectiva y la aplica al membrete', async () => {
    const html = await prescriptionHtml({
      ...base,
      brand: {
        palette: BRAND.palette,
        typography: BRAND.typography,
        letterhead: { ...BRAND.letterhead, logoHeightMm: 30 },
      },
    });
    expect(html).toContain('--brand-logo-height-mm: 30mm');
  });

  it('los COLORES del papel salen de la marca del panel, no del código', async () => {
    // Regresión del fallo «cambié el color en el panel y el papel salió igual»: la paleta
    // del panel tiene que llegar al `:root { --brand-* }` de la plantilla.
    const html = await prescriptionHtml({
      ...base,
      brand: {
        palette: { ...BRAND.palette, primary: '#c81e1e', accent: '#f97316', ink: '#123456' },
        typography: BRAND.typography,
        letterhead: BRAND.letterhead,
      },
    });
    expect(html).toContain('--brand-primary: #c81e1e;');
    expect(html).toContain('--brand-accent: #f97316;');
    expect(html).toContain('--brand-ink: #123456;');
    // El color de fábrica no se queda pegado en el CSS.
    expect(html).not.toContain(`--brand-primary: ${BRAND.palette.primary};`);
  });
});

describe('la escala de encaje del récipe', () => {
  it('el HTML nace en escala 1 y todas las medidas la respetan', async () => {
    const html = await prescriptionHtml(base);
    // El valor por defecto que `withPrescriptionFit` reescribe si el récipe no cabe.
    expect(html).toContain('--rx-fit: 1;');
    // Las medidas caen al valor 1 si la variable no está: la escala nunca rompe el papel.
    expect(html).toContain('var(--rx-fit, 1)');
    // El membrete también encoge (tipografía del nombre, líneas y alto del logo).
    expect(html).toContain('calc(var(--brand-lh-title-pt) * var(--rx-fit, 1))');
    expect(html).toContain('calc(var(--brand-logo-height-mm) * var(--rx-fit, 1))');
  });

  it('withPrescriptionFit reescribe solo el valor por defecto', async () => {
    const html = await prescriptionHtml(base);
    const escalado = withPrescriptionFit(html, 0.85);
    expect(escalado).toContain('--rx-fit: 0.85;');
    expect(escalado).not.toContain('--rx-fit: 1;');
    // Los respaldos de las medidas siguen en 1: cambiar la escala no los toca.
    expect(escalado).toContain('var(--rx-fit, 1)');
  });
});

describe('el récipe cabe en una sola hoja', () => {
  const pdfDe = (paginas: number): Buffer => Buffer.from('/Type /Page '.repeat(paginas));
  const escalaDe = (documento: string): number => {
    const encontrado = /--rx-fit: ([\d.]+);/.exec(documento);
    return encontrado === null ? 1 : Number(encontrado[1]);
  };

  it('no reintenta si ya cabe a tamaño normal', async () => {
    const intentos: string[] = [];
    const pdf = await renderPrescriptionFitted(async (documento) => {
      intentos.push(documento);
      return pdfDe(1);
    }, 'HTML --rx-fit: 1;');
    // Una sola composición: el récipe normal no paga el bucle.
    expect(intentos).toHaveLength(1);
    expect(countPdfPages(pdf)).toBe(1);
  });

  it('baja la escala hasta que cabe y deja de intentar', async () => {
    const escalas: number[] = [];
    await renderPrescriptionFitted(async (documento) => {
      const escala = escalaDe(documento);
      escalas.push(escala);
      // A 1 y 0,94 el récipe sale en dos hojas; a 0,88 ya cabe.
      return pdfDe(escala <= 0.88 ? 1 : 2);
    }, 'HTML --rx-fit: 1;');
    expect(escalas).toEqual([1, 0.94, 0.88]);
  });

  it('si ni con la escala mínima cabe, devuelve la última composición', async () => {
    const escalas: number[] = [];
    const pdf = await renderPrescriptionFitted(async (documento) => {
      escalas.push(escalaDe(documento));
      return pdfDe(2);
    }, 'HTML --rx-fit: 1;');
    expect(escalas).toEqual([1, 0.94, 0.88, 0.82, 0.76, 0.7]);
    expect(countPdfPages(pdf)).toBe(2);
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
