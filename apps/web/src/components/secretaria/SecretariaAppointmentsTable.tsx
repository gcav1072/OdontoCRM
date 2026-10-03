import {
  formatTime12h,
  type AppointmentSummary,
  type Permission,
  type Role,
} from '@odontocrm/contracts';
import {
  Badge,
  Button,
  Table,
  TableBody,
  TableCell,
  TableEmpty,
  TableHead,
  TableHeader,
  TableRow,
} from '@odontocrm/ui';
import { History } from 'lucide-react';

import { useNow } from '../../hooks/useNow';
import { t } from '../../lib/i18n';
import { noShowPending } from '../../lib/scheduling';
import { AppointmentStatusBadge } from '../scheduling/AppointmentStatusBadge';
import {
  accionesDeFila,
  etiquetaDeAccion,
  requiereLlamadoFueraDeOrden,
  type AccionSecretaria,
} from './acciones';

export interface SecretariaAppointmentsTableProps {
  /** Citas del día ya filtradas por el buscador y ordenadas por hora. */
  appointments: readonly AppointmentSummary[];
  role: Role | null;
  hasPermission: (permission: Permission) => boolean;
  /** Hay una transición en vuelo: se bloquean los botones para no repetirla. */
  busy: boolean;
  onAction: (action: AccionSecretaria, appointment: AppointmentSummary) => void;
  onEmergencyCall: (appointment: AppointmentSummary) => void;
  onHistory: (appointment: AppointmentSummary) => void;
}

const COLUMNAS = 7;

/**
 * Jornada hora por hora con las acciones del flujo en cada fila. Las acciones
 * salen de la máquina de estados (estado + rol) y del permiso de escritura, así
 * que la fila solo enseña lo que el servidor va a aceptar: registrar llegada,
 * llamar (segundo llamado incluido), pasar a consulta, marcar atendido o
 * inasistencia y, cuando el estado no admite el llamado, llamar fuera de orden.
 */
export const SecretariaAppointmentsTable = ({
  appointments,
  role,
  hasPermission,
  busy,
  onAction,
  onEmergencyCall,
  onHistory,
}: SecretariaAppointmentsTableProps) => {
  // El tic de 30 s hace aparecer la inasistencia en cuanto pasa la tolerancia.
  const ahora = useNow(30_000);

  return (
    <Table caption={t('programacion.citas.total', { total: appointments.length })}>
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <TableHead>{t('secretaria.columna.hora')}</TableHead>
          <TableHead>{t('secretaria.columna.paciente')}</TableHead>
          <TableHead>{t('secretaria.columna.documento')}</TableHead>
          <TableHead>{t('secretaria.columna.telefono')}</TableHead>
          <TableHead>{t('secretaria.columna.ticket')}</TableHead>
          <TableHead>{t('secretaria.columna.estado')}</TableHead>
          <TableHead className="text-right">{t('secretaria.columna.acciones')}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {appointments.length === 0 ? (
          <TableEmpty colSpan={COLUMNAS}>{t('secretaria.sinResultados')}</TableEmpty>
        ) : (
          appointments.map((cita) => {
            const acciones = accionesDeFila(cita, { role, hasPermission, now: ahora });
            const fueraDeOrden = requiereLlamadoFueraDeOrden(acciones);
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
                </TableCell>

                <TableCell className="font-medium text-ink">{cita.patientName}</TableCell>

                <TableCell className="whitespace-nowrap text-sm text-ink-muted">
                  {cita.patientDocument ?? t('comun.sinDato')}
                </TableCell>

                <TableCell className="whitespace-nowrap text-sm text-ink-muted">
                  {cita.patientPhone ?? t('comun.sinDato')}
                </TableCell>

                <TableCell className="font-mono text-xs">
                  {cita.ticket ?? t('comun.sinDato')}
                </TableCell>

                <TableCell>
                  <span className="flex flex-wrap items-center gap-1.5">
                    <AppointmentStatusBadge status={cita.status} />
                    {/* A partir del segundo llamado el display de la sala lo pinta
                        en rojo: aquí se ve el mismo aviso en la fila. */}
                    {cita.callCount > 0 && (
                      <Badge variant={cita.callCount >= 2 ? 'danger' : 'neutral'}>
                        {t('programacion.accion.llamados', { total: cita.callCount })}
                      </Badge>
                    )}
                  </span>
                </TableCell>

                <TableCell>
                  <div className="flex flex-wrap items-center justify-end gap-1.5">
                    {acciones.map((accion, indice) => (
                      <Button
                        key={accion}
                        size="sm"
                        variant={
                          accion === 'no-show' ? 'ghost' : indice === 0 ? 'primary' : 'secondary'
                        }
                        disabled={busy}
                        aria-label={`${etiquetaDeAccion(accion, cita)}: ${cita.patientName}`}
                        onClick={() => onAction(accion, cita)}
                      >
                        {etiquetaDeAccion(accion, cita)}
                      </Button>
                    ))}

                    {fueraDeOrden && (
                      <Button
                        size="sm"
                        variant="secondary"
                        disabled={busy}
                        aria-label={`${t('secretaria.acciones.fueraDeOrden')}: ${cita.patientName}`}
                        onClick={() => onEmergencyCall(cita)}
                      >
                        {t('secretaria.acciones.fueraDeOrden')}
                      </Button>
                    )}

                    {acciones.length === 0 && !fueraDeOrden && (
                      <span className="text-xs text-ink-subtle">
                        {t('programacion.accion.sinAcciones')}
                      </span>
                    )}

                    {faltan !== null && (
                      <span className="text-xs text-ink-subtle">
                        {t('secretaria.noAsistio.muyPronto')}
                      </span>
                    )}

                    <Button
                      size="sm"
                      variant="ghost"
                      aria-label={`${t('secretaria.acciones.detalle')}: ${cita.patientName}`}
                      onClick={() => onHistory(cita)}
                      leadingIcon={<History className="size-3.5" aria-hidden="true" />}
                    >
                      {t('secretaria.acciones.detalle')}
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            );
          })
        )}
      </TableBody>
    </Table>
  );
};
