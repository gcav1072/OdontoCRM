import {
  APPOINTMENT_STATUSES,
  formatTime12h,
  type AppointmentNotificationItem,
  type AppointmentStatus,
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
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarClock, PhoneCall, Send } from 'lucide-react';
import { useEffect, useState } from 'react';

import { apiErrorMessage } from '../../lib/api';
import {
  appointmentsApi,
  notificationsApi,
  type AppointmentsNotificationParams,
} from '../../lib/endpoints';
import { formatDate } from '../../lib/format';
import { APPOINTMENT_STATUS_LABELS, CHANNEL_LABELS, t } from '../../lib/i18n';
import { notificationKeys } from '../../lib/notifications';
import { formatDateOnly, schedulingKeys, todayInClinic } from '../../lib/scheduling';
import { AppointmentStatusBadge } from '../scheduling/AppointmentStatusBadge';
import { NotifyBatchDialog } from '../scheduling/NotifyBatchDialog';

const TAMANO_PAGINA = 25;
/** Días que se miran hacia adelante por defecto: lo que se avisa con antelación. */
const DIAS_POR_DEFECTO = 30;

export interface UpcomingAppointmentsCardProps {
  /** `scheduling:notify`: habilita «Notificar» y «Confirmar (llamada)». */
  canNotify: boolean;
  onNotice: (variant: 'success' | 'danger', message: string) => void;
}

type FiltroConfirmacion = '' | 'si' | 'no';

/** Fecha `AAAA-MM-DD` desplazada N días (aritmética de calendario, no de instantes). */
const desplazar = (date: string, dias: number): string =>
  new Date(new Date(`${date}T00:00:00Z`).getTime() + dias * 86_400_000).toISOString().slice(0, 10);

/** Etiqueta y color del **último aviso** de una cita. */
const AVISO_VARIANTE: Readonly<Record<string, 'success' | 'info' | 'warning' | 'danger'>> = {
  sent: 'success',
  sending: 'info',
  queued: 'info',
  skipped_no_channel: 'warning',
  failed: 'danger',
};

const etiquetaDeAviso = (status: NotificationStatus): string => {
  if (status === 'sent') return t('notificaciones.citas.aviso.enviado');
  if (status === 'failed') return t('notificaciones.citas.aviso.fallido');
  if (status === 'skipped_no_channel') return t('notificaciones.citas.aviso.manual');
  return t('notificaciones.citas.aviso.pendiente');
};

/** Una cita está pendiente de respuesta: es cuando tiene sentido confirmarla a mano. */
const esperaConfirmacion = (status: AppointmentStatus): boolean =>
  status === 'programada' || status === 'notificada';

/**
 * **Citas próximas** (ADR 0052): lo que viene, por dónde se le puede avisar a cada
 * paciente y si ya confirmó.
 *
 * Es la vista desde la que la secretaría trabaja el día antes: filtra por fecha, por
 * estado y por «confirmadas / sin confirmar», avisa a la cita que toque (el mismo
 * diálogo con vista previa del lote, reducido a una) y deja constancia de la
 * confirmación telefónica cuando el paciente contesta por teléfono.
 *
 * El aviso por Telegram/WhatsApp lleva un botón para confirmar; esa confirmación la
 * registra el bot y aquí aparece sola, porque el canal en vivo refresca la sección.
 */
