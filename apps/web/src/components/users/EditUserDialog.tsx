import { updateUserSchema, type Role, type UserSummary } from '@odontocrm/contracts';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation } from '@tanstack/react-query';
import { Alert, Button, Dialog, Field, Input, Switch } from '@odontocrm/ui';
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import type { z } from 'zod';

import { apiErrorMessage } from '../../lib/api';
import { usersApi } from '../../lib/endpoints';
import { applyApiFieldErrors } from '../../lib/forms';
import { t } from '../../lib/i18n';
import { RolePicker, type RoleOption } from './RolePicker';

type ValoresFormulario = z.input<typeof updateUserSchema>;
type ValoresEnviados = z.output<typeof updateUserSchema>;

export interface EditUserDialogProps {
  open: boolean;
  usuario: UserSummary | null;
  opcionesRol: readonly RoleOption[];
  onClose: () => void;
  onUpdated: (nombre: string) => void;
}

/**
 * Edición de usuario. El **motivo es obligatorio** (`updateUserSchema.reason`):
 * cada cambio de usuario queda auditado con su justificación, igual que las
 * ediciones de pacientes.
 */
export const EditUserDialog = ({
  open,
  usuario,
  opcionesRol,
  onClose,
  onUpdated,
}: EditUserDialogProps) => {
  const [errorGeneral, setErrorGeneral] = useState<string | null>(null);

  const formulario = useForm<ValoresFormulario, unknown, ValoresEnviados>({
    resolver: zodResolver(updateUserSchema),
    defaultValues: { fullName: '', email: '', roles: [], isActive: true, reason: '' },
  });

  const { reset } = formulario;
  useEffect(() => {
    if (!open || !usuario) return;
    setErrorGeneral(null);
    reset({
      fullName: usuario.fullName,
      email: usuario.email ?? '',
      roles: [...usuario.roles],
      isActive: usuario.isActive,
      reason: '',
    });
  }, [open, usuario, reset]);

  const actualizar = useMutation({
    mutationFn: (valores: ValoresEnviados) => {
      if (!usuario) throw new Error('No hay usuario seleccionado');
      return usersApi.update(usuario.id, valores);
    },
  });

  const rolesSeleccionados = formulario.watch('roles') ?? [];

  const alternarRol = (rol: Role) => {
    const actuales = formulario.getValues('roles') ?? [];
    const siguientes = actuales.includes(rol)
      ? actuales.filter((valor) => valor !== rol)
      : [...actuales, rol];
    formulario.setValue('roles', siguientes, { shouldValidate: true, shouldDirty: true });
  };

  const enviar = async (valores: ValoresEnviados) => {
    setErrorGeneral(null);
    try {
      const actualizado = await actualizar.mutateAsync(valores);
      onClose();
      onUpdated(actualizado.fullName);
    } catch (fallo) {
      if (!applyApiFieldErrors(formulario.setError, fallo)) setErrorGeneral(apiErrorMessage(fallo));
    }
  };

  const { errors, isSubmitting } = formulario.formState;

  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="lg"
      title={t('usuarios.form.editarTitulo', { usuario: usuario?.username ?? '' })}
      description={t('usuarios.form.descripcion')}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={isSubmitting}>
            {t('comun.cancelar')}
          </Button>
          <Button
            type="submit"
            form="formulario-editar-usuario"
            loading={isSubmitting}
            loadingLabel={t('comun.guardando')}
          >
            {t('comun.guardar')}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {errorGeneral && <Alert variant="danger">{errorGeneral}</Alert>}

        <form
          id="formulario-editar-usuario"
          noValidate
          className="space-y-4"
          onSubmit={(event) => {
            void formulario.handleSubmit(enviar)(event);
          }}
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={t('usuarios.form.usuario')}>
              <Input value={usuario?.username ?? ''} readOnly disabled />
            </Field>

            <Field label={t('usuarios.form.nombre')} error={errors.fullName?.message} required>
              <Input {...formulario.register('fullName')} />
            </Field>
          </div>

          <Field
            label={t('usuarios.form.correo')}
            hint={t('usuarios.form.correoAyuda')}
            error={errors.email?.message}
          >
            <Input type="email" autoComplete="off" {...formulario.register('email')} />
          </Field>

          <div className="space-y-2">
            <p className="text-sm font-medium text-ink">{t('usuarios.form.roles')}</p>
            <p className="text-xs text-ink-subtle">{t('usuarios.form.rolesAyuda')}</p>
            <RolePicker
              opciones={opcionesRol}
              seleccionados={rolesSeleccionados}
              onToggle={alternarRol}
              disabled={isSubmitting}
              error={errors.roles?.message}
            />
          </div>

          <Switch
            label={t('usuarios.form.activo')}
            description={t('usuarios.form.activoAyuda')}
            {...formulario.register('isActive')}
          />

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
