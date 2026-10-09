import {
  CLINICAL_STATE_COLORS,
  CONDITION_LABELS,
  SURFACE_POLYGONS,
  TOOTH_CANVAS,
  TOOTH_LABEL_BASELINE,
  TOOTH_OUTLINE_POINTS,
  WHOLE_TOOTH_CONDITIONS,
  WHOLE_TOOTH_SYMBOLS,
  allowedStatesFor,
  archLayout,
  hasPrimaryFindings,
  odontogramSummary,
  toothGroupTransform,
  wholeToothMarkerTone,
  wholeToothMarkers,
  type Dentition,
  type OdontogramSummary,
  type ToothFindingRecord,
  type ToothMarker,
  type ToothPlacement,
  type ToothSurface,
  type WholeToothCondition,
} from '@odontocrm/contracts';

/**
 * El odontograma del **dossier**, en SVG plano.
 *
 * La web ya dibuja la boca con React (`OdontogramStaticChart`), pero el dossier se
 * compone en el **servidor**: allí no hay React ni DOM, así que la geometría se
 * convierte a una cadena de SVG. Lo que **no** se duplica es la geometría —el reparto
 * de cuadrantes, los polígonos de las caras y las transformaciones de volteo y espejo
 * salen de `@odontocrm/contracts`, los mismos que usa la pantalla—; lo que se escribe
 * aquí es solo el pintado, para que el papel y la pantalla no se separen nunca.
 *
 * El **énfasis** del dibujo (separadores de caras, contorno y número) sale de la
 * **marca** (`--brand-*`), para que el dossier y el odontograma del navegador casen.
 * Los colores **clínicos** (rojo `pendiente`, azul `completado`, de `CLINICAL_STATE_COLORS`)
 * son del dominio y no cambian con la paleta. En SVG, `var()` no vale como atributo:
 * las variables de marca entran por `style`.
 *
 * **Lo que cambia respecto a la pantalla:** los símbolos de las condiciones de pieza
 * completa (extracción, corona, endodoncia…) **se dibujan igual**, porque su geometría
 * vive en el contrato (`WHOLE_TOOTH_SYMBOLS`) y no en el componente de React. Aquí se
 * convierte esa geometría a una cadena de SVG con las mismas capas que la pantalla
 * (`wholeToothMarkers`): el círculo de la corona rodea la pieza, el tornillo del
 * implante o el triángulo del conducto van en el centro y el aspa punteada de la
 * extracción se superpone. El papel dice lo mismo que la pantalla, con las mismas
 * formas —no una versión «resumida»—, y el detalle en palabras sigue en la tabla de
 * hallazgos que acompaña al dibujo.
 */

/** Alto del lienzo de una arcada: la pieza, el aire del número y el número. */
const ARCH_HEIGHT = TOOTH_LABEL_BASELINE + 16;

/** Color del halo de un símbolo: el del papel, para que se lea sobre una cara pintada. */
const HALO_COLOR = '#ffffff';

/** Color del trazo de un símbolo: la tinta para `ausente`, el del estado para el resto. */
const markerStroke = (marker: ToothMarker): string =>
  wholeToothMarkerTone(marker.condition) === 'ink'
    ? 'var(--brand-ink-strong)'
    : CLINICAL_STATE_COLORS[marker.state];

/**
 * Las formas de un símbolo como SVG: el mismo trazado que pinta la pantalla, con el
 * color y el grosor pedidos. `grosor` multiplica el del contrato (el halo es más
 * grueso para dejar un borde del color del papel alrededor de la marca).
 */
const symbolShapes = (condition: WholeToothCondition, color: string, grosor: number): string => {
  const simbolo = WHOLE_TOOTH_SYMBOLS[condition];
  const linecap =
    simbolo.strokeLinecap === undefined ? '' : ` stroke-linecap="${simbolo.strokeLinecap}"`;
  const linejoin =
    simbolo.strokeLinejoin === undefined ? '' : ` stroke-linejoin="${simbolo.strokeLinejoin}"`;
  const formas = simbolo.shapes
    .map((shape) => {
      if (shape.kind === 'line') {
        const dash = shape.dash === undefined ? '' : ` stroke-dasharray="${shape.dash}"`;
        return `<line x1="${String(shape.x1)}" y1="${String(shape.y1)}" x2="${String(shape.x2)}" y2="${String(shape.y2)}"${dash}/>`;
      }
      if (shape.kind === 'circle') {
        return `<circle cx="${String(shape.cx)}" cy="${String(shape.cy)}" r="${String(shape.r)}"/>`;
      }
      return `<polygon points="${shape.points}"/>`;
    })
    .join('');
  return `<g style="stroke:${color};fill:none" stroke-width="${String(
    simbolo.strokeWidth * grosor,
  )}"${linecap}${linejoin}>${formas}</g>`;
};

