import {
  formatTime12h,
  type AppointmentSummary,
  type DayView,
  type NotifyBatchResult,
  type RequestSummary,
} from '@odontocrm/contracts';
import { useQueryClient } from '@tanstack/react-query';
import { Alert, Card, CardContent, Spinner } from '@odontocrm/ui';
import { CalendarClock, ClipboardList } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';

import { NoticeBanner } from '../components/NoticeBanner';
import { PanelTabs, panelPanelId, panelTabId } from '../components/PanelTabs';
import { AppointmentActionDialog } from '../components/scheduling/AppointmentActionDialog';
import { AppointmentHistoryDialog } from '../components/scheduling/AppointmentHistoryDialog';
import { AssignAppointmentDialog } from '../components/scheduling/AssignAppointmentDialog';
import { CapacityDialog } from '../components/scheduling/CapacityDialog';
import { DayAppointmentsTable } from '../components/scheduling/DayAppointmentsTable';
import { DayCapacityCard } from '../components/scheduling/DayCapacityCard';
import { DayToolbar } from '../components/scheduling/DayToolbar';
import { NewRequestDialog } from '../components/scheduling/NewRequestDialog';
import { NotifyBatchDialog } from '../components/scheduling/NotifyBatchDialog';
import { PatientCancellationsCard } from '../components/scheduling/PatientCancellationsCard';
import { RequestCancelDialog } from '../components/scheduling/RequestCancelDialog';
import { RequestQueuePanel } from '../components/scheduling/RequestQueuePanel';
import { RescheduleAppointmentDialog } from '../components/scheduling/RescheduleAppointmentDialog';
import { SlotGrid } from '../components/scheduling/SlotGrid';
import { TemplatesDialog } from '../components/scheduling/TemplatesDialog';
import { useDayView } from '../hooks/useDayView';
import { useNotice } from '../hooks/useNotice';
import { apiErrorMessage } from '../lib/api';
import { t } from '../lib/i18n';
import {
  applyDayChanges,
  effectiveRole,
  formatDateOnly,
  schedulingKeys,
  shiftDate,
  todayInClinic,
  type AppointmentAction,
  type AppointmentChange,
} from '../lib/scheduling';
import { useAuth } from '../providers/AuthProvider';

/** Acción del flujo diario y la cita sobre la que se aplica. */
interface ActionTarget {
  action: AppointmentAction;
  appointment: AppointmentSummary;
}

/**
 * `/programacion` (Fase 3): cola de solicitudes a la izquierda y jornada del día
 * a la derecha.
 *
 * Rendimiento: la vista del día vive en la consulta `['jornada', fecha]` y cada
 * mutación devuelve la cita actualizada, así que la jornada se parchea en la
 * caché (`applyDayChanges`) en lugar de volver a pedir el día completo; la cola,
 * las listas de citas y los historiales sí se invalidan porque cambian de
 * composición. El botón «Recargar la jornada» fuerza la recarga completa.
 */
