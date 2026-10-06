import {
  CATALOG_KINDS,
  CURRENCIES,
  IGTF_PERCEIVERS,
  IMPUTATION_POLICIES,
  INVOICE_STATUSES,
  PAYMENT_METHODS,
  RATE_SOURCES,
  TAX_CATEGORIES,
} from '@odontocrm/contracts';
import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  pgSequence,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

/** Lista de valores para un CHECK como literales (ver nota en identity/schema.ts). */
const sqlLiteralList = (values: readonly string[]) => {
  const escaped = values.map((value) => `'${value.replace(/'/g, "''")}'`);
  return sql.join(
    // eslint-disable-next-line no-restricted-syntax -- constantes del contrato, nunca entrada de usuario
    escaped.map((value) => sql.raw(value)),
    sql`, `,
  );
};

/** Los códigos de medio de pago, del contrato: el `CHECK` no repite la lista. */
const PAYMENT_METHOD_CODES = PAYMENT_METHODS.map((method) => method.code);

/**
 * Base de la facturación (`odonto_billing`, puerto 4009). Convenciones del repositorio:
 * `snake_case` explícito, **`text` + `CHECK` contra las constantes del contrato** (nada de `pgEnum`),
 * dinero **solo en enteros** (céntimos de USD, céntimos de Bs. y tasa en micros) y `timestamptz` para
 * los instantes, `date` para el día de la tasa.
 *
 * Las tablas y los índices se nombran en inglés; los **valores** van en español.
 *
 * Decisiones: [ADR 0044](../../../../docs/adr/0044-modulo-de-facturacion-desacoplado.md) (servicio,
 * dinero en enteros, borrador idempotente), [0045](../../../../docs/adr/0045-regimen-tributario-iva-e-igtf.md)
 * (alícuotas con vigencia y copiadas), [0046](../../../../docs/adr/0046-tasa-bcv-historica-y-regla-de-imputacion.md)
 * (tasa histórica), [0047](../../../../docs/adr/0047-quien-asigna-el-numero-de-la-factura.md)
 * (dos números) y [0048](../../../../docs/adr/0048-el-documento-de-cobro-se-archiva.md) (emitir congela).
 */

/* ── 1. Tasas BCV: histórico, de solo agregado (ADR 0046) ───────────────────── */

/**
 * Una fila por fecha y fuente. **No se edita ni se borra**: una corrección es una fila nueva con
 * `supersedes_id`, y la anterior queda como historia —lo emitido con la tasa vieja sigue diciendo lo
 * que decía—. El índice único parcial garantiza **una sola tasa vigente por día**.
 */
export const exchangeRates = pgTable(
  'exchange_rates',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Día al que aplica la tasa, en `America/Caracas`. */
    rateDate: date('rate_date').notNull(),
    /** 36,5420 Bs./USD = 36_542_000 micros: entero, sin punto flotante. */
    rateMicros: bigint('rate_micros', { mode: 'number' }).notNull(),
    source: text('source').notNull(),
    /** Corrección posterior: la fila anterior se marca, no se edita. */
    supersedesId: uuid('supersedes_id'),
    supersededById: uuid('superseded_by_id'),
    /** Respuesta cruda del BCV (o motivo y nota del ingreso manual). */
    rawPayload: jsonb('raw_payload'),
    note: text('note'),
    setByUserId: uuid('set_by_user_id'),
    setByUsername: text('set_by_username'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('uq_exchange_rates_day')
      .on(table.rateDate)
      .where(sql`${table.supersededById} is null`),
    index('idx_exchange_rates_date').on(table.rateDate),
    check('chk_exchange_rates_positive', sql`${table.rateMicros} > 0`),
    check('chk_exchange_rates_source', sql`${table.source} in (${sqlLiteralList(RATE_SOURCES)})`),
  ],
);

/* ── 2. Configuración fiscal (una sola fila) ────────────────────────────────── */

/**
 * La configuración de **esta** clínica, en una sola fila (`chk_billing_settings_single_row`). Nace
 * del entorno como valor inicial y después manda la base, editable por el `admin` y auditada.
 */
