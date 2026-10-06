# Documento de Arquitectura y Especificación: Módulo de Facturación y Pagos Adaptado al Marco Fiscal Venezolano

Este documento define la integración arquitectónica, el modelo de datos y las directrices normativas para incorporar el nuevo microservicio `services/billing` al ecosistema de OdontoCRM, preservando las convenciones de diseño del proyecto: base de datos desacoplada por servicio, contratos formales, comunicación asíncrona mediante el patrón Outbox/`pg-boss` y máquinas de estado explícitas. (Hecho por Gabriel- Al Agente: Si se puede mejorar algo con una mejor solución, es válido presentarlo)

---

## 1. Registros de Decisión Arquitectónica (ADRs)

### ADR 0043: Módulo de Facturación Desacoplado y Gestión de Pagos

* **Estado:** Aceptado
* **Contexto:**
La evolución de sesiones clínicas (`services/clinical`) y el flujo operativo de citas concluidas (`services/scheduling`) generan obligaciones de cobro. Incorporar lógica contable o pasarelas de pago dentro de los servicios asistenciales violaría el principio de responsabilidad única y acoplaría el expediente clínico a reglas fiscales mutables.


* **Decisión:**
1. Crear un microservicio autónomo `services/billing` con su propia base de datos PostgreSQL (`odontocrm_billing`), siguiendo el patrón de aislamiento del proyecto.


2. La facturación reacciona a eventos de dominio (principalmente `clinical.session.closed`) a través de la cola de eventos compartida, generando automáticamente borradores de cuenta (`draft`) sin bloquear la salida del odontólogo del consultorio.


3. Los montos se modelan estrictamente como enteros en céntimos (`integer` o `bigint`) en la moneda base de referencia contable (USD cents) y tipos `numeric(14, 2)` para la moneda de curso legal (VES), eliminando inconsistencias por redondeo de punto flotante.


* **Consecuencias:**
* *Positivas:* Resiliencia asistencial; si el módulo fiscal o de cobros experimenta demoras, la atención clínica continúa ininterrumpida.


* *Negativas:* Requiere sincronización eventual de datos del paciente mediante eventos (`patient.updated`) y conciliación periódica de estados.





---

### ADR 0044: Régimen Tributario SENIAT y Tratamiento de IVA e IGTF

* **Estado:** Aceptado
* **Contexto:**
La legislación tributaria venezolana establece normas particulares para el sector salud y transacciones multimoneda:
* **Ley del IVA (Art. 18, num. 4):** Los servicios odontológicos y médico-asistenciales están **exentos de IVA**. La venta accesoria de bienes o insumos (ej. cepillos ortodónticos, geles blanqueadores) está gravada con la alícuota general del $16\%$.
* **Ley de IGTF:** Aplica una alícuota del $3\%$ sobre pagos en divisas o moneda extranjera en efectivo cuando la clínica actúa como Sujeto Pasivo Especial ("Contribuyente Especial"). El IGTF grava el medio de pago, no el servicio.


* **Decisión:**
1. Cada ítem del catálogo de tratamientos posee una clasificación fiscal explícita: `tax_category` (`exempt`, `general_16`).
2. Los servicios odontológicos son `exempt` por defecto.
3. El cálculo del IGTF del $3\%$ se desacopla de la factura y se traslada al **evento de transacción/pago**: sólo se calcula e imputa si el medio registrado es efectivo en divisas (`cash_usd`) y el perfil fiscal de la clínica tiene habilitada la condición de contribuyente especial.


* **Consecuencias:**
Cumplimiento tributario riguroso en auditorías del SENIAT y desglose claro entre el saldo de la deuda médica y el tributo percibido.

---

### ADR 0045: Trazabilidad e Inmutabilidad de la Tasa Cambiaria Oficial (BCV)

