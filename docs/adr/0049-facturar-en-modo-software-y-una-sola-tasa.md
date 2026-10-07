# ADR 0049 — Facturar en modo `software` por defecto, y una sola regla de tasa

- **Fecha:** 2026-10-06 · **Estado:** aceptada (fase 11)
- **Plan de la fase:** [`docs/feat_billing.md`](../feat_billing.md) (§5.1, §5.3, §7)
- **Relacionada:** [ADR 0047](0047-quien-asigna-el-numero-de-la-factura.md) — quién asigna el número;
  [ADR 0046](0046-tasa-bcv-historica-y-regla-de-imputacion.md) — la tasa y su regla; [ADR 0048](0048-el-documento-de-cobro-se-archiva.md)
  — lo emitido se archiva.

## Contexto

La Fase 11 construyó **dos** formas de numerar (el correlativo interno, modo `software`, y el **número de
control preimpreso** de un lote de formas libres, modo `formas_libres`) y **dos** políticas de imputación
del pago (a la tasa del pago o a la de la factura). Las dos, como **dato** y no como código: era el punto.

Al ir a probar el sistema **sembrando datos** apareció el coste de haber dejado el camino difícil por
defecto: la serie sembrada es `formas_libres`, así que **sin lote no se emite**. Un lote arrastra rango,
imprenta, providencia, solapamientos, consumo en orden, formas dañadas y aviso de pocas — un módulo
entero en el camino crítico antes de que exista una sola forma comprada.

Dos hechos más, decididos por el odontólogo el 2026-10-06: **cada instalación sirve a una sola persona
jurídica** (sus datos en el entorno; las otras serán ramas del repositorio) y la impresión es en **papel
común**, no sobre formas preimpresas.

## Decisión

1. **`software` es el modo por defecto**: el del esquema y el de la serie sembrada. El número de la factura
   es el **correlativo interno** y el control queda `null`. `formas_libres` pasa a ser **opcional por
   serie**, para el día que se compren formas autorizadas: su módulo queda construido y **probado**, pero
   **fuera del camino crítico**.
2. **Una sola regla de tasa: la del pago** (Convenio Cambiario N.º 1, Art. 8.a). La columna
   `imputation_policy` se conserva como **registro** de lo que se hizo, pero la caja **no ofrece la
   elección** y el valor por defecto es `tasa_del_pago`. El diferencial cambiario se sigue guardando como
   dato informativo.
3. **El libro va en USD y los bolívares son una foto congelada** a la tasa del documento. No se revalúa: un
   arancel de 30 US$ sigue valiendo 30 US$ dentro de un año.

## Consecuencias

- **Emitir necesita solo una tasa publicada.** El seed de prueba se vuelve corto —tasa, borradores y un par
  de facturas con sus cobros— y la caja emite desde el primer minuto después de sembrar.
- El número de control es **dato opcional**, y eso no cuesta código: la columna ya era `null`-able, la
  plantilla del PDF ya no imprime la línea si no existe y los libros ya lo dejan vacío.
- Cambiar de modo más adelante es **dato por serie** (`numbering_mode`), no una reescritura. Esa fue la
  razón de modelarlo así desde el principio, y es lo que hace que este ADR sea barato.
- Lo que se cede: sin formas preimpresas, la garantía de que un número no se repite vive en la
  **secuencia**, en el **PDF archivado** ([ADR 0048](0048-el-documento-de-cobro-se-archiva.md)) y en la
  **auditoría**, no en el papel.
- El camino de `formas_libres` **sigue probado** (su suite no se toca): lo que cambia es que deja de ser el
  que estrena el sistema.
- **Advertencia fiscal:** si facturar en modo `software` exige autorización como imprenta digital, eso lo
  decide el contador. Lo que fija este ADR es que **el código no obligue a la opción difícil**.

## Alternativas descartadas

- **Dejar `formas_libres` por defecto**: exige tener lote para poder emitir —lo que rompe la primera prueba
  después de sembrar— y mantener rangos y vigencias antes de que existan formas compradas.
- **Ofrecer las dos políticas de imputación en la caja**: convierte cada cobro en una decisión que hay que
  explicarle a la secretaría, cuando la ley ya dice cuál toca.
- **Llevar el libro en bolívares y revaluar**: precios que se mueven solos, céntimos que no cuadran y
  aranceles que hay que retocar cada semana.
