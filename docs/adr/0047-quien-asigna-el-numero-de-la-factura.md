# ADR 0047 — Quién asigna el número de la factura: formas libres, máquina fiscal o régimen digital

- **Fecha:** 2026-10-05 · **Estado:** aceptada (fase 11; **cierre con el contador** el 2026-10-05: se
  factura en **formas libres** de imprenta autorizada)
- **Plan de la fase:** [`docs/feat_billing.md`](../feat_billing.md) (§5.2, §6, Anexo A)

## Contexto

La factura de un contribuyente ordinario solo puede emitirse por **tres caminos** (Providencia
SNAT/2011/0071, **Art. 6**):

1. **Formatos** o **formas libres** de una imprenta autorizada, con el **número de control preimpreso** y,
   en las formas libres, la razón social y el RIF de la imprenta, la providencia que la autoriza y el
   **rango asignado «desde el N°… hasta el N°…»** (Arts. 7, 30 y 31).
2. **Máquina fiscal.**
3. El **régimen de facturación digital** (Providencia SNAT/2024/000102), que es **opt-in** y solo
   obligatorio para quien opera **exclusivamente** por medios electrónicos.

**Está prohibido llenar a mano una forma libre** y, por tanto, **un PDF impreso en hoja blanca no es una
factura válida**. Esto corrige una premisa de la v1 del plan: la validez no la da el PDF, la da el
**soporte** sobre el que se imprime.

Los servicios odontológicos **no** están en la lista de actividades del **Art. 8**, así que la **máquina
fiscal no es obligatoria** para la clínica (ojo: si crecen las ventas de cosméticos o de artículos
ortopédicos/farmacéuticos del catálogo, esas letras sí están en la lista). Y la providencia que obligaba a
**registrar y homologar a los proveedores de sistemas informáticos de facturación** (SNAT/2024/000121) fue
**derogada** por la **SNAT/2026/00084** (Gaceta 43.435, 12-ago-2026): por eso **el software propio de la
clínica puede emitir los datos sobre las formas libres sin homologación de proveedor**. Lo que **no**
desaparece es la exigencia de soporte del Art. 6: «sin homologación de proveedor» **no** significa
«cualquier PDF en hoja blanca vale».

Requisitos que condicionan el papel: **una página por documento, mínimo 8 cm** y, si la operación no cabe,
**varios documentos cada uno con su número** (Art. 33); fechas en **DDMMAAAA** (Art. 34); **sin enmiendas
ni tachaduras** (Art. 41); los **originales y copias de lo anulado se conservan** (Art. 36); las formas sin
usar **solo se destruyen con autorización del SENIAT** (Art. 40).

**El problema de fondo:** el número de la factura puede venir del software, de una máquina fiscal o de una
forma preimpresa. Modelar «el software numera» como un hecho universal es lo que hacía la v1 con un
`last_invoice_number` en la tabla de perfil: **una carrera** y una suposición falsa.

## Decisión

1. **`invoice_series` declara el modo**: `software` (numeramos nosotros), `formas_libres` (consumimos un
   **rango de control** autorizado y registramos el lote con los datos de la imprenta) o `maquina_fiscal`
   (el número lo da la máquina y se registra al vuelo).
2. **Dos números distintos, y no se confunden**:
   - el **número consecutivo y único** de la factura (Art. 13 num. 2), que sale de una **secuencia**
     nuestra y atómica (`invoice_number_seq`): el correlativo interno del software, `A-000123`;
   - el **número de control preimpreso** (Art. 13 num. 3), que **viene de la forma** y se teclea o se
     escanea al dar de alta el lote.

   La emisión es el **único** punto donde se consumen los dos; `unique(series, number)` más el `CHECK` de
   emitida, patrón exacto de `prescriptions`.
3. **En formas libres, un fallo al generar el PDF no deja un hueco mudo**: la forma se registra como
   **anulada con motivo** («forma dañada») **ocupando su control**, y el documento **se conserva**
   (Art. 36). Lo mismo para el rango agotado o un lote dado de baja.
4. **La plantilla se calibra sobre la forma física** (muestra de la imprenta): márgenes `@page` medidos para
   que el texto caiga **solo en las áreas en blanco**, sin pisar el membrete ni el número de control de la
   imprenta. La calibración se prueba imprimiendo sobre una forma real **antes** de dar la fase por cerrada.
5. **La factura larga se parte**: si las partidas no caben en una página se emiten **varios documentos con
   su propio número**, no un papel de dos caras.
6. **El recibo interno (`REC-`) y la nota de crédito (`NC-`) son series nuestras en cualquier modo** —la
   nota de crédito, además, **obligatoria por ley** cuando la operación queda sin efecto total o
   parcialmente (Art. 22)—.
7. **Contingencia (Art. 10)**: si el sistema está caído se emite en **formatos autorizados** con el número
   precedido de la palabra «serie» y se carga después. El procedimiento se documenta **en la pantalla de
   caja**: no se improvisa.
8. **Numeración reservada en modo test** ([ADR 0020](0020-modo-test.md)): series y rangos de prueba
   (`900.000+`, serie `T`) para que la numeración real nunca vea un número de prueba.

## Consecuencias

- ✅ El módulo sirve para los **tres escenarios sin migración**, y la numeración sigue siendo auditable: el
  papel lleva el número que le corresponde y el sistema sabe de dónde salió.
- ✅ Máquina fiscal y régimen digital quedan **modelados y sin usar**: si cambia el criterio, es
  configuración y alta de un lote, no una migración.
- ⚠️ Con formas libres hay una **carga operativa real**: comprar las formas, alimentarlas en la impresora,
  dar de alta el lote y vigilar el rango. La interfaz tiene que **avisar cuando quedan pocas**, porque
  **quedarse sin formas es quedarse sin poder facturar**.
- ⚠️ **La plantilla no se puede validar en pantalla**: hasta tener las formas y una impresora, la
  calibración del `@page` es una **hipótesis**. El código puede ir cerrado; **la fase no**.
- ⚠️ Si algún día se confirma máquina fiscal, la pantalla de caja gana un paso manual y el PDF del sistema
  pasa a ser el **comprobante interno**, no la factura.

## Alternativas consideradas

- **`last_invoice_number` en una tabla de perfil** (lo que decía la v1): rechazada. Es una carrera entre
  emisiones concurrentes y asume que el número lo da el software.
- **Asumir que el PDF es la factura**: rechazada, y es el error conceptual que este ADR corrige. La
  Providencia 0071 solo admite formas autorizadas o máquina fiscal.
- **Máquina fiscal para todo**: rechazada por innecesaria (Art. 8 no incluye los servicios odontológicos) y
  por cara: obliga a comprar el equipo y a teclear cada operación.
- **Régimen de facturación digital**: rechazada por ahora. Es **opt-in** y la clínica atiende en persona;
  quedaría obligatorio solo si algún día vende **exclusivamente** en línea.
