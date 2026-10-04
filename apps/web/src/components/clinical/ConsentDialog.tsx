import { acceptConsentSchema, type ClinicalPatientSnapshot } from '@odontocrm/contracts';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation } from '@tanstack/react-query';
import { Alert, Button, Dialog, Field, Input } from '@odontocrm/ui';
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import type { z } from 'zod';

import { apiErrorMessage } from '../../lib/api';
import { clinicalApi } from '../../lib/endpoints';
import { applyApiFieldErrors } from '../../lib/forms';
import { t } from '../../lib/i18n';

type Valores = z.input<typeof acceptConsentSchema>;
type Enviados = z.output<typeof acceptConsentSchema>;

export interface ConsentDialogProps {
  open: boolean;
  recordId: string;
  patient: ClinicalPatientSnapshot | null;
  onClose: () => void;
  onDone: () => void;
}

/**
 * Consentimiento informado: se registra **antes** de firmar la historia (el
 * servidor no deja firmar sin él) y guarda quién aceptó, su relación con el
 * paciente y ante quién.
 */
export const ConsentDialog = ({ open, recordId, patient, onClose, onDone }: ConsentDialogProps) => {
  const [errorGeneral, setErrorGeneral] = useState<string | null>(null);

  const formulario = useForm<Valores, unknown, Enviados>({
    resolver: zodResolver(acceptConsentSchema),
    defaultValues: {
      accepted: true,
      acceptedByName: '',
      acceptedByDocument: null,
      relationship: 'paciente',
      witnessName: null,
      notes: null,
    },
  });

  const { reset } = formulario;
  useEffect(() => {
    if (!open) return;
    setErrorGeneral(null);
    reset({
      accepted: true,
      acceptedByName: patient?.fullName ?? '',
      acceptedByDocument: null,
      relationship: 'paciente',
      witnessName: null,
      notes: null,
    });
  }, [open, patient, reset]);

  const registrar = useMutation({
    mutationFn: (valores: Enviados) => clinicalApi.acceptConsent(recordId, valores),
  });

  const enviar = async (valores: Enviados): Promise<void> => {
    setErrorGeneral(null);
    try {
      await registrar.mutateAsync(valores);
      onClose();
      onDone();
    } catch (fallo) {
      if (!applyApiFieldErrors(formulario.setError, fallo)) {
        setErrorGeneral(apiErrorMessage(fallo));
      }
    }
  };

  const { errors, isSubmitting } = formulario.formState;

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={t('clinica.consentimiento.titulo')}
      description={t('clinica.consentimiento.texto')}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={isSubmitting}>
            {t('comun.cancelar')}
          </Button>
          <Button
            type="submit"
            form="formulario-consentimiento"
            loading={isSubmitting}
            loadingLabel={t('comun.guardando')}
          >
            {t('clinica.consentimiento.registrar')}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {errorGeneral && <Alert variant="danger">{errorGeneral}</Alert>}

        <form
          id="formulario-consentimiento"
          noValidate
          className="space-y-4"
          onSubmit={(event) => {
            void formulario.handleSubmit(enviar)(event);
          }}
        >
          <Field
            label={t('clinica.consentimiento.acepta')}
            error={errors.acceptedByName?.message}
            required
          >
            <Input autoFocus {...formulario.register('acceptedByName')} />
          </Field>

          <Field
            label={t('clinica.consentimiento.documento')}
            error={errors.acceptedByDocument?.message}
          >
            <Input {...formulario.register('acceptedByDocument')} />
          </Field>

          <Field
            label={t('clinica.consentimiento.relacion')}
            hint={t('clinica.consentimiento.relacionAyuda')}
            error={errors.relationship?.message}
            required
          >
            <Input {...formulario.register('relationship')} />
          </Field>

          <Field label={t('clinica.consentimiento.testigo')} error={errors.witnessName?.message}>
            <Input {...formulario.register('witnessName')} />
          </Field>

          <Field label={t('clinica.campo.observaciones')} error={errors.notes?.message}>
            <Input {...formulario.register('notes')} />
          </Field>
        </form>
      </div>
    </Dialog>
  );
};
