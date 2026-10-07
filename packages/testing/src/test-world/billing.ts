import {
  findPaymentMethod,
  formatRateMicros,
  igtfDecision,
  igtfToCollectCents,
  invoiceStatusForBalance,
  invoiceTotalsFromItems,
  invoiceVesTotals,
  ivaCentsForItem,
  IVA_GENERAL_BASIS_POINTS,
  procedureLabel,
  SESSION_PROCEDURES,
  usdCentsFromVes,
  vesCentimosFromUsd,
  type CatalogKind,
  type Currency,
  type DocType,
  type IgtfPerceiver,
  type ImputationPolicy,
  type InvoiceStatus,
  type InvoiceTotals,
  type InvoiceVesTotals,
  type PaymentMethodCode,
  type RateSource,
  type SessionProcedure,
  type TaxCategory,
} from '@odontocrm/contracts';

import { createRng } from '../prng.js';
import { addDays, clinicDate, clinicInstant, isWorkday, nextWorkday } from './clinic-time.js';
import { deterministicUuid, FICTITIOUS_SEQUENCE_MIN } from './ids.js';
import type { TestWorldPatient, TestWorldSession } from './world.js';

/**
 * La **facturación del mundo de prueba** (Fase 11, ADR 0020).
 *
 * El mundo clínico ya dice qué sesiones se cerraron y qué se hizo en cada una; esto
 * dice lo que pasó **con el dinero**: la tasa del BCV de cada día, los aranceles de
 * la clínica, la factura que dejó cada sesión cerrada —emitida y cobrada, o todavía
 * en borrador—, los recibos y la nota de crédito de la que se anuló.
 *
 * Cuatro decisiones que importan:
 *
 * 1. **El mundo factura lo que facturaría el servicio.** Las partidas salen de los
 *    procedimientos de la sesión y del arancel, con las **mismas funciones del
 *    contrato** que usa `billing` (`invoiceTotalsFromItems`, `ivaCentsForItem`,
 *    `invoiceVesTotals`, `igtfDecision`…). No hay una segunda aritmética del dinero
 *    que pueda discrepar: si el contrato cambia, el mundo cambia con él.
 * 2. **Una factura por sesión cerrada, siempre.** El consumidor de `billing` factura
 *    toda sesión que se cierra, así que el mundo también: lo que cambia es el
 *    **estado** de cada una según lo reciente que sea. Las últimas siguen en la cola
 *    de la caja (borradores) y las viejas ya se cobraron. Así la cola de la pila no
 *    puede inventar facturas nuevas: la sesión ya tiene la suya (segunda red de
 *    idempotencia, `uq_invoice_sessions_session`).
 * 3. **Los documentos llevan su PDF de prueba**, con el mismo `pdfDePrueba` que los
 *    récipes: el papel archivado existe y se descarga, aunque no sea el A5 real (eso
 *    lo compone Chromium en la aplicación). Las líneas del PDF viven **en el mundo**,
 *    así que `seed:test` y `seed:verify` calculan el mismo `sha256` sin duplicar
 *    textos.
 * 4. **Numeración reservada y `is_test`.** Los correlativos (factura, recibo y nota
 *    de crédito) van al rango 900.000+ —igual que los tickets y los récipes—, y las
 *    filas van marcadas: la numeración real nunca ve un número de prueba.
 *
 * Lo que **no** hace: tocar `billing_settings` ni las series. La configuración de la
 * clínica (régimen tributario, política de imputación) no es dato del mundo; lo que
 * el mundo sí declara —y `seed:verify` comprueba— son los aranceles, que la
 * migración deja a cero esperando a la clínica.
 *
 * Nada se genera en el orden en que se recorre: cada sesión tiene su **generador
 * derivado** (`…:facturacion:<sesión>`) y las facturas se numeran por la hora de
 * emisión, no por el orden de la lista. Añadir una sesión al mundo no renumera las
 * demás.
 */

/* ── Constantes del mundo ──────────────────────────────────────────────────── */

/** La tasa con la que nace el mundo: 36,5420 Bs./USD, el ejemplo del ADR 0046. */
export const BASE_RATE_MICROS = 36_542_000;

/** Lo que sube la tasa por día laborable: el bolívar se deprecia despacio y el histórico se ve. */
export const RATE_STEP_MICROS = 18_500;

