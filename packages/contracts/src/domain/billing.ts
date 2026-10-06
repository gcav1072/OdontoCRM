import { z } from 'zod';

import { optionalText } from '../common/optional.js';
import { INVOICE_STATUSES, type InvoiceStatus, type Role } from './enums.js';
import { toothNumberSchema, toothSurfaceSchema } from './odontogram.js';

/**
 * Módulo de facturación y pagos (Fase 11) — contrato compartido.
 *
 * Este archivo es la **única fuente** de los estados, las categorías fiscales, los medios de pago y
 * la aritmética del dinero: la base de datos, la API y la interfaz usan exactamente lo mismo, como
 * hace `clinical-session.ts` con el documento del día.
 *
 * Decisiones registradas (no se reabren aquí):
 * [ADR 0044](../../../docs/adr/0044-modulo-de-facturacion-desacoplado.md) — servicio desacoplado,
 * dinero en enteros y borrador idempotente desde la sesión clínica;
 * [ADR 0045](../../../docs/adr/0045-regimen-tributario-iva-e-igtf.md) — servicios exentos, bienes al
 * 16 % y el IGTF como dato del medio de pago;
 * [ADR 0046](../../../docs/adr/0046-tasa-bcv-historica-y-regla-de-imputacion.md) — tasa histórica,
 * congelada por documento y regla de imputación;
 * [ADR 0047](../../../docs/adr/0047-quien-asigna-el-numero-de-la-factura.md) — quién asigna el
 * número; [ADR 0048](../../../docs/adr/0048-el-documento-de-cobro-se-archiva.md) — emitir es
 * congelar y anular no es borrar.
 */

/* ── 1. Estados y transiciones (la máquina, como dato) ─────────────────────── */

/**
 * Una transición de la factura. Igual que `APPOINTMENT_TRANSITIONS`, es **dato**: la interfaz, la
 * API y las pruebas usan las mismas reglas en vez de repetir `if`.
 *
 * `roles` vacío significa **transición automática**: no la ejecuta una persona, la provoca el saldo
 * (un cobro, una anulación de cobro). Por eso no se ofrecen como botones.
 */
export interface InvoiceTransition {
  readonly from: InvoiceStatus;
  readonly to: InvoiceStatus;
  /** Roles autorizados además de `admin`, que puede todo. Vacío = automática. */
  readonly roles: readonly Role[];
  readonly label: string;
  /** `true` si exige un motivo escrito (queda en la auditoría). */
  readonly requiresReason?: boolean;
}

/**
 * §3.1 del plan de la fase, con dos precisiones que el documento cerraba en otro sitio:
 *
 * 1. **Anular es de la secretaría también**, no solo del `admin` (decisión del 2026-10-05, §5.4 y
 *    §3.5): atiende sola el mostrador, así que anula con motivo y queda auditado.
 * 2. **`pagada` también retrocede** cuando se anula un cobro (§9.10: «el saldo vuelve y el estado
 *    retrocede»); sin esas dos aristas, una factura cobrada de más se quedaría sin salida.
 *
 * Descartar un borrador exige motivo porque el `CHECK` de la tabla lo exige para **cualquier** fila
 * en `anulada` (`chk_invoices_void_reason`), no solo para las que consumieron número fiscal.
 */
