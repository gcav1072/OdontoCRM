import {
  CLINICAL_STATE_COLORS,
  CLINICAL_STATE_LABELS,
  CONDITION_LABELS,
  hasPrimaryFindings,
  surfaceLabelFor,
  supersedesSurfaces,
} from '@odontocrm/contracts';
import type {
  OdontogramDetail,
  ToothFindingHistoryEntry,
  ToothFindingRecord,
} from '@odontocrm/contracts';

import { formatDate, formatDateTime } from '../../lib/format';
import { historyEventLabel } from './OdontogramHistory';
import { t } from '../../lib/i18n';
import { dentitionLabel } from '../../lib/odontogram-api';
import { OdontogramStaticChart } from '../odontogram/OdontogramStaticChart';
import { MarcaDeAgua } from '../print/MarcaDeAgua';
import { MembreteDocumento } from '../print/MembreteDocumento';

/**
 * Documento imprimible del odontograma (A4).
 *
 * La secretaría **imprime el odontograma** (decisión 23), así que el documento se
 * lee sin ninguna interacción y sin depender de permisos de escritura: solo pinta
 * el estado de la boca y deja el pie con la constancia de impresión.
 *
 * Los colores de **énfasis** del documento (títulos, encabezados y líneas) salen de
 * la **marca** (`packages/contracts/src/brand.ts`), los mismos del récipe y el reporte
 * del servidor. Los colores **clínicos** del odontograma —rojo `pendiente` y azul
 * `completado` (`CLINICAL_STATE_COLORS`)— **no**: son un código del dominio que el
 * odontólogo lee y no cambian con la paleta.
 */

/** Todos los hallazgos vigentes, ordenados por pieza y cara. */
const orderedFindings = (detail: OdontogramDetail): ToothFindingRecord[] =>
  Object.values(detail.findings)
    .flat()
    .sort((a, b) => {
      if (a.toothNumber !== b.toothNumber) return a.toothNumber - b.toothNumber;
      const caraA = a.surface ?? '';
      const caraB = b.surface ?? '';
      return caraA.localeCompare(caraB);
    });

/** Piezas distintas con al menos un hallazgo (lo que no está aquí está sano). */
const affectedTeeth = (detail: OdontogramDetail): number[] =>
  [
    ...new Set(
      Object.values(detail.findings)
        .flat()
        .map((finding) => finding.toothNumber),
    ),
  ].sort((a, b) => a - b);

