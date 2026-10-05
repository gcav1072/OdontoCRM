import type { ClinicalSessionDetail } from '@odontocrm/contracts';
import { Alert, Badge, Button, Dialog } from '@odontocrm/ui';
import { Printer } from 'lucide-react';
import type { ReactNode } from 'react';

import {
  SESSION_VITAL_FIELDS,
  sessionMaterialLine,
  sessionProcedureLine,
  sessionStatusLabel,
} from '../../lib/clinical-session';
import { formatDate, formatDateTime } from '../../lib/format';
import { t } from '../../lib/i18n';

/**
 * **Lectura de una sesión clínica cerrada**, tal como se ve desde la ficha del
 * paciente.
 *
 * Una sesión cerrada es un **documento inmutable** ([ADR 0034]): no se edita, se lee
 * —y si hay que corregirla, se abre una sesión *enmendada* con su motivo, que es lo
 * que se avisa aquí—. Por eso esta vista no tiene campos: solo muestra lo que se
 * registró aquel día, con quién lo firmó y cuándo.
 *
 * Es un componente **puro** (recibe la sesión ya cargada y no pide nada), para poder
 * probarlo sin navegador.
 */
export interface SessionDetailViewProps {
  sesion: ClinicalSessionDetail;
  /** Notas internas: solo para quien puede escribir en la historia. */
  mostrarNotasInternas?: boolean;
  patientName?: string | null;
  onPrint?: () => void;
}

const Dato = ({ etiqueta, valor }: { etiqueta: string; valor: string }) => (
  <div>
    <dt className="text-xs font-medium tracking-wide text-ink-subtle uppercase">{etiqueta}</dt>
    <dd className="pt-0.5 text-sm text-ink">{valor}</dd>
  </div>
);

const Bloque = ({ titulo, children }: { titulo: string; children: ReactNode }) => (
  <section className="rounded-control border border-border bg-surface-muted/40 p-3.5">
    <h4 className="pb-1.5 text-sm font-semibold text-ink">{titulo}</h4>
    {children}
  </section>
);

const Parrafo = ({ valor }: { valor: string | null }) =>
  valor === null || valor.trim() === '' ? (
    <p className="text-sm text-ink-subtle">{t('clinica.lectura.sinDato')}</p>
  ) : (
    <p className="text-sm whitespace-pre-line text-ink">{valor}</p>
  );

