import { buildCsv, type CsvColumn, type CsvValue } from '../common/csv.js';
import { z } from 'zod';

import { optionalText } from '../common/optional.js';
import { paginationQuerySchema } from '../common/pagination.js';
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
  /** La serie de la que sale el correlativo y el lote de formas. */
  series: z.string(),
  patientId: z.uuid(),
  patientName: z.string(),
  patientDocType: z.string(),
  patientDocNumber: z.string(),
  /** RIF, solo si factura con crédito fiscal. */
  patientTaxId: z.string().nullable(),
  patientFiscalAddress: z.string().nullable(),
  /** El correlativo interno; `null` mientras es un borrador. */
  invoiceNumber: z.number().int().nullable(),
  /** La tasa congelada al emitir (Art. 25); `null` mientras es un borrador. */
  exchangeRateMicros: z.number().int().nullable(),
  createdAt: z.string(),
  itemCount: z.number().int(),
  /** Desglose que se imprime en el papel (céntimos de USD): exento, gravado e IVA. */
  exemptAmountCentsUsd: z.number().int(),
  taxableAmountCentsUsd: z.number().int(),
  ivaAmountCentsUsd: z.number().int(),
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

/* ── 10. La tasa del día (ADR 0046) ───────────────────────────────────────── */

/**
 * El «día» de la tasa y del hecho imponible es el de **America/Caracas**, no el del reloj del servidor
 * ni UTC (Art. 25 de la Ley de IVA). Con `en-CA` sale directamente `AAAA-MM-DD`.
 */
export const rateDateInCaracas = (now: Date = new Date()): string =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Caracas',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);

/**
 * Alta o corrección de la tasa. La corrección **marca** la fila anterior (`supersedes_id`) y escribe
 * una nueva: lo ya emitido con la tasa vieja sigue diciendo lo que decía.
 */
export const setExchangeRateSchema = z
  .object({
    rateDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'La fecha va en AAAA-MM-DD'),
    /** Como se teclea en el mostrador: `36,5420`. */
    rate: z.string().trim().min(1, 'Escribe la tasa'),
    /** Por qué se corrige: obligatorio cuando ya había tasa para ese día. */
    note: optionalText(300),
  })
  .strict();

export type SetExchangeRateInput = z.infer<typeof setExchangeRateSchema>;

export const billingRateSchema = z.object({
  /** La fila: es el `entityId` con el que la tasa aparece en la auditoría. */
  id: z.uuid(),
  rateDate: z.string(),
  rateMicros: z.number().int(),
  source: z.enum(RATE_SOURCES),
  note: z.string().nullable(),
  setByUsername: z.string().nullable(),
  createdAt: z.string(),
});

export type BillingRate = z.infer<typeof billingRateSchema>;

/** La tasa vigente para una fecha, con el hueco de días que arrastra. */
export const billingRateStatusSchema = z.object({
  /** `null` = no hay ninguna tasa publicada hasta esa fecha: la caja no puede cobrar. */
  current: billingRateSchema.nullable(),
  /** Días entre la fecha pedida y el día de la tasa vigente (0 = es de ese mismo día). */
  gapDays: z.number().int(),
  /** El hueco supera el umbral configurado: cobrar exige confirmar (M8). */
  needsConfirmation: z.boolean(),
});

export type BillingRateStatus = z.infer<typeof billingRateStatusSchema>;

export const billingRateListSchema = z.object({ items: z.array(billingRateSchema) });

/* ── 11. El lote de formas libres (ADR 0047) ──────────────────────────────── */

/**
 * Cuántas formas quedan cuando la caja empieza a avisar. Quedarse sin formas es **quedarse sin poder
 * facturar**, así que el aviso es parte del trabajo, no un adorno.
 */
export const FISCAL_FORMS_LOW_THRESHOLD = 20;

/**
 * Alta de un lote: el rango que autorizó la imprenta («desde el N° … hasta el N° …») y los datos que
 * la factura tiene que imprimir (Art. 13 nums. 15 y 16). El **número de control viene preimpreso**: el
 * software solo lo consume en orden.
 */
