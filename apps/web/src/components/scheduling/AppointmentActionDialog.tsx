import {
  NO_SHOW_GRACE_MINUTES,
  formatTime12h,
  type AppointmentSummary,
} from '@odontocrm/contracts';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation } from '@tanstack/react-query';
import { Alert, Button, Dialog, Field, Input } from '@odontocrm/ui';
import { useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';

import { appointmentsApi } from '../../lib/endpoints';
import { applyApiFieldErrors } from '../../lib/forms';
import { schedulingErrorInfo } from '../../lib/scheduling';
import { t } from '../../lib/i18n';

export type AppointmentActionMode = 'attend' | 'no-show' | 'cancel';

/**
 * Esquema del motivo según la acción. «Atendido» lo exige (la máquina de
 * estados marca `requiresReason`): mientras no exista historia clínica, ese
 * motivo es el respaldo auditado de la atención (Fase 6 lo enlazará).
 */
const construirEsquema = (modo: AppointmentActionMode) =>
  z
    .object({
      reason: z.string().trim().max(300).optional(),
      forceReason: z.string().trim().max(300).optional(),
    })
    .superRefine((valores, ctx) => {
      if (modo === 'attend' && (valores.forceReason ?? '').trim().length < 3) {
        ctx.addIssue({
          code: 'custom',
          path: ['forceReason'],
          message: t('programacion.atendido.motivoCorto'),
        });
      }
    });

type ValoresAccion = z.input<ReturnType<typeof construirEsquema>>;
type AccionEnviada = z.output<ReturnType<typeof construirEsquema>>;

export interface AppointmentActionDialogProps {
  mode: AppointmentActionMode;
  appointment: AppointmentSummary;
  onClose: () => void;
  onDone: (appointment: AppointmentSummary, message: string) => void;
}

const TITULOS: Record<AppointmentActionMode, (paciente: string) => string> = {
  attend: (paciente) => t('programacion.atendido.titulo', { paciente }),
  'no-show': (paciente) => t('programacion.inasistencia.titulo', { paciente }),
  cancel: (paciente) => t('programacion.cancelar.titulo', { paciente }),
};

const BOTONES: Record<AppointmentActionMode, string> = {
  attend: t('programacion.atendido.enviar'),
  'no-show': t('programacion.inasistencia.enviar'),
  cancel: t('programacion.cancelar.enviar'),
};

const EXITOS: Record<AppointmentActionMode, string> = {
  attend: t('programacion.atendido.ok'),
  'no-show': t('programacion.inasistencia.ok'),
  cancel: t('programacion.cancelar.ok'),
};

/** Diálogos de «atendido», «inasistencia» y «cancelada»: piden el motivo y lo envían. */
export const AppointmentActionDialog = ({
  mode,
  appointment,
  onClose,
  onDone,
}: AppointmentActionDialogProps) => {
  const [errorGeneral, setErrorGeneral] = useState<string | null>(null);
  const [pista, setPista] = useState<string | null>(null);

  // El esquema se memoriza por modo: el resolver no cambia de identidad en cada
  // dibujado y react-hook-form valida siempre contra el mismo contrato.
  const esquema = useMemo(() => construirEsquema(mode), [mode]);
  const resolver = useMemo(() => zodResolver(esquema), [esquema]);

  const formulario = useForm<ValoresAccion, unknown, AccionEnviada>({
    resolver,
    defaultValues: { reason: '', forceReason: '' },
  });

  const ejecutar = useMutation({
    mutationFn: (valores: AccionEnviada) => {
      if (mode === 'attend') {
        return appointmentsApi.attend(appointment.id, { forceReason: valores.forceReason });
      }
      if (mode === 'no-show') {
        return appointmentsApi.noShow(appointment.id, { reason: valores.reason });
      }
      return appointmentsApi.cancel(appointment.id, { reason: valores.reason });
    },
  });

  const enviar = async (valores: AccionEnviada) => {
    setErrorGeneral(null);
    setPista(null);
    try {
      const actualizada = await ejecutar.mutateAsync(valores);
      onDone(actualizada, EXITOS[mode]);
    } catch (fallo) {
      const info = schedulingErrorInfo(fallo);
      applyApiFieldErrors(formulario.setError, fallo);
      setErrorGeneral(info.message);
      setPista(info.hint);
    }
  };

  const { errors, isSubmitting } = formulario.formState;

  return (
    <Dialog
      open
      onClose={onClose}
      title={TITULOS[mode](appointment.patientName)}
      description={t('programacion.accion.hora', {
        inicio: formatTime12h(appointment.startTime),
        fin: formatTime12h(appointment.endTime),
      })}
      dismissOnBackdrop={false}
      closeLabel={t('comun.cerrar')}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={isSubmitting}>
            {t('comun.cancelar')}
          </Button>
          <Button
            type="submit"
            form="formulario-accion-cita"
            variant={mode === 'cancel' ? 'danger' : 'primary'}
            loading={isSubmitting}
            loadingLabel={t('comun.guardando')}
          >
            {BOTONES[mode]}
          </Button>
        </>
      }
    >
      <form
        id="formulario-accion-cita"
        noValidate
        className="space-y-4"
        onSubmit={(event) => {
          void formulario.handleSubmit(enviar)(event);
        }}
      >
        {errorGeneral !== null && (
          <Alert variant="danger" title={t('api.titulo.error')}>
            <p>{errorGeneral}</p>
            {pista !== null && <p className="pt-1 font-medium">{pista}</p>}
          </Alert>
        )}

        {mode === 'attend' && <Alert variant="warning">{t('programacion.atendido.texto')}</Alert>}

        {mode === 'no-show' && (
          <Alert variant="info">
            {t('programacion.inasistencia.texto', { minutos: NO_SHOW_GRACE_MINUTES })}
          </Alert>
        )}

        {mode === 'cancel' && <Alert variant="info">{t('programacion.cancelar.texto')}</Alert>}

        {mode === 'attend' ? (
          <Field
            label={t('programacion.atendido.motivo')}
            hint={t('programacion.atendido.motivoAyuda')}
            error={errors.forceReason?.message}
            required
          >
            <Input autoComplete="off" {...formulario.register('forceReason')} />
          </Field>
        ) : (
          <Field
            label={
              mode === 'no-show'
                ? t('programacion.inasistencia.motivo')
                : t('programacion.cancelar.motivo')
            }
            error={errors.reason?.message}
          >
            <Input autoComplete="off" {...formulario.register('reason')} />
          </Field>
        )}
      </form>
    </Dialog>
  );
};