export const SessionDetailView = ({
  sesion,
  mostrarNotasInternas = false,
  patientName = null,
  onPrint,
}: SessionDetailViewProps) => {
  const { content } = sesion;
  const vitales = SESSION_VITAL_FIELDS.map((campo) => ({
    etiqueta: t(campo.labelKey),
    valor: content.vitals[campo.name],
    unidad: campo.unit,
  })).filter((fila) => fila.valor !== null && fila.valor !== undefined);

  const examen: { etiqueta: string; valor: string | null }[] = [
    { etiqueta: t('clinica.campo.tejidosBlandos'), valor: content.exam.tejidosBlandos },
    { etiqueta: t('clinica.campo.encias'), valor: content.exam.encias },
    { etiqueta: t('clinica.campo.oclusion'), valor: content.exam.oclusion },
    { etiqueta: t('clinica.campo.higiene'), valor: content.exam.higiene },
    { etiqueta: t('clinica.campo.sondaje'), valor: content.exam.sondaje },
  ].filter((fila) => fila.valor !== null && fila.valor !== '');

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={sesion.status === 'cerrada' ? 'success' : 'warning'} dot>
          {sessionStatusLabel(sesion.status)}
        </Badge>
        <span className="text-sm text-ink-muted">
          {t('clinica.lectura.sesionNumero', { numero: String(sesion.sessionNumber) })}
        </span>
        {sesion.amendedFromId !== null && (
          <Badge variant="info">{t('clinica.lectura.enmendada')}</Badge>
        )}
        {onPrint !== undefined && (
          <Button
            variant="secondary"
            size="sm"
            className="ml-auto"
            leadingIcon={<Printer className="size-4" aria-hidden="true" />}
            onClick={onPrint}
          >
            {t('comun.imprimir')}
          </Button>
        )}
      </div>

      <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {patientName !== null && (
          <Dato etiqueta={t('clinica.lectura.paciente')} valor={patientName} />
        )}
        <Dato etiqueta={t('clinica.lectura.abierta')} valor={formatDateTime(sesion.openedAt)} />
        <Dato
          etiqueta={t('clinica.lectura.cerrada')}
          valor={
            sesion.closedAt === null
              ? t('clinica.lectura.abiertaAun')
              : formatDateTime(sesion.closedAt)
          }
        />
        <Dato
          etiqueta={t('clinica.lectura.abrio')}
          valor={sesion.openedByUsername ?? t('clinica.lectura.sinDato')}
        />
        <Dato
          etiqueta={t('clinica.lectura.cerro')}
          valor={sesion.closedByUsername ?? t('clinica.lectura.sinDato')}
        />
      </dl>

      {sesion.amendedFromId !== null && (
        <Alert variant="info" title={t('clinica.lectura.enmendada')}>
          {sesion.amendmentReason ?? t('clinica.lectura.sinDato')}
        </Alert>
      )}

      {sesion.closureNote !== null && (
        <Bloque titulo={t('clinica.lectura.notaCierre')}>
          <Parrafo valor={sesion.closureNote} />
        </Bloque>
      )}

      <Bloque titulo={t('clinica.seccion.motivo')}>
        <Parrafo valor={content.motivo} />
      </Bloque>

      <Bloque titulo={t('clinica.seccion.anamnesis')}>
        <Parrafo valor={content.anamnesis} />
      </Bloque>

      {vitales.length > 0 && (
        <Bloque titulo={t('clinica.seccion.vitals')}>
          <p className="text-sm text-ink">
            {vitales
              .map(
                (fila) =>
                  `${fila.etiqueta} ${String(fila.valor)}${fila.unidad === undefined ? '' : ` ${fila.unidad}`}`,
              )
              .join(' · ')}
          </p>
        </Bloque>
      )}

      <Bloque titulo={t('clinica.seccion.examen_intraoral')}>
        {examen.length === 0 ? (
          <p className="text-sm text-ink-subtle">{t('clinica.lectura.sinDato')}</p>
        ) : (
          <p className="text-sm text-ink">
            {examen.map((fila) => `${fila.etiqueta}: ${String(fila.valor)}`).join(' · ')}
          </p>
        )}
        {content.exam.hallazgos !== null && content.exam.hallazgos.trim() !== '' && (
          <p className="pt-2 text-sm whitespace-pre-line text-ink">{content.exam.hallazgos}</p>
        )}
      </Bloque>

      <Bloque titulo={t('clinica.seccion.procedimientos')}>
        {content.procedimientos.length === 0 ? (
          <p className="text-sm text-ink-subtle">{t('clinica.lectura.sinProcedimientos')}</p>
        ) : (
          <ul className="list-disc space-y-1 pl-5 text-sm text-ink">
            {content.procedimientos.map((procedimiento, indice) => (
              <li key={`${procedimiento.code}-${String(indice)}`}>
                {sessionProcedureLine(procedimiento)}
                {procedimiento.notas === null || procedimiento.notas.trim() === '' ? null : (
                  <span className="text-ink-muted"> — {procedimiento.notas}</span>
                )}
              </li>
            ))}
          </ul>
        )}
      </Bloque>

      {content.materiales.length > 0 && (
        <Bloque titulo={t('clinica.seccion.materiales')}>
          <ul className="list-disc space-y-1 pl-5 text-sm text-ink">
            {content.materiales.map((material, indice) => (
              <li key={`${material.code}-${String(indice)}`}>{sessionMaterialLine(material)}</li>
            ))}
          </ul>
        </Bloque>
      )}

      <Bloque titulo={t('clinica.seccion.diagnostico')}>
        <Parrafo valor={content.diagnostico} />
      </Bloque>

      <Bloque titulo={t('clinica.seccion.indicaciones')}>
        <Parrafo valor={content.indicaciones} />
      </Bloque>

      {content.proximaCitaFecha !== null && (
        <Bloque titulo={t('clinica.seccion.proximaCita')}>
          <p className="text-sm text-ink">
            {formatDate(content.proximaCitaFecha)}
            {content.proximaCitaNota === null ? '' : ` — ${content.proximaCitaNota}`}
          </p>
        </Bloque>
      )}

      {/* Las notas internas no se imprimen para el paciente: se muestran solo a quien
          puede escribir en la historia, y con el aviso a la vista. */}
      {mostrarNotasInternas && (
        <Bloque titulo={t('clinica.lectura.notasInternas')}>
          <Alert variant="warning">{t('clinica.lectura.notasInternasAviso')}</Alert>
          <div className="pt-2">
            <Parrafo valor={content.notasInternas} />
          </div>
        </Bloque>
      )}
    </div>
  );
};

/**
 * Un **diálogo** con la lectura de la sesión. Se usa desde la ficha del paciente y
 * desde el historial del odontograma.
 */
export interface SessionReadDialogProps {
  open: boolean;
  sesion: ClinicalSessionDetail | null;
  cargando?: boolean;
  error?: string | null;
  mostrarNotasInternas?: boolean;
  patientName?: string | null;
  onClose: () => void;
  onPrint?: () => void;
}

export const SessionReadDialog = ({
  open,
  sesion,
  cargando = false,
  error = null,
  mostrarNotasInternas = false,
  patientName = null,
  onClose,
  onPrint,
}: SessionReadDialogProps) => {
  if (!open) return null;

  return (
    <Dialog
      open
      onClose={onClose}
      title={t('clinica.lectura.titulo')}
      description={sesion === null ? undefined : sesion.summary}
      closeLabel={t('comun.cerrar')}
      footer={
        <Button variant="secondary" onClick={onClose}>
          {t('comun.cerrar')}
        </Button>
      }
    >
      {cargando && <p className="text-sm text-ink-muted">{t('comun.cargando')}</p>}
      {error !== null && <Alert variant="danger">{error}</Alert>}
      {!cargando && error === null && sesion !== null && (
        <div className="space-y-3">
          <SessionDetailView
            sesion={sesion}
            mostrarNotasInternas={mostrarNotasInternas}
            patientName={patientName}
            {...(onPrint === undefined ? {} : { onPrint })}
          />
        </div>
      )}
    </Dialog>
  );
};
