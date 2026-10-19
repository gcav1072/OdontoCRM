import {
  EXCHANGE_DIFF_BOOK_COLUMNS,
  IGTF_BOOK_COLUMNS,
  SALES_BOOK_COLUMNS,
  type CsvColumn,
} from '@odontocrm/contracts';
import { describe, expect, it } from 'vitest';

import {
  BOOK_TITLES,
  FORMATO_DE_COLUMNA,
  celdaDelLibro,
  fechaDelLibro,
  renderBookHtml,
  type BookKind,
  type BookPdfInput,
} from './book-pdf.js';

/**
 * La plantilla de los libros, comprobada como **texto** (como la factura): el PDF de Chromium es el
 * transporte, así que lo que importa —membrete, período, columnas, cifras y la tabla vacía— se puede
 * verificar sin navegador.
 */

const COLUMNAS: Readonly<Record<BookKind, readonly CsvColumn[]>> = {
  ventas: SALES_BOOK_COLUMNS,
  igtf: IGTF_BOOK_COLUMNS,
  cambiario: EXCHANGE_DIFF_BOOK_COLUMNS,
};

const libro = (extra: Partial<BookPdfInput> = {}): BookPdfInput => ({
  kind: 'ventas',
  from: '2026-10-01',
  to: '2026-10-31',
  columns: SALES_BOOK_COLUMNS,
  rows: [
    {
      fecha: '2026-10-04',
      documento: 'A-000123',
      control: '000456',
      cliente: 'María Peña',
      rif: 'V-12345678',
      exento: 50,
      base16: 12,
      iva: 1.92,
      total: 63.92,
      tasa: 36.542,
      totalBs: 2335.6,
      estado: 'emitida',
    },
  ],
  generatedAt: new Date('2026-10-18T14:00:00.000Z'),
  brand: null,
  logoDataUri: null,
  fontFaceCss: '',
  ...extra,
});

describe('el formato de cada columna', () => {
  it('ningún libro puede imprimir una columna sin formato decidido', () => {
    for (const kind of ['ventas', 'igtf', 'cambiario'] as const) {
      const claves = COLUMNAS[kind].map((columna) => columna.key).sort();
      expect(Object.keys(FORMATO_DE_COLUMNA[kind]).sort()).toEqual(claves);
    }
  });

  it('el dinero lleva dos decimales, la tasa cuatro y el porcentaje dos', () => {
    expect(celdaDelLibro(2335.6, 'money')).toBe('2.335,60');
    expect(celdaDelLibro(36.542, 'rate')).toBe('36,5420');
    expect(celdaDelLibro(3, 'percent')).toBe('3,00');
  });

  it('la fecha no pasa por `Date`: no puede retroceder un día en Caracas', () => {
    expect(fechaDelLibro('2026-10-01')).toBe('01/10/2026');
    expect(celdaDelLibro('2026-10-01', 'date')).toBe('01/10/2026');
  });

  it('un valor ausente es una celda vacía, no «null»', () => {
    expect(celdaDelLibro(null, 'money')).toBe('');
    expect(celdaDelLibro(undefined, 'text')).toBe('');
  });
});

describe('el HTML del libro', () => {
  it('lleva el membrete del consultorio y el período', async () => {
    const html = await renderBookHtml(
      libro({
        clinic: {
          name: 'Clínica Sonrisa, C.A.',
          legalName: 'Sonrisa Compañía Anónima',
          rif: 'J-12345678-9',
          address: 'Av. Principal',
          city: 'Caracas',
          phones: ['+58 212 555 0101'],
          email: 'hola@sonrisa.test',
          website: 'sonrisa.test',
          logoPath: null,
          dentists: [],
        },
      }),
    );

    expect(html).toContain('Clínica Sonrisa, C.A.');
    expect(html).toContain('Del 01/10/2026 al 31/10/2026');
    expect(html).toContain(BOOK_TITLES.ventas);
    // El membrete compartido (ADR 0064): la clase la publica `letterheadHtml`.
    expect(html).toContain('brand-lh-name');
    // Un libro no lo firma el odontólogo: no lleva esa línea (la clase del CSS sí está).
    expect(html).not.toContain('class="brand-lh-line brand-lh-dentist"');
  });

  it('el libro de ventas trae sus doce columnas y las cifras con coma decimal', async () => {
    const html = await renderBookHtml(libro());

    for (const columna of SALES_BOOK_COLUMNS) expect(html).toContain(columna.label);
    expect(html).toContain('María Peña');
    expect(html).toContain('2.335,60');
    expect(html).toContain('36,5420');
    // La nota de crédito en negativo se explica al pie del libro de ventas.
    expect(html).toContain('notas de crédito');
  });

  it('sin operaciones dice que no hay, en vez de dejar una tabla huérfana', async () => {
    const html = await renderBookHtml(libro({ rows: [] }));

    expect(html).toContain('Sin operaciones en el período seleccionado.');
    expect(html).not.toContain('<tbody>');
  });

  it('el cambiario imprime el neto que cuadra: ganancias − pérdidas + reversiones', async () => {
    const html = await renderBookHtml(
      libro({
        kind: 'cambiario',
        columns: EXCHANGE_DIFF_BOOK_COLUMNS,
        rows: [
          {
            fecha: '2026-10-05',
            documento: 'REC-000004',
            concepto: 'Cobro en bolívares',
            tasa: 36.542,
            diferencialBs: 200,
          },
        ],
        summary: {
          exchangeDiff: {
            gananciasVesCentimos: 20_000,
            perdidasVesCentimos: 5_000,
            reversionesVesCentimos: -2_000,
            netoVesCentimos: 13_000,
          },
        },
      }),
    );

    expect(html).toContain(BOOK_TITLES.cambiario);
    expect(html).toContain('Neto del período');
    expect(html).toContain('Bs. 130,00');
    expect(html).toContain('REC-000004');
  });

  it('el de IGTF separa el arqueo de Caja Divisas del de Banco/Caja Bs.', async () => {
    const html = await renderBookHtml(
      libro({
        kind: 'igtf',
        columns: IGTF_BOOK_COLUMNS,
        rows: [
          {
            fecha: '2026-10-06',
            recibo: 'REC-000005',
            factura: 'A-000124',
            medio: 'Efectivo (USD)',
            monto: 100,
            alicuota: 3,
            percibidoPor: 'clinica',
            igtf: 3,
            igtfBs: 109.63,
          },
        ],
        summary: {
          igtf: {
            baseDivisasCentsUsd: 10_000,
            igtfCentsUsd: 300,
            igtfVesCentimos: 10_963,
            igtfCajaDivisasCentsUsd: 300,
            igtfCajaBsVesCentimos: 0,
          },
        },
      }),
    );

    expect(html).toContain('Arqueo Caja Divisas');
    expect(html).toContain('Arqueo Banco/Caja Bs.');
    expect(html).toContain('US$ 3,00');
  });

  it('la identidad sale del helper compartido, no de una copia de la factura', async () => {
    const html = await renderBookHtml(libro());
    // Las clases las publica `letterheadCss()` y las pinta `letterheadHtml()` (ADR 0064):
    // si el membrete cambia de forma, se ve aquí y en la factura a la vez.
    expect(html).toContain('class="brand-lh"');
    expect(html).toContain('class="brand-lh-name"');
  });
});