* **Estado:** Aceptado
* **Contexto:**
La normativa venezolana exige expresar los valores en moneda de cuenta (ej. USD) y en moneda de curso legal (VES) a la tasa oficial informada por el Banco Central de Venezuela correspondiente a la fecha de la operación. Dado que las facturas y los abonos pueden emitirse en fechas distintas (ej. presupuestos o tratamientos en cuotas), calcular o consultar tasas "al vuelo" desde fuentes externas en tiempo real genera incongruencias contables históricas y bloqueos si falla la conectividad.
* **Decisión:**
1. `services/billing` mantendrá una tabla histórica e inmutable de tasas oficiales: `exchange_rates`.
2. Toda factura emitida (`invoices`) congelará en su propia fila el valor numérico exacto de la tasa BCV aplicada al momento de su emisión (`exchange_rate_bcv`), garantizando que la reimpresión o auditoría del documento refleje exactamente los montos en Bolívares de ese instante.
3. Todo pago o abono (`payments`) registrará de forma independiente la tasa BCV vigente al momento de recibir el dinero (`exchange_rate_bcv`), permitiendo conciliar diferencias cambiarias si una factura se cobró días después de ser emitida.
4. La tasa podrá sincronizarse automáticamente mediante un cron/worker o ingresarse manualmente por secretaría al inicio de la jornada operativa con auditoría de usuario.




* **Consecuencias:**
Inmutabilidad histórica total. No hay dependencia de APIs externas durante el cobro en sala y el sistema opera con autonomía en contingencias de red local.



---

## 2. Arquitectura del Servicio `services/billing`

### Árbol de Componentes del Microservicio

```text
services/billing/
├── drizzle.config.ts
├── migrations/
├── src/
│   ├── config.ts
│   ├── index.ts
│   ├── server.ts
│   ├── consumer.ts                  # Consumidor de outbox / pg-boss
│   ├── db/
│   │   ├── client.ts
│   │   ├── migrate.ts
│   │   └── schema.ts                # Tablas Drizzle: invoices, payments, rates, etc.
│   ├── rates/
│   │   ├── rate-service.ts          # Gestión y consulta histórica de tasa BCV
│   │   └── bcv-fetcher.ts           # Worker auxiliar para captura automática
│   ├── billing/
│   │   ├── invoice-service.ts       # Ciclo de vida: draft -> issued -> paid
│   │   ├── payment-service.ts       # Imputación de cobros y cálculo de IGTF
│   │   └── catalog-service.ts       # Precios y categorías impositivas
│   ├── documents/
│   │   └── invoice-pdf.ts           # Motor PDF con doble denominación y formato legal
│   ├── routes/
│   │   ├── billing-routes.ts        # Endpoints consumidos por el Gateway
│   │   ├── rate-routes.ts           # Configuración y consulta de tasas
│   │   └── internal-routes.ts       # Endpoints inter-servicio
│   └── shared/
│       ├── context.ts
│       └── events.ts                # Emisión de billing.invoice.* y billing.payment.*
└── tsconfig.json

```

---

## 3. Esquema de Base de Datos (`services/billing/src/db/schema.ts`)

