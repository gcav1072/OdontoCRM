import {
  analyzePeriodontalChart,
  emptyPeriodontalSite,
  findPeriodontalTooth,
  furcationEntrancesFor,
  attachmentLevel,
  PERIODONTAL_GM_MAX,
  PERIODONTAL_GM_MIN,
  PERIODONTAL_PD_MAX,
  PERIODONTAL_SIDES,
  PERIODONTAL_SITE_INDEXES,
  periodontalArchOf,
  type FurcationEntrance,
  type FurcationGrade,
  type MobilityGrade,
  type PeriodontalChart,
  type PeriodontalDiagnosis,
  type PeriodontalExamDetail,
  type PeriodontalGrade,
  type PeriodontalRiskFactors,
  type PeriodontalSide,
  type PeriodontalSite,
  type PeriodontalSiteIndex,
  type PeriodontalSites,
  type PeriodontalStage,
  type PeriodontalTooth,
} from '@odontocrm/contracts';

/**
 * Controlador **puro** del periodontograma: el único sitio donde se decide qué le
 * pasa a la boca cuando alguien toca un número, una insignia o una tecla.
 *
 * Es puro a propósito: el pad táctil, el SVG, la tabla y el teclado físico llaman a
 * las mismas funciones, y las pruebas las ejercitan sin navegador. El hook
 * (`usePeriodontalController`) envuelve este módulo para añadir el historial de
 * deshacer; nada de lógica clínica vive en los componentes.
 *
 * Reglas que se respetan aquí:
 * - **Sin dato no es cero**: ni los sitios ni el margen arrancan con un número.
 * - La pieza **ausente** no tiene sitios, movilidad ni furca (contrato): al marcarla
 *   se limpian sus datos; el **implante** se sonda pero no tiene movilidad ni furca.
 * - El **auto-avance** salta las piezas ausentes y avanza en el orden visual de
 *   sondaje (vestibular 0→1→2 y después lingual 0→1→2 del diente siguiente).
 * - La movilidad cicla `ausente → 0 → 1 → 2 → 3 → ausente` y la furca
 *   `sin lesión → I → II → III → sin lesión`.
 */

/** Campo que se está capturando en el sitio activo. */
export type PeriodontalField = 'pd' | 'gm';

/**
 * Qué sitio (y qué campo) recibe la próxima pulsación del pad o del teclado.
 *
 * `fdi + side + siteIndex` identifican el sitio; `field` dice si el número que se
 * toque es profundidad de sondaje o margen gingival. `gmNegative` recuerda el signo
 * que se aplicará al margen: la recesión (negativo) y la hiperplasia (positivo) se
 * escriben con el mismo teclado numérico.
 */
export interface PeriodontalCursor {
  fdi: number;
  side: PeriodontalSide;
  siteIndex: PeriodontalSiteIndex;
  field: PeriodontalField;
  autoAdvance: boolean;
  /** Signo pendiente del margen gingival: `true` = recesión (valor negativo). */
  gmNegative: boolean;
}

/** Lo que se guarda en cada examen (sin la revisión, que la lleva el servidor). */
export interface PeriodontalChartState {
  examDate: string;
  chart: PeriodontalChart;
  riskFactors: PeriodontalRiskFactors;
  diagnosis: PeriodontalDiagnosis | null;
  notes: string | null;
}

/** Estado completo del controlador: la boca, el cursor y los datos del examen. */
export interface PeriodontalControllerState extends PeriodontalChartState {
  cursor: PeriodontalCursor;
}

/** Foto de lo último guardado (referencias: comparar es barato y suficiente). */
export type PeriodontalSavedSnapshot = PeriodontalChartState;

/** Los flags de un sitio que el pad conmuta con un solo toque. */
export type PeriodontalSiteFlag = 'bop' | 'plaque' | 'suppuration';

/** Direcciones de navegación del cursor (flechas y Tab del teclado físico). */
export type PeriodontalNavDirection =
  'next' | 'previous' | 'left' | 'right' | 'up' | 'down' | 'nextTooth' | 'previousTooth';

/** Nombres de los canales del pad clínico, para etiquetas y pruebas. */
export const PERIODONTAL_FIELDS: readonly PeriodontalField[] = ['pd', 'gm'];

