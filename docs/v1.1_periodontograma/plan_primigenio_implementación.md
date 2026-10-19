## 1. Filosofía de Diseño: Touch-First, Mouse-Friendly y Código Minimalista

En un consultorio odontológico real, el operador suele interactuar con el sistema a través de una **tablet (iPad/Android)** o un **monitor en el brazo del sillón usando el ratón con guantes de látex/nitrilo**. Si diseñamos el periodontograma como una hoja de cálculo tradicional con $384$ cajas `<input type="number">`, ocurrirán dos fallos críticos de usabilidad:

1. **El problema del teclado virtual en tablets:** Al tocar un `<input>` nativo, el teclado del sistema operativo emerge y oculta el $50\,\%$ de la pantalla, desplazando el gráfico SVG y obligando a abrirlo y cerrarlo cientos de veces.
2. **El síndrome del "dedo con guante" (*Fat-Finger*):** En una fila de $16$ dientes, cada diente mide apenas $\sim 45\text{ px}$ de ancho y cada uno de sus $3$ sitios mide $\sim 15\text{ px}$. Atinar con el dedo o hacer doble clic con el ratón en celdas de $15\text{ px}$ ni siquiera cumple con el estándar mínimo de ergonomía táctil ($44\text{ px} \times 44\text{ px}$) verificado en el proyecto mediante `tools/check-responsive.mjs`.



Para resolver esto manteniendo el código simple y alineado con `OdontoCRM`, aplicaremos cinco decisiones de arquitectura:

1. **Cero `<input>` nativos (Pad Clínico Táctil Propio):** Todas las celdas del periodontograma son botones visuales (`<button type="button">`). Al tocar un diente o sitio con el dedo o el ratón, se utiliza una **Barra/Pad Clínico Táctil fijo** con botones grandes ($0\text{--}12\text{ mm}$, Sangrado, Placa, Supuración) que nunca invoca el teclado virtual de Android/iOS.
2. **Un único motor de entrada (Touch/Mouse + Teclado secundario):** Los botones táctiles en pantalla y las teclas físicas del teclado disparan exactamente las mismas acciones sobre un único hook (`usePeriodontalController.ts`). Así, el teclado físico funciona automáticamente como método secundario sin duplicar lógica.
3. **Interacción de "Ciclado en 1 Toque/Clic" (Sin `<select>` desplegables):** Cambiar la movilidad ($0 \to 1 \to 2 \to 3 \to 0$) o la lesión de furca ($0 \to \text{I} \to \text{II} \to \text{III} \to 0$) se hace tocando o haciendo clic directamente sobre el indicador, reutilizando la filosofía de gestos de `apps/web/src/components/odontogram/press-intent.ts`.


4. **Cero microservicios nuevos y una sola tabla SQL JSONB:** El módulo vive en `services/odontogram/` y almacena cada examen en una sola fila de la tabla `periodontogram_exams` con una columna `teeth_data` (`jsonb`).


5. **Tuplas posicionales `[0, 1, 2]` y SVG por polilíneas:** Cada cara (`vestibular` y `lingual`) guarda sus $3$ sitios en orden visual de izquierda a derecha `[izquierdo, central, derecho]`, reduciendo el renderizado SVG a menos de $90$ líneas de código sin librerías externas.

---

## 2. Arquitectura UX/UI para Tablets y Ratón

### 2.1. Vista Dual Adaptativa: Mapa Completo + Enfoque de Sitio Activo

Para que sea cómodo tanto en un monitor de escritorio con ratón como en una tablet de $10\text{ pulgadas}$:

* **1. El Lienzo Panorámico (Arcadas Superior e Inferior):**
Muestra los $16$ dientes por arcada con su gráfico SVG de bolsas y sus filas numéricas.
* **En monitor con ratón:** Cabe al $100\,\%$ de ancho. El usuario puede hacer clic en cualquier diente, sitio o punto de sangrado directamente.
* **En tablet (modo táctil):** Permite desplazamiento horizontal suave por **Sextantes** (con botones rápidos de salto: `Sextante 1 [18-14]`, `Sextante 2 [13-23]`, `Sextante 3 [24-28]`, etc.) o tocar directamente cualquier diente del SVG para seleccionarlo.


* 2. La Barra Táctil de Sondaje (`ProbingTouchPad.tsx` — Equivalente a `QuickEntryBar.tsx`):
Ubicada en la parte inferior o lateral del panel (fija, cómoda para los pulgares en tablet o para clics rápidos de ratón), muestra en grande el **Diente y Cara Activos** (ej. `Diente 16 · Vestibular`) con:


