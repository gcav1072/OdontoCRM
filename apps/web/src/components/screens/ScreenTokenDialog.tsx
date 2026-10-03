import { Alert, Button, Dialog, Field, Input, buttonClasses } from '@odontocrm/ui';
import { Check, Copy, ExternalLink } from 'lucide-react';
import { useState } from 'react';

import { t } from '../../lib/i18n';

/**
 * Enlace de configuración de la pantalla, con su token.
 *
 * El token de dispositivo **se muestra una sola vez** (en la base solo queda su
 * hash): este diálogo no se puede reabrir, así que avisa de ello y ofrece copiar
 * el enlace y abrirlo en una pestaña nueva, que es lo que se hace en el equipo
 * del televisor. También se deja seleccionable a mano por si el portapapeles
 * está bloqueado (navegadores sin HTTPS o sin permiso).
 */
export interface ScreenTokenDialogProps {
  /** Nombre de la pantalla recién registrada. */
  label: string;
  /** Enlace del kiosko (`kioskUrl`), con el token dentro. */
  url: string;
  onClose: () => void;
}

export const ScreenTokenDialog = ({ label, url, onClose }: ScreenTokenDialogProps) => {
  const [copiado, setCopiado] = useState(false);
  const [errorCopiar, setErrorCopiar] = useState(false);

  const copiar = async (): Promise<void> => {
    setErrorCopiar(false);
    try {
      await navigator.clipboard.writeText(url);
      setCopiado(true);
    } catch {
      // El portapapeles puede estar bloqueado: el enlace queda visible para
      // copiarlo a mano y se avisa de que no se pudo.
      setCopiado(false);
      setErrorCopiar(true);
    }
  };

  return (
    <Dialog
      open
      onClose={onClose}
      size="md"
      title={t('pantallas.token.titulo')}
      description={label}
      dismissOnBackdrop={false}
      closeLabel={t('comun.cerrar')}
      footer={
        <Button variant="secondary" onClick={onClose}>
          {t('comun.cerrar')}
        </Button>
      }
    >
      <div className="space-y-4">
        <Alert variant="warning">{t('pantallas.token.texto')}</Alert>

        {copiado && <Alert variant="success">{t('pantallas.token.copiado')}</Alert>}
        {errorCopiar && <Alert variant="danger">{t('pantallas.token.copiarError')}</Alert>}

        <Field label={t('pantallas.token.enlace')}>
          <Input
            readOnly
            value={url}
            className="font-mono text-xs"
            onFocus={(event) => event.currentTarget.select()}
          />
        </Field>

        <div className="flex flex-wrap gap-2">
          <Button
            variant="secondary"
            leadingIcon={
              copiado ? (
                <Check className="size-4" aria-hidden="true" />
              ) : (
                <Copy className="size-4" aria-hidden="true" />
              )
            }
            onClick={() => void copiar()}
          >
            {copiado ? t('comun.copiado') : t('pantallas.token.copiar')}
          </Button>

          {/* Enlace nativo y no `window.open`: así el navegador no lo bloquea
              como ventana emergente y el usuario decide dónde abrirlo. */}
          <a
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            className={buttonClasses({ variant: 'secondary' })}
          >
            <ExternalLink className="size-4" aria-hidden="true" />
            {t('pantallas.token.abrir')}
          </a>
        </div>
      </div>
    </Dialog>
  );
};
