import { describe, expect, it } from 'vitest';

import { problemasDeGuionCmd, problemasDeGuionPs1 } from './scripts-windows.mjs';

/**
 * El fallo que motivó este verificador: `infra/windows/odontocrm.ps1` se guardó sin
 * BOM y en PowerShell 5.1 el `odontocrm` de la PC dejó de arrancar con
 * `MissingEndCurlyBrace`. Las dos reglas (BOM en `.ps1`, ASCII en `.cmd`) se prueban
 * aquí con buffers, sin depender de los archivos del repositorio.
 */
const BOM = Buffer.from([0xef, 0xbb, 0xbf]);

const ps1 = (texto, conBom = true) =>
  Buffer.concat([conBom ? BOM : Buffer.alloc(0), Buffer.from(texto, 'utf8')]);

describe('guiones .ps1: UTF-8 con BOM', () => {
  it('un .ps1 con BOM y acentos es válido', () => {
    expect(
      problemasDeGuionPs1('ok.ps1', ps1("# OdontoCRM · año 2026\r\nWrite-Host 'listo ✔'")),
    ).toEqual([]);
  });

  it('un .ps1 sin BOM se detecta (el fallo real de noviembre de 2026)', () => {
    const problemas = problemasDeGuionPs1('sin-bom.ps1', ps1('Write-Host «hola»', false));
    expect(problemas).toHaveLength(1);
    expect(problemas[0]).toContain('BOM');
    expect(problemas[0]).toContain('sin-bom.ps1');
  });

  it('un .ps1 con BOM pero con bytes que no son UTF-8 se detecta', () => {
    const roto = Buffer.concat([BOM, Buffer.from([0x57, 0x72, 0x69, 0x74, 0x65, 0xff, 0xfe])]);
    const problemas = problemasDeGuionPs1('roto.ps1', roto);
    expect(problemas).toHaveLength(1);
    expect(problemas[0]).toContain('UTF-8 válido');
  });
});

describe('lanzadores .cmd/.bat: ASCII puro', () => {
  it('un .cmd ASCII sin BOM es válido', () => {
    const bytes = Buffer.from(
      '@echo off\r\npowershell -NoProfile -File "%~dp0cli.ps1" %*\r\n',
      'ascii',
    );
    expect(problemasDeGuionCmd('odontocrm.cmd', bytes)).toEqual([]);
  });

  it('un .cmd con acentos se detecta (cmd.exe usa la página OEM)', () => {
    const bytes = Buffer.from('rem Codificación de la consola\r\n@echo off\r\n', 'utf8');
    const problemas = problemasDeGuionCmd('acentos.cmd', bytes);
    expect(problemas).toHaveLength(1);
    expect(problemas[0]).toContain('no ASCII');
  });

  it('un .cmd con BOM se detecta', () => {
    const bytes = Buffer.concat([BOM, Buffer.from('@echo off\r\n', 'ascii')]);
    const problemas = problemasDeGuionCmd('bom.cmd', bytes);
    expect(problemas.some((problema) => problema.includes('BOM'))).toBe(true);
  });
});
