# ADR 0069 — Diferencial cambiario por Fecha Valor (Escuela A) e IGTF configurable con destino de caja

- **Fecha:** 2026-10-14 · **Estado:** aceptada (fase 12)
- **Documentos que cierra:** especificación funcional «Reglas de Invariancia Contable» (6 invariantes),
  y el cierre contable con el contador (Escuela A: recibo de cobro + reporte contable, sin Nota de
  Débito por diferencial).
- **Reemplaza parcialmente:** [ADR 0045](0045-regimen-tributario-iva-e-igtf.md) (IGTF) y
  [ADR 0046](0046-tasa-bcv-historica-y-regla-de-imputacion.md) (imputación): los **completa**, no los
  contradicen — la tasa sigue histórica y congelada por documento.

## Contexto

Con la regla `tasa_del_pago` (ADR 0046), un abono en bolívares liquidado **después** de la emisión
extingue deuda en USD valorada a la tasa de **hoy**, pero la factura fue contabilizada en el Libro de
Ventas a la tasa de **emisión**. Esa diferencia es un **diferencial cambiario real**, y hoy solo vive
como dato informativo (`fx_difference_cents_usd`, en céntimos de USD): no se desglosa en el recibo ni
aparece en ningún reporte contable, y el papel que se lleva el paciente no explica por qué los Bs que
entregó no son los Bs impresos.

Tres huecos concretos:

1. **Fecha Valor**: el comprobante bancario dice cuándo se hizo la transferencia, no cuándo la tecleó
   el cajero. Un pago móvil del domingo registrado el lunes debe valorarse con la tasa del viernes
   (el BCV no publica fines de semana), y `rateForDate` ya sabe hacerlo —falta que el cobro **declare**
   la fecha a la que aplica—.
2. **Redondeo del Pago Móvil**: el paciente transfiere bolívares **enteros**; la conversión deja residuos
   de céntimos («debo $10,00 y transferí el equivalente a $9,9993») que hoy producen **saldos zombi** de
   $0,01 imposibles de cobrar sin otro recibo.
3. **IGTF**: `billing_settings.is_special_taxpayer` ya existe, pero falta la **alícuota configurable**
   (`igtf_rate_bp`), y sobre todo **en qué moneda entregó el paciente el 3 %**: en divisas a caja o en
   bolívares por Pago Móvil a banco — el arqueo físico tiene que poder separarlos.

Y cuando una factura con diferencial ya realizado se anula con Nota de Crédito, hay que distinguir si
**volvió el dinero** (el diferencial se reversa: nunca se realizó) o si la anulación es **administrativa**
(refacturación: la ganancia/pérdida ya ocurrió y se conserva).

**Adopción de la Escuela A** (elegida con el contador): el diferencial cambiario **no** se factura con
Nota de Débito ni toca el Libro de Ventas de IVA —el tributo nace de la emisión—; se documenta en el
**Recibo de Cobro** y se rinde en un **reporte contable propio** (Estado de Ganancias y Pérdidas por
Diferencial Cambiario).

## Decisión

1. **Fecha Valor (`effective_date`) en cada cobro.** Por defecto el día de Caracas del registro; admite
   la fecha real del comprobante bancario si `issueDate ≤ effectiveDate ≤ hoy`. El cobro congela la tasa
   vigente para **esa** fecha (`rateForDate`, que arrastra la del viernes en fin de semana) en
   `exchange_rate_micros` — mismo campo, nuevo significado: la tasa de la Fecha Valor.
2. **Descomposición tripartita del cobro en bolívares** (en céntimos enteros, redondeo half-up del
   contrato):
   - `amount_bs` = lo que entró al banco/caja (ya vive en `tendered_amount`);
   - `historical_amount_ves_centimos` = los USD amortizados valorados a la **tasa de emisión**
     (`A_USD × T_emisión`): extingue la cuenta por cobrar **nominal** de la factura. La suma de este
     campo cuadra siempre con `total_ves_centimos` del documento.
   - `exchange_diff_ves_centimos` = `tendered − historical` (positivo = ganancia cambiaria).
   - En cobros en divisas: `historical = A_USD × T_emisión` y `exchange_diff = 0` (la moneda funcional
     es el USD; no hay diferencial de caja en bolívares).
3. **Absorción de residuos de redondeo (± 0,05 USD).** Si la diferencia entre lo imputable y el saldo
   pendiente es ≤ 5 céntimos de USD, el cobro **liquida el 100 %** de la deuda y la diferencia se
   absorbe en `exchange_diff_ves_centimos`. Un sobrepago real (> 5 céntimos) se **rechaza**. Así no
   nacen saldos zombi de $0,01.
