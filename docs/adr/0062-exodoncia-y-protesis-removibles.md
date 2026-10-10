# ADR 0062 — La exodoncia realizada y las prótesis removibles

- **Fecha:** 2026-10-10
- **Estado:** aceptado
- **Anexo a:** [ADR 0032 — Los tratamientos conviven con las caras](0032-convivencia-de-tratamientos-con-las-caras.md)
- **Fuente de verdad en código:** `packages/contracts/src/domain/odontogram.ts`, `packages/contracts/src/domain/prosthesis.ts`

## Contexto

El odontograma distinguía la **extracción indicada** (un plan, aspa roja discontinua) de la pieza
**ausente** (un hecho, aspa neutra), pero al cumplirse una extracción el modelo solo sabía **tachar**
la pieza (`ausente`). Eso colapsaba dos historias clínicas muy distintas: la **agenesia / pérdida no
quirúrgica** («el diente nunca estuvo o se perdió sin cirugía») y la **exodoncia realizada** («se
extrajo en un acto quirúrgico documentado»). La lectura del papel y los reportes no podían recuperar
**cómo** se perdió la pieza.

Al mismo tiempo, el modelo era **puramente monopieza** (`Record<number, ToothFinding>`): no había
dónde registrar una **prótesis removible**, que no vive en una pieza sino en un **tramo** (PPR) o en
una **arcada completa** (PRT). Forzarla dentro del diccionario de piezas habría sido un error de
modelo (una PPR «14–16» no es una propiedad de la 14, la 15 o la 16 por separado).

## Decisión

### 1. Nueva condición de pieza completa `extraida`

La exodoncia **realizada** es una condición propia (`extraida`), terminal como `ausente`:

- **Estado único:** `completado` (aspa **azul sólida**, el color de lo hecho).
- **Supera y excluye las caras**, como `ausente` (la pieza no está: no hay tejido que tratar).
- **No convive con** `ausente`, `extraccion_indicada`, `corona` ni `endodoncia`; **sí con `implante`**
  (fase quirúrgica: la exodoncia y el tornillo que la sustituye).
- **Cede ante el implante** en el dibujo, igual que `ausente`.
- La transición `extraer` pasa de `extraccion_indicada` a **`extraida`** (antes `ausente`).
- `rehabilitar` admite como origen tanto `ausente` (congénita) como `extraida` (quirúrgica).

**Convención de color.** Coherente con el resto del odontograma (**rojo = pendiente, azul =
realizado**), `extraida` es **azul**: es un acto cumplido. Se distingue de `ausente` (X negra de
tinta neutra) y de `extraccion_indicada` (X roja discontinua) por el color y por el significado.

### 2. Nueva entidad `ProsthesisRecord` (PPR/PRT)

Las prótesis removibles se guardan en una entidad de **nivel de arcada/tramo** (tabla `prostheses`,
DTO `prostheses` en `OdontogramDetail`), no en el diccionario de piezas:

- **PPR (parcial):** un **tramo contiguo** de una arcada; se elige en el gráfico con **dos toques**
  (primera y última pieza).
- **PRT (total):** la **arcada completa**.
- **Una sola prótesis viva por arcada:** la parcial y la total no conviven (ni dos parciales).
  Registrar una segunda se rechaza con **409** («quite primero esa prótesis») y la base lo garantiza
  con el índice único parcial `uq_prosthesis_arch_viva` sobre `(odontogram_id, arch)` restringido a
  `resolved_at is null` (sustituye al antiguo `uq_prosthesis_prt_arch`, migración `0004`).
- **Estado:** `pendiente` (rojo, indicada) o `completado` (azul, instalada).
- **Dibujo:** doble línea con retenedores en los extremos de la PPR, en una **franja bajo las piezas**
  (no tapa aspas ni caras). La geometría vive en el contrato (`prosthesisTrack`) y la comparten
  pantalla, papel del navegador y dossier del servidor.

**Gesto (mouse/toques).** La captura por toques es la de por defecto: la PPR se arma tocando la
primera y la última pieza del tramo, y la PRT se elige desde la barra (arcada superior o inferior).
No hay casillas ni formularios de selección múltiple.

## Consecuencias

- **A favor:** la historia clínica distingue cómo se perdió una pieza; los reportes pueden contar
  extracciones por separado de las ausencias congénitas; las prótesis removibles dejan de ser
  invisibles en el papel y el dossier.
- **En contra:** una condición más que mantener en la matriz de convivencia (sembrada en tres capas:
  contrato, servicio y CHECK de la base) y una entidad persistida nueva con su propio histórico
  (`prosthesis_history`) y sus eventos de outbox.
- **Migración** `0003` (odontograma): añade `extraida` a los CHECK de `tooth_findings` y crea
  `prostheses` + `prosthesis_history`. Las filas históricas `ausente` **no** se reescriben a
  `extraida`: por retroactivo son indistinguibles.
- **Reporting**: `extraida` entra en la salud bucal (`ORAL_HEALTH_CONDITIONS`, migración `0006` de
  reporting). Las prótesis **no** entran en los KPIs; se listan en el imprimible.
- **Terminología:** se unifica el nombre clínico de `restauracion` a **restauración** (antes
  «obturación») en todo el esquema del odontograma.

## Referencias

- [ADR 0032 — Los tratamientos conviven con las caras](0032-convivencia-de-tratamientos-con-las-caras.md)
- [ADR 0051 — Dentición mixta en el odontograma](0051-denticion-mixta-en-el-odontograma.md)
- [`docs/ODONTOGRAMA_REGLAS.md`](../ODONTOGRAMA_REGLAS.md)