/** Sitios de una cara sin datos: el estado inicial y el que deja la pieza ausente. */
const emptySites = (): PeriodontalSites => [
  emptyPeriodontalSite(),
  emptyPeriodontalSite(),
  emptyPeriodontalSite(),
];

/** Redondea y acota un entero al rango del contrato; un `NaN` no entra. */
const clampInt = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, Math.round(value)));

/** Reemplaza un sitio de una tupla sin mutar la original (las tuplas son de 3). */
const replaceSite = (
  sites: PeriodontalSites,
  index: PeriodontalSiteIndex,
  site: PeriodontalSite,
): PeriodontalSites => {
  const siguiente: PeriodontalSites = [sites[0], sites[1], sites[2]];
  siguiente[index] = site;
  return siguiente;
};

/** Aplica un parche a un sitio concreto de la boca (inmutable). */
const patchSite = (
  chart: PeriodontalChart,
  fdi: number,
  side: PeriodontalSide,
  index: PeriodontalSiteIndex,
  patch: Partial<PeriodontalSite>,
): PeriodontalChart =>
  chart.map((tooth) => {
    if (tooth.fdi !== fdi) return tooth;
    const sitios = side === 'vestibular' ? tooth.vestibular : tooth.lingual;
    const actual = sitios[index];
    return side === 'vestibular'
      ? { ...tooth, vestibular: replaceSite(sitios, index, { ...actual, ...patch }) }
      : { ...tooth, lingual: replaceSite(sitios, index, { ...actual, ...patch }) };
  });

/** Aplica un parche a una pieza concreta de la boca (inmutable). */
const patchTooth = (
  chart: PeriodontalChart,
  fdi: number,
  patch: Partial<PeriodontalTooth>,
): PeriodontalChart => chart.map((tooth) => (tooth.fdi === fdi ? { ...tooth, ...patch } : tooth));

/** `true` si el diente está en boca: solo las piezas presentes se pueden sondar. */
const toothIsSondeable = (tooth: PeriodontalTooth | null): tooth is PeriodontalTooth =>
  tooth !== null && !tooth.missing;

/**
 * Orden real de sondaje: por cada pieza presente, sus seis sitios (vestibular y
 * después lingual, en orden visual). Listo para saltar las piezas ausentes sin
 * repetir el recorrido en cada función.
 */
export const periodontalSiteOrder = (
  chart: readonly PeriodontalTooth[],
): readonly { fdi: number; side: PeriodontalSide; index: PeriodontalSiteIndex }[] => {
  const orden: { fdi: number; side: PeriodontalSide; index: PeriodontalSiteIndex }[] = [];
  for (const tooth of chart) {
    if (tooth.missing) continue;
    for (const side of PERIODONTAL_SIDES) {
      for (const index of PERIODONTAL_SITE_INDEXES) {
        orden.push({ fdi: tooth.fdi, side, index });
      }
    }
  }
  return orden;
};

/** Primer sitio sondable de la boca, o `null` si no queda ninguna pieza presente. */
const firstSondeableSite = (chart: readonly PeriodontalTooth[]) =>
  periodontalSiteOrder(chart)[0] ?? null;

/**
 * Estado inicial de un examen: el cursor aterriza en el primer sitio sondable (la
 * boca puede venir sin piezas presentes si el odontograma las dio todas por
 * ausentes) y el auto-avance empieza **apagado**: sin él, tocar un número no mueve el
 * cursor y el operador ve el valor donde lo escribió.
 */
export const initialPeriodontalState = (
  detail: PeriodontalExamDetail,
): PeriodontalControllerState => {
  const first = firstSondeableSite(detail.chart);
  return {
    examDate: detail.examDate,
    chart: detail.chart,
    riskFactors: detail.riskFactors,
    diagnosis: detail.diagnosis,
    notes: detail.notes,
    cursor: {
      fdi: first?.fdi ?? 0,
      side: first?.side ?? 'vestibular',
      siteIndex: first?.index ?? 0,
      field: 'pd',
      // El auto-avance viene apagado: el pad no mueve el cursor salvo que se encienda.
      autoAdvance: false,
      gmNegative: false,
    },
  };
};