export const INVOICE_TRANSITIONS: readonly InvoiceTransition[] = [
  { from: 'borrador', to: 'emitida', roles: ['secretario'], label: 'Emitir la factura' },
  {
    from: 'borrador',
    to: 'anulada',
    roles: ['secretario'],
    label: 'Descartar el borrador',
    requiresReason: true,
  },
  { from: 'emitida', to: 'parcial', roles: [], label: 'Un cobro dejó saldo' },
  { from: 'emitida', to: 'pagada', roles: [], label: 'Saldo cero' },
  { from: 'parcial', to: 'pagada', roles: [], label: 'Saldo cero' },
  { from: 'parcial', to: 'emitida', roles: [], label: 'Se anuló un cobro y volvió el saldo' },
  { from: 'pagada', to: 'parcial', roles: [], label: 'Se anuló un cobro y quedó saldo' },
  { from: 'pagada', to: 'emitida', roles: [], label: 'Se anuló un cobro y volvió el saldo' },
  {
    from: 'emitida',
    to: 'anulada',
    roles: ['secretario'],
    label: 'Anular con nota de crédito',
    requiresReason: true,
  },
  {
    from: 'parcial',
    to: 'anulada',
    roles: ['secretario'],
    label: 'Anular con nota de crédito',
    requiresReason: true,
  },
  {
    from: 'pagada',
    to: 'anulada',
    roles: ['secretario'],
    label: 'Anular con nota de crédito',
    requiresReason: true,
  },
] as const;

/** `anulada` no vuelve: no tiene salida, y es lo único que no la tiene. */
export const TERMINAL_INVOICE_STATUSES = ['anulada'] as const;

export const isTerminalInvoiceStatus = (status: InvoiceStatus): boolean =>
  TERMINAL_INVOICE_STATUSES.some((terminal) => terminal === status);

export const invoiceTransitionsFrom = (from: InvoiceStatus): readonly InvoiceTransition[] =>
  INVOICE_TRANSITIONS.filter((transition) => transition.from === from);

/** Las que puede ejecutar una persona con ese rol: las automáticas no se ofrecen. */
export const invoiceTransitionsFor = (
  from: InvoiceStatus,
  role: Role,
): readonly InvoiceTransition[] =>
  invoiceTransitionsFrom(from).filter(
    (transition) =>
      transition.roles.length > 0 && (role === 'admin' || transition.roles.includes(role)),
  );

/** Las que provoca el saldo, no una persona. */
export const automaticInvoiceTransitions = (from: InvoiceStatus): readonly InvoiceTransition[] =>
  invoiceTransitionsFrom(from).filter((transition) => transition.roles.length === 0);

export const canTransitionInvoice = (from: InvoiceStatus, to: InvoiceStatus, role: Role): boolean =>
  invoiceTransitionsFor(from, role).some((transition) => transition.to === to);

/**
 * El estado que le corresponde a un saldo: es la regla que mueve `emitida → parcial → pagada` (y
 * hacia atrás cuando se anula un cobro) sin que nadie la escriba dos veces.
 *
 * Una factura de total cero (todas las partidas sin precio) nace **pagada**: no hay nada que cobrar.
 */
export const invoiceStatusForBalance = (
  totalCentsUsd: number,
  balanceCentsUsd: number,
): InvoiceStatus => {
  const total = enteroSeguro(totalCentsUsd, 'el total');
  const saldo = enteroSeguro(balanceCentsUsd, 'el saldo');
  if (saldo > total) {
    throw new RangeError(`el saldo (${saldo}) no puede superar el total (${total})`);
  }
  if (total === 0 || saldo === 0) return 'pagada';
  return saldo === total ? 'emitida' : 'parcial';
};

/** Una factura solo se cobra si ya es un documento y le queda saldo. */
export const isCollectableInvoice = (status: InvoiceStatus): boolean =>
  status === 'emitida' || status === 'parcial';

export const invoiceStatusLabel = (status: string): string => {
  switch (status) {
    case 'borrador':
      return 'Borrador';
    case 'emitida':
      return 'Emitida';
    case 'parcial':
      return 'Abonada';
    case 'pagada':
      return 'Pagada';
    case 'anulada':
      return 'Anulada';
    default:
      return status;
  }
};

/* ── 2. Medios de pago (dato, no `if`) ────────────────────────────────────── */

export const CURRENCIES = ['USD', 'VES'] as const;
export type Currency = (typeof CURRENCIES)[number];