export const billingSettings = pgTable(
  'billing_settings',
  {
    id: integer('id').primaryKey().default(1),
    /**
     * Sujeto Pasivo Especial: **lo notifica el SENIAT**, no se autodeclara. Habilita la percepción del
     * IGTF de divisas sin mediación bancaria (Art. 4.6). Hoy: `false`, contribuyente ordinario.
     */
    isSpecialTaxpayer: boolean('is_special_taxpayer').notNull().default(false),
    speNotifiedAt: date('spe_notified_at'),
    /** Oficio o providencia de la calificación. */
    speReference: text('spe_reference'),
    /** Política de imputación de pagos en Bs (B6): la decide la clínica, no el redondeo. */
    imputationPolicy: text('imputation_policy').notNull().default('tasa_del_pago'),
    /** Días de arrastre tolerados antes de exigir confirmación al cobrar. */
    rateGraceDays: integer('rate_grace_days').notNull().default(5),
    /**
     * Alícuota **adicional** por pago en moneda extranjera (Ley de IVA Art. 27 ¶4 y Art. 62, 5 %–25 %).
     * Solo rige por Decreto del Ejecutivo y no hay evidencia de que exista: queda como gancho, en 0.
     */
    foreignCurrencyIvaBasisPoints: integer('foreign_currency_iva_basis_points')
      .notNull()
      .default(0),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    updatedByUserId: uuid('updated_by_user_id'),
  },
  (table) => [
    check('chk_billing_settings_single_row', sql`${table.id} = 1`),
    check(
      'chk_billing_settings_imputation',
      sql`${table.imputationPolicy} in (${sqlLiteralList(IMPUTATION_POLICIES)})`,
    ),
    check(
      'chk_billing_settings_extra_iva',
      sql`${table.foreignCurrencyIvaBasisPoints} between 0 and 10000`,
    ),
    check('chk_billing_settings_grace', sql`${table.rateGraceDays} between 0 and 60`),
  ],
);

/* ── 3. Series, formas libres y numeración (ADR 0047) ───────────────────────── */

/**
 * Una serie declara **quién asigna el número**: `software` (numeramos nosotros), `formas_libres`
 * (consumimos un rango de control autorizado) o `maquina_fiscal`. Esta clínica factura en formas
 * libres, con el correlativo interno **y** el número de control preimpreso.
 */
export const invoiceSeries = pgTable('invoice_series', {
  id: uuid('id').primaryKey().defaultRandom(),
  /** `A` para la factura real, `T` para la numeración reservada del modo test. */
  series: text('series').notNull().unique(),
  numberingMode: text('numbering_mode').notNull(),
  prefix: text('prefix').notNull().default(''),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Lote de formas libres autorizadas: el **número de control viene preimpreso** en la forma. Un fallo
 * al generar el PDF no deja un hueco mudo —la forma se registra como anulada con motivo y se
 * conserva (Art. 36)— y `spoiledCount` lo cuenta.
 */
export const fiscalForms = pgTable(
  'fiscal_forms',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    seriesId: uuid('series_id')
      .notNull()
      .references(() => invoiceSeries.id),
    /** Rango asignado por la imprenta: «desde el N° … hasta el N° …». */
    controlFrom: text('control_from').notNull(),
    controlTo: text('control_to').notNull(),
    nextControl: text('next_control').notNull(),
    /** Datos que la factura tiene que imprimir (Art. 13 nums. 15 y 16). */
    printerName: text('printer_name').notNull(),
    printerRif: text('printer_rif').notNull(),
    /** Providencia que autoriza a la imprenta. */
    authorizationRef: text('authorization_ref').notNull(),
    authorizationDate: date('authorization_date').notNull(),
    printDate: date('print_date').notNull(),
    receivedAt: timestamp('received_at', { withTimezone: true }),
    /** Formas estropeadas o dadas de baja: se **conservan** (Art. 36 y 40). */
    spoiledCount: integer('spoiled_count').notNull().default(0),
    exhaustedAt: timestamp('exhausted_at', { withTimezone: true }),
  },
  (table) => [
    index('idx_fiscal_forms_series').on(table.seriesId),
    check('chk_fiscal_forms_spoiled', sql`${table.spoiledCount} >= 0`),
  ],
);

/** Secuencias atómicas: el número se toma aquí y nunca se comparte (patrón del récipe). */
export const invoiceNumberSequence = pgSequence('invoice_number_seq', { startWith: 1 });
export const receiptNumberSequence = pgSequence('receipt_number_seq', { startWith: 1 });
export const creditNoteNumberSequence = pgSequence('credit_note_number_seq', { startWith: 1 });

/* ── 4. Aranceles ───────────────────────────────────────────────────────────── */

/**
 * Catálogo de aranceles. Los códigos de **servicio** son los 28 de `SESSION_PROCEDURES`, para que el
 * borrador se arme solo desde la sesión clínica; los **bienes** llevan códigos propios y
 * `tax_category = 'general'`.
 */
export const treatmentCatalog = pgTable(
  'treatment_catalog',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    code: text('code').notNull().unique(),
    name: text('name').notNull(),
    kind: text('kind').notNull().default('servicio'),
    priceCentsUsd: integer('price_cents_usd').notNull(),
    taxCategory: text('tax_category').notNull().default('exento'),
    isActive: boolean('is_active').notNull().default(true),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    updatedByUserId: uuid('updated_by_user_id'),
  },
  (table) => [
    check('chk_catalog_price', sql`${table.priceCentsUsd} >= 0`),
    check('chk_catalog_tax', sql`${table.taxCategory} in (${sqlLiteralList(TAX_CATEGORIES)})`),
    check('chk_catalog_kind', sql`${table.kind} in (${sqlLiteralList(CATALOG_KINDS)})`),
  ],
);

