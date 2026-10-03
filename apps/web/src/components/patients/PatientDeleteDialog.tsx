import { deletePatientSchema, type PatientDetail } from '@odontocrm/contracts';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation } from '@tanstack/react-query';
import { Alert, Button, Dialog, Field, Input } from '@odontocrm/ui';
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import type { z } from 'zod';

import { apiErrorMessage } from '../../lib/api';
import { patientsApi } from '../../lib/endpoints';
import { applyApiFieldErrors } from '../../lib/forms';
import { t } from '../../lib/i18n';

type ValoresBorrado = z.input<typeof deletePatientSchema>;
type ValoresEnviados = z.output<typeof deletePatientSchema>;

export interface PatientDeleteDialogProps {
  open: boolean;
  patient: PatientDetail | null;
  onClose: () => void;
  onDone: () => void;
}

/**
 * Borrado **lógico** de un paciente (ADR 0027). Solo el `admin` llega a ver este
 * diálogo (`patients:delete`) y el contrato exige **motivo**: nada se destruye,
 * pero el paciente sale de listas y búsquedas y el documento vuelve a quedar
 * libre. El borrado queda en la auditoría como cualquier otro cambio.
 */
export const PatientDeleteDialog = ({
  open,
  patient,
  onClose,
  onDone,
}: PatientDeleteDialogProps) => {
  const [errorGeneral, setErrorGeneral] = useState<string | null>(null);

  const formulario = useForm<ValoresBorrado, unknown, ValoresEnviados>({
    resolver: zodResolver(deletePatientSchema),
    defaultValues: { reason: '' },
  });

  const { reset } = formulario;
  useEffect(() => {
    if (!open) return;
    setErrorGeneral(null);
    reset({ reason: '' });
  }, [open, reset]);

  const borrar = useMutation({
    mutationFn: (valores: ValoresEnviados) => {
      if (!patient) throw new Error('No hay paciente seleccionado');
      return patientsApi.remove(patient.id, valores);
    },
  });

  const enviar = async (valores: ValoresEnviados) => {
    setErrorGeneral(null);
    try {
      await borrar.mutateAsync(valores);
      onClose();
      onDone();
    } catch (fallo) {
      if (!applyApiFieldErrors(formulario.setError, fallo)) setErrorGeneral(apiErrorMessage(fallo));
    }
  };

  const { errors, isSubmitting } = formulario.formState;

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={t('pacientes.borrar.titulo', { paciente: patient?.fullName ?? '' })}
      description={t('pacientes.borrar.texto')}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={isSubmitting}>
            {t('comun.cancelar')}
          </Button>
          <Button
            type="submit"
            form="formulario-borrar-paciente"
            variant="danger"
            loading={isSubmitting}
            loadingLabel={t('comun.guardando')}
          >
            {t('pacientes.borrar.enviar')}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {errorGeneral && <Alert variant="danger">{errorGeneral}</Alert>}

        <Alert variant="warning" title={patient?.document ?? ''}>
          {t('pacientes.borrar.aviso')}
        </Alert>

        <form
          id="formulario-borrar-paciente"
          noValidate
          className="space-y-4"
          onSubmit={(event) => {
            void formulario.handleSubmit(enviar)(event);
          }}
        >
          <Field label={t('pacientes.borrar.motivo')} error={errors.reason?.message} required>
            <Input
              placeholder={t('pacientes.borrar.motivoPlaceholder')}
              autoFocus
              {...formulario.register('reason')}
            />
          </Field>
        </form>
      </div>
    </Dialog>
  );
};
