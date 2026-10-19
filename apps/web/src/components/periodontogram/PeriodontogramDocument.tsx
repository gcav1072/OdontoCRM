import {
  FURCATION_ENTRANCE_SHORT,
  PERIODONTAL_LOWER_TEETH,
  PERIODONTAL_UPPER_TEETH,
  PERIODONTAL_SITE_INDEXES,
  analyzePeriodontalChart,
  buildPeriodontalChart,
  furcationEntrancesFor,
  periodontalArchOf,
  sitesOfTooth,
  type PeriodontalComparison,
  type PeriodontalExamDetail,
  type PeriodontalPatientSnapshot,
  type PeriodontalSiteDiff,
  type PeriodontalTooth,
} from '@odontocrm/contracts';

import { formatDateTime, formatDecimal } from '../../lib/format';
import { t } from '../../lib/i18n';
import { MarcaDeAgua } from '../print/MarcaDeAgua';
import { MembreteDocumento } from '../print/MembreteDocumento';
import { PeriodontogramArchSvg } from './PeriodontogramArchSvg';
import { changeColor, comparisonSiteIndex, PERIODONTAL_COLORS } from './geometry';
import {
  archName,
  calText,
  changeLabel,
  comparisonKpiItems,
  examDateLabel,
  examStatusLabel,
  furcationLabel,
  gradeLabel,
  kpiItems,
  mobilityLabel,
  riskFactorsText,
  siteFieldText,
  siteShortName,
  stageLabel,
  suggestionText,
  toothStateText,
  type KpiItem,
} from './presentation';

/**
 * Documento imprimible del periodontograma (A4).
 *
 * Se lee sin interacción y sin permisos de escritura: la secretaría imprime y el
 * odontólogo archiva el examen. Enseña **todo** lo capturado —las 192 cifras de
 * PS/MG con su NIC derivado, por diente, cara y sitio—, el estado de las piezas, los
 * KPIs, la clasificación firmada y los factores de riesgo. Si se pide la comparación,
 * la evolución va detrás, en su propia página, para que el informe base siga cabiendo
 * en una hoja.
 *
 * Reutiliza `MembreteDocumento`, `MarcaDeAgua` y el mismo SVG de la pantalla
 * (`readOnly`): el papel no puede discrepar de lo que se vio al capturar.
 */

/** Tonos de las tarjetas del informe (sin fondos: el navegador no los imprime). */
const TONE_COLOR: Readonly<Record<KpiItem['tone'], string>> = {
  neutral: 'var(--brand-ink-muted)',
  success: '#15803d',
  warning: '#b45309',
  danger: '#b91c1c',
  info: '#1d4ed8',
};

/** Círculo de color en SVG: los fondos CSS no se imprimen, el `fill` sí. */
const Dot = ({ color, size = 'size-2.5' }: { color: string; size?: string }) => (
  <svg viewBox="0 0 10 10" className={`${size} shrink-0`} aria-hidden>
    <circle cx={5} cy={5} r={5} fill={color} />
  </svg>
);

/** Cuadrado de color en SVG, para la leyenda de la tabla. */
const Square = ({ color }: { color: string }) => (
  <svg viewBox="0 0 10 10" className="size-2.5 shrink-0" aria-hidden>
    <rect x={1} y={1} width={8} height={8} rx={1} fill={color} />
  </svg>
);

/** Fila de KPIs del informe (la misma lista que el panel). */
const KpiGrid = ({ items }: { items: readonly KpiItem[] }) => (
  <dl className="grid grid-cols-3 gap-x-4 gap-y-2 sm:grid-cols-4 lg:grid-cols-6 print:grid-cols-6 print:gap-x-2 print:gap-y-1">
    {items.map((item) => (
      <div key={item.key}>
        <dt className="text-[9px] tracking-wide text-[color:var(--brand-ink-subtle)] uppercase print:text-[7px]">
          {item.label}
        </dt>
        <dd
          className="font-mono text-sm font-semibold print:text-[10px]"
          style={{ color: TONE_COLOR[item.tone] }}
        >
          {item.value}
        </dd>
      </div>
    ))}
  </dl>
);

/**
 * `true` si la pieza tiene algo que contar en el papel: una medición, un hallazgo o
 * un estado (ausente, implante). Las 32 piezas de una boca en blanco no se listan:
 * imprimir 64 filas de «—» convertía el informe de dos hojas en cuatro.
 */