/** Pieza activa del cursor, o `null` si el cursor apunta a una pieza que no está. */
export const activeToothOf = (state: PeriodontalControllerState): PeriodontalTooth | null =>
  findPeriodontalTooth(state.chart, state.cursor.fdi);

/**
 * Sitio activo del cursor, o `null` si la pieza activa está ausente (en ese caso el
 * pad se muestra deshabilitado: no hay sitio que sondar).
 */
export const activeSiteOf = (state: PeriodontalControllerState): PeriodontalSite | null => {
  const tooth = activeToothOf(state);
  if (!toothIsSondeable(tooth)) return null;
  return state.cursor.side === 'vestibular'
    ? tooth.vestibular[state.cursor.siteIndex]
    : tooth.lingual[state.cursor.siteIndex];
};

/** Foto de lo guardado, para que el panel sepa si hay cambios sin guardar. */
export const savedSnapshotOf = (state: PeriodontalControllerState): PeriodontalSavedSnapshot => ({
  examDate: state.examDate,
  chart: state.chart,
  riskFactors: state.riskFactors,
  diagnosis: state.diagnosis,
  notes: state.notes,
});

/**
 * `true` si algo cambió desde la última foto guardada. Compara **referencias**: el
 * controlador nunca muta, así que una referencia distinta es un cambio real y la
 * comprobación es O(1) en cada render (importante con 192 sitios en pantalla).
 */
export const periodontalStateIsDirty = (
  state: PeriodontalControllerState,
  saved: PeriodontalSavedSnapshot | null,
): boolean =>
  saved === null ||
  state.chart !== saved.chart ||
  state.riskFactors !== saved.riskFactors ||
  state.diagnosis !== saved.diagnosis ||
  state.notes !== saved.notes ||
  state.examDate !== saved.examDate;

/* ── Cursor: selección y navegación ────────────────────────────────────────── */

/** Selecciona un sitio concreto (toque en el SVG o en la tabla). */
export const selectPeriodontalSite = (
  state: PeriodontalControllerState,
  fdi: number,
  side: PeriodontalSide,
  siteIndex: PeriodontalSiteIndex,
): PeriodontalControllerState => {
  const tooth = findPeriodontalTooth(state.chart, fdi);
  if (!toothIsSondeable(tooth)) return state;
  return { ...state, cursor: { ...state.cursor, fdi, side, siteIndex } };
};

/**
 * Selecciona una pieza conservando la cara y el sitio. Se permite enfocar una pieza
 * **ausente**: el pad la muestra como tal y ofrece devolverla a la boca; si el FDI no
 * existe en el examen, el cursor no se mueve.
 */
export const selectPeriodontalTooth = (
  state: PeriodontalControllerState,
  fdi: number,
): PeriodontalControllerState => {
  const tooth = findPeriodontalTooth(state.chart, fdi);
  if (tooth === null) return state;
  return { ...state, cursor: { ...state.cursor, fdi } };
};

/** Cambia el canal de captura del pad: profundidad de sondaje o margen gingival. */
export const setPeriodontalField = (
  state: PeriodontalControllerState,
  field: PeriodontalField,
): PeriodontalControllerState =>
  state.cursor.field === field ? state : { ...state, cursor: { ...state.cursor, field } };

/** Enciende o apaga el auto-avance (apagado por defecto). */
export const setAutoAdvance = (
  state: PeriodontalControllerState,
  autoAdvance: boolean,
): PeriodontalControllerState =>
  state.cursor.autoAdvance === autoAdvance
    ? state
    : { ...state, cursor: { ...state.cursor, autoAdvance } };

/** Lleva el cursor a un sitio del orden de sondaje (índice ya calculado). */
const moveToOrderIndex = (
  state: PeriodontalControllerState,
  position: number,
): PeriodontalControllerState => {
  const orden = periodontalSiteOrder(state.chart);
  if (orden.length === 0) return state;
  const destino = orden[Math.min(orden.length - 1, Math.max(0, position))];
  if (destino === undefined) return state;
  return {
    ...state,
    cursor: { ...state.cursor, fdi: destino.fdi, side: destino.side, siteIndex: destino.index },
  };
};