/* ── 5. Facturas (documento fiscal: se emite y se archiva, ADR 0048) ────────── */

export const invoices = pgTable(
  'invoices',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    series: text('series').notNull().default('A'),
    /** Correlativo interno, asignado al emitir. */
    invoiceNumber: integer('invoice_number'),
    /** Número de control **preimpreso** en la forma (formas libres) o el de la máquina fiscal. */
    controlNumber: text('control_number'),
    fiscalFormId: uuid('fiscal_form_id').references(() => fiscalForms.id),
    status: text('status').notNull().default('borrador'),

    // Instantánea del paciente (ADR 0048): el papel no cambia si la ficha cambia.
    patientId: uuid('patient_id').notNull(),
    patientName: text('patient_name').notNull(),
    patientDocType: text('patient_doc_type').notNull(),
    patientDocNumber: text('patient_doc_number').notNull(),
    /** RIF, solo si factura con crédito fiscal: el consumidor final no lo necesita. */
    patientTaxId: text('patient_tax_id'),
    patientFiscalAddress: text('patient_fiscal_address'),

    // Tasa: provisional mientras es borrador, definitiva al emitir (B5).
    rateAtDraftMicros: bigint('rate_at_draft_micros', { mode: 'number' }),
    exchangeRateMicros: bigint('exchange_rate_micros', { mode: 'number' }),

    // Totales USD en céntimos (enteros: suma exacta de las partidas).
    exemptAmountCentsUsd: integer('exempt_amount_cents_usd').notNull().default(0),
    taxableAmountCentsUsd: integer('taxable_amount_cents_usd').notNull().default(0),
    ivaAmountCentsUsd: integer('iva_amount_cents_usd').notNull().default(0),
    totalCentsUsd: integer('total_cents_usd').notNull(),
    balanceCentsUsd: integer('balance_cents_usd').notNull(),
    // Totales VES en céntimos (B3), calculados con la tasa congelada.
    exemptAmountVesCentimos: bigint('exempt_amount_ves_centimos', { mode: 'number' })
      .notNull()
      .default(0),
    taxableAmountVesCentimos: bigint('taxable_amount_ves_centimos', { mode: 'number' })
      .notNull()
      .default(0),
    ivaAmountVesCentimos: bigint('iva_amount_ves_centimos', { mode: 'number' })
      .notNull()
      .default(0),
    totalVesCentimos: bigint('total_ves_centimos', { mode: 'number' }).notNull().default(0),

    // PDF archivado (ADR 0048).
    pdfPath: text('pdf_path'),
    pdfSha256: text('pdf_sha256'),
    generatedAt: timestamp('generated_at', { withTimezone: true }),
    printCount: integer('print_count').notNull().default(0),
    lastPrintedAt: timestamp('last_printed_at', { withTimezone: true }),

    // Anulación con nota de crédito (B8).
    voidedAt: timestamp('voided_at', { withTimezone: true }),
    voidReason: text('void_reason'),
    voidedByUserId: uuid('voided_by_user_id'),
    voidedByUsername: text('voided_by_username'),

    /** Modo test: la numeración real nunca ve un número de prueba (ADR 0020). */
    isTest: boolean('is_test').notNull().default(false),
    createdByUserId: uuid('created_by_user_id').notNull(),
    createdByUsername: text('created_by_username').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    issuedAt: timestamp('issued_at', { withTimezone: true }),
    issuedByUserId: uuid('issued_by_user_id'),
  },
  (table) => [
    uniqueIndex('uq_invoices_number').on(table.series, table.invoiceNumber),
    index('idx_invoices_status_created').on(table.status, table.createdAt),
    index('idx_invoices_patient').on(table.patientId, table.createdAt),
    check('chk_invoices_status', sql`${table.status} in (${sqlLiteralList(INVOICE_STATUSES)})`),
    /** Emitida = número, tasa, totales y PDF: sin eso no es un documento. */
    check(
      'chk_invoices_issued',
      sql`${table.status} = 'borrador' or (
        ${table.invoiceNumber} is not null and ${table.exchangeRateMicros} is not null
        and ${table.issuedAt} is not null and ${table.pdfPath} is not null)`,
    ),
    /** Las partidas cuadran con el total (la suma manda, no el redondeo). */
    check(
      'chk_invoices_totals',
      sql`${table.exemptAmountCentsUsd} + ${table.taxableAmountCentsUsd} + ${table.ivaAmountCentsUsd}
        = ${table.totalCentsUsd}`,
    ),
    /** El saldo y el estado no pueden contradecirse (una sola verdad). */
    check(
      'chk_invoices_balance',
      sql`${table.balanceCentsUsd} between 0 and ${table.totalCentsUsd}`,
    ),
    check(
      'chk_invoices_status_balance',
      sql`(${table.status} = 'emitida' and ${table.balanceCentsUsd} = ${table.totalCentsUsd})
        or (${table.status} = 'parcial' and ${table.balanceCentsUsd} > 0
            and ${table.balanceCentsUsd} < ${table.totalCentsUsd})
        or (${table.status} = 'pagada' and ${table.balanceCentsUsd} = 0)
        or ${table.status} in ('borrador', 'anulada')`,
    ),
    check(
      'chk_invoices_void_reason',
      sql`${table.status} <> 'anulada' or ${table.voidReason} is not null`,
    ),
  ],
);

