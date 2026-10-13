# ADR 0067 — La partida escrita a mano en la factura

- **Fecha:** 2026-10-13
- **Estado:** aceptado
- **Anexo a:** [ADR 0044 — El módulo de facturación es un servicio desacoplado](0044-modulo-de-facturacion-desacoplado.md)
- **Fuente de verdad en código:** `packages/contracts/src/domain/billing.ts`, `services/billing/src/billing/invoice-service.ts`, `apps/web/src/lib/caja.ts`, `apps/web/src/pages/CajaPage.tsx`

## Contexto

La caja solo podía facturar lo que estuviera en el **arancel** (`treatment_catalog`): un producto o
servicio suelto —un retiro de brackets, un cepillo, un trabajo de laboratorio— había que darlo de
alta en el catálogo **antes** de cobrarlo, lo que frena el mostrador. Y la exención de los servicios
odontológicos (Ley de IVA Art. 19.6) frente a los bienes al 16 % obliga a que la **categoría fiscal**
de la partida se declare con criterio: no vale «lo que diga el catálogo» para algo que no está en él.

## Decisión

1. El borrador acepta una partida **escrita a mano**, identificada con el código centinela
   `MANUAL_LINE_CODE = 'manual'` (sin fila en `treatment_catalog`).
2. Su **categoría fiscal** viaja en la línea (`draftItemInputSchema.taxCategory`, hoy `exento` o
   `general`) y se **copia** en el documento como la de cualquier partida; la caja la elige con una
   **casilla «Exento de IVA»** (marcada = 0 %, sin marcar = 16 %).
3. En las partidas **del arancel** la categoría se **ignora**: la manda el catálogo, para que un
   servicio odontológico no se pueda facturar gravado desde la interfaz.
4. La **descripción es obligatoria** para guardar o emitir una línea manual.
5. La partida manual sale con su letra **`(E)`/`(G)`** y entra en el desglose de bases como cualquier
   otra (**sin migración**: `invoice_items` ya guardaba categoría y alícuota por partida).

## Alternativas consideradas

- **Dar de alta un arancel «Otro procedimiento» editable**: descartado — mezcla el catálogo —que
  cruza con `SESSION_PROCEDURES`, los reportes y el borrador automático— con lo ad-hoc, que **no**
  debe contarse como procedimiento clínico.
- **Permitir recategorizar cualquier partida**: descartado — abre la puerta a facturar exento un bien
  gravado y al revés.

## Consecuencias

- La caja no se bloquea por un producto que no está dado de alta.
- La contabilidad sigue cuadrando porque la categoría se **copia** en el documento emitido.
- El código `manual` **no** es un procedimiento del catálogo clínico: si algún día hay reportes de
  procedimientos por código a partir de las facturas, hay que excluirlo o agruparlo aparte.
