import type { AppointmentSummary } from '@odontocrm/contracts';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation } from '@tanstack/react-query';
import { Alert, Button, Dialog, Field, Input } from '@odontocrm/ui';
import { useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';

import { apiErrorMessage } from '../../lib/api';
import { appointmentsApi } from '../../lib/endpoints';
import { applyApiFieldErrors } from '../../lib/forms';
import { t } from '../../lib/i18n';
import { CODIGO_SESION_CLINICA, codigoDeProblema } from './acciones';

/** Longitud mínima del motivo; el servidor aplica la misma regla. */
const MOTIVO_MINIMO = 3;

/**
 * Mientras no exista historia clínica (Fase 6), el «atendido» exige un motivo
 * escrito que queda en la auditoría: es el respaldo de la visita. El esquema lo
 * pide aquí también para no gastar una petición que el servidor va a rechazar.
 */
const esquema = z.object({
  forceReason: z
    .string()
    .trim()
    .min(MOTIVO_MINIMO, t('programacion.atendido.motivoCorto'))
    .max(300),
});

type ValoresAtendido = z.input<typeof esquema>;
type AtendidoEnviado = z.output<typeof esquema>;

export interface AttendDialogProps {
  appointment: AppointmentSummary;
  onClose: () => void;
  onDone: (appointment: AppointmentSummary) => void;
}

/** Cierre de la visita con motivo obligatorio (`attend` + `forceReason`). */
export const AttendDialog = ({ appointment, onClose, onDone }: AttendDialogProps) => {
  const [errorGeneral, setErrorGeneral] = useState<string | null>(null);

  // El resolver se memoriza: el esquema es constante y no cambia de identidad en
  // cada dibujado.
  const resolver = useMemo(() => zodResolver(esquema), []);

  const formulario = useForm<ValoresAtendido, unknown, AtendidoEnviado>({
    resolver,
    defaultValues: { forceReason: '' },
  });

  const marcarAtendido = useMutation({
    mutationFn: (valores: AtendidoEnviado) =>
      appointmentsApi.attend(appointment.id, { forceReason: valores.forceReason }),
  });

  const enviar = async (valores: AtendidoEnviado) => {
    setErrorGeneral(null);
    try {
      onDone(await marcarAtendido.mutateAsync(valores));
    } catch (fallo) {
      applyApiFieldErrors(formulario.setError, fallo);

      // El 400 `clinical_session_required` es el camino esperado mientras no haya
      // sesión clínica: el mensaje del servidor explica qué falta y se muestra
      // tal cual, marcando además el motivo para que se complete.
      if (codigoDeProblema(fallo) === CODIGO_SESION_CLINICA) {
        formulario.setError('forceReason', {
          type: 'servidor',
          message: t('programacion.atendido.motivoCorto'),
        });
      }
      setErrorGeneral(apiErrorMessage(fallo));
    }
  };

  const { errors, isSubmitting } = formulario.formState;

  return (
    <Dialog
      open
      onClose={onClose}
      title={t('secretaria.atendido.titulo')}
      description={t('secretaria.atendido.texto', { paciente: appointment.patientName })}
      dismissOnBackdrop={false}
      closeLabel={t('comun.cerrar')}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={isSubmitting}>
            {t('comun.cancelar')}
          </Button>
          <Button
            type="submit"
            form="formulario-secretaria-atendido"
            loading={isSubmitting}
            loadingLabel={t('comun.guardando')}
          >
            {t('secretaria.atendido.confirmar')}
          </Button>
        </>
      }
    >
      <form
        id="formulario-secretaria-atendido"
        noValidate
        className="space-y-4"
        onSubmit={(event) => {
          void formulario.handleSubmit(enviar)(event);
        }}
      >
        {errorGeneral !== null && (
          <Alert variant="danger" title={t('secretaria.error.accion')}>
            {errorGeneral}
          </Alert>
        )}

        <Alert variant="warning">{t('secretaria.atendido.advertencia')}</Alert>

        <Field label={t('secretaria.atendido.motivo')} error={errors.forceReason?.message} required>
          <Input
            autoComplete="off"
            placeholder={t('secretaria.atendido.motivoPlaceholder')}
            {...formulario.register('forceReason')}
          />
        </Field>
      </form>
    </Dialog>
  );
};
