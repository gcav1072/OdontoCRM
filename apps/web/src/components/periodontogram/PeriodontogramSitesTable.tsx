import { memo } from 'react';

import {
  PERIODONTAL_SITE_INDEXES,
  furcationEntrancesFor,
  type PeriodontalArch,
  type PeriodontalSide,
  type PeriodontalSiteDiff,
  type PeriodontalSiteIndex,
  type PeriodontalTooth,
} from '@odontocrm/contracts';

import { t } from '../../lib/i18n';
import { changeColor, comparisonSiteOf } from './geometry';
import {
  calText,
  furcationEntranceLabel,
  furcationGradeText,
  mobilityLabel,
  sideName,
  siteAriaLabel,
  siteFieldText,
  siteShortName,
} from './presentation';

/**
 * Tabla numérica de sitios: la lectura «de rejilla» del periodontograma, para el
 * ratón y para revisar cifras de un vistazo.
 *
 * Cada celda es un `<button type="button">` (nunca un `<input>`): al tocarla se
 * selecciona ese sitio en el pad, igual que en el SVG. La tabla enseña PS, MG y el
 * NIC derivado, y los flags de BOP/placa/supuración como letras además de color.
 * Las piezas ausentes se ven como una sola fila y los implantes con su insignia: la
 * tabla tiene que contar la misma boca que el gráfico.
 */

export interface PeriodontogramSitesTableProps {
  arch: PeriodontalArch;
  teeth: readonly PeriodontalTooth[];
  readOnly?: boolean;
  active?: { fdi: number; side: PeriodontalSide; siteIndex: PeriodontalSiteIndex } | null;
  comparison?: ReadonlyMap<string, PeriodontalSiteDiff> | null;
  onSelectSite?: (fdi: number, side: PeriodontalSide, siteIndex: PeriodontalSiteIndex) => void;
}

/** Marcas de los flags del sitio: letra clínica + color (nunca solo color). */
const SiteFlags = ({
  bop,
  plaque,
  suppuration,
}: {
  bop: boolean;
  plaque: boolean;
  suppuration: boolean;
}) => (
  <span className="flex flex-wrap gap-0.5">
    {bop && (
      <span
        className="inline-flex size-4 items-center justify-center rounded-xs bg-danger/15 text-[0.6rem] font-bold text-danger"
        title={t('periodonto.tabla.bop')}
        aria-label={t('periodonto.tabla.bop')}
      >
        {t('periodonto.tabla.corta.bop')}
      </span>
    )}
    {plaque && (
      <span
        className="inline-flex size-4 items-center justify-center rounded-xs bg-primary/15 text-[0.6rem] font-bold text-primary"
        title={t('periodonto.tabla.placa')}
        aria-label={t('periodonto.tabla.placa')}
      >
        {t('periodonto.tabla.corta.placa')}
      </span>
    )}
    {suppuration && (
      <span
        className="inline-flex size-4 items-center justify-center rounded-xs bg-warning/20 text-[0.6rem] font-bold text-warning"
        title={t('periodonto.tabla.supuracion')}
        aria-label={t('periodonto.tabla.supuracion')}
      >
        {t('periodonto.tabla.corta.supuracion')}
      </span>
    )}
  </span>
);

