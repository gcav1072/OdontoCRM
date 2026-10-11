import {
  BRAND,
  CLINIC,
  MEDICATION_ROUTES,
  RECIPE_MARGIN_MM,
  brandStyles,
  brandWatermarkCss,
  brandWatermarkHtml,
  buildLetterheadView,
  clinicDentistLine,
  letterheadCss,
  letterheadHtml,
  medicationRouteLabel,
  recipePaperGeometry,
  type BrandThemePayload,
  type ClinicDentist,
  type ClinicIdentity,
  type MedicationRoute,
  type RecipePaper,
} from '@odontocrm/contracts';
import { brandFontFaceCss, readImageDataUri } from '@odontocrm/kernel';

import { qrSvg } from './qr.js';

/**
 * El HTML del **récipe** ([ADR 0015](../../../docs/adr/0015-recipe-a5-en-pdf.md),
 * [ADR 0065](../../../docs/adr/0065-el-recipe-cabe-en-el-papel-de-la-clinica.md)).
 *
 * Sale en **una hoja apaisada** partida en dos mitades verticales: a la izquierda la
 * **copia de la farmacia** (qué dispensar) y a la derecha la **copia del paciente** (las
 * indicaciones, con el QR). Las dos mitades llevan membrete, la línea del especialista y
 * su firma. El papel (carta de fábrica) y la **tipografía** (los tres tamaños del panel)
 * salen de la marca; el encaje a una sola hoja lo mide `prescriptions/fit-to-page.ts`.
 *
 * Es una plantilla de una sola pieza: el membrete sale de la **sección editable del
 * consultorio** (`packages/contracts/src/clinic.ts`) y lo que esté en `null`
 * simplemente no se imprime. El documento no lleva diagnóstico ni historia clínica:
 * un récipe dice qué tomar, no qué tiene el paciente.
 *
 * Se renderiza con Chromium (`renderPrescriptionPdf`) con el `@page` que dicta la marca.
 */

export interface PrescriptionDocumentItem {
  medicationName: string;
  presentation: string | null;
  route: string | null;
  dose: string;
  frequency: string;
  duration: string | null;
  instructions: string | null;
  quantity: string | null;
}

export interface PrescriptionDocumentInput {
  number: string;
  issuedAt: Date;
  patientName: string;
  patientDocument: string;
  patientBirthDate: string | null;
  /** `M` / `F` / `O` (o `null`): decide la concordancia de «nacido / nacida». */
  patientSex: string | null;
  patientAge: number | null;
  dentist: ClinicDentist | null;
  items: readonly PrescriptionDocumentItem[];
  generalInstructions: string | null;
  /** URL que abre el QR; si falta, el récipe sale sin QR (no se inventa). */
  verificationUrl: string | null;
  /** Código de verificación con su guion (`ABCDE-FGHJK`), como lo lee quien verifica. */
  verifyCode: string | null;
  /** Ruta del logo relativa a la raíz del repositorio (respaldo si no hay `logoDataUri`). */
  logoPath: string | null;
  /**
   * La identidad del consultorio tal como la leyó el servicio (la de la base o el
   * respaldo del código). Si falta, se usa `CLINIC`.
   */
  clinic?: ClinicIdentity | null;
  /** Logo ya incrustado como `data:` URI; si falta, se lee `logoPath`. */
  logoDataUri?: string | null;
  /**
   * La **marca efectiva** de los imprimibles (ADR 0060). Si falta, se usa `BRAND` (el
   * respaldo del código): los documentos ya emitidos y las pruebas siguen igual.
   */
  brand?: BrandThemePayload | null;
  /** Las `@font-face` ya resueltas por identity (con los `.woff2` incrustados). */
  fontFaceCss?: string | null;
}

/** Fecha como se lee en el papel: `1988-04-12` → `12/04/1988`. */
const shortDate = (value: string): string => {
  const partes = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  return partes === null ? value : `${partes[3] ?? ''}/${partes[2] ?? ''}/${partes[1] ?? ''}`;
};

