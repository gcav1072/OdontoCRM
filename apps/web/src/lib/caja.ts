import {
  findPaymentMethod,
  formatRateMicros,
  usdCentsFromVes,
  vesCentimosFromUsd,
  type BillingDraftItem,
  type DraftItemInput,
  type ImputationPolicy,
  type ToothSurface,
} from '@odontocrm/contracts';

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

/* ── Emitir y cobrar (ADR 0046 y 0048) ────────────────────────────────────── */

/** Lo mínimo de una factura para decidir qué se puede hacer con ella en el mostrador. */
export interface FacturaParaCobrar {
  status: string;
  totalCentsUsd: number;
  balanceCentsUsd: number;
}

/** La palabra del mostrador: «Sin emitir» no es «Por cobrar», y confundirlas cuesta dinero. */
export const estadoDeFactura = (factura: FacturaParaCobrar): string => {
  if (factura.status === 'borrador') return 'Sin emitir';
  if (factura.status === 'anulada') return 'Anulada';
  if (factura.status === 'pagada') return 'Pagada';
  if (factura.status === 'parcial') return 'Abonada';
  return 'Por cobrar';
};

/** Un borrador se emite cuando tiene partidas y **todas** tienen precio. */
export const puedeEmitirse = (lineas: readonly EditableLine[]): boolean =>
  lineas.length > 0 && linesReady(lineas);

/** El saldo en bolívares a la tasa **congelada** de la factura (`null` si aún no tiene). */
export const saldoEnBs = (balanceCentsUsd: number, rateMicros: number | null): number | null =>
  rateMicros === null || rateMicros <= 0 ? null : vesCentimosFromUsd(balanceCentsUsd, rateMicros);

/** La tasa como se escribe en el mostrador. */
export const tasaEnTexto = (rateMicros: number | null): string =>
  rateMicros === null || rateMicros <= 0 ? '—' : formatRateMicros(rateMicros);

export interface ImputacionPrevista {
  /** Lo que se imputará a la deuda, en céntimos de USD. `null` si lo tecleado no es un importe. */
  cents: number | null;
  /** Lo que hay que avisar antes de cobrar (o `null` si todo está en orden). */
  aviso: string | null;
}

/**
 * Lo que se va a imputar con lo tecleado, **con la regla del servidor**: la moneda la declara el medio
 * de pago y, en bolívares, la política decide si se imputa a la tasa del pago o a la de la factura. La
 * cuenta la hacen los helpers del contrato, así que es la misma que va a hacer el servicio: la pantalla
 * **no** tiene su propia aritmética de dinero.
 */
export const imputacionPrevista = (input: {
  tenderedText: string;
  method: string;
  rateMicros: number | null;
  invoiceRateMicros: number | null;
  policy: ImputationPolicy;
  balanceCentsUsd: number;
}): ImputacionPrevista => {
  const tecleado = parseUsdToCents(input.tenderedText);
  if (tecleado === null || tecleado <= 0) {
    return { cents: null, aviso: 'Escribe el monto que entregó el paciente (por ejemplo 12,34).' };
  }

  const moneda = findPaymentMethod(input.method)?.currency ?? 'VES';
  if (moneda === 'USD') {
    return {
      cents: tecleado,
      aviso: tecleado > input.balanceCentsUsd ? 'El monto supera el saldo.' : null,
    };
  }

  const tasa = input.policy === 'tasa_de_la_factura' ? input.invoiceRateMicros : input.rateMicros;
  if (tasa === null || tasa <= 0) {
    return { cents: null, aviso: 'No hay tasa publicada: fíjala antes de cobrar.' };
  }
  const cents = usdCentsFromVes(tecleado, tasa);
  return { cents, aviso: cents > input.balanceCentsUsd ? 'El monto supera el saldo.' : null };
};
