import {
  retryNotificationSchema,
  type NotificationRecord,
  type RetryNotificationInput,
} from '@odontocrm/contracts';
import { useMutation } from '@tanstack/react-query';
import { Alert, Button, Dialog, Field, Input } from '@odontocrm/ui';
import { useState } from 'react';

import { apiErrorMessage, isApiError } from '../../lib/api';
import { notificationsApi } from '../../lib/endpoints';
import { formatDateTime } from '../../lib/format';
import { CHANNEL_LABELS, t, templateName } from '../../lib/i18n';
import { DescriptionList } from './DescriptionList';
import { NotificationStatusBadge } from './NotificationStatusBadge';

export interface RetryNotificationDialogProps {
  record: NotificationRecord;
  onClose: () => void;
  onRetried: (record: NotificationRecord) => void;
}

/**
 * Reintento manual de un envío: devuelve el mensaje a la cola del bot. El motivo
 * es opcional (queda en el registro del servicio); si Zod lo rechaza se muestra
 * bajo el campo, igual que en el resto de los formularios.
 */
export const RetryNotificationDialog = ({
  record,
  onClose,
  onRetried,
}: RetryNotificationDialogProps) => {
  const [motivo, setMotivo] = useState('');
  const [errorCampo, setErrorCampo] = useState<string | null>(null);
  const [errorGeneral, setErrorGeneral] = useState<string | null>(null);

  const reintentar = useMutation({
    mutationFn: (input: RetryNotificationInput) => notificationsApi.retry(record.id, input),
  });

  const enviar = async () => {
    setErrorCampo(null);
    setErrorGeneral(null);

    const limpio = motivo.trim();
    const analizado = retryNotificationSchema.safeParse(limpio === '' ? {} : { reason: limpio });
    if (!analizado.success) {
      setErrorCampo(analizado.error.issues[0]?.message ?? t('api.error.422'));
      return;
    }

    try {
      onRetried(await reintentar.mutateAsync(analizado.data));
    } catch (fallo) {
      if (isApiError(fallo) && fallo.fieldErrors['reason'] !== undefined) {
        setErrorCampo(fallo.fieldErrors['reason']);
      } else {
        setErrorGeneral(apiErrorMessage(fallo));
      }
    }
  };

  return (
    <Dialog
      open
      onClose={onClose}
      size="md"
      title={t('notificaciones.reintento.titulo')}
      description={`${record.patientName ?? t('comun.desconocido')} · ${templateName(record.templateKey)}`}
      dismissOnBackdrop={false}
      closeLabel={t('comun.cerrar')}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={reintentar.isPending}>
            {t('comun.cancelar')}
          </Button>
          <Button loading={reintentar.isPending} onClick={() => void enviar()}>
            {reintentar.isPending ? t('comun.enviando') : t('notificaciones.reintento.enviar')}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <p className="text-sm text-ink-muted">{t('notificaciones.reintento.texto')}</p>

        <DescriptionList
          items={[
            [
              t('notificaciones.bandeja.columna.estado'),
              <NotificationStatusBadge status={record.status} />,
            ],
            [t('notificaciones.bandeja.columna.canal'), CHANNEL_LABELS[record.channel]],
            [
              t('notificaciones.bandeja.columna.intentos'),
              `${record.attempts}/${record.maxAttempts}`,
            ],
            [t('notificaciones.bandeja.columna.creado'), formatDateTime(record.createdAt)],
          ]}
        />

        {record.lastError !== null && (
          <Alert variant="danger" title={t('notificaciones.detalle.error')}>
            {record.lastError}
          </Alert>
        )}

        <Field
          label={t('notificaciones.reintento.motivo')}
          hint={t('comun.opcional')}
          error={errorCampo ?? undefined}
        >
          <Input
            value={motivo}
            maxLength={200}
            onChange={(event) => setMotivo(event.target.value)}
          />
        </Field>

        {errorGeneral !== null && <Alert variant="danger">{errorGeneral}</Alert>}
      </div>
    </Dialog>
  );
};
