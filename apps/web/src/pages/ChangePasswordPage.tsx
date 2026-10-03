import { changePasswordSchema, type ChangePasswordInput } from '@odontocrm/contracts';
import { zodResolver } from '@hookform/resolvers/zod';
import {
  Alert,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Field,
} from '@odontocrm/ui';
import { Stethoscope } from 'lucide-react';
import { useForm } from 'react-hook-form';
import { useNavigate } from 'react-router-dom';

import { NoticeBanner } from '../components/NoticeBanner';
import { PasswordInput } from '../components/PasswordInput';
import { ThemeSelector } from '../components/shell/ThemeSelector';
import { apiErrorMessage } from '../lib/api';
import { authApi } from '../lib/endpoints';
import { applyApiFieldErrors } from '../lib/forms';
import { t } from '../lib/i18n';
import { useNotice } from '../hooks/useNotice';
import { useAuth } from '../providers/AuthProvider';

/**
 * Cambio de contraseña. Se llega aquí de dos formas: por voluntad propia, o
 * empujado por `MustChangePasswordGate` cuando la cuenta trae una contraseña
 * temporal (el caso del `admin` del seed). Al guardar, el servidor devuelve un
 * token nuevo y `mustChangePassword` queda en falso.
 *
 * La pantalla va sin shell a propósito: mientras la contraseña sea temporal no
 * tiene sentido ofrecer navegación.
 */
export const ChangePasswordPage = () => {
  const { mustChangePassword, user, applyLoginResponse } = useAuth();
  const navigate = useNavigate();
  const { notice, limpiar, exito, error } = useNotice();

  const formulario = useForm<ChangePasswordInput>({
    resolver: zodResolver(changePasswordSchema),
    defaultValues: { currentPassword: '', newPassword: '', repeatPassword: '' },
  });

  const enviar = async (valores: ChangePasswordInput) => {
    limpiar();
    try {
      const respuesta = await authApi.changePassword(valores);
      applyLoginResponse(respuesta);
      exito(t('contrasena.ok'));
      void navigate('/inicio', { replace: true });
    } catch (fallo) {
      if (!applyApiFieldErrors(formulario.setError, fallo)) error(apiErrorMessage(fallo));
    }
  };

  const { errors, isSubmitting } = formulario.formState;

  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-6 bg-canvas px-4 py-10">
      <div className="flex items-center gap-3">
        <span className="grid size-10 place-items-center rounded-card bg-primary text-primary-ink">
          <Stethoscope className="size-5" aria-hidden="true" />
        </span>
        <div>
          <p className="text-base font-semibold text-ink">{t('app.nombre')}</p>
          <p className="text-xs text-ink-subtle">
            {user?.fullName ?? t('comun.sinDato')} · {user?.username ?? ''}
          </p>
        </div>
      </div>

      <Card className="w-full max-w-lg">
        <CardHeader>
          <CardTitle as="h1">
            {mustChangePassword ? t('contrasena.tituloObligatorio') : t('contrasena.titulo')}
          </CardTitle>
          <CardDescription>
            {mustChangePassword ? t('contrasena.textoObligatorio') : t('contrasena.texto')}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <NoticeBanner notice={notice} onClose={limpiar} />

          {mustChangePassword && (
            <Alert variant="warning" title={t('contrasena.tituloObligatorio')}>
              {t('contrasena.textoObligatorio')}
            </Alert>
          )}

          <form
            noValidate
            className="space-y-4"
            onSubmit={(event) => {
              void formulario.handleSubmit(enviar)(event);
            }}
          >
            <Field label={t('contrasena.actual')} error={errors.currentPassword?.message} required>
              <PasswordInput
                autoComplete="current-password"
                {...formulario.register('currentPassword')}
              />
            </Field>

            <Field
              label={t('contrasena.nueva')}
              hint={t('contrasena.nuevaAyuda')}
              error={errors.newPassword?.message}
              required
            >
              <PasswordInput autoComplete="new-password" {...formulario.register('newPassword')} />
            </Field>

            <Field label={t('contrasena.repetir')} error={errors.repeatPassword?.message} required>
              <PasswordInput
                autoComplete="new-password"
                {...formulario.register('repeatPassword')}
              />
            </Field>

            <Button
              type="submit"
              fullWidth
              loading={isSubmitting}
              loadingLabel={t('comun.enviando')}
            >
              {t('contrasena.enviar')}
            </Button>
          </form>

          <p className="text-xs text-ink-subtle">{t('contrasena.politica')}</p>
        </CardContent>
      </Card>

      <div className="flex flex-col items-center gap-2">
        <ThemeSelector />
        <p className="text-xs text-ink-subtle">{t('app.pie')}</p>
      </div>
    </div>
  );
};
