import { describe, expect, it } from 'vitest';

import { CSV_BOM } from '../common/csv.js';
import {
  bookFileName,
  igtfBookToCsv,
  rangoDelMes,
  rangoDelMesAnterior,
  salesBookToCsv,
  type IgtfBookRow,
  type SalesBookRow,
} from './billing.js';

/**
 * Los libros fiscales, como **texto**: lo que se le entrega al contador tiene que abrir bien en Excel
 * (BOM, `;`, coma decimal), llevar el desglose y no dejar que un nombre con `;` rompa la fila.
 */
const venta = (extra: Partial<SalesBookRow> = {}): SalesBookRow => ({
  fecha: '2026-10-06',
  documento: 'A-000123',
  control: '000456',
  cliente: 'Ana Pérez',
  rif: 'V-12345678',
  exento: 50,
  base16: 12,
  iva: 1.92,
  total: 63.92,
  tasa: 36.542,
  totalBs: 2923.36,
  estado: 'emitida',
  ...extra,
});

describe('el libro de ventas en CSV', () => {
  it('sale con BOM, separador `;` y coma decimal', () => {
    const csv = salesBookToCsv([venta()]);
    expect(csv.startsWith(CSV_BOM)).toBe(true);
    const [cabecera = '', fila = ''] = csv.replace(CSV_BOM, '').split('\r\n');
    expect(cabecera).toContain('Fecha;Documento;N.º de control');
    expect(cabecera).toContain('Base 16 % US$');
    expect(fila).toContain('2026-10-06;A-000123;000456');
    expect(fila).toContain('1,92');
    expect(fila).toContain('36,542');
    expect(fila).toContain('2923,36');
  });

  it('una nota de crédito entra en negativo y con su factura', () => {
    const csv = salesBookToCsv([
      venta(),
      venta({
        documento: 'NC-000001',
        exento: -50,
        base16: -12,
        iva: -1.92,
        total: -63.92,
        totalBs: -2923.36,
        estado: 'nota de crédito de A-000123',
      }),
    ]);
    const filas = csv.replace(CSV_BOM, '').trim().split('\r\n');
    expect(filas).toHaveLength(3);
    expect(filas[2]).toContain('-63,92');
    expect(filas[2]).toContain('nota de crédito de A-000123');
  });

  it('un cliente con `;` en el nombre no parte la fila', () => {
    const csv = salesBookToCsv([venta({ cliente: 'Pérez; Ana' })]);
    expect(csv).toContain('"Pérez; Ana"');
    expect(csv.replace(CSV_BOM, '').trim().split('\r\n')).toHaveLength(2);
  });

  it('sin operaciones sale solo la cabecera', () => {
    const csv = salesBookToCsv([]);
    expect(csv.replace(CSV_BOM, '').trim().split('\r\n')).toHaveLength(1);
  });
});

describe('el libro de IGTF en CSV', () => {
  it('lleva el medio, la alícuota y quién percibe', () => {
    const fila: IgtfBookRow = {
      fecha: '2026-10-06',
      recibo: 'REC-000001',
      factura: 'A-000123',
      medio: 'Efectivo en divisas',
      monto: 30,
      alicuota: 3,
      percibidoPor: 'clinica',
      igtf: 0.9,
      igtfBs: 32.89,
    };
    const csv = igtfBookToCsv([fila]);
    const [cabecera = '', cuerpo = ''] = csv.replace(CSV_BOM, '').split('\r\n');
    expect(cabecera).toContain('Recibo;Factura;Medio de pago');
    expect(cabecera).toContain('Percibido por');
    expect(cuerpo).toContain('REC-000001;A-000123;Efectivo en divisas');
    expect(cuerpo).toContain('3;clinica;0,9;32,89');
  });
});

describe('el nombre del archivo del libro', () => {
  it('lleva el rango pedido', () => {
    expect(bookFileName('ventas', { from: '2026-10-01', to: '2026-10-31' })).toBe(
      'libro-de-ventas-2026-10-01_2026-10-31.csv',
    );
    expect(bookFileName('igtf', {})).toBe('libro-de-igtf-inicio_fin.csv');
  });

  it('el PDF es el mismo nombre con la otra extensión', () => {
    expect(bookFileName('ventas', { from: '2026-10-01', to: '2026-10-31' }, 'pdf')).toBe(
      'libro-de-ventas-2026-10-01_2026-10-31.pdf',
    );
    expect(bookFileName('cambiario', {}, 'pdf')).toBe('libro-de-cambiario-inicio_fin.pdf');
  });

  it('no deja pasar nada que rompa una cabecera HTTP', () => {
    // El valor viaja a `content-disposition`: comillas o saltos son una inyección de cabeceras.
    const nombre = bookFileName('ventas', {
      from: '2026-10-01" \r\nX-Malicioso: 1',
      to: '2026-10-31',
    });
    expect(nombre).not.toContain('"');
    expect(nombre).not.toContain('\n');
    expect(nombre).not.toContain('\r');
    // Cada carácter prohibido se vuelve un guion: comilla, espacio, retorno y salto son cuatro.
    expect(nombre).toBe('libro-de-ventas-2026-10-01----X-Malicioso--1_2026-10-31.csv');
  });
});

/**
 * El período del libro es una cuenta de **calendario** (`aaaa-mm-dd`), no de instantes: si se
 * calculara con `new Date('2026-10-01')`, en Caracas caería el 30 de septiembre y el libro saldría
 * un día corrido. La misma función propone el período en la pantalla y lo resuelve el servidor.
 */
describe('el período del libro: el mes y el mes anterior', () => {
  it('un mes de 31 días', () => {
    expect(rangoDelMes('2026-10-18')).toEqual({ from: '2026-10-01', to: '2026-10-31' });
  });

  it('febrero, bisiesto y no bisiesto', () => {
    expect(rangoDelMes('2028-02-10')).toEqual({ from: '2028-02-01', to: '2028-02-29' });
    expect(rangoDelMes('2026-02-10')).toEqual({ from: '2026-02-01', to: '2026-02-28' });
  });

  it('diciembre y enero, que son los bordes de año', () => {
    expect(rangoDelMesAnterior('2026-12-31')).toEqual({
      from: '2026-11-01',
      to: '2026-11-30',
    });
    expect(rangoDelMesAnterior('2026-01-05')).toEqual({ from: '2025-12-01', to: '2025-12-31' });
  });

  it('el mes anterior de marzo es febrero (y de un bisiesto, 29 días)', () => {
    expect(rangoDelMesAnterior('2026-03-31')).toEqual({ from: '2026-02-01', to: '2026-02-28' });
    expect(rangoDelMesAnterior('2028-03-01')).toEqual({ from: '2028-02-01', to: '2028-02-29' });
  });
});