/** Quién entera el IGTF: `banco` = ya lo debitó el banco, la clínica solo lo registra. */
export const IGTF_PERCEIVERS = ['clinica', 'banco', 'no_aplica'] as const;
export type IgtfPerceiver = (typeof IGTF_PERCEIVERS)[number];

/**
 * Lo que un medio de pago declara **antes** de que exista configuración:
 * `clinica_si_spe` = la clínica solo percibe si el SENIAT la notificó como Sujeto Pasivo Especial
 * (Art. 4.6 de la Ley de IGTF); `null` = **lo decide el contador** y la pantalla avisa mientras el
 * medio no esté configurado en `igtf_rules`.
 */
export type IgtfPerceiverRule = IgtfPerceiver | 'clinica_si_spe' | null;

export interface PaymentMethod {
  readonly code: string;
  readonly label: string;
  readonly currency: Currency;
  readonly percibe: IgtfPerceiverRule;
}

/**
 * §3.2 del plan. Los cuatro primeros grupos son bolívares (no causan IGTF); los de divisas
 * bancarizada los debita **el banco** (Art. 4.5) y los de divisas sin mediación bancaria solo los
 * percibe la clínica **si es SPE** (Art. 4.6).
 */
export const PAYMENT_METHODS = [
  {
    code: 'cash_usd',
    label: 'Efectivo en divisas (USD)',
    currency: 'USD',
    percibe: 'clinica_si_spe',
  },
  { code: 'cash_ves', label: 'Efectivo en bolívares', currency: 'VES', percibe: 'no_aplica' },
  { code: 'pago_movil', label: 'Pago móvil', currency: 'VES', percibe: 'no_aplica' },
  {
    code: 'transfer_ves',
    label: 'Transferencia nacional (Bs)',
    currency: 'VES',
    percibe: 'no_aplica',
  },
  {
    code: 'pos_debit',
    label: 'Punto de venta (débito, Bs)',
    currency: 'VES',
    percibe: 'no_aplica',
  },
  {
    code: 'pos_credit',
    label: 'Punto de venta (crédito, Bs)',
    currency: 'VES',
    percibe: 'no_aplica',
  },
  { code: 'card_usd', label: 'Tarjeta en divisas', currency: 'USD', percibe: 'banco' },
  {
    code: 'transfer_usd_local',
    label: 'Transferencia en divisas (banco nacional)',
    currency: 'USD',
    percibe: 'banco',
  },
  { code: 'zelle', label: 'Zelle', currency: 'USD', percibe: 'clinica_si_spe' },
  { code: 'crypto_usdt', label: 'USDT / cripto', currency: 'USD', percibe: 'clinica_si_spe' },
  {
    code: 'international_wire',
    label: 'Transferencia del exterior',
    currency: 'USD',
    percibe: null,
  },
  { code: 'other', label: 'Otro medio', currency: 'VES', percibe: null },
] as const satisfies readonly PaymentMethod[];

export type PaymentMethodCode = (typeof PAYMENT_METHODS)[number]['code'];

export const findPaymentMethod = (code: string): PaymentMethod | undefined =>
  PAYMENT_METHODS.find((method) => method.code === code);

export const isPaymentMethodCode = (code: string): code is PaymentMethodCode =>
  PAYMENT_METHODS.some((method) => method.code === code);

export const paymentMethodLabel = (code: string): string => findPaymentMethod(code)?.label ?? code;

/* ── 3. Categorías fiscales, alícuotas y configuración ────────────────────── */

/** `exento` = servicios odontológicos (Ley de IVA Art. 19.6); `general` = bienes (16 %). */
export const TAX_CATEGORIES = ['exento', 'general'] as const;
export type TaxCategory = (typeof TAX_CATEGORIES)[number];

export const CATALOG_KINDS = ['servicio', 'bien'] as const;
export type CatalogKind = (typeof CATALOG_KINDS)[number];