/**
 * Un símbolo de pieza completa, con su halo: primero el halo del color del papel y
 * después la marca. La extracción indicada (capa `overlay`) va translúcida, para que
 * se vean debajo el círculo de la corona o el triángulo del conducto que la motivaron.
 */
const markerSvg = (marker: ToothMarker): string => {
  const color = markerStroke(marker);
  const transform = `translate(${String(marker.cx - 50 * marker.scale)},${String(
    marker.cy - 50 * marker.scale,
  )}) scale(${String(marker.scale)})`;
  const overlay = marker.layer === 'overlay' ? ' opacity="0.75"' : '';
  return (
    `<g transform="${transform}"${overlay}>` +
    symbolShapes(marker.condition, HALO_COLOR, 2.6) +
    symbolShapes(marker.condition, color, 1) +
    '</g>'
  );
};

/** Muestra en pequeño el símbolo de una condición, en el color de su estado. */
const symbolPreview = (
  condition: WholeToothCondition,
  state: 'pendiente' | 'completado',
): string => {
  const color =
    wholeToothMarkerTone(condition) === 'ink'
      ? 'var(--brand-ink-strong)'
      : CLINICAL_STATE_COLORS[state];
  return `<svg class="odo-simbolo" viewBox="0 0 100 100">${symbolShapes(condition, color, 1)}</svg>`;
};

/** Hallazgos por cara de una pieza (caras con más de uno se quedan con el primero). */
const surfacesOf = (
  findings: readonly ToothFindingRecord[],
): Partial<Record<ToothSurface, ToothFindingRecord>> => {
  const bySurface: Partial<Record<ToothSurface, ToothFindingRecord>> = {};
  for (const finding of findings) {
    if (finding.surface !== null) bySurface[finding.surface] ??= finding;
  }
  return bySurface;
};

const colorOf = (finding: ToothFindingRecord | undefined): string =>
  finding === undefined
    ? 'none'
    : finding.state === 'pendiente'
      ? CLINICAL_STATE_COLORS.pendiente
      : CLINICAL_STATE_COLORS.completado;

/**
 * Una pieza: sus cinco caras, el contorno, los símbolos de pieza completa y el número,
 * siempre derecho.
 */
const toothSvg = (tooth: ToothPlacement, findings: readonly ToothFindingRecord[]): string => {
  const transform = toothGroupTransform(tooth);
  const grupo = transform === undefined ? '' : ` transform="${transform}"`;
  const bySurface = surfacesOf(findings);

  const caras = (Object.keys(SURFACE_POLYGONS) as ToothSurface[])
    .map(
      (surface) =>
        `<polygon points="${SURFACE_POLYGONS[surface]}" fill="${colorOf(bySurface[surface])}" style="stroke:var(--brand-line)" stroke-width="1"/>`,
    )
    .join('');

  // Los símbolos de pieza completa, por capas y encima del contorno (spec §6).
  const simbolos = wholeToothMarkers(findings)
    .map((marker) => markerSvg(marker))
    .join('');

  return (
    `<g${grupo}>${caras}` +
    `<polygon points="${TOOTH_OUTLINE_POINTS}" fill="none" style="stroke:var(--brand-ink-strong)" stroke-width="4" stroke-linejoin="round"/>` +
    simbolos +
    '</g>' +
    // El número va fuera del grupo volteado: dentro saldría espejado («8t» en vez de «48»).
    `<text x="${String(TOOTH_CANVAS / 2)}" y="${String(TOOTH_LABEL_BASELINE)}" text-anchor="middle" font-size="30" font-weight="600" style="fill:var(--brand-ink)">${String(tooth.toothNumber)}</text>`
  );
};

