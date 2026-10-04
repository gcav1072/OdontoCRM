import {
  CLINICAL_STATE_COLORS,
  CLINICAL_STATE_LABELS,
  CONDITION_LABELS,
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
import { OdontogramStaticChart } from '../odontogram/OdontogramStaticChart';

/**
 * Documento imprimible del odontograma (A4).
 *
 * La secretaría **imprime el odontograma** (decisión 23), así que el documento se
 * lee sin ninguna interacción y sin depender de permisos de escritura: solo pinta
 * el estado de la boca y deja el pie con la constancia de impresión.
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
    return <p className="text-sm text-ink-muted">{t('odonto.hallazgos.ninguno')}</p>;
  }

  return (
    <table className="w-full border-collapse text-sm">
      <thead>
        <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-ink-subtle">
          <th className="py-1.5 pr-3">{t('odonto.hallazgos.pieza')}</th>
          <th className="py-1.5 pr-3">{t('odonto.hallazgos.cara')}</th>
          <th className="py-1.5 pr-3">{t('odonto.hallazgos.condicion')}</th>
          <th className="py-1.5 pr-3">{t('odonto.hallazgos.estado')}</th>
          <th className="py-1.5">{t('odonto.hallazgos.notas')}</th>
        </tr>
      </thead>
      <tbody>
        {hallazgos.map((hallazgo) => (
          <tr key={hallazgo.id} className="border-b border-border/60 align-top">
            <td className="py-1.5 pr-3 font-medium text-ink">{hallazgo.toothNumber}</td>
            <td className="py-1.5 pr-3 text-ink-muted">
              {hallazgo.surface === null
                ? t('odonto.hallazgos.piezaCompleta')
                : surfaceLabelFor(hallazgo.toothNumber, hallazgo.surface)}
            </td>
            <td className="py-1.5 pr-3 text-ink-muted">{CONDITION_LABELS[hallazgo.condition]}</td>
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
            <td className="py-1.5 text-ink-subtle">
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
  /** Membrete: genérico hasta que el configurable llegue en la Fase 7. */
  clinicName?: string;
  /**
   * Histórico de cambios, si el informe se pide **con** historial (la casilla de la
   * vista de impresión). Se pinta en orden **cronológico** —lo que pasó primero
   * arriba—, que es como se lee una evolución. 
ull o vacío: el informe sale sin
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
  clinicName = t('app.nombre'),
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
    <article className="mx-auto max-w-[21cm] bg-white px-8 py-6 text-ink print:px-0 print:py-0">
      <header className="border-b-2 border-ink pb-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h1 className="text-lg font-semibold">{clinicName}</h1>
          <p className="text-sm font-medium uppercase tracking-wide">
            {t('odonto.imprimir.documento')}
          </p>
        </div>
        <dl className="mt-2 grid grid-cols-2 gap-x-6 gap-y-1 text-sm sm:grid-cols-4">
          <div>
            <dt className="text-xs uppercase tracking-wide text-ink-subtle">Paciente</dt>
            <dd className="font-medium">
              {paciente?.fullName ?? t('odonto.paciente.desconocido')}
            </dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-ink-subtle">Documento</dt>
            <dd>{paciente?.document ?? t('comun.sinDato')}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-ink-subtle">Edad</dt>
            <dd>{paciente === null ? t('comun.sinDato') : `${String(paciente.age)} años`}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-ink-subtle">
              {detail.dentition === 'temporal' ? 'Dentición temporal' : 'Dentición permanente'}
            </dt>
            <dd>{formatDate(detail.updatedAt)}</dd>
          </div>
        </dl>
      </header>

      <section className="mt-5">
        <OdontogramStaticChart detail={detail} dentition={detail.dentition} />
      </section>

      <section className="mt-5">
        <h2 className="text-sm font-semibold uppercase tracking-wide">
          {t('odonto.hallazgos.titulo')}
        </h2>
        <p className="mt-1 text-xs text-ink-muted">
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
          <h2 className="text-sm font-semibold uppercase tracking-wide break-after-avoid">
            {t('odonto.imprimir.historial.titulo')}
          </h2>
          <p className="mt-1 text-xs text-ink-muted break-after-avoid">
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
              <tr className="border-b border-border text-left uppercase tracking-wide text-ink-subtle">
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
                <tr key={entrada.id} className="break-inside-avoid border-b border-border/60">
                  <td className="py-1 pr-2 whitespace-nowrap text-ink-muted">
                    {formatDateTime(entrada.occurredAt)}
                  </td>
                  <td className="py-1 pr-2 font-medium text-ink">{entrada.toothNumber}</td>
                  <td className="py-1 pr-2 text-ink-muted">
                    {entrada.surface === null
                      ? t('odonto.hallazgos.piezaCompleta')
                      : surfaceLabelFor(entrada.toothNumber, entrada.surface)}
                  </td>
                  <td className="py-1 pr-2 text-ink-muted">
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
                  <td className="py-1 pr-2 text-ink-muted">{historyEventLabel(entrada.event)}</td>
                  <td className="py-1 text-ink-muted">
                    {entrada.actorUsername ?? t('comun.sinDato')}
                    {entrada.reason !== null ? ` · ${entrada.reason}` : ''}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      <footer className="mt-8 border-t border-border pt-2 text-xs text-ink-subtle">
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
    </article>
  );
};
