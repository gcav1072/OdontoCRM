import {
  DEFAULT_SLOT_MINUTES,
  addMinutes,
  assignAppointmentSchema,
  formatTime12h,
  minutesBetween,
  type AppointmentSummary,
  type Permission,
  type RequestSummary,
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
import { applyApiFieldErrors } from '../../lib/forms';
import { formatDateOnly, schedulingErrorInfo } from '../../lib/scheduling';
import { t } from '../../lib/i18n';
import { SlotPickerFields } from './SlotPickerFields';

type ValoresAsignar = z.input<typeof assignAppointmentSchema>;
type AsignarEnviado = z.output<typeof assignAppointmentSchema>;

export interface AssignAppointmentDialogProps {
  request: RequestSummary;
  defaultDate: string;
  /** Hora de la franja que se soltó o se pulsó, si la hay. */
  defaultStartTime?: string;
  hasPermission: (permission: Permission) => boolean;
  onClose: () => void;
  onAssigned: (appointment: AppointmentSummary, request: RequestSummary) => void;
}

/**
 * Asignación: convierte la solicitud en cita. La fecha se puede cambiar (se
 * consulta la jornada de ese día para ofrecer sus franjas libres) y la hora es
 * de franja o manual. Si el día destino está completo, el diálogo explica la
 * situación; con `scheduling:overbook` pide el motivo y autoriza el sobrecupo.
 */
export const AssignAppointmentDialog = ({
  request,
  defaultDate,
  defaultStartTime,
  hasPermission,
  onClose,
  onAssigned,
}: AssignAppointmentDialogProps) => {
  const [errorGeneral, setErrorGeneral] = useState<string | null>(null);
  const [pista, setPista] = useState<string | null>(null);

  const formulario = useForm<ValoresAsignar, unknown, AsignarEnviado>({
    resolver: zodResolver(assignAppointmentSchema),
    defaultValues: {
      requestId: request.id,
      patientId: request.patientId,
      patientName: request.patientName,
      patientDocument: request.patientDocument ?? '',
      patientPhone: request.patientPhone ?? '',
      date: defaultDate,
      startTime: defaultStartTime ?? '',
      slotKind: 'franja',
      durationMinutes: DEFAULT_SLOT_MINUTES,
      notes: '',
      authorizeOverbook: false,
      overbookReason: '',
    },
  });

  const { setValue } = formulario;
  const fecha = formulario.watch('date') ?? defaultDate;
  const slotKind = (formulario.watch('slotKind') ?? 'franja') as SlotKind;
  const startTime = formulario.watch('startTime') ?? '';
  const durationMinutes = Number(formulario.watch('durationMinutes') ?? DEFAULT_SLOT_MINUTES);

  const diaQuery = useDayView(fecha);
  const dia = diaQuery.data;
  const refetchDia = diaQuery.refetch;
  const franjas = dia?.slots ?? [];
  const libres = franjas.filter((franja) => franja.state === 'libre');

  const puedeSobrecupo = hasPermission('scheduling:overbook');
  const completo = dia?.capacity.isFull ?? false;
  const bloqueadoPorSobrecupo = completo && !puedeSobrecupo;

  // Al abrir, o al cambiar de día, se propone la primera franja libre.
  useEffect(() => {
    if (slotKind !== 'franja') return;
    if (libres.some((franja) => franja.startTime === startTime)) return;
    const primera = libres[0];
    setValue('startTime', primera === undefined ? '' : primera.startTime, {
      shouldValidate: false,
    });
  }, [libres, slotKind, startTime, setValue]);

  // La duración acompaña a la franja elegida, también cuando viene de la rejilla.
  useEffect(() => {
    if (slotKind !== 'franja') return;
    const franja = libres.find((candidata) => candidata.startTime === startTime);
    if (franja === undefined) return;
    const esperada = Math.max(5, minutesBetween(franja.startTime, franja.endTime));
    if (durationMinutes !== esperada) {
      setValue('durationMinutes', esperada, { shouldValidate: false });
    }
  }, [libres, slotKind, startTime, durationMinutes, setValue]);

  // El sobrecupo viaja como autorización explícita, nunca por defecto.
  useEffect(() => {
    setValue('authorizeOverbook', completo && puedeSobrecupo, { shouldValidate: false });
  }, [completo, puedeSobrecupo, setValue]);

  const asignar = useMutation({
    mutationFn: (valores: AsignarEnviado) => appointmentsApi.assign(valores),
  });

  const enviar = async (valores: AsignarEnviado) => {
    if (bloqueadoPorSobrecupo) {
      setErrorGeneral(t('programacion.sobrecupo.sinPermiso'));
      return;
    }
    setErrorGeneral(null);
    setPista(null);
    try {
      const cita = await asignar.mutateAsync(valores);
      onAssigned(cita, request);
    } catch (fallo) {
      const info = schedulingErrorInfo(fallo);
      applyApiFieldErrors(formulario.setError, fallo);
      setErrorGeneral(info.message);
      setPista(info.hint);
      // El día pudo cambiar bajo los pies (franja ocupada, día completo): se
      // vuelve a pedir la jornada para que el reintento salga con datos frescos.
      void refetchDia();
    }
  };

  const { errors, isSubmitting } = formulario.formState;

  return (
    <Dialog
      open
      onClose={onClose}
      size="lg"
      title={t('programacion.asignar.titulo')}
      description={t('programacion.asignar.texto')}
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
              form="formulario-asignar-cita"
              loading={isSubmitting}
              loadingLabel={t('comun.guardando')}
            >
              {completo ? t('programacion.sobrecupo.autorizar') : t('programacion.asignar.enviar')}
            </Button>
          )}
        </>
      }
    >
      <form
        id="formulario-asignar-cita"
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
            {t('programacion.asignar.ticket', { ticket: request.ticket })} · {request.patientName}
          </p>
          <p className="pt-0.5">
            {request.patientPhone ?? t('comun.sinDato')} · {request.reason}
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
              onChange: () => {
                setValue('startTime', '', { shouldValidate: false });
              },
            })}
          />
        </Field>

        {diaQuery.isPending ? (
          <p className="text-sm text-ink-muted">{t('programacion.asignar.cargandoDia')}</p>
        ) : diaQuery.isError ? (
          <Alert variant="danger">{t('programacion.fecha.error')}</Alert>
        ) : (
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
        )}

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

        <Field label={t('programacion.asignar.notas')} error={errors.notes?.message}>
          <textarea
            rows={2}
            className="w-full rounded-control border border-border-strong bg-surface px-3 py-2 text-sm text-ink shadow-xs transition-colors placeholder:text-ink-subtle focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-solid focus-visible:outline-focus"
            {...formulario.register('notes')}
          />
        </Field>

        {startTime !== '' && (
          <p className="text-xs text-ink-subtle">
            {t('programacion.accion.hora', {
              inicio: formatTime12h(startTime),
              fin: formatTime12h(addMinutes(startTime, durationMinutes)),
            })}
          </p>
        )}
      </form>
    </Dialog>
  );
};