const NOTA_TASA_CAPTURA = 'MODO TEST: tasa ficticia capturada del BCV (ADR 0020)';
const NOTA_TASA_MANUAL = 'MODO TEST: tasa del día publicada a mano (ADR 0020)';

/** Quién firma los actos del mundo: nadie del consultorio, y se nota en la auditoría. */
export const SEED_ACTOR_USERNAME = 'seed-test';

/** El borrador lo crea el sistema al cerrarse la sesión, no una persona. */
export const SISTEMA_USERNAME = 'sistema';
/** El mismo identificador que usa `billing` para el actor del sistema. */
export const SISTEMA_USER_ID = '00000000-0000-0000-0000-000000000000';

/**
 * Aranceles del mundo: el precio ficticio de cada servicio del catálogo clínico, en
 * céntimos de USD. No es decoración: sin precio, `billing` marca la partida como
 * «sin precio» y **no deja emitir** hasta que la caja la resuelva a mano. Con esto,
 * la caja abre con trabajo que se puede emitir y cobrar de verdad.
 *
 * Solo los servicios: los bienes del catálogo (`cepillo_dental`, `gel_fluorado`) ya
 * vienen con precio de la migración y el mundo no los toca.
 */
export const WORLD_SERVICE_PRICES: Readonly<Record<string, number>> = {
  consulta_evaluacion: 1_200,
  control_postoperatorio: 600,
  profilaxis: 2_000,
  detartraje: 3_500,
  aplicacion_fluor: 1_500,
  sellante: 1_800,
  obturacion_resina: 3_000,
  obturacion_amalgama: 2_500,
  obturacion_ionomero: 2_200,
  reconstruccion: 4_000,
  endodoncia_unirradicular: 8_000,
  endodoncia_birradicular: 10_000,
  endodoncia_multirradicular: 12_000,
  retratamiento_endodontico: 14_000,
  extraccion_simple: 2_500,
  extraccion_quirurgica: 6_000,
  corona_metal_porcelana: 15_000,
  corona_zirconia: 22_000,
  corona_temporal: 5_000,
  implante_quirurgico: 35_000,
  carga_implante: 12_000,
  protesis_fija: 18_000,
  protesis_removible: 25_000,
  blanqueamiento: 9_000,
  cementado: 2_000,
  retiro_sutura: 800,
  radiografia: 1_500,
  otros: 1_500,
};

/** Horas del consultorio en las que entra el dinero (recibos), deterministas. */
const HORAS_DE_COBRO = ['08:45', '09:30', '11:00', '14:15', '15:40'] as const;

/** Medios de pago del mundo: mayoría en bolívares, como en el mostrador. */
const METODOS_EN_BOLIVARES: readonly PaymentMethodCode[] = [
  'pago_movil',
  'cash_ves',
  'transfer_ves',
  'pos_debit',
  'pos_credit',
];
const METODOS_EN_DIVISAS: readonly PaymentMethodCode[] = ['cash_usd', 'zelle', 'card_usd'];

/** Medios que exigen una referencia del banco o del operador. */
const MEDIOS_CON_REFERENCIA: readonly PaymentMethodCode[] = [
  'pago_movil',
  'transfer_ves',
  'pos_debit',
  'pos_credit',
  'zelle',
  'card_usd',
  'transfer_usd_local',
];

/* ── Lo que el mundo dice de la facturación ────────────────────────────────── */

/** Una tasa publicada, con su día y su fuente (`bcv_oficial` o `manual`). */
export interface TestWorldRate {
  id: string;
  /** Día al que aplica, en el calendario del consultorio. */
  rateDate: string;
  rateMicros: number;
  source: RateSource;
  note: string | null;
}

/** Un arancel del mundo: lo que la clínica cobra por un servicio del catálogo. */
export interface TestWorldArancel {
  code: string;
  kind: CatalogKind;
  priceCentsUsd: number;
  taxCategory: TaxCategory;
}

/** Una partida: copia del arancel, como en el papel (ADR 0048). */
export interface TestWorldInvoiceItem {
  id: string;
  code: string;
  description: string;
  toothNumber: number | null;
  surfaces: string[] | null;
  quantity: number;
  unitPriceCentsUsd: number;
  totalPriceCentsUsd: number;
  taxCategory: TaxCategory;
  taxRateBasisPoints: number;
  ivaAmountCentsUsd: number;
  needsPricing: boolean;
}

