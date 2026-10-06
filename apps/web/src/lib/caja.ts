import type { BillingDraftItem, DraftItemInput, ToothSurface } from '@odontocrm/contracts';

/**
 * Piezas puras de la caja (Fase 11): cómo se escribe el dinero, cómo se convierte lo que se teclea y
 * cómo se manda la lista completa al servicio.
 *
 * **La aritmética del dinero no se reimplementa aquí**: los totales que se muestran son los que
 * calcula el servidor con el contrato (`invoiceTotalsFromItems`), porque el redondeo tiene que ser el
 * mismo en las dos puntas. Lo único que se multiplica en pantalla es `precio × cantidad`, que no
 * redondea nada.
 */

/** Céntimos de USD como se escriben en el mostrador: `1234` → «12,34». */
export const formatUsd = (cents: number): string =>
  (cents / 100).toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/**
 * Lo que se teclea a céntimos: «12,34» → 1234, «12» → 1200, «12.5» → 1250.
 * Devuelve `null` si no es un importe: la pantalla avisa en vez de mandar un cero silencioso.
 */
export const parseUsdToCents = (texto: string): number | null => {
  const limpio = texto.trim().replace(',', '.');
  if (!/^\d{1,9}(\.\d{1,2})?$/.test(limpio)) return null;
  const [enteros = '0', decimales = ''] = limpio.split('.');
  return Number(enteros) * 100 + Number(decimales.padEnd(2, '0'));
};

/** Una línea tal como se edita en pantalla: el precio va en texto, como se teclea. */
export interface EditableLine {
  code: string;
  description: string;
  toothNumber: number | null;
  surfaces: ToothSurface[];
  quantity: number;
  priceText: string;
  /** El precio no venía del arancel (o venía en 0): la caja lo tiene que escribir. */
  needsPricing: boolean;
}

export const toEditableLine = (item: BillingDraftItem): EditableLine => ({
  code: item.code,
  description: item.description,
  toothNumber: item.toothNumber,
  // Las caras las garantiza el contrato al guardarlas; el tipo del contrato las pide nombradas.
  surfaces: (item.surfaces ?? []) as ToothSurface[],
  quantity: item.quantity,
  priceText: item.unitPriceCentsUsd === 0 ? '' : formatUsd(item.unitPriceCentsUsd),
  needsPricing: item.needsPricing,
});

/** Lo que se ve en la columna del total: sin redondeo, es una multiplicación exacta. */
export const lineTotalCents = (linea: Pick<EditableLine, 'priceText' | 'quantity'>): number => {
  const cents = parseUsdToCents(linea.priceText);
  return cents === null ? 0 : cents * linea.quantity;
};

/** ¿Se puede guardar? Todas las líneas necesitan un precio legible. */
export const linesReady = (lineas: readonly EditableLine[]): boolean =>
  lineas.every((linea) => parseUsdToCents(linea.priceText) !== null);

/** La lista completa que espera el servicio: quitar una línea es no mandarla. */
export const toDraftItems = (lineas: readonly EditableLine[]): DraftItemInput[] =>
  lineas.map((linea) => ({
    code: linea.code,
    quantity: linea.quantity,
    unitPriceCentsUsd: parseUsdToCents(linea.priceText) ?? 0,
    description: linea.description === '' ? null : linea.description,
    toothNumber: linea.toothNumber,
    surfaces: linea.surfaces,
  }));