* **3 Tarjetas Grandes de Sitio (`Distal`, `Central`, `Mesial`):** Con áreas táctiles de $56\text{ px} \times 56\text{ px}$ donde se toca con el dedo o se hace clic para elegir el sitio activo, y botones directos de **un solo toque** para `Sangrado (BOP)`, `Placa` y `Supuración`.
* **Teclado Numérico Clínico de 1 Toque:** Botones grandes (`0`, `1`, `2`, `3`, `4`, `5`, `6`, `7`, `8`, `9`, `10`, `11`, `>=12`) y un selector de modo `[ Sondear PS | Margen MG ]` con botón de signo `[ - Recesión / + Hiperplasia ]`.
* **Auto-Avance Inteligente (Toggleable):** Cuando el interruptor `Auto-avance` está activo (por defecto), al tocar con el dedo o hacer clic en un número (ej. `4`), el sistema registra $4\text{ mm}$ en el sitio actual y **mueve automáticamente el foco al siguiente sitio** ($0 \to 1 \to 2 \to \text{siguiente diente presente}$). El odontólogo o asistente puede registrar toda una arcada haciendo únicamente clics o toques sucesivos en el pad numérico sin tener que buscar cada celda en la tabla.



### 2.2. Interacciones Directas con Ratón o Dedo sobre el Gráfico

Además del Pad Táctil, el usuario puede interactuar directamente sobre el diagrama:

| Elemento en Pantalla | Acción con Toque (Tablet) o Clic Izquierdo (Ratón) | Acción Secundaria (Pulsación Larga / Clic Derecho) |
| --- | --- | --- |
| **Número FDI del diente** (ej. `16`) | Selecciona el diente en el Pad Táctil para editar sus $6$ sitios. | Abre menú rápido o alterna estado `Ausente` / `Implante` (usando `press-intent.ts`).

 |
| **Insignia de Movilidad** (`M0`..`M3`) | Cicla en bucle: $0 \to 1 \to 2 \to 3 \to 0$. | Resetea a $0$. |
| **Icono de Furca** ($\triangle$) | Cicla en bucle: Grado $0 \to \text{I} \to \text{II} \to \text{III} \to 0$. | Resetea a Grado $0$. |
| **Puntos de Sangrado / Placa** | Conmuta (`true` / `false`) instantáneamente ese sitio sin mover el cursor activo. | Marca/desmarca los $3$ sitios de esa cara a la vez. |
| **Celda numérica ($\text{PS}$ o $\text{MG}$)** | Pone el foco en ese sitio y fila exacta para recibir el toque del Pad Numérico. | Incrementa/decrementa con rueda del ratón (*scroll wheel* opcional en escritorio). |

### 2.3. Un Solo Hook para Touch, Ratón y Teclado (`usePeriodontalController.ts`)

El código se mantiene limpio porque el controlador expone funciones semánticas simples que consumen tanto los botones táctiles como el listener secundario de teclado:

```typescript
export interface PeriodontalCursor {
  fdi: number;
  side: 'vestibular' | 'lingual';
  siteIndex: 0 | 1 | 2;
  field: 'pd' | 'gm';
  autoAdvance: boolean;
}

// Acciones únicas invocadas por onClick/onPointerDown (Primario) y onKeyDown (Secundario):
// - applyMillimeters(value: number) -> escribe el valor en el sitio activo y, si autoAdvance=true, salta al siguiente sitio de diente no ausente.
// - toggleSiteFlag(flag: 'bop' | 'plaque' | 'suppuration', target?: { fdi, side, siteIndex })
// - cycleMobility(fdi: number) -> (current + 1) % 4
// - cycleFurcation(fdi: number, entrance: 'v' | 'l' | 'mp' | 'dp' | 'm' | 'd') -> (current + 1) % 4
// - toggleSignGm() -> invierte el signo del margen gingival en el sitio activo

```

---

## 3. Diseño Simplificado del Modelo de Datos (`packages/contracts`)

Archivo: `packages/contracts/src/domain/periodontogram.ts` (registrado en `packages/contracts/src/index.ts`).

