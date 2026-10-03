import {
  changePatientStatusSchema,
  type PatientDetail,
  type PatientStatus,
} from '@odontocrm/contracts';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation } from '@tanstack/react-query';
import { Alert, Button, Dialog, Field, Input, Select } from '@odontocrm/ui';
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import type { z } from 'zod';

import { apiErrorMessage } from '../../lib/api';
import { patientsApi } from '../../lib/endpoints';
import { applyApiFieldErrors } from '../../lib/forms';
import { PATIENT_STATUS_LABELS, t } from '../../lib/i18n';

type ValoresEstado = z.input<typeof changePatientStatusSchema>;
type ValoresEnviados = z.output<typeof changePatientStatusSchema>;

const ESTADOS: readonly PatientStatus[] = ['en_espera_cita', 'activo', 'inactivo'];

const textoDe = (estado: PatientStatus): string => {
  if (estado === 'activo') return t('pacientes.estado.activoTexto');
  if (estado === 'inactivo') return t('pacientes.estado.inactivoTexto');
  return t('pacientes.estado.esperaTexto');
};

export interface PatientStatusDialogProps {
  open: boolean;
  patient: PatientDetail | null;
  onClose: () => void;
  onDone: (patient: PatientDetail) => void;
}

/**
 * Activar o inactivar un paciente. El estado no es un interruptor: el contrato
 * exige **motivo** (`changePatientStatusSchema.reason`) y el servidor lo guarda
 * en la auditoría con el cambio.
 */
export const PatientStatusDialog = ({
  open,
  patient,
  onClose,
  onDone,
}: PatientStatusDialogProps) => {
  const [errorGeneral, setErrorGeneral] = useState<string | null>(null);

  const formulario = useForm<ValoresEstado, unknown, ValoresEnviados>({
    resolver: zodResolver(changePatientStatusSchema),
    defaultValues: { status: 'activo', reason: '' },
  });

  const { reset } = formulario;
  useEffect(() => {
    if (!open || !patient) return;
    setErrorGeneral(null);
    reset({ status: patient.status === 'activo' ? 'inactivo' : 'activo', reason: '' });
  }, [open, patient, reset]);

  const cambiar = useMutation({
    mutationFn: (valores: ValoresEnviados) => {
      if (!patient) throw new Error('No hay paciente seleccionado');
      return patientsApi.changeStatus(patient.id, valores);
    },
  });

  const estadoElegido = formulario.watch('status') ?? 'activo';

  const enviar = async (valores: ValoresEnviados) => {
    setErrorGeneral(null);
    try {
      const actualizado = await cambiar.mutateAsync(valores);
      onClose();
      onDone(actualizado);
    } catch (fallo) {
      if (!applyApiFieldErrors(formulario.setError, fallo)) setErrorGeneral(apiErrorMessage(fallo));
    }
  };

  const { errors, isSubmitting } = formulario.formState;

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={t('pacientes.estado.titulo', { paciente: patient?.fullName ?? '' })}
      description={t('pacientes.estado.texto')}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={isSubmitting}>
            {t('comun.cancelar')}
          </Button>
          <Button
            type="submit"
            form="formulario-estado-paciente"
            variant={estadoElegido === 'inactivo' ? 'danger' : 'primary'}
            loading={isSubmitting}
            loadingLabel={t('comun.guardando')}
          >
            {t('comun.guardar')}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {errorGeneral && <Alert variant="danger">{errorGeneral}</Alert>}

        <Alert variant={estadoElegido === 'inactivo' ? 'warning' : 'info'}>
          {textoDe(estadoElegido)}
        </Alert>

        <form
          id="formulario-estado-paciente"
          noValidate
          className="space-y-4"
          onSubmit={(event) => {
            void formulario.handleSubmit(enviar)(event);
          }}
        >
          <Field label={t('pacientes.estado.nuevo')} error={errors.status?.message} required>
            <Select {...formulario.register('status')}>
              {ESTADOS.map((estado) => (
                <option key={estado} value={estado}>
                  {PATIENT_STATUS_LABELS[estado]}
                </option>
              ))}
            </Select>
          </Field>

          <Field
            label={t('pacientes.estado.motivo')}
            hint={t('pacientes.editar.motivoTexto')}
            error={errors.reason?.message}
            required
          >
            <Input
              placeholder={t('pacientes.editar.motivoPlaceholder')}
              {...formulario.register('reason')}
            />
          </Field>
        </form>
      </div>
    </Dialog>
  );
};