/** Posición del cursor dentro del orden de sondaje; `-1` si ya no está en la boca. */
const cursorPosition = (state: PeriodontalControllerState): number => {
  const orden = periodontalSiteOrder(state.chart);
  return orden.findIndex(
    (sitio) =>
      sitio.fdi === state.cursor.fdi &&
      sitio.side === state.cursor.side &&
      sitio.index === state.cursor.siteIndex,
  );
};

/** Avanza al siguiente sitio sondable (auto-avance y flecha derecha). */
export const movePeriodontalCursor = (
  state: PeriodontalControllerState,
  direction: PeriodontalNavDirection,
): PeriodontalControllerState => {
  const posicion = cursorPosition(state);

  switch (direction) {
    case 'next':
      return moveToOrderIndex(state, (posicion < 0 ? -1 : posicion) + 1);
    case 'previous':
      return moveToOrderIndex(state, (posicion < 0 ? 0 : posicion) - 1);
    case 'left':
    case 'right': {
      // Dentro de la misma cara: el índice visual no cruza de vestibular a lingual.
      const indice = state.cursor.siteIndex + (direction === 'right' ? 1 : -1);
      if (indice < 0 || indice > 2) return state;
      return {
        ...state,
        cursor: { ...state.cursor, siteIndex: indice as PeriodontalSiteIndex },
      };
    }
    case 'up':
    case 'down': {
      // Cambia de cara conservando la posición visual. La arcada manda: en el
      // maxilar la vestibular se dibuja arriba; en la mandíbula, abajo.
      const arch = periodontalArchOf(state.cursor.fdi);
      const arriba: PeriodontalSide = arch === 'mandibula' ? 'lingual' : 'vestibular';
      const abajo: PeriodontalSide = arriba === 'vestibular' ? 'lingual' : 'vestibular';
      const buscado = direction === 'up' ? arriba : abajo;
      if (state.cursor.side === buscado) return state;
      return { ...state, cursor: { ...state.cursor, side: buscado } };
    }
    case 'nextTooth':
    case 'previousTooth': {
      // Misma cara y misma posición visual, pero en la pieza de al lado.
      const orden = periodontalSiteOrder(state.chart);
      const actuales = orden.filter(
        (sitio) => sitio.side === state.cursor.side && sitio.index === state.cursor.siteIndex,
      );
      const actual = actuales.findIndex((sitio) => sitio.fdi === state.cursor.fdi);
      if (actual < 0) return state;
      const destino = actuales[actual + (direction === 'nextTooth' ? 1 : -1)];
      return destino === undefined
        ? state
        : {
            ...state,
            cursor: {
              ...state.cursor,
              fdi: destino.fdi,
              side: destino.side,
              siteIndex: destino.index,
            },
          };
    }
  }
};

/**
 * Deja el cursor en un sitio sondable después de tocar una pieza (marcarla ausente
 * o implantarla puede dejar el cursor apuntando a un sitio que ya no existe).
 */
const ensureCursorOnSondeableSite = (
  state: PeriodontalControllerState,
): PeriodontalControllerState => {
  const tooth = activeToothOf(state);
  if (toothIsSondeable(tooth)) return state;
  const first = firstSondeableSite(state.chart);
  if (first === null) return state;
  return {
    ...state,
    cursor: { ...state.cursor, fdi: first.fdi, side: first.side, siteIndex: first.index },
  };
};

/* ── Escritura de medidas (pad numérico) ───────────────────────────────────── */

/**
 * Escribe los milímetros en el sitio activo y, si el auto-avance está encendido,
 * salta al siguiente sitio **presente**.
 *
 * Para la profundidad de sondaje el valor se acota al rango del contrato (`0–15`) y
 * para el margen el signo pendiente decide si es recesión (negativo, hasta −15) o
 * hiperplasia (positivo, hasta +10). Un 0 es un dato (`0 mm`), no un borrado.
 */
