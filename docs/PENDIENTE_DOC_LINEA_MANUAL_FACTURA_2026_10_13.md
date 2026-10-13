# Pendiente de documentación — partida escrita a mano en la factura (Caja)

> **Qué es este archivo.** La **línea manual** de la Caja —poder facturar un producto o servicio que
> **no está en el arancel**, escrito a mano, con su **IVA** (exento o gravado), su **precio** y sus
> **unidades**— ya está en el **código**, pero su **documentación no se tocó a propósito**: en la otra
> PC hay commits sin subir que editan `CHANGELOG.md` y varios docs, y meter aquí esas mismas ediciones
> provocaría conflictos de rama. Este archivo reúne **todo lo que hay que actualizar** cuando se
> fusionen los dos lados; después se puede borrar.
>
> **Regla de oro al aplicarlo:** NO reescribir secciones enteras. Añadir la entrada del CHANGELOG
> **arriba** y tocar los docs con el **mínimo** de líneas, como se indica abajo.

**Qué se implementó (en código, ya hecho):** en el borrador de `/caja` hay un botón **«Añadir línea
manual»** junto al desplegable del arancel. La partida nace **vacía y exenta**, con la **descripción
editable**, una **casilla «Exento de IVA»** (marcada = exento 0 %; sin marcar = gravado 16 %), el
**precio** y las **unidades**. La **descripción es obligatoria** para guardar o emitir. La **categoría
de las partidas del arancel no se puede cambiar**: la manda el catálogo (un servicio odontológico no se
factura gravado desde la Caja).

Piezas tocadas (para referencia al documentar):

| Pieza | Qué hace |
| :--- | :--- |
| `packages/contracts/src/domain/billing.ts` | Nuevo `MANUAL_LINE_CODE = 'manual'`; `draftItemInputSchema` gana `taxCategory` opcional (solo la línea manual la declara) |
| `services/billing/src/billing/invoice-service.ts` | `buildItems` toma `delCatalogo?.taxCategory ?? line.taxCategory ?? 'exento'`: **el arancel manda** y solo la partida sin arancel declara la suya |
| `apps/web/src/lib/caja.ts` | `esLineaManual`, `nuevaLineaManual`, `faltaDescripcionManual`; `linesReady` exige descripción en las manuales; `toDraftItems` envía `taxCategory` |
| `apps/web/src/pages/CajaPage.tsx` | Botón «Añadir línea manual», descripción editable y casilla «Exento de IVA» en la fila |
| `apps/web/src/lib/i18n.ts` | Claves `caja.anadir.manual`, `caja.manual.descripcion`, `caja.manual.exento`, `caja.manual.descripcionFalta` |
| `apps/web/src/lib/caja.test.ts` · `services/billing/src/draft.integration.test.ts` | Pruebas de la línea manual y de que el arancel manda sobre la categoría |

> **Sin migración.** Las columnas (`tax_category`, `tax_rate_basis_points`…) ya existían en
> `invoice_items`; solo se dejó de forzar la categoría del catálogo. La línea ya llevaba su letra
> `(E)`/`(G)` y su desglose hasta el PDF.

---

## 1. `CHANGELOG.md` — entrada nueva (arriba del todo)

Añadir una sección al principio (respetando el estilo Keep a Changelog del archivo), con un texto
equivalente a este:

```markdown
## [Caja] — Partida escrita a mano en la factura · 2026-10-13

La caja solo podía facturar lo que estuviera en el **arancel**: un producto o servicio suelto (un
retiro de brackets, un cepillo, un trabajo de laboratorio) había que darlo de alta en el catálogo
antes de cobrarlo. Ahora el borrador tiene un botón **«Añadir línea manual»** que agrega una partida
**escrita a mano**: descripción, **casilla «Exento de IVA»** (marcada = exento al 0 %; sin marcar =
gravado al 16 %), precio y unidades. La **descripción es obligatoria** para guardar o emitir, y la
**categoría fiscal de las partidas del arancel no se puede cambiar** (la manda el catálogo, para que
un servicio odontológico no se pueda facturar gravado desde el mostrador). La partida manual sale en
la factura con su letra **`(E)`/`(G)`** y entra en el desglose de bases como cualquier otra.

| Pieza | Qué hace |
| :--- | :--- |
| `MANUAL_LINE_CODE` (contratos) | El código centinela `manual` y el `taxCategory` opcional de la línea del borrador |
| `buildItems` (billing) | La categoría sale del catálogo si la partida está en él; solo la línea manual declara la suya |
| `CajaPage` / `caja.ts` | «Añadir línea manual», descripción obligatoria y casilla «Exento de IVA» |

> **Sin migración**: `invoice_items` ya guardaba la categoría y la alícuota de cada partida.
```

---

## 2. ADR — decisión nueva (`docs/adr/00NN-partida-escrita-a-mano-en-la-factura.md`)