export const createFiscalFormLotSchema = z
  .object({
    series: z.string().trim().min(1).max(4).default('A'),
    /** Los extremos del rango, como vienen impresos: `000001`. */
    controlFrom: z.string().trim().min(1).max(20),
    controlTo: z.string().trim().min(1).max(20),
    printerName: z.string().trim().min(3).max(120),
    printerRif: z.string().trim().min(5).max(20),
    /** Providencia que autoriza a la imprenta. */
    authorizationRef: z.string().trim().min(3).max(60),
    authorizationDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    printDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  })
  .strict();

export type CreateFiscalFormLotInput = z.infer<typeof createFiscalFormLotSchema>;

export const fiscalFormLotSchema = z.object({
  id: z.uuid(),
  series: z.string(),
  controlFrom: z.string(),
  controlTo: z.string(),
  /** La forma que se consumirá en la próxima emisión. */
  nextControl: z.string(),
  /** Cuántas formas quedan (la próxima incluida). */
  remaining: z.number().int(),
  /** Quedan pocas: la caja lo avisa. */
  isLow: z.boolean(),
  printerName: z.string(),
  printerRif: z.string(),
  authorizationRef: z.string(),
  authorizationDate: z.string(),
  printDate: z.string(),
  /** Formas estropeadas o dadas de baja: se **conservan** (Art. 36 y 40) y se cuentan. */
  spoiledCount: z.number().int(),
  exhaustedAt: z.string().nullable(),
  receivedAt: z.string().nullable(),
});

export type FiscalFormLot = z.infer<typeof fiscalFormLotSchema>;

export const fiscalFormLotListSchema = z.object({ items: z.array(fiscalFormLotSchema) });

/** Marcar una forma como dañada: se registra con motivo y **ocupa su control**, no se reutiliza. */
export const spoilFiscalFormSchema = z
  .object({ reason: z.string().trim().min(3, 'Indica por qué se dañó').max(200) })
  .strict();

export type SpoilFiscalFormInput = z.infer<typeof spoilFiscalFormSchema>;

/* ── 12. Emitir (ADR 0048: emitir es congelar) ────────────────────────────── */

/**
 * Emitir toma el correlativo, consume el **control** de la forma y archiva el PDF: no hay vuelta
 * atrás (desde ahí solo se anula con nota de crédito). Se confirma explícitamente.
 */
export const issueInvoiceSchema = z
  .object({ confirm: z.literal(true, { message: 'Confirma la emisión de la factura' }) })
  .strict();

export type IssueInvoiceInput = z.infer<typeof issueInvoiceSchema>;

/** Lo que devuelve la emisión: los **dos** números, la tasa congelada y las dos monedas. */
export const billingInvoiceIssuedSchema = billingDraftDetailSchema.extend({
  /** Correlativo interno, asignado ahora. */
  invoiceNumber: z.number().int(),
  /** Número de control preimpreso de la forma consumida (`null` en modo `software`). */
  controlNumber: z.string().nullable(),
  /** `A-000123`: el número como se imprime. */
  numberLabel: z.string(),
  issuedAt: z.string(),
  exchangeRateMicros: z.number().int(),
  exemptAmountVesCentimos: z.number().int(),
  taxableAmountVesCentimos: z.number().int(),
  ivaAmountVesCentimos: z.number().int(),
  totalVesCentimos: z.number().int(),
  /** Huella del PDF archivado: lo que se reimprime es ese archivo. */
  pdfSha256: z.string(),
});

export type BillingInvoiceIssued = z.infer<typeof billingInvoiceIssuedSchema>;

/* ── 13. Cobrar: el recibo, la tasa del pago y la anulación (B6, B8) ───────── */

export const paymentMethodCodeSchema = z.enum(
  PAYMENT_METHODS.map((method) => method.code) as unknown as [
    PaymentMethodCode,
    ...PaymentMethodCode[],
  ],
);

/**
 * Un cobro. `tenderedAmount` va en la **unidad mínima de la moneda del medio de pago**: céntimos de
 * USD o céntimos de Bs. Lo que se imputa a la deuda se calcula con la tasa, según la política.
 */
