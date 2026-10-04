import type { AppointmentSummary, DayView, Permission, Role } from '@odontocrm/contracts';
import { formatTime12h } from '@odontocrm/contracts';
import { Badge, Button, Card, Field, Input } from '@odontocrm/ui';
import {
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  History,
  RefreshCw,
  Search,
  UserRound,
} from 'lucide-react';

import { t } from '../../lib/i18n';
import { formatDateOnly } from '../../lib/scheduling';
import { AppointmentStatusBadge } from '../scheduling/AppointmentStatusBadge';
import {
  accionesDeFila,
  etiquetaDeAccion,
  requiereLlamadoFueraDeOrden,
  type AccionSecretaria,
} from '../secretaria/acciones';
import { DayCounters } from '../secretaria/DayCounters';
import { ayudaDeAtajo, type AccionFlujo } from './flujo';

export interface FlowTopBarProps {
  date: string;
  day: DayView | undefined;
  isFetching: boolean;
  onShift: (days: number) => void;
  onToday: () => void;
  onDateChange: (date: string) => void;
  onReload: () => void;

  /** Cita en curso: la barra ofrece sus acciones y el paciente que hay en el centro. */
  appointment: AppointmentSummary | null;
  role: Role | null;
  hasPermission: (permission: Permission) => boolean;
  /** Hay una transición en vuelo: se bloquean los botones para no repetirla. */
  busy: boolean;
  now: Date;
  onAction: (action: AccionSecretaria, appointment: AppointmentSummary) => void;
  onEmergencyCall: (appointment: AppointmentSummary) => void;
  onHistory: (appointment: AppointmentSummary) => void;
  /** Los atajos también se ofrecen como botones: en una tableta no hay teclado. */
  onShortcut: (action: AccionFlujo) => void;
}

/**
 * Barra superior de `/flujo`: **todo el día en una franja**.
 *
 * Arriba la fecha de la jornada (anterior, hoy, siguiente y campo de fecha) con los
 * contadores del servidor; debajo, el paciente en curso con las cinco acciones de
 * secretaría —llegada, llamar, pasar a consulta, atendido e inasistencia—, el
 * llamado fuera de orden y el historial de la cita, más los atajos de teclado como
 * botones (en la tableta del consultorio no hay teclado).
 *
 * Las acciones salen de la máquina de estados y de los permisos
 * (`accionesDeFila`), así que la barra solo enseña lo que el servidor va a aceptar.
 */