```typescript
import { pgTable, uuid, text, integer, numeric, timestamp, boolean, pgEnum, date } from 'drizzle-orm/pg-core';

export const taxCategoryEnum = pgEnum('tax_category', [
  'exempt',        // Servicios odontológicos (Art. 18 numeral 4 Ley IVA)
  'general_16',    // Productos/insumos comerciales gravados al 16%
  'reduced_8'
]);

export const invoiceStatusEnum = pgEnum('invoice_status', [
  'draft',           // Borrador generado automáticamente tras sesión clínica
  'issued',          // Emitida y liquidada con correlativo fiscal
  'partially_paid',   // Con saldo deudor pendiente
  'paid',            // Saldada en su totalidad
  'voided'           // Anulada por Nota de Crédito
]);

export const paymentMethodEnum = pgEnum('payment_method', [
  'cash_usd',        // Divisa en efectivo -> Sujeto a IGTF 3% si aplica
  'cash_ves',        // Efectivo bolívares -> Exento de IGTF
  'pago_movil',      // Bancario nacional -> Exento de IGTF
  'pos_debit',       // Punto de venta débito -> Exento de IGTF
  'pos_credit',      // Punto de venta crédito -> Exento de IGTF
  'transfer_ves',    // Transferencia bancaria nacional -> Exento de IGTF
  'zelle',           // Electrónico divisa extranjera
  'international_wire'
]);

// 1. Registro Histórico e Inmutable de Tasas BCV
export const exchangeRates = pgTable('exchange_rates', {
  id: uuid('id').primaryKey().defaultRandom(),
  rate_date: date('rate_date').notNull().unique(), // YYYY-MM-DD
  rate_bcv: numeric('rate_bcv', { precision: 12, scale: 4 }).notNull(), // Ej: 36.5420
  source: text('source').default('bcv_official').notNull(), // 'bcv_official' | 'manual_override'
  set_by_user_id: uuid('set_by_user_id'), // Usuario que confirmó/modificó la tasa
  created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

// 2. Perfil Fiscal de la Clínica
export const clinicFiscalProfiles = pgTable('clinic_fiscal_profiles', {
  id: uuid('id').primaryKey().defaultRandom(),
  legal_name: text('legal_name').notNull(),
  trade_name: text('trade_name'),
  rif: text('rif').notNull().unique(), // J-12345678-0
  fiscal_address: text('fiscal_address').notNull(),
  phone: text('phone').notNull(),
  is_special_taxpayer: boolean('is_special_taxpayer').default(false).notNull(), // Contribuyente Especial
  igtf_percentage: numeric('igtf_percentage', { precision: 5, scale: 2 }).default('3.00').notNull(),
  invoice_series: text('invoice_series').default('A').notNull(),
  last_invoice_number: integer('last_invoice_number').default(0).notNull(),
  updated_at: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

// 3. Catálogo de Aranceles y Tratamientos
export const treatmentCatalog = pgTable('treatment_catalog', {
  id: uuid('id').primaryKey().defaultRandom(),
  code: text('code').notNull().unique(),
  name: text('name').notNull(),
  price_cents_usd: integer('price_cents_usd').notNull(), // Moneda de cuenta base
  tax_category: taxCategoryEnum('tax_category').default('exempt').notNull(),
  is_active: boolean('is_active').default(true).notNull(),
  created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

// 4. Facturas
export const invoices = pgTable('invoices', {
  id: uuid('id').primaryKey().defaultRandom(),
  invoice_number: text('invoice_number').notNull().unique(), // Correlativo fiscal
  control_number: text('control_number'), // Número de control (si usa formas libres)
  patient_id: uuid('patient_id').notNull(),[cite: 1]
  patient_name: text('patient_name').notNull(),
  patient_doc_id: text('patient_doc_id').notNull(), // V-, E-, J-
  patient_fiscal_address: text('patient_fiscal_address'),
  clinical_session_id: uuid('clinical_session_id'), // Trazabilidad médica opcional[cite: 1]
  status: invoiceStatusEnum('status').default('draft').notNull(),

  // TASA HISTÓRICA CONGELADA AL EMITIR
  exchange_rate_bcv: numeric('exchange_rate_bcv', { precision: 12, scale: 4 }).notNull(),

  // Totales en USD (Céntimos)
  exempt_amount_cents_usd: integer('exempt_amount_cents_usd').default(0).notNull(),
  taxable_amount_cents_usd: integer('taxable_amount_cents_usd').default(0).notNull(),
  iva_amount_cents_usd: integer('iva_amount_cents_usd').default(0).notNull(),
  total_cents_usd: integer('total_cents_usd').notNull(),
  balance_cents_usd: integer('balance_cents_usd').notNull(),

  // Totales en VES (Calculados estrictamente con exchange_rate_bcv al momento de emitir)
  exempt_amount_ves: numeric('exempt_amount_ves', { precision: 14, scale: 2 }).notNull(),
  taxable_amount_ves: numeric('taxable_amount_ves', { precision: 14, scale: 2 }).notNull(),
  iva_amount_ves: numeric('iva_amount_ves', { precision: 14, scale: 2 }).notNull(),
  total_ves: numeric('total_ves', { precision: 14, scale: 2 }).notNull(),

  created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  issued_at: timestamp('issued_at', { withTimezone: true }),
  voided_at: timestamp('voided_at', { withTimezone: true }),
});

// 5. Partidas de la Factura
export const invoiceItems = pgTable('invoice_items', {
  id: uuid('id').primaryKey().defaultRandom(),
  invoice_id: uuid('invoice_id').notNull().references(() => invoices.id),
  treatment_catalog_id: uuid('treatment_catalog_id').references(() => treatmentCatalog.id),
  tooth_number: integer('tooth_number'), // Asociación anatómica (ej. 16, 21)[cite: 1]
  description: text('description').notNull(),
  quantity: integer('quantity').default(1).notNull(),
  unit_price_cents_usd: integer('unit_price_cents_usd').notNull(),
  total_price_cents_usd: integer('total_price_cents_usd').notNull(),
  tax_category: taxCategoryEnum('tax_category').notNull(),
  iva_amount_cents_usd: integer('iva_amount_cents_usd').default(0).notNull(),
});

// 6. Pagos / Recibos de Cobro (Abonos)
export const payments = pgTable('payments', {
  id: uuid('id').primaryKey().defaultRandom(),
  invoice_id: uuid('invoice_id').notNull().references(() => invoices.id),
  patient_id: uuid('patient_id').notNull(),[cite: 1]
  method: paymentMethodEnum('method').notNull(),
  reference: text('reference'), // Nº de transacción o referencia bancaria

  // Monto imputado a la deuda
  amount_cents_usd: integer('amount_cents_usd').notNull(),

  // Tasa BCV aplicada al momento exacto de este pago
  exchange_rate_bcv: numeric('exchange_rate_bcv', { precision: 12, scale: 4 }).notNull(),
  amount_ves: numeric('amount_ves', { precision: 14, scale: 2 }).notNull(),

  // Percepción de IGTF (3% sobre divisas en efectivo)
  applies_igtf: boolean('applies_igtf').default(false).notNull(),
  igtf_amount_cents_usd: integer('igtf_amount_cents_usd').default(0).notNull(),
  igtf_amount_ves: numeric('igtf_amount_ves', { precision: 14, scale: 2 }).default('0.00').notNull(),

  received_by_user_id: uuid('received_by_user_id').notNull(), // Auditoría de cajero/secretaria[cite: 1]
  created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

```