/* ── 6. Partidas: copia del arancel, no una referencia viva ────────────────── */

export const invoiceItems = pgTable(
  'invoice_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    invoiceId: uuid('invoice_id')
      .notNull()
      .references(() => invoices.id, { onDelete: 'restrict' }),
    catalogId: uuid('catalog_id').references(() => treatmentCatalog.id, { onDelete: 'set null' }),
    code: text('code').notNull(),
    description: text('description').notNull(),
    toothNumber: integer('tooth_number'),
    surfaces: jsonb('surfaces').$type<string[]>(),
    quantity: integer('quantity').notNull().default(1),
    unitPriceCentsUsd: integer('unit_price_cents_usd').notNull(),
    totalPriceCentsUsd: integer('total_price_cents_usd').notNull(),
    taxCategory: text('tax_category').notNull(),
    /** Alícuota aplicada, copiada: la ley cambia, el papel no (B13). */
    taxRateBasisPoints: integer('tax_rate_basis_points').notNull().default(0),
    ivaAmountCentsUsd: integer('iva_amount_cents_usd').notNull().default(0),
    /** Falta el precio en el catálogo: la caja no se bloquea, se avisa (M3). */
    needsPricing: boolean('needs_pricing').notNull().default(false),
  },
  (table) => [
    index('idx_invoice_items_invoice').on(table.invoiceId),
    check('chk_invoice_items_quantity', sql`${table.quantity} > 0`),
    check(
      'chk_invoice_items_total',
      sql`${table.totalPriceCentsUsd} = ${table.unitPriceCentsUsd} * ${table.quantity}`,
    ),
    check(
      'chk_invoice_items_tax',
      sql`${table.taxCategory} in (${sqlLiteralList(TAX_CATEGORIES)})`,
    ),
  ],
);