/** Una celda de sitio: etiqueta anatómica, PS, MG, NIC y marcas. */
const SiteCell = ({
  tooth,
  side,
  index,
  readOnly,
  active,
  change,
  onSelectSite,
}: {
  tooth: PeriodontalTooth;
  side: PeriodontalSide;
  index: PeriodontalSiteIndex;
  readOnly: boolean;
  active: PeriodontogramSitesTableProps['active'];
  change: PeriodontalSiteDiff | null;
  onSelectSite: PeriodontogramSitesTableProps['onSelectSite'];
}) => {
  const sites = side === 'vestibular' ? tooth.vestibular : tooth.lingual;
  const site = sites[index];
  const selected =
    active !== null &&
    active !== undefined &&
    active.fdi === tooth.fdi &&
    active.side === side &&
    active.siteIndex === index;
  const etiqueta = siteAriaLabel(tooth.fdi, side, index);

  const contenido = (
    <>
      <span className="block text-[0.62rem] font-semibold tracking-wide text-ink-subtle uppercase">
        {siteShortName(tooth.fdi, side, index)}
      </span>
      <span className="mt-0.5 flex items-baseline justify-center gap-1 font-mono text-sm leading-none text-ink">
        <span>{siteFieldText(site, 'pd')}</span>
        <span className="text-ink-subtle">/</span>
        <span>{siteFieldText(site, 'gm')}</span>
      </span>
      <span className="mt-0.5 block text-[0.62rem] text-ink-muted">
        {t('periodonto.tabla.nic', { valor: calText(site) })}
      </span>
      {change !== null && change.deltaPd !== null && (
        <span
          className="mt-0.5 block text-[0.62rem] font-semibold"
          style={{ color: changeColor(change.change) }}
        >
          {t('periodonto.tabla.delta', {
            valor: change.deltaPd > 0 ? `+${String(change.deltaPd)}` : String(change.deltaPd),
          })}
        </span>
      )}
      <span className="mt-0.5 flex justify-center">
        <SiteFlags bop={site.bop} plaque={site.plaque} suppuration={site.suppuration} />
      </span>
    </>
  );

  if (readOnly) {
    return (
      <td
        className="border border-border px-1 py-1.5 align-top"
        title={etiqueta}
        aria-label={etiqueta}
      >
        {contenido}
      </td>
    );
  }

  return (
    <td className="border border-border p-0 align-top">
      <button
        type="button"
        onClick={() => onSelectSite?.(tooth.fdi, side, index)}
        aria-label={t('periodonto.tabla.sitioAria', {
          detalle: etiqueta,
          ps: siteFieldText(site, 'pd'),
          mg: siteFieldText(site, 'gm'),
        })}
        aria-pressed={selected}
        className={`block min-h-14 w-full min-w-14 touch-manipulation px-1 py-1.5 text-center transition-colors hover:bg-surface-muted focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-solid focus-visible:outline-focus ${
          selected ? 'bg-primary/10 ring-2 ring-primary ring-inset' : ''
        }`}
      >
        {contenido}
      </button>
    </td>
  );
};

/** Encabezado de la tabla: la columna de sitio se nombra por posición visual. */
const TableHead = () => (
  <thead>
    <tr className="bg-surface-muted text-[0.65rem] tracking-wide text-ink-muted uppercase">
      <th scope="col" className="border border-border px-2 py-1.5 text-left">
        {t('periodonto.tabla.pieza')}
      </th>
      <th scope="col" className="border border-border px-2 py-1.5 text-left">
        {t('periodonto.tabla.cara')}
      </th>
      <th scope="col" className="border border-border px-1 py-1.5">
        {t('periodonto.tabla.sitioIzquierdo')}
      </th>
      <th scope="col" className="border border-border px-1 py-1.5">
        {t('periodonto.tabla.sitioCentral')}
      </th>
      <th scope="col" className="border border-border px-1 py-1.5">
        {t('periodonto.tabla.sitioDerecho')}
      </th>
      <th scope="col" className="border border-border px-2 py-1.5 text-left">
        {t('periodonto.tabla.movilidad')}
      </th>
      <th scope="col" className="border border-border px-2 py-1.5 text-left">
        {t('periodonto.tabla.furca')}
      </th>
    </tr>
  </thead>
);

/** Resumen de una pieza (rowSpan de sus dos caras): estado, movilidad y furcas. */
const ToothSummaryCell = ({ tooth }: { tooth: PeriodontalTooth }) => {
  const estado = tooth.missing
    ? t('periodonto.pieza.ausente')
    : tooth.implant
      ? t('periodonto.pieza.implante')
      : null;
  const furcas = tooth.missing || tooth.implant ? [] : furcationEntrancesFor(tooth.fdi);
  return (
    <th
      scope="rowgroup"
      className="border border-border bg-surface px-2 py-1.5 text-left align-top"
      rowSpan={tooth.missing ? 1 : 2}
    >
      <span className="block font-mono text-sm font-semibold text-ink">{tooth.fdi}</span>
      {estado !== null && (
        <span className="mt-0.5 block text-[0.62rem] font-medium text-ink-muted">{estado}</span>
      )}
      {!tooth.missing && (
        <span className="mt-0.5 block text-[0.62rem] text-ink-muted">
          {tooth.implant ? '' : mobilityLabel(tooth.mobility)}
        </span>
      )}
      {furcas.length > 0 && (
        <span className="mt-0.5 flex flex-wrap gap-x-1 text-[0.6rem] text-ink-subtle">
          {furcas.map((entrance) => {
            const grado = tooth.furcation[entrance];
            return (
              <span key={entrance}>
                {t('periodonto.tabla.furcaCorta', {
                  entrada: furcationEntranceLabel(entrance),
                  grado:
                    grado === undefined
                      ? t('periodonto.tabla.sinLesion')
                      : furcationGradeText(grado),
                })}
              </span>
            );
          })}
        </span>
      )}
    </th>
  );
};

const SIDE_ORDER: readonly PeriodontalSide[] = ['vestibular', 'lingual'];