/**
 * Línea del nacimiento: «nacida el 12/04/1988».
 *
 * El sexo del paciente decide la concordancia. El récipe lo firma una persona real y
 * lo lee el paciente: decirle «nacido» a una paciente es un error que se ve en el
 * papel. Si el sexo no consta (o es «otro»), se usa la forma que sirve para
 * cualquiera —«nació el …»— en vez de suponer.
 */
export const birthLine = (birthDate: string | null, sex: string | null): string | null => {
  if (birthDate === null || birthDate.trim() === '') return null;
  const fecha = `el ${shortDate(birthDate)}`;
  if (sex === 'F') return `nacida ${fecha}`;
  if (sex === 'M') return `nacido ${fecha}`;
  return `nació ${fecha}`;
};

/** Escapa el texto que va al HTML: el nombre del paciente lo escribe una persona. */
const escapeHtml = (value: string): string =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

/** ¿El valor guardado es una de las vías del catálogo? Protege los récipes ya emitidos. */
const esViaCatalogo = (value: string): value is MedicationRoute =>
  (MEDICATION_ROUTES as readonly string[]).includes(value);

/**
 * La **vía** como se lee en el papel.
 *
 * En la base se guarda el **código** (`oral`, `topica`…), así que el récipe lo traduce
 * con `medicationRouteLabel`. Si viniera un valor que no es del catálogo (un récipe ya
 * emitido con otra forma), se imprime tal cual en vez de rotularlo «Otra vía».
 */
export const routeText = (route: string | null): string | null => {
  const valor = route?.trim() ?? '';
  if (valor === '') return null;
  return esViaCatalogo(valor) ? medicationRouteLabel(valor) : valor;
};

/**
 * La vía para el renglón «Vía: …» de la copia de la farmacia.
 *
 * El rótulo del campo ya dice «Vía», así que se le quita el prefijo al valor para no
 * leer «Vía: Vía oral»: «Vía oral» → «Oral», «Otra vía» → «Otra».
 */
const viaParaCampo = (via: string): string => {
  const sinPrefijo = via.replace(/^vía\s+/i, '');
  return sinPrefijo.charAt(0).toUpperCase() + sinPrefijo.slice(1);
};

/** Fecha larga en la zona del consultorio: «04 de octubre de 2026». */
const longDate = (value: Date): string =>
  new Intl.DateTimeFormat('es-VE', {
    day: '2-digit',
    month: 'long',
    year: 'numeric',
    timeZone: 'America/Caracas',
  }).format(value);

/**
 * Valor por defecto de la **escala de encaje** del récipe: `1` (tamaño normal). El
 * servicio la reescribe —sobre `<html>`— cuando la hoja no cabe, midiendo el documento
 * (`prescriptions/fit-to-page.ts`), para no dejar los medicamentos o la firma en una
 * segunda página casi vacía.
 */
const RX_FIT_DEFAULT = '--rx-fit: 1;';

