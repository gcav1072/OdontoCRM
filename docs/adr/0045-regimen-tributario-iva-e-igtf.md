# ADR 0045 — Régimen tributario: servicios exentos, bienes al 16 % y el IGTF como dato del medio de pago

- **Fecha:** 2026-10-05 · **Estado:** aceptada (fase 11; **cierre fiscal con el contador** el 2026-10-05)
- **Plan de la fase:** [`docs/feat_billing.md`](../feat_billing.md) (§0.1, Anexos A y B)

## Contexto

**IVA.** Los servicios odontológicos y médico-asistenciales están **exentos** de IVA (Ley de IVA, **Art. 19,
numeral 6**; *no* el Art. 18.4, que habla de **ventas** de bienes —prótesis incluidas—). La **venta
accesoria de bienes** (cepillos, geles, insumos) está **gravada**: el Art. 27 fija la banda 8 %–16,5 % y el
Art. 63 la fija en **16 %** hasta que el Ejecutivo diga otra cosa; **la alícuota reducida del 8 % no está
vigente**. Y como la clínica factura sobre todo exento, **no puede deducir el IVA de sus compras**
(Art. 33): el IVA de insumos, laboratorio y alquiler es **costo**, no crédito fiscal.

**IGTF.** Grava el **medio de pago** (Ley de IGTF, Gaceta Oficial Extraordinaria 6.687, 25-feb-2022). El
**Art. 24** fija 3 % para los supuestos de divisas y 2 % para los generales, pero el **Decreto 4.972**
(Gaceta 6.821 Ext., jul-2024) bajó el general a **0 %**: hoy lo que le importa a la clínica es el **3 % de
las operaciones en divisas**, y **no es solo efectivo** (Art. 3 nums. 6 y 8):

- **Divisas a través del sistema bancario nacional** (tarjeta o transferencia en divisas) → **Art. 4.5**,
  aplica a cualquiera y **lo debita el banco**.
- **Divisas sin mediación de instituciones financieras** (efectivo USD, **Zelle**, PayPal, USDT) →
  **Art. 4.6**, y ahí **la clínica solo percibe si está calificada como Sujeto Pasivo Especial (SPE)**,
  condición que **notifica el SENIAT**: no se autodeclara.

El **período del IGTF es de un día** (Art. 15) y **no es deducible de ISLR** (Art. 18): es dinero de
terceros que se recauda y se entera.

**Requisito de forma.** La Providencia **SNAT/2011/0071, Art. 13 num. 8** pide la letra **`(E)`** junto a
la partida exenta/exonerada/no sujeta y el **num. 10** el **total exento separado** de la base gravada; el
«**sin derecho a crédito fiscal**» de las **copias** es el Art. 13 num. 13.

**Lo que quedó cerrado con el contador (2026-10-05):** la clínica es **contribuyente ordinario y no está
calificada como SPE**, así que **no percibe IGTF en caja**; y **sí vende bienes gravados**, así que el
camino del 16 % tiene que quedar activo y probado.

## Decisión

1. **Cada ítem del catálogo lleva `tax_category`** (`exento` | `general`) y **el documento copia la alícuota
   aplicada** (`tax_rate_basis_points`): los porcentajes viven en `tax_rates` con **fecha de vigencia**, no
   en una columna editable. Se **elimina `reduced_8`**: el 8 % es el piso de la banda, no una alícuota
   vigente.
2. **Los servicios odontológicos son `exento` por defecto** (con la letra `(E)` en el papel); **los bienes,
   `general` al 16 %**, con la letra `(G)`. La factura puede salir **mixta**, con las bases desglosadas por
   alícuota y el total exento aparte.
3. **El IGTF no forma parte de la factura**: se calcula en el **cobro**, se copia la alícuota aplicada y
   **quién lo percibe** (`clinica` | `banco`), y se imprime en el **recibo** con su propia línea. Si lo
   debita el banco, la clínica **no lo cobra dos veces**: solo lo registra para conciliar el extracto.
4. **Qué medios causan IGTF y quién lo percibe es configuración por medio de pago** (`igtf_rules`, con
   vigencia), **no un `if`**. Configuración de esta clínica: `is_special_taxpayer = false`, **ningún medio
   con percepción de la clínica** —todos `no_aplica` o `banco`—, así que el recibo **no cobra IGTF**;
   tarjeta y transferencia en divisas quedan marcadas como «lo debita el banco».
5. **La calificación de SPE es un dato de configuración con su fecha y su constancia** (`spe_notified_at`,
   `spe_reference`); hoy: sin constancia ⇒ `false`. Mientras esté en `false`, la interfaz **bloquea**
   añadir IGTF a un cobro y muestra «Clínica no calificada como Sujeto Pasivo Especial (IGTF no
   percibido)»; con `true`, el 3 % se calcula solo sobre la partida del recibo. Es el error más caro en los
   dos sentidos: cobrar un tributo que no corresponde, o no cobrarlo cuando sí.
6. **La alícuota adicional por pago en divisas** (Art. 27 ¶4 y **Art. 62**, 5 %–25 %) queda como **gancho de
   configuración en 0 %** mientras no exista el Decreto que la active. Su parágrafo primero dice que en las
   operaciones **exentas** solo aplica esa adicional, así que el gancho la aplica también a las líneas
   exentas y la copia en el documento.
7. **El reporte de IGTF percibido por día es parte del alcance**: sin él, la clínica no puede enterarlo.

## Consecuencias

- ✅ Cambiar una alícuota es un `insert` con vigencia, no una migración ni un `update` que reescriba la
  historia: lo emitido conserva la alícuota que se aplicó.
- ✅ El desglose exento/gravado sale en el documento y en el **libro de ventas** (base desglosada por
  alícuota y total exento aparte, como pide el Art. 13 num. 10).
- ✅ El camino del 16 % no queda dormido: el catálogo nace con **bienes de ejemplo** y hay una prueba de
  factura mixta.
- ⚠️ El IGTF percibido, cuando algún día aplique, es **dinero de terceros** con **período diario**: debe
  cuadrar caja contra recaudación, y eso es una comprobación de la interfaz.
- ⚠️ **No se construye libro de crédito fiscal de compras** (Art. 33): el IVA de las compras es costo. Lo
  lleva el contador fuera del sistema.
- ⚠️ Con `is_special_taxpayer = false` el IGTF queda **modelado, probado y apagado**. Si el SENIAT notifica
  a la clínica como SPE, se enciende con un interruptor y una fecha; no hay que tocar código.

## Alternativas consideradas

- **`igtf_percentage` en una columna e IVA del 16 % cableado en el enum**: rechazada. Un cambio de ley
  reescribiría lo ya emitido.
- **Cobrar el 3 % en todos los pagos en divisas**: rechazada. En los bancarizados el agente de percepción es
  el **banco** (Art. 4.5): cobrarlo sería cobrar dos veces.
- **Cobrar el 3 % en efectivo/Zelle sin ser SPE**: rechazada. El Art. 4.6 lo reserva a quien esté
  calificado; el contador confirmó que la clínica **no** lo está.
- **Asumir que la exención es el Art. 18.4**: corregida. El 18.4 se refiere a **ventas** de bienes
  (prótesis incluidas), no a servicios; la exención de servicios odontológicos es el **Art. 19.6**.