export const RATE_SOURCES = ['bcv_oficial', 'manual', 'arrastre'] as const;
export type RateSource = (typeof RATE_SOURCES)[number];

/** B6: una sola política por instalación, y queda registrada en cada pago. */
export const IMPUTATION_POLICIES = ['tasa_del_pago', 'tasa_de_la_factura'] as const;
export type ImputationPolicy = (typeof IMPUTATION_POLICIES)[number];

/** ADR 0047: quién asigna el número (esta clínica factura en `formas_libres`). */
export const NUMBERING_MODES = ['software', 'formas_libres', 'maquina_fiscal'] as const;
export type NumberingMode = (typeof NUMBERING_MODES)[number];

/**
 * Valores de **siembra**, no verdades cableadas: la alícuota que se aplica se **copia** en cada
 * documento (B13), así que cambiar la ley es un `insert` con vigencia en `tax_rates`/`igtf_rules`,
 * no un despliegue. Estos números solo existen para que la migración siembre algo coherente.
 */
export const IVA_GENERAL_BASIS_POINTS = 1600;
export const IGTF_DIVISAS_BASIS_POINTS = 300;
/** Gancho del Art. 62 (5 %–25 % por pago en divisas): solo rige por Decreto, y no hay ninguno. */
export const FOREIGN_CURRENCY_IVA_BASIS_POINTS_DEFAULT = 0;

/** La letra que exige la Providencia 0071 Art. 13 num. 8 junto a cada partida. */
export const taxCategoryLetter = (category: TaxCategory): string =>
  category === 'general' ? '(G)' : '(E)';

/* ── 4. IGTF: qué medio lo causa y quién lo entera ────────────────────────── */

/** Una fila de `igtf_rules`: la alícuota y quién percibe, con fecha de vigencia. */
export interface IgtfRule {
  readonly method: PaymentMethodCode;
  /** 300 = 3,00 %. */
  readonly basisPoints: number;
  readonly perceivedBy: IgtfPerceiver;
  /** Día desde el que rige, en `America/Caracas` (`YYYY-MM-DD`). */
  readonly effectiveFrom: string;
}

/** La fila vigente para un medio en una fecha: la última con `effective_from <= fecha`. */
export const resolveIgtfRule = (
  rules: readonly IgtfRule[],
  method: PaymentMethodCode,
  onDate: string,
): IgtfRule | null => {
  const vigentes = rules
    .filter((rule) => rule.method === method && rule.effectiveFrom <= onDate)
    .sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom));
  return vigentes[0] ?? null;
};

export interface IgtfDecision {
  /** `true` si el medio causa IGTF. */
  readonly applies: boolean;
  readonly basisPoints: number;
  /** `null` cuando no aplica. `banco` = lo debita el banco y la clínica **no** lo cobra. */
  readonly perceivedBy: IgtfPerceiver | null;
  /** Por qué, en una línea: es lo que muestra la pantalla de caja. */
  readonly reason: string;
}

/**
 * ¿Este cobro lleva IGTF y quién lo entera? Es **el único sitio** donde vive la regla; la
 * configuración (`igtf_rules`) manda, y el medio de pago solo dice lo que declararía sin ella.
 *
 * La configuración de esta clínica (2026-10-05) es `is_special_taxpayer = false`: ningún medio se
 * percibe en caja, y los bancarizados en divisas quedan en `banco` solo para conciliar el extracto.
 */
