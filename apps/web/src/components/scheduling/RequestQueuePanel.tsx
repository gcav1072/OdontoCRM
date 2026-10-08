import {
  CHANNELS,
  REQUEST_STATUSES,
  formatTime12h,
  type AppointmentStatus,
  type Channel,
  type RequestStatus,
  type RequestSummary,
} from '@odontocrm/contracts';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Checkbox,
  EmptyState,
  Field,
  Input,
  Select,
  Spinner,
  cn,
} from '@odontocrm/ui';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { ClipboardList, Plus, Search } from 'lucide-react';
import { useEffect, useState, type DragEvent } from 'react';

import { useDebouncedValue } from '../../hooks/useDebouncedValue';
import { apiErrorMessage } from '../../lib/api';
import { requestsApi } from '../../lib/endpoints';
import { APPOINTMENT_STATUS_LABELS, CHANNEL_LABELS, t } from '../../lib/i18n';
import { formatDateOnly, schedulingKeys } from '../../lib/scheduling';
import { AppointmentStatusBadge } from './AppointmentStatusBadge';

const TAMANO_PAGINA = 25;

export interface RequestQueuePanelProps {
  /** Solicitud elegida para asignar con el teclado. */
  selectedRequestId: string | null;
  /** `scheduling:write`: habilita «Nueva solicitud», «Asignar» y «Cancelar». */
  canWrite: boolean;
  onSelect: (request: RequestSummary | null) => void;
  onAssign: (request: RequestSummary) => void;
  onCancel: (request: RequestSummary) => void;
  onNew: () => void;
}

const puedeCancelarse = (status: AppointmentStatus): boolean =>
  status === 'en_espera_cita' || status === 'programada' || status === 'notificada';

/**
 * Cola de solicitudes (panel izquierdo de `/programacion`): filtros por estado,
 * canal y búsqueda diferida, orden por ticket o por antigüedad, y por fila las
 * acciones «Asignar» y «Cancelar».
 *
 * La fila entera es un botón: se selecciona con clic o con Enter y se puede
 * arrastrar a una franja libre de la jornada (el arrastre es un atajo; asignar
 * con el teclado funciona igual).
 */
