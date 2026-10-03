import type { AppointmentSummary } from '@odontocrm/contracts';
import { useQuery } from '@tanstack/react-query';
import {
  Alert,
  Button,
  Dialog,
  Spinner,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@odontocrm/ui';

import { apiErrorMessage } from '../../lib/api';
import { appointmentsApi } from '../../lib/endpoints';
import { formatDateTime } from '../../lib/format';
import { APPOINTMENT_STATUS_LABELS, t } from '../../lib/i18n';
import { schedulingKeys } from '../../lib/scheduling';
import { AppointmentStatusBadge } from './AppointmentStatusBadge';

export interface AppointmentHistoryDialogProps {
  appointment: AppointmentSummary;
  onClose: () => void;
}

/** Historial de estados de una cita: de → a, motivo, quién y cuándo. */
export const AppointmentHistoryDialog = ({
  appointment,
  onClose,
}: AppointmentHistoryDialogProps) => {
  const historialQuery = useQuery({
    queryKey: schedulingKeys.history(appointment.id),
    queryFn: ({ signal }) => appointmentsApi.history(appointment.id, signal),
  });

  const movimientos = historialQuery.data?.items ?? [];

  return (
    <Dialog
      open
      onClose={onClose}
      size="lg"
      title={t('programacion.historial.titulo')}
      description={`${appointment.patientName} · ${t('programacion.historial.texto')}`}
      closeLabel={t('comun.cerrar')}
      footer={
        <Button variant="secondary" onClick={onClose}>
          {t('comun.cerrar')}
        </Button>
      }
    >
      {historialQuery.isPending ? (
        <Spinner label={t('programacion.historial.cargando')} showLabel />
      ) : historialQuery.isError ? (
        <Alert variant="danger" title={t('programacion.historial.error')}>
          {apiErrorMessage(historialQuery.error)}
        </Alert>
      ) : movimientos.length === 0 ? (
        <Alert variant="info">{t('programacion.historial.vacio')}</Alert>
      ) : (
        <Table caption={t('programacion.historial.total', { total: movimientos.length })}>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>{t('programacion.historial.columna.cambio')}</TableHead>
              <TableHead>{t('programacion.historial.columna.motivo')}</TableHead>
              <TableHead>{t('programacion.historial.columna.actor')}</TableHead>
              <TableHead>{t('programacion.historial.columna.cuando')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {movimientos.map((movimiento) => (
              <TableRow key={movimiento.id}>
                <TableCell>
                  <span className="flex flex-wrap items-center gap-1.5">
                    {movimiento.fromStatus === null ? (
                      <AppointmentStatusBadge status={movimiento.toStatus} dot={false} />
                    ) : (
                      <>
                        <span className="text-xs text-ink-subtle">
                          {APPOINTMENT_STATUS_LABELS[movimiento.fromStatus]}
                        </span>
                        <span aria-hidden="true" className="text-ink-subtle">
                          →
                        </span>
                        <AppointmentStatusBadge status={movimiento.toStatus} dot={false} />
                      </>
                    )}
                  </span>
                </TableCell>
                <TableCell className="text-sm text-ink-muted">
                  {movimiento.reason ?? t('comun.sinDato')}
                </TableCell>
                <TableCell className="text-sm text-ink-muted">
                  {movimiento.actorUsername ?? t('programacion.historial.sistema')}
                </TableCell>
                <TableCell className="text-sm text-ink-muted">
                  {formatDateTime(movimiento.occurredAt)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </Dialog>
  );
};