export const igtfDecision = (input: {
  readonly method: PaymentMethodCode;
  readonly isSpecialTaxpayer: boolean;
  readonly rule?: IgtfRule | null;
}): IgtfDecision => {
  const { isSpecialTaxpayer } = input;
  const medio = findPaymentMethod(input.method);
  const declarado: IgtfPerceiverRule = input.rule?.perceivedBy ?? medio?.percibe ?? null;
  const puntos = input.rule?.basisPoints ?? IGTF_DIVISAS_BASIS_POINTS;

  switch (declarado) {
    case 'no_aplica':
      return {
        applies: false,
        basisPoints: 0,
        perceivedBy: null,
        reason: 'El medio de pago no causa IGTF.',
      };
    case 'banco':
      return {
        applies: true,
        basisPoints: puntos,
        perceivedBy: 'banco',
        reason: 'Lo debita el banco (Art. 4.5): la clínica solo lo registra para conciliar.',
      };
    case 'clinica':
    case 'clinica_si_spe':
      return isSpecialTaxpayer
        ? {
            applies: true,
            basisPoints: puntos,
            perceivedBy: 'clinica',
            reason: 'La clínica está calificada como Sujeto Pasivo Especial y lo percibe.',
          }
        : {
            applies: false,
            basisPoints: 0,
            perceivedBy: null,
            reason:
              'Clínica no calificada como Sujeto Pasivo Especial (IGTF no percibido; Art. 4.6).',
          };
    default:
      return {
        applies: false,
        basisPoints: 0,
        perceivedBy: null,
        reason: 'Medio sin configurar: quién percibe lo decide el contador.',
      };
  }
};

/**
 * Lo que la caja le cobra al paciente por IGTF. Es **0 cuando lo debita el banco**: sumarlo sería
 * cobrar dos veces el mismo tributo.
 */
export const igtfToCollectCents = (decision: IgtfDecision, baseCentsUsd: number): number =>
  decision.applies && decision.perceivedBy === 'clinica'
    ? igtfCents(baseCentsUsd, decision.basisPoints)
    : 0;

/** El IGTF no forma parte del monto de la factura: es dinero de terceros que se entera. */
export const igtfPercentLabel = (basisPoints: number): string =>
  `${(basisPoints / 100).toFixed(2).replace('.', ',')} %`;

/* ── 5. Aritmética del dinero: una sola regla, en un solo sitio ───────────── */

const MICROS_POR_UNIDAD = 1_000_000n;
const PUNTOS_BASICOS_POR_UNO = 10_000n;

const enteroSeguro = (valor: number, nombre: string): number => {
  if (!Number.isSafeInteger(valor) || valor < 0) {
    throw new RangeError(`${nombre} tiene que ser un entero no negativo: ${valor}`);
  }
  return valor;
};

const numeroSeguro = (valor: bigint, nombre: string): number => {
  if (valor > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError(`${nombre} se sale del rango entero seguro: ${valor}`);
  }
  return Number(valor);
};

/**
 * División entera con redondeo **half-up** (0,5 sube), sobre enteros no negativos. Es la única
 * regla de redondeo del módulo: todo lo demás la usa en vez de inventar la suya.
 */
export const divideHalfUp = (dividendo: bigint, divisor: bigint): bigint => {
  if (dividendo < 0n) {
    throw new RangeError(`el dividendo no puede ser negativo: ${dividendo}`);
  }
  if (divisor <= 0n) {
    throw new RangeError(`el divisor tiene que ser positivo: ${divisor}`);
  }
  return (dividendo * 2n + divisor) / (divisor * 2n);
};

/**
 * Tasa BCV a **micros**: `36,5420 Bs./USD = 36_542_000`.
 *
 * Se acepta coma o punto como separador decimal y hasta seis decimales. **No** se aceptan
 * separadores de miles: la tasa del BCV no los lleva, y adivinar si «1.234» es 1234 o 1,234 en un
 * dato del que depende el dinero es peor que rechazarlo.
 */
export const rateToMicros = (rate: string): number => {
  const match = /^(\d{1,9})(?:[.,](\d{1,6}))?$/.exec(rate.trim());
  if (match === null) {
    throw new RangeError(`tasa no válida: «${rate}» (se espera 36,5420 o 36.5420)`);
  }
  const [, entero = '', decimales = ''] = match;
  const micros = BigInt(entero) * MICROS_POR_UNIDAD + BigInt(decimales.padEnd(6, '0'));
  if (micros <= 0n) {
    throw new RangeError(`la tasa tiene que ser mayor que cero: «${rate}»`);
  }
  return numeroSeguro(micros, 'la tasa en micros');
};

