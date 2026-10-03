import {
  addMinutes,
  formatTime12h,
  minutesBetween,
  rescheduleAppointmentSchema,
  type AppointmentSummary,
  type Permission,
  type SlotKind,
} from '@odontocrm/contracts';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation } from '@tanstack/react-query';
import { Alert, Button, Dialog, Field, Input } from '@odontocrm/ui';
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import type { z } from 'zod';

import { useDayView } from '../../hooks/useDayView';
import { appointmentsApi } from '../../lib/endpoints';
import { formatDateOnly, schedulingErrorInfo } from '../../lib/scheduling';
import { t } from '../../lib/i18n';
import { SlotPickerFields } from './SlotPickerFields';

type ValoresReprogramar = z.input<typeof rescheduleAppointmentSchema>;
type ReprogramarEnviado = z.output<typeof rescheduleAppointmentSchema>;

export interface RescheduleAppointmentDialogProps {
  appointment: AppointmentSummary;
  hasPermission: (permission: Permission) => boolean;
  onClose: () => void;
  /** Recibe la cita anterior ya marcada como `reprogramada` y la nueva. */
  onRescheduled: (previous: AppointmentSummary, next: AppointmentSummary) => void;
}

/**
 * Reprogramación: no borra nada. La cita actual queda como `reprogramada` y el
 * servidor crea una nueva enlazada con el mismo ticket; aquí se avisa de esa
 * regla y se devuelven las dos citas para refrescar la jornada sin recargarla.
 */
