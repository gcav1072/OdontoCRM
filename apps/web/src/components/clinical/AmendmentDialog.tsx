import { createAmendmentSchema, type ClinicalSectionKey } from '@odontocrm/contracts';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation } from '@tanstack/react-query';
import { Alert, Button, Dialog, Field, Input, Select } from '@odontocrm/ui';
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import type { z } from 'zod';

import { apiErrorMessage } from '../../lib/api';
import { CLINICAL_SECTION_ORDER, clinicalSectionLabel } from '../../lib/clinical';
import { clinicalApi } from '../../lib/endpoints';
import { applyApiFieldErrors } from '../../lib/forms';
import { t } from '../../lib/i18n';

type Valores = z.input<typeof createAmendmentSchema>;
type Enviados = z.output<typeof createAmendmentSchema>;

export interface AmendmentDialogProps {
  open: boolean;
  recordId: string;
  onClose: () => void;
  onDone: () => void;
}

/**
 * Adenda a una historia firmada: la única forma de corregirla. Exige motivo
 * (queda en la auditoría) y deja el texto fechado y firmado por su autor.
 */
export const AmendmentDialog = ({ open, recordId, onClose, onDone }: AmendmentDialogProps) => {
  const [errorGeneral, setErrorGeneral] = useState<string | null>(null);

  const formulario = useForm<Valores, unknown, Enviados>({
    resolver: zodResolver(createAmendmentSchema),
    defaultValues: { sectionKey: null, reason: '', content: '' },
  });

  const { reset } = formulario;
  useEffect(() => {
    if (!open) return;
    setErrorGeneral(null);
    reset({ sectionKey: null, reason: '', content: '' });
  }, [open, reset]);

  const crear = useMutation({
    mutationFn: (valores: Enviados) => clinicalApi.addAmendment(recordId, valores),
  });

  const enviar = async (valores: Enviados): Promise<void> => {
    setErrorGeneral(null);
    try {
      await crear.mutateAsync(valores);
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
      title={t('clinica.adenda.titulo')}
      description={t('clinica.adenda.texto')}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={isSubmitting}>
            {t('comun.cancelar')}
          </Button>
          <Button
            type="submit"
            form="formulario-adenda"
            loading={isSubmitting}
            loadingLabel={t('comun.guardando')}
          >
            {t('clinica.adenda.registrar')}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {errorGeneral && <Alert variant="danger">{errorGeneral}</Alert>}

        <form
          id="formulario-adenda"
          noValidate
          className="space-y-4"
          onSubmit={(event) => {
            void formulario.handleSubmit(enviar)(event);
          }}
        >
          <Field
            label={t('clinica.adenda.seccion')}
            hint={t('clinica.adenda.seccionAyuda')}
            error={errors.sectionKey?.message}
          >
            <Select {...formulario.register('sectionKey')}>
              <option value="">{t('clinica.adenda.general')}</option>
              {CLINICAL_SECTION_ORDER.map((key: ClinicalSectionKey) => (
                <option key={key} value={key}>
                  {clinicalSectionLabel(key)}
                </option>
              ))}
            </Select>
          </Field>

          <Field label={t('clinica.adenda.motivo')} error={errors.reason?.message} required>
            <Input
              placeholder={t('clinica.adenda.motivoPlaceholder')}
              {...formulario.register('reason')}
            />
          </Field>

          <Field label={t('clinica.adenda.contenido')} error={errors.content?.message} required>
            <Input {...formulario.register('content')} />
          </Field>
        </form>
      </div>
    </Dialog>
  );
};