/**
 * Micros a la forma que se imprime: solo los decimales significativos, porque `36,5420` y `36,542`
 * son la misma tasa y el papel no puede dar a entender que son distintas.
 */
export const formatRateMicros = (micros: number): string => {
  const valor = BigInt(enteroSeguro(micros, 'la tasa en micros'));
  const enteros = valor / MICROS_POR_UNIDAD;
  const decimales = (valor % MICROS_POR_UNIDAD).toString().padStart(6, '0').replace(/0+$/, '');
  return decimales === '' ? enteros.toString() : `${enteros},${decimales}`;
};

/** Céntimos de Bs. a partir de céntimos de USD. Se redondea **una vez**, half-up. */
export const vesCentimosFromUsd = (centsUsd: number, rateMicros: number): number =>
  numeroSeguro(
    divideHalfUp(
      BigInt(enteroSeguro(centsUsd, 'los céntimos de USD')) *
        BigInt(enteroSeguro(rateMicros, 'la tasa en micros')),
      MICROS_POR_UNIDAD,
    ),
    'los céntimos de Bs.',
  );

/** Céntimos de USD imputados a partir de lo entregado en Bs. */
export const usdCentsFromVes = (vesCentimos: number, rateMicros: number): number => {
  const tasa = enteroSeguro(rateMicros, 'la tasa en micros');
  if (tasa === 0) {
    throw new RangeError('la tasa tiene que ser mayor que cero');
  }
  return numeroSeguro(
    divideHalfUp(
      BigInt(enteroSeguro(vesCentimos, 'los céntimos de Bs.')) * MICROS_POR_UNIDAD,
      BigInt(tasa),
    ),
    'los céntimos de USD',
  );
};

/** Aplica puntos básicos a una base en céntimos (300 = 3,00 %). */
const porcentajeDe = (centsUsd: number, basisPoints: number): number =>
  numeroSeguro(
    divideHalfUp(
      BigInt(enteroSeguro(centsUsd, 'la base en céntimos')) *
        BigInt(enteroSeguro(basisPoints, 'los puntos básicos')),
      PUNTOS_BASICOS_POR_UNO,
    ),
    'el resultado en céntimos',
  );

/** IGTF: alícuota en puntos básicos (300 = 3,00 %). */
export const igtfCents = (centsUsd: number, basisPoints: number): number =>
  porcentajeDe(centsUsd, basisPoints);

/**
 * IVA de una partida: la alícuota de su categoría **más** la adicional del Art. 62 cuando exista.
 *
 * El parágrafo primero del Art. 62 dice que en las operaciones **exentas** solo aplica esa adicional,
 * así que una partida `exento` paga `0 + adicional` y una `general` paga `general + adicional`. Hoy
 * la adicional está en 0 y no hay Decreto que la active; el día que lo haya es configuración.
 */
export const ivaCentsForItem = (input: {
  readonly baseCentsUsd: number;
  readonly taxCategory: TaxCategory;
  /** Alícuota vigente **copiada** del documento (`tax_rate_basis_points`). */
  readonly taxRateBasisPoints: number;
  readonly foreignCurrencyIvaBasisPoints?: number;
}): number => {
  const general = input.taxCategory === 'general' ? input.taxRateBasisPoints : 0;
  const adicional =
    input.foreignCurrencyIvaBasisPoints ?? FOREIGN_CURRENCY_IVA_BASIS_POINTS_DEFAULT;
  return porcentajeDe(input.baseCentsUsd, general + adicional);
};

/* ── 6. Totales del documento ─────────────────────────────────────────────── */

