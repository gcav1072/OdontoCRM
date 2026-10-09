import type { AppointmentSummary, DayView } from '@odontocrm/contracts';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Alert, Button, Card, CardContent, EmptyState, Spinner } from '@odontocrm/ui';
import { CalendarClock, ClipboardList } from 'lucide-react';
import { useMemo, useState } from 'react';

import { NoticeBanner } from '../components/NoticeBanner';
import {
  coincideBusqueda,
  hechoDeAccion,
  porHoraDeInicio,
  type AccionSecretaria,
} from '../components/secretaria/acciones';
import { AppointmentHistoryDialog } from '../components/secretaria/AppointmentHistoryDialog';
import { AttendDialog } from '../components/secretaria/AttendDialog';
import { DayCounters } from '../components/secretaria/DayCounters';
import { EmergencyCallDialog } from '../components/secretaria/EmergencyCallDialog';
import { NoShowDialog } from '../components/secretaria/NoShowDialog';
import { SecretariaAppointmentsTable } from '../components/secretaria/SecretariaAppointmentsTable';
import { SecretariaToolbar } from '../components/secretaria/SecretariaToolbar';
import { useDayView } from '../hooks/useDayView';
import { useNotice } from '../hooks/useNotice';
import { apiErrorMessage } from '../lib/api';
import { appointmentsApi } from '../lib/endpoints';
import { t } from '../lib/i18n';
import {
  applyDayChanges,
  effectiveRole,
  schedulingKeys,
  shiftDate,
  todayInClinic,
  type AppointmentChange,
} from '../lib/scheduling';
import { useAuth } from '../providers/AuthProvider';

/** Transiciones que no piden datos: se ejecutan y se avisan con el toast. */
type AccionSimple = Extract<AccionSecretaria, 'check-in' | 'call' | 'start'>;

/** Cita con un diálogo abierto que sí pide motivo. */
interface AccionConMotivo {
  tipo: 'attend' | 'no-show';
  appointment: AppointmentSummary;
}

/**
 * `/secretaria` (Fase 5): la jornada del día para el mostrador.
 *
 * - Selector de fecha, buscador por nombre, documento, teléfono o ticket, y los
 *   contadores del día tal como los cuenta el servidor.
 * - Una fila por cita, ordenada por hora, con las acciones que la máquina de
 *   estados permite a ese estado y ese rol: registrar llegada, llamar (el
 *   segundo llamado repite la acción), pasar a consulta, marcar atendido —con
 *   motivo mientras no haya historia clínica—, marcar inasistencia y llamar
 *   fuera de orden.
 * - El historial de la cita, que es donde queda el rastro de cada transición.
 *
 * Rendimiento: la jornada vive en la caché bajo `['jornada', fecha]` y cada
 * mutación devuelve la cita actualizada, así que el día se parchea en memoria
 * (`applyDayChanges`) en lugar de volver a pedirse; solo se invalida el
 * historial, que sí cambia de composición con cada transición.
 */