export const applyPeriodontalMillimeters = (
  state: PeriodontalControllerState,
  value: number,
): PeriodontalControllerState => {
  if (!Number.isFinite(value)) return state;
  const tooth = activeToothOf(state);
  if (!toothIsSondeable(tooth)) return state;

  const { cursor } = state;
  let siguiente: PeriodontalControllerState;

  if (cursor.field === 'pd') {
    const pd = clampInt(value, 0, PERIODONTAL_PD_MAX);
    siguiente = {
      ...state,
      chart: patchSite(state.chart, cursor.fdi, cursor.side, cursor.siteIndex, { pd }),
    };
  } else {
    // El signo lo decide el pad: `−` permite recesión hasta −15; `+` hiperplasia
    // hasta +10. La magnitud máxima del teclado (12 mm) ya cubre los dos casos.
    const magnitud = Math.abs(Math.round(value));
    const gm = cursor.gmNegative
      ? -clampInt(magnitud, 0, Math.abs(PERIODONTAL_GM_MIN))
      : clampInt(magnitud, 0, PERIODONTAL_GM_MAX);
    siguiente = {
      ...state,
      chart: patchSite(state.chart, cursor.fdi, cursor.side, cursor.siteIndex, { gm }),
    };
  }

  return cursor.autoAdvance ? movePeriodontalCursor(siguiente, 'next') : siguiente;
};

/**
 * Ventana para componer dos dígitos con el teclado físico: `1` y luego `2` es 12 mm.
 * El pad táctil no la necesita (tiene teclas hasta 12), pero sin ella el teclado solo
 * alcanzaría 0–9 y no podría escribir los 10–15 mm que el contrato admite.
 */
export const PERIODONTAL_DIGIT_WINDOW_MS = 450;

/** Dígito pendiente de composición: el estado antes y después de escribirlo. */
export interface PendingPeriodontalDigit {
  value: number;
  at: number;
  before: PeriodontalControllerState;
  after: PeriodontalControllerState;
}

/**
 * Escribe un dígito sin perder la inmediatez: el primer dígito se aplica en el acto y
 * el segundo, si llega dentro de la ventana **y nada más cambió el estado**, lo
 * reemplaza en el mismo sitio por la decena (`1`+`2` → 12 mm) y avanza una sola vez.
 */
export const applyPeriodontalDigit = (
  state: PeriodontalControllerState,
  digit: number,
  pending: PendingPeriodontalDigit | null,
  now: number,
): { state: PeriodontalControllerState; pending: PendingPeriodontalDigit | null } => {
  const previo =
    pending !== null && state === pending.after && now - pending.at <= PERIODONTAL_DIGIT_WINDOW_MS
      ? pending
      : null;
  if (previo !== null) {
    const compuesto = previo.value * 10 + digit;
    if (compuesto <= PERIODONTAL_PD_MAX) {
      return { state: applyPeriodontalMillimeters(previo.before, compuesto), pending: null };
    }
  }
  const after = applyPeriodontalMillimeters(state, digit);
  return {
    state: after,
    pending: after === state ? null : { value: digit, at: now, before: state, after },
  };
};

/** Invierte el signo del margen: recesión ↔ hiperplasia (y el signo pendiente). */
export const toggleGmSign = (state: PeriodontalControllerState): PeriodontalControllerState => {
  const gmNegative = !state.cursor.gmNegative;
  const sitio = activeSiteOf(state);
  const chart =
    sitio === null || sitio.gm === null
      ? state.chart
      : patchSite(state.chart, state.cursor.fdi, state.cursor.side, state.cursor.siteIndex, {
          gm: Math.min(PERIODONTAL_GM_MAX, Math.max(PERIODONTAL_GM_MIN, -sitio.gm)),
        });
  return { ...state, chart, cursor: { ...state.cursor, gmNegative } };
};

/* ── Flags por sitio y por cara ────────────────────────────────────────────── */

/** Conmuta BOP, placa o supuración de un sitio sin mover el cursor. */
export const toggleSiteFlag = (
  state: PeriodontalControllerState,
  flag: PeriodontalSiteFlag,
  target: { fdi: number; side: PeriodontalSide; index: PeriodontalSiteIndex } = {
    fdi: state.cursor.fdi,
    side: state.cursor.side,
    index: state.cursor.siteIndex,
  },
): PeriodontalControllerState => {
  const tooth = findPeriodontalTooth(state.chart, target.fdi);
  if (!toothIsSondeable(tooth)) return state;
  const sitios = target.side === 'vestibular' ? tooth.vestibular : tooth.lingual;
  const actual = sitios[target.index];
  return {
    ...state,
    chart: patchSite(state.chart, target.fdi, target.side, target.index, {
      [flag]: !actual[flag],
    }),
  };
};