/** Un cobro: lo que entregó el paciente, con la tasa de ese día y su recibo archivado. */
export interface TestWorldPayment {
  id: string;
  receiptNumber: number;
  method: PaymentMethodCode;
  reference: string | null;
  tenderedAmount: number;
  tenderedCurrency: Currency;
  amountCentsUsd: number;
  exchangeRateMicros: number;
  imputationPolicy: ImputationPolicy;
  fxDifferenceCentsUsd: number;
  appliesIgtf: boolean;
  igtfBasisPoints: number;
  igtfPerceivedBy: IgtfPerceiver | null;
  igtfAmountCentsUsd: number;
  igtfAmountVesCentimos: number;
  receivedByUsername: string;
  createdAt: string;
  voidedAt: string | null;
  voidReason: string | null;
  /** Líneas del PDF archivado del recibo. */
  pdfLines: string[];
}

/** La nota de crédito que deja sin efecto una factura emitida (Art. 22 y 23). */
export interface TestWorldCreditNote {
  id: string;
  creditNoteNumber: number;
  reason: string;
  kind: 'total';
  totalCentsUsd: number;
  exchangeRateMicros: number;
  totalVesCentimos: number;
  issuedByUsername: string;
  issuedAt: string;
  /** Líneas del PDF archivado de la nota. */
  pdfLines: string[];
}

/** Una factura del mundo, con sus partidas y sus cobros. */
export interface TestWorldInvoice {
  id: string;
  series: string;
  sessionId: string;
  patientId: string;
  patientName: string;
  patientDocType: DocType;
  patientDocNumber: string;
  status: InvoiceStatus;
  /** `null` mientras es borrador: el número se asigna al emitir. */
  invoiceNumber: number | null;
  controlNumber: string | null;
  rateAtDraftMicros: number | null;
  exchangeRateMicros: number | null;
  exemptAmountCentsUsd: number;
  taxableAmountCentsUsd: number;
  ivaAmountCentsUsd: number;
  totalCentsUsd: number;
  balanceCentsUsd: number;
  /** Totales en Bs. con la tasa congelada; `null` mientras es borrador. */
  venBs: InvoiceVesTotals | null;
  createdByUsername: string;
  createdAt: string;
  issuedAt: string | null;
  voidedAt: string | null;
  voidReason: string | null;
  voidedByUsername: string | null;
  /** Líneas del PDF archivado de la factura; `null` mientras es borrador. */
  pdfLines: string[] | null;
  items: TestWorldInvoiceItem[];
  payments: TestWorldPayment[];
  creditNote: TestWorldCreditNote | null;
}

/** La parte de facturación del mundo: tasas, aranceles, facturas y sus cobros. */
export interface TestWorldBilling {
  rates: TestWorldRate[];
  aranceles: TestWorldArancel[];
  invoices: TestWorldInvoice[];
}

export interface BuildBillingWorldInput {
  anchor: string;
  patients: readonly TestWorldPatient[];
  /** Las sesiones cerradas del mundo, en cualquier orden. */
  sessions: readonly TestWorldSession[];
}

/* ── Ayudantes ─────────────────────────────────────────────────────────────── */

const iso = (date: Date): string => date.toISOString();

const clinicIso = (date: string, time: string): string => iso(clinicInstant(date, time));

const addMinutesToIso = (instant: string, minutes: number): string =>
  iso(new Date(new Date(instant).getTime() + minutes * 60_000));

/** El día del consultorio al que pertenece un instante del mundo. */
const diaDe = (instant: string): string => clinicDate(new Date(instant));

/**
 * El mostrador abre a las 08:15 y cierra a las 17:45: ningún acto de dinero del
 * mundo —emitir, cobrar, anular— cae fuera de ahí. Sin esto, una sesión que termina a
 * las 17:05 podía acabar «emitiendo» a las 21:37, que no se lo cree nadie.
 */
const enHorarioDelConsultorio = (instant: string): string => {
  const dia = diaDe(instant);
  const apertura = clinicIso(dia, '08:15');
  const cierre = clinicIso(dia, '17:45');
  if (instant < apertura) return apertura;
  return instant > cierre ? cierre : instant;
};

/** Dólares y bolívares como se imprimen en el papel de prueba. */
const usd = (cents: number): string => `US$ ${(cents / 100).toFixed(2)}`;
const ves = (centimos: number): string => `Bs. ${(centimos / 100).toFixed(2)}`;