export const SecretariaPage = () => {
  const { hasPermission, roles } = useAuth();
  const cliente = useQueryClient();
  const { notice, exito, error: avisarError, limpiar } = useNotice();

  const [fecha, setFecha] = useState(() => todayInClinic());
  const [busqueda, setBusqueda] = useState('');
  const [conMotivo, setConMotivo] = useState<AccionConMotivo | null>(null);
  const [emergencia, setEmergencia] = useState<AppointmentSummary | null>(null);
  const [historial, setHistorial] = useState<AppointmentSummary | null>(null);

  const rol = useMemo(() => effectiveRole(roles), [roles]);

  const diaQuery = useDayView(fecha);
  const dia = diaQuery.data;

  /** Citas visibles: la jornada ordenada por hora y filtrada por el buscador. */
  const visibles = useMemo(
    () =>
      [...(dia?.appointments ?? [])]
        .sort(porHoraDeInicio)
        .filter((cita) => coincideBusqueda(cita, busqueda)),
    [dia, busqueda],
  );

  /* ── Caché ─────────────────────────────────────────────────────────────── */

  /**
   * Aplica a la jornada en caché las citas que devolvieron las mutaciones, sin
   * volver a pedir el día: `applyDayChanges` recalcula citas, franjas,
   * contadores y cupo a partir del estado anterior. El aviso del día no se toca.
   */
  const parchearJornada = (cambios: readonly AppointmentChange[]) => {
    if (dia === undefined) return;

    const clave = schedulingKeys.day(dia.date);
    if (cliente.getQueryData(clave) === undefined) return;
    cliente.setQueryData<DayView>(clave, (actual) =>
      actual === undefined ? actual : applyDayChanges(actual, cambios),
    );
  };

  /** Cada transición añade una línea al historial de la cita: se marca obsoleto. */
  const invalidarHistorial = () => {
    void cliente.invalidateQueries({ queryKey: schedulingKeys.historyRoot });
  };

  /* ── Acciones del flujo ────────────────────────────────────────────────── */

  const simple = useMutation({
    mutationFn: (entrada: { accion: AccionSimple; appointment: AppointmentSummary }) =>
      entrada.accion === 'check-in'
        ? appointmentsApi.checkIn(entrada.appointment.id)
        : entrada.accion === 'call'
          ? appointmentsApi.call(entrada.appointment.id)
          : appointmentsApi.start(entrada.appointment.id),
  });

  /** Llegada, llamado y paso a consulta: una transición, un aviso. */
  const ejecutarSimple = async (accion: AccionSimple, cita: AppointmentSummary) => {
    try {
      const actualizada = await simple.mutateAsync({ accion, appointment: cita });
      parchearJornada([{ appointment: actualizada, previous: cita }]);
      invalidarHistorial();
      exito(hechoDeAccion(accion, actualizada.patientName));
    } catch (fallo) {
      avisarError(apiErrorMessage(fallo), t('secretaria.error.accion'));
    }
  };

  const alAccionar = (accion: AccionSecretaria, cita: AppointmentSummary) => {
    // «Atendido» e «inasistencia» piden motivo en su diálogo; el resto se aplica.
    if (accion === 'attend' || accion === 'no-show') {
      setConMotivo({ tipo: accion, appointment: cita });
      return;
    }
    void ejecutarSimple(accion, cita);
  };

  /* ── Render ────────────────────────────────────────────────────────────── */

  return (
    <div className="space-y-5">
      <NoticeBanner notice={notice} onClose={limpiar} />

      <header>
        <h1 className="flex items-center gap-2 text-xl font-semibold text-ink">
          <ClipboardList className="size-5 text-primary" aria-hidden="true" />
          {t('secretaria.titulo')}
        </h1>
        <p className="pt-1 text-sm text-ink-muted">{t('secretaria.descripcion')}</p>
      </header>

      <SecretariaToolbar
        date={fecha}
        day={dia}
        search={busqueda}
        isFetching={diaQuery.isFetching}
        onSearch={setBusqueda}
        onShift={(dias) => setFecha((valor) => shiftDate(valor, dias))}
        onToday={() => setFecha(todayInClinic())}
        onDateChange={setFecha}
        onReload={() => {
          void diaQuery.refetch();
        }}
      />

      {diaQuery.isError && (
        <Alert variant="danger" title={t('secretaria.error')}>
          <p>{apiErrorMessage(diaQuery.error)}</p>
          <Button
            size="sm"
            variant="secondary"
            className="mt-2"
            loading={diaQuery.isFetching}
            loadingLabel={t('secretaria.cargando')}
            onClick={() => {
              void diaQuery.refetch();
            }}
          >
            {t('secretaria.reintentar')}
          </Button>
        </Alert>
      )}

      {diaQuery.isPending ? (
        <div className="py-16">
          <Spinner label={t('secretaria.cargando')} showLabel />
        </div>
      ) : dia === undefined ? null : (
        <>
          <DayCounters counts={dia.counts} />

          {dia.appointments.length === 0 ? (
            <EmptyState
              icon={<CalendarClock className="size-6" aria-hidden="true" />}
              title={t('secretaria.titulo')}
              description={t('secretaria.vacio')}
            />
          ) : (
            <Card>
              <CardContent className="pt-5">
                <h2 className="flex items-center gap-2 pb-3 text-base font-semibold text-ink">
                  <CalendarClock className="size-4 text-primary" aria-hidden="true" />
                  {t('secretaria.citas.titulo')}
                </h2>
                <SecretariaAppointmentsTable
                  appointments={visibles}
                  role={rol}
                  hasPermission={hasPermission}
                  busy={simple.isPending}
                  onAction={alAccionar}
                  onEmergencyCall={setEmergencia}
                  onHistory={setHistorial}
                />
              </CardContent>
            </Card>
          )}
        </>
      )}

      {emergencia !== null && (
        <EmergencyCallDialog
          appointment={emergencia}
          onClose={() => setEmergencia(null)}
          onCalled={(enSala, llamado) => {
            setEmergencia(null);
            // Las dos transiciones entran juntas en la caché para que los
            // contadores queden como los dejó el servidor.
            parchearJornada([{ appointment: enSala }, { appointment: llamado, previous: enSala }]);
            invalidarHistorial();
            exito(hechoDeAccion('call', llamado.patientName));
          }}
        />
      )}

      {conMotivo !== null && conMotivo.tipo === 'attend' && (
        <AttendDialog
          appointment={conMotivo.appointment}
          onClose={() => setConMotivo(null)}
          onDone={(actualizada) => {
            setConMotivo(null);
            parchearJornada([{ appointment: actualizada }]);
            invalidarHistorial();
            exito(hechoDeAccion('attend', actualizada.patientName));
          }}
        />
      )}

      {conMotivo !== null && conMotivo.tipo === 'no-show' && (
        <NoShowDialog
          appointment={conMotivo.appointment}
          onClose={() => setConMotivo(null)}
          onDone={(actualizada) => {
            setConMotivo(null);
            parchearJornada([{ appointment: actualizada }]);
            invalidarHistorial();
            exito(hechoDeAccion('no-show', actualizada.patientName));
          }}
        />
      )}

      {historial !== null && (
        <AppointmentHistoryDialog appointment={historial} onClose={() => setHistorial(null)} />
      )}
    </div>
  );
};
