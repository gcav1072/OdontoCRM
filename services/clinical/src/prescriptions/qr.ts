import qrcode from 'qrcode-generator';

/**
 * Código QR del récipe, **sin dependencias nativas**: `qrcode-generator` produce el
 * SVG y aquí se dibuja como SVG en línea, así que el PDF no lleva imágenes
 * incrustadas ni hace falta un codificador de PNG.
 *
 * El contenido es la URL de verificación (`<PUBLIC_APP_URL>/verificar/<código>`): el
 * QR se lee con la cámara del teléfono y abre la página que confirma que el papel es
 * auténtico, sin exponer datos clínicos (ADR 0015).
 */

/** Corrección de errores media: aguanta que el papel se doble o se manche un poco. */
const ERROR_CORRECTION = 'M';

/**
 * SVG del QR, listo para meter en el HTML del récipe.
 *
 * `cellSize` está en milímetros de papel (el HTML del PDF usa mm): 0,6 mm por módulo
 * deja un QR de unos 20 mm en la mitad del paciente, que se lee bien desde un teléfono.
 */
export const qrSvg = (content: string, cellSizeMm = 0.6): string => {
  const qr = qrcode(0, ERROR_CORRECTION);
  qr.addData(content);
  qr.make();

  return qr.createSvgTag({
    cellSize: cellSizeMm,
    margin: 0,
    scalable: true,
  });
};

/**
 * Matriz de módulos del QR (1 = oscuro). La usa la prueba de ida y vuelta para
 * **leer** el código que se imprime y comprobar que apunta a donde debe.
 */
export const qrModules = (content: string): boolean[][] => {
  const qr = qrcode(0, ERROR_CORRECTION);
  qr.addData(content);
  qr.make();

  const count = qr.getModuleCount();
  return Array.from({ length: count }, (_, row) =>
    Array.from({ length: count }, (_, column) => qr.isDark(row, column)),
  );
};