---

## 4. Lógica de Dominio y Flujo Operativo

```
[ services/clinical ]               [ services/billing ]               [ apps/web (Caja) ]
        │                                    │                                  │
        │ 1. clinical.session.closed[cite: 1]       │                                  │
        ├───────────────────────────────────►│                                  │
        │                                    │ 2. Crea factura 'draft'          │
        │                                    │    con tasa BCV del día          │
        │                                    │                                  │
        │                                    │ 3. Notifica disponibilidad       │
        │                                    ├─────────────────────────────────►│
        │                                    │                                  │ 4. Paciente pasa a caja
        │                                    │                                  │    Secretaría revisa
        │                                    │ 5. Registra pago + IGTF (si USD) │
        │                                    │◄─────────────────────────────────┤
        │                                    │                                  │
        │                                    │ 6. Emite factura fiscal y recibo │
        │                                    │    congelando tasa y montos      │
        │                                    ├─────────────────────────────────►│
        │                                    │                                  │ 7. Imprime A5 / Carta
        │                                    │                                  │    Doble expresión Bs/USD

```

### Reglas de Liquidación en `payment-service.ts`:

1. **Determinación de IGTF:**
Se valida si la clínica tiene `is_special_taxpayer = true`. Si el paciente entrega `cash_usd`, se calcula:

$$\text{IGTF}_{\text{cents}} = \text{round}(\text{amount\_cents\_usd} \times 0,03)$$



El paciente abona a su saldo exactamente `amount_cents_usd`, pero la caja recauda físicamente:

$$\text{Total Recaudado} = \text{amount\_cents\_usd} + \text{IGTF}_{\text{cents}}$$


2. **Conversión a Moneda de Curso Legal (VES):**
Para cualquier operación en fecha $t$, se obtiene la tasa oficial correspondiente a $t$:

$$\text{Monto}_{\text{VES}} = \left(\frac{\text{amount\_cents\_usd}}{100}\right) \times \text{rate\_bcv}$$


$$\text{IGTF}_{\text{VES}} = \left(\frac{\text{IGTF}_{\text{cents}}}{100}\right) \times \text{rate\_bcv}$$



---

## 5. Especificaciones del Documento Fiscal Impreso

Siguiendo el diseño del documento de récipes en formato A5 implementado en `clinical`:

* **Encabezado Legal:** Razón social, RIF del emisor, dirección fiscal, teléfono de contacto y condición fiscal: *"Contribuyente Especial"* (si aplica) o *"Exento de IVA de conformidad con el Artículo 18, numeral 4 de la Ley del IVA"*.
* **Identificación del Paciente:** Cédula / RIF con prefijo formal (V, E, J), nombre completo y domicilio.
* **Detalle de Partidas:** Cada ítem con columna fiscal explícita: **(E)** para Exento o **(G)** para Gravado.
* **Bloque de Cierre y Liquidación Tributaria:**
* Subtotal Exento en USD y Bolívares.
* Subtotal Gravado en USD y Bolívares.
* Alícuota IVA ($16\%$) en USD y Bolívares.
* IGTF percibido ($3\%$) desglosado por transacción.
* Indicación expresa: `Tasa Oficial BCV aplicada: XX,XXXX Bs./USD correspondiente al DD/MM/AAAA`.
* Total a pagar expresado en ambas denominaciones monetarias.