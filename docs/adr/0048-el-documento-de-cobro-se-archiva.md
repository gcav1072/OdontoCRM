# ADR 0048 — El documento de cobro se archiva: emitir es congelar, y anular no es borrar

- **Fecha:** 2026-10-05 · **Estado:** aceptada (fase 11)
- **Plan de la fase:** [`docs/feat_billing.md`](../feat_billing.md) (§5.2, §5.4, §6)
- **Relacionada:** [ADR 0036](0036-recipe-emitido-documento-archivado.md) — es la misma decisión, aplicada
  al dinero.

## Contexto

Este ADR es el [0036](0036-recipe-emitido-documento-archivado.md) aplicado al dinero, y las preguntas son
exactamente las mismas que allí: el paciente corrige su nombre **después** de emitir, se cambia un precio
del catálogo, hay un error en un cobro ya entregado.

Lo que cambia con el dinero es la consecuencia de equivocarse:

1. **El papel que tiene el paciente no puede cambiar.** Un comprobante que dice una cosa y una base que dice
   otra es una discusión en el mostrador y, en materia fiscal, un documento que no respalda nada.
2. **Un documento fiscal tiene requisitos de forma** (Providencia SNAT/2011/0071): numeración consecutiva y
   única, fechas en `DDMMAAAA`, **sin enmiendas ni tachaduras** (Art. 41), y los **originales y copias de lo
   anulado se conservan** (Art. 36). «Editar» no es una opción: no existe la casilla de «corregido».
3. **La operación que queda sin efecto exige un documento nuevo**, no un borrado: la **nota de crédito** es
   **obligatoria** cuando la operación queda sin efecto —total **o parcialmente**— o genera un ajuste
   (Art. 22), y tiene que **referenciar la factura original** con **fecha, número y monto** (Art. 23).
4. **Reimprimir no puede recomponer.** Si el PDF se compone al vuelo cada vez que alguien pulsa «imprimir»,
   una plantilla cambiada reescribe el pasado: dos impresiones del mismo número dirían cosas distintas.

## Decisión

**Emitir es congelar.** La factura, el recibo y la nota de crédito guardan:

- la **instantánea del paciente** (nombre, tipo y número de documento, RIF y dirección fiscal si factura con
  crédito fiscal): lo que la ficha diga después no toca el papel;
- la **instantánea de cada partida** (código, descripción, cantidad, precio unitario, **categoría fiscal y
  alícuota aplicada**): el catálogo se puede mantener sin miedo;
- la **tasa congelada** y los totales en las **dos monedas**
  ([ADR 0046](0046-tasa-bcv-historica-y-regla-de-imputacion.md));
- **un** PDF, generado **una vez** (fuera de la transacción, que Chromium tarda) y archivado con su
  `sha256`. Si la transacción falla, el archivo se borra.

**Toda impresión o descarga cuenta**: `print_count` y `last_printed_at` se incrementan y el acto deja
evento. Lo que se reimprime es **el mismo archivo**.

**Un documento emitido nunca se borra ni se edita.** Se **anula con motivo y actor**, y en el caso de la
factura se emite su **nota de crédito**, que es un documento con **numeración propia** (`NC-000001`,
consecutiva y única), su PDF archivado y la **referencia copiada** a la factura (fecha, número y monto),
porque la factura puede anularse después y la referencia tiene que seguir siendo legible.

**Un pago tampoco se borra**: se anula con motivo (`billing:void`), se conserva su PDF y **el saldo se
recalcula en la misma transacción** desde los pagos vigentes. La coherencia entre estado y saldo la vigila
la base con un `CHECK`, y una prueba de integración recalcula el saldo desde cero y lo compara con el
guardado: si alguien introduce un camino que no lo actualiza, se ve.

## Consecuencias

- ✅ El papel del paciente y la base dicen **lo mismo dentro de diez años**: la reimpresión es el mismo
  archivo y la auditoría muestra exactamente lo que se emitió.
- ✅ El catálogo se puede mantener sin miedo: cambiar un precio **no** reescribe nada, y el cambio queda
  auditado con su valor anterior y nuevo.
- ✅ Un error de cobro se corrige **con un rastro**, no con un `update`: quién, cuándo y por qué.
- ✅ La numeración fiscal no se puede reutilizar: una forma dañada ocupa su control y se conserva
  ([ADR 0047](0047-quien-asigna-el-numero-de-la-factura.md)).
- ⚠️ Corregir de verdad cuesta más que un `update`: hay que emitir la nota de crédito y, si procede, una
  factura nueva. Es el precio de que el papel no mienta, y es el mismo que ya se paga con el récipe.
- ⚠️ **Nada se purga**: los documentos anulados se conservan (Art. 36) y las formas sin usar solo se
  destruyen con autorización del SENIAT (Art. 40). El almacenamiento crece de forma monótona.
- ⚠️ El PDF archivado es un **artefacto con `sha256`**: hay que respaldarlo junto con la base (vive en
  `storage/billing`), o la fila quedaría apuntando a un archivo que no está.

## Alternativas consideradas

- **Recomponer el PDF al imprimir** (lo que decía la v1 del plan, «motor PDF»): rechazada. Una plantilla
  cambiada reescribiría el pasado, y el Art. 41 prohíbe las enmiendas: el documento tiene que ser el que se
  emitió.
- **Anular con un `update` de estado** (un comentario `voided // Anulada por Nota de Crédito`, que es lo que
  decía la v1): rechazada. La ley **exige** la nota de crédito como documento, con su número y su
  referencia; un estado no la sustituye.
- **Borrar un pago mal registrado**: rechazada. Es la misma regla del récipe emitido
  ([ADR 0036](0036-recipe-emitido-documento-archivado.md)): se anula con motivo y el saldo se recalcula.
- **Un contador de impresiones en memoria**: rechazada. La reimpresión es un acto auditable —puede ser la
  segunda copia de una factura— y tiene que quedar en la fila y en la auditoría.
