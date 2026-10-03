import {
  loginSchema,
  MAX_FAILED_ATTEMPTS,
  LOCK_MINUTES,
  type LoginInput,
} from '@odontocrm/contracts';
import { zodResolver } from '@hookform/resolvers/zod';
import {
  Alert,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Field,
  Input,
  type AlertVariant,
} from '@odontocrm/ui';
import { Stethoscope } from 'lucide-react';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';

import { FullScreenLoader } from '../components/FullScreenLoader';
import { PasswordInput } from '../components/PasswordInput';
import { ThemeSelector } from '../components/shell/ThemeSelector';
import { isApiError } from '../lib/api';
import { t } from '../lib/i18n';
import { useAuth } from '../providers/AuthProvider';

interface AvisoError {
  variant: AlertVariant;
  title: string;
  message: string;
}

/** Traduce el fallo del login a un aviso entendible. El `detail` ya viene en español. */
const describirError = (fallo: unknown): AvisoError => {
  if (!isApiError(fallo)) {
    return { variant: 'danger', title: t('login.credenciales'), message: t('api.error.generico') };
  }
  if (fallo.status === 423) {
    return { variant: 'warning', title: t('login.bloqueada'), message: fallo.detail };
  }
  if (fallo.sinConexion) {
    return { variant: 'danger', title: t('api.titulo.sinConexion'), message: fallo.detail };
  }
  return { variant: 'danger', title: t('login.credenciales'), message: fallo.detail };
};

/** Ruta a la que volver tras entrar (la dejó `RequireAuth` en el estado). */
const leerDestino = (state: unknown): string => {
  if (
    typeof state === 'object' &&
    state !== null &&
    'desde' in state &&
    typeof state.desde === 'string'
  ) {
    return state.desde;
  }
  return '/inicio';
};

export const LoginPage = () => {
  const { login, status, sessionExpired } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [aviso, setAviso] = useState<AvisoError | null>(null);

  const formulario = useForm<LoginInput>({
    resolver: zodResolver(loginSchema),
    defaultValues: { username: '', password: '' },
  });

  if (status === 'cargando') return <FullScreenLoader label={t('sesion.restaurando')} />;
  if (status === 'autenticado') return <Navigate to={leerDestino(location.state)} replace />;

  const enviar = async (valores: LoginInput) => {
    setAviso(null);
    try {
      await login(valores);
      void navigate(leerDestino(location.state), { replace: true });
    } catch (fallo) {
      // El error de credenciales se muestra como aviso: el formulario no tiene
      // un campo al que pertenezca (el servidor no dice cuál falló, a propósito).
      setAviso(describirError(fallo));
    }
  };

  const { errors, isSubmitting } = formulario.formState;

  return (
    <div className="grid min-h-dvh bg-canvas lg:grid-cols-[1.1fr_1fr]">
      {/* Franja de marca: solo en pantallas grandes */}
      <section className="hidden flex-col justify-between bg-primary p-10 text-primary-ink lg:flex">
        <div className="flex items-center gap-3">
          <span className="grid size-11 place-items-center rounded-card bg-primary-ink/10">
            <Stethoscope className="size-6" aria-hidden="true" />
          </span>
          <div>
            <p className="text-lg font-semibold">{t('app.nombre')}</p>
            <p className="text-sm opacity-80">{t('app.lema')}</p>
          </div>
        </div>

        <div className="max-w-md space-y-3">
          <h2 className="text-2xl font-semibold">{t('login.titulo')}</h2>
          <p className="text-sm opacity-85">{t('login.subtitulo')}</p>
        </div>

        <p className="text-xs opacity-75">{t('app.pie')}</p>
      </section>

      <section className="flex flex-col items-center justify-center gap-6 px-4 py-10">
        <div className="flex items-center gap-3 lg:hidden">
          <span className="grid size-10 place-items-center rounded-card bg-primary text-primary-ink">
            <Stethoscope className="size-5" aria-hidden="true" />
          </span>
          <div>
            <p className="text-base font-semibold text-ink">{t('app.nombre')}</p>
            <p className="text-xs text-ink-subtle">{t('app.lema')}</p>
          </div>
        </div>

        <Card className="w-full max-w-md">
          <CardHeader>
            <CardTitle as="h1">{t('login.titulo')}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {sessionExpired && (
              <Alert variant="warning" title={t('login.credenciales')}>
                {t('sesion.caducada')}
              </Alert>
            )}

            {aviso && (
              <Alert variant={aviso.variant} title={aviso.title}>
                {aviso.message}
              </Alert>
            )}

            <form
              noValidate
              className="space-y-4"
              onSubmit={(event) => {
                void formulario.handleSubmit(enviar)(event);
              }}
            >
              <Field label={t('login.usuario')} error={errors.username?.message} required>
                <Input
                  autoFocus
                  autoComplete="username"
                  autoCapitalize="none"
                  spellCheck={false}
                  placeholder={t('login.usuarioPlaceholder')}
                  {...formulario.register('username')}
                />
              </Field>

              <Field label={t('login.contrasena')} error={errors.password?.message} required>
                <PasswordInput
                  autoComplete="current-password"
                  {...formulario.register('password')}
                />
              </Field>

              <Button
                type="submit"
                fullWidth
                size="lg"
                loading={isSubmitting}
                loadingLabel={t('login.entrando')}
              >
                {t('login.entrar')}
              </Button>
            </form>

            <p className="text-xs text-ink-subtle">
              {t('login.avisoBloqueo', {
                intentos: MAX_FAILED_ATTEMPTS,
                minutos: LOCK_MINUTES,
              })}
            </p>
          </CardContent>
        </Card>

        <div className="flex flex-col items-center gap-2">
          <ThemeSelector />
          <p className="text-xs text-ink-subtle">{t('app.pie')}</p>
        </div>
      </section>
    </div>
  );
};
