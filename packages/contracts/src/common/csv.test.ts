import { describe, expect, it } from 'vitest';

import { buildCsv, CSV_BOM, csvCell, csvNumber } from './csv.js';

const columns = [
  { key: 'fecha', label: 'Fecha' },
  { key: 'paciente', label: 'Paciente' },
  { key: 'tasa', label: 'Tasa' },
];

describe('CSV para Excel en español', () => {
  it('empieza con BOM UTF-8: sin él Excel rompe los acentos', () => {
    const csv = buildCsv(columns, [{ fecha: '2026-10-04', paciente: 'María Peña', tasa: 12.5 }]);
    expect(csv.startsWith(CSV_BOM)).toBe(true);
    expect(csv).toContain('María Peña');
  });

  it('usa punto y coma y CRLF, como espera Excel en español', () => {
    const csv = buildCsv(columns, [{ fecha: '2026-10-04', paciente: 'Ana', tasa: 1 }]);
    const lineas = csv.replace(CSV_BOM, '').split('\r\n');
    expect(lineas[0]).toBe('Fecha;Paciente;Tasa');
    expect(lineas[1]).toBe('2026-10-04;Ana;1');
  });

  it('escribe los decimales con coma', () => {
    expect(csvNumber(12.5)).toBe('12,5');
    expect(csvNumber(12)).toBe('12');
    const csv = buildCsv(columns, [{ fecha: 'x', paciente: 'y', tasa: 0.85 }]);
    expect(csv).toContain(';0,85');
  });

  it('entrecomilla lo que lleva separador, comillas o espacios de sobra', () => {
    expect(csvCell('Pérez; Ana')).toBe('"Pérez; Ana"');
    expect(csvCell('dijo "hola"')).toBe('"dijo ""hola"""');
    expect(csvCell('espacio al final ')).toBe('"espacio al final "');
    expect(csvCell('normal')).toBe('normal');
  });

  it('aplana los saltos de línea para que una fila no se parta', () => {
    expect(csvCell('linea 1\nlinea 2')).toBe('linea 1 linea 2');
    expect(csvCell('linea 1\r\nlinea 2')).toBe('linea 1 linea 2');
    // Con un separador dentro sí lleva comillas, además del aplanado.
    expect(csvCell('uno; dos\ntres')).toBe('"uno; dos tres"');
  });

  it('deja la celda vacía cuando no hay dato', () => {
    expect(csvCell(null)).toBe('');
    expect(csvCell(undefined)).toBe('');
    const csv = buildCsv(columns, [{ fecha: '2026-10-04', paciente: null, tasa: null }]);
    expect(csv.replace(CSV_BOM, '').split('\r\n')[1]).toBe('2026-10-04;;');
  });

  it('exporta solo las columnas declaradas, en su orden', () => {
    const csv = buildCsv(columns, [
      { tasa: 3, sobrante: 'no debe salir', paciente: 'Luis', fecha: '2026-01-01' },
    ]);
    expect(csv.replace(CSV_BOM, '').split('\r\n')[1]).toBe('2026-01-01;Luis;3');
    expect(csv).not.toContain('no debe salir');
  });

  it('con cero filas deja la cabecera', () => {
    expect(buildCsv(columns, []).replace(CSV_BOM, '')).toBe('Fecha;Paciente;Tasa\r\n');
  });
});