const facturaLabel = (invoiceNumber: number): string =>
  `A-${String(invoiceNumber).padStart(6, '0')}`;

/**
 * Los aranceles del mundo: **todos** los servicios del catálogo clínico, con su
 * precio. Si un servicio nuevo del contrato se queda sin precio, esto revienta al
 * construir el mundo en vez de sembrar una partida sin arancel.
 */
const buildAranceles = (): TestWorldArancel[] =>
  SESSION_PROCEDURES.map((procedimiento) => {
    const priceCentsUsd = WORLD_SERVICE_PRICES[procedimiento.code];
    if (priceCentsUsd === undefined) {
      throw new Error(`el mundo no tiene arancel para «${procedimiento.code}»`);
    }
    return {
      code: procedimiento.code,
      kind: 'servicio' as const,
      priceCentsUsd,
      // Los servicios odontológicos están exentos (Ley de IVA Art. 19.6).
      taxCategory: 'exento' as const,
    };
  });

/**
 * El histórico de tasas: un día laborable por fila, desde el primer día que el mundo
 * facturó hasta el ancla. La tasa sube un punto fijo cada día, así que el
 * diferencial cambiario de los cobros tardíos es real y se ve en los libros. El día
 * del ancla va como `manual` (lo publicó la secretaría); los anteriores, como
 * `bcv_oficial`, que es lo que habría dejado la captura automática.
 */
const buildRates = (input: { anchor: string; desde: string }): TestWorldRate[] => {
  const rates: TestWorldRate[] = [];
  let paso = 0;

  for (let fecha = input.desde; fecha <= input.anchor; fecha = addDays(fecha, 1)) {
    if (!isWorkday(fecha)) continue;
    const esElDiaDelAncla = fecha === input.anchor;
    rates.push({
      id: deterministicUuid('exchange_rate', fecha),
      rateDate: fecha,
      rateMicros: BASE_RATE_MICROS + paso * RATE_STEP_MICROS,
      source: esElDiaDelAncla ? 'manual' : 'bcv_oficial',
      note: esElDiaDelAncla ? NOTA_TASA_MANUAL : NOTA_TASA_CAPTURA,
    });
    paso += 1;
  }

  return rates;
};

/** La tasa vigente de un día: la última publicada **hasta** esa fecha (ADR 0046). */
export const rateForClinicDate = (rates: readonly TestWorldRate[], date: string): TestWorldRate => {
  const [vigente] = rates
    .filter((rate) => rate.rateDate <= date)
    .sort((left, right) => (left.rateDate < right.rateDate ? 1 : -1));
  if (vigente === undefined) {
    throw new Error(`el mundo no tiene tasa para el ${date}: revisa el histórico`);
  }
  return vigente;
};

/**
 * Las partidas de una sesión cerrada, con las mismas reglas que `billing`: el precio
 * y la categoría salen del arancel, el IVA se copia de la alícuota, `otros` usa el
 * detalle que escribió el odontólogo y una partida sin precio entra **marcada**.
 */
const buildItems = (
  invoiceId: string,
  procedures: readonly SessionProcedure[],
  aranceles: readonly TestWorldArancel[],
): TestWorldInvoiceItem[] => {
  const porCodigo = new Map(aranceles.map((arancel) => [arancel.code, arancel]));

  return procedures.map((procedimiento, index) => {
    const arancel = porCodigo.get(procedimiento.code);
    const taxCategory: TaxCategory = arancel?.taxCategory ?? 'exento';
    const taxRateBasisPoints = taxCategory === 'general' ? IVA_GENERAL_BASIS_POINTS : 0;
    const unitPriceCentsUsd = arancel?.priceCentsUsd ?? 0;
    const detalle = procedimiento.detalle?.trim() ?? '';

    return {
      id: deterministicUuid('invoice_item', `${invoiceId}:${String(index)}`),
      code: procedimiento.code,
      description:
        procedimiento.code === 'otros' && detalle !== ''
          ? detalle
          : procedureLabel(procedimiento.code),
      toothNumber: procedimiento.toothNumber,
      surfaces: procedimiento.surfaces.length > 0 ? [...procedimiento.surfaces] : null,
      quantity: 1,
      unitPriceCentsUsd,
      totalPriceCentsUsd: unitPriceCentsUsd,
      taxCategory,
      taxRateBasisPoints,
      ivaAmountCentsUsd: ivaCentsForItem({
        baseCentsUsd: unitPriceCentsUsd,
        taxCategory,
        taxRateBasisPoints,
      }),
      needsPricing: unitPriceCentsUsd === 0,
    };
  });
};

