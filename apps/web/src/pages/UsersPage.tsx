import { DEFAULT_PAGE_SIZE, ROLE_PERMISSIONS, ROLES, type UserSummary } from '@odontocrm/contracts';
import { useQuery, keepPreviousData } from '@tanstack/react-query';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  EmptyState,
  Field,
  Input,
  Select,
  Spinner,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@odontocrm/ui';
import { Ban, CircleCheck, KeyRound, Pencil, Search, UserPlus, Users } from 'lucide-react';
import { useEffect, useState } from 'react';

import { NoticeBanner } from '../components/NoticeBanner';
import { CreateUserDialog } from '../components/users/CreateUserDialog';
import { EditUserDialog } from '../components/users/EditUserDialog';
import { ResetPasswordDialog } from '../components/users/ResetPasswordDialog';
import { TemporaryPasswordDialog } from '../components/users/TemporaryPasswordDialog';
import { UserStatusDialog } from '../components/users/UserStatusDialog';
import type { RoleOption } from '../components/users/RolePicker';
import { useNotice } from '../hooks/useNotice';
import { useDebouncedValue } from '../hooks/useDebouncedValue';
import { apiErrorMessage } from '../lib/api';
import { usersApi } from '../lib/endpoints';
import { formatDateTime, formatNumber, formatRelative } from '../lib/format';
import { ROLE_DESCRIPTIONS, ROLE_LABELS, t } from '../lib/i18n';
import { useAuth } from '../providers/AuthProvider';

type DialogoState =
  | { tipo: 'ninguno' }
  | { tipo: 'crear' }
  | { tipo: 'editar'; usuario: UserSummary }
  | { tipo: 'estado'; usuario: UserSummary }
  | { tipo: 'restablecer'; usuario: UserSummary }
  | { tipo: 'temporal'; usuario: UserSummary; contrasena: string | null };

const TAMANOS_PAGINA = [10, DEFAULT_PAGE_SIZE, 50] as const;

/**
 * Módulo de usuarios (Fase 1): listado con búsqueda y paginación, alta, edición
 * con motivo obligatorio, activación/desactivación, restablecimiento de
 * contraseña y asignación de roles con sus permisos a la vista.
 */
