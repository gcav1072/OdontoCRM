import {
  NO_SHOW_GRACE_MINUTES,
  formatTime12h,
  type AppointmentSummary,
  type DayView,
  type Permission,
  type Role,
} from '@odontocrm/contracts';
import {
  Badge,
  Button,
  EmptyState,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@odontocrm/ui';
import { CalendarClock, History } from 'lucide-react';

import { useNow } from '../../hooks/useNow';
import { t } from '../../lib/i18n';
import {
  actionLabel,
  appointmentActions,
  noShowPending,
  type AppointmentAction,
} from '../../lib/scheduling';
import { AppointmentStatusBadge } from './AppointmentStatusBadge';

export interface DayAppointmentsTableProps {
  day: DayView;
  role: Role | null;
  hasPermission: (permission: Permission) => boolean;
  onAction: (action: AppointmentAction, appointment: AppointmentSummary) => void;
  onHistory: (appointment: AppointmentSummary) => void;
}

/**
 * Citas del día. Las acciones salen de `allowedTransitions(estado, rol)`: la
 * interfaz solo ofrece lo que la máquina de estados permite a ese rol, más los
 * permisos de la API y la tolerancia de la inasistencia (hora + 15 min).
 */
export const DayAppointmentsTable = ({
  day,
  role,
  hasPermission,
  onAction,
  onHistory,
}: DayAppointmentsTableProps) => {
  // El tic de 30 s hace que la inasistencia aparezca cuando ya pasó la tolerancia.
  const ahora = useNow(30_000);

  if (day.appointments.length === 0) {
    return (
      <EmptyState
        icon={<CalendarClock className="size-6" aria-hidden="true" />}
        title={t('programacion.citas.titulo')}
        description={t('programacion.citas.vacio')}
      />
    );
  }

  return (
    <Table caption={t('programacion.citas.total', { total: day.appointments.length })}>
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <TableHead>{t('programacion.citas.columna.hora')}</TableHead>
          <TableHead>{t('programacion.citas.columna.paciente')}</TableHead>
          <TableHead>{t('programacion.citas.columna.ticket')}</TableHead>
          <TableHead>{t('programacion.citas.columna.estado')}</TableHead>
          <TableHead>{t('programacion.citas.columna.llamados')}</TableHead>
          <TableHead className="text-right">{t('programacion.citas.columna.acciones')}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {day.appointments.map((cita) => {
          const acciones = appointmentActions(cita, { role, hasPermission, now: ahora });
          const faltan = noShowPending(cita, ahora);

          return (
            <TableRow key={cita.id}>
              <TableCell className="whitespace-nowrap">
                <span className="font-mono text-xs font-semibold text-ink">
                  {formatTime12h(cita.startTime)}
                </span>
                <span className="block text-xs text-ink-subtle">
                  {t('programacion.accion.hora', {
                    inicio: formatTime12h(cita.startTime),
                    fin: formatTime12h(cita.endTime),
                  })}
                </span>
                {cita.slotKind === 'manual' && (
                  <Badge variant="info">{t('programacion.citas.manual')}</Badge>
                )}
              </TableCell>

              <TableCell>
                <span className="block font-medium text-ink">{cita.patientName}</span>
                <span className="block text-xs text-ink-subtle">
                  {cita.patientDocument ?? t('comun.sinDato')} ·{' '}
                  {cita.patientPhone ?? t('comun.sinDato')}
                </span>
              </TableCell>

              <TableCell className="font-mono text-xs">
                {cita.ticket ?? t('comun.sinDato')}
              </TableCell>

              <TableCell>
                <AppointmentStatusBadge status={cita.status} />
              </TableCell>

              <TableCell>
                {cita.callCount === 0 ? (
                  <span className="text-xs text-ink-subtle">{t('comun.sinDato')}</span>
                ) : (
                  <Badge
                    variant={cita.callCount >= 2 ? 'danger' : 'neutral'}
                    aria-label={
                      cita.callCount >= 2
                        ? t('programacion.accion.segundoLlamado')
                        : t('programacion.accion.llamados', { total: cita.callCount })
                    }
                  >
                    {t('programacion.accion.llamados', { total: cita.callCount })}
                  </Badge>
                )}
              </TableCell>

              <TableCell>
                <div className="flex flex-wrap items-center justify-end gap-1.5">
                  {acciones.length === 0 ? (
                    <span className="text-xs text-ink-subtle">
                      {faltan === null
                        ? t('programacion.accion.sinAcciones')
                        : t('programacion.accion.inasistenciaPendiente', {
                            minutos: NO_SHOW_GRACE_MINUTES,
                            faltan,
                          })}
                    </span>
                  ) : (
                    acciones.map((accion) => (
                      <Button
                        key={accion}
                        size="sm"
                        variant={accion === 'cancel' ? 'ghost' : 'secondary'}
                        aria-label={`${actionLabel(accion, cita)}: ${cita.patientName}`}
                        onClick={() => onAction(accion, cita)}
                      >
                        {actionLabel(accion, cita)}
                      </Button>
                    ))
                  )}

                  {faltan !== null && acciones.length > 0 && (
                    <span className="text-xs text-ink-subtle">
                      {t('programacion.accion.inasistenciaPendiente', {
                        minutos: NO_SHOW_GRACE_MINUTES,
                        faltan,
                      })}
                    </span>
                  )}

                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={`${t('programacion.accion.historial')}: ${cita.patientName}`}
                    onClick={() => onHistory(cita)}
                    leadingIcon={<History className="size-3.5" aria-hidden="true" />}
                  >
                    {t('programacion.accion.historial')}
                  </Button>
                </div>
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
};