const styles = (fontFaces: string, brand: BrandThemePayload | null | undefined): string => {
  const marca = brand ?? BRAND;
  const papel = recipePaperGeometry(marca.recipePaper);
  // La escala `--rx-fit` multiplica todas las medidas del récipe (membrete, listas,
  // tabla, firmas). Vale 1 en tamaño normal; el servicio la baja si el documento no cabe.
  const f = 'var(--rx-fit, 1)';
  return `
  ${fontFaces}
  ${brandStyles(marca)}
  ${brandWatermarkCss()}
  ${letterheadCss()}
  /* El papel lo fija la marca (carta de fábrica, el mismo de los demás imprimibles): una
     hoja A4 apaisada mide 210 mm de alto y no entra en una carta, así que la impresora
     parte lo que sobra —que va en blanco— a una segunda hoja. */
  @page { size: ${papel.cssSize}; margin: ${String(RECIPE_MARGIN_MM)}mm; }
  * { box-sizing: border-box; }
  /* El cuerpo (fuente y tinta) lo pone brandStyles(), la marca compartida con el
     reporte y el dossier: el membrete del consultorio no sale de dos colores. */
  /* La escala de encaje vive en la raíz y la leen todas las reglas de abajo (y las del
     membrete): así se reduce el récipe entero de una vez. El servicio la escribe ahí
     cuando la hoja no cabe (prescriptions/fit-to-page.ts). */
  :root {
    ${RX_FIT_DEFAULT}
    /* La **tipografía del récipe** sale de la marca que el panel configura: el título, el
       cuerpo y lo menudo (13 / 9 / 7,5 pt de fábrica). Los tamaños intermedios son las
       proporciones que el récipe ya tenía sobre esos tres, así que con los valores de
       fábrica el papel sale exactamente como salía, y mover uno de los tres en el panel
       mueve su familia entera. Todos se multiplican por el encaje. */
    --rx-title: calc(var(--brand-doc-title-pt) * ${f}); /* 13 pt: «RÉCIPE» */
    --rx-body: calc(var(--brand-doc-body-pt) * ${f}); /* 9 pt: líneas del borrador */
    --rx-small: calc(var(--brand-doc-small-pt) * ${f}); /* 7,5 pt: lo menudo */
    --rx-med: calc(var(--brand-doc-body-pt) * 7 / 6 * ${f}); /* 10,5 pt: el medicamento */
    --rx-patient: calc(var(--brand-doc-body-pt) * 17 / 18 * ${f}); /* 8,5 pt: el paciente */
    --rx-table: calc(var(--brand-doc-body-pt) * 8 / 9 * ${f}); /* 8 pt: tabla y códigos */
    --rx-th: calc(var(--brand-doc-small-pt) * 14 / 15 * ${f}); /* 7 pt: encabezado de tabla */
    --rx-code: calc(var(--brand-doc-small-pt) * 16 / 15 * ${f}); /* 8 pt: «Código de verificación» */
    --rx-verify: calc(var(--brand-doc-small-pt) * 4 / 5 * ${f}); /* 6 pt: el QR */
    --rx-note: calc(var(--brand-doc-small-pt) * 13 / 15 * ${f}); /* 6,5 pt: la nota del pie */
  }
  /* El membrete también encoge (tipografía, alto del logo y espaciado de las líneas): la
     identidad del consultorio no debe ser lo que empuje el documento a una segunda hoja. */
  .brand-lh--rule { padding-bottom: calc(2.5mm * ${f}); }
  .brand-lh-logo { height: calc(var(--brand-logo-height-mm) * ${f}); }
  .brand-lh-name { font-size: calc(var(--brand-lh-title-pt) * ${f}); }
  .brand-lh-line { font-size: calc(var(--brand-lh-line-pt) * ${f}); margin-top: calc(0.5mm * ${f}); }
  .brand-lh-dentist { margin-top: calc(0.8mm * ${f}); }
  .brand-lh-footer { margin-top: calc(1mm * ${f}); }
  /* La hoja va **apaisada y partida en dos mitades verticales**: a la izquierda la
     copia de la farmacia, a la derecha la del paciente. Su alto es una **altura mínima
     holgada** (185 mm), no un alto fijo: crece con el contenido. La escala de encaje la
     multiplica, así que si el documento se encoge, la hoja se encoge con él: es lo que
     garantiza que quepa en la página y no deje una segunda hoja en blanco. */
  .sheet { display: flex; min-height: calc(185mm * ${f}); }
  .half { position: relative; flex: 1 1 0; min-width: 0; display: flex; flex-direction: column; }
  /* La marca de agua va **una vez por mitad**, no sobre el pliego entero: el récipe son
     dos copias en una sola hoja apaisada, y una marca centrada en la página caería justo
     sobre la línea divisoria. Además el contenido sube a una capa superior para quedar
     por encima del velo.

     Se centra **sin transform**: la marca compartida se centra con top:50% +
     translateY(-50%), y ese transform solo la mueve *a la vista*: su **caja de layout**
     queda anclada al 50% y **se extiende hacia abajo** por toda su altura. Con un velo
     grande —o con el membrete alto, que alarga la mitad— esa caja pasaba del área
     imprimible y Chromium añadía una **segunda hoja en blanco**. Con inset:0 y
     margin:auto la caja queda centrada *dentro* de la mitad (misma posición a la vista)
     y, con max-height/max-width al 100%, nunca la desborda. El velo encoge con la hoja,
     igual que el resto del documento (--rx-fit). */
  .half > .brand-watermark {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    margin: auto;
    transform: none;
    width: calc(var(--brand-watermark-width-mm) * ${f});
    max-width: 100%;
    max-height: 100%;
  }
  .half > *:not(.brand-watermark) { position: relative; z-index: 1; }
  .half + .half { border-left: 0.3mm dashed var(--brand-line); padding-left: 6mm; }
  .half:first-child { padding-right: 6mm; }
  /* El bloque de identidad del consultorio (logo + datos) sale del helper compartido
     (letterheadCss): el alto del logo es el de la marca —no un 12 mm fijo—, el logo se
     centra en vertical y las líneas siguen el orden y la tipografía del panel. */
  .rx { display: flex; justify-content: space-between; align-items: baseline; gap: 3mm; margin-top: calc(3mm * ${f}); }
  .rx-title { font-family: var(--brand-font-doc-title); font-size: var(--rx-title); font-weight: var(--brand-font-doc-title-weight); letter-spacing: 0.4mm; margin: 0; color: var(--brand-primary); }
  .rx-number { font-size: var(--rx-table); color: var(--brand-ink-muted); text-align: right; }
  .patient { margin-top: calc(2mm * ${f}); font-size: var(--rx-patient); }
  .patient strong { font-weight: 600; }
  /* Copia de la farmacia (izquierda): un bloque por medicamento. */
  .rp-items { margin-top: calc(3.5mm * ${f}); }
  .rp-item { margin-top: calc(3.5mm * ${f}); }
  .rp-item:first-child { margin-top: 0; }
  .rp-med { font-weight: 700; text-decoration: underline; font-size: var(--rx-med); margin: 0 0 calc(1mm * ${f}); }
  .rp-line { font-size: var(--rx-body); margin: calc(0.4mm * ${f}) 0 0; }
  .rp-line strong { font-weight: 600; }
  .rp-code { margin-top: calc(4mm * ${f}); font-size: var(--rx-code); color: var(--brand-ink-muted); }
  .rp-code code { font-size: var(--rx-patient); letter-spacing: 0.3mm; color: var(--brand-ink-strong); }
  /* Copia del paciente (derecha): la tabla de siempre. */
  table { width: 100%; border-collapse: collapse; margin-top: calc(3mm * ${f}); font-size: var(--rx-table); }
  th { text-align: left; background: var(--brand-table-head-bg); color: var(--brand-primary); font-size: var(--rx-th); text-transform: uppercase; letter-spacing: 0.2mm; padding: calc(1.4mm * ${f}) calc(1.6mm * ${f}); border-bottom: 0.3mm solid var(--brand-line); }
  td { padding: calc(1.5mm * ${f}) calc(1.6mm * ${f}); border-bottom: 0.2mm solid var(--brand-line-soft); vertical-align: top; }
  /* Anchos fijos para que «500 mg» y «cada 8 horas» no se partan en dos renglones. */
  th:nth-child(2), td:nth-child(2) { width: calc(18mm * ${f}); }
  th:nth-child(3), td:nth-child(3) { width: calc(28mm * ${f}); }
  .med { font-weight: 600; }
  .detail { color: var(--brand-ink-strong); font-size: var(--rx-small); }
  .instructions { margin-top: calc(3mm * ${f}); font-size: var(--rx-table); }
  .instructions h2 { font-family: var(--brand-font-doc-title); font-size: var(--rx-table); font-weight: var(--brand-font-doc-title-weight); text-transform: uppercase; letter-spacing: 0.2mm; color: var(--brand-primary); margin: 0 0 calc(1mm * ${f}); }
  /* La firma se ancla al pie de su mitad; el especialista ya va en el membrete, así que
     bajo la línea solo queda el nombre. */
  .signature { text-align: center; font-size: var(--rx-patient); min-width: 48mm; margin-top: auto; padding-top: calc(6mm * ${f}); }
  .signature-line { border-top: 0.3mm solid var(--brand-ink); margin-bottom: calc(1.2mm * ${f}); }
  .signature-name { font-weight: 600; }
  .footer { display: flex; align-items: flex-end; justify-content: space-between; gap: 4mm; margin-top: auto; padding-top: calc(6mm * ${f}); }
  .footer .signature { margin-top: 0; padding-top: 0; }
  .verify { text-align: center; font-size: var(--rx-verify); color: var(--brand-ink-muted); }
  .verify svg { width: calc(19mm * ${f}); height: calc(19mm * ${f}); display: block; margin: 0 auto calc(1mm * ${f}); }
  .verify code { font-size: var(--rx-note); letter-spacing: 0.3mm; }
  .note { margin-top: calc(1.5mm * ${f}); font-size: var(--rx-note); color: var(--brand-ink-subtle); }
`;
};