export const UpcomingAppointmentsCard = ({
  canNotify,
  onNotice,
}: UpcomingAppointmentsCardProps) => {
  const cliente = useQueryClient();
  const hoy = todayInClinic();

  const [desde, setDesde] = useState(hoy);
  const [hasta, setHasta] = useState(() => desplazar(hoy, DIAS_POR_DEFECTO));
  const [estado, setEstado] = useState<'' | AppointmentStatus>('');
  const [confirmacion, setConfirmacion] = useState<FiltroConfirmacion>('');
  const [busqueda, setBusqueda] = useState('');
  const [pagina, setPagina] = useState(1);
  const [notificando, setNotificando] = useState<AppointmentNotificationItem | null>(null);

  // Cambiar cualquier filtro devuelve a la primera página (quedarse en la 5 de una
  // lista que ahora tiene 1 hoja muestra una tabla vacía sin explicación).
  useEffect(() => {
    setPagina(1);
  }, [desde, hasta, estado, confirmacion, busqueda]);

  const consulta: AppointmentsNotificationParams = {
    from: desde === '' ? undefined : desde,
    to: hasta === '' ? undefined : hasta,
    status: estado === '' ? undefined : estado,
    confirmed: confirmacion === '' ? undefined : confirmacion === 'si',
    search: busqueda.trim() === '' ? undefined : busqueda.trim(),
    page: pagina,
    pageSize: TAMANO_PAGINA,
  };

  const citasQuery = useQuery({
    queryKey: notificationKeys.appointments(consulta),
    queryFn: ({ signal }) => notificationsApi.appointments(consulta, signal),
    placeholderData: keepPreviousData,
  });

  const confirmar = useMutation({
    mutationFn: (cita: AppointmentNotificationItem) =>
      appointmentsApi.confirm(cita.appointmentId, { channel: 'telefono' }),
    onSuccess: () => {
      // La sección y la jornada, las dos: la cita acaba de cambiar de estado.
      void cliente.invalidateQueries({ queryKey: notificationKeys.appointmentsRoot });
      void cliente.invalidateQueries({ queryKey: schedulingKeys.appointmentsRoot });
      void cliente.invalidateQueries({ queryKey: schedulingKeys.daysRoot });
      onNotice('success', t('notificaciones.citas.confirmarOk'));
    },
    onError: (fallo) => onNotice('danger', apiErrorMessage(fallo)),
  });

  const pagina1 = citasQuery.data;
  const total = pagina1?.total ?? 0;
  const paginas = pagina1?.totalPages ?? 1;

  return (
    <Card>
      <CardHeader>
        <CardTitle as="h2" className="flex items-center gap-2">
          <CalendarClock className="size-4 text-primary" aria-hidden="true" />
          {t('notificaciones.citas.titulo')}
        </CardTitle>
        <p className="text-sm text-ink-muted">{t('notificaciones.citas.descripcion')}</p>
      </CardHeader>

      <CardContent className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <Field label={t('notificaciones.citas.filtro.desde')}>
            <Input type="date" value={desde} onChange={(event) => setDesde(event.target.value)} />
          </Field>
          <Field label={t('notificaciones.citas.filtro.hasta')}>
            <Input type="date" value={hasta} onChange={(event) => setHasta(event.target.value)} />
          </Field>
          <Field label={t('notificaciones.citas.filtro.estado')}>
            <Select
              value={estado}
              onChange={(event) => setEstado(event.target.value as '' | AppointmentStatus)}
            >
              <option value="">{t('notificaciones.citas.filtro.todos')}</option>
              {APPOINTMENT_STATUSES.map((valor) => (
                <option key={valor} value={valor}>
                  {APPOINTMENT_STATUS_LABELS[valor]}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t('notificaciones.citas.filtro.confirmacion')}>
            <Select
              value={confirmacion}
              onChange={(event) => setConfirmacion(event.target.value as FiltroConfirmacion)}
            >
              <option value="">{t('notificaciones.citas.filtro.cualquiera')}</option>
              <option value="si">{t('notificaciones.citas.filtro.confirmadas')}</option>
              <option value="no">{t('notificaciones.citas.filtro.sinConfirmar')}</option>
            </Select>
          </Field>
          <Field label={t('notificaciones.bandeja.filtro.buscar')}>
            <Input
              value={busqueda}
              placeholder={t('notificaciones.bandeja.filtro.buscarPlaceholder')}
              onChange={(event) => setBusqueda(event.target.value)}
            />
          </Field>
        </div>

        {citasQuery.isPending ? (
          <Spinner label={t('notificaciones.citas.cargando')} showLabel />
        ) : citasQuery.isError ? (
          <Alert variant="danger" title={t('notificaciones.citas.error')}>
            {apiErrorMessage(citasQuery.error)}
          </Alert>
        ) : total === 0 ? (
          <EmptyState
            icon={<CalendarClock className="size-6" aria-hidden="true" />}
            title={t('notificaciones.citas.vacioTitulo')}
            description={t('notificaciones.citas.vacio')}
          />
        ) : (
          <>
            <Table
              caption={t('notificaciones.citas.total', { total })}
              containerClassName="border-border"
            >
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead>{t('notificaciones.citas.columna.fecha')}</TableHead>
                  <TableHead>{t('notificaciones.citas.columna.paciente')}</TableHead>
                  <TableHead>{t('notificaciones.citas.columna.canal')}</TableHead>
                  <TableHead>{t('notificaciones.citas.columna.estado')}</TableHead>
                  <TableHead>{t('notificaciones.citas.columna.confirmada')}</TableHead>
                  <TableHead>{t('notificaciones.citas.columna.aviso')}</TableHead>
                  {canNotify && <TableHead>{t('notificaciones.citas.columna.acciones')}</TableHead>}
                </TableRow>
              </TableHeader>
              <TableBody>
                {pagina1?.items.map((cita) => (
                  <TableRow key={cita.appointmentId}>
                    <TableCell className="text-sm text-ink">
                      <span className="block">{formatDateOnly(cita.date)}</span>
                      <span className="block text-xs text-ink-subtle">
                        {formatTime12h(cita.startTime)}
                      </span>
                    </TableCell>
                    <TableCell>
                      <span className="block text-sm font-medium text-ink">
                        {cita.ticket ?? t('comun.sinDato')} · {cita.patientName}
                      </span>
                      <span className="block text-xs text-ink-subtle">
                        {cita.patientPhone ?? t('programacion.notificar.sinTelefono')}
                      </span>
                    </TableCell>
                    <TableCell>
                      {cita.channel === null ? (
                        <span
                          className="text-xs text-ink-subtle"
                          title={t('notificaciones.citas.sinCanalAyuda')}
                        >
                          {t('notificaciones.citas.sinCanal')}
                        </span>
                      ) : (
                        <>
                          <Badge variant="neutral">{CHANNEL_LABELS[cita.channel]}</Badge>
                          <span className="block pt-1 font-mono text-xs text-ink-muted">
                            {cita.direccionMasked}
                          </span>
                        </>
                      )}
                    </TableCell>
                    <TableCell>
                      <AppointmentStatusBadge status={cita.status} />
                    </TableCell>
                    <TableCell className="text-sm">
                      {cita.confirmedAt === null ? (
                        <span className="text-ink-subtle">
                          {t('notificaciones.citas.confirmada.no')}
                        </span>
                      ) : (
                        <Badge variant="success" dot>
                          {t('notificaciones.citas.confirmada.si', {
                            fecha: formatDate(cita.confirmedAt),
                          })}
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-sm">
                      {cita.lastNotification === null ? (
                        <span className="text-ink-subtle">
                          {t('notificaciones.citas.aviso.ninguno')}
                        </span>
                      ) : (
                        <>
                          <Badge
                            variant={AVISO_VARIANTE[cita.lastNotification.status] ?? 'neutral'}
                          >
                            {etiquetaDeAviso(cita.lastNotification.status)}
                          </Badge>
                          <span className="block pt-1 text-xs text-ink-subtle">
                            {cita.lastNotification.contactedAt !== null
                              ? t('notificaciones.citas.aviso.manualHecho', {
                                  fecha: formatDate(cita.lastNotification.contactedAt),
                                })
                              : cita.lastNotification.sentAt !== null
                                ? formatDate(cita.lastNotification.sentAt)
                                : ''}
                          </span>
                        </>
                      )}
                    </TableCell>
                    {canNotify && (
                      <TableCell>
                        <div className="flex flex-wrap gap-2">
                          <Button
                            size="sm"
                            variant="secondary"
                            leadingIcon={<Send className="size-4" aria-hidden="true" />}
                            onClick={() => setNotificando(cita)}
                          >
                            {t('notificaciones.citas.notificar')}
                          </Button>
                          {cita.confirmedAt === null && esperaConfirmacion(cita.status) && (
                            <Button
                              size="sm"
                              variant="ghost"
                              loading={confirmar.isPending}
                              leadingIcon={<PhoneCall className="size-4" aria-hidden="true" />}
                              onClick={() => confirmar.mutate(cita)}
                            >
                              {t('notificaciones.citas.confirmarTelefono')}
                            </Button>
                          )}
                        </div>
                      </TableCell>
                    )}
                  </TableRow>
                ))}
              </TableBody>
            </Table>

            {paginas > 1 && (
              <div className="flex items-center justify-between gap-3">
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={pagina <= 1}
                  onClick={() => setPagina((actual) => Math.max(1, actual - 1))}
                >
                  {t('notificaciones.bandeja.anterior')}
                </Button>
                <span className="text-xs text-ink-subtle">
                  {t('notificaciones.bandeja.pagina', { pagina, paginas })}
                </span>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={pagina >= paginas}
                  onClick={() => setPagina((actual) => Math.min(paginas, actual + 1))}
                >
                  {t('notificaciones.bandeja.siguiente')}
                </Button>
              </div>
            )}
          </>
        )}
      </CardContent>

      {notificando !== null && (
        <NotifyBatchDialog
          date={notificando.date}
          appointmentIds={[notificando.appointmentId]}
          onClose={() => setNotificando(null)}
          onNotified={(resultado) => {
            setNotificando(null);
            void cliente.invalidateQueries({ queryKey: notificationKeys.appointmentsRoot });
            onNotice(
              'success',
              t('notificaciones.citas.notificado', { total: resultado.notified }),
            );
          }}
        />
      )}
    </Card>
  );
};
