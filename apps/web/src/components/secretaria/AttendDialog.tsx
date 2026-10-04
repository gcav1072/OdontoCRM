import type { AppointmentSummary } from '@odontocrm/contracts';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Alert, Button, Dialog, Field, Input, Spinner } from '@odontocrm/ui';
import { useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';

import { apiErrorMessage } from '../../lib/api';
import { appointmentsApi, clinicalApi } from '../../lib/endpoints';
import { applyApiFieldErrors } from '../../lib/forms';
import { t } from '../../lib/i18n';
import { CODIGO_SESION_CLINICA, codigoDeProblema } from './acciones';

/** Longitud mínima del motivo; el servidor aplica la misma regla. */
const MOTIVO_MINIMO = 3;

/**
 * El «atendido» exige la **sesión clínica cerrada** (Fase 7). Si el doctor ya la
 * cerró, la secretaría solo confirma: el diálogo la busca por la cita y la manda
 * como respaldo, sin pedir motivo. Si no la hay, pide el motivo escrito, que queda
 * en la auditoría.
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

/**
 * Cierre de la visita: con la sesión clínica cerrada delante, sin motivo; sin ella,
 * con el motivo obligatorio que va a la auditoría.
 */
export const AttendDialog = ({ appointment, onClose, onDone }: AttendDialogProps) => {
  const [errorGeneral, setErrorGeneral] = useState<string | null>(null);

  // El resolver se memoriza: el esquema es constante y no cambia de identidad en
  // cada dibujado.
  const resolver = useMemo(() => zodResolver(esquema), []);

  const formulario = useForm<ValoresAtendido, unknown, AtendidoEnviado>({
    resolver,
    defaultValues: { forceReason: '' },
  });

  /** Sesiones de la cita: la cerrada es la que respalda el «atendido» sin motivo. */
  const sesionesQuery = useQuery({
    queryKey: ['clinica', 'sesiones-cita', appointment.id],
    queryFn: ({ signal }) => clinicalApi.sessionsByAppointment(appointment.id, signal),
  });

  const sesionCerrada =
    sesionesQuery.data?.items.find((session) => session.status === 'cerrada') ?? null;

  const marcarAtendido = useMutation({
    mutationFn: (input: { forceReason?: string }) =>
      appointmentsApi.attend(appointment.id, {
        ...input,
        ...(sesionCerrada === null ? {} : { clinicalSessionId: sesionCerrada.id }),
      }),
  });

  const confirmarSinMotivo = async (): Promise<void> => {
    setErrorGeneral(null);
    try {
      onDone(await marcarAtendido.mutateAsync({}));
    } catch (fallo) {
      setErrorGeneral(apiErrorMessage(fallo));
    }
  };

  const enviar = async (valores: AtendidoEnviado) => {
    setErrorGeneral(null);
    try {
      onDone(await marcarAtendido.mutateAsync({ forceReason: valores.forceReason }));
    } catch (fallo) {
      applyApiFieldErrors(formulario.setError, fallo);

      // El 400 `clinical_session_required` es el camino esperado cuando no hay
      // sesión cerrada: el mensaje del servidor explica qué falta y se muestra
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
  const buscandoSesion = sesionesQuery.isLoading;

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
            type={sesionCerrada === null ? 'submit' : 'button'}
            form={sesionCerrada === null ? 'formulario-secretaria-atendido' : undefined}
            loading={isSubmitting || marcarAtendido.isPending}
            loadingLabel={t('comun.guardando')}
            onClick={sesionCerrada === null ? undefined : () => void confirmarSinMotivo()}
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

        {buscandoSesion && <Spinner showLabel label={t('comun.cargando')} />}

        {sesionCerrada !== null ? (
          <Alert variant="success" title={t('secretaria.atendido.conSesion.titulo')}>
            {t('secretaria.atendido.conSesion.texto', { resumen: sesionCerrada.summary })}
          </Alert>
        ) : (
          !buscandoSesion && (
            <>
              <Alert variant="warning">{t('secretaria.atendido.advertencia')}</Alert>

              <Field
                label={t('secretaria.atendido.motivo')}
                error={errors.forceReason?.message}
                required
              >
                <Input
                  autoComplete="off"
                  placeholder={t('secretaria.atendido.motivoPlaceholder')}
                  {...formulario.register('forceReason')}
                />
              </Field>
            </>
          )
        )}
      </form>
    </Dialog>
  );
};