```typescript
import { z } from 'zod';

export const PeriodontalSiteSchema = z.object({
  pd: z.number().int().min(0).max(15).default(2),     // Profundidad de sondaje (0 a 15 mm)
  gm: z.number().int().min(-15).max(10).default(0),   // Margen gingival (-15 a +10 mm)
  bop: z.boolean().default(false),                    // Sangrado al sondaje
  plaque: z.boolean().default(false),                 // Placa bacteriana
  suppuration: z.boolean().default(false),            // Supuración
});

// Tupla posicional de 3 sitios en orden visual de izquierda a derecha: [0: Izq, 1: Centro, 2: Der]
export const ThreeSitesTupleSchema = z.tuple([
  PeriodontalSiteSchema,
  PeriodontalSiteSchema,
  PeriodontalSiteSchema,
]);

export const FurcationGradeSchema = z.union([
  z.literal(0),
  z.literal(1),
  z.literal(2),
  z.literal(3),
]);

export const MobilityGradeSchema = z.union([
  z.literal(0),
  z.literal(1),
  z.literal(2),
  z.literal(3),
]);

export const FurcationEntranceSchema = z.enum(['v', 'l', 'mp', 'dp', 'm', 'd']);

export const PeriodontalToothSchema = z.object({
  missing: z.boolean().default(false),
  implant: z.boolean().default(false),
  mobility: MobilityGradeSchema.default(0),
  furcation: z.partialRecord(FurcationEntranceSchema, FurcationGradeSchema).optional(),
  vestibular: ThreeSitesTupleSchema,
  lingual: ThreeSitesTupleSchema,
});

// Orden visual de izquierda a derecha en pantalla
export const UPPER_ARCH_FDI = [18, 17, 16, 15, 14, 13, 12, 11, 21, 22, 23, 24, 25, 26, 27, 28] as const;
export const LOWER_ARCH_FDI = [48, 47, 46, 45, 44, 43, 42, 41, 31, 32, 33, 34, 35, 36, 37, 38] as const;

// Regla anatómica estática de entradas de furca permitidas por diente FDI
export const ALLOWED_FURCATIONS_BY_FDI: Readonly<Record<number, readonly ('v' | 'l' | 'mp' | 'dp' | 'm' | 'd')[]>> = {
  18: ['v', 'mp', 'dp'], 17: ['v', 'mp', 'dp'], 16: ['v', 'mp', 'dp'],
  26: ['v', 'mp', 'dp'], 27: ['v', 'mp', 'dp'], 28: ['v', 'mp', 'dp'],
  14: ['m', 'd'],        24: ['m', 'd'],
  48: ['v', 'l'],        47: ['v', 'l'],        46: ['v', 'l'],
  36: ['v', 'l'],        37: ['v', 'l'],        38: ['v', 'l'],
};

export function calculateAttachmentLevel(site: z.infer<typeof PeriodontalSiteSchema>): number {
  return Math.max(0, site.pd - site.gm);
}

```

---

## 4. Diseño Simplificado del Apartado Gráfico SVG (Interactivo al Toque/Clic)

El componente `PeriodontogramArchSvg.tsx` no solo dibuja las curvas clínicas, sino que actúa como una **superficie táctil/clicable**.

### 4.1. Geometría Limpia y Zonas de Toque (`Hitboxes`)

1. **Sistema de coordenadas fijo (`viewBox="0 0 640 80"`):**
* $16$ columnas de dientes $\times 40\text{ unidades} = 640\text{ unidades}$ de ancho.
* Los $3$ sitios de cada diente $i \in \{0 \dots 15\}$ se ubican siempre en $X = (i \times 40) + \text{offset}_s$, con $\text{offset} = [7, \, 20, \, 33]$.
* La línea del $\text{LAC}$ ($0\text{ mm}$) se sitúa en $y_{\text{LAC}} = 22$, y cada milímetro equivale a $3,5\text{ unidades}$ verticales:

$$Y_{\text{MG}} = 22 - (\text{MG} \times 3,5)$$


$$Y_{\text{PS}} = Y_{\text{MG}} + (\text{PS} \times 3,5)$$




2. **Capas del SVG (de atrás hacia adelante):**
* **Capa 1 (Rejilla milimetrada y silueta radicular esquemática):** Líneas horizontales grises cada $2\text{ mm}$ ($0, 2, 4, 6, 8, 10, 12\text{ mm}$) y línea de alerta roja tenue en la cota de $4\text{ mm}$.
* **Capa 2 (Polígonos y Polilíneas por tramos de dientes presentes):**
* `<polygon>` rojo translúcido (`rgba(220, 38, 38, 0.18)`) encerrado entre la curva de $\text{MG}$ y la curva de $\text{PS}$.
* `<polyline>` azul (`#2563eb`) para el Margen Gingival ($\text{MG}$).
* `<polyline>` roja (`#dc2626`) para la Profundidad de Sondaje ($\text{PS}$), con puntos (`<circle r="3">`) en cada vértice cuando $\text{PS} \ge 4\text{ mm}$.