const archSvg = (
  teeth: readonly ToothPlacement[],
  width: number,
  findings: Record<string, readonly ToothFindingRecord[]>,
  caption: string,
): string => {
  if (teeth.length === 0) return '';
  const piezas = teeth
    .map(
      (tooth) =>
        `<g transform="translate(${String(tooth.x)},0)">${toothSvg(tooth, findings[String(tooth.toothNumber)] ?? [])}</g>`,
    )
    .join('');

  return (
    `<figure class="arch"><figcaption>${caption}</figcaption>` +
    `<svg viewBox="0 0 ${String(width)} ${String(ARCH_HEIGHT)}" xmlns="http://www.w3.org/2000/svg">${piezas}</svg>` +
    '</figure>'
  );
};

const leyenda = (): string =>
  `<ul class="odo-legend">` +
  `<li><span class="swatch" style="background:${CLINICAL_STATE_COLORS.pendiente}"></span>Pendiente (por hacer)</li>` +
  `<li><span class="swatch" style="background:${CLINICAL_STATE_COLORS.completado}"></span>Realizado</li>` +
  `<li><span class="swatch empty"></span>Sin hallazgos</li>` +
  '</ul>' +
  // Los símbolos de pieza completa, con las mismas formas que la pantalla. Los
  // tratamientos se enseñan en los colores que admiten (la extracción indicada solo
  // rojo: al cumplirse, la pieza queda ausente, no «extracción completada»).
  `<ul class="odo-legend">` +
  `<li>${symbolPreview('ausente', 'completado')}${CONDITION_LABELS.ausente}</li>` +
  WHOLE_TOOTH_CONDITIONS.filter((condition) => condition !== 'ausente')
    .map(
      (condition) =>
        `<li>${allowedStatesFor(condition)
          .map((state) => symbolPreview(condition, state))
          .join('')}${CONDITION_LABELS[condition]}</li>`,
    )
    .join('') +
  '</ul>';

export interface OdontogramSection {
  /** El dibujo completo (las bandas que correspondan y su leyenda). */
  html: string;
  /** Los contadores, para el encabezado de la sección. */
  summary: OdontogramSummary;
  /** `true` si el paciente todavía no tiene odontograma. */
  empty: boolean;
}

/** Texto de la dentición para el papel: «dentición permanente», «dentición mixta»… */
const dentitionCaption = (dentition: Dentition): string =>
  dentition === 'temporal'
    ? 'Dentición temporal (de leche)'
    : dentition === 'mixta'
      ? 'Dentición mixta (permanentes y de leche)'
      : 'Dentición permanente';

/**
 * Sección del odontograma del dossier: el dibujo anatómico, la leyenda de colores y
 * los contadores. Sin odontograma devuelve `empty: true` y el texto que lo dice —el
 * dossier sale igual, con el hueco explicado en vez de un dibujo en blanco.
 */
export const odontogramSection = (input: {
  dentition: Dentition | null;
  findings: Record<string, readonly ToothFindingRecord[]>;
}): OdontogramSection => {
  const dentition = input.dentition ?? 'permanente';
  const summary = odontogramSummary({ findings: input.findings, dentition });

  if (input.dentition === null) {
    return {
      html: '<p class="vacio">El paciente todavía no tiene odontograma registrado.</p>',
      summary,
      empty: true,
    };
  }

  const layout = archLayout(dentition);
  const bandas = [
    archSvg(layout.upper, layout.width, input.findings, 'Arcada superior · vestibular arriba'),
    archSvg(layout.lower, layout.width, input.findings, 'Arcada inferior · vestibular abajo'),
    // Las bandas primarias solo existen en la dentición mixta y, como en el imprimible
    // del navegador, solo se dibujan si hay algún hallazgo en piezas de leche: una
    // banda vacía haría dudar de si faltó capturarla. Van debajo de la principal, cada
    // pieza de leche en la ranura de su sucesor (ADR 0051).
    ...(hasPrimaryFindings(input.findings)
      ? [
          archSvg(
            layout.upperPrimary,
            layout.width,
            input.findings,
            'Dentición temporal · arcada superior',
          ),
          archSvg(
            layout.lowerPrimary,
            layout.width,
            input.findings,
            'Dentición temporal · arcada inferior',
          ),
        ]
      : []),
  ].join('');

  return {
    html: `<p class="odo-denticion">${dentitionCaption(dentition)}</p>${bandas}${leyenda()}`,
    summary,
    empty: false,
  };
};
