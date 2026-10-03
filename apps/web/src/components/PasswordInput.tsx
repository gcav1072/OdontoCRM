import { Input, type InputProps } from '@odontocrm/ui';
import { Eye, EyeOff } from 'lucide-react';
import { forwardRef, useState } from 'react';

import { t } from '../lib/i18n';

export type PasswordInputProps = Omit<InputProps, 'type'>;

/**
 * Campo de contraseña con botón para mostrarla u ocultarla. Escribir a ciegas en
 * un mostrador compartido genera errores tontos; poder verificar lo tecleado los
 * evita sin sacrificar el ocultado por defecto.
 */
export const PasswordInput = forwardRef<HTMLInputElement, PasswordInputProps>(
  function PasswordInput({ className, ...rest }, ref) {
    const [visible, setVisible] = useState(false);

    return (
      <div className="relative">
        <Input
          ref={ref}
          type={visible ? 'text' : 'password'}
          className={`pr-11 ${className ?? ''}`}
          {...rest}
        />
        <button
          type="button"
          onClick={() => setVisible((valor) => !valor)}
          aria-pressed={visible}
          aria-label={visible ? t('login.ocultarContrasena') : t('login.mostrarContrasena')}
          className="absolute inset-y-0 right-0 grid w-10 place-items-center rounded-control text-ink-subtle transition-colors hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-solid focus-visible:outline-focus"
        >
          {visible ? (
            <EyeOff className="size-4" aria-hidden="true" />
          ) : (
            <Eye className="size-4" aria-hidden="true" />
          )}
        </button>
      </div>
    );
  },
);