export const SchedulingPage = () => {
  const { hasPermission, roles } = useAuth();
  const cliente = useQueryClient();
  const { notice, mostrar, exito, limpiar } = useNotice();

  const [fecha, setFecha] = useState(() => todayInClinic());
  const [solicitudElegida, setSolicitudElegida] = useState<RequestSummary | null>(null);
  const [asignando, setAsignando] = useState<{
    request: RequestSummary;
    startTime?: string;
  } | null>(null);
  const [cancelandoSolicitud, setCancelandoSolicitud] = useState<RequestSummary | null>(null);
  const [nuevaSolicitud, setNuevaSolicitud] = useState(false);
  const [editandoCupo, setEditandoCupo] = useState(false);
  const [viendoPlantillas, setViendoPlantillas] = useState(false);
  const [historial, setHistorial] = useState<AppointmentSummary | null>(null);
  const [reprogramando, setReprogramando] = useState<AppointmentSummary | null>(null);
  const [accion, setAccion] = useState<ActionTarget | null>(null);
  const [notificando, setNotificando] = useState<{ appointmentIds?: string[] } | null>(null);
  /**
   * Pestaña de la jornada. Los cuadros del día se reparten aquí para no apilarlos
   * todos en la misma columna; la cola de solicitudes queda fija a la izquierda.
   */
  const [pestana, setPestana] = useState<'jornada' | 'citas' | 'cancelaciones'>('jornada');

  const rol = useMemo(() => effectiveRole(roles), [roles]);
  const puedeEscribir = hasPermission('scheduling:write');
  const puedeNotificar = hasPermission('scheduling:notify');

  const diaQuery = useDayView(fecha);
  const dia = diaQuery.data;

  /* ── Caché ─────────────────────────────────────────────────────────────── */

  const parchearDia = (
    date: string,
    changes: readonly AppointmentChange[],
    options?: { removeWaitingRequestId?: string | null },
  ) => {
    const clave = schedulingKeys.day(date);
    if (cliente.getQueryData(clave) === undefined) return;
    cliente.setQueryData<DayView>(clave, (actual) =>
      actual === undefined ? actual : applyDayChanges(actual, changes, options),
    );
  };

  /**
   * Consultas que sí cambian de composición con cualquier mutación: la cola, las
   * listas de citas y el historial. La jornada del día **no** se invalida: se
   * parchea con la respuesta, así el día no vuelve a cargar por una sola cita.
   */
  const invalidarDerivados = () => {
    void cliente.invalidateQueries({ queryKey: schedulingKeys.requestsRoot });
    void cliente.invalidateQueries({ queryKey: schedulingKeys.appointmentsRoot });
    void cliente.invalidateQueries({ queryKey: schedulingKeys.historyRoot });
  };

  const citaEnJornada = (id: string): AppointmentSummary | null =>
    dia?.appointments.find((cita) => cita.id === id) ?? null;

  const parchearCupo = (date: string, capacity: DayView['capacity']) => {
    const clave = schedulingKeys.day(date);
    if (cliente.getQueryData(clave) === undefined) return;
    cliente.setQueryData<DayView>(clave, (actual) =>
      actual === undefined ? actual : { ...actual, capacity },
    );
  };

  /* ── Acciones de la jornada ────────────────────────────────────────────── */

  const trasAsignar = (cita: AppointmentSummary, solicitud: RequestSummary) => {
    setAsignando(null);
    setSolicitudElegida(null);
    parchearDia(cita.date, [{ appointment: cita }], {
      removeWaitingRequestId: solicitud.id,
    });
    if (dia !== undefined && dia.date !== cita.date) {
      parchearDia(dia.date, [], { removeWaitingRequestId: solicitud.id });
    }
    invalidarDerivados();
    exito(
      t('programacion.asignar.ok', {
        hora: formatTime12h(cita.startTime),
        fecha: formatDateOnly(cita.date),
      }),
    );
  };

  const trasCambioDeEstado = (cita: AppointmentSummary, mensaje: string) => {
    setAccion(null);
    parchearDia(cita.date, [{ appointment: cita, previous: citaEnJornada(cita.id) }]);
    invalidarDerivados();
    exito(mensaje);
  };

  const trasReprogramar = (anterior: AppointmentSummary, nueva: AppointmentSummary) => {
    setReprogramando(null);
    parchearDia(anterior.date, [
      { appointment: anterior, previous: citaEnJornada(anterior.id) ?? anterior },
      { appointment: nueva },
    ]);
    if (dia !== undefined && nueva.date !== dia.date) {
      parchearDia(nueva.date, [{ appointment: nueva }]);
    }
    invalidarDerivados();
    exito(
      t('programacion.reprogramar.ok', {
        fecha: formatDateOnly(nueva.date),
        hora: formatTime12h(nueva.startTime),
      }),
    );
  };

  const trasNotificar = (resultado: NotifyBatchResult) => {
    setNotificando(null);
    if (dia !== undefined) {
      const cambios: AppointmentChange[] = resultado.appointments.map((cita) => ({
        appointment: cita,
        previous: citaEnJornada(cita.id),
      }));
      parchearDia(dia.date, cambios);
    }
    invalidarDerivados();
    exito(
      t('programacion.notificar.ok', {
        notified: resultado.notified,
        skipped: resultado.skipped,
      }),
    );
  };

  const alPedirHora = (startTime: string, requestId?: string) => {
    if (
      solicitudElegida === null ||
      (requestId !== undefined && requestId !== solicitudElegida.id)
    ) {
      mostrar({ variant: 'info', message: t('programacion.franja.sinSeleccion') });
      return;
    }
    setAsignando({ request: solicitudElegida, startTime });
  };

  const alAccionar = (accionElegida: AppointmentAction, cita: AppointmentSummary) => {
    if (accionElegida === 'reschedule') {
      setReprogramando(cita);
      return;
    }
    if (accionElegida === 'notify') {
      setNotificando({ appointmentIds: [cita.id] });
      return;
    }
    setAccion({ action: accionElegida, appointment: cita });
  };

  /* ── Render ────────────────────────────────────────────────────────────── */

  return (
    <div className="space-y-5">
      <NoticeBanner notice={notice} onClose={limpiar} />

      <div className="grid gap-5 xl:grid-cols-[minmax(19rem,23rem)_minmax(0,1fr)]">
        <RequestQueuePanel
          selectedRequestId={solicitudElegida?.id ?? null}
          canWrite={puedeEscribir}
          onSelect={setSolicitudElegida}
          onAssign={(solicitud) => setAsignando({ request: solicitud })}
          onCancel={setCancelandoSolicitud}
          onNew={() => setNuevaSolicitud(true)}
        />

        <div className="min-w-0 space-y-5">
          <DayToolbar
            date={fecha}
            day={dia}
            isFetching={diaQuery.isFetching}
            canNotify={puedeNotificar}
            onShift={(dias) => setFecha((valor) => shiftDate(valor, dias))}
            onToday={() => setFecha(todayInClinic())}
            onDateChange={setFecha}
            onReload={() => {
              void diaQuery.refetch();
            }}
            onNotify={() => setNotificando({})}
            onTemplates={() => setViendoPlantillas(true)}
          />

          {diaQuery.isError && (
            <Alert variant="danger" title={t('programacion.fecha.error')}>
              {apiErrorMessage(diaQuery.error)}
            </Alert>
          )}

          {diaQuery.isPending ? (
            <div className="py-16">
              <Spinner label={t('programacion.fecha.cargando')} showLabel />
            </div>
          ) : dia === undefined ? null : (
            <>
              {!dia.isWorkingDay && (
                <Alert variant="info" title={t('programacion.fecha.noLaborable')}>
                  {t('programacion.fecha.noLaborableTexto', { dia: dia.weekdayName })}
                </Alert>
              )}

              {/* Los cuadros del día se reparten en pestañas para no apilarlos todos:
                  la cola de solicitudes (a la izquierda) queda siempre a la vista y aquí
                  se cambia entre el cupo con las franjas, las citas y las cancelaciones. */}
              <PanelTabs
                idPrefix="programacion"
                label={t('programacion.pestanas.titulo')}
                tabs={[
                  { key: 'jornada', label: t('programacion.pestana.jornada') },
                  {
                    key: 'citas',
                    label: t('programacion.pestana.citas'),
                    hint: (
                      <span className="text-xs text-ink-subtle">{dia.appointments.length}</span>
                    ),
                  },
                  { key: 'cancelaciones', label: t('programacion.pestana.cancelaciones') },
                ]}
                active={pestana}
                onSelect={setPestana}
              />

              {pestana === 'jornada' && (
                <div
                  role="tabpanel"
                  id={panelPanelId('programacion', 'jornada')}
                  aria-labelledby={panelTabId('programacion', 'jornada')}
                  className="space-y-5"
                >
                  <DayCapacityCard
                    day={dia}
                    canWrite={puedeEscribir}
                    onEdit={() => setEditandoCupo(true)}
                  />

                  <SlotGrid
                    day={dia}
                    selectedRequest={solicitudElegida}
                    canAssign={puedeEscribir}
                    onRequestTime={alPedirHora}
                    onOpenAppointment={setHistorial}
                  />
                </div>
              )}

              {pestana === 'citas' && (
                <div
                  role="tabpanel"
                  id={panelPanelId('programacion', 'citas')}
                  aria-labelledby={panelTabId('programacion', 'citas')}
                  className="space-y-5"
                >
                  <Card>
                    <CardContent className="pt-5">
                      <h2 className="flex items-center gap-2 pb-3 text-base font-semibold text-ink">
                        <CalendarClock className="size-4 text-primary" aria-hidden="true" />
                        {t('programacion.citas.titulo')}
                      </h2>
                      <DayAppointmentsTable
                        day={dia}
                        role={rol}
                        hasPermission={hasPermission}
                        onAction={alAccionar}
                        onHistory={setHistorial}
                      />
                    </CardContent>
                  </Card>

                  <Card>
                    <CardContent className="flex items-start gap-2.5 pt-5 text-sm text-ink-muted">
                      <ClipboardList className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
                      <span>
                        {t('programacion.notificar.envio')}{' '}
                        <Link
                          to="/notificaciones"
                          className="font-medium whitespace-nowrap text-primary underline underline-offset-2"
                        >
                          {t('programacion.notificar.verBandeja')}
                        </Link>
                      </span>
                    </CardContent>
                  </Card>
                </div>
              )}

              {pestana === 'cancelaciones' && (
                <div
                  role="tabpanel"
                  id={panelPanelId('programacion', 'cancelaciones')}
                  aria-labelledby={panelTabId('programacion', 'cancelaciones')}
                >
                  <PatientCancellationsCard />
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {nuevaSolicitud && (
        <NewRequestDialog
          onClose={() => setNuevaSolicitud(false)}
          onCreated={(creada) => {
            setNuevaSolicitud(false);
            invalidarDerivados();
            exito(t('programacion.nueva.ok', { ticket: creada.ticket }));
          }}
        />
      )}

      {cancelandoSolicitud !== null && (
        <RequestCancelDialog
          request={cancelandoSolicitud}
          onClose={() => setCancelandoSolicitud(null)}
          onCancelled={(actualizada) => {
            setCancelandoSolicitud(null);
            if (solicitudElegida?.id === actualizada.id) setSolicitudElegida(null);
            if (dia !== undefined) {
              cliente.setQueryData<DayView>(schedulingKeys.day(dia.date), (actual) =>
                actual === undefined
                  ? actual
                  : {
                      ...actual,
                      waiting: actual.waiting.filter(
                        (solicitud) => solicitud.id !== actualizada.id,
                      ),
                    },
              );
            }
            invalidarDerivados();
            exito(t('programacion.solicitud.ok', { ticket: actualizada.ticket }));
          }}
        />
      )}

      {asignando !== null && (
        <AssignAppointmentDialog
          request={asignando.request}
          defaultDate={dia?.date ?? fecha}
          defaultStartTime={asignando.startTime}
          hasPermission={hasPermission}
          onClose={() => setAsignando(null)}
          onAssigned={trasAsignar}
        />
      )}

      {editandoCupo && dia !== undefined && (
        <CapacityDialog
          capacity={dia.capacity}
          onClose={() => setEditandoCupo(false)}
          onSaved={(actualizado) => {
            parchearCupo(actualizado.date, actualizado);
            invalidarDerivados();
            // Con `warning` el diálogo se queda abierto mostrándolo y la tarjeta
            // del cupo lo repite: no hace falta otro aviso en la página.
            if (actualizado.warning === null) exito(t('programacion.cupo.ok'));
          }}
        />
      )}

      {viendoPlantillas && <TemplatesDialog onClose={() => setViendoPlantillas(false)} />}

      {historial !== null && (
        <AppointmentHistoryDialog appointment={historial} onClose={() => setHistorial(null)} />
      )}

      {reprogramando !== null && (
        <RescheduleAppointmentDialog
          appointment={reprogramando}
          hasPermission={hasPermission}
          onClose={() => setReprogramando(null)}
          onRescheduled={trasReprogramar}
        />
      )}

      {accion !== null && (
        <AppointmentActionDialog
          mode={
            accion.action === 'attend'
              ? 'attend'
              : accion.action === 'no-show'
                ? 'no-show'
                : 'cancel'
          }
          appointment={accion.appointment}
          onClose={() => setAccion(null)}
          onDone={trasCambioDeEstado}
        />
      )}

      {notificando !== null && (
        <NotifyBatchDialog
          date={dia?.date ?? fecha}
          appointmentIds={notificando.appointmentIds}
          onClose={() => setNotificando(null)}
          onNotified={trasNotificar}
        />
      )}
    </div>
  );
};