/** El papel de la factura, según lo reciente que sea la sesión que la dejó. */
type PapelDeFactura = 'borrador' | 'emitida' | 'parcial' | 'anulada' | 'pagada' | 'cobro_anulado';

/**
 * La cola de la caja y la historia: las tres sesiones más recientes siguen en
 * borrador (el mostrador no ha cerrado la caja), la siguiente está emitida sin
 * cobrar, después una abonada a medias, después una anulada con su nota de crédito y
 * después una pagada **con un cobro anulado** (el que se registró mal y se corrigió).
 * Todo lo anterior, cobrado.
 */
const papelDeLaFactura = (posicionDesdeElFinal: number): PapelDeFactura => {
  if (posicionDesdeElFinal <= 2) return 'borrador';
  if (posicionDesdeElFinal === 3) return 'emitida';
  if (posicionDesdeElFinal === 4) return 'parcial';
  if (posicionDesdeElFinal === 5) return 'anulada';
  if (posicionDesdeElFinal === 6) return 'cobro_anulado';
  return 'pagada';
};

/** Contexto que necesita el recibo para imprimirse (el número se sabe al final). */
interface ReciboEnConstruccion {
  pago: TestWorldPayment;
  factura: string;
  paciente: TestWorldPatient;
  saldoTrasElCobro: number;
}

const lineasDelRecibo = (input: ReciboEnConstruccion): string[] => {
  const { pago } = input;
  const recibido =
    pago.tenderedCurrency === 'USD' ? usd(pago.tenderedAmount) : ves(pago.tenderedAmount);

  return [
    'MODO TEST - ODONTOCRM',
    `Recibo REC-${String(pago.receiptNumber).padStart(6, '0')} de la factura ${input.factura}`,
    `Paciente: ${input.paciente.fullName} (${input.paciente.document})`,
    `Recibido: ${recibido} · imputado ${usd(pago.amountCentsUsd)}`,
    `Tasa del pago: ${formatRateMicros(pago.exchangeRateMicros)} Bs./USD`,
    `Saldo de la factura: ${usd(input.saldoTrasElCobro)}`,
    'Documento de prueba: no corresponde a un cobro real.',
    'Para ver el PDF real, cobre desde la aplicacion.',
  ];
};

/* ── El mundo de facturación ───────────────────────────────────────────────── */