const PeriodontogramSitesTableBase = ({
  arch,
  teeth,
  readOnly = false,
  active = null,
  comparison = null,
  onSelectSite,
}: PeriodontogramSitesTableProps) => {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[52rem] border-collapse text-center">
        <caption className="sr-only">
          {t('periodonto.tabla.caption', {
            arcada:
              arch === 'maxilar'
                ? t('periodonto.arcada.maxilar')
                : t('periodonto.arcada.mandibula'),
          })}
        </caption>
        <TableHead />
        <tbody>
          {teeth.map((tooth) => {
            if (tooth.missing) {
              return (
                <tr key={tooth.fdi}>
                  <ToothSummaryCell tooth={tooth} />
                  <td
                    className="border border-border px-2 py-1.5 text-left text-xs text-ink-muted"
                    colSpan={6}
                  >
                    {t('periodonto.tabla.piezaSinSitios', { pieza: tooth.fdi })}
                  </td>
                </tr>
              );
            }
            return SIDE_ORDER.map((side, position) => {
              return (
                <tr
                  key={`${String(tooth.fdi)}-${side}`}
                  className={position === 0 ? 'border-t-2 border-border-strong' : ''}
                >
                  {position === 0 && <ToothSummaryCell tooth={tooth} />}
                  <td className="border border-border px-2 py-1.5 text-left text-[0.7rem] whitespace-nowrap text-ink-muted">
                    {sideName(tooth.fdi, side)}
                  </td>
                  {PERIODONTAL_SITE_INDEXES.map((index) => {
                    const change =
                      comparison === null
                        ? null
                        : comparisonSiteOf(comparison, tooth.fdi, side, index);
                    return (
                      <SiteCell
                        key={`${String(index)}`}
                        tooth={tooth}
                        side={side}
                        index={index}
                        readOnly={readOnly}
                        active={active}
                        change={change}
                        onSelectSite={onSelectSite}
                      />
                    );
                  })}
                  {position === 0 ? (
                    <>
                      <td
                        className="border border-border px-2 py-1.5 text-xs text-ink-muted"
                        rowSpan={2}
                      >
                        {tooth.implant ? '' : mobilityLabel(tooth.mobility)}
                      </td>
                      <td
                        className="border border-border px-2 py-1.5 text-left text-[0.65rem] text-ink-subtle"
                        rowSpan={2}
                      >
                        {tooth.implant
                          ? ''
                          : furcationEntrancesFor(tooth.fdi).map((entrance) => {
                              const grado = tooth.furcation[entrance];
                              return (
                                <span key={entrance} className="block">
                                  {furcationEntranceLabel(entrance)}:{' '}
                                  {grado === undefined
                                    ? t('periodonto.tabla.sinLesion')
                                    : furcationGradeText(grado)}
                                </span>
                              );
                            })}
                      </td>
                    </>
                  ) : null}
                </tr>
              );
            });
          })}
        </tbody>
      </table>
      <p className="mt-1 text-[0.68rem] text-ink-subtle">
        {t('periodonto.tabla.leyenda', {
          ps: t('periodonto.leyenda.ps'),
          mg: t('periodonto.leyenda.mg'),
          nic: t('periodonto.leyenda.nic'),
        })}
      </p>
      <ul className="mt-1 flex flex-wrap gap-x-3 text-[0.68rem] text-ink-subtle">
        <li>{t('periodonto.leyenda.bop')}</li>
        <li>{t('periodonto.leyenda.placa')}</li>
        <li>{t('periodonto.leyenda.supuracion')}</li>
      </ul>
      {/* La comparación, si la hay, pinta el delta en la celda con el color del
          cambio; la tabla lo explica para que el color no sea la única pista. */}
      {comparison !== null && comparison !== undefined && (
        <p className="mt-1 text-[0.68rem] text-ink-subtle">
          {t('periodonto.tabla.leyendaComparacion')}
        </p>
      )}
      {teeth.some((tooth) => tooth.notes !== null) && (
        <ul className="mt-2 space-y-0.5 text-[0.68rem] text-ink-muted">
          {teeth
            .filter((tooth) => tooth.notes !== null)
            .map((tooth) => (
              <li key={tooth.fdi}>
                <span className="font-semibold">{tooth.fdi}:</span> {tooth.notes}
              </li>
            ))}
        </ul>
      )}
    </div>
  );
};

/**
 * La tabla se memoiza: son 192 botones. Solo se repinta cuando cambia la boca, el
 * sitio activo, la comparación o los manejadores (que el panel mantiene estables).
 */
export const PeriodontogramSitesTable = memo(PeriodontogramSitesTableBase);