/**
 * Conmuta un flag en los **tres sitios de la cara activa**: si ya estaban todos
 * marcados, los apaga; si no, los enciende. Es el gesto de «sangra toda la cara».
 */
export const toggleFaceFlag = (
  state: PeriodontalControllerState,
  flag: PeriodontalSiteFlag,
): PeriodontalControllerState => {
  const tooth = activeToothOf(state);
  if (!toothIsSondeable(tooth)) return state;
  const sitios = state.cursor.side === 'vestibular' ? tooth.vestibular : tooth.lingual;
  const todos = sitios.every((site) => site[flag]);
  let chart = state.chart;
  for (const index of PERIODONTAL_SITE_INDEXES) {
    chart = patchSite(chart, state.cursor.fdi, state.cursor.side, index, { [flag]: !todos });
  }
  return { ...state, chart };
};

/* ── Movilidad y furca (ciclado en un toque) ───────────────────────────────── */

/** Ciclo de movilidad de Miller: ausente → 0 → 1 → 2 → 3 → ausente. */
export const nextMobilityGrade = (current: MobilityGrade | null): MobilityGrade | null => {
  if (current === null) return 0;
  if (current >= 3) return null;
  return (current + 1) as MobilityGrade;
};

/** Cicla la movilidad de una pieza (por defecto, la activa). */
export const cycleMobility = (
  state: PeriodontalControllerState,
  fdi: number = state.cursor.fdi,
): PeriodontalControllerState => {
  const tooth = findPeriodontalTooth(state.chart, fdi);
  // Ni la pieza ausente ni el implante admiten movilidad (regla del contrato).
  if (!toothIsSondeable(tooth) || tooth.implant) return state;
  return {
    ...state,
    chart: patchTooth(state.chart, fdi, { mobility: nextMobilityGrade(tooth.mobility) }),
  };
};

/** Ciclo de furca de Hamp: sin lesión → I → II → III → sin lesión. */
export const nextFurcationGrade = (current: FurcationGrade | undefined): FurcationGrade | null => {
  if (current === undefined) return 1;
  if (current >= 3) return null;
  return (current + 1) as FurcationGrade;
};

/**
 * Cicla una entrada de furca de la pieza. Solo existen las entradas que la anatomía
 * admite (`furcationEntrancesFor`): intentar una que no existe no cambia nada.
 */
export const cycleFurcation = (
  state: PeriodontalControllerState,
  fdi: number = state.cursor.fdi,
  entrance?: FurcationEntrance,
): PeriodontalControllerState => {
  const tooth = findPeriodontalTooth(state.chart, fdi);
  if (!toothIsSondeable(tooth) || tooth.implant) return state;
  const entradas = furcationEntrancesFor(fdi);
  const elegida = entrance ?? entradas[0];
  if (elegida === undefined || !entradas.includes(elegida)) return state;

  const siguiente = nextFurcationGrade(tooth.furcation[elegida]);
  const furcation: PeriodontalTooth['furcation'] = { ...tooth.furcation };
  if (siguiente === null) delete furcation[elegida];
  else furcation[elegida] = siguiente;

  return { ...state, chart: patchTooth(state.chart, fdi, { furcation }) };
};

/* ── Estado de la pieza: ausente e implante ────────────────────────────────── */

/**
 * Marca o desmarca una pieza como **ausente**. Al marcarla se limpian sus sitios,
 * su movilidad y sus furcas: el contrato rechaza una pieza ausente con datos.
 */
export const toggleMissingTooth = (
  state: PeriodontalControllerState,
  fdi: number = state.cursor.fdi,
): PeriodontalControllerState => {
  const tooth = findPeriodontalTooth(state.chart, fdi);
  if (tooth === null) return state;
  const missing = !tooth.missing;
  const chart = patchTooth(state.chart, fdi, {
    missing,
    implant: missing ? false : tooth.implant,
    mobility: missing ? null : tooth.mobility,
    furcation: missing ? {} : tooth.furcation,
    vestibular: missing ? emptySites() : tooth.vestibular,
    lingual: missing ? emptySites() : tooth.lingual,
  });
  return ensureCursorOnSondeableSite({ ...state, chart });
};