export const collectPaymentSchema = z
  .object({
    method: paymentMethodCodeSchema,
    tenderedAmount: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    /** Referencia del pago (número de operación, de Zelle, del punto de venta…). */
    reference: optionalText(60),
    /** Confirma cobrar con una tasa que arrastra más días de los tolerados (M8). */
    confirmRate: z.boolean().default(false),
  })
  .strict();

export type CollectPaymentInput = z.infer<typeof collectPaymentSchema>;

export const billingPaymentSchema = z.object({
  id: z.uuid(),
  receiptNumber: z.number().int(),
  /** `REC-000001`. */
  receiptLabel: z.string(),
  method: paymentMethodCodeSchema,
  tenderedAmount: z.number().int(),
  tenderedCurrency: z.enum(CURRENCIES),
  /** Lo imputado a la deuda, en céntimos de USD. */
  amountCentsUsd: z.number().int(),
  /** La tasa **congelada de este pago**. */
  exchangeRateMicros: z.number().int(),
  /** La política con la que se imputó (B6), registrada en cada pago. */
  imputationPolicy: z.enum(IMPUTATION_POLICIES),
  /** Informativo: los Bs de diferencia con lo impreso, valorados a la tasa de la factura. */
  fxDifferenceCentsUsd: z.number().int(),
  appliesIgtf: z.boolean(),
  igtfBasisPoints: z.number().int(),
  /** `banco` = ya lo debitó el banco; `clinica` = lo percibe y lo entera la clínica. */
  igtfPerceivedBy: z.enum(IGTF_PERCEIVERS).nullable(),
  igtfAmountCentsUsd: z.number().int(),
  igtfAmountVesCentimos: z.number().int(),
  pdfSha256: z.string().nullable(),
  receivedByUsername: z.string(),
  createdAt: z.string(),
  voidedAt: z.string().nullable(),
  voidReason: z.string().nullable(),
});

export type BillingPayment = z.infer<typeof billingPaymentSchema>;

/** Lo que devuelve un cobro: el recibo y cómo queda la factura. */
export const billingPaymentResultSchema = z.object({
  payment: billingPaymentSchema,
  invoice: z.object({
    id: z.uuid(),
    status: z.enum(INVOICE_STATUSES),
    totalCentsUsd: z.number().int(),
    balanceCentsUsd: z.number().int(),
  }),
});

export type BillingPaymentResult = z.infer<typeof billingPaymentResultSchema>;

/** Anular un cobro exige motivo: el saldo vuelve y el estado retrocede (B8). */
export const voidPaymentSchema = z
  .object({ reason: z.string().trim().min(3, 'Indica por qué se anula').max(200) })
  .strict();

export type VoidPaymentInput = z.infer<typeof voidPaymentSchema>;

/** La factura con sus cobros: lo que necesita el historial de la caja. */
export const billingInvoiceDetailSchema = billingDraftDetailSchema.extend({
  payments: z.array(billingPaymentSchema),
});

export type BillingInvoiceDetail = z.infer<typeof billingInvoiceDetailSchema>;

/* ── 14. Anular con nota de crédito (Art. 22 y 23; ADR 0048) ──────────────── */

/** Anular exige motivo; el descartar un borrador, también (el `CHECK` lo pide para toda fila anulada). */
export const voidInvoiceSchema = z
  .object({ reason: z.string().trim().min(5, 'Explica por qué se anula').max(200) })
  .strict();

export type VoidInvoiceInput = z.infer<typeof voidInvoiceSchema>;

/**
 * La **nota de crédito**: documento nuevo, con su numeración y su PDF archivado, que referencia la
 * factura con **fecha, número y monto copiados** (Art. 23) porque la factura puede anularse después.
 */
export const billingCreditNoteSchema = z.object({
  id: z.uuid(),
  creditNoteNumber: z.number().int(),
  /** `NC-000001`. */
  creditNoteLabel: z.string(),
  invoiceId: z.uuid(),
  /** La referencia copiada, no un enlace vivo. */
  invoiceNumber: z.number().int(),
  invoiceNumberLabel: z.string(),
  invoiceIssuedAt: z.string(),
  invoiceTotalCentsUsd: z.number().int(),
  /** `total` anula la factura entera; `parcial` (todavía sin usar) ajusta partidas. */
  kind: z.enum(['total', 'parcial']),
  reason: z.string(),
  totalCentsUsd: z.number().int(),
  exchangeRateMicros: z.number().int(),
  totalVesCentimos: z.number().int(),
  pdfSha256: z.string().nullable(),
  issuedAt: z.string(),
});

