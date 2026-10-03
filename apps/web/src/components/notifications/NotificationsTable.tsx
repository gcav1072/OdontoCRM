import {
  CHANNELS,
  NOTIFICATION_STATUSES,
  type Channel,
  type NotificationRecord,
  type NotificationStatus,
} from '@odontocrm/contracts';
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
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { BellRing, Eye, PhoneCall, RotateCcw, Search } from 'lucide-react';

import { apiErrorMessage } from '../../lib/api';
import { notificationsApi, type NotificationsListParams } from '../../lib/endpoints';
import { formatDateTime } from '../../lib/format';
import { CHANNEL_LABELS, NOTIFICATION_STATUS_LABELS, t, templateName } from '../../lib/i18n';
import { notificationKeys } from '../../lib/notifications';
import {
  NotificationStatusBadge,
  canRetryNotification,
  needsManualContact,
} from './NotificationStatusBadge';

const TAMANO_PAGINA = 25;
const RECORTE_ERROR = 48;

/** Filtros distintos de la búsqueda (la búsqueda la difiere la página). */
export interface NotificationFiltersState {
  status: '' | NotificationStatus;
  channel: '' | Channel;
  from: string;
  to: string;
}

export interface NotificationsTableProps {
  filters: NotificationFiltersState;
  onFiltersChange: (filters: NotificationFiltersState) => void;
  /** Texto de búsqueda ya diferido por la página. */
  search: string;
  onSearchChange: (search: string) => void;
  page: number;
  onPageChange: (page: number) => void;
  /** `scheduling:notify`: habilita «Reintentar» y «Marcar contacto hecho». */
  canNotify: boolean;
  onRetry: (record: NotificationRecord) => void;
  onContact: (record: NotificationRecord) => void;
  onDetail: (record: NotificationRecord) => void;
}

/** Último error recortado; el texto completo va en el `title` de la celda. */
const recortarError = (error: string): string =>
  error.length > RECORTE_ERROR ? `${error.slice(0, RECORTE_ERROR - 1)}…` : error;

/**
 * Bandeja de envíos: una fila por mensaje del bot, con filtros por estado, canal,
 * paciente y rango de fechas, y por fila las acciones de reintentar, marcar el
 * contacto hecho y ver el detalle.
 *
 * La tabla no sabe de mutaciones: cada acción la resuelve la página, que es
 * quien invalida las consultas afectadas.
 */