/**
 * Marca o desmarca una pieza como **implante**: se sigue sondando (mucositis y
 * periimplantitis), pero no se le evalúa movilidad ni furca.
 */
export const toggleImplantTooth = (
  state: PeriodontalControllerState,
  fdi: number = state.cursor.fdi,
): PeriodontalControllerState => {
  const tooth = findPeriodontalTooth(state.chart, fdi);
  if (tooth === null) return state;
  const implant = !tooth.implant;
  const chart = patchTooth(state.chart, fdi, {
    implant,
    missing: false,
    mobility: implant ? null : tooth.mobility,
    furcation: implant ? {} : tooth.furcation,
  });
  return { ...state, chart };
};

/* ── Limpieza y edición del examen ─────────────────────────────────────────── */

/** Deja el sitio activo en «sin dato» (PS/MG nulos y flags apagados). */
export const clearActiveSite = (state: PeriodontalControllerState): PeriodontalControllerState => {
  const tooth = activeToothOf(state);
  if (!toothIsSondeable(tooth)) return state;
  return {
    ...state,
    chart: patchSite(state.chart, state.cursor.fdi, state.cursor.side, state.cursor.siteIndex, {
      pd: null,
      gm: null,
      bop: false,
      plaque: false,
      suppuration: false,
    }),
  };
};

/** Fecha clínica del examen (`YYYY-MM-DD`). */
export const setPeriodontalExamDate = (
  state: PeriodontalControllerState,
  examDate: string,
): PeriodontalControllerState => (state.examDate === examDate ? state : { ...state, examDate });

/** Factores de riesgo declarados (tabaco, diabetes y HbA1c). */
export const setRiskFactors = (
  state: PeriodontalControllerState,
  riskFactors: PeriodontalRiskFactors,
): PeriodontalControllerState => ({ ...state, riskFactors });

/** Clasificación firmada por el odontólogo (o `null` si no se clasifica todavía). */
export const setDiagnosis = (
  state: PeriodontalControllerState,
  diagnosis: PeriodontalDiagnosis | null,
): PeriodontalControllerState => ({ ...state, diagnosis });

/** Notas libres del examen. */
export const setExamNotes = (
  state: PeriodontalControllerState,
  notes: string | null,
): PeriodontalControllerState => {
  const limpio = notes === null || notes.trim() === '' ? null : notes;
  return { ...state, notes: limpio };
};

/**
 * Copia la clasificación **sugerida** como diagnóstico firmado. Si la evidencia no
 * alcanza para un estadio (boca sin periodontitis medible), no se inventa: el botón
 * del panel se deshabilita y la sugerencia se explica como tal.
 */
export const applySuggestedDiagnosis = (
  state: PeriodontalControllerState,
): PeriodontalControllerState => {
  const { suggestion } = analyzePeriodontalChart(state.chart, state.riskFactors);
  if (suggestion.stage === null) return state;
  return {
    ...state,
    diagnosis: {
      stage: suggestion.stage,
      grade: suggestion.grade,
      notes: state.diagnosis?.notes ?? null,
    },
  };
};

/** Datos de un examen recién cargado, listos para el panel (autosave y KPIs). */
export const stateFromExamDetail = initialPeriodontalState;

/* ── Ayudas de estado para el pad y la tabla ───────────────────────────────── */

/** Nivel de inserción clínica del sitio activo, si hay PS medida. */
export const activeCalOf = (state: PeriodontalControllerState): number | null => {
  const sitio = activeSiteOf(state);
  return sitio === null ? null : attachmentLevel(sitio);
};

/** Tipos reexportados para que los componentes no importen del contrato por su cuenta. */
export type {
  FurcationEntrance,
  FurcationGrade,
  MobilityGrade,
  PeriodontalGrade,
  PeriodontalRiskFactors,
  PeriodontalSide,
  PeriodontalSite,
  PeriodontalSiteIndex,
  PeriodontalStage,
  PeriodontalTooth,
};
