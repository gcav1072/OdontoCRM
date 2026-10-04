import { auditDiffRows, type AuditEventRecord } from '@odontocrm/contracts';
import { Alert, Button, Dialog } from '@odontocrm/ui';
import { ArrowRight, MessageSquareQuote, ScanSearch } from 'lucide-react';

import { DescriptionList } from '../notifications/DescriptionList';
import { actionLabel, entityTypeLabel, fieldLabel } from '../../lib/audit';
import { formatDateTime, formatUserAgent } from '../../lib/format';
import { t } from '../../lib/i18n';

export interface AuditDiffDialogProps {
  open: boolean;
  evento: AuditEventRecord | null;
  onClose: () => void;
  /** Lleva a la lista los filtros de la entidad del evento (tipo + identificador). */
  onFiltrarEntidad: (entityType: string, entityId: string) => void;
}

/**
 * Detalle de un evento de auditoría: los datos de la petición (quién, desde
 * dónde, con qué navegador) y el **diff antes/después** de los campos que
 * cambiaron, que es lo que la fase pide poder leer.
 *
 * Las filas del diff salen de `auditDiffRows` (contratos), que respeta el orden
 * en que el servicio detectó los cambios y pinta los vacíos como «—». El valor
 * anterior va tachado y el nuevo en negrita, igual que en el resto de la
 * aplicación (`PatientDiffDialog`).
 */
export const AuditDiffDialog = ({
  open,
  evento,
  onClose,
  onFiltrarEntidad,
}: AuditDiffDialogProps) => {
  const filas = evento === null ? [] : auditDiffRows(evento);
  const motivo = evento?.reason ?? null;
  // Se resuelven fuera del `footer` porque ahí TypeScript ya no estrecha `evento`.
  const entidadId = evento?.entityId ?? null;
  const entidadTipo = evento?.entityType ?? '';

  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="lg"
      title={evento === null ? t('auditoria.titulo') : actionLabel(evento.action)}
      description={evento?.summary ?? t('auditoria.dialogo.sinResumen')}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t('comun.cerrar')}
          </Button>
          {entidadId !== null && (
            <Button
              onClick={() => onFiltrarEntidad(entidadTipo, entidadId)}
              leadingIcon={<ScanSearch className="size-4" aria-hidden="true" />}
            >
              {t('auditoria.dialogo.filtrarEntidad')}
            </Button>
          )}
        </>
      }
    >
      {evento === null ? null : (
        <div className="space-y-5">
          <DescriptionList
            items={[
              [t('auditoria.tabla.fecha'), formatDateTime(evento.occurredAt)],
              [t('auditoria.dialogo.usuario'), evento.actorUsername ?? t('comun.sinDato')],
              [t('auditoria.dialogo.entidad'), entityTypeLabel(evento.entityType)],
              [
                t('auditoria.dialogo.identificador'),
                <span key="id" className="font-mono text-xs">
                  {evento.entityId ?? t('comun.sinDato')}
                </span>,
              ],
              [t('auditoria.dialogo.ip'), evento.ip ?? t('comun.sinDato')],
              [t('auditoria.dialogo.peticion'), evento.requestId ?? t('comun.sinDato')],
              [t('auditoria.dialogo.navegador'), formatUserAgent(evento.userAgent)],
            ]}
          />

          {motivo !== null && motivo !== '' && (
            <div className="flex items-start gap-3 rounded-control border border-warning/40 bg-warning/10 px-3.5 py-3">
              <MessageSquareQuote
                className="mt-0.5 size-4 shrink-0 text-warning"
                aria-hidden="true"
              />
              <div className="min-w-0 flex-1">
                <p className="text-xs font-semibold tracking-wide text-ink-subtle uppercase">
                  {t('auditoria.dialogo.motivo')}
                </p>
                <p className="text-sm font-medium text-ink">{motivo}</p>
              </div>
            </div>
          )}

          <section className="space-y-2">
            <h3 className="text-sm font-semibold text-ink">{t('auditoria.dialogo.cambios')}</h3>

            {filas.length === 0 ? (
              <Alert variant="info">{t('auditoria.dialogo.sinDiff')}</Alert>
            ) : (
              <ul className="divide-y divide-border overflow-hidden rounded-control border border-border">
                {filas.map((fila) => (
                  <li key={fila.field} className="grid gap-1 px-3.5 py-3 sm:grid-cols-[12rem_1fr]">
                    <span className="text-sm font-medium text-ink">
                      {fieldLabel(fila.field, evento.entityType)}
                    </span>
                    <span className="flex flex-wrap items-center gap-2 text-sm">
                      <span className="text-ink-muted line-through">{fila.before}</span>
                      <ArrowRight className="size-3.5 text-ink-subtle" aria-hidden="true" />
                      <span className="font-medium text-ink">{fila.after}</span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      )}
    </Dialog>
  );
};