export const RequestQueuePanel = ({
  selectedRequestId,
  canWrite,
  onSelect,
  onAssign,
  onCancel,
  onNew,
}: RequestQueuePanelProps) => {
  const [estado, setEstado] = useState<'' | RequestStatus>('');
  const [canal, setCanal] = useState<'' | Channel>('');
  const [soloEspera, setSoloEspera] = useState(false);
  const [busqueda, setBusqueda] = useState('');
  const [orden, setOrden] = useState<'ticket' | 'antiguedad'>('ticket');
  const [pagina, setPagina] = useState(1);

  const busquedaDiferida = useDebouncedValue(busqueda, 350);

  // Cualquier cambio de filtro vuelve a la primera página.
  useEffect(() => {
    setPagina(1);
  }, [estado, canal, soloEspera, busquedaDiferida, orden]);

  const filtros = {
    status: estado === '' ? undefined : estado,
    onlyWaiting: soloEspera ? true : undefined,
    channel: canal === '' ? undefined : canal,
    search: busquedaDiferida.trim() === '' ? undefined : busquedaDiferida.trim(),
    order: orden,
    page: pagina,
    pageSize: TAMANO_PAGINA,
  };

  const colaQuery = useQuery({
    queryKey: schedulingKeys.requests(filtros),
    queryFn: ({ signal }) => requestsApi.list(filtros, signal),
    placeholderData: keepPreviousData,
  });

  const datos = colaQuery.data;
  const total = datos?.total ?? 0;
  const totalPaginas = datos?.totalPages ?? 1;

  const arrastrar = (event: DragEvent<HTMLButtonElement>, solicitud: RequestSummary) => {
    event.dataTransfer.setData('text/plain', solicitud.id);
    event.dataTransfer.effectAllowed = 'move';
    onSelect(solicitud);
  };

  return (
    <Card className="flex h-full flex-col">
      <CardHeader className="gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <CardTitle as="h2" className="flex items-center gap-2">
            <ClipboardList className="size-4 text-primary" aria-hidden="true" />
            {t('programacion.cola.titulo')}
          </CardTitle>
          <p className="pt-1 text-sm text-ink-muted">{t('programacion.cola.descripcion')}</p>
        </div>
        {canWrite && (
          <Button onClick={onNew} leadingIcon={<Plus className="size-4" aria-hidden="true" />}>
            {t('programacion.cola.nueva')}
          </Button>
        )}
      </CardHeader>

      <CardContent className="flex min-h-0 flex-1 flex-col gap-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t('programacion.cola.filtro.buscar')} className="sm:col-span-2">
            <div className="relative">
              <Search
                className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-ink-subtle"
                aria-hidden="true"
              />
              <Input
                type="search"
                className="pl-9"
                placeholder={t('programacion.cola.filtro.buscarPlaceholder')}
                value={busqueda}
                onChange={(event) => setBusqueda(event.target.value)}
              />
            </div>
          </Field>

          <Field label={t('programacion.cola.filtro.estado')}>
            <Select
              value={estado}
              onChange={(event) => setEstado(event.target.value as '' | RequestStatus)}
            >
              <option value="">{t('programacion.cola.filtro.todos')}</option>
              {/* Estados de **solicitud**: la lista no incluye «confirmada», que es un
                  estado de una cita ya agendada (ADR 0052). */}
              {REQUEST_STATUSES.map((valor) => (
                <option key={valor} value={valor}>
                  {APPOINTMENT_STATUS_LABELS[valor]}
                </option>
              ))}
            </Select>
          </Field>

          <Field label={t('programacion.cola.filtro.canal')}>
            <Select
              value={canal}
              onChange={(event) => setCanal(event.target.value as '' | Channel)}
            >
              <option value="">{t('programacion.cola.filtro.todos')}</option>
              {CHANNELS.map((valor) => (
                <option key={valor} value={valor}>
                  {CHANNEL_LABELS[valor]}
                </option>
              ))}
            </Select>
          </Field>

          <Field label={t('programacion.cola.orden')}>
            <Select
              value={orden}
              onChange={(event) => setOrden(event.target.value as 'ticket' | 'antiguedad')}
            >
              <option value="ticket">{t('programacion.cola.orden.ticket')}</option>
              <option value="antiguedad">{t('programacion.cola.orden.antiguedad')}</option>
            </Select>
          </Field>

          <div className="flex items-end pb-2">
            <Checkbox
              label={t('programacion.cola.filtro.soloEspera')}
              checked={soloEspera}
              onChange={(event) => setSoloEspera(event.target.checked)}
            />
          </div>
        </div>

        {colaQuery.isError && (
          <Alert variant="danger" title={t('programacion.cola.error')}>
            {apiErrorMessage(colaQuery.error)}
          </Alert>
        )}

        {colaQuery.isPending ? (
          <div className="py-10">
            <Spinner label={t('programacion.cola.cargando')} showLabel />
          </div>
        ) : datos !== undefined && datos.items.length === 0 ? (
          <EmptyState
            icon={<ClipboardList className="size-6" aria-hidden="true" />}
            title={t('programacion.cola.vacioTitulo')}
            description={t('programacion.cola.vacio')}
          />
        ) : (
          <ul className="min-h-0 flex-1 space-y-2 overflow-y-auto pr-1">
            {datos?.items.map((solicitud) => {
              const seleccionada = solicitud.id === selectedRequestId;
              const asignable = solicitud.status === 'en_espera_cita';

              return (
                <li
                  key={solicitud.id}
                  className={cn(
                    'rounded-control border bg-surface p-3 transition-colors',
                    seleccionada ? 'border-primary bg-primary/5' : 'border-border',
                  )}
                >
                  <button
                    type="button"
                    draggable={canWrite && asignable}
                    aria-pressed={seleccionada}
                    aria-label={t('programacion.cola.seleccionar', {
                      ticket: solicitud.ticket,
                      paciente: solicitud.patientName,
                    })}
                    title={canWrite && asignable ? t('programacion.cola.arrastrar') : undefined}
                    className={cn(
                      'w-full rounded-control text-left',
                      canWrite && asignable ? 'cursor-grab' : 'cursor-pointer',
                      'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-solid focus-visible:outline-focus',
                    )}
                    onClick={() => onSelect(seleccionada ? null : solicitud)}
                    onDragStart={(event) => arrastrar(event, solicitud)}
                  >
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="font-mono text-xs font-semibold text-ink">
                        {solicitud.ticket}
                      </span>
                      <AppointmentStatusBadge status={solicitud.status} />
                      {seleccionada && (
                        <Badge variant="primary">{t('programacion.cola.seleccionada')}</Badge>
                      )}
                    </span>

                    <span className="block pt-1 text-sm font-medium text-ink">
                      {solicitud.patientName}
                    </span>

                    <span className="block text-xs text-ink-subtle">
                      {solicitud.patientPhone ?? t('comun.sinDato')}
                      {solicitud.patientDocument !== null && ` · ${solicitud.patientDocument}`}
                    </span>

                    <span className="block pt-1 text-xs text-ink-muted">{solicitud.reason}</span>

                    <span className="flex flex-wrap items-center gap-2 pt-1.5">
                      <Badge variant="neutral">{CHANNEL_LABELS[solicitud.channel]}</Badge>
                      <Badge variant={solicitud.waitingDays > 3 ? 'warning' : 'info'}>
                        {solicitud.waitingDays === 0
                          ? t('programacion.cola.antiguedadHoy')
                          : t('programacion.cola.antiguedad', { dias: solicitud.waitingDays })}
                      </Badge>
                    </span>

                    {solicitud.appointmentDate !== null && (
                      <span className="block pt-1 text-xs text-ink-muted">
                        {t('programacion.cola.cita', {
                          fecha: formatDateOnly(solicitud.appointmentDate),
                          hora:
                            solicitud.appointmentTime === null
                              ? t('comun.sinDato')
                              : formatTime12h(solicitud.appointmentTime),
                        })}
                      </span>
                    )}
                  </button>

                  {canWrite && (
                    <div className="mt-2 flex flex-wrap gap-2">
                      <Button
                        size="sm"
                        variant="secondary"
                        disabled={!asignable}
                        title={asignable ? undefined : t('programacion.cola.yaAsignada')}
                        onClick={() => onAssign(solicitud)}
                      >
                        {t('programacion.cola.asignar')}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={!puedeCancelarse(solicitud.status)}
                        onClick={() => onCancel(solicitud)}
                      >
                        {t('programacion.cola.cancelar')}
                      </Button>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}

        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3">
          <p className="text-xs text-ink-subtle">
            {t('programacion.cola.total', { total })}
            {' · '}
            {t('programacion.cola.pagina', { pagina, paginas: totalPaginas })}
          </p>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="secondary"
              disabled={pagina <= 1 || colaQuery.isFetching}
              onClick={() => setPagina((valor) => Math.max(1, valor - 1))}
            >
              {t('programacion.cola.anterior')}
            </Button>
            <Button
              size="sm"
              variant="secondary"
              disabled={pagina >= totalPaginas || colaQuery.isFetching}
              onClick={() => setPagina((valor) => valor + 1)}
            >
              {t('programacion.cola.siguiente')}
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
};
