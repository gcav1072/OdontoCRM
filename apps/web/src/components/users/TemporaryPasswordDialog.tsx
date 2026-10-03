import { Alert, Button, Dialog } from '@odontocrm/ui';
import { Check, Copy } from 'lucide-react';
import { useState } from 'react';

import { t } from '../../lib/i18n';

export interface TemporaryPasswordDialogProps {
  open: boolean;
  usuario: string;
  /** Cadena que se muestra una sola vez; `null` si el servidor no la devolvió. */
  contrasena: string | null;
  onClose: () => void;
}

/**
 * Contraseña temporal recién generada. Se enseña **una sola vez** (el servidor
 * solo guarda su hash): al cerrar el diálogo, la página descarta el valor.
 */
export const TemporaryPasswordDialog = ({
  open,
  usuario,
  contrasena,
  onClose,
}: TemporaryPasswordDialogProps) => {
  const [copiada, setCopiada] = useState(false);

  const copiar = async () => {
    if (contrasena === null) return;
    try {
      await navigator.clipboard.writeText(contrasena);
      setCopiada(true);
    } catch {
      // Sin permiso de portapapeles: se puede seleccionar el texto a mano.
      setCopiada(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={() => {
        setCopiada(false);
        onClose();
      }}
      title={t('usuarios.reset.temporalTitulo')}
      description={usuario}
      footer={
        <Button
          onClick={() => {
            setCopiada(false);
            onClose();
          }}
        >
          {t('comun.aceptar')}
        </Button>
      }
    >
      <div className="space-y-4">
        {contrasena === null ? (
          <Alert variant="warning">{t('usuarios.reset.sinTemporal')}</Alert>
        ) : (
          <>
            <Alert variant="warning">{t('usuarios.reset.temporalAviso')}</Alert>

            <div className="flex items-center gap-2">
              <code className="min-w-0 flex-1 truncate rounded-control border border-border bg-surface-muted px-3 py-2.5 font-mono text-sm text-ink select-all">
                {contrasena}
              </code>
              <Button
                variant="secondary"
                onClick={() => void copiar()}
                leadingIcon={
                  copiada ? (
                    <Check className="size-4 text-success" aria-hidden="true" />
                  ) : (
                    <Copy className="size-4" aria-hidden="true" />
                  )
                }
              >
                {copiada ? t('comun.copiado') : t('comun.copiar')}
              </Button>
            </div>

            <p aria-live="polite" className="text-xs text-ink-subtle">
              {copiada ? t('usuarios.reset.copiada') : ''}
            </p>
          </>
        )}
      </div>
    </Dialog>
  );
};
