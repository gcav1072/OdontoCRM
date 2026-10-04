import type { ClinicalSessionSummary } from '@odontocrm/contracts';
import { Alert, Button, Dialog, Field, Input } from '@odontocrm/ui';
import { useEffect, useState } from 'react';

import { sessionNumberLabel } from '../../lib/clinical-session';
import { t } from '../../lib/i18n';

/**
 * Enmienda de una sesión cerrada: pide el motivo y abre una sesión **nueva** en
 * borrador con el contenido copiado. Lo que se hizo no se reescribe.
 */

/** Longitud mínima del motivo; el servidor aplica la misma regla. */
const MOTIVO_MINIMO = 3;

export interface AmendSessionDialogProps {
  open: boolean;
  session: ClinicalSessionSummary | null;
  loading: boolean;
  onClose: () => void;
  onConfirm: (values: { reason: string }) => void;
}

export const AmendSessionDialog = ({
  open,
  session,
  loading,
  onClose,
  onConfirm,
}: AmendSessionDialogProps) => {
  const [motivo, setMotivo] = useState('');
  const [error, setError] = useState<string | null>(null);

  // Cada sesión se corrige con su propio motivo: el campo no arrastra el anterior.
  useEffect(() => {
    if (open) {
      setMotivo('');
      setError(null);
    }
  }, [open, session?.id]);

  if (!open || session === null) return null;

  const enviar = (): void => {
    const limpio = motivo.trim();
    if (limpio.length < MOTIVO_MINIMO) {
      setError(t('clinica.sesion.corregir.motivoCorto'));
      return;
    }
    setError(null);
    onConfirm({ reason: limpio });
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title={t('clinica.sesion.corregir.titulo', {
        numero: sessionNumberLabel(session.sessionNumber),
      })}
      description={t('clinica.sesion.corregir.texto')}
      dismissOnBackdrop={false}
      closeLabel={t('comun.cerrar')}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={loading}>
            {t('comun.cancelar')}
          </Button>
          <Button loading={loading} loadingLabel={t('comun.guardando')} onClick={enviar}>
            {t('clinica.sesion.corregir.confirmar')}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Alert variant="info">{t('clinica.sesion.corregir.aviso')}</Alert>
        <Field
          label={t('clinica.sesion.corregir.motivo')}
          error={error ?? undefined}
          required
          hint={t('clinica.sesion.corregir.motivoAyuda')}
        >
          <Input
            autoComplete="off"
            value={motivo}
            onChange={(event) => setMotivo(event.target.value)}
          />
        </Field>
      </div>
    </Dialog>
  );
};
