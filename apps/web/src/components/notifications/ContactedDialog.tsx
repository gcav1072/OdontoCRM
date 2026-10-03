import {
  markContactedSchema,
  type MarkContactedInput,
  type NotificationRecord,
} from '@odontocrm/contracts';
import { useMutation } from '@tanstack/react-query';
import { Alert, Button, Dialog, Field } from '@odontocrm/ui';
import { useState } from 'react';

import { apiErrorMessage, isApiError } from '../../lib/api';
import { notificationsApi } from '../../lib/endpoints';
import { t, templateName } from '../../lib/i18n';

export interface ContactedDialogProps {
  record: NotificationRecord;
  onClose: () => void;
  onContacted: (record: NotificationRecord) => void;
}

/**
 * «Marcar contacto hecho»: el aviso manual pendiente es un paciente sin
 * Telegram vinculado, así que alguien tiene que llamarlo por teléfono. La nota
 * es obligatoria (la valida `markContactedSchema`) y queda con la fecha y el
 * usuario que la registró.
 */
export const ContactedDialog = ({ record, onClose, onContacted }: ContactedDialogProps) => {
  const [nota, setNota] = useState('');
  const [errorCampo, setErrorCampo] = useState<string | null>(null);
  const [errorGeneral, setErrorGeneral] = useState<string | null>(null);

  const marcar = useMutation({
    mutationFn: (input: MarkContactedInput) => notificationsApi.markContacted(record.id, input),
  });

  const enviar = async () => {
    setErrorCampo(null);
    setErrorGeneral(null);

    const analizado = markContactedSchema.safeParse({ note: nota.trim() });
    if (!analizado.success) {
      setErrorCampo(analizado.error.issues[0]?.message ?? t('api.error.422'));
      return;
    }

    try {
      onContacted(await marcar.mutateAsync(analizado.data));
    } catch (fallo) {
      if (isApiError(fallo) && fallo.fieldErrors['note'] !== undefined) {
        setErrorCampo(fallo.fieldErrors['note']);
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
      title={t('notificaciones.contacto.titulo')}
      description={`${record.patientName ?? t('comun.desconocido')} · ${templateName(record.templateKey)}`}
      dismissOnBackdrop={false}
      closeLabel={t('comun.cerrar')}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={marcar.isPending}>
            {t('comun.cancelar')}
          </Button>
          <Button loading={marcar.isPending} onClick={() => void enviar()}>
            {marcar.isPending ? t('comun.guardando') : t('notificaciones.contacto.enviar')}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Alert variant="warning">{t('notificaciones.estado.avisoManual')}</Alert>

        <p className="text-sm text-ink-muted">{t('notificaciones.contacto.texto')}</p>

        <Field
          label={t('notificaciones.contacto.nota')}
          required
          error={errorCampo ?? undefined}
          hint={t('notificaciones.contacto.notaAyuda')}
        >
          <textarea
            value={nota}
            rows={3}
            maxLength={300}
            aria-required
            onChange={(event) => setNota(event.target.value)}
            className="w-full rounded-control border border-border-strong bg-surface px-3 py-2 text-sm text-ink transition-colors placeholder:text-ink-subtle focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-solid focus-visible:outline-focus"
            placeholder={t('notificaciones.contacto.notaPlaceholder')}
          />
        </Field>

        {errorGeneral !== null && <Alert variant="danger">{errorGeneral}</Alert>}
      </div>
    </Dialog>
  );
};