**Número por asignar.** En `docs/adr/` el mayor es **0065**. Ojo: el
[`PENDIENTE_DOC_REFACTOR_LOBBY_2026_10_13.md`](PENDIENTE_DOC_REFACTOR_LOBBY_2026_10_13.md) también
sugiere el **0066** para la estética de las pantallas. **Coordinar cuál se aplica primero**: el que
llegue después toma el **0067**. (Si el del lobby ya está aplicado cuando se lea esto, este ADR va
como **0067**.)

Registrar la decisión con, al menos:

- **Contexto:** el arancel cubre los tratamientos y unos pocos bienes de ejemplo, pero en el mostrador
  aparecen productos y servicios que no están en el catálogo (trabajos de laboratorio, retiros de
  ortodoncia, un cepillo suelto). Obligarlos a pasar por el catálogo antes de cobrar frena la caja, y
  la exención de los servicios odontológicos (Ley de IVA Art. 19.6) frente a los bienes al 16 % obliga
  a declarar la categoría de la partida con criterio.
- **Decisión:**
  - El borrador acepta una partida **escrita a mano**, identificada por el código centinela
    `MANUAL_LINE_CODE = 'manual'` (sin fila en `treatment_catalog`).
  - Su **categoría fiscal** viaja en la línea (`draftItemInputSchema.taxCategory`, hoy solo `exento` o
    `general`) y se **copia** en el documento como la de cualquier partida; la caja la elige con una
    casilla («Exento de IVA»).
  - En las partidas del **arancel** la categoría se **ignora**: la manda el catálogo, para que un
    servicio odontológico no se pueda facturar gravado desde la interfaz.
  - La **descripción es obligatoria** para guardar o emitir una línea manual.
- **Alternativas consideradas:** dar de alta un arancel «Otro procedimiento» editable (descartado:
  mezcla el catálogo —que cruza con `SESSION_PROCEDURES`, los reportes y el borrador automático— con
  lo ad-hoc, que no debe contarse como procedimiento); permitir recategorizar **cualquier** partida
  (descartado: abre la puerta a facturar exento un bien gravado y al revés).
- **Consecuencias:** la caja no se bloquea por un producto que no está dado de alta; la contabilidad
  sigue cuadrando porque la categoría se copia en el documento; el código «manual» **no** es un
  procedimiento del catálogo clínico y no debe entrar en los reportes por código.

---

## 3. `docs/adr/README.md` — fila nueva en la tabla

Añadir la fila del ADR nuevo (con su número definitivo) y subir el contador del encabezado si procede:

```markdown
| [00NN](00NN-partida-escrita-a-mano-en-la-factura.md) | La caja puede facturar una partida **escrita a mano** (sin arancel) con su IVA, precio y unidades; la categoría del arancel no se puede cambiar | aceptada |
```

---

## 4. `docs/feat_billing.md` — §5.6 «Catálogo y precios» (≈línea 1128)

Añadir al final de la sección (sin reescribir lo que ya hay) un párrafo como este:

> Además de las partidas del arancel, el borrador admite una **partida escrita a mano** (código
> centinela `manual`, sin fila en `treatment_catalog`): descripción, **categoría fiscal** (exento o
> gravado), precio y unidades, con la descripción **obligatoria**. Su categoría **se copia** en el
> documento como la de cualquier partida, y sale con su letra `(E)`/`(G)`. La categoría de las partidas
> **del arancel** no se puede cambiar desde la caja: la manda el catálogo, para que un servicio
> odontológico (Art. 19.6) no se pueda facturar gravado desde el mostrador.

Y, en la tabla de la **§0** (delta de la revisión), añadir una fila **M9** si se quiere dejar traza —
opcional, no bloquea:

```markdown
| M9 | Línea libre | No se menciona | El borrador admite una partida **escrita a mano** (`manual`) con su categoría fiscal, precio y unidades; el arancel manda su categoría (§5.6) |
```

---

## 5. Seguimiento (NO bloquea esta mejora)

- **Despliegue (gotcha de siempre).** El cambio vive en el `dist` de `services/billing` **y** en el
  bundle de `@odontocrm/web`: en producción hay que `sudo odontocrm recompilar` (o `actualizar`) para
  que el botón aparezca y el servicio honre la categoría de la línea manual.
- **Humo.** `npm run smoke:billing` no ejercita la línea manual todavía; si se quiere cubrirla, el
  recorrido del mostrador puede añadir una partida `manual` (una exenta y una gravada) y comprobar el
  desglose. No es obligatorio para cerrar.
- **Interfaz del arancel.** La opción «Otro procedimiento» (`otros`) del desplegable queda conviviendo
  con la línea manual. Es intencional (una la crea el odontólogo desde la sesión clínica con su detalle;
  la otra la teclea la caja). Si estorba en el mostrador, se puede **ocultar del desplegable** de la
  Caja sin tocar el catálogo ni la sesión clínica.
- **Informe «por código».** `manual` no es un procedimiento: si en el futuro se hacen reportes de
  procedimientos por código a partir de las facturas, hay que excluir o agrupar aparte el código
  `manual` (hoy los reportes clínicos no leen las facturas).