/** Lo mínimo que necesita una partida para sumar: el precio, su categoría y su IVA ya calculado. */
export interface InvoiceItemAmounts {
  readonly totalPriceCentsUsd: number;
  readonly taxCategory: TaxCategory;
  readonly ivaAmountCentsUsd: number;
}

export interface InvoiceTotals {
  readonly exemptAmountCentsUsd: number;
  readonly taxableAmountCentsUsd: number;
  readonly ivaAmountCentsUsd: number;
  readonly totalCentsUsd: number;
}

/**
 * Los totales se calculan **sumando las partidas**, nunca al revés: es la invariante que la base
 * vigila con `chk_invoices_totals`.
 */
export const invoiceTotalsFromItems = (items: readonly InvoiceItemAmounts[]): InvoiceTotals => {
  let exento = 0;
  let gravado = 0;
  let iva = 0;
  for (const item of items) {
    const base = enteroSeguro(item.totalPriceCentsUsd, 'el total de la partida');
    if (item.taxCategory === 'general') {
      gravado += base;
    } else {
      exento += base;
    }
    iva += enteroSeguro(item.ivaAmountCentsUsd, 'el IVA de la partida');
  }
  return {
    exemptAmountCentsUsd: exento,
    taxableAmountCentsUsd: gravado,
    ivaAmountCentsUsd: iva,
    totalCentsUsd: exento + gravado + iva,
  };
};

export interface InvoiceVesTotals {
  readonly exemptAmountVesCentimos: number;
  readonly taxableAmountVesCentimos: number;
  readonly ivaAmountVesCentimos: number;
  readonly totalVesCentimos: number;
}

/**
 * Los totales en bolívares, con la tasa congelada. El **total se suma de las partes ya convertidas**
 * (no se convierte aparte): así el desglose que se imprime cuadra siempre con el total, que es lo
 * que el Art. 13 num. 10 pone en el papel. Convertir el total por su cuenta podría diferir en un
 * céntimo de Bs., y un documento que no cuadra consigo mismo no se explica en el mostrador.
 */
export const invoiceVesTotals = (totals: InvoiceTotals, rateMicros: number): InvoiceVesTotals => {
  const exento = vesCentimosFromUsd(totals.exemptAmountCentsUsd, rateMicros);
  const gravado = vesCentimosFromUsd(totals.taxableAmountCentsUsd, rateMicros);
  const iva = vesCentimosFromUsd(totals.ivaAmountCentsUsd, rateMicros);
  return {
    exemptAmountVesCentimos: exento,
    taxableAmountVesCentimos: gravado,
    ivaAmountVesCentimos: iva,
    totalVesCentimos: exento + gravado + iva,
  };
};

/* ── 7. Números impresos (se calculan, no se guardan formateados) ──────────── */

/** El correlativo interno del software: `A-000123` (el número de control es otro, y viene de la forma). */
export const formatInvoiceNumber = (series: string, invoiceNumber: number): string =>
  `${series}-${String(invoiceNumber).padStart(6, '0')}`;

export const formatReceiptNumber = (receiptNumber: number): string =>
  `REC-${String(receiptNumber).padStart(6, '0')}`;

export const formatCreditNoteNumber = (creditNoteNumber: number): string =>
  `NC-${String(creditNoteNumber).padStart(6, '0')}`;

/* ── 8. Entradas de la caja (lo que manda la interfaz) ────────────────────── */

/**
 * Una línea del borrador. La caja manda la lista **completa** al guardar: quitar una línea es no
 * mandarla, y así no hay dos caminos para el mismo cambio (ni un `PATCH` que dependa del orden).
 *
 * `unitPriceCentsUsd` y `description` se piden cuando la partida **no tiene precio en el catálogo**
 * (M3: entra en 0 y marcada, y la caja la resuelve en diez segundos).
 */
