import { createUserSchema, type Role } from '@odontocrm/contracts';
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

/** Entrada del formulario (lo que se teclea) y salida (lo que se envía). */
type ValoresFormulario = z.input<typeof createUserSchema>;
type ValoresEnviados = z.output<typeof createUserSchema>;

export interface CreateUserDialogProps {
  open: boolean;
  opcionesRol: readonly RoleOption[];
  onClose: () => void;
  onCreated: (nombre: string) => void;
}

/**
 * Alta de usuario. Reutiliza `createUserSchema` de `@odontocrm/contracts`, así
 * que las reglas (usuario, contraseña de 10+, al menos un rol) son las mismas
 * que aplica el servidor.
 */
export const CreateUserDialog = ({
  open,
  opcionesRol,
  onClose,
  onCreated,
}: CreateUserDialogProps) => {
  const [errorGeneral, setErrorGeneral] = useState<string | null>(null);

  const formulario = useForm<ValoresFormulario, unknown, ValoresEnviados>({
    resolver: zodResolver(createUserSchema),
    defaultValues: {
      username: '',
      fullName: '',
      email: '',
      password: '',
      roles: [],
      mustChangePassword: true,
    },
  });

  const { reset } = formulario;
  useEffect(() => {
    if (!open) return;
    setErrorGeneral(null);
    reset({
      username: '',
      fullName: '',
      email: '',
      password: '',
      roles: [],
      mustChangePassword: true,
    });
  }, [open, reset]);

  const crear = useMutation({
    mutationFn: (valores: ValoresEnviados) => usersApi.create(valores),
  });

  const rolesSeleccionados = formulario.watch('roles');

  const alternarRol = (rol: Role) => {
    const actuales = formulario.getValues('roles');
    const siguientes = actuales.includes(rol)
      ? actuales.filter((valor) => valor !== rol)
      : [...actuales, rol];
    formulario.setValue('roles', siguientes, { shouldValidate: true, shouldDirty: true });
  };

  const enviar = async (valores: ValoresEnviados) => {
    setErrorGeneral(null);
    try {
      const creado = await crear.mutateAsync(valores);
      onClose();
      onCreated(creado.fullName);
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
      title={t('usuarios.form.crearTitulo')}
      description={t('usuarios.form.descripcion')}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={isSubmitting}>
            {t('comun.cancelar')}
          </Button>
          <Button
            type="submit"
            form="formulario-nuevo-usuario"
            loading={isSubmitting}
            loadingLabel={t('comun.guardando')}
          >
            {t('usuarios.form.crear')}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {errorGeneral && <Alert variant="danger">{errorGeneral}</Alert>}

        <form
          id="formulario-nuevo-usuario"
          noValidate
          className="space-y-4"
          onSubmit={(event) => {
            void formulario.handleSubmit(enviar)(event);
          }}
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              label={t('usuarios.form.usuario')}
              hint={t('usuarios.form.usuarioAyuda')}
              error={errors.username?.message}
              required
            >
              <Input
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                {...formulario.register('username')}
              />
            </Field>

            <Field label={t('usuarios.form.nombre')} error={errors.fullName?.message} required>
              <Input autoComplete="off" {...formulario.register('fullName')} />
            </Field>
          </div>

          <Field
            label={t('usuarios.form.correo')}
            hint={t('usuarios.form.correoAyuda')}
            error={errors.email?.message}
          >
            <Input type="email" autoComplete="off" {...formulario.register('email')} />
          </Field>

          <Field
            label={t('usuarios.form.contrasena')}
            hint={t('usuarios.form.contrasenaAyuda')}
            error={errors.password?.message}
            required
          >
            <Input
              type="password"
              autoComplete="new-password"
              {...formulario.register('password')}
            />
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
            label={t('usuarios.form.mustChange')}
            description={t('usuarios.form.mustChangeAyuda')}
            {...formulario.register('mustChangePassword')}
          />
        </form>
      </div>
    </Dialog>
  );
};
