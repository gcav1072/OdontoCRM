import { DEFAULT_MESSAGE_TEMPLATES, type MessageTemplate } from '@odontocrm/contracts';
import { Alert, Button, Dialog } from '@odontocrm/ui';

import { t, templateName } from '../../lib/i18n';

export interface TemplateResetDialogProps {
  template: MessageTemplate;
  loading: boolean;
  onClose: () => void;
  onConfirm: () => void;
}

/**
 * Confirmación de «Restaurar texto por defecto»: muestra el texto al que va a
 * volver la plantilla antes de pisar lo que hay guardado. Es un POST al
 * servicio (`…/reset`), no una edición con el texto de fábrica.
 */
export const TemplateResetDialog = ({
  template,
  loading,
  onClose,
  onConfirm,
}: TemplateResetDialogProps) => {
  const defecto = DEFAULT_MESSAGE_TEMPLATES.find((valor) => valor.key === template.key) ?? null;

  return (
    <Dialog
      open
      onClose={onClose}
      size="md"
      title={t('notificaciones.plantillas.restaurarTitulo', { clave: templateName(template.key) })}
      dismissOnBackdrop={false}
      closeLabel={t('comun.cerrar')}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={loading}>
            {t('comun.cancelar')}
          </Button>
          <Button variant="danger" loading={loading} onClick={onConfirm}>
            {t('notificaciones.plantillas.restaurar')}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Alert variant="warning">{t('notificaciones.plantillas.restaurarTexto')}</Alert>

        {defecto !== null && (
          <div className="space-y-2">
            <p className="text-xs font-medium tracking-wide text-ink-subtle uppercase">
              {t('notificaciones.plantillas.original')}
            </p>
            {defecto.subject !== null && (
              <p className="text-sm font-medium text-ink">{defecto.subject}</p>
            )}
            <p className="rounded-control border border-border bg-surface-muted px-3.5 py-3 text-sm whitespace-pre-wrap text-ink">
              {defecto.body}
            </p>
          </div>
        )}

        <div className="space-y-2">
          <p className="text-xs font-medium tracking-wide text-ink-subtle uppercase">
            {t('notificaciones.plantillas.cuerpo')}
          </p>
          <p className="rounded-control border border-border px-3.5 py-3 text-sm whitespace-pre-wrap text-ink-muted">
            {template.body}
          </p>
        </div>
      </div>
    </Dialog>
  );
};
