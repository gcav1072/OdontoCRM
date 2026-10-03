import { MAX_DAY_CAPACITY, setCapacitySchema, type DayCapacity } from '@odontocrm/contracts';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation } from '@tanstack/react-query';
import { Alert, Button, Dialog, Field, Input } from '@odontocrm/ui';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import type { z } from 'zod';

import { apiErrorMessage } from '../../lib/api';
import { agendaApi } from '../../lib/endpoints';
import { applyApiFieldErrors } from '../../lib/forms';
import { formatDateOnly } from '../../lib/scheduling';
import { t } from '../../lib/i18n';

type ValoresCupo = z.input<typeof setCapacitySchema>;
type CupoEnviado = z.output<typeof setCapacitySchema>;

export interface CapacityDialogProps {
  capacity: DayCapacity;
  onClose: () => void;
  onSaved: (capacity: DayCapacity) => void;
}

/**
 * Cupo del día (0–100) con notas y motivo. Se puede cambiar en cualquier
 * momento; si el cupo queda por debajo de lo ya asignado el servidor responde
 * 200 con `warning` y **no borra** ninguna cita: aquí se muestra ese aviso
 * destacado antes de cerrar.
 */
export const CapacityDialog = ({ capacity, onClose, onSaved }: CapacityDialogProps) => {
  const [errorGeneral, setErrorGeneral] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);

  const formulario = useForm<ValoresCupo, unknown, CupoEnviado>({
    resolver: zodResolver(setCapacitySchema),
    defaultValues: {
      date: capacity.date,
      capacity: capacity.capacity,
      notes: capacity.notes ?? '',
      reason: '',
    },
  });

  const guardar = useMutation({
    mutationFn: (valores: CupoEnviado) => agendaApi.setCapacity(valores),
  });

  const enviar = async (valores: CupoEnviado) => {
    setErrorGeneral(null);
    try {
      const actualizado = await guardar.mutateAsync(valores);
      onSaved(actualizado);
      if (actualizado.warning !== null) setAviso(actualizado.warning);
      else onClose();
    } catch (fallo) {
      if (!applyApiFieldErrors(formulario.setError, fallo)) {
        setErrorGeneral(apiErrorMessage(fallo));
      }
    }
  };

  const { errors, isSubmitting } = formulario.formState;
  const cupoEscrito = Number(formulario.watch('capacity') ?? 0);
  const porDebajo = cupoEscrito < capacity.assigned;

  if (aviso !== null) {
    return (
      <Dialog
        open
        onClose={onClose}
        title={t('programacion.cupo.aviso')}
        description={t('programacion.cupo.dialogoTitulo', {
          fecha: formatDateOnly(capacity.date),
        })}
        closeLabel={t('comun.cerrar')}
        footer={
          <Button onClick={onClose} variant="secondary">
            {t('comun.cerrar')}
          </Button>
        }
      >
        <Alert variant="warning">{aviso}</Alert>
      </Dialog>
    );
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title={t('programacion.cupo.dialogoTitulo', { fecha: formatDateOnly(capacity.date) })}
      description={t('programacion.cupo.dialogoTexto')}
      closeLabel={t('comun.cerrar')}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={isSubmitting}>
            {t('comun.cancelar')}
          </Button>
          <Button
            type="submit"
            form="formulario-cupo"
            loading={isSubmitting}
            loadingLabel={t('comun.guardando')}
          >
            {t('comun.guardar')}
          </Button>
        </>
      }
    >
      <form
        id="formulario-cupo"
        noValidate
        className="space-y-4"
        onSubmit={(event) => {
          void formulario.handleSubmit(enviar)(event);
        }}
      >
        {errorGeneral !== null && <Alert variant="danger">{errorGeneral}</Alert>}

        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label={t('programacion.cupo.numero')}
            hint={t('programacion.cupo.numeroAyuda', { max: MAX_DAY_CAPACITY })}
            error={errors.capacity?.message}
            required
          >
            <Input
              type="number"
              min={0}
              max={MAX_DAY_CAPACITY}
              inputMode="numeric"
              invalid={porDebajo}
              {...formulario.register('capacity')}
            />
          </Field>

          <Field label={t('programacion.cupo.motivo')} error={errors.reason?.message}>
            <Input autoComplete="off" {...formulario.register('reason')} />
          </Field>
        </div>

        {porDebajo && (
          <Alert variant="warning" title={t('programacion.cupo.aviso')}>
            {t('programacion.cupo.avisoPrevio', {
              cupo: cupoEscrito,
              asignados: capacity.assigned,
            })}
          </Alert>
        )}

        <Field label={t('programacion.cupo.notas')} error={errors.notes?.message}>
          <textarea
            rows={2}
            className="w-full rounded-control border border-border-strong bg-surface px-3 py-2 text-sm text-ink shadow-xs transition-colors placeholder:text-ink-subtle focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-solid focus-visible:outline-focus"
            {...formulario.register('notes')}
          />
        </Field>
      </form>
    </Dialog>
  );
};