* **Capa 3 (Símbolos de Furca y Sangrado):**
* Triángulos SVG (`<polygon points="0,-4 4,4 -4,4" />`) en la zona interradicular de los molares: vacío (`fill="none"`) para Grado $\text{I}$, mitad lleno para Grado $\text{II}$, y sólido (`fill="currentColor"`) para Grado $\text{III}$.


* **Capa 4 (Zonas de Toque/Clic Transparentes — *Hitboxes*):**
* Por cada sitio se renderiza un `<rect>` transparente de $13,3 \times 80\text{ unidades}$ con `className="cursor-pointer hover:fill-primary/10"`. Al hacer clic o tocar esa franja vertical en el propio dibujo SVG, el cursor salta inmediatamente a ese diente y sitio.





---

## 5. Plan de Implementación por Fases

### Fase 1: Contratos, Reglas Clínicas y Eventos (`packages/contracts` y `packages/events`)

* **Entregables:**
1. `docs/PERIODONTOGRAMA_BASES_CLINICAS.md` y `docs/adr/0071-periodontograma-integrado.md`.
2. `packages/contracts/src/domain/periodontogram.ts`: Esquemas Zod, etiquetas de sitio según cuadrante (`MV/V/DV` vs `DV/V/MV`), calculadora de $\text{NIC}$, calculadora de métricas agregadas (`% BOP`, `% Placa`, media de $\text{PS}$/$\text{NIC}$, conteo de bolsas $\ge 4\text{ mm}$ y $\ge 6\text{ mm}$) y comparador entre dos exámenes (`diffPeriodontograms`).
3. `packages/contracts/src/domain/periodontogram.test.ts`: Pruebas unitarias exhaustivas de cálculo y validación de furcas.


4. `packages/events/src/topics.ts`: Tópicos `periodontogram.exam.saved` y `periodontogram.exam.finalized`.





### Fase 2: Base de Datos y Servicio en `services/odontogram`

* **Entregables:**
1. Migración `services/odontogram/migrations/0004_periodontogram_exams.sql` y actualización de `services/odontogram/src/db/schema.ts` con la tabla única `periodontogram_exams`.


2. `services/odontogram/src/odontogram/periodontogram-service.ts`:
* Creación de examen sincronizando automáticamente los dientes extraídos/ausentes y los implantes desde el odontograma activo del paciente (`chart-service.ts`), o clonando las mediciones del último periodontograma para agilizar controles de mantenimiento.


* Guardado parcial/total en estado `'draft'` con recálculo automático de KPIs e inserción en `outbox`.


* Cierre inmutable (`finalizeExam`) y endpoint de comparación entre dos exámenes.


3. Rutas en `services/odontogram/src/routes/odontogram-routes.ts` e `internal-routes.ts`, más pruebas de integración en `services/odontogram/src/odontogram.integration.test.ts`.





### Fase 3: Componentes Visuales SVG y Pad Táctil/Ratón (`apps/web`)

* **Entregables:**
1. Cliente API y llaves de caché en `apps/web/src/lib/odontogram-api.ts`, `endpoints.ts` y `queryKeys.ts`.


2. `apps/web/src/components/periodontogram/usePeriodontalController.ts`: Hook central que unifica los toques/clics del Pad Clínico, los clics directos en la tabla/SVG y los atajos de teclado secundarios.
3. `apps/web/src/components/periodontogram/PeriodontogramArchSvg.tsx`: Gráfico vectorial de polilíneas con zonas táctiles/clicables por sitio e iconos de furca.
4. `apps/web/src/components/periodontogram/ProbingTouchPad.tsx`: Panel inferior/lateral con botones táctiles grandes ($\ge 44\text{ px}$), toggles de un toque para Sangrado/Placa/Supuración, ciclado de Movilidad/Furca y auto-avance.
5. `apps/web/src/components/periodontogram/PeriodontogramPanel.tsx`: Vista principal con selector de sextantes para tablets, tarjetas de KPIs en vivo (`% BOP`, `% Placa`, `Bolsas >= 4 mm`), selector de diagnóstico AAP/EFP (Estadio $\text{I--IV}$, Grado $\text{A--C}$) e integración como pestaña en `PatientWorkspace.tsx` (`PanelTabs.tsx`).





