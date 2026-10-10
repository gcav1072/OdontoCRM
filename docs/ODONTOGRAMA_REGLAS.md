# Reglas clínicas del odontograma

- **Módulo:** OdontoCRM · Odontograma (dominio clínico)
- **Anexo a:** [ADR 0032 — Los tratamientos conviven con las caras](adr/0032-convivencia-de-tratamientos-con-las-caras.md)
- **Versión:** 1.0 · **Fecha:** 2026-10-09
- **Fuente de verdad en código:** `packages/contracts/src/domain/odontogram.ts`

Este documento fija **qué estados clínicos son válidos**, **qué condiciones pueden convivir** en una
misma pieza y **cómo evolucionan** con las citas del paciente. Es la referencia para el validador de
comandos, las mutaciones de la base y el dibujo. Se escribió a raíz de un fallo real: la **pieza 13**
quedó registrada con `extraccion_indicada` **completada** y `implante` **completado**, una
combinación imposible que el modelo antiguo admitía.

> **Nomenclatura.** El código y la clínica se refieren con **`restauracion`** / **restauración** al
> tratamiento restaurador (el empaste), y se representa el «superado» con la columna
> **`resolved_at`** más una entrada en `tooth_finding_history` (no hay
> `superseded_at`/`superseded_by`). El resto de nombres coinciden con este documento.

## 1. Ejes ontológicos

El fallo de la pieza 13 vino de colapsar en un mismo tipo de dato condiciones que pertenecen a
categorías semánticas distintas. El dominio se descompone en **tres ejes independientes**:

**Eje temporal / semántico**

| Categoría | Qué es | Condiciones |
| :--- | :--- | :--- |
| Patología activa | Hecho biológico negativo que pide intervención | `caries` |
| Plan / prescripción | Lo que se va a hacer | `extraccion_indicada` |
| Estado anatómico / terapéutico | Condición física ya ejecutada o preexistente | `restauracion`, `ausente`, `corona`, `endodoncia`, `implante` |

**Eje anatómico estructural**

- **Coronal** (lo que se ve en boca): caras anatómicas, corona biológica o protésica, o su ausencia.
- **Radicular / soporte** (lo anclado en hueso): raíz biológica (sana o endodonciada) o implante de
  titanio.

**Eje de alcance**

- **Superficial:** afecta a caras concretas (`vestibular`, `lingual`, `occlusal` —o incisal—, `mesial`,
  `distal`).
- **Pieza completa** (`surface: null`): afecta a toda la corona y/o a la raíz.

## 2. Catálogo de condiciones y estados válidos

No todas las condiciones admiten `pendiente` y `completado`. Permitir un estado imposible corrompe
la base.

| Condición | Tipo de entidad | ¿`pendiente` (rojo)? | ¿`completado` (azul)? | Justificación clínica |
| :--- | :--- | :---: | :---: | :--- |
| `caries` | Patología activa | **Sí** | **No** | Una caries no se «completa»: se elimina el tejido y se sustituye por una restauración (`obturar`). |
| `restauracion` | Tratamiento restaurador | **Sí** | **Sí** | Pendiente: empaste indicado o recambio. Completado: restauración existente en buen estado. |
| `ausente` | Estado anatómico | **No** | **Sí** | Hecho consumado: la pieza no está (agenesia o pérdida no quirúrgica). La «ausencia futura» se llama `extraccion_indicada`. |
| `extraccion_indicada` | Prescripción / plan | **Sí** | **No** | Es un procedimiento por realizar; al cumplirse, la pieza pasa a `extraida`. |
| `extraida` | Estado anatómico | **No** | **Sí** | Hecho consumado: la exodoncia **realizada**. El aspa es la misma que `ausente` pero en azul (acto quirúrgico documentado). |
| `corona` | Prótesis coronal | **Sí** | **Sí** | Pendiente: por fabricar o cementar. Completado: instalada y adaptada. |
| `endodoncia` | Terapéutica radicular | **Sí** | **Sí** | Pendiente: conducto infectado/indicado. Completado: obturado tridimensionalmente. |
| `implante` | Terapéutica radicular | **Sí** | **Sí** | Pendiente: fase quirúrgica indicada. Completado: titanio osteointegrado. |

En código: `allowedStatesFor(condition)` y `isStateAllowed(condition, state)`.

## 3. Matriz de convivencia (pieza completa)

Qué condiciones pueden estar **vigentes a la vez** en la misma pieza.

| Existente ↓ / Nueva → | `ausente` | `extraccion_indicada` | `extraida` | `corona` | `endodoncia` | `implante` | Caras (cara a cara) |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| `ausente` | — | ❌ | ❌ | ❌ | ❌ | ✅ (fase quirúrgica) | ❌ excluidas |
| `extraccion_indicada` | ❌ | — | ❌ | ✅ (corona fallida) | ✅ (endodoncia fallida) | ❌ | ✅ |
| `extraida` | ❌ | ❌ | — | ❌ | ❌ | ✅ (fase quirúrgica) | ❌ excluidas |
| `corona` | ❌ | ✅ | ❌ | — | ✅ (post-endodoncia) | ✅ (fase rehabilitada) | ✅ superadas al ponerla |
| `endodoncia` | ❌ | ✅ | ❌ | ✅ | — | ❌ | ✅ |
| `implante` | ✅ | ❌ | ✅ | ✅ | ❌ | — | ❌ excluidas |

**Reglas de exclusión:**

- **`implante` × `extraccion_indicada` — incompatibilidad absoluta.** Un implante no se «extrae» (no
  es un diente natural): si falla, es un explante. La coexistencia de ambos en la pieza 13 fue la
  causa raíz del fallo.
- **`implante` × `endodoncia` — incompatibilidad absoluta.** El titanio no tiene conducto pulpar,
  cámara ni ápice biológico.
- **`ausente` × `extraccion_indicada` — incompatibilidad absoluta.** No se prescribe la extracción de
  una estructura que ya no está en boca.
- **`ausente` × `extraida` — incompatibilidad absoluta.** Son dos formas de «no estar»: una pieza no
  puede ser a la vez congénitamente ausente y extraída.
- **`extraida` × `corona` / `endodoncia` — incompatibilidad.** Sin diente natural no hay muñón que
  coronar ni conducto que tratar; la rehabilitación pasa por el `implante`.
- **`extraida` × `implante` — conviven.** Es la fase quirúrgica: la pieza se extrajo y el tornillo la
  sustituye (el aspa cede ante el implante, igual que con `ausente`).
- **`ausente` × `corona` — incompatibilidad.** Una corona protésica no flota en el vacío: o hay
  soporte radicular (corona + implante) o es el póntico de un puente.
- **`implante` × caras — exclusión.** El implante no conserva caras naturales.

En código: `WHOLE_TOOTH_RULES[*].incompatibleWith`, `conditionsConflict(a, b)` (simétrica, para lotes)
y `recordingConflicts(existing, next)` (direccional, para registrar).

## 4. Precedencia y manejo de caras

### 4.1 `ausente`

- **Anula cualquier cara.** Al registrarlo, las caras vigentes quedan con `resolved_at` y su entrada
  `superado` en el histórico (no se borran), y dejan de leerse.
- **En el dibujo** el aspa domina la casilla y ningún polígono de cara conserva color.

### 4.2 `corona` (`supersedesSurfaces: true`)

- **Oculta las caras biológicas previas** en el dibujo, pero **preserva la historia** (el dato queda
  con `resolved_at`).
- **Excepción activa:** una **caries recurrente / filtración marginal** diagnosticada *después* se
  registra sobre la cara concreta (habitualmente vestibular o interproximal) y **se pinta en rojo**
  sobre el gráfico. La superación solo mira lo que había al poner la corona.

### 4.3 `extraccion_indicada`

- **No supera las caras; convive con ellas.** Una pieza con indicación de exodoncia suele tener
  caries profundas o restauraciones desbordantes: las caras siguen viéndose y el aspa punteada roja
  se superpone.

### 4.4 `implante`

- **Supera y excluye las caras.** Al registrarlo, las caras previas quedan superadas y no se admite
  una caries sobre el titanio.
- **Cede el aspa de `ausente`:** en la fase quirúrgica (`ausente` + `implante`) el dibujo pinta solo
  el tornillo.

### 4.5 `extraida`

- **Supera y excluye las caras**, como `ausente`: la pieza se extrajo, no hay tejido que tratar. Al
  registrarla, las caras vigentes quedan superadas y no se admite una caries nueva.
- **Se distingue de `ausente`** en que documenta **cómo** se perdió el diente (acto quirúrgico): el
  aspa es la misma, pero en **azul** (hecho consumado) en lugar de la tinta neutra.
- **Cede ante el `implante`**, igual que `ausente` (fase quirúrgica: la exodoncia y el tornillo que la
  sustituye conviven).

## 5. Ciclo de vida y transiciones

Los estados no son estáticos; evolucionan con las citas:

```
[ Caries (pendiente) ]        ──(Restaurar)──▶  [ Restauración (completado) ]
[ Extracción indicada ]       ──(Extraer)──▶  [ Extraída (completado) ]
[ Ausente / Extraída ] ──(Cirugía)──▶ [ … + Implante ] ──(Rehabilitar)──▶ [ Corona + Implante ]
```

El comando `completeProcedure` (`POST /api/v1/odontogram/patients/:patientId/procedures`) las aplica
en **una sola transacción**: resuelve el hallazgo de origen (con su entrada `resuelto` en el
histórico) e inserta el destino con `applyFinding`.

| Procedimiento | Origen | Destino | Requisito |
| :--- | :--- | :--- | :--- |
| `obturar` | `caries` (una cara, o **todas** las de la pieza) | `restauracion` (completado), misma cara | — |
| `extraer` | `extraccion_indicada` | `extraida` (completado) | — |
| `rehabilitar` | `ausente` o `extraida` | `corona` (completado) | **implante vigente** |

**Transición de exodoncia:** al extraer, `extraccion_indicada` se resuelve, se inserta `extraida`
(completado), las caras preexistentes pasan a superadas y la corona/el conducto que hubiera caen con
el diente.

**Fase quirúrgica → protésica:** sobre el `implante`, `rehabilitar` resuelve la ausencia (congénita
`ausente` o quirúrgica `extraida`) e inserta `corona` (completado); el `implante` se preserva.

**Resolución de caries:** `obturar` resuelve la `caries` de la cara e inserta `restauracion`
(completado) en la **misma** cara.

La carga rápida por teclado (`quickEntryKey`) **clampea** la caja al estado válido: `c`/`C` (caries)
y `a`/`A` (ausente) registran su único estado; la `x` es la exodoncia en sus dos fases —`x`
(extracción **indicada**, `pendiente`) y `X` (**extraída**, `completado`)—.

## 6. Renderizado por capas

Cuando varias condiciones de pieza completa conviven, el dibujo se compone **por capas** —no en fila
y encogido— (`WHOLE_TOOTH_MARKER_STYLES`, `wholeToothMarkers`):

| Capa | Condición | Trazo |
| :--- | :--- | :--- |
| `aspa` | `ausente`, `extraida` | Aspa sólida a tamaño completo (cede ante el implante). Tinta neutra para `ausente`; azul para `extraida`. |
| `periferia` | `corona` | Círculo que rodea la casilla. |
| `centro` | `implante`, `endodoncia` | Tornillo / triángulo en el eje; se encogen **solo** si comparten la pieza con la corona. |
| `overlay` | `extraccion_indicada` | Aspa punteada translúcida **por encima**, dejando ver debajo lo que motivó la extracción. |

- `ausente` + `implante`: el tornillo ocupa el centro; el aspa se **suprime**.
- `extraida` + `implante`: igual que arriba; el aspa azul de la exodoncia también cede ante el tornillo.
- `corona` + `implante`: círculo en la periferia y tornillo en el centro, sin encogerse artificialmente.
- `corona` + `endodoncia`: círculo en la periferia y triángulo en el centro.
- `extraccion_indicada` + tratamiento previo: el aspa punteada se proyecta sobre el círculo/triángulo
  con trazo translúcido (`stroke-dasharray`).

La **geometría** de los símbolos vive en el contrato (`WHOLE_TOOTH_SYMBOLS`, `wholeToothMarkers`), no
en un componente: la pantalla la pasa a React y el **dossier del expediente** (que se compone en el
servidor, sin DOM) la convierte a una cadena de SVG. El dibujo del papel y el de la pantalla no
pueden separarse.

## 6 bis. Prótesis removibles (PPR/PRT)

Las prótesis removibles **no** se registran cara a cara ni pieza a pieza: son una entidad de **tramo**
o de **arcada completa** (`ProsthesisRecord`, `prosthesisTrack`, migración `0003`).

- **PPR (parcial):** un **tramo contiguo** de la arcada (p. ej. `14–16`), elegido en el gráfico con
  **dos toques** (primera y última pieza del tramo).
- **PRT (total):** la **arcada completa** (18–28 o 48–38).
- **Convivencia en una arcada:** varias prótesis pueden convivir **mientras no compartan ninguna
  pieza**. Dos o más parciales de tramos distintos sí; la total cubre la arcada entera, así que no
  convive con ninguna. Registrar una prótesis que **se solape** con otra viva se **rechaza con 409**
  («…ya cubre la pieza N: quite primero esa prótesis o elija otras piezas»). La clave natural es
  **tipo + arcada + tramo**: volver a registrar el mismo tramo lo actualiza. La regla la impone el
  **servicio** (`recordProsthesis`), que sí ve el resto de la arcada; en la base solo se blinda que
  haya **una sola PRT viva por arcada** (`uq_prosthesis_prt_arch`).
- **Estado:** `pendiente` (rojo, indicada / por confeccionar) o `completado` (azul, instalada).
- **Dibujo:** doble línea con **retenedores** en los extremos de la PPR, en una **franja bajo las
  piezas** (no tapa aspas ni caras), a la misma altura en pantalla, papel y dossier.
- **Validación** (`recordProsthesisSchema`): todas las piezas de la misma arcada; tramo contiguo en la
  PPR; arcada completa en la PRT (el servidor normaliza la PRT a las 16 piezas). El **solape** entre
  prótesis vivas de la misma arcada lo impone el servicio.

## 7. Enforcement en tres capas

Ninguna deja pasar un estado imposible:

1. **Contrato** (`packages/contracts/src/domain/odontogram.ts`): `WHOLE_TOOTH_RULES`,
   `SURFACE_CONDITION_RULES`, `isStateAllowed`, `PROCEDURE_TRANSITIONS`, y el `.superRefine` de
   `recordFindingSchema` / `completeProcedureSchema`.
2. **Servicio** (`services/odontogram/src/odontogram/chart-service.ts`):
   `assertStateAllowed`, `assertNoConflictingCondition`, `assertNoScopeConflict`, `supersedeSurfaces`,
   `resolveFinding` y `completeProcedure`. Devuelve `409` con la condición o el estado que sobra.
3. **Base de datos** (`services/odontogram/src/db/schema.ts` + migración `0002`): `chk_tooth_findings_state_allowed`
   ata el estado a la condición; la migración **repara** los datos antes de blindarlos.

Herramienta de red de seguridad: `npm run reparar:odontograma` (simulación) y `--apply` para aplicarlo.

## 8. Referencias

- [ADR 0032 — Los tratamientos conviven con las caras](adr/0032-convivencia-de-tratamientos-con-las-caras.md)
- [ADR 0031 — La pieza completa manda sobre las caras](adr/0031-odontograma-pieza-completa-sobre-caras.md)
- [ADR 0033 — El odontograma en posición anatómica](adr/0033-odontograma-en-posicion-anatomica.md)
- [ADR 0051 — Dentición mixta en el odontograma](adr/0051-denticion-mixta-en-el-odontograma.md)
