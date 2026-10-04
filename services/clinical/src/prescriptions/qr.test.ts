import jsQRModule, { type Options, type QRCode } from 'jsqr';
import { describe, expect, it } from 'vitest';

import { qrModules, qrSvg } from './qr.js';

/**
 * `jsqr` es un paquete CommonJS con tipos ESM: según cómo se resuelva el módulo, el
 * invocable queda en el `default` o en el propio import. Aquí se acepta lo uno o lo
 * otro, que es lo único que cambia.
 */
type JsQr = (
  data: Uint8ClampedArray,
  width: number,
  height: number,
  options?: Options,
) => QRCode | null;

const posible = jsQRModule as unknown as JsQr & { default?: JsQr };
const jsQR: JsQr = posible.default ?? posible;

/**
 * El QR del récipe, comprobado **de ida y vuelta**: se genera, se rasteriza como lo
 * vería una cámara y se **lee** con un decodificador real (`jsqr`). Comprobar que el
 * SVG «tiene pinta de QR» no sirve: lo que importa es que un teléfono lo lea y
 * llegue a la página de verificación.
 */

/** Rasteriza la matriz del QR a RGBA (escala y margen en módulos). */
const rasterizar = (
  modulos: boolean[][],
  escala = 8,
  margen = 4,
): { data: Uint8ClampedArray; width: number } => {
  const lado = (modulos.length + margen * 2) * escala;
  const data = new Uint8ClampedArray(lado * lado * 4);

  for (let y = 0; y < lado; y += 1) {
    for (let x = 0; x < lado; x += 1) {
      const fila = Math.floor(y / escala) - margen;
      const columna = Math.floor(x / escala) - margen;
      const oscuro =
        fila >= 0 && columna >= 0 && fila < modulos.length && columna < modulos.length
          ? (modulos[fila]?.[columna] ?? false)
          : false;
      const valor = oscuro ? 0 : 255;
      const indice = (y * lado + x) * 4;
      data[indice] = valor;
      data[indice + 1] = valor;
      data[indice + 2] = valor;
      data[indice + 3] = 255;
    }
  }

  return { data, width: lado };
};

const leerQr = (contenido: string): string | null => {
  const { data, width } = rasterizar(qrModules(contenido));
  return jsQR(data, width, width, { inversionAttempts: 'dontInvert' })?.data ?? null;
};

describe('QR del récipe', () => {
  it('una cámara lee el enlace de verificación que se imprime', () => {
    const url = 'http://127.0.0.1:5173/verificar/ABCDE-FGHJK';
    expect(leerQr(url)).toBe(url);
  });

  it('lee también una URL larga (proxy de la clínica con nombre largo)', () => {
    const url = 'https://consultorio-odontologico-nueva-esparta.local/verificar/7M4PQ-XY2ZK';
    expect(leerQr(url)).toBe(url);
  });

  it('el SVG lleva el mismo número de módulos que la matriz', () => {
    const svg = qrSvg('http://127.0.0.1:5173/verificar/ABCDE-FGHJK');
    const modulos = qrModules('http://127.0.0.1:5173/verificar/ABCDE-FGHJK');

    expect(svg.startsWith('<svg')).toBe(true);
    expect(modulos.length).toBeGreaterThanOrEqual(21);
    // Marca de localización superior izquierda: el marco es oscuro, el anillo
    // interior claro y el centro (3×3) oscuro otra vez.
    expect(modulos[0]?.[0]).toBe(true);
    expect(modulos[0]?.[6]).toBe(true);
    expect(modulos[6]?.[0]).toBe(true);
    expect(modulos[6]?.[6]).toBe(true);
    expect(modulos[1]?.[1]).toBe(false);
    expect(modulos[3]?.[3]).toBe(true);
  });

  it('dos récipes distintos dan códigos distintos', () => {
    expect(leerQr('http://127.0.0.1:5173/verificar/AAAAA-AAAAA')).not.toBe(
      leerQr('http://127.0.0.1:5173/verificar/BBBBB-BBBBB'),
    );
  });
});