export const FlowTopBar = ({
  date,
  day,
  isFetching,
  onShift,
  onToday,
  onDateChange,
  onReload,
  appointment,
  role,
  hasPermission,
  busy,
  now,
  onAction,
  onEmergencyCall,
  onHistory,
  onShortcut,
}: FlowTopBarProps) => {
  const acciones =
    appointment === null ? [] : accionesDeFila(appointment, { role, hasPermission, now });
  const fueraDeOrden = requiereLlamadoFueraDeOrden(acciones);

  return (
    <Card className="lg:sticky lg:top-4 lg:z-20">
      <div className="space-y-4 p-4 sm:p-5">
        {/* Fecha de la jornada y contadores del día. */}
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div className="min-w-0">
            <h1 className="flex items-center gap-2 text-lg font-semibold text-ink">
              <CalendarDays className="size-5 text-primary" aria-hidden />
              {t('flujo.titulo')}
            </h1>
            <p className="flex flex-wrap items-center gap-2 pt-0.5 text-sm text-ink-muted">
              <span className="font-medium text-ink">{formatDateOnly(date)}</span>
              {day !== undefined && (
                <span className="first-letter:uppercase">{day.weekdayName}</span>
              )}
              {day !== undefined && !day.isWorkingDay && (
                <Badge variant="warning">{t('programacion.fecha.noLaborable')}</Badge>
              )}
            </p>
          </div>

          <div className="flex flex-wrap items-end gap-2">
            <Button
              variant="secondary"
              aria-label={t('secretaria.diaAnterior')}
              title={t('secretaria.diaAnterior')}
              onClick={() => onShift(-1)}
              leadingIcon={<ChevronLeft className="size-4" aria-hidden />}
            />
            <Button variant="secondary" onClick={onToday}>
              {t('secretaria.hoy')}
            </Button>
            <Button
              variant="secondary"
              aria-label={t('secretaria.diaSiguiente')}
              title={t('secretaria.diaSiguiente')}
              onClick={() => onShift(1)}
              leadingIcon={<ChevronRight className="size-4" aria-hidden />}
            />
            <Field label={t('flujo.fecha')} className="w-40">
              <Input
                type="date"
                value={date}
                onChange={(event) => {
                  // El campo nativo avisa en cada tecla: solo se aplica la fecha completa.
                  if (event.target.value.length === 10) onDateChange(event.target.value);
                }}
              />
            </Field>
            <Button
              variant="secondary"
              aria-label={t('programacion.fecha.recargar')}
              title={t('programacion.fecha.recargar')}
              loading={isFetching}
              onClick={onReload}
              leadingIcon={<RefreshCw className="size-4" aria-hidden />}
            />
          </div>
        </div>

        {day !== undefined && <DayCounters counts={day.counts} dense />}

        {/* Paciente en curso y sus acciones del flujo. */}
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-control border border-border bg-surface-muted/60 px-3 py-2.5">
          <div className="flex min-w-0 items-center gap-2">
            <UserRound className="size-4 shrink-0 text-primary" aria-hidden />
            {appointment === null ? (
              <p className="text-sm text-ink-muted">{t('flujo.sinPaciente')}</p>
            ) : (
              <p className="min-w-0 truncate text-sm text-ink">
                <span className="font-medium">{appointment.patientName}</span>
                <span className="text-ink-muted">
                  {' · '}
                  {t('programacion.accion.hora', {
                    inicio: formatTime12h(appointment.startTime),
                    fin: formatTime12h(appointment.endTime),
                  })}
                  {appointment.patientDocument !== null ? ` · ${appointment.patientDocument}` : ''}
                </span>
              </p>
            )}
            {appointment !== null && <AppointmentStatusBadge status={appointment.status} />}
          </div>

          {appointment !== null && (
            <div className="flex flex-wrap items-center gap-1.5">
              {acciones.map((accion, indice) => (
                <Button
                  key={accion}
                  size="lg"
                  variant={accion === 'no-show' ? 'ghost' : indice === 0 ? 'primary' : 'secondary'}
                  disabled={busy}
                  aria-label={`${etiquetaDeAccion(accion, appointment)}: ${appointment.patientName}`}
                  onClick={() => onAction(accion, appointment)}
                >
                  {etiquetaDeAccion(accion, appointment)}
                </Button>
              ))}

              {fueraDeOrden && (
                <Button
                  size="lg"
                  variant="secondary"
                  disabled={busy}
                  aria-label={`${t('secretaria.acciones.fueraDeOrden')}: ${appointment.patientName}`}
                  onClick={() => onEmergencyCall(appointment)}
                >
                  {t('secretaria.acciones.fueraDeOrden')}
                </Button>
              )}

              {acciones.length === 0 && !fueraDeOrden && (
                <span className="text-xs text-ink-subtle">
                  {t('programacion.accion.sinAcciones')}
                </span>
              )}

              <Button
                size="lg"
                variant="ghost"
                aria-label={`${t('secretaria.acciones.detalle')}: ${appointment.patientName}`}
                onClick={() => onHistory(appointment)}
                leadingIcon={<History className="size-4" aria-hidden />}
              >
                {t('secretaria.acciones.detalle')}
              </Button>
            </div>
          )}
        </div>

        {/* Atajos: teclas en el puesto de trabajo, botones en la tableta. El grupo
            lleva nombre accesible para que se anuncie como un conjunto y para poder
            distinguirlo del botón que ofrece la pantalla vacía («Sin paciente»). */}
        <div
          role="group"
          aria-label={t('flujo.atajos.grupo')}
          className="flex flex-wrap items-center gap-2"
        >
          <Button
            variant="secondary"
            onClick={() => onShortcut('buscar')}
            leadingIcon={<Search className="size-4" aria-hidden />}
          >
            {t('flujo.atajo.buscar')}
          </Button>
          <Button
            variant="secondary"
            disabled={appointment === null || busy}
            onClick={() => onShortcut('llamar')}
            title={ayudaDeAtajo('llamar')}
          >
            {t('flujo.atajo.llamar')}
          </Button>
          <Button
            variant="secondary"
            disabled={appointment === null}
            onClick={() => onShortcut('cerrar-sesion')}
            title={ayudaDeAtajo('cerrar-sesion')}
          >
            {t('flujo.atajo.cerrar')}
          </Button>

          <p className="text-xs text-ink-subtle">
            {t('flujo.atajos.ayuda', {
              buscar: ayudaDeAtajo('buscar'),
              llamar: ayudaDeAtajo('llamar'),
              cerrar: ayudaDeAtajo('cerrar-sesion'),
            })}
          </p>
        </div>
      </div>
    </Card>
  );
};
