import {
  bsPaymentBreakdown,
  divisasPaymentBreakdown,
  findPaymentMethod,
  formatRateMicros,
  igtfDecision,
  igtfToCollectCents,
  invoiceTotalsFromItems,
  ivaCentsForItem,
  IVA_GENERAL_BASIS_POINTS,
  MANUAL_LINE_CODE,
  usdCentsFromVes,
  vesCentimosFromUsd,
  type BillingDraftItem,
  type DraftItemInput,
  type ImputationPolicy,
  type InvoiceTotals,
  type PaymentMethodCode,
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
 * Lo que se teclea a céntimos: «12,34» → 1234, «12» → 1200, «12.5» → 1250,
 * «1.234,56» → 123456, «1,234.56» → 123456, «6.000» → 600000.
 *
 * Acepta el **separador de miles** porque es como se escribe lo que la propia pantalla
 * autocompleta (`formatBs`/`formatUsd` usan `es-VE`: «6.000,00»). Antes ese texto se
 * rechazaba y el campo quedaba inválido: había que volver a teclear el monto a mano —y
 * al redondearlo al bolívar entero aparecía un diferencial cambiario de céntimos que en
 * realidad era solo ruido de redondeo (ADR 0069)—.
 *
 * La regla: exactamente **dos decimales** como mucho, y los grupos de tres dígitos son
 * miles. Un punto con tres dígitos detrás es un grupo de miles («6.000»), porque un
 * importe de tres decimales no existe; una coma con tres dígitos («12,345») se rechaza
 * —la coma es el decimal de `es-VE`—. Lo que no encaja no se adivina: devuelve `null`.
 */
export const parseUsdToCents = (texto: string): number | null => {
  const limpio = texto.trim().replace(/\s/g, '');
  if (limpio === '') return null;

  const ultimaComa = limpio.lastIndexOf(',');
  const ultimoPunto = limpio.lastIndexOf('.');
  let normalizado = limpio;

  if (ultimaComa !== -1 && ultimoPunto !== -1) {
    // Los dos separadores: el último es el decimal y el otro agrupa los miles.
    const decimal = ultimaComa > ultimoPunto ? ',' : '.';
    const miles = decimal === ',' ? '.' : ',';
    const [enteros = '', decimales = ''] = limpio.split(decimal);
    const grupoMiles = miles === '.' ? /^\d{1,3}(?:\.\d{3})*$/ : /^\d{1,3}(?:,\d{3})*$/;
    if (!grupoMiles.test(enteros)) return null;
    if (!/^\d{1,2}$/.test(decimales)) return null;
    normalizado = `${enteros.split(miles).join('')}.${decimales}`;
  } else if (ultimaComa !== -1) {
    // Solo comas: es el decimal de `es-VE`, así que no puede haber grupos de miles.
    const partes = limpio.split(',');
    if (partes.length !== 2 || !/^\d{1,2}$/.test(partes[1] ?? '')) return null;
    normalizado = `${partes[0] ?? ''}.${partes[1] ?? ''}`;
  } else if (ultimoPunto !== -1) {
    const partes = limpio.split('.');
    if (partes.length > 2) {
      // Varios puntos solo pueden ser grupos de miles («1.234.567»).
      const [, ...grupos] = partes;
      if (!grupos.every((grupo) => /^\d{3}$/.test(grupo))) return null;
      if (!/^\d{1,3}$/.test(partes[0] ?? '')) return null;
      normalizado = partes.join('');
    } else {
      const [enteros = '', resto = ''] = partes;
      // Tres dígitos detrás de un punto son miles: el dinero tiene dos decimales como mucho.
      if (resto.length === 3) {
        if (!/^\d{1,3}$/.test(enteros)) return null;
        normalizado = `${enteros}${resto}`;
      } else if (/^\d{1,2}$/.test(resto)) {
        normalizado = `${enteros}.${resto}`;
      } else {
        return null;
      }
    }
  }

  if (!/^\d{1,9}(?:\.\d{1,2})?$/.test(normalizado)) return null;
  const [enteros = '0', decimales = ''] = normalizado.split('.');
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

/**
 * Una partida **escrita a mano** en la caja: no viene del arancel, así que declara su descripción y
 * su categoría fiscal. Se reconoce por el código centinela (`MANUAL_LINE_CODE`), que es también el
 * que decide en el servicio de dónde sale la categoría.
 */
export const esLineaManual = (linea: Pick<EditableLine, 'code'>): boolean =>
  linea.code === MANUAL_LINE_CODE;

/** Lo que se ve en la columna del total: sin redondeo, es una multiplicación exacta. */
export const lineTotalCents = (linea: Pick<EditableLine, 'priceText' | 'quantity'>): number => {
  const cents = parseUsdToCents(linea.priceText);
  return cents === null ? 0 : cents * linea.quantity;
};

/** ¿Se puede guardar? Todas las líneas necesitan un precio legible y, las **escritas a mano**, una
 * descripción: sin ella la factura no diría qué se vendió. */
export const linesReady = (lineas: readonly EditableLine[]): boolean =>
  lineas.every(
    (linea) =>
      parseUsdToCents(linea.priceText) !== null &&
      (!esLineaManual(linea) || linea.description.trim() !== ''),
  );

/** Falta la descripción de alguna partida escrita a mano: la pantalla lo avisa antes de emitir. */
export const faltaDescripcionManual = (lineas: readonly EditableLine[]): boolean =>
  lineas.some((linea) => esLineaManual(linea) && linea.description.trim() === '');

/** La lista completa que espera el servicio: quitar una línea es no mandarla. */
export const toDraftItems = (lineas: readonly EditableLine[]): DraftItemInput[] =>
  lineas.map((linea) => ({
    code: linea.code,
    quantity: linea.quantity,
    unitPriceCentsUsd: parseUsdToCents(linea.priceText) ?? 0,
    description: linea.description === '' ? null : linea.description,
    toothNumber: linea.toothNumber,
    surfaces: linea.surfaces,
    // En las partidas del arancel el servicio la ignora; en las escritas a mano la aplica.
    taxCategory: linea.taxCategory,
  }));

/* ── Los totales de lo que hay en pantalla ─────────────────────────────────── */

/** La alícuota que el servicio copiará en una partida nueva, según su categoría. */
export const taxRateForCategory = (category: TaxCategory): number =>
  category === 'general' ? IVA_GENERAL_BASIS_POINTS : 0;

/**
 * La partida que añade «Añadir línea manual»: vacía y **exenta** por defecto (el caso más común en
 * un servicio odontológico), con el precio por escribir y la descripción por completar.
 */
export const nuevaLineaManual = (): EditableLine => ({
  code: MANUAL_LINE_CODE,
  description: '',
  toothNumber: null,
  surfaces: [],
  quantity: 1,
  priceText: '',
  taxCategory: 'exento',
  taxRateBasisPoints: taxRateForCategory('exento'),
  needsPricing: true,
});

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
  /** Imputación histórica a la tasa de emisión (ADR 0069); `null` si aún no se puede calcular. */
  historicalVesCentimos: number | null;
  /** Diferencial cambiario que quedará registrado (positivo = ganancia, negativo = pérdida). */
  exchangeDiffVesCentimos: number | null;
  /**
   * La tolerancia ±0,05 USD absorbió el residuo del cobro y con él se salda el **100 %** de la deuda:
   * es el badge «ajuste de redondeo absorbido» (ADR 0069).
   */
  absorbeRedondeo: boolean;
}

const PREVISUALIZACION_VACIA: ImputacionPrevista = {
  cents: null,
  aviso: null,
  historicalVesCentimos: null,
  exchangeDiffVesCentimos: null,
  absorbeRedondeo: false,
};

/**
 * Lo que se va a imputar con lo tecleado, **con la regla del servidor**: la moneda la declara el medio
 * de pago y la descomposición (imputado / histórico / diferencial, con la tolerancia de ±0,05 USD) la
 * hacen los helpers del **contrato** (`bsPaymentBreakdown`, `divisasPaymentBreakdown`), así que es la
 * misma que va a hacer el servicio: la pantalla **no** tiene su propia aritmética de dinero.
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
    return {
      ...PREVISUALIZACION_VACIA,
      aviso: 'Escribe el monto que entregó el paciente (por ejemplo 12,34).',
    };
  }

  const moneda = findPaymentMethod(input.method)?.currency ?? 'VES';
  const tasaEmision = input.invoiceRateMicros;

  if (moneda === 'USD') {
    if (tecleado > input.balanceCentsUsd) {
      return {
        ...PREVISUALIZACION_VACIA,
        cents: tecleado,
        aviso: 'El monto supera el saldo.',
      };
    }
    // En divisas no hay diferencial cambiario; lo histórico se valora a la tasa de emisión.
    const desglose =
      tasaEmision === null || tasaEmision <= 0
        ? null
        : divisasPaymentBreakdown({
            tenderedCentsUsd: tecleado,
            balanceCentsUsd: input.balanceCentsUsd,
            rateEmissionMicros: tasaEmision,
          });
    return {
      cents: tecleado,
      aviso: null,
      historicalVesCentimos: desglose?.historicalVesCentimos ?? null,
      exchangeDiffVesCentimos: desglose?.exchangeDiffVesCentimos ?? null,
      absorbeRedondeo: false,
    };
  }

  const tasa = input.policy === 'tasa_de_la_factura' ? tasaEmision : input.rateMicros;
  if (tasa === null || tasa <= 0) {
    return {
      ...PREVISUALIZACION_VACIA,
      aviso: 'No hay tasa publicada: fíjala antes de cobrar.',
    };
  }
  const desglose = bsPaymentBreakdown({
    tenderedVesCentimos: tecleado,
    balanceCentsUsd: input.balanceCentsUsd,
    rateEmissionMicros: tasaEmision ?? tasa,
    ratePaymentMicros: tasa,
  });
  if (desglose === null) {
    return {
      ...PREVISUALIZACION_VACIA,
      cents: usdCentsFromVes(tecleado, tasa),
      aviso: 'El monto supera el saldo.',
    };
  }
  return {
    cents: desglose.amountCentsUsd,
    aviso: null,
    historicalVesCentimos: desglose.historicalVesCentimos,
    exchangeDiffVesCentimos: desglose.exchangeDiffVesCentimos,
    absorbeRedondeo: desglose.absorbsRounding,
  };
};

/** Lo que se causa por IGTF en un cobro (ADR 0069): solo lo que percibe la clínica. */
export interface IgtfPrevisto {
  /** `true` cuando este cobro tiene IGTF que la clínica percibe y debe declararse. */
  aplica: boolean;
  /** La alícuota copiada al cobro, en puntos básicos (300 = 3,00 %). */
  basisPoints: number;
  /** El tributo en céntimos de USD. */
  amountCentsUsd: number;
  /** El mismo tributo en bolívares, a la tasa del cobro (`null` sin tasa). */
  amountVesCentimos: number | null;
  /** Por qué no aplica (o qué implica): es lo que muestra la pantalla de caja. */
  motivo: string;
}

/**
 * El IGTF previsto de un cobro, con **la misma regla que el servicio**: la causa la decide el medio de
 * pago y la calificación de la clínica (`igtfDecision`), y la alícuota viene de la configuración.
 */
export const igtfPrevisto = (input: {
  method: string;
  amountCentsUsd: number;
  rateMicros: number | null;
  isSpecialTaxpayer: boolean;
  igtfRateBp: number;
}): IgtfPrevisto => {
  const decision = igtfDecision({
    method: input.method as PaymentMethodCode,
    isSpecialTaxpayer: input.isSpecialTaxpayer,
    basisPoints: input.igtfRateBp,
  });
  const aplica = decision.applies && decision.perceivedBy === 'clinica';
  const amountCentsUsd = aplica ? igtfToCollectCents(decision, input.amountCentsUsd) : 0;
  return {
    aplica,
    basisPoints: decision.basisPoints,
    amountCentsUsd,
    amountVesCentimos:
      input.rateMicros === null || input.rateMicros <= 0
        ? null
        : vesCentimosFromUsd(amountCentsUsd, input.rateMicros),
    motivo: decision.reason,
  };
};
