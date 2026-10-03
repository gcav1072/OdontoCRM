import { cancelRequestSchema, type RequestSummary } from '@odontocrm/contracts';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation } from '@tanstack/react-query';
import { Alert, Button, Dialog, Field, Input } from '@odontocrm/ui';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import type { z } from 'zod';

import { apiErrorMessage } from '../../lib/api';
import { requestsApi } from '../../lib/endpoints';
import { applyApiFieldErrors } from '../../lib/forms';
import { t } from '../../lib/i18n';

type ValoresCancelar = z.input<typeof cancelRequestSchema>;
type CancelarEnviado = z.output<typeof cancelRequestSchema>;

export interface RequestCancelDialogProps {
  request: RequestSummary;
  onClose: () => void;
  onCancelled: (request: RequestSummary) => void;
}

/** Cancelación de una solicitud con motivo: el ticket se conserva en el historial. */
export const RequestCancelDialog = ({
  request,
  onClose,
  onCancelled,
}: RequestCancelDialogProps) => {
  const [errorGeneral, setErrorGeneral] = useState<string | null>(null);

  const formulario = useForm<ValoresCancelar, unknown, CancelarEnviado>({
    resolver: zodResolver(cancelRequestSchema),
    defaultValues: { reason: '' },
  });

  const cancelar = useMutation({
    mutationFn: (valores: CancelarEnviado) => requestsApi.cancel(request.id, valores),
  });

  const enviar = async (valores: CancelarEnviado) => {
    setErrorGeneral(null);
    try {
      const actualizada = await cancelar.mutateAsync(valores);
      onCancelled(actualizada);
    } catch (fallo) {
      if (!applyApiFieldErrors(formulario.setError, fallo)) {
        setErrorGeneral(apiErrorMessage(fallo));
      }
    }
  };

  const { errors, isSubmitting } = formulario.formState;

  return (
    <Dialog
      open
      onClose={onClose}
      title={t('programacion.solicitud.cancelarTitulo', { ticket: request.ticket })}
      description={t('programacion.solicitud.cancelarTexto')}
      closeLabel={t('comun.cerrar')}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={isSubmitting}>
            {t('comun.volver')}
          </Button>
          <Button
            type="submit"
            form="formulario-cancelar-solicitud"
            variant="danger"
            loading={isSubmitting}
            loadingLabel={t('comun.guardando')}
          >
            {t('programacion.cola.cancelar')}
          </Button>
        </>
      }
    >
      <form
        id="formulario-cancelar-solicitud"
        noValidate
        className="space-y-4"
        onSubmit={(event) => {
          void formulario.handleSubmit(enviar)(event);
        }}
      >
        {errorGeneral !== null && <Alert variant="danger">{errorGeneral}</Alert>}

        <Alert variant="info">
          {request.ticket} · {request.patientName} · {request.reason}
        </Alert>

        <Field label={t('programacion.solicitud.motivo')} error={errors.reason?.message}>
          <Input autoComplete="off" {...formulario.register('reason')} />
        </Field>
      </form>
    </Dialog>
  );
};