/* ── 7. Qué sesiones cubre la factura (N:M, B15) ───────────────────────────── */

/**
 * Un tratamiento que se cobra al final cubre **varias** sesiones, así que el enlace es N:M desde el
 * principio. La unicidad por sesión es además la **segunda red de idempotencia** del consumidor: un
 * evento repetido no puede crear dos borradores para la misma sesión.
 */
export const invoiceSessions = pgTable(
  'invoice_sessions',
  {
    invoiceId: uuid('invoice_id')
      .notNull()
      .references(() => invoices.id, { onDelete: 'cascade' }),
    clinicalSessionId: uuid('clinical_session_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('uq_invoice_sessions_session').on(table.clinicalSessionId),
    uniqueIndex('uq_invoice_sessions_pair').on(table.invoiceId, table.clinicalSessionId),
  ],
);

/* ── 8. Cobros: el dinero que entra, con su tasa y su IGTF ─────────────────── */

export const payments = pgTable(
  'payments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    invoiceId: uuid('invoice_id')
      .notNull()
      .references(() => invoices.id, { onDelete: 'restrict' }),
    /** `REC-000001`. */
    receiptNumber: integer('receipt_number').notNull(),
    method: text('method').notNull(),
    reference: text('reference'),

    /** Lo que el paciente entregó, en la moneda del medio de pago. */
    tenderedAmount: bigint('tendered_amount', { mode: 'number' }).notNull(),
    tenderedCurrency: text('tendered_currency').notNull(),
    /** Lo imputado a la deuda, en céntimos de USD (B6). */
    amountCentsUsd: integer('amount_cents_usd').notNull(),

    /** Tasa congelada de **este** pago y la política con la que se imputó. */
    exchangeRateMicros: bigint('exchange_rate_micros', { mode: 'number' }).notNull(),
    imputationPolicy: text('imputation_policy').notNull(),
    /** Diferencial cambiario respecto de la tasa de la factura (informativo). */
    fxDifferenceCentsUsd: integer('fx_difference_cents_usd').notNull().default(0),

    /** IGTF percibido: alícuota copiada, quién lo entera y montos en las dos monedas. */
    appliesIgtf: boolean('applies_igtf').notNull().default(false),
    igtfBasisPoints: integer('igtf_basis_points').notNull().default(0),
    /** `clinica` = lo percibe y lo entera la clínica; `banco` = ya lo debitó el banco. */
    igtfPerceivedBy: text('igtf_perceived_by'),
    igtfAmountCentsUsd: integer('igtf_amount_cents_usd').notNull().default(0),
    igtfAmountVesCentimos: bigint('igtf_amount_ves_centimos', { mode: 'number' })
      .notNull()
      .default(0),

    pdfPath: text('pdf_path'),
    pdfSha256: text('pdf_sha256'),
    printCount: integer('print_count').notNull().default(0),
    lastPrintedAt: timestamp('last_printed_at', { withTimezone: true }),

    receivedByUserId: uuid('received_by_user_id').notNull(),
    receivedByUsername: text('received_by_username').notNull(),
    /** Modo test: el recibo también usa la numeración reservada. */
    isTest: boolean('is_test').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),

    voidedAt: timestamp('voided_at', { withTimezone: true }),
    voidReason: text('void_reason'),
    voidedByUserId: uuid('voided_by_user_id'),
  },
  (table) => [
    uniqueIndex('uq_payments_receipt').on(table.receiptNumber),
    index('idx_payments_invoice').on(table.invoiceId, table.createdAt),
    index('idx_payments_igtf').on(table.appliesIgtf, table.createdAt),
    check('chk_payments_method', sql`${table.method} in (${sqlLiteralList(PAYMENT_METHOD_CODES)})`),
    check(
      'chk_payments_currency',
      sql`${table.tenderedCurrency} in (${sqlLiteralList(CURRENCIES)})`,
    ),
    check(
      'chk_payments_imputation',
      sql`${table.imputationPolicy} in (${sqlLiteralList(IMPUTATION_POLICIES)})`,
    ),
    check('chk_payments_amount', sql`${table.amountCentsUsd} > 0`),
    check(
      'chk_payments_igtf_consistency',
      sql`(${table.appliesIgtf} = false and ${table.igtfAmountCentsUsd} = 0
            and ${table.igtfPerceivedBy} is null)
        or (${table.appliesIgtf} = true and ${table.igtfAmountCentsUsd} >= 0
            and ${table.igtfPerceivedBy} in (${sqlLiteralList(IGTF_PERCEIVERS)}))`,
    ),
    check(
      'chk_payments_void_reason',
      sql`${table.voidedAt} is null or ${table.voidReason} is not null`,
    ),
  ],
);