export const RescheduleAppointmentDialog = ({
  appointment,
  hasPermission,
  onClose,
  onRescheduled,
}: RescheduleAppointmentDialogProps) => {
  const [errorGeneral, setErrorGeneral] = useState<string | null>(null);
  const [pista, setPista] = useState<string | null>(null);

  const formulario = useForm<ValoresReprogramar, unknown, ReprogramarEnviado>({
    resolver: zodResolver(rescheduleAppointmentSchema),
    defaultValues: {
      date: appointment.date,
      startTime: appointment.startTime,
      slotKind: appointment.slotKind,
      durationMinutes: appointment.durationMinutes,
      reason: '',
      authorizeOverbook: false,
      overbookReason: '',
    },
  });

  const { setValue } = formulario;
  const fecha = formulario.watch('date') ?? appointment.date;
  const slotKind = (formulario.watch('slotKind') ?? appointment.slotKind) as SlotKind;
  const startTime = formulario.watch('startTime') ?? appointment.startTime;
  const durationMinutes = Number(
    formulario.watch('durationMinutes') ?? appointment.durationMinutes,
  );

  const diaQuery = useDayView(fecha, fecha !== appointment.date);
  const dia = diaQuery.data;
  const refetchDia = diaQuery.refetch;
  const franjas = dia?.slots ?? [];
  const libres = franjas.filter((franja) => franja.state === 'libre');

  const puedeSobrecupo = hasPermission('scheduling:overbook');
  const completo = dia?.capacity.isFull ?? false;
  const bloqueadoPorSobrecupo = completo && !puedeSobrecupo;

  useEffect(() => {
    if (slotKind !== 'franja') return;
    if (libres.some((franja) => franja.startTime === startTime)) return;
    const primera = libres[0];
    if (primera === undefined) return;
    setValue('startTime', primera.startTime, { shouldValidate: false });
  }, [libres, slotKind, startTime, setValue]);

  // La duración acompaña a la franja elegida mientras el usuario no la cambie.
  useEffect(() => {
    if (slotKind !== 'franja') return;
    const franja = libres.find((candidata) => candidata.startTime === startTime);
    if (franja === undefined) return;
    const esperada = Math.max(5, minutesBetween(franja.startTime, franja.endTime));
    if (durationMinutes !== esperada) {
      setValue('durationMinutes', esperada, { shouldValidate: false });
    }
  }, [libres, slotKind, startTime, durationMinutes, setValue]);

  useEffect(() => {
    setValue('authorizeOverbook', completo && puedeSobrecupo, { shouldValidate: false });
  }, [completo, puedeSobrecupo, setValue]);

  const reprogramar = useMutation({
    mutationFn: (valores: ReprogramarEnviado) =>
      appointmentsApi.reschedule(appointment.id, valores),
  });

  const enviar = async (valores: ReprogramarEnviado) => {
    if (bloqueadoPorSobrecupo) {
      setErrorGeneral(t('programacion.sobrecupo.sinPermiso'));
      return;
    }
    setErrorGeneral(null);
    setPista(null);
    try {
      const nueva = await reprogramar.mutateAsync(valores);
      onRescheduled({ ...appointment, status: 'reprogramada', rescheduledToId: nueva.id }, nueva);
    } catch (fallo) {
      const info = schedulingErrorInfo(fallo);
      setErrorGeneral(info.message);
      setPista(info.hint);
      // El día destino pudo cambiar (franja ocupada, día completo).
      void refetchDia();
    }
  };

  const { errors, isSubmitting } = formulario.formState;

  return (
    <Dialog
      open
      onClose={onClose}
      size="lg"
      title={t('programacion.reprogramar.titulo', { paciente: appointment.patientName })}
      description={t('programacion.reprogramar.texto')}
      dismissOnBackdrop={false}
      closeLabel={t('comun.cerrar')}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={isSubmitting}>
            {t('comun.cancelar')}
          </Button>
          {!bloqueadoPorSobrecupo && (
            <Button
              type="submit"
              form="formulario-reprogramar"
              loading={isSubmitting}
              loadingLabel={t('comun.guardando')}
            >
              {completo
                ? t('programacion.sobrecupo.autorizar')
                : t('programacion.reprogramar.enviar')}
            </Button>
          )}
        </>
      }
    >
      <form
        id="formulario-reprogramar"
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

        <Alert variant="info">
          <p className="font-medium text-ink">
            {appointment.ticket ?? t('comun.sinDato')} · {appointment.patientName}
          </p>
          <p className="pt-0.5">
            {t('programacion.accion.hora', {
              inicio: formatTime12h(appointment.startTime),
              fin: formatTime12h(appointment.endTime),
            })}
            {' · '}
            {formatDateOnly(appointment.date)}
          </p>
        </Alert>

        {completo && puedeSobrecupo && (
          <Alert variant="warning" title={t('programacion.sobrecupo.titulo')}>
            {t('programacion.sobrecupo.texto', {
              fecha: formatDateOnly(fecha),
              asignados: dia?.capacity.assigned ?? 0,
              cupo: dia?.capacity.capacity ?? 0,
            })}
          </Alert>
        )}

        {bloqueadoPorSobrecupo && (
          <Alert variant="danger" title={t('programacion.cupo.completo')}>
            {t('programacion.sobrecupo.sinPermiso')}
          </Alert>
        )}

        <Field label={t('programacion.asignar.fecha')} error={errors.date?.message} required>
          <Input
            type="date"
            {...formulario.register('date', {
              onChange: () => setValue('startTime', '', { shouldValidate: false }),
            })}
          />
        </Field>

        <SlotPickerFields
          slots={franjas}
          value={{ slotKind, startTime, durationMinutes }}
          disabled={isSubmitting}
          errorStartTime={errors.startTime?.message}
          errorDuration={errors.durationMinutes?.message}
          onChange={(siguiente) => {
            if (siguiente.slotKind !== undefined) {
              setValue('slotKind', siguiente.slotKind, { shouldValidate: true });
            }
            if (siguiente.startTime !== undefined) {
              setValue('startTime', siguiente.startTime, { shouldValidate: true });
            }
            if (siguiente.durationMinutes !== undefined) {
              setValue('durationMinutes', siguiente.durationMinutes, { shouldValidate: true });
            }
          }}
        />

        {completo && puedeSobrecupo && (
          <Field
            label={t('programacion.sobrecupo.motivo')}
            hint={t('programacion.sobrecupo.motivoAyuda')}
            error={errors.overbookReason?.message}
            required
          >
            <Input autoComplete="off" {...formulario.register('overbookReason')} />
          </Field>
        )}

        <Field label={t('programacion.reprogramar.motivo')} error={errors.reason?.message}>
          <Input autoComplete="off" {...formulario.register('reason')} />
        </Field>

        <p className="text-xs text-ink-subtle">
          {t('programacion.accion.hora', {
            inicio: formatTime12h(startTime),
            fin: formatTime12h(addMinutes(startTime, durationMinutes)),
          })}
        </p>
      </form>
    </Dialog>
  );
};