export const UsersPage = () => {
  const { user: usuarioActual } = useAuth();
  const { notice, limpiar, exito } = useNotice();

  const [busqueda, setBusqueda] = useState('');
  const [pagina, setPagina] = useState(1);
  const [porPagina, setPorPagina] = useState<number>(DEFAULT_PAGE_SIZE);
  const [dialogo, setDialogo] = useState<DialogoState>({ tipo: 'ninguno' });

  const busquedaDiferida = useDebouncedValue(busqueda, 350);

  // Al cambiar el filtro o el tamaño de página se vuelve a la primera.
  useEffect(() => {
    setPagina(1);
  }, [busquedaDiferida, porPagina]);

  const usuariosQuery = useQuery({
    queryKey: ['usuarios', { busqueda: busquedaDiferida, pagina, porPagina }],
    queryFn: ({ signal }) =>
      usersApi.list({ search: busquedaDiferida.trim(), page: pagina, pageSize: porPagina }, signal),
    placeholderData: keepPreviousData,
  });

  // Catálogo del servidor con respaldo en los contratos: si la consulta falla,
  // el formulario sigue pudiendo asignar roles y mostrar sus permisos.
  const rolesQuery = useQuery({
    queryKey: ['catalogo-roles'],
    queryFn: ({ signal }) => usersApi.roles(signal),
    staleTime: 30 * 60_000,
  });

  const opcionesRol: readonly RoleOption[] =
    rolesQuery.data?.roles ??
    ROLES.map((rol) => ({
      name: rol,
      description: ROLE_DESCRIPTIONS[rol],
      permissions: [...ROLE_PERMISSIONS[rol]],
    }));

  const pagina_ = usuariosQuery.data;
  const total = pagina_?.total ?? 0;
  const totalPaginas = pagina_?.totalPages ?? 1;
  const desde = total === 0 ? 0 : (pagina - 1) * porPagina + 1;
  const hasta = Math.min(pagina * porPagina, total);

  /** Refresca el listado y muestra el aviso de éxito con el nombre afectado. */
  const confirmar = (mensaje: string, nombre: string) => {
    void usuariosQuery.refetch();
    exito(`${nombre}: ${mensaje}`);
  };

  return (
    <div className="space-y-5">
      <NoticeBanner notice={notice} onClose={limpiar} />

      <Card>
        <CardHeader className="gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div className="flex-1">
            <CardTitle as="h2">{t('usuarios.titulo')}</CardTitle>
            <p className="pt-1 text-sm text-ink-muted">{t('usuarios.descripcion')}</p>
          </div>
          <Button
            onClick={() => setDialogo({ tipo: 'crear' })}
            leadingIcon={<UserPlus className="size-4" aria-hidden="true" />}
          >
            {t('usuarios.nuevo')}
          </Button>
        </CardHeader>

        <CardContent className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
            <Field label={t('usuarios.buscar')}>
              <div className="relative">
                <Search
                  className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-ink-subtle"
                  aria-hidden="true"
                />
                <Input
                  type="search"
                  className="pl-9"
                  placeholder={t('usuarios.buscarPlaceholder')}
                  value={busqueda}
                  onChange={(event) => setBusqueda(event.target.value)}
                />
              </div>
            </Field>

            <Field label={t('usuarios.porPagina')} className="sm:w-32">
              <Select
                value={String(porPagina)}
                onChange={(event) => setPorPagina(Number(event.target.value))}
              >
                {TAMANOS_PAGINA.map((tamano) => (
                  <option key={tamano} value={tamano}>
                    {tamano}
                  </option>
                ))}
              </Select>
            </Field>
          </div>

          {usuariosQuery.isError && (
            <Alert variant="danger" title={t('usuarios.error')}>
              {apiErrorMessage(usuariosQuery.error)}
            </Alert>
          )}

          {usuariosQuery.isPending ? (
            <div className="py-10">
              <Spinner label={t('usuarios.cargando')} showLabel />
            </div>
          ) : pagina_ && pagina_.items.length === 0 ? (
            <EmptyState
              icon={<Users className="size-6" aria-hidden="true" />}
              title={t('usuarios.sinResultados')}
              description={t('usuarios.vacio')}
            />
          ) : (
            <Table caption={t('usuarios.paginacion', { pagina, paginas: totalPaginas, total })}>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead>{t('usuarios.columna.usuario')}</TableHead>
                  <TableHead>{t('usuarios.columna.nombre')}</TableHead>
                  <TableHead>{t('usuarios.columna.roles')}</TableHead>
                  <TableHead>{t('usuarios.columna.estado')}</TableHead>
                  <TableHead>{t('usuarios.columna.ultimoAcceso')}</TableHead>
                  <TableHead className="text-right">{t('usuarios.columna.acciones')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {pagina_?.items.map((usuario) => {
                  const esUnoMismo = usuario.id === usuarioActual?.id;
                  return (
                    <TableRow key={usuario.id}>
                      <TableCell className="font-mono text-xs">{usuario.username}</TableCell>
                      <TableCell>
                        <span className="block font-medium text-ink">{usuario.fullName}</span>
                        {usuario.email && (
                          <span className="block text-xs text-ink-subtle">{usuario.email}</span>
                        )}
                      </TableCell>
                      <TableCell>
                        <span className="flex flex-wrap gap-1">
                          {usuario.roles.map((rol) => (
                            <Badge key={rol} variant="primary">
                              {ROLE_LABELS[rol]}
                            </Badge>
                          ))}
                        </span>
                      </TableCell>
                      <TableCell>
                        <span className="flex flex-wrap gap-1">
                          <Badge variant={usuario.isActive ? 'success' : 'neutral'} dot>
                            {usuario.isActive
                              ? t('usuarios.estado.activo')
                              : t('usuarios.estado.inactivo')}
                          </Badge>
                          {usuario.isLocked && (
                            <Badge variant="danger">{t('usuarios.estado.bloqueado')}</Badge>
                          )}
                          {usuario.mustChangePassword && (
                            <Badge variant="warning">{t('usuarios.estado.debeCambiar')}</Badge>
                          )}
                          {usuario.failedAttempts > 0 && (
                            <Badge variant="neutral">
                              {t('usuarios.intentos', { intentos: usuario.failedAttempts })}
                            </Badge>
                          )}
                        </span>
                      </TableCell>
                      <TableCell>
                        <span className="block text-sm" title={formatDateTime(usuario.lastLoginAt)}>
                          {usuario.lastLoginAt
                            ? formatRelative(usuario.lastLoginAt)
                            : t('usuarios.nunca')}
                        </span>
                        <span className="block text-xs text-ink-subtle">
                          {formatDateTime(usuario.createdAt)}
                        </span>
                      </TableCell>
                      <TableCell>
                        <span
                          className="flex items-center justify-end gap-1"
                          aria-label={t('usuarios.acciones', { usuario: usuario.username })}
                        >
                          <Button
                            variant="ghost"
                            size="sm"
                            title={t('usuarios.acciones.editar')}
                            aria-label={t('usuarios.acciones.editar')}
                            onClick={() => setDialogo({ tipo: 'editar', usuario })}
                            leadingIcon={<Pencil className="size-4" aria-hidden="true" />}
                          />
                          <Button
                            variant="ghost"
                            size="sm"
                            title={t('usuarios.acciones.restablecer')}
                            aria-label={t('usuarios.acciones.restablecer')}
                            onClick={() => setDialogo({ tipo: 'restablecer', usuario })}
                            leadingIcon={<KeyRound className="size-4" aria-hidden="true" />}
                          />
                          <Button
                            variant="ghost"
                            size="sm"
                            disabled={esUnoMismo}
                            title={
                              esUnoMismo
                                ? t('usuarios.acciones.tuCuenta')
                                : usuario.isActive
                                  ? t('usuarios.acciones.desactivar')
                                  : t('usuarios.acciones.activar')
                            }
                            aria-label={
                              usuario.isActive
                                ? t('usuarios.acciones.desactivar')
                                : t('usuarios.acciones.activar')
                            }
                            onClick={() => setDialogo({ tipo: 'estado', usuario })}
                            leadingIcon={
                              usuario.isActive ? (
                                <Ban className="size-4" aria-hidden="true" />
                              ) : (
                                <CircleCheck className="size-4" aria-hidden="true" />
                              )
                            }
                          />
                        </span>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}

          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-xs text-ink-subtle">
              {t('usuarios.indicador', {
                desde: formatNumber(desde),
                hasta: formatNumber(hasta),
                total: formatNumber(total),
              })}
            </p>
            <div className="flex items-center gap-2">
              <Button
                variant="secondary"
                size="sm"
                disabled={pagina <= 1 || usuariosQuery.isFetching}
                onClick={() => setPagina((valor) => Math.max(1, valor - 1))}
              >
                {t('usuarios.anterior')}
              </Button>
              <span className="text-xs text-ink-muted">
                {t('usuarios.paginacion', { pagina, paginas: totalPaginas, total })}
              </span>
              <Button
                variant="secondary"
                size="sm"
                disabled={pagina >= totalPaginas || usuariosQuery.isFetching}
                onClick={() => setPagina((valor) => valor + 1)}
              >
                {t('usuarios.siguiente')}
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      <CreateUserDialog
        open={dialogo.tipo === 'crear'}
        opcionesRol={opcionesRol}
        onClose={() => setDialogo({ tipo: 'ninguno' })}
        onCreated={(nombre) => confirmar(t('usuarios.creado'), nombre)}
      />

      <EditUserDialog
        open={dialogo.tipo === 'editar'}
        usuario={dialogo.tipo === 'editar' ? dialogo.usuario : null}
        opcionesRol={opcionesRol}
        onClose={() => setDialogo({ tipo: 'ninguno' })}
        onUpdated={(nombre) => confirmar(t('usuarios.actualizado'), nombre)}
      />

      <UserStatusDialog
        open={dialogo.tipo === 'estado'}
        usuario={dialogo.tipo === 'estado' ? dialogo.usuario : null}
        onClose={() => setDialogo({ tipo: 'ninguno' })}
        onDone={(mensaje) => {
          void usuariosQuery.refetch();
          exito(mensaje);
        }}
      />

      <ResetPasswordDialog
        open={dialogo.tipo === 'restablecer'}
        usuario={dialogo.tipo === 'restablecer' ? dialogo.usuario : null}
        onClose={() => setDialogo({ tipo: 'ninguno' })}
        onReset={(temporal) => {
          void usuariosQuery.refetch();
          const usuario = dialogo.tipo === 'restablecer' ? dialogo.usuario : null;
          exito(t('usuarios.reset.ok'));
          if (usuario) setDialogo({ tipo: 'temporal', usuario, contrasena: temporal });
        }}
      />

      <TemporaryPasswordDialog
        open={dialogo.tipo === 'temporal'}
        usuario={dialogo.tipo === 'temporal' ? dialogo.usuario.username : ''}
        contrasena={dialogo.tipo === 'temporal' ? dialogo.contrasena : null}
        onClose={() => setDialogo({ tipo: 'ninguno' })}
      />
    </div>
  );
};