4. **IGTF configurable con destino de caja.** `billing_settings` gana `igtf_rate_bp` (default 300 =
   3,00 %). La **causa** del tributo sigue mandatada por `igtfDecision` (ADR 0045: quién lo debita —
   banco Art. 4.5 vs clínica SPE Art. 4.6); cuando lo percibe la clínica, el cajero declara
   `igtf_collected_currency`:
   - `USD`: el 3 % entra junto a la base a **Caja Divisas**;
   - `VES`: la base a Caja Divisas y el IGTF convertido a la tasa de la Fecha Valor a **Banco/Caja
     Bolívares**, con `igtf_payment_method` / `igtf_payment_reference` (operación del Pago Móvil).
   El recibo certifica el IGTF (base, alícuota, moneda de percepción).
5. **Notas de Crédito con doble escenario** (`credit_notes.cancellation_type`):
   - `ADMINISTRATIVE` (default): anulación administrativa o refacturación, **sin devolución de dinero**;
     el diferencial cambiario realizado se **conserva** (`reversed_exchange_diff_ves_centimos = 0`).
   - `REFUND`: reembolso real; se reversa el diferencial acumulado de los cobros vigentes de la factura
     (`reversed_exchange_diff_ves_centimos = −Σ exchange_diff`). La Nota de Crédito fiscal **siempre**
     se emite a la tasa original de la factura (anula exactamente el monto del Libro de Ventas).
6. **Escuela A en los papeles**: el Recibo de Cobro desglosa *Imputación a factura (T emisión) / Ajuste
   por diferencial cambiario / Total recibido* y el bloque fiscal del IGTF; el reporte contable
   (Ganancias y Pérdidas cambiarias + Percepción IGTF con arqueo Caja USD vs Banco Bs.) rinde lo que la
   ley no obliga a facturar. **Sin Nota de Débito** por diferencial.

### Adaptaciones al código existente (la spec se ancla a la realidad del repo)

- **Nomenclatura**: la spec dice `BS`/`bs_cents`/`bcvRateApplied`; el repo usa `VES`,
  `...ves_centimos`, `...cents_usd` y la tasa en **micros** (`exchange_rate_micros`). Se conserva la
  nomenclatura del repo: `IgtfCollectedCurrencyEnum = ['USD', 'VES']` (misma moneda que
  `tenderedCurrency`), `historical_amount_ves_centimos`, `exchange_diff_ves_centimos`,
  `igtf_amount_ves_centimos`. La tasa aplicada del cobro es **el propio** `exchange_rate_micros`
  (no se duplica en una columna numérica paralela).
- **Tipos de cambio/contratos**: `CreatePaymentSchema` → `collectPaymentSchema`; `PaymentSchema` →
  `billingPaymentSchema`; `InvoiceDetailSchema` → `billingInvoiceDetailSchema`;
  `CreateCreditNoteSchema` → `voidInvoiceSchema` (más `billingCreditNoteSchema`).
- **Sobrepago**: la spec pide 422; el repo rechaza con `ConflictError` (409), igual que el rechazo
  actual por sobrepago. La semántica —rechazar, no absorber— es lo que importa.
- **Reglas de IGTF por medio de pago** (`igtfDecision`, ADR 0045) **se conservan**: un cobro con tarjeta
  en divisas lo debita el banco y la clínica no vuelve a cobrar el 3 %. El nuevo selector de moneda de
  percepción solo aparece cuando el tributo lo percibe la clínica.
- **Redondeo**: se mantiene `divideHalfUp` (half-up simétrico) como única regla del módulo.

## Consecuencias

- ✅ Los tres montos de todo cobro en Bs. (real, histórico, diferencial) son **recomputables** desde
  `tendered_amount` + tasas; la auditoría no depende de un dato que solo vivía en un PDF.
- ✅ `Σ historical_amount_ves_centimos` de los cobros de una factura cuadra con `total_ves_centimos`:
  la cuenta por cobrar nominal se extingue en la misma moneda en la que se contabilizó.
- ✅ Fin de semana y feriados resueltos por dato (Fecha Valor + arrastre de `rateForDate`), no por
  intervención del cajero.
- ✅ Sin saldos zombi de céntimos: la absorción ±0,05 USD es explícita y queda en el recibo como
  «ajuste de redondeo absorbido».
- ✅ El arqueo físico separa IGTF en Caja Divisas del IGTF en Banco/Caja Bs.; la declaración SENIAT
  quincenal sale del mismo dato.
- ⚠️ La migración **backfillea** los cobros históricos como si su diferencial fuera 0: Fecha Valor =
  día de Caracas del registro y `historical` = lo recibido en Bs. (en divisas, lo imputado a la tasa
  congelada de la factura). Desde la migración, todo cobro nuevo queda con la descomposición completa.
- ⚠️ `imputation_policy = 'tasa_de_la_factura'` (el paciente paga los Bs impresos) sigue existiendo:
  con esa política el diferencial es 0 por construcción. La Escuela A describe el caso
  `tasa_del_pago`, que es el adoptado por el contador.
- ⚠️ Anular un cobro **recompone** el saldo desde los cobros vigentes; el diferencial de un cobro
  anulado deja de contar para el reporte (ya no se «realizó»).
