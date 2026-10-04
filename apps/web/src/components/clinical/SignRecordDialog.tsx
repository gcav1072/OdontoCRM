import type { ClinicalRecordDetail } from '@odontocrm/contracts';
import { useMutation } from '@tanstack/react-query';
import { Alert, Button, Dialog } from '@odontocrm/ui';
import { useState } from 'react';

import { apiErrorMessage } from '../../lib/api';
import { clinicalSectionLabel } from '../../lib/clinical';
import { clinicalApi } from '../../lib/endpoints';
import { t } from '../../lib/i18n';

export interface SignRecordDialogProps {
  open: boolean;
  record: ClinicalRecordDetail;
  onClose: () => void;
  onSigned: (detail: ClinicalRecordDetail) => void;
}

/**
 * Firma de la historia. El servidor vuelve a comprobar secciones y
 * consentimiento (no se fía de la interfaz), así que el diálogo solo explica por
 * qué no se puede firmar todavía.
 */
export const SignRecordDialog = ({ open, record, onClose, onSigned }: SignRecordDialogProps) => {
  const [errorGeneral, setErrorGeneral] = useState<string | null>(null);

  const firmar = useMutation({
    mutationFn: () => clinicalApi.sign(record.id),
  });

  const faltantes = record.missingSections;
  const puedeFirmar = faltantes.length === 0 && record.consentAccepted;

  const confirmar = async (): Promise<void> => {
    setErrorGeneral(null);
    try {
      const detail = await firmar.mutateAsync();
      onClose();
      onSigned(detail);
    } catch (fallo) {
      setErrorGeneral(apiErrorMessage(fallo));
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={t('clinica.firma.titulo')}
      description={t('clinica.firma.texto')}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={firmar.isPending}>
            {t('comun.cancelar')}
          </Button>
          <Button
            variant="primary"
            disabled={!puedeFirmar}
            loading={firmar.isPending}
            onClick={() => void confirmar()}
          >
            {t('clinica.firma.firmar')}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {errorGeneral && <Alert variant="danger">{errorGeneral}</Alert>}

        {puedeFirmar ? (
          <Alert variant="warning">{t('clinica.firma.aviso')}</Alert>
        ) : (
          <Alert variant="danger" title={t('clinica.firma.bloqueada')}>
            <ul className="list-inside list-disc space-y-1">
              {faltantes.map((key) => (
                <li key={key}>{clinicalSectionLabel(key)}</li>
              ))}
              {!record.consentAccepted && <li>{t('clinica.consentimiento.titulo')}</li>}
            </ul>
          </Alert>
        )}
      </div>
    </Dialog>
  );
};
