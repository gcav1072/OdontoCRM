import { PERMISSIONS, ROLE_PERMISSIONS } from '@odontocrm/contracts';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Spinner,
} from '@odontocrm/ui';
import { useQuery } from '@tanstack/react-query';
import { CircleCheck, CircleX, Clock, RefreshCw, ShieldCheck } from 'lucide-react';

import { LinkButton } from '../components/LinkButton';
import { apiErrorMessage } from '../lib/api';
import { authApi } from '../lib/endpoints';
import { formatDate, formatDuration, formatRelative, formatTime } from '../lib/format';
import { PERMISSION_LABELS, ROLE_DESCRIPTIONS, ROLE_LABELS, isPermission, t } from '../lib/i18n';
import { MODULES } from '../lib/nav';
import { useAuth } from '../providers/AuthProvider';

/**
 * Tablero de bienvenida: quién eres, qué puedes hacer y cómo está el sistema.
 *
 * Todo se calcula con lo que ya se sabe de la sesión (sin endpoints nuevos); la
 * única consulta es `GET /auth/me`, que sirve de comprobación en vivo del
 * backend: si falla, se avisa en pantalla y el resto del tablero sigue visible.
 */
export const HomePage = () => {
  const { user, roles, permissions, sessionInfo, hasPermission, mustChangePassword } = useAuth();

  const estadoQuery = useQuery({
    queryKey: ['estado-servidor'],
    queryFn: ({ signal }) => authApi.me(signal),
    refetchInterval: 60_000,
    staleTime: 30_000,
    retry: false,
  });

  const modulos = Object.values(MODULES).filter(
    (modulo) =>
      modulo.id !== 'inicio' && (modulo.permission === null || hasPermission(modulo.permission)),
  );

  const permisosHeredados = roles.flatMap((rol) => [...ROLE_PERMISSIONS[rol]]);

  return (
    <div className="space-y-5">
      {mustChangePassword && (
        <Alert variant="warning" title={t('contrasena.tituloObligatorio')}>
          {t('inicio.debeCambiar')}
        </Alert>
      )}

      <Card>
        <CardHeader className="gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0 space-y-1">
            <CardTitle as="h2">
              {t('inicio.saludo', { nombre: user?.fullName ?? t('comun.sinDato') })}
            </CardTitle>
            <CardDescription>
              {t('inicio.fecha', { fecha: formatDate(new Date()) })} · {t('inicio.tableroTexto')}
            </CardDescription>
            <div className="flex flex-wrap gap-1.5 pt-1">
              {roles.map((rol) => (
                <Badge key={rol} variant="primary">
                  {ROLE_LABELS[rol]}
                </Badge>
              ))}
              <Badge variant="neutral">
                {t('sesion.permisosCuenta', { total: permissions.length })}
              </Badge>
            </div>
          </div>
        </CardHeader>
        <CardContent className="text-sm text-ink-muted">
          {roles.map((rol) => (
            <p key={rol}>
              <span className="font-medium text-ink">{ROLE_LABELS[rol]}:</span>{' '}
              {ROLE_DESCRIPTIONS[rol]}
            </p>
          ))}
        </CardContent>
      </Card>

      <div className="grid gap-5 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle as="h2">{t('inicio.modulos')}</CardTitle>
            <CardDescription>{t('modulo.inicio.descripcion')}</CardDescription>
          </CardHeader>
          <CardContent>
            {modulos.length === 0 ? (
              <p className="text-sm text-ink-muted">{t('inicio.sinModulos')}</p>
            ) : (
              <ul className="grid gap-3 sm:grid-cols-2">
                {modulos.map((modulo) => {
                  const Icono = modulo.icon;
                  return (
                    <li
                      key={modulo.id}
                      className="flex flex-col gap-2 rounded-control border border-border bg-surface-muted/50 p-3.5"
                    >
                      <div className="flex items-center gap-2">
                        <Icono className="size-4 shrink-0 text-primary" aria-hidden="true" />
                        <p className="truncate text-sm font-semibold text-ink">
                          {t(modulo.labelKey)}
                        </p>
                      </div>
                      <p className="text-xs text-ink-muted">{t(modulo.descriptionKey)}</p>
                      <LinkButton
                        to={modulo.path}
                        variant="secondary"
                        size="sm"
                        className="mt-auto self-start"
                      >
                        {t('inicio.abrir')}
                      </LinkButton>
                    </li>
                  );
                })}
              </ul>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle as="h2">{t('inicio.puedesHacer')}</CardTitle>
            <CardDescription>
              <ShieldCheck className="mr-1 inline size-3.5 align-[-2px]" aria-hidden="true" />
              {t('sesion.permisos')}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {permissions.length === 0 ? (
              <p className="text-sm text-ink-muted">{t('inicio.sinPermisos')}</p>
            ) : (
              <ul className="space-y-1.5 text-sm">
                {PERMISSIONS.filter((permiso) => permissions.includes(permiso)).map((permiso) => (
                  <li key={permiso} className="flex items-start gap-2">
                    <CircleCheck
                      className="mt-0.5 size-4 shrink-0 text-success"
                      aria-hidden="true"
                    />
                    <span className="text-ink-muted">{PERMISSION_LABELS[permiso]}</span>
                  </li>
                ))}
              </ul>
            )}
            {permisosHeredados.filter(isPermission).length === 0 && roles.length > 0 && (
              <p className="mt-3 text-xs text-ink-subtle">{t('inicio.sinPermisos')}</p>
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle as="h2">{t('inicio.estado')}</CardTitle>
          <CardDescription>{t('inicio.estado.detalle', { ruta: '/api/v1' })}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {estadoQuery.isError && (
            <Alert variant="danger" title={t('inicio.estado.sinConexion')}>
              {apiErrorMessage(estadoQuery.error)}
            </Alert>
          )}

          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <div className="space-y-1">
              <p className="text-xs font-medium tracking-wide text-ink-subtle uppercase">
                {t('inicio.estado.servidor')}
              </p>
              <p className="flex items-center gap-2 text-sm text-ink">
                {estadoQuery.isPending ? (
                  <>
                    <Spinner size="sm" label={t('inicio.estado.comprobando')} />
                    {t('inicio.estado.comprobando')}
                  </>
                ) : estadoQuery.isError ? (
                  <>
                    <CircleX className="size-4 text-danger" aria-hidden="true" />
                    {t('inicio.estado.sinConexion')}
                  </>
                ) : (
                  <>
                    <CircleCheck className="size-4 text-success" aria-hidden="true" />
                    {t('inicio.estado.conectado')}
                  </>
                )}
              </p>
            </div>

            <div className="space-y-1">
              <p className="text-xs font-medium tracking-wide text-ink-subtle uppercase">
                {t('sesion.iniciada')}
              </p>
              <p className="flex items-center gap-2 text-sm text-ink">
                <Clock className="size-4 text-ink-subtle" aria-hidden="true" />
                {t('sesion.iniciadaA', { hora: formatTime(sessionInfo?.loginAt) })}
              </p>
            </div>

            <div className="space-y-1">
              <p className="text-xs font-medium tracking-wide text-ink-subtle uppercase">
                {t('sesion.duracion')}
              </p>
              <p className="text-sm text-ink">
                {sessionInfo ? formatDuration(sessionInfo.loginAt) : t('comun.sinDato')}
              </p>
            </div>

            <div className="space-y-1">
              <p className="text-xs font-medium tracking-wide text-ink-subtle uppercase">
                {t('sesion.caducidad')}
              </p>
              <p className="text-sm text-ink">
                {sessionInfo
                  ? t('sesion.caduca', { tiempo: formatRelative(sessionInfo.expiresAt) })
                  : t('comun.sinDato')}
              </p>
            </div>
          </div>

          {roles.includes('pantalla') && <Alert variant="info">{t('inicio.pantallaNota')}</Alert>}

          <Button
            variant="secondary"
            size="sm"
            onClick={() => void estadoQuery.refetch()}
            loading={estadoQuery.isFetching}
            leadingIcon={<RefreshCw className="size-4" aria-hidden="true" />}
          >
            {t('inicio.estado.revisar')}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
};