export const NotificationsTable = ({
  filters,
  onFiltersChange,
  search,
  onSearchChange,
  page,
  onPageChange,
  canNotify,
  onRetry,
  onContact,
  onDetail,
}: NotificationsTableProps) => {
  const consulta: NotificationsListParams = {
    status: filters.status === '' ? undefined : filters.status,
    channel: filters.channel === '' ? undefined : filters.channel,
    search: search.trim() === '' ? undefined : search.trim(),
    from: filters.from === '' ? undefined : filters.from,
    to: filters.to === '' ? undefined : filters.to,
    page,
    pageSize: TAMANO_PAGINA,
  };

  const bandejaQuery = useQuery({
    queryKey: notificationKeys.list(consulta),
    queryFn: ({ signal }) => notificationsApi.list(consulta, signal),
    placeholderData: keepPreviousData,
  });

  const datos = bandejaQuery.data;
  const total = datos?.total ?? 0;
  const totalPaginas = datos?.totalPages ?? 1;

  return (
    <Card>
      <CardHeader>
        <CardTitle as="h2" className="flex items-center gap-2">
          <BellRing className="size-4 text-primary" aria-hidden="true" />
          {t('notificaciones.bandeja.titulo')}
        </CardTitle>
        <p className="text-sm text-ink-muted">{t('notificaciones.bandeja.descripcion')}</p>
      </CardHeader>

      <CardContent className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
          <Field label={t('notificaciones.bandeja.filtro.buscar')}>
            <div className="relative">
              <Search
                className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-ink-subtle"
                aria-hidden="true"
              />
              <Input
                type="search"
                className="pl-9"
                placeholder={t('notificaciones.bandeja.filtro.buscarPlaceholder')}
                value={search}
                onChange={(event) => onSearchChange(event.target.value)}
              />
            </div>
          </Field>

          <Field label={t('notificaciones.bandeja.filtro.estado')}>
            <Select
              value={filters.status}
              onChange={(event) =>
                onFiltersChange({
                  ...filters,
                  status: event.target.value as '' | NotificationStatus,
                })
              }
            >
              <option value="">{t('notificaciones.bandeja.filtro.todos')}</option>
              {NOTIFICATION_STATUSES.map((valor) => (
                <option key={valor} value={valor}>
                  {NOTIFICATION_STATUS_LABELS[valor]}
                </option>
              ))}
            </Select>
          </Field>

          <Field label={t('notificaciones.bandeja.filtro.canal')}>
            <Select
              value={filters.channel}
              onChange={(event) =>
                onFiltersChange({ ...filters, channel: event.target.value as '' | Channel })
              }
            >
              <option value="">{t('notificaciones.bandeja.filtro.todos')}</option>
              {CHANNELS.map((valor) => (
                <option key={valor} value={valor}>
                  {CHANNEL_LABELS[valor]}
                </option>
              ))}
            </Select>
          </Field>

          <Field label={t('notificaciones.bandeja.filtro.desde')}>
            <Input
              type="date"
              value={filters.from}
              max={filters.to === '' ? undefined : filters.to}
              onChange={(event) => onFiltersChange({ ...filters, from: event.target.value })}
            />
          </Field>

          <Field label={t('notificaciones.bandeja.filtro.hasta')}>
            <Input
              type="date"
              value={filters.to}
              min={filters.from === '' ? undefined : filters.from}
              onChange={(event) => onFiltersChange({ ...filters, to: event.target.value })}
            />
          </Field>
        </div>

        {bandejaQuery.isError && (
          <Alert variant="danger" title={t('notificaciones.bandeja.error')}>
            {apiErrorMessage(bandejaQuery.error)}
          </Alert>
        )}

        {bandejaQuery.isPending ? (
          <div className="py-10">
            <Spinner label={t('notificaciones.bandeja.cargando')} showLabel />
          </div>
        ) : datos !== undefined && datos.items.length === 0 ? (
          <EmptyState
            icon={<BellRing className="size-6" aria-hidden="true" />}
            title={t('notificaciones.bandeja.vacioTitulo')}
            description={t('notificaciones.bandeja.vacio')}
          />
        ) : (
          <Table
            caption={t('notificaciones.bandeja.total', { total })}
            containerClassName="border-border"
          >
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>{t('notificaciones.bandeja.columna.creado')}</TableHead>
                <TableHead>{t('notificaciones.bandeja.columna.paciente')}</TableHead>
                <TableHead>{t('notificaciones.bandeja.columna.plantilla')}</TableHead>
                <TableHead>{t('notificaciones.bandeja.columna.canal')}</TableHead>
                <TableHead>{t('notificaciones.bandeja.columna.estado')}</TableHead>
                <TableHead>{t('notificaciones.bandeja.columna.intentos')}</TableHead>
                <TableHead>{t('notificaciones.bandeja.columna.error')}</TableHead>
                <TableHead>{t('notificaciones.bandeja.columna.enviado')}</TableHead>
                <TableHead className="text-right">
                  {t('notificaciones.bandeja.columna.acciones')}
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {datos?.items.map((envio) => (
                <TableRow key={envio.id}>
                  <TableCell className="text-sm whitespace-nowrap text-ink-muted">
                    {formatDateTime(envio.createdAt)}
                  </TableCell>
                  <TableCell className="text-sm text-ink">
                    {envio.patientName ?? t('comun.desconocido')}
                  </TableCell>
                  <TableCell className="text-sm text-ink-muted">
                    {templateName(envio.templateKey)}
                  </TableCell>
                  <TableCell>
                    <Badge variant="neutral">{CHANNEL_LABELS[envio.channel]}</Badge>
                  </TableCell>
                  <TableCell>
                    <NotificationStatusBadge status={envio.status} />
                  </TableCell>
                  <TableCell className="text-sm tabular-nums text-ink-muted">
                    {envio.attempts}/{envio.maxAttempts}
                  </TableCell>
                  <TableCell
                    className="max-w-[16rem] text-sm text-ink-muted"
                    title={envio.lastError ?? undefined}
                  >
                    {envio.lastError === null ? (
                      t('comun.sinDato')
                    ) : (
                      <>
                        <span className="block">{recortarError(envio.lastError)}</span>
                        {envio.nextAttemptAt !== null && (
                          <span className="block text-xs text-ink-subtle">
                            {t('notificaciones.bandeja.proximoIntento', {
                              cuando: formatDateTime(envio.nextAttemptAt),
                            })}
                          </span>
                        )}
                      </>
                    )}
                  </TableCell>
                  <TableCell className="text-sm whitespace-nowrap text-ink-muted">
                    {formatDateTime(envio.sentAt)}
                  </TableCell>
                  <TableCell>
                    <span className="flex flex-wrap items-center justify-end gap-1.5">
                      <Button
                        size="sm"
                        variant="ghost"
                        leadingIcon={<Eye className="size-3.5" aria-hidden="true" />}
                        onClick={() => onDetail(envio)}
                      >
                        {t('notificaciones.bandeja.ver')}
                      </Button>

                      {canNotify && canRetryNotification(envio) && (
                        <Button
                          size="sm"
                          variant="secondary"
                          leadingIcon={<RotateCcw className="size-3.5" aria-hidden="true" />}
                          onClick={() => onRetry(envio)}
                        >
                          {t('notificaciones.bandeja.reintentar')}
                        </Button>
                      )}

                      {canNotify && needsManualContact(envio) && (
                        <Button
                          size="sm"
                          variant="secondary"
                          className="border-warning/50"
                          leadingIcon={<PhoneCall className="size-3.5" aria-hidden="true" />}
                          onClick={() => onContact(envio)}
                        >
                          {t('notificaciones.bandeja.contactado')}
                        </Button>
                      )}
                    </span>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}

        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3">
          <p className="text-xs text-ink-subtle">
            {t('notificaciones.bandeja.total', { total })}
            {' · '}
            {t('notificaciones.bandeja.pagina', { pagina: page, paginas: totalPaginas })}
          </p>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="secondary"
              disabled={page <= 1 || bandejaQuery.isFetching}
              onClick={() => onPageChange(Math.max(1, page - 1))}
            >
              {t('notificaciones.bandeja.anterior')}
            </Button>
            <Button
              size="sm"
              variant="secondary"
              disabled={page >= totalPaginas || bandejaQuery.isFetching}
              onClick={() => onPageChange(page + 1)}
            >
              {t('notificaciones.bandeja.siguiente')}
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
};
