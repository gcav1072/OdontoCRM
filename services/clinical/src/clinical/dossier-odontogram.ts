import {
  CLINICAL_STATE_COLORS,
  SURFACE_POLYGONS,
  TOOTH_CANVAS,
  TOOTH_LABEL_BASELINE,
  TOOTH_OUTLINE_POINTS,
  archLayout,
  hasPrimaryFindings,
  odontogramSummary,
  toothGroupTransform,
  type Dentition,
  type OdontogramSummary,
  type ToothFindingRecord,
  type ToothPlacement,
  type ToothSurface,
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
 * **Lo que sí cambia respecto a la pantalla:** los símbolos de las condiciones que
 * afectan a la **pieza completa** (extracción, corona, endodoncia…) no se dibujan. Son
 * una docena de formas con su propio trazado y viven en un componente de la web; en su
 * lugar, una pieza con una condición completa se marca con su cara **oclusal** teñida
 * del color de su estado y el detalle —el nombre de la condición— va en la tabla de
 * hallazgos que acompaña al dibujo. Así el papel dice lo mismo que la pantalla, aunque
 * lo diga de otra forma.
 */

/** Alto del lienzo de una arcada: la pieza, el aire del número y el número. */
const ARCH_HEIGHT = TOOTH_LABEL_BASELINE + 16;

/** Lo que se dibuja de una pieza: sus hallazgos vigentes, ya separados. */
interface ToothFindings {
  /** Hallazgos por cara (caras con más de uno se quedan con el primero: así lo pinta la web). */
  bySurface: Partial<Record<ToothSurface, ToothFindingRecord>>;
  /** Hallazgos que afectan a la pieza entera (`surface === null`). */
  whole: readonly ToothFindingRecord[];
}

const splitFindings = (findings: readonly ToothFindingRecord[]): ToothFindings => {
  const bySurface: Partial<Record<ToothSurface, ToothFindingRecord>> = {};
  const whole: ToothFindingRecord[] = [];
  for (const finding of findings) {
    if (finding.surface === null) whole.push(finding);
    else bySurface[finding.surface] ??= finding;
  }
  return { bySurface, whole };
};

const colorOf = (finding: ToothFindingRecord | undefined): string =>
  finding === undefined
    ? 'none'
    : finding.state === 'pendiente'
      ? CLINICAL_STATE_COLORS.pendiente
      : CLINICAL_STATE_COLORS.completado;

/** Una pieza: sus cinco caras, el contorno y el número, siempre derecho. */
const toothSvg = (tooth: ToothPlacement, findings: ToothFindings): string => {
  const transform = toothGroupTransform(tooth);
  const grupo = transform === undefined ? '' : ` transform="${transform}"`;

  const caras = (Object.keys(SURFACE_POLYGONS) as ToothSurface[])
    .map((surface) => {
      // Una condición de pieza completa no tiene cara: se enseña en la oclusal, que es
      // el centro del diente, para que la pieza no salga limpia en el papel.
      const finding =
        findings.bySurface[surface] ?? (surface === 'occlusal' ? findings.whole[0] : undefined);
      return `<polygon points="${SURFACE_POLYGONS[surface]}" fill="${colorOf(finding)}" style="stroke:var(--brand-line)" stroke-width="1"/>`;
    })
    .join('');

  return (
    `<g${grupo}>${caras}` +
    `<polygon points="${TOOTH_OUTLINE_POINTS}" fill="none" style="stroke:var(--brand-ink-strong)" stroke-width="4" stroke-linejoin="round"/>` +
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
        `<g transform="translate(${String(tooth.x)},0)">${toothSvg(tooth, splitFindings(findings[String(tooth.toothNumber)] ?? []))}</g>`,
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
