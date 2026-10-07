import {
  findPaymentMethod,
  formatRateMicros,
  invoiceTotalsFromItems,
  ivaCentsForItem,
  IVA_GENERAL_BASIS_POINTS,
  usdCentsFromVes,
  vesCentimosFromUsd,
  type BillingDraftItem,
  type DraftItemInput,
  type ImputationPolicy,
  type InvoiceTotals,
  type TaxCategory,
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
  /**
   * La categoría fiscal **copiada** de la partida: decide si el IVA se suma (un bien
   * gravado) o no (un servicio odontológico exento). Sin ella, la pantalla no puede
   * mostrar el total en vivo sin equivocarse en el IVA.
   */
  taxCategory: TaxCategory;
  /** La alícuota vigente copiada en la partida (puntos básicos; 1600 = 16 %). */
  taxRateBasisPoints: number;
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
  taxCategory: item.taxCategory,
  taxRateBasisPoints: item.taxRateBasisPoints,
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

/* ── Los totales de lo que hay en pantalla ─────────────────────────────────── */

/** La alícuota que el servicio copiará en una partida nueva, según su categoría. */
export const taxRateForCategory = (category: TaxCategory): number =>
  category === 'general' ? IVA_GENERAL_BASIS_POINTS : 0;

/**
 * Los totales **de lo que se ve en pantalla**, sumando las partidas con los mismos ayudantes
 * del contrato que usa el servicio (`invoiceTotalsFromItems` e `ivaCentsForItem`). No es una
 * segunda aritmética: es la misma cuenta, hecha antes de guardar.
 *
 * Sin esto el total solo se movía al pulsar «Guardar cambios», y añadir un bien al arancel
 * parecía no cambiar nada (y el IVA de un bien gravado no aparecía hasta después).
 */
export const liveInvoiceTotals = (lineas: readonly EditableLine[]): InvoiceTotals =>
  invoiceTotalsFromItems(
    lineas.map((linea) => {
      const base = lineTotalCents(linea);
      return {
        totalPriceCentsUsd: base,
        taxCategory: linea.taxCategory,
        ivaAmountCentsUsd: ivaCentsForItem({
          baseCentsUsd: base,
          taxCategory: linea.taxCategory,
          taxRateBasisPoints: linea.taxRateBasisPoints,
        }),
      };
    }),
  );

/* ── El historial: qué se puede hacer con cada documento ───────────────────── */

/** Lo mínimo del historial para decidir los botones: el estado del documento. */
export interface DocumentoDelHistorial {
  status: string;
}

/**
 * Un **borrador** se puede descartar (nunca fue documento: no lleva nota de crédito) y una factura
 * emitida se anula con nota. Una **pagada** no: primero hay que devolver sus cobros, y eso lo dice la
 * propia pantalla (el servicio lo rechaza con un 409 explicado).
 */
export const puedeDescartarse = (documento: DocumentoDelHistorial): boolean =>
  documento.status === 'borrador';

/** Se cobra lo que está emitido y no está pagado: `emitida` (entera) o `parcial` (el resto). */
export const puedeCobrarse = (documento: DocumentoDelHistorial): boolean =>
  documento.status === 'emitida' || documento.status === 'parcial';

/** Se anula con nota de crédito lo emitido que **no** está cobrado del todo. */
export const puedeAnularse = (documento: DocumentoDelHistorial): boolean =>
  documento.status === 'emitida' || documento.status === 'parcial';

/** Lo que tiene papel archivado: todo lo emitido, anulado incluido (el PDF no se borra, ADR 0048). */
export const puedeReimprimirse = (documento: DocumentoDelHistorial): boolean =>
  documento.status !== 'borrador';

/** La palabra del mostrador sobre el papel: «sin reimprimir» no es lo mismo que «reimpresa 3 veces». */
export const reimpresionesEnTexto = (printCount: number): string =>
  printCount === 0
    ? 'Sin reimprimir'
    : `Reimpresa ${String(printCount)} ${printCount === 1 ? 'vez' : 'veces'}`;

/** Los bolívares, como se escriben en el mostrador: `73084` céntimos → «730,84». */
export const formatBs = (centimos: number): string =>
  (centimos / 100).toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** Filtros del historial tal como los maneja la pantalla (vacíos = sin filtrar). */
export interface FiltrosDelHistorial {
  status: string;
  from: string;
  to: string;
  search: string;
}

export const FILTROS_VACIOS: FiltrosDelHistorial = { status: '', from: '', to: '', search: '' };

export const hayFiltros = (filtros: FiltrosDelHistorial): boolean =>
  filtros.status !== '' || filtros.from !== '' || filtros.to !== '' || filtros.search.trim() !== '';

/**
 * Lo que se manda al servicio: el vacío se omite para no mandar filtros en blanco, y el texto se
 * recorta. La página la pide el servidor, que es quien pagina.
 */
export const aParametrosDeConsulta = (
  filtros: FiltrosDelHistorial,
  pagina: number,
  porPagina: number,
): {
  status?: string;
  from?: string;
  to?: string;
  search?: string;
  page: number;
  pageSize: number;
} => ({
  ...(filtros.status === '' ? {} : { status: filtros.status }),
  ...(filtros.from === '' ? {} : { from: filtros.from }),
  ...(filtros.to === '' ? {} : { to: filtros.to }),
  ...(filtros.search.trim() === '' ? {} : { search: filtros.search.trim() }),
  page: pagina,
  pageSize: porPagina,
});

/** El rango inválido (desde > hasta) se avisa antes de consultar, como en la auditoría. */
export const rangoInvalido = (filtros: FiltrosDelHistorial): boolean =>
  filtros.from !== '' && filtros.to !== '' && filtros.from > filtros.to;

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
