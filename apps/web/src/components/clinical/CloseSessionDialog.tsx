import { Alert, Button, Checkbox, Dialog, Field } from '@odontocrm/ui';
import { useState } from 'react';

import { t } from '../../lib/i18n';

/**
 * Cierre de la sesión: pregunta una vez, porque después **no se puede editar**.
 *
 * La corrección de una sesión cerrada no reescribe lo hecho: abre una sesión
 * enmendada con su motivo (lo explica el diálogo para que nadie se lleve la
 * sorpresa).
 */

const TEXTAREA_CLASSES =
  'w-full rounded-control border border-border-strong bg-surface px-3 py-2 text-sm text-ink shadow-xs transition-colors placeholder:text-ink-subtle focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-solid focus-visible:outline-focus';

export interface CloseSessionDialogProps {
  open: boolean;
  loading: boolean;
  /**
   * Al cerrar, ¿se abre el récipe? Es la pregunta que pide el plan
   * («¿Desea guardar el récipe?») y solo se hace si el doctor puede escribirlo.
   */
  canPrescribe?: boolean;
  onClose: () => void;
  onConfirm: (values: { closureNote: string | null; conRecipe: boolean }) => void;
}

export const CloseSessionDialog = ({
  open,
  loading,
  canPrescribe = false,
  onClose,
  onConfirm,
}: CloseSessionDialogProps) => {
  const [nota, setNota] = useState('');
  const [conRecipe, setConRecipe] = useState(false);

  if (!open) return null;

  return (
    <Dialog
      open
      onClose={onClose}
      title={t('clinica.sesion.cerrar.titulo')}
      description={t('clinica.sesion.cerrar.texto')}
      dismissOnBackdrop={false}
      closeLabel={t('comun.cerrar')}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={loading}>
            {t('comun.cancelar')}
          </Button>
          <Button
            loading={loading}
            loadingLabel={t('comun.guardando')}
            onClick={() =>
              onConfirm({
                closureNote: nota.trim() === '' ? null : nota.trim(),
                conRecipe,
              })
            }
          >
            {t('clinica.sesion.cerrar.confirmar')}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Alert variant="warning">{t('clinica.sesion.cerrar.aviso')}</Alert>

        {canPrescribe && (
          <label className="flex cursor-pointer items-start gap-3 rounded-control border border-border p-3">
            <Checkbox
              checked={conRecipe}
              onChange={(evento) => setConRecipe(evento.target.checked)}
            />
            <span>
              <span className="block text-sm font-medium text-ink">
                {t('clinica.sesion.cerrar.preguntaRecipe')}
              </span>
              <span className="block text-xs text-ink-muted">
                {t('clinica.sesion.cerrar.preguntaRecipeAyuda')}
              </span>
            </span>
          </label>
        )}

        <Field label={t('clinica.sesion.cerrar.nota')} hint={t('clinica.sesion.cerrar.notaAyuda')}>
          <textarea
            className={TEXTAREA_CLASSES}
            rows={3}
            value={nota}
            onChange={(event) => setNota(event.target.value)}
          />
        </Field>
      </div>
    </Dialog>
  );
};