/* ── 9. Notas de crédito: obligatorias si la operación queda sin efecto (Art. 22) ── */

export const creditNotes = pgTable(
  'credit_notes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** `NC-000001`. */
    creditNoteNumber: integer('credit_note_number').notNull(),
    invoiceId: uuid('invoice_id')
      .notNull()
      .references(() => invoices.id, { onDelete: 'restrict' }),
    /**
     * Referencia obligatoria a la factura que soportó la operación (Art. 23): fecha, número y monto,
     * **copiados**, porque la factura puede anularse después y la referencia tiene que seguir legible.
     */
    invoiceNumber: integer('invoice_number').notNull(),
    invoiceIssuedAt: timestamp('invoice_issued_at', { withTimezone: true }).notNull(),
    invoiceTotalCentsUsd: integer('invoice_total_cents_usd').notNull(),
    /** `total` = anula la factura entera; `parcial` = ajuste de partidas (Art. 22: las dos). */
    kind: text('kind').notNull().default('total'),
    reason: text('reason').notNull(),
    totalCentsUsd: integer('total_cents_usd').notNull(),
    exchangeRateMicros: bigint('exchange_rate_micros', { mode: 'number' }).notNull(),
    totalVesCentimos: bigint('total_ves_centimos', { mode: 'number' }).notNull(),
    pdfPath: text('pdf_path'),
    pdfSha256: text('pdf_sha256'),
    isTest: boolean('is_test').notNull().default(false),
    issuedByUserId: uuid('issued_by_user_id').notNull(),
    issuedByUsername: text('issued_by_username').notNull(),
    issuedAt: timestamp('issued_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('uq_credit_notes_number').on(table.creditNoteNumber),
    index('idx_credit_notes_invoice').on(table.invoiceId),
    check('chk_credit_notes_total', sql`${table.totalCentsUsd} > 0`),
    check('chk_credit_notes_kind', sql`${table.kind} in ('total', 'parcial')`),
    check(
      'chk_credit_notes_reference',
      sql`${table.invoiceNumber} > 0 and ${table.invoiceTotalCentsUsd} > 0`,
    ),
  ],
);

/** Partidas de una nota de crédito parcial: qué se ajusta y por cuánto. */
export const creditNoteItems = pgTable(
  'credit_note_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    creditNoteId: uuid('credit_note_id')
      .notNull()
      .references(() => creditNotes.id, { onDelete: 'cascade' }),
    invoiceItemId: uuid('invoice_item_id').references(() => invoiceItems.id, {
      onDelete: 'set null',
    }),
    description: text('description').notNull(),
    totalCentsUsd: integer('total_cents_usd').notNull(),
  },
  (table) => [index('idx_credit_note_items_note').on(table.creditNoteId)],
);

/* ── 10. Idempotencia del consumidor (B1) ──────────────────────────────────── */

/**
 * El `eventId` se reclama **en la misma transacción** que crea el borrador: un reintento de la cola,
 * un evento duplicado o un reproceso manual no crean dos facturas. Es la primera red; la segunda es
 * `uq_invoice_sessions_session`, en la base.
 */
export const processedEvents = pgTable('processed_events', {
  eventId: text('event_id').primaryKey(),
  topic: text('topic').notNull(),
  processedAt: timestamp('processed_at', { withTimezone: true }).notNull().defaultNow(),
});
