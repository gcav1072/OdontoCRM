# ADR 0046 — La tasa BCV es histórica, se congela por documento y tiene una regla de imputación explícita

- **Fecha:** 2026-10-05 · **Estado:** aceptada (fase 11; **cierre con el contador** el 2026-10-05: se
  liquida a la **tasa del día del pago**)
- **Plan de la fase:** [`docs/feat_billing.md`](../feat_billing.md) (§0.1, §5.5, Anexo A)

## Contexto

Los valores se expresan en moneda de cuenta (USD) y se pagan en moneda de curso legal (VES). Es **legal y
está expresamente previsto**: el **Convenio Cambiario N.º 1** (Gaceta 6.405 Ext., 7-sep-2018, que desarrolla
el Art. 128 de la Ley del BCV) dice en su **Art. 8.a** que, cuando la obligación se pacta en moneda
extranjera **como moneda de cuenta**, «el pago podrá efectuarse en dicha moneda **o en bolívares, al tipo de
cambio vigente para la fecha del pago**».

Por el lado del IVA, el **Art. 25** de la Ley de IVA manda usar el tipo de cambio **del día del hecho
imponible** —la emisión—, y el **Art. 13 num. 14** de la Providencia 0071 exige que la factura muestre
**ambas cantidades y el tipo de cambio aplicable**. Es decir: **la ley pide dos tasas distintas en dos
momentos distintos**, y las facturas y los abonos caen en fechas diferentes (cuotas, tratamientos largos).

Consultar la tasa «al vuelo» en cada operación produce incongruencias (la misma factura con dos tasas según
cuándo se mire) y depende de la red. Y la red no es un supuesto teórico:

- El **BCV publica solo en días hábiles** (fines de semana y feriados conservan la última tasa).
- **No tiene API oficial**: es una página web con formato humano, así que cualquier «API del BCV» de
  terceros es un raspado de esa página.

**Lo que quedó cerrado:** ¿el paciente paga los Bs impresos en la factura, o se recalcula con la tasa del
día del pago? Era la decisión más importante del módulo y estaba indefinida. El contador eligió la tasa del
día del pago.

## Decisión

1. **`exchange_rates`: tabla histórica y de solo agregado** (una fila por fecha y fuente, con
   `supersedes_id` si hay corrección). La tasa se guarda en **micros** (entero) y se identifica su origen:
   `bcv_oficial`, `manual` o `arrastre`. Una sola tasa vigente por día (`unique index` parcial donde
   `superseded_by_id is null`).
2. **Al emitir**, la factura **congela la tasa del día del hecho imponible** (Art. 25) y sus totales en
   ambas monedas —que es la obligación de forma del Art. 13 num. 14—.
3. **Al cobrar**, el pago **congela su propia tasa**, el monto **entregado** por el paciente y su moneda.
4. **Regla de imputación: una sola política por instalación**, guardada en `billing_settings` y **registrada
   en cada pago**:
   - `tasa_del_pago` (**la adoptada**, y la que describe el Convenio Cambiario Art. 8.a): el paciente paga
     en Bs **al valor de hoy**; los Bs impresos en la factura son referenciales («a la tasa del DD/MM/AAAA»)
     y las diferencias cambiarias quedan del lado del paciente.
   - `tasa_de_la_factura`: el paciente paga **exactamente** los Bs impresos; la clínica asume la diferencia.

   En los dos casos se guardan **los dos hechos** (`tendered_amount`, `exchange_rate_micros` y
   `fx_difference_cents_usd`), así que el diferencial se puede recalcular y reportar sin volver a tomar la
   decisión: cambiarla es un `update` de una fila.
5. **Sin red, la caja no se detiene**: si no hay tasa para la fecha se usa la última publicada
   (`arrastre`) y la pantalla avisa; con un hueco mayor al umbral configurado (`rate_grace_days`), cobrar
   **exige confirmación**. La captura automática (`bcv-fetcher`) es **best-effort**, nunca bloquea la caja y
   siempre queda el **ingreso manual auditado**.
6. **Todo se calcula en `America/Caracas`**: el «día» de la tasa y de la operación no es UTC.
7. Como los Bs se liquidan a la tasa de la fecha del pago, **la factura lleva impresa la leyenda de doble
   tasa** con el texto que fijó el contador, y el recibo lleva la tasa del pago.

## Consecuencias

- ✅ Reimpresión y auditoría muestran **exactamente lo que decía el papel**: la tasa aplicada no se
  recalcula al volver a mirar.
- ✅ El módulo **funciona sin internet**: la caja nunca llama al BCV; si la captura automática falla, la
  secretaría ingresa la tasa a mano (con auditoría) o la caja cobra con la última publicada y lo avisa.
- ✅ La política cambiaria es una **decisión explícita y visible**, no un efecto colateral del redondeo; y
  el papel la declara, que es lo que evita la discusión en el mostrador.
- ✅ La factura cumple el doble requisito de mostrar **las dos monedas y la tasa** (Art. 13 num. 14).
- ⚠️ El arrastre introduce una **confirmación humana** en el camino del cobro cuando el hueco supera el
  umbral. Es deliberado: cobrar con una tasa vieja es una decisión, no un accidente.
- ⚠️ La corrección de una tasa **no toca lo ya emitido**: la fila anterior queda como historia y la nueva
  apunta a ella. Lo emitido con la tasa vieja sigue diciendo lo que decía.

## Alternativas consideradas

- **Consultar la tasa del BCV en cada operación**: rechazada. La misma factura mostraría tasas distintas
  según el momento de la consulta, y la caja quedaría dependiendo de una página web sin API.
- **`tasa_de_la_factura` (congelar los bolívares impresos)**: es una opción legítima y está modelada y
  configurable, pero el contador eligió `tasa_del_pago` porque es lo que describe el Convenio Cambiario
  Art. 8.a y porque la diferencia cambiaria en tratamientos largos la terminaría asumiendo la clínica.
- **Guardar la tasa como `numeric`**: rechazada por la misma razón que el resto del dinero
  ([ADR 0044](0044-modulo-de-facturacion-desacoplado.md)): enteros, sin punto flotante.
- **Una tasa por «día de caja» en hora local del servidor**: rechazada. El día de la tasa y el del hecho
  imponible son de `America/Caracas`, no del reloj del servidor.