export type BillingCreditNote = z.infer<typeof billingCreditNoteSchema>;

/** Lo que devuelve anular: cómo queda la factura y la nota que la deja sin efecto. */
export const billingInvoiceVoidedSchema = z.object({
  invoice: z.object({
    id: z.uuid(),
    status: z.enum(INVOICE_STATUSES),
    voidReason: z.string(),
    voidedAt: z.string(),
  }),
  /** `null` cuando se descartó un **borrador**: nunca fue un documento, así que no hay nota. */
  creditNote: billingCreditNoteSchema.nullable(),
});

export type BillingInvoiceVoided = z.infer<typeof billingInvoiceVoidedSchema>;

/* ── 15. El libro de ventas y el de IGTF (Art. 75; §5.5 del plan) ─────────── */

/** El rango del libro: días de **Caracas** (`aaaa-mm-dd`). Sin rango, el mes en curso. */
export const bookQuerySchema = z
  .object({ from: z.iso.date().optional(), to: z.iso.date().optional() })
  .strict();

export type BookQuery = z.infer<typeof bookQuerySchema>;

/**
 * Una operación del libro de ventas. La **nota de crédito** entra como una fila más, con el monto en
 * **negativo** y el documento de la factura que deja sin efecto: el libro cuenta lo que pasó, no lo
 * que sobrevivió, y así el total del período cuadra con la realidad.
 */
export interface SalesBookRow extends Record<string, CsvValue> {
  fecha: string;
  documento: string;
  control: string;
  cliente: string;
  rif: string;
  exento: number;
  base16: number;
  iva: number;
  total: number;
  /** La tasa congelada del documento, en Bs./US$. */
  tasa: number;
  totalBs: number;
  estado: string;
}

export const SALES_BOOK_COLUMNS: readonly CsvColumn[] = [
  { key: 'fecha', label: 'Fecha' },
  { key: 'documento', label: 'Documento' },
  { key: 'control', label: 'N.º de control' },
  { key: 'cliente', label: 'Cliente' },
  { key: 'rif', label: 'RIF/Cédula' },
  { key: 'exento', label: 'Exento US$' },
  { key: 'base16', label: 'Base 16 % US$' },
  { key: 'iva', label: 'IVA US$' },
  { key: 'total', label: 'Total US$' },
  { key: 'tasa', label: 'Tasa Bs./US$' },
  { key: 'totalBs', label: 'Total Bs.' },
  { key: 'estado', label: 'Estado' },
];

export const salesBookToCsv = (rows: readonly SalesBookRow[]): string =>
  buildCsv(SALES_BOOK_COLUMNS, rows);

/** Una fila del libro de IGTF: **solo** los cobros en los que el tributo se causó. */
export interface IgtfBookRow extends Record<string, CsvValue> {
  fecha: string;
  recibo: string;
  factura: string;
  medio: string;
  /** Lo entregado por el paciente, en la moneda del medio. */
  monto: number;
  alicuota: number;
  percibidoPor: string;
  igtf: number;
  igtfBs: number;
}

export const IGTF_BOOK_COLUMNS: readonly CsvColumn[] = [
  { key: 'fecha', label: 'Fecha' },
  { key: 'recibo', label: 'Recibo' },
  { key: 'factura', label: 'Factura' },
  { key: 'medio', label: 'Medio de pago' },
  { key: 'monto', label: 'Monto' },
  { key: 'alicuota', label: 'Alícuota %' },
  { key: 'percibidoPor', label: 'Percibido por' },
  { key: 'igtf', label: 'IGTF US$' },
  { key: 'igtfBs', label: 'IGTF Bs.' },
];

export const igtfBookToCsv = (rows: readonly IgtfBookRow[]): string =>
  buildCsv(IGTF_BOOK_COLUMNS, rows);

