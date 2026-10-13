import { BRAND, type BrandLetterhead, type LetterheadLineKey } from './brand.js';
import { CLINIC, clinicContactLine, clinicFullAddress, type ClinicIdentity } from './clinic.js';

/** Una línea del membrete ya resuelta: su clave y el texto que se imprime. */
export interface LetterheadViewLine {
  key: LetterheadLineKey;
  text: string;
}

/** El membrete resuelto para pintar: nombre (y subtítulo), líneas visibles y pie. */
export interface LetterheadView {
  /** Encabeza el bloque: el **nombre del consultorio** en todos los imprimibles (admite dos líneas). */
  name: string;
  /** Segunda línea bajo el nombre: la **razón social**, si el documento la lleva (récipe, dossier, factura…). */
  subtitle: string | null;
  /** Las líneas visibles, en el orden elegido en el panel y ya sin las vacías. */
  lines: LetterheadViewLine[];
  /** Pie propio del membrete, o `null` si no hay. */
  footer: string | null;
}

/** Ajustes de composición que cada documento puede variar sobre el membrete común. */
export interface LetterheadViewOptions {
  /** Texto que encabeza el bloque; por defecto, el nombre del consultorio. */
  name?: string | null;
  /** Segunda línea bajo el nombre; por defecto, ninguna. */
  subtitle?: string | null;
}

/** Escapa el texto del membrete: lo escriben personas y va a un HTML. */
const escapar = (value: string): string =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

/**
 * ¿El texto está vacío **o** es solo separadores? Una dirección a medias (`address` y
 * `city` en blanco) produce `", "`, que no debe imprimirse como un renglón huérfano.
 */
const sinContenido = (text: string): boolean => text.replace(/[\s,·]+/g, '') === '';

/**
 * Compone el **membrete** a partir de la identidad del consultorio, la línea del
 * especialista que firma y la **presentación** elegida en el panel (alineación del
 * logo, tipografía del nombre, orden y visibilidad de las líneas, pie).
 *
 * Es el **punto único** que comparten la SPA (`MembreteDocumento`, lo que imprime el
 * navegador) y las plantillas del servidor (récipe, dossier, reporte, factura, recibo y
 * nota de crédito): así el papel del navegador y el PDF no pueden separarse —el fallo
 * que tuvo al récipe con un alto de logo fijo, ajeno a la marca—.
 *
 * Las líneas **vacías se descartan** (nunca se imprime un renglón en blanco) y el orden
 * es el que trae la marca. La línea del especialista entra por `dentistLine`, que el
 * llamador resuelve con `clinicDentistLine(clinicDentistFor(usuario, clinic))`.
 */
export const buildLetterheadView = (
  clinic: ClinicIdentity = CLINIC,
  dentistLine: string | null = null,
  letterhead: BrandLetterhead = BRAND.letterhead,
  options: LetterheadViewOptions = {},
): LetterheadView => {
  const textos: Record<LetterheadLineKey, string | null> = {
    address: clinicFullAddress(clinic),
    rif: clinic.rif === null || clinic.rif.trim() === '' ? null : `RIF ${clinic.rif}`,
    contact: clinicContactLine(clinic),
    website: clinic.website,
    dentist: dentistLine,
  };

  const lines = letterhead.lines
    .filter((line) => line.visible)
    .map((line) => ({ key: line.key, text: (textos[line.key] ?? '').trim() }))
    .filter((line) => !sinContenido(line.text));

  const footer = letterhead.footer?.trim() ?? '';
  const subtitle = options.subtitle?.trim() ?? '';

  return {
    name: (options.name ?? clinic.name).trim(),
    subtitle: subtitle === '' ? null : subtitle,
    lines,
    footer: footer === '' ? null : footer,
  };
};

/**
 * El HTML del bloque de identidad del membrete, con las clases `.brand-lh*` que publica
 * `letterheadCss()`. `logo` es el `data:` URI ya resuelto (o `null`: el membrete sale
 * sin logo, igual que cuando falta el archivo).
 *
 * `options.rule` (por defecto `true`) añade la regla de acento bajo el bloque; se quita
 * en los documentos de cobro, cuya regla abarca toda la cabecera (identidad + número).
 */
export const letterheadHtml = (
  view: LetterheadView,
  logo: string | null,
  options: { rule?: boolean } = {},
): string => {
  const regla = options.rule ?? true;
  const lineas = [
    ...(view.subtitle === null ? [] : [`<p class="brand-lh-line">${escapar(view.subtitle)}</p>`]),
    ...view.lines.map(
      (line) =>
        `<p class="brand-lh-line${line.key === 'dentist' ? ' brand-lh-dentist' : ''}">${escapar(line.text)}</p>`,
    ),
  ];

  return `<header class="brand-lh${regla ? ' brand-lh--rule' : ''}">
  ${logo === null ? '' : `<img class="brand-lh-logo" src="${logo}" alt="" aria-hidden="true">`}
  <div class="brand-lh-body">
    <p class="brand-lh-name">${escapar(view.name)}</p>
    ${lineas.join('\n    ')}
    ${view.footer === null ? '' : `<p class="brand-lh-footer">${escapar(view.footer)}</p>`}
  </div>
</header>`;
};