const toothHasData = (tooth: PeriodontalTooth): boolean =>
  tooth.missing ||
  tooth.implant ||
  tooth.mobility !== null ||
  Object.keys(tooth.furcation).length > 0 ||
  sitesOfTooth(tooth).some(
    ({ site }) =>
      site.pd !== null || site.gm !== null || site.bop || site.plaque || site.suppuration,
  );

/**
 * Tabla de los sitios de una arcada: 16 piezas × 2 caras × 3 sitios = 96 entradas.
 * Cada celda enseña la sigla anatómica (MV, P, DL…), PS/MG y el NIC derivado.
 *
 * Se imprimen **solo las piezas con datos** y cada pieza va en su propio `<tbody>`:
 * las dos caras de un mismo diente no se separan nunca entre dos páginas (el motor
 * de paginación corta entre filas, pero respeta los grupos protegidos).
 */
const SitesTable = ({
  arch,
  teeth,
  comparisonIndex,
}: {
  arch: 'maxilar' | 'mandibula';
  teeth: readonly PeriodontalTooth[];
  comparisonIndex: ReadonlyMap<string, PeriodontalSiteDiff> | null;
}) => {
  const evaluadas = teeth.filter(toothHasData);
  const omitidas = teeth.length - evaluadas.length;
  return (
    <div className="break-inside-avoid">
      <h4 className="text-[10px] font-semibold text-[color:var(--brand-primary)]">
        {archName(arch)}
      </h4>
      {evaluadas.length === 0 ? (
        <p className="mt-1 text-[8px] text-[color:var(--brand-ink-muted)]">
          {t('periodonto.imprimir.sitios.sinDatos')}
        </p>
      ) : (
        <table className="mt-1 w-full border-collapse text-center">
          <thead>
            <tr className="text-[7px] tracking-wide text-[color:var(--brand-primary)] uppercase">
              <th className="border border-[color:var(--brand-line)] px-0.5 py-0.5 text-left">
                {t('periodonto.tabla.pieza')}
              </th>
              <th className="border border-[color:var(--brand-line)] px-0.5 py-0.5 text-left">
                {t('periodonto.tabla.cara')}
              </th>
              {PERIODONTAL_SITE_INDEXES.map((index) => (
                <th key={index} className="border border-[color:var(--brand-line)] px-0.5 py-0.5">
                  {t('periodonto.imprimir.sitioColumna', { numero: index + 1 })}
                </th>
              ))}
              <th className="border border-[color:var(--brand-line)] px-0.5 py-0.5">
                {t('periodonto.tabla.movilidad')}
              </th>
              <th className="border border-[color:var(--brand-line)] px-0.5 py-0.5">
                {t('periodonto.tabla.furca')}
              </th>
            </tr>
          </thead>
          {evaluadas.map((tooth) => {
            if (tooth.missing) {
              return (
                <tbody key={tooth.fdi} className="break-inside-avoid">
                  <tr>
                    <th
                      scope="row"
                      className="border border-[color:var(--brand-line)] px-0.5 py-0.5 text-left font-mono text-[9px] font-semibold"
                    >
                      {tooth.fdi}
                    </th>
                    <td
                      className="border border-[color:var(--brand-line)] px-0.5 py-0.5 text-left text-[7px] text-[color:var(--brand-ink-muted)]"
                      colSpan={6}
                    >
                      {t('periodonto.imprimir.piezaSinSitios', {
                        estado: toothStateText(tooth).toLowerCase(),
                      })}
                    </td>
                  </tr>
                </tbody>
              );
            }
            return (
              <tbody key={tooth.fdi} className="break-inside-avoid">
                {(['vestibular', 'lingual'] as const).map((side, position) => {
                  const sites = side === 'vestibular' ? tooth.vestibular : tooth.lingual;
                  return (
                    <tr
                      key={`${String(tooth.fdi)}-${side}`}
                      className={
                        position === 0 ? 'border-t border-[color:var(--brand-ink-muted)]' : ''
                      }
                    >
                      {position === 0 && (
                        <th
                          scope="rowgroup"
                          rowSpan={2}
                          className="border border-[color:var(--brand-line)] px-0.5 py-0.5 align-top text-left font-mono text-[9px] font-semibold"
                        >
                          {tooth.fdi}
                          {tooth.implant && (
                            <span className="block text-[6px] font-normal text-[color:var(--brand-ink-muted)]">
                              {t('periodonto.pieza.implante')}
                            </span>
                          )}
                        </th>
                      )}
                      <td className="border border-[color:var(--brand-line)] px-0.5 py-0.5 text-left text-[7px] text-[color:var(--brand-ink-muted)]">
                        {side === 'vestibular'
                          ? t('periodonto.cara.vestibular')
                          : arch === 'maxilar'
                            ? t('periodonto.cara.palatina')
                            : t('periodonto.cara.lingual')}
                      </td>
                      {PERIODONTAL_SITE_INDEXES.map((index) => {
                        const site = sites[index];
                        const cambio =
                          comparisonIndex === null
                            ? null
                            : (comparisonIndex.get(
                                `${String(tooth.fdi)}:${side}:${String(index)}`,
                              ) ?? null);
                        return (
                          <td
                            key={index}
                            className="border border-[color:var(--brand-line)] px-0.5 py-0.5 align-top"
                          >
                            <span className="block text-[6px] font-semibold text-[color:var(--brand-ink-subtle)] uppercase">
                              {siteShortName(tooth.fdi, side, index)}
                            </span>
                            <span className="block font-mono text-[8px] leading-tight text-[color:var(--brand-ink)]">
                              {siteFieldText(site, 'pd')} / {siteFieldText(site, 'gm')}
                            </span>
                            <span className="block text-[6px] leading-tight text-[color:var(--brand-ink-subtle)]">
                              {t('periodonto.imprimir.nic', { valor: calText(site) })}
                            </span>
                            <span className="flex justify-center gap-1 text-[7px] leading-none font-bold">
                              {site.bop && (
                                <span
                                  style={{ color: PERIODONTAL_COLORS.bop }}
                                  title={t('periodonto.tabla.bop')}
                                >
                                  {t('periodonto.tabla.corta.bop')}
                                </span>
                              )}
                              {site.plaque && (
                                <span
                                  style={{ color: PERIODONTAL_COLORS.plaque }}
                                  title={t('periodonto.tabla.placa')}
                                >
                                  {t('periodonto.tabla.corta.placa')}
                                </span>
                              )}
                              {site.suppuration && (
                                <span
                                  style={{ color: PERIODONTAL_COLORS.suppuration }}
                                  title={t('periodonto.tabla.supuracion')}
                                >
                                  {t('periodonto.tabla.corta.supuracion')}
                                </span>
                              )}
                            </span>
                            {cambio !== null &&
                              cambio.change !== 'sin_dato' &&
                              cambio.change !== 'estable' && (
                                <span
                                  className="block text-[6px] font-semibold"
                                  style={{ color: changeColor(cambio.change) }}
                                >
                                  {changeLabel(cambio.change)}
                                </span>
                              )}
                          </td>
                        );
                      })}
                      {position === 0 && (
                        <>
                          <td
                            rowSpan={2}
                            className="border border-[color:var(--brand-line)] px-0.5 py-0.5 text-[7px] text-[color:var(--brand-ink-muted)]"
                          >
                            {tooth.implant ? '' : mobilityLabel(tooth.mobility)}
                          </td>
                          <td
                            rowSpan={2}
                            className="border border-[color:var(--brand-line)] px-0.5 py-0.5 text-left text-[6px] text-[color:var(--brand-ink-muted)]"
                          >
                            {tooth.implant
                              ? ''
                              : furcationEntrancesFor(tooth.fdi).map((entrance) => (
                                  <span key={entrance} className="block whitespace-nowrap">
                                    {FURCATION_ENTRANCE_SHORT[entrance]}:{' '}
                                    {furcationLabel(tooth.furcation[entrance] ?? null)}
                                  </span>
                                ))}
                          </td>
                        </>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            );
          })}
        </table>
      )}
      {omitidas > 0 && (
        <p className="mt-1 text-[7px] text-[color:var(--brand-ink-subtle)]">
          {t('periodonto.imprimir.sitios.omitidas', { piezas: omitidas })}
        </p>
      )}
    </div>
  );
};

/** Boca sintética del examen anterior, para superponer su línea punteada. */
const previousChartOf = (comparison: PeriodontalComparison): PeriodontalTooth[] => {
  const chart = buildPeriodontalChart();
  for (const diff of comparison.sites) {
    const tooth = chart.find((item) => item.fdi === diff.fdi);
    if (tooth === undefined || diff.previous === null) continue;
    const sitios = diff.side === 'vestibular' ? tooth.vestibular : tooth.lingual;
    sitios[diff.index] = {
      ...sitios[diff.index],
      pd: diff.previous.pd,
      gm: diff.previous.gm,
      bop: diff.previous.bop,
    };
  }
  return chart;
};

/** Evolución: solo los sitios con cambio real, bolsa nueva o bolsa resuelta. */
const EvolutionSection = ({
  comparison,
  previousExamDate,
  currentExamDate,
}: {
  comparison: PeriodontalComparison;
  previousExamDate: string | null;
  currentExamDate: string;
}) => {
  const relevantes = comparison.sites.filter(
    (site) =>
      site.change === 'mejoro' ||
      site.change === 'empeoro' ||
      site.newPocket ||
      site.resolvedPocket,
  );
  return (
    <section className="mt-6 break-before-page">
      <h2 className="text-sm font-semibold tracking-wide text-[color:var(--brand-primary)] uppercase">
        {t('periodonto.imprimir.evolucion.titulo')}
      </h2>
      <p className="mt-1 text-xs text-[color:var(--brand-ink-muted)]">
        {t('periodonto.imprimir.evolucion.texto', {
          anterior:
            previousExamDate === null ? t('comun.sinDato') : examDateLabel(previousExamDate),
          actual: examDateLabel(currentExamDate),
        })}
      </p>
      <div className="mt-3">
        <KpiGrid items={comparisonKpiItems(comparison.summary)} />
      </div>
      {relevantes.length === 0 ? (
        <p className="mt-3 text-sm text-[color:var(--brand-ink-muted)]">
          {t('periodonto.imprimir.evolucion.sinCambios')}
        </p>
      ) : (
        <table className="mt-3 w-full border-collapse text-[8px]">
          <thead>
            <tr className="text-[7px] tracking-wide text-[color:var(--brand-primary)] uppercase">
              <th className="border border-[color:var(--brand-line)] px-1 py-0.5">
                {t('periodonto.tabla.pieza')}
              </th>
              <th className="border border-[color:var(--brand-line)] px-1 py-0.5">
                {t('periodonto.tabla.cara')}
              </th>
              <th className="border border-[color:var(--brand-line)] px-1 py-0.5">
                {t('periodonto.imprimir.sitio')}
              </th>
              <th className="border border-[color:var(--brand-line)] px-1 py-0.5">
                {t('periodonto.imprimir.evolucion.anterior')}
              </th>
              <th className="border border-[color:var(--brand-line)] px-1 py-0.5">
                {t('periodonto.imprimir.evolucion.actual')}
              </th>
              <th className="border border-[color:var(--brand-line)] px-1 py-0.5">
                {t('periodonto.imprimir.evolucion.deltaPs')}
              </th>
              <th className="border border-[color:var(--brand-line)] px-1 py-0.5">
                {t('periodonto.imprimir.evolucion.deltaNic')}
              </th>
              <th className="border border-[color:var(--brand-line)] px-1 py-0.5">
                {t('periodonto.imprimir.evolucion.cambio')}
              </th>
            </tr>
          </thead>
          <tbody>
            {relevantes.map((site) => (
              <tr key={`${String(site.fdi)}-${site.side}-${String(site.index)}`}>
                <td className="border border-[color:var(--brand-line)] px-1 py-0.5 text-center font-mono font-semibold">
                  {site.fdi}
                </td>
                <td className="border border-[color:var(--brand-line)] px-1 py-0.5 text-center">
                  {site.side === 'vestibular'
                    ? t('periodonto.cara.vestibular')
                    : periodontalArchOf(site.fdi) === 'maxilar'
                      ? t('periodonto.cara.palatina')
                      : t('periodonto.cara.lingual')}
                </td>
                <td className="border border-[color:var(--brand-line)] px-1 py-0.5 text-center">
                  {siteShortName(site.fdi, site.side, site.index)}
                </td>
                <td className="border border-[color:var(--brand-line)] px-1 py-0.5 text-center font-mono">
                  {site.previous === null
                    ? t('comun.sinDato')
                    : `${site.previous.pd === null ? t('comun.sinDato') : String(site.previous.pd)} / ${site.previous.gm === null ? t('comun.sinDato') : String(site.previous.gm)}`}
                </td>
                <td className="border border-[color:var(--brand-line)] px-1 py-0.5 text-center font-mono">
                  {site.current === null
                    ? t('comun.sinDato')
                    : `${site.current.pd === null ? t('comun.sinDato') : String(site.current.pd)} / ${site.current.gm === null ? t('comun.sinDato') : String(site.current.gm)}`}
                </td>
                <td className="border border-[color:var(--brand-line)] px-1 py-0.5 text-center font-mono">
                  {site.deltaPd === null
                    ? t('comun.sinDato')
                    : site.deltaPd > 0
                      ? `+${String(site.deltaPd)}`
                      : String(site.deltaPd)}
                </td>
                <td className="border border-[color:var(--brand-line)] px-1 py-0.5 text-center font-mono">
                  {site.deltaCal === null
                    ? t('comun.sinDato')
                    : site.deltaCal > 0
                      ? `+${String(site.deltaCal)}`
                      : String(site.deltaCal)}
                </td>
                <td
                  className="border border-[color:var(--brand-line)] px-1 py-0.5 text-center font-semibold"
                  style={{ color: changeColor(site.change) }}
                >
                  {changeLabel(site.change)}
                  {site.newPocket ? ` · ${t('periodonto.imprimir.evolucion.bolsaNueva')}` : ''}
                  {site.resolvedPocket
                    ? ` · ${t('periodonto.imprimir.evolucion.bolsaResuelta')}`
                    : ''}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className="mt-2 text-[8px] text-[color:var(--brand-ink-subtle)]">
        {t('periodonto.imprimir.evolucion.leyenda')}
      </p>
    </section>
  );
};

export interface PeriodontogramDocumentProps {
  detail: PeriodontalExamDetail;
  patient: PeriodontalPatientSnapshot | null;
  /** Comparación con el examen anterior: añade la sección de evolución. */
  comparison?: PeriodontalComparison | null;
  /** Fecha del examen anterior comparado (para el encabezado de la evolución). */
  previousExamDate?: string | null;
}

export const PeriodontogramDocument = ({
  detail,
  patient,
  comparison = null,
  previousExamDate = null,
}: PeriodontogramDocumentProps) => {
  const analisis = analyzePeriodontalChart(detail.chart, detail.riskFactors);
  const comparisonIndex = comparison === null ? null : comparisonSiteIndex(comparison);
  const previousChart = comparison === null ? null : previousChartOf(comparison);
  const archivos = [
    {
      arch: 'maxilar' as const,
      teeth: detail.chart.filter((tooth) => PERIODONTAL_UPPER_TEETH.includes(tooth.fdi)),
    },
    {
      arch: 'mandibula' as const,
      teeth: detail.chart.filter((tooth) => PERIODONTAL_LOWER_TEETH.includes(tooth.fdi)),
    },
  ];
  const diagnosis = detail.diagnosis;

  return (
    <article className="relative mx-auto max-w-[21cm] bg-white px-8 py-6 text-[color:var(--brand-ink)] print:px-0 print:py-0">
      <MarcaDeAgua />
      <div className="relative z-[1]">
        <MembreteDocumento title={t('periodonto.imprimir.documento')} />
        <header
          className="mt-3 border-b-2 pb-3 print:mt-2 print:pb-2"
          style={{ borderColor: 'var(--brand-ink)' }}
        >
          <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm sm:grid-cols-4">
            <div>
              <dt className="text-xs tracking-wide text-[color:var(--brand-ink-subtle)] uppercase">
                {t('periodonto.imprimir.paciente')}
              </dt>
              <dd className="font-medium">
                {patient?.fullName ?? t('periodonto.imprimir.pacienteDesconocido')}
              </dd>
            </div>
            <div>
              <dt className="text-xs tracking-wide text-[color:var(--brand-ink-subtle)] uppercase">
                {t('periodonto.imprimir.documentoPaciente')}
              </dt>
              <dd>{patient?.document ?? t('comun.sinDato')}</dd>
            </div>
            <div>
              <dt className="text-xs tracking-wide text-[color:var(--brand-ink-subtle)] uppercase">
                {t('periodonto.imprimir.edad')}
              </dt>
              <dd>
                {patient === null
                  ? t('comun.sinDato')
                  : t('periodonto.imprimir.anios', { edad: patient.age })}
              </dd>
            </div>
            <div>
              <dt className="text-xs tracking-wide text-[color:var(--brand-ink-subtle)] uppercase">
                {t('periodonto.imprimir.fecha')}
              </dt>
              <dd>
                {examDateLabel(detail.examDate)} · {examStatusLabel(detail.status)}
              </dd>
            </div>
          </dl>
          {detail.recordedByUsername !== null && (
            <p className="mt-1 text-xs text-[color:var(--brand-ink-subtle)]">
              {t('periodonto.imprimir.registradoPor', {
                usuario: detail.recordedByUsername,
                fecha: formatDateTime(detail.createdAt),
              })}
            </p>
          )}
        </header>

        <section className="mt-4 print:mt-2">
          <h2 className="text-sm font-semibold tracking-wide text-[color:var(--brand-primary)] uppercase">
            {t('periodonto.imprimir.kpis.titulo')}
          </h2>
          <div className="mt-2 print:mt-1">
            <KpiGrid items={kpiItems(analisis.metrics)} />
          </div>
        </section>

        <section className="mt-4 print:mt-2">
          <h2 className="text-sm font-semibold tracking-wide break-after-avoid text-[color:var(--brand-primary)] uppercase">
            {t('periodonto.imprimir.grafico.titulo')}
          </h2>
          <div className="mx-auto mt-2 max-w-[19cm] space-y-2 print:mt-1 print:space-y-1">
            {archivos.map(({ arch, teeth }) => (
              <PeriodontogramArchSvg
                key={arch}
                arch={arch}
                teeth={teeth}
                readOnly
                paper
                comparison={comparisonIndex}
                previous={previousChart}
                /* Una arcada entera —título, SVG, franja FDI y furcas— no se parte
                   entre dos páginas: la mandíbula dejaba su título huérfano al pie
                   de la página 1. */
                className="break-inside-avoid"
              />
            ))}
          </div>
          <p className="mt-1 break-before-avoid text-[8px] text-[color:var(--brand-ink-subtle)]">
            {t('periodonto.imprimir.grafico.leyenda')}
          </p>
        </section>

        <section className="mt-4 print:mt-3">
          <h2 className="text-sm font-semibold tracking-wide break-after-avoid text-[color:var(--brand-primary)] uppercase">
            {t('periodonto.imprimir.sitios.titulo')}
          </h2>
          <p className="mt-1 break-after-avoid text-[8px] text-[color:var(--brand-ink-muted)]">
            {t('periodonto.imprimir.sitios.texto')}
          </p>
          {comparison === null ? null : (
            <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[8px] break-after-avoid">
              {(['mejoro', 'empeoro', 'estable'] as const).map((change) => (
                <span key={change} className="inline-flex items-center gap-1">
                  <Dot color={changeColor(change)} />
                  {changeLabel(change)}
                </span>
              ))}
            </div>
          )}
          {/* Dos columnas: el maxilar a la izquierda y la mandíbula a la derecha.
              Cabe en una hoja y se lee como la boca, con las dos arcadas juntas. */}
          <div className="mt-2 grid grid-cols-1 gap-x-4 gap-y-2 print:grid-cols-2">
            {archivos.map(({ arch, teeth }) => (
              <SitesTable key={arch} arch={arch} teeth={teeth} comparisonIndex={comparisonIndex} />
            ))}
          </div>
          <p className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[8px] text-[color:var(--brand-ink-muted)]">
            <span className="inline-flex items-center gap-1">
              <Square color={PERIODONTAL_COLORS.bop} />
              {t('periodonto.tabla.bop')}
            </span>
            <span className="inline-flex items-center gap-1">
              <Square color={PERIODONTAL_COLORS.plaque} />
              {t('periodonto.tabla.placa')}
            </span>
            <span className="inline-flex items-center gap-1">
              <Square color={PERIODONTAL_COLORS.suppuration} />
              {t('periodonto.tabla.supuracion')}
            </span>
            <span>
              {t('periodonto.leyenda.ps')} / {t('periodonto.leyenda.mg')} ·{' '}
              {t('periodonto.leyenda.nic')}
            </span>
            <span>{t('periodonto.imprimir.furcaAbrev')}</span>
          </p>
        </section>

        <div className="mt-4 grid grid-cols-2 gap-4">
          <section>
            <h2 className="text-sm font-semibold tracking-wide text-[color:var(--brand-primary)] uppercase">
              {t('periodonto.imprimir.diagnostico.titulo')}
            </h2>
            {diagnosis === null ? (
              <p className="mt-1 text-sm text-[color:var(--brand-ink-muted)]">
                {t('periodonto.diagnostico.sinClasificar')}
              </p>
            ) : (
              <div className="mt-1 text-sm">
                <p className="font-medium">
                  {stageLabel(diagnosis.stage)} · {gradeLabel(diagnosis.grade)}
                </p>
                {diagnosis.notes !== null && (
                  <p className="mt-1 text-xs text-[color:var(--brand-ink-muted)]">
                    {diagnosis.notes}
                  </p>
                )}
              </div>
            )}
            <p className="mt-2 text-[8px] text-[color:var(--brand-ink-subtle)]">
              {t('periodonto.imprimir.sugerencia', {
                sugerencia: suggestionText(analisis.suggestion),
              })}
            </p>
          </section>
          <section>
            <h2 className="text-sm font-semibold tracking-wide text-[color:var(--brand-primary)] uppercase">
              {t('periodonto.imprimir.riesgo.titulo')}
            </h2>
            <p className="mt-1 text-sm">{riskFactorsText(detail.riskFactors)}</p>
            {detail.riskFactors.hba1c !== null && (
              <p className="text-xs text-[color:var(--brand-ink-muted)]">
                {t('periodonto.riesgo.hba1cValor', {
                  valor: formatDecimal(detail.riskFactors.hba1c),
                })}
              </p>
            )}
            {detail.notes !== null && (
              <p className="mt-2 text-xs text-[color:var(--brand-ink-muted)]">
                {t('periodonto.imprimir.notas', { notas: detail.notes })}
              </p>
            )}
            {detail.sessionId !== null && (
              <p className="mt-1 text-[8px] text-[color:var(--brand-ink-subtle)]">
                {t('periodonto.imprimir.sesion')}
              </p>
            )}
          </section>
        </div>

        <section className="mt-4">
          <h2 className="text-sm font-semibold tracking-wide text-[color:var(--brand-primary)] uppercase">
            {t('periodonto.imprimir.leyenda.titulo')}
          </h2>
          <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[9px] text-[color:var(--brand-ink-muted)]">
            <li className="inline-flex items-center gap-1.5">
              <Dot color={PERIODONTAL_COLORS.pd} />
              {t('periodonto.leyenda.ps')}
            </li>
            <li className="inline-flex items-center gap-1.5">
              <Dot color={PERIODONTAL_COLORS.mg} />
              {t('periodonto.leyenda.mg')}
            </li>
            <li className="inline-flex items-center gap-1.5">
              <Square color={PERIODONTAL_COLORS.nic} />
              {t('periodonto.leyenda.nic')}
            </li>
            <li className="inline-flex items-center gap-1.5">
              <Dot color={PERIODONTAL_COLORS.bop} />
              {t('periodonto.leyenda.bop')}
            </li>
            <li className="inline-flex items-center gap-1.5">
              <Square color={PERIODONTAL_COLORS.plaque} />
              {t('periodonto.leyenda.placa')}
            </li>
            <li className="inline-flex items-center gap-1.5">
              <Square color={PERIODONTAL_COLORS.suppuration} />
              {t('periodonto.leyenda.supuracion')}
            </li>
            <li>{t('periodonto.leyenda.furca')}</li>
            <li>{t('periodonto.leyenda.movilidad')}</li>
            <li>{t('periodonto.leyenda.comparacion')}</li>
          </ul>
          <p className="mt-2 text-[8px] text-[color:var(--brand-ink-subtle)]">
            {t('periodonto.leyenda.sinDato')}
          </p>
        </section>

        <footer className="mt-6 border-t border-[color:var(--brand-line)] pt-2 text-xs text-[color:var(--brand-ink-subtle)]">
          <p>
            {t('periodonto.imprimir.pie')} ·{' '}
            {t('periodonto.imprimir.impreso', {
              fecha: formatDateTime(detail.lastPrintedAt ?? detail.updatedAt),
              usuario: detail.recordedByUsername ?? t('comun.sinDato'),
            })}
            {detail.printCount > 0
              ? ` · ${t('periodonto.imprimir.veces', { veces: detail.printCount })}`
              : ''}
          </p>
          {/* La anatomía de la boca, por si el papel se separa del expediente. */}
          <p className="mt-1 text-[8px]">
            {t('periodonto.imprimir.orientacion', {
              maxilar: archName('maxilar'),
              mandibula: archName('mandibula'),
            })}
          </p>
        </footer>

        {comparison !== null && (
          <EvolutionSection
            comparison={comparison}
            previousExamDate={previousExamDate}
            currentExamDate={detail.examDate}
          />
        )}
      </div>
    </article>
  );
};