/** Cuenta las hojas del PDF (`/Type /Page`; `/Type /Pages` es el nodo raíz del árbol). */
export const countPdfPages = (pdf: Buffer): number =>
  (pdf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) ?? []).length;

/**
 * El **papel** en el que sale el récipe según la marca (con el respaldo del código). El
 * documento pone el `@page` y el servicio compone el PDF con el mismo papel: una sola
 * fuente para las dos cosas.
 */
export const recipePaperOf = (brand: BrandThemePayload | null | undefined): RecipePaper =>
  brand?.recipePaper ?? BRAND.recipePaper;

/**
 * HTML completo del récipe. Se devuelve como cadena (no se escribe en disco): el
 * navegador lo recibe con `page.setContent` y de ahí sale el PDF.
 */
export const prescriptionHtml = async (input: PrescriptionDocumentInput): Promise<string> => {
  const consultorio = input.clinic ?? CLINIC;
  const logo = input.logoDataUri ?? (await readImageDataUri(input.logoPath));
  // La marca de agua usa el **logo efectivo** (el subido o el del repositorio): si no
  // hay ninguno, `brandWatermarkHtml` devuelve cadena vacía y el récipe sale sin velo.
  const marcaDeAgua = brandWatermarkHtml(logo ?? (await readImageDataUri(BRAND.watermarkPath)));
  const odontologo = input.dentist;
  const lineaDentista = clinicDentistLine(odontologo);

  // El membrete se repite en cada mitad: cada copia se puede desprender y sigue siendo
  // un documento con su identidad. Sale del **helper compartido**: el mismo bloque —con
  // el alto del logo, la tipografía, las líneas y el pie que elige el panel— en la SPA y
  // en el PDF del servidor.
  const membrete = letterheadHtml(
    buildLetterheadView(consultorio, lineaDentista, input.brand?.letterhead ?? BRAND.letterhead, {
      subtitle: consultorio.legalName,
    }),
    logo,
  );

  const paciente = [
    input.patientAge === null ? null : `${String(input.patientAge)} años`,
    birthLine(input.patientBirthDate, input.patientSex),
  ]
    .filter((line): line is string => line !== null)
    .join(' · ');

  const pacienteLinea = `
  <p class="patient">
    <strong>Paciente:</strong> ${escapeHtml(input.patientName)} ·
    <strong>Documento:</strong> ${escapeHtml(input.patientDocument)}${paciente === '' ? '' : ` · ${escapeHtml(paciente)}`}
  </p>`;

  const numeroFecha = `N.º ${escapeHtml(input.number)} · ${escapeHtml(longDate(input.issuedAt))}`;

  // La firma la comparten las dos mitades: el especialista ya está en el membrete, así
  // que bajo la línea solo va su nombre.
  const firma = `
    <div class="signature">
      <div class="signature-line"></div>
      <div class="signature-name">${escapeHtml(odontologo?.fullName ?? '')}</div>
    </div>`;

  // ── Copia de la farmacia (izquierda): qué dispensar, sin posología ni indicaciones ──
  const itemsFarmacia = input.items
    .map((item) => {
      const via = routeText(item.route);
      const lineas: [string, string][] = [];
      if (item.presentation !== null && item.presentation.trim() !== '') {
        lineas.push(['Presentación', item.presentation]);
      }
      if (via !== null) lineas.push(['Vía', viaParaCampo(via)]);
      lineas.push(['Dosis', item.dose]);
      return `
      <div class="rp-item">
        <p class="rp-med">${escapeHtml(item.medicationName)}</p>
        ${lineas
          .map(
            ([etiqueta, valor]) =>
              `<p class="rp-line"><strong>${etiqueta}:</strong> ${escapeHtml(valor)}</p>`,
          )
          .join('')}
      </div>`;
    })
    .join('');

  const codigo =
    input.verifyCode === null
      ? ''
      : `<p class="rp-code">Código de verificación: <code>${escapeHtml(input.verifyCode)}</code></p>`;

  // ── Copia del paciente (derecha): las indicaciones, con la tabla y el QR de siempre ──
  const filas = input.items
    .map((item) => {
      const detalles = [
        item.presentation,
        routeText(item.route),
        item.duration === null ? null : `por ${item.duration}`,
        item.quantity === null ? null : `cantidad: ${item.quantity}`,
        item.instructions,
      ]
        .filter((line): line is string => line !== null && line.trim() !== '')
        .map(escapeHtml)
        .join(' · ');

      return `
        <tr>
          <td>
            <span class="med">${escapeHtml(item.medicationName)}</span>
            ${detalles === '' ? '' : `<div class="detail">${detalles}</div>`}
          </td>
          <td>${escapeHtml(item.dose)}</td>
          <td>${escapeHtml(item.frequency)}</td>
        </tr>`;
    })
    .join('');

  const verificacion =
    input.verificationUrl === null
      ? ''
      : `<div class="verify">
           ${qrSvg(input.verificationUrl)}
           <code>${escapeHtml(input.number)}</code>
           <div>Verifica este récipe en la web del consultorio</div>
         </div>`;

  return `<!doctype html>
<html lang="es">
<head><meta charset="utf-8"><title>Récipe ${escapeHtml(input.number)}</title><style>${styles(input.fontFaceCss ?? (await brandFontFaceCss()), input.brand)}</style></head>
<body>
  <div class="brand-doc">
  <div class="sheet">

    <section class="half">
      ${marcaDeAgua}
      ${membrete}

      <section class="rx">
        <h1 class="rx-title">RÉCIPE</h1>
        <span class="rx-number">${numeroFecha}</span>
      </section>

      ${pacienteLinea}

      <div class="rp-items">${itemsFarmacia}</div>

      ${codigo}

      ${firma}
    </section>

    <section class="half">
      ${marcaDeAgua}
      ${membrete}

      <section class="rx">
        <h1 class="rx-title">INDICACIONES</h1>
        <span class="rx-number">${numeroFecha}</span>
      </section>

      ${pacienteLinea}

      <table>
        <thead>
          <tr><th>Medicamento</th><th>Dosis</th><th>Frecuencia</th></tr>
        </thead>
        <tbody>${filas}</tbody>
      </table>

      ${
        input.generalInstructions === null || input.generalInstructions.trim() === ''
          ? ''
          : `<section class="instructions"><h2>Indicaciones generales</h2>${escapeHtml(input.generalInstructions).replace(/\n/g, '<br>')}</section>`
      }

      <div class="footer">
        <div>${verificacion}</div>
        ${firma}
      </div>

      <p class="note">
        Documento emitido por el sistema del consultorio. Conserva este récipe: el código del recuadro
        permite comprobar su autenticidad.
      </p>
    </section>

  </div>
  </div>
</body>
</html>`;
};