/**
 * El nombre del archivo: `libro-de-ventas-<desde>_<hasta>.csv`. Se limpia todo lo que no sea
 * `[0-9A-Za-z._-]` porque el valor viaja a una cabecera HTTP (`content-disposition`): comillas o
 * saltos de línea ahí son una inyección de cabeceras.
 */
export const bookFileName = (tipo: 'ventas' | 'igtf', query: BookQuery): string => {
  const parte = (valor: string | undefined, porDefecto: string): string => {
    if (valor === undefined || valor === '') return porDefecto;
    const limpio = valor.replace(/[^0-9A-Za-z._-]/g, '-');
    return limpio.length > 0 ? limpio : porDefecto;
  };
  return `libro-de-${tipo}-${parte(query.from, 'inicio')}_${parte(query.to, 'fin')}.csv`;
};

/* ── 16. El historial de la caja (Fase 11) ─────────────────────────────────── */

/**
 * Los filtros del historial. La secretaría busca la factura que el paciente trae en la mano —por
 * nombre, por cédula, por fecha o por estado—, así que el rango va en **días de Caracas**, que es como
 * el mostrador habla de las fechas.
 *
 * El «día del documento» es el de **emisión** y, mientras sigue en borrador, el de su creación: un
 * borrador no tiene fecha de emisión, pero tiene que aparecer en el día en que nació. Es la misma
 * decisión que el libro de ventas, que también filtra por el día de Caracas y no por UTC.
 */
export const billingInvoiceListQuerySchema = paginationQuerySchema
  .extend({
    status: z.enum(INVOICE_STATUSES).optional(),
    from: z.iso.date().optional(),
    to: z.iso.date().optional(),
    /** Nombre o documento del paciente. */
    search: optionalText(60),
  })
  .strict();

export type BillingInvoiceListQuery = z.infer<typeof billingInvoiceListQuerySchema>;

/** La nota de crédito, con lo justo para reimprimirla desde el historial. */
export const billingCreditNoteSummarySchema = z.object({
  id: z.uuid(),
  /** `NC-000001`. */
  creditNoteLabel: z.string(),
  issuedAt: z.string(),
  totalCentsUsd: z.number().int(),
  totalVesCentimos: z.number().int(),
  pdfSha256: z.string().nullable(),
});

export type BillingCreditNoteSummary = z.infer<typeof billingCreditNoteSummarySchema>;

/** Una fila del historial: el documento y lo que se puede hacer con él en el mostrador. */
export const billingInvoiceListItemSchema = billingDraftSummarySchema.extend({
  /** `A-000123`; `null` mientras es borrador. */
  numberLabel: z.string().nullable(),
  issuedAt: z.string().nullable(),
  voidedAt: z.string().nullable(),
  voidReason: z.string().nullable(),
  /** El papel archivado del que se reimprime; `null` mientras es borrador (ADR 0048). */
  pdfSha256: z.string().nullable(),
  /** Veces que se ha impreso o descargado **desde que se emitió** (emitir no cuenta). */
  printCount: z.number().int(),
  lastPrintedAt: z.string().nullable(),
  /** Los cobros que tiene, anulados incluidos: se conservan (B8). */
  paymentCount: z.number().int(),
  /** La nota de crédito que la dejó sin efecto, si la tiene. */
  creditNote: billingCreditNoteSummarySchema.nullable(),
});

export type BillingInvoiceListItem = z.infer<typeof billingInvoiceListItemSchema>;

export const billingInvoiceListSchema = z.object({
  items: z.array(billingInvoiceListItemSchema),
  total: z.number().int(),
  page: z.number().int(),
  pageSize: z.number().int(),
  totalPages: z.number().int(),
});

export type BillingInvoiceList = z.infer<typeof billingInvoiceListSchema>;

/**
 * La constancia de una impresión o descarga: lo que el mostrador dice cuando reimprime. El PDF
 * archivado se sirve por su ruta (ADR 0048); este paso es el que deja rastro —y el que cuenta— porque
 * una factura reimpresa tres veces es un dato, no un detalle.
 */
export const billingPrintResultSchema = z.object({
  id: z.uuid(),
  printCount: z.number().int(),
  lastPrintedAt: z.string(),
});

export type BillingPrintResult = z.infer<typeof billingPrintResultSchema>;