const FindingsTable = ({ detail }: { detail: OdontogramDetail }) => {
  const hallazgos = orderedFindings(detail);
  if (hallazgos.length === 0) {
    return (
      <p className="text-sm text-[color:var(--brand-ink-muted)]">{t('odonto.hallazgos.ninguno')}</p>
    );
  }

  return (
    <table className="w-full border-collapse text-sm">
      <thead>
        <tr className="border-b border-[color:var(--brand-line)] text-left text-xs tracking-wide text-[color:var(--brand-primary)] uppercase">
          <th className="py-1.5 pr-3">{t('odonto.hallazgos.pieza')}</th>
          <th className="py-1.5 pr-3">{t('odonto.hallazgos.cara')}</th>
          <th className="py-1.5 pr-3">{t('odonto.hallazgos.condicion')}</th>
          <th className="py-1.5 pr-3">{t('odonto.hallazgos.estado')}</th>
          <th className="py-1.5">{t('odonto.hallazgos.notas')}</th>
        </tr>
      </thead>
      <tbody>
        {hallazgos.map((hallazgo) => (
          <tr
            key={hallazgo.id}
            className="border-b border-[color:var(--brand-line-soft)] align-top"
          >
            <td className="py-1.5 pr-3 font-medium text-[color:var(--brand-ink)]">
              {hallazgo.toothNumber}
            </td>
            <td className="py-1.5 pr-3 text-[color:var(--brand-ink-muted)]">
              {hallazgo.surface === null
                ? t('odonto.hallazgos.piezaCompleta')
                : surfaceLabelFor(hallazgo.toothNumber, hallazgo.surface)}
            </td>
            <td className="py-1.5 pr-3 text-[color:var(--brand-ink-muted)]">
              {CONDITION_LABELS[hallazgo.condition]}
            </td>
            <td className="py-1.5 pr-3">
              <span
                className="inline-flex items-center gap-1.5"
                style={{
                  color:
                    hallazgo.state === 'pendiente'
                      ? CLINICAL_STATE_COLORS.pendiente
                      : CLINICAL_STATE_COLORS.completado,
                }}
              >
                <span
                  className="inline-block size-2.5 rounded-full"
                  style={{
                    backgroundColor:
                      hallazgo.state === 'pendiente'
                        ? CLINICAL_STATE_COLORS.pendiente
                        : CLINICAL_STATE_COLORS.completado,
                  }}
                  aria-hidden
                />
                {CLINICAL_STATE_LABELS[hallazgo.state]}
              </span>
            </td>
            {/*
              Una celda vacía se lee como un olvido de captura —y en un informe que
              puede acabar en manos de una aseguradora, como una omisión—: se escribe
              «Sin observaciones» para que se vea que **se miró** y no había nada.
            */}
            <td className="py-1.5 text-[color:var(--brand-ink-subtle)]">
              {hallazgo.notes === null || hallazgo.notes.trim() === ''
                ? t('odonto.hallazgos.sinNotas')
                : hallazgo.notes}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
};

export interface OdontogramDocumentProps {
  detail: OdontogramDetail;
  /**
   * Histórico de cambios, si el informe se pide **con** historial (la casilla de la
   * vista de impresión). Se pinta en orden **cronológico** —lo que pasó primero
   * arriba—, que es como se lee una evolución. `null` o vacío: el informe sale sin
   * esa sección, que es el caso normal.
   */
  history?: readonly ToothFindingHistoryEntry[] | null;
  /**
   * Tope con el que se pidió el histórico: si se alcanzó, el informe lo dice. Un
   * historial recortado en silencio se lee como si no hubiera más.
   */
  historyLimit?: number;
}

export const OdontogramDocument = ({
  detail,
  history = null,
  historyLimit,
}: OdontogramDocumentProps) => {
  const piezas = affectedTeeth(detail);
  const pendientes = Object.values(detail.findings)
    .flat()
    .filter((hallazgo) => hallazgo.state === 'pendiente').length;
  const completadas = Object.values(detail.findings)
    .flat()
    .filter((hallazgo) => hallazgo.state === 'completado').length;
  const paciente = detail.patient;

  /** Condiciones de pieza completa que **cubren** las caras: se explican en el pie. */
  const condicionesQueCubren = new Set(
    Object.values(detail.findings)
      .flat()
      .filter((hallazgo) => supersedesSurfaces(hallazgo.condition))
      .map((hallazgo) => hallazgo.condition),
  );

  // El histórico se pide del más nuevo al más viejo (para la pantalla); en el papel se
  // lee al revés, como una historia clínica: lo primero que pasó, primero.
  const historial =
    history === undefined || history === null
      ? null
      : [...history].sort(
          (a, b) => new Date(a.occurredAt).getTime() - new Date(b.occurredAt).getTime(),
        );

  return (
    <article className="relative mx-auto max-w-[21cm] bg-white px-8 py-6 text-[color:var(--brand-ink)] print:px-0 print:py-0">
      <MarcaDeAgua />
      {/* Todo lo que va sobre el velo de la marca de agua queda por encima (`z-[1]`). */}
      <div className="relative z-[1]">
        <MembreteDocumento title={t('odonto.imprimir.documento')} />
        <header className="mt-3 border-b-2 pb-3" style={{ borderColor: 'var(--brand-ink)' }}>
          <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm sm:grid-cols-4">
            <div>
              <dt className="text-xs tracking-wide text-[color:var(--brand-ink-subtle)] uppercase">
                Paciente
              </dt>
              <dd className="font-medium">
                {paciente?.fullName ?? t('odonto.paciente.desconocido')}
              </dd>
            </div>
            <div>
              <dt className="text-xs tracking-wide text-[color:var(--brand-ink-subtle)] uppercase">
                Documento
              </dt>
              <dd>{paciente?.document ?? t('comun.sinDato')}</dd>
            </div>
            <div>
              <dt className="text-xs tracking-wide text-[color:var(--brand-ink-subtle)] uppercase">
                Edad
              </dt>
              <dd>{paciente === null ? t('comun.sinDato') : `${String(paciente.age)} años`}</dd>
            </div>
            <div>
              <dt className="text-xs tracking-wide text-[color:var(--brand-ink-subtle)] uppercase">
                {dentitionLabel(detail.dentition)}
              </dt>
              <dd>{formatDate(detail.updatedAt)}</dd>
            </div>
          </dl>
        </header>

        <section className="mt-5">
          <OdontogramStaticChart
            detail={detail}
            dentition={detail.dentition}
            showPrimary={hasPrimaryFindings(detail.findings)}
          />
        </section>

        <section className="mt-5">
          <h2 className="text-sm font-semibold tracking-wide text-[color:var(--brand-primary)] uppercase">
            {t('odonto.hallazgos.titulo')}
          </h2>
          <p className="mt-1 text-xs text-[color:var(--brand-ink-muted)]">
            {t('odonto.afectadas', { total: piezas.length })} ·{' '}
            {t('odonto.pendientes', { total: pendientes })} ·{' '}
            {t('odonto.completadas', { total: completadas })}
          </p>
          <div className="mt-3">
            <FindingsTable detail={detail} />
          </div>
        </section>

        {/*
        Historial de cambios (opcional): la evolución del odontograma con sus fechas,
        para el informe que se archiva o se entrega. Sale **en orden cronológico** y
        con quién hizo cada cambio, porque es lo que da valor probatorio al papel.
      */}
        {historial !== null && historial.length > 0 && (
          <section className="mt-6">
            <h2 className="text-sm font-semibold tracking-wide break-after-avoid text-[color:var(--brand-primary)] uppercase">
              {t('odonto.imprimir.historial.titulo')}
            </h2>
            <p className="mt-1 text-xs text-[color:var(--brand-ink-muted)] break-after-avoid">
              {t('odonto.imprimir.historial.rango', {
                desde: formatDate(historial[0]?.occurredAt ?? detail.updatedAt),
                hasta: formatDate(historial[historial.length - 1]?.occurredAt ?? detail.updatedAt),
                total: historial.length,
              })}
              {historyLimit !== undefined && historial.length >= historyLimit
                ? ` · ${t('odonto.imprimir.historial.recortado', { tope: historyLimit })}`
                : ''}
            </p>
            <table className="mt-3 w-full border-collapse text-xs">
              <thead>
                <tr className="border-b border-[color:var(--brand-line)] text-left tracking-wide text-[color:var(--brand-primary)] uppercase">
                  <th className="py-1 pr-2">{t('odonto.imprimir.historial.fecha')}</th>
                  <th className="py-1 pr-2">{t('odonto.hallazgos.pieza')}</th>
                  <th className="py-1 pr-2">{t('odonto.hallazgos.cara')}</th>
                  <th className="py-1 pr-2">{t('odonto.hallazgos.condicion')}</th>
                  <th className="py-1 pr-2">{t('odonto.hallazgos.estado')}</th>
                  <th className="py-1 pr-2">{t('odonto.imprimir.historial.cambio')}</th>
                  <th className="py-1">{t('odonto.imprimir.historial.quien')}</th>
                </tr>
              </thead>
              <tbody>
                {historial.map((entrada) => (
                  <tr
                    key={entrada.id}
                    className="break-inside-avoid border-b border-[color:var(--brand-line-soft)]"
                  >
                    <td className="py-1 pr-2 whitespace-nowrap text-[color:var(--brand-ink-muted)]">
                      {formatDateTime(entrada.occurredAt)}
                    </td>
                    <td className="py-1 pr-2 font-medium text-[color:var(--brand-ink)]">
                      {entrada.toothNumber}
                    </td>
                    <td className="py-1 pr-2 text-[color:var(--brand-ink-muted)]">
                      {entrada.surface === null
                        ? t('odonto.hallazgos.piezaCompleta')
                        : surfaceLabelFor(entrada.toothNumber, entrada.surface)}
                    </td>
                    <td className="py-1 pr-2 text-[color:var(--brand-ink-muted)]">
                      {CONDITION_LABELS[entrada.condition]}
                    </td>
                    <td className="py-1 pr-2">
                      <span
                        className="inline-flex items-center gap-1"
                        style={{ color: CLINICAL_STATE_COLORS[entrada.state] }}
                      >
                        <span
                          className="inline-block size-2 rounded-full"
                          style={{ backgroundColor: CLINICAL_STATE_COLORS[entrada.state] }}
                          aria-hidden
                        />
                        {CLINICAL_STATE_LABELS[entrada.state]}
                      </span>
                    </td>
                    <td className="py-1 pr-2 text-[color:var(--brand-ink-muted)]">
                      {historyEventLabel(entrada.event)}
                    </td>
                    <td className="py-1 text-[color:var(--brand-ink-muted)]">
                      {entrada.actorUsername ?? t('comun.sinDato')}
                      {entrada.reason !== null ? ` · ${entrada.reason}` : ''}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        )}

        <footer className="mt-8 border-t border-[color:var(--brand-line)] pt-2 text-xs text-[color:var(--brand-ink-subtle)]">
          <p>
            {t('odonto.imprimir.pie')} ·{' '}
            {t('odonto.imprimir.impreso', {
              fecha: formatDateTime(detail.lastPrintedAt ?? detail.updatedAt),
              usuario: detail.recordedByUsername ?? t('comun.sinDato'),
            })}
            {detail.printCount > 0
              ? ` · ${t('odonto.imprimir.veces', { veces: detail.printCount })}`
              : ''}
          </p>
          {/*
          Qué manda sobre qué, en el papel (ADR 0032): `ausente` deja las caras sin
          efecto y la **corona las recubre** (en boca ya no se ven, aunque el dato siga
          en la historia); el conducto, el implante y la extracción indicada conviven
          con ellas. Cada nota sale sola cuando hay una pieza en esa situación.
        */}
          {condicionesQueCubren.has('ausente') && (
            <p className="mt-1">{t('odonto.imprimir.notaAusente')}</p>
          )}
          {condicionesQueCubren.has('corona') && (
            <p className="mt-1">{t('odonto.imprimir.notaCorona')}</p>
          )}
        </footer>
      </div>
    </article>
  );
};