export const buildBillingWorld = (input: BuildBillingWorldInput): TestWorldBilling => {
  const aranceles = buildAranceles();
  const sesiones = [...input.sessions].sort((left, right) =>
    left.closedAt === right.closedAt
      ? left.id < right.id
        ? -1
        : 1
      : left.closedAt < right.closedAt
        ? -1
        : 1,
  );
  if (sesiones.length === 0) return { rates: [], aranceles, invoices: [] };

  const primerDia = diaDe(sesiones[0]?.closedAt ?? input.anchor);
  const rates = buildRates({ anchor: input.anchor, desde: primerDia });

  /**
   * El plan de cada sesión: qué papel juega, cuándo nació el borrador y cuándo se
   * emitió. Se calcula antes de construir nada para poder **numerar en el orden real
   * de emisión** (el correlativo se toma al emitir, no al listar).
   */
  const plan = sesiones.map((session, index) => {
    const rng = createRng(`${SEED_ACTOR_USERNAME}:facturacion:${session.id}`);
    const createdAt = enHorarioDelConsultorio(addMinutesToIso(session.closedAt, 2));
    return {
      session,
      rng,
      papel: papelDeLaFactura(sesiones.length - 1 - index),
      id: deterministicUuid('invoice', session.id),
      createdAt,
      issuedAt: enHorarioDelConsultorio(addMinutesToIso(createdAt, rng.int(20, 150))),
    };
  });

  const recibos: ReciboEnConstruccion[] = [];
  const invoices: TestWorldInvoice[] = [];
  let numeroDeFactura = FICTITIOUS_SEQUENCE_MIN;
  let numeroDeNota = FICTITIOUS_SEQUENCE_MIN;

  /** Emite (numera) y construye la factura de un plan; devuelve sus cobros. */
  const emitir = (paso: (typeof plan)[number]): TestWorldInvoice => {
    const { session, rng, papel, id, createdAt, issuedAt } = paso;
    const paciente = input.patients.find((item) => item.id === session.patientId);
    if (paciente === undefined) {
      throw new Error(`la sesión ${session.id} no tiene paciente en el mundo`);
    }

    const items = buildItems(id, session.content.procedimientos, aranceles);
    const totales: InvoiceTotals = invoiceTotalsFromItems(items);
    const tasaDelBorrador = rateForClinicDate(rates, diaDe(createdAt));
    const pagos: TestWorldPayment[] = [];

    if (papel === 'borrador') {
      return {
        id,
        series: 'A',
        sessionId: session.id,
        patientId: paciente.id,
        patientName: paciente.fullName,
        patientDocType: paciente.docType,
        patientDocNumber: paciente.docNumber,
        status: 'borrador',
        invoiceNumber: null,
        controlNumber: null,
        rateAtDraftMicros: tasaDelBorrador.rateMicros,
        exchangeRateMicros: null,
        ...totales,
        balanceCentsUsd: totales.totalCentsUsd,
        venBs: null,
        createdByUsername: SISTEMA_USERNAME,
        createdAt,
        issuedAt: null,
        voidedAt: null,
        voidReason: null,
        voidedByUsername: null,
        pdfLines: null,
        items,
        payments: pagos,
        creditNote: null,
      };
    }

    numeroDeFactura += 1;
    const etiqueta = facturaLabel(numeroDeFactura);
    const tasaDeEmision = rateForClinicDate(rates, diaDe(issuedAt));
    const venBs = invoiceVesTotals(totales, tasaDeEmision.rateMicros);
    const pdfDeFactura = [
      'MODO TEST - ODONTOCRM',
      `Factura ${etiqueta}`,
      `Paciente: ${paciente.fullName} (${paciente.document})`,
      `Emitida: ${diaDe(issuedAt)} a la tasa ${formatRateMicros(tasaDeEmision.rateMicros)} Bs./USD`,
      `Total: ${usd(totales.totalCentsUsd)} · ${ves(venBs.totalVesCentimos)}`,
      'Documento de prueba: no corresponde a una operacion real.',
      'Para ver el PDF real, emita una factura desde la aplicacion.',
    ];

    /**
     * El cobro: el paciente paga en la moneda del medio, y en bolívares se imputa a
     * la **tasa del pago** (política `tasa_del_pago` de la clínica, B6). Si paga unos
     * días después, la tasa ya subió y el diferencial queda registrado.
     *
     * `en` fija el instante y `seAnulaEn` el de la anulación (el cobro equivocado y su
     * corrección se colocan a mano, para que la corrección vaya **después** de la
     * anulación); sin ellos, el cobro se sortea entre el mismo día y unos días más
     * tarde y la anulación, dos horas después.
     */
    const cobrar = (
      montoCentsUsd: number,
      opciones: { anulado?: boolean; en?: string; seAnulaEn?: string } = {},
    ): void => {
      const metodo = rng.bool(0.22) ? rng.pick(METODOS_EN_DIVISAS) : rng.pick(METODOS_EN_BOLIVARES);
      const moneda: Currency = findPaymentMethod(metodo)?.currency ?? 'VES';
      const diaDeEmision = diaDe(issuedAt);
      const conRetraso = addDays(diaDeEmision, rng.pick([0, 1, 2, 4]));
      const diaDePago = conRetraso > input.anchor ? diaDeEmision : conRetraso;
      const pagadoEn =
        opciones.en ??
        enHorarioDelConsultorio(
          diaDePago === diaDeEmision
            ? addMinutesToIso(issuedAt, rng.int(15, 210))
            : clinicIso(diaDePago, rng.pick(HORAS_DE_COBRO)),
        );
      const tasaDelPago = rateForClinicDate(rates, diaDe(pagadoEn)).rateMicros;

      const tenderedAmount =
        moneda === 'USD' ? montoCentsUsd : vesCentimosFromUsd(montoCentsUsd, tasaDelPago);
      const enBsImpresos = vesCentimosFromUsd(montoCentsUsd, tasaDeEmision.rateMicros);
      const diferenciaBs = tenderedAmount - enBsImpresos;
      const fxDifferenceCentsUsd =
        moneda === 'USD' || diferenciaBs === 0
          ? 0
          : Math.sign(diferenciaBs) *
            usdCentsFromVes(Math.abs(diferenciaBs), tasaDeEmision.rateMicros);

      // Hoy la clínica es contribuyente ordinario: solo los medios bancarizados en
      // divisas quedan marcados como «lo debita el banco» (y no se le cobran al
      // paciente). La regla vive en el contrato, no aquí.
      const decision = igtfDecision({ method: metodo, isSpecialTaxpayer: false, rule: null });
      const igtfAmountCentsUsd = igtfToCollectCents(decision, montoCentsUsd);
      const anuladoEn =
        opciones.anulado === true ? (opciones.seAnulaEn ?? addMinutesToIso(pagadoEn, 120)) : null;
      const yaCobrado = pagos
        .filter((item) => item.voidedAt === null)
        .reduce((suma, item) => suma + item.amountCentsUsd, 0);

      const pago: TestWorldPayment = {
        id: deterministicUuid('payment', `${id}:${String(pagos.length)}`),
        // El número lo pone la secuencia al final, en orden de cobro.
        receiptNumber: 0,
        method: metodo,
        reference: MEDIOS_CON_REFERENCIA.includes(metodo)
          ? String(rng.int(100_000, 999_999))
          : null,
        tenderedAmount,
        tenderedCurrency: moneda,
        amountCentsUsd: montoCentsUsd,
        exchangeRateMicros: tasaDelPago,
        imputationPolicy: 'tasa_del_pago',
        fxDifferenceCentsUsd,
        appliesIgtf: decision.applies,
        igtfBasisPoints: decision.applies ? decision.basisPoints : 0,
        igtfPerceivedBy: decision.perceivedBy,
        igtfAmountCentsUsd,
        igtfAmountVesCentimos: vesCentimosFromUsd(igtfAmountCentsUsd, tasaDelPago),
        receivedByUsername: SEED_ACTOR_USERNAME,
        createdAt: pagadoEn,
        voidedAt: anuladoEn,
        voidReason: anuladoEn === null ? null : 'MODO TEST: se registró el monto equivocado',
        pdfLines: [],
      };
      pagos.push(pago);
      recibos.push({
        pago,
        factura: etiqueta,
        paciente,
        saldoTrasElCobro:
          totales.totalCentsUsd - yaCobrado - (anuladoEn === null ? montoCentsUsd : 0),
      });
    };

    if (papel === 'pagada' || papel === 'cobro_anulado') {
      if (papel === 'cobro_anulado') {
        /**
         * El cobro equivocado y su corrección, el mismo día y en orden: se registra a
         * media mañana (nunca más tarde de las 15:45, para que quepan los dos), se
         * anula una hora después y se cobra la corrección **después de anular**.
         */
        const temprano = enHorarioDelConsultorio(addMinutesToIso(issuedAt, rng.int(15, 90)));
        const techo = clinicIso(diaDe(issuedAt), '15:45');
        const cobradoEn = temprano > techo ? techo : temprano;
        const anuladoEn = addMinutesToIso(cobradoEn, rng.int(45, 90));
        cobrar(Math.max(1, Math.round((totales.totalCentsUsd * 40) / 100)), {
          anulado: true,
          en: cobradoEn,
          seAnulaEn: anuladoEn,
        });
        cobrar(totales.totalCentsUsd, { en: addMinutesToIso(anuladoEn, rng.int(15, 30)) });
      } else {
        cobrar(totales.totalCentsUsd);
      }
    } else if (papel === 'parcial') {
      const abono = Math.round((totales.totalCentsUsd * rng.int(40, 60)) / 100);
      cobrar(Math.max(1, Math.min(abono, Math.max(1, totales.totalCentsUsd - 1))));
    }

    if (papel === 'anulada') {
      // El error se descubre al día siguiente: la anulación y su nota de crédito van
      // en la mañana del día laborable siguiente (o al cerrar, si no hay margen).
      const diaDeAnulacion = nextWorkday(diaDe(issuedAt), 1);
      const anuladaEn =
        diaDeAnulacion > input.anchor
          ? enHorarioDelConsultorio(addMinutesToIso(issuedAt, rng.int(45, 180)))
          : clinicIso(diaDeAnulacion, rng.pick(['09:15', '10:00', '11:30'] as const));
      numeroDeNota += 1;
      const etiquetaDeNota = `NC-${String(numeroDeNota).padStart(6, '0')}`;
      const motivo = 'MODO TEST: se anuló el tratamiento y se facturó de nuevo';
      const creditNote: TestWorldCreditNote = {
        id: deterministicUuid('credit_note', id),
        creditNoteNumber: numeroDeNota,
        reason: motivo,
        kind: 'total',
        totalCentsUsd: totales.totalCentsUsd,
        exchangeRateMicros: tasaDeEmision.rateMicros,
        totalVesCentimos: venBs.totalVesCentimos,
        issuedByUsername: SEED_ACTOR_USERNAME,
        issuedAt: anuladaEn,
        pdfLines: [
          'MODO TEST - ODONTOCRM',
          `Nota de credito ${etiquetaDeNota}`,
          `Factura ${etiqueta} del ${diaDe(issuedAt)}`,
          'Motivo: se anulo el tratamiento y se facturo de nuevo',
          `Monto: ${usd(totales.totalCentsUsd)} · ${ves(venBs.totalVesCentimos)}`,
          'Documento de prueba: no corresponde a una operacion real.',
        ],
      };

      return {
        id,
        series: 'A',
        sessionId: session.id,
        patientId: paciente.id,
        patientName: paciente.fullName,
        patientDocType: paciente.docType,
        patientDocNumber: paciente.docNumber,
        // Una factura pagada no se anula hasta devolver sus cobros: esta va sin cobros.
        status: 'anulada',
        invoiceNumber: numeroDeFactura,
        controlNumber: null,
        rateAtDraftMicros: tasaDelBorrador.rateMicros,
        exchangeRateMicros: tasaDeEmision.rateMicros,
        ...totales,
        balanceCentsUsd: totales.totalCentsUsd,
        venBs,
        createdByUsername: SISTEMA_USERNAME,
        createdAt,
        issuedAt,
        voidedAt: anuladaEn,
        voidReason: motivo,
        voidedByUsername: SEED_ACTOR_USERNAME,
        pdfLines: pdfDeFactura,
        items,
        payments: [],
        creditNote,
      };
    }

    // El estado sale de la resta y de la regla del contrato, igual que en el servicio.
    const cobrado = pagos
      .filter((pago) => pago.voidedAt === null)
      .reduce((suma, pago) => suma + pago.amountCentsUsd, 0);
    const saldo = totales.totalCentsUsd - cobrado;

    return {
      id,
      series: 'A',
      sessionId: session.id,
      patientId: paciente.id,
      patientName: paciente.fullName,
      patientDocType: paciente.docType,
      patientDocNumber: paciente.docNumber,
      status: invoiceStatusForBalance(totales.totalCentsUsd, saldo),
      invoiceNumber: numeroDeFactura,
      controlNumber: null,
      rateAtDraftMicros: tasaDelBorrador.rateMicros,
      exchangeRateMicros: tasaDeEmision.rateMicros,
      ...totales,
      balanceCentsUsd: saldo,
      venBs,
      createdByUsername: SISTEMA_USERNAME,
      createdAt,
      issuedAt,
      voidedAt: null,
      voidReason: null,
      voidedByUsername: null,
      pdfLines: pdfDeFactura,
      items,
      payments: pagos,
      creditNote: null,
    };
  };

  // Los borradores no son documentos: se construyen al final, en orden cronológico.
  for (const paso of plan.filter((item) => item.papel === 'borrador')) {
    invoices.push(emitir(paso));
  }

  // Las emitidas se numeran por la hora de emisión: el correlativo se toma al emitir.
  const emitidas = plan
    .filter((item) => item.papel !== 'borrador')
    .sort((left, right) =>
      left.issuedAt === right.issuedAt
        ? left.id < right.id
          ? -1
          : 1
        : left.issuedAt < right.issuedAt
          ? -1
          : 1,
    );
  for (const paso of emitidas) {
    invoices.push(emitir(paso));
  }

  // El recibo: número de secuencia **en orden de cobro** y su PDF, ya con el número.
  [...recibos]
    .sort((left, right) =>
      left.pago.createdAt === right.pago.createdAt
        ? left.pago.id < right.pago.id
          ? -1
          : 1
        : left.pago.createdAt < right.pago.createdAt
          ? -1
          : 1,
    )
    .forEach((recibo, index) => {
      recibo.pago.receiptNumber = FICTITIOUS_SEQUENCE_MIN + index + 1;
      recibo.pago.pdfLines = lineasDelRecibo(recibo);
    });

  return { rates, aranceles, invoices };
};
