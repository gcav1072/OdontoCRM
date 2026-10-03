import { updateUserSchema, type UserSummary } from '@odontocrm/contracts';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation } from '@tanstack/react-query';
import { Alert, Button, Dialog, Field, Input } from '@odontocrm/ui';
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import type { z } from 'zod';

import { apiErrorMessage } from '../../lib/api';
import { usersApi } from '../../lib/endpoints';
import { applyApiFieldErrors } from '../../lib/forms';
import { t } from '../../lib/i18n';

/** Solo el motivo: el resto del `PATCH` lo pone este diálogo. */
const esquemaMotivo = updateUserSchema.pick({ reason: true });
type ValoresMotivo = z.input<typeof esquemaMotivo>;

export interface UserStatusDialogProps {
  open: boolean;
  usuario: UserSummary | null;
  onClose: () => void;
  onDone: (mensaje: string) => void;
}

/**
 * Activar o desactivar una cuenta. `PATCH /users/:id` exige motivo, así que la
 * acción no es un simple interruptor: se pide la justificación que irá a la
 * auditoría.
 */
export const UserStatusDialog = ({ open, usuario, onClose, onDone }: UserStatusDialogProps) => {
  const [errorGeneral, setErrorGeneral] = useState<string | null>(null);
  const activar = usuario !== null && !usuario.isActive;

  const formulario = useForm<ValoresMotivo>({
    resolver: zodResolver(esquemaMotivo),
    defaultValues: { reason: '' },
  });

  const { reset } = formulario;
  useEffect(() => {
    if (!open) return;
    setErrorGeneral(null);
    reset({ reason: '' });
  }, [open, reset]);

  const cambiar = useMutation({
    mutationFn: (motivo: string) => {
      if (!usuario) throw new Error('No hay usuario seleccionado');
      return usersApi.update(usuario.id, { isActive: activar, reason: motivo });
    },
  });

  const enviar = async (valores: ValoresMotivo) => {
    setErrorGeneral(null);
    try {
      await cambiar.mutateAsync(valores.reason);
      onClose();
      onDone(activar ? t('usuarios.activado') : t('usuarios.desactivado'));
    } catch (fallo) {
      if (!applyApiFieldErrors(formulario.setError, fallo)) setErrorGeneral(apiErrorMessage(fallo));
    }
  };

  const { errors, isSubmitting } = formulario.formState;

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={
        activar
          ? t('usuarios.acciones.activarTitulo', { usuario: usuario?.username ?? '' })
          : t('usuarios.acciones.desactivarTitulo', { usuario: usuario?.username ?? '' })
      }
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={isSubmitting}>
            {t('comun.cancelar')}
          </Button>
          <Button
            type="submit"
            form="formulario-estado-usuario"
            variant={activar ? 'primary' : 'danger'}
            loading={isSubmitting}
            loadingLabel={t('comun.guardando')}
          >
            {activar ? t('usuarios.acciones.activar') : t('usuarios.acciones.desactivar')}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {errorGeneral && <Alert variant="danger">{errorGeneral}</Alert>}

        <Alert variant={activar ? 'info' : 'warning'}>
          {activar ? t('usuarios.acciones.activarTexto') : t('usuarios.acciones.desactivarTexto')}
        </Alert>

        <form
          id="formulario-estado-usuario"
          noValidate
          className="space-y-4"
          onSubmit={(event) => {
            void formulario.handleSubmit(enviar)(event);
          }}
        >
          <Field
            label={t('usuarios.form.motivo')}
            hint={t('usuarios.form.motivoAyuda')}
            error={errors.reason?.message}
            required
          >
            <Input
              placeholder={t('usuarios.form.motivoPlaceholder')}
              {...formulario.register('reason')}
            />
          </Field>
        </form>
      </div>
    </Dialog>
  );
};