### Fase 4: Modo Comparación Longitudinal y Vista de Impresión (`apps/web`)

* **Entregables:**
1. **Modo Comparativo Visual:** Selector «Comparar con examen anterior» en `PeriodontogramPanel.tsx`. Sobrepone en el SVG la línea punteada del examen previo y resalta en verde las bolsas que redujeron su profundidad ($\Delta \text{PS} \le -2\text{ mm}$) y en rojo las que progresaron ($\Delta \text{PS} \ge +2\text{ mm}$).
2. **Documento Imprimible (`PeriodontogramDocument.tsx` y `PeriodontogramPrintPage.tsx`):** Diseño limpio en una página que reutiliza `MembreteDocumento.tsx`, `MargenDeImpresion.tsx` y `MarcaDeAgua.tsx` (`apps/web/src/components/print/`).





### Fase 5: Dossier Clínico, Auditoría, Reportes y Pruebas E2E

* **Entregables:**
1. **Integración con Historia Clínica (`services/clinical/`):** Ampliar `odontogram-client.ts`, `dossier-odontogram.ts` y `MedicalRecordDocument.tsx` para incluir el resumen del último periodontograma finalizado en el expediente del paciente.


2. **Auditoría y Reportes (`services/identity/` y `services/reporting/`):** Registrar eventos en `event-consumer.ts` / `audit.ts` y sumar métricas periodontales en `oral-health.ts`.


3. **Semillas y Pruebas (`packages/testing/` y `tools/`):** Añadir generación determinista de periodontogramas en `clinical-content.ts` / `seed-test.mjs` y pruebas E2E/responsivas en `smoke-odontogram.mjs` y `check-responsive.mjs`.





---

## 6. Estado de implementación de la v1.1 (2026-10-18)

El núcleo del plan (fases 1–4) está implementado y verificado. Durante la revisión previa se
corrigieron varios riesgos clínicos y de datos; el detalle y el porqué están en
[`revision_critica_y_decisiones.md`](revision_critica_y_decisiones.md), las decisiones de
arquitectura en el [ADR 0071](../adr/0071-periodontograma-integrado.md) y las bases clínicas
implementadas en [`../PERIODONTOGRAMA_BASES_CLINICAS.md`](../PERIODONTOGRAMA_BASES_CLINICAS.md).

| Fase | Estado | Notas |
| :--- | :--- | :--- |
| 1 · Contratos, reglas y eventos | ✅ Implementada | `packages/contracts/src/domain/periodontogram.ts` (+42 pruebas), tópicos y acciones de auditoría. `docs/PERIODONTOGRAMA_BASES_CLINICAS.md` y ADR 0071 escritos. |
| 2 · Base y servicio | ✅ Implementada | Tabla única `periodontogram_exams` (JSONB + `revision` + un borrador por paciente), servicio con snapshot del odontograma, clonado, guardado optimista, cierre inmutable, comparación, impresión y resumen interno; rutas bajo `/api/v1/odontogram` (sin tocar gateway) y permisos del odontograma. |
| 3 · SVG y pad táctil | ✅ Implementada | Controlador único (dedo/ratón/teclado), pad clínico ≥ 44 px, SVG por arcadas con zonas de toque, tabla numérica, KPIs en vivo, sugerencia AAP/EFP y selección de diagnóstico. |
| 4 · Comparación e impresión | ✅ Implementada | Modo comparación en el panel (superposición + deltas) e informe imprimible con membrete (carta, varias hojas si la boca está completa) con hoja de evolución. |
| 5 · Dossier, auditoría, reportes, semillas y E2E | ⚠️ Parcial | **Auditoría ya**: cada guardado/cierre/impresión/descarte publica su evento y `entityType='periodontogram'`. Resumen interno listo para el dossier. Dossier clínico, métricas en `reporting`, semilla determinista y E2E de la fase 5 quedan **declarados para la v1.2** (ver §3 del documento de revisión). |

Las diferencias con el texto original de este plan son deliberadas y están justificadas en la
revisión: `pd`/`gm` nullable (sin mediciones inventadas), snapshot en vez de sincronización viva,
revisión optimista, clasificación sugerida en vez de calculada, geometría SVG con rango vertical
suficiente e impresión en dos páginas cuando hay comparación.





---