import { passwordSchema, type UserSummary } from '@odontocrm/contracts';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation } from '@tanstack/react-query';
import { Alert, Button, Dialog, Field, Input } from '@odontocrm/ui';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';

import { PasswordInput } from '../PasswordInput';
import { apiErrorMessage } from '../../lib/api';
import { usersApi } from '../../lib/endpoints';
import { applyApiFieldErrors } from '../../lib/forms';
import { t } from '../../lib/i18n';

/**
 * Formulario de restablecimiento.
 *
 * `resetPasswordSchema` pide `reason` y una `newPassword` **opcional**: si se
 * omite, el servidor genera la temporal. El único ajuste sobre el esquema
 * compartido es aceptar la cadena vacía como «sin contraseña nueva» (un campo de
 * texto vacío no es `undefined`), reutilizando `passwordSchema` para validarla
 * cuando sí se escribe.
 */
const esquemaRestablecer = z
  .object({
    newPassword: z.string(),
    reason: z
      .string()
      .trim()
      .min(3, t('usuarios.reset.motivoCorto'))
      .max(300, t('usuarios.form.motivoLargo')),
  })
  .superRefine((valores, contexto) => {
    if (valores.newPassword === '') return;
    const resultado = passwordSchema.safeParse(valores.newPassword);
    if (resultado.success) return;
    contexto.addIssue({
      code: 'custom',
      path: ['newPassword'],
      message: resultado.error.issues[0]?.message ?? t('usuarios.reset.nuevaAyuda'),
    });
  });

type ValoresRestablecer = z.input<typeof esquemaRestablecer>;

export interface ResetPasswordDialogProps {
  open: boolean;
  usuario: UserSummary | null;
  onClose: () => void;
  /** Recibe la contraseña temporal, o `null` si el servidor no la devolvió. */
  onReset: (temporal: string | null) => void;
}

export const ResetPasswordDialog = ({
  open,
  usuario,
  onClose,
  onReset,
}: ResetPasswordDialogProps) => {
  const [errorGeneral, setErrorGeneral] = useState<string | null>(null);

  const formulario = useForm<ValoresRestablecer>({
    resolver: zodResolver(esquemaRestablecer),
    defaultValues: { newPassword: '', reason: '' },
  });

  const restablecer = useMutation({
    mutationFn: (valores: ValoresRestablecer) => {
      if (!usuario) throw new Error('No hay usuario seleccionado');
      return usersApi.resetPassword(usuario.id, {
        reason: valores.reason,
        ...(valores.newPassword === '' ? {} : { newPassword: valores.newPassword }),
      });
    },
  });

  const enviar = async (valores: ValoresRestablecer) => {
    setErrorGeneral(null);
    try {
      const respuesta = await restablecer.mutateAsync(valores);
      formulario.reset({ newPassword: '', reason: '' });
      onClose();
      onReset(respuesta.temporaryPassword ?? null);
    } catch (fallo) {
      if (!applyApiFieldErrors(formulario.setError, fallo)) setErrorGeneral(apiErrorMessage(fallo));
    }
  };

  const { errors, isSubmitting } = formulario.formState;

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={t('usuarios.reset.titulo', { usuario: usuario?.username ?? '' })}
      description={t('usuarios.reset.texto')}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={isSubmitting}>
            {t('comun.cancelar')}
          </Button>
          <Button
            type="submit"
            form="formulario-restablecer"
            variant="danger"
            loading={isSubmitting}
            loadingLabel={t('comun.guardando')}
          >
            {t('usuarios.reset.enviar')}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {errorGeneral && <Alert variant="danger">{errorGeneral}</Alert>}

        <form
          id="formulario-restablecer"
          noValidate
          className="space-y-4"
          onSubmit={(event) => {
            void formulario.handleSubmit(enviar)(event);
          }}
        >
          <Field
            label={t('usuarios.reset.nueva')}
            hint={t('usuarios.reset.nuevaAyuda')}
            error={errors.newPassword?.message}
          >
            <PasswordInput autoComplete="new-password" {...formulario.register('newPassword')} />
          </Field>

          <Field
            label={t('usuarios.form.motivo')}
            hint={t('usuarios.form.motivoAyuda')}
            error={errors.reason?.message}
            required
          >
            <Input
              autoComplete="off"
              placeholder={t('usuarios.form.motivoPlaceholder')}
              {...formulario.register('reason')}
            />
          </Field>
        </form>
      </div>
    </Dialog>
  );
};