export const draftItemInputSchema = z
  .object({
    /** Código del catálogo (`obturacion_resina`) o el que trajo la sesión clínica (`otros`). */
    code: z.string().trim().min(1).max(60),
    quantity: z.number().int().min(1).max(99).default(1),
    /** Precio unitario en céntimos de USD; si falta, el del catálogo. */
    unitPriceCentsUsd: z.number().int().min(0).max(100_000_000).optional(),
    description: optionalText(200),
    toothNumber: toothNumberSchema.nullable().default(null),
    surfaces: z.array(toothSurfaceSchema).max(5).default([]),
  })
  .strict();

export type DraftItemInput = z.infer<typeof draftItemInputSchema>;

export const replaceDraftItemsSchema = z
  .object({ items: z.array(draftItemInputSchema).max(60) })
  .strict();

export type ReplaceDraftItemsInput = z.infer<typeof replaceDraftItemsSchema>;

/* ── 9. Lo que responde la caja (contrato de la API) ─────────────────────── */

/** Una línea ya guardada: el arancel **copiado** (ADR 0048), no una referencia viva. */
export const billingDraftItemSchema = z.object({
  id: z.uuid(),
  code: z.string(),
  description: z.string(),
  toothNumber: z.number().int().nullable(),
  surfaces: z.array(z.string()).nullable(),
  quantity: z.number().int(),
  unitPriceCentsUsd: z.number().int(),
  totalPriceCentsUsd: z.number().int(),
  taxCategory: z.enum(TAX_CATEGORIES),
  taxRateBasisPoints: z.number().int(),
  ivaAmountCentsUsd: z.number().int(),
  needsPricing: z.boolean(),
});

export type BillingDraftItem = z.infer<typeof billingDraftItemSchema>;

/** Un borrador en la cola de la caja: lo justo para decidir cuál abrir. */
export const billingDraftSummarySchema = z.object({
  id: z.uuid(),
  status: z.enum(INVOICE_STATUSES),
  patientId: z.uuid(),
  patientName: z.string(),
  patientDocType: z.string(),
  patientDocNumber: z.string(),
  createdAt: z.string(),
  itemCount: z.number().int(),
  totalCentsUsd: z.number().int(),
  balanceCentsUsd: z.number().int(),
  /** Alguna partida sin precio: la caja lo resuelve antes de emitir (M3). */
  needsPricing: z.boolean(),
});

export type BillingDraftSummary = z.infer<typeof billingDraftSummarySchema>;

export const billingDraftDetailSchema = billingDraftSummarySchema.extend({
  items: z.array(billingDraftItemSchema),
  /** Sesiones clínicas que cubre; el número de factura llega al emitir. */
  clinicalSessionIds: z.array(z.uuid()),
});

export type BillingDraftDetail = z.infer<typeof billingDraftDetailSchema>;

export const billingDraftListSchema = z.object({ items: z.array(billingDraftSummarySchema) });

export const billingDraftTotalsSchema = z.object({
  exemptAmountCentsUsd: z.number().int(),
  taxableAmountCentsUsd: z.number().int(),
  ivaAmountCentsUsd: z.number().int(),
  totalCentsUsd: z.number().int(),
});

export type BillingDraftTotals = z.infer<typeof billingDraftTotalsSchema>;

/** El detalle que devuelve guardar: el borrador ya recalculado y sus totales. */
export const billingDraftSavedSchema = billingDraftDetailSchema.extend({
  totals: billingDraftTotalsSchema,
});

export type BillingDraftSaved = z.infer<typeof billingDraftSavedSchema>;

export const billingCatalogItemSchema = z.object({
  id: z.uuid(),
  code: z.string(),
  name: z.string(),
  kind: z.enum(CATALOG_KINDS),
  priceCentsUsd: z.number().int(),
  taxCategory: z.enum(TAX_CATEGORIES),
});

export type BillingCatalogItem = z.infer<typeof billingCatalogItemSchema>;

export const billingCatalogListSchema = z.object({ items: z.array(billingCatalogItemSchema) });
