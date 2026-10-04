import type { AppointmentSummary, DayView } from '@odontocrm/contracts';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Alert, Button, Spinner } from '@odontocrm/ui';
import { ContactRound } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { PatientWorkspace, type PatientTab } from '../components/clinical/PatientWorkspace';
import { DayQueue } from '../components/flujo/DayQueue';
import {
  accionDeTecla,
  citasDeLaCola,
  hayDialogoAbierto,
  resolverSeleccion,
  type AccionFlujo,
} from '../components/flujo/flujo';
import { FlowTopBar } from '../components/flujo/FlowTopBar';
import { PatientSearchDialog } from '../components/flujo/PatientSearchDialog';
import { NoticeBanner } from '../components/NoticeBanner';
import { AppointmentHistoryDialog } from '../components/secretaria/AppointmentHistoryDialog';
import {
  accionesDeFila,
  hechoDeAccion,
  type AccionSecretaria,
} from '../components/secretaria/acciones';
import { AttendDialog } from '../components/secretaria/AttendDialog';
import { EmergencyCallDialog } from '../components/secretaria/EmergencyCallDialog';
import { NoShowDialog } from '../components/secretaria/NoShowDialog';
import { useDayView } from '../hooks/useDayView';
import { useNotice } from '../hooks/useNotice';
import { useNow } from '../hooks/useNow';
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

/** Transiciones que no piden datos: se ejecutan y se avisan con el aviso en línea. */
type AccionSimple = Extract<AccionSecretaria, 'check-in' | 'call' | 'start'>;

/** Cita con un diálogo abierto que sí pide motivo. */
interface AccionConMotivo {
  tipo: 'attend' | 'no-show';
  appointment: AppointmentSummary;
}

/**
 * `/flujo` (Fase 8): **el día completo en una sola pantalla**.
 *
 * A la izquierda la cola del día —con su selector de fecha y su buscador—, en el
 * centro el paciente en curso con su historia, su sesión (adjuntos y récipe
 * incluidos) y su odontograma, y arriba las acciones de secretaría de la cita
 * seleccionada: registrar llegada, llamar (el llamado que sale en la pantalla del
 * lobby), pasar a consulta, marcar atendido, marcar inasistencia, llamar fuera de
 * orden y ver el historial.
 *
 * Todo lo que se ve aquí es lo mismo que hay en `/secretaria` y `/consultorio`
 * —el área del paciente es el componente `PatientWorkspace` y los diálogos son los
 * de la secretaría—, así que la ruta unificada no puede quedarse corta respecto a
 * las rutas individuales.
 *
 * Atajos: `F2` busca un paciente, `F4` llama al que está en curso y `F8` cierra su
 * sesión clínica (con la pregunta del récipe). No disparan con un diálogo abierto
 * ni con modificadores (`Ctrl`/`Alt`/`Meta`), que son del navegador y del sistema.
 */
export const FlujoPage = () => {
  const { hasPermission, roles } = useAuth();
  const cliente = useQueryClient();
  const { notice, exito, error: avisarError, limpiar } = useNotice();
  // El tic de 30 s hace aparecer la inasistencia en cuanto pasa la tolerancia.
  const ahora = useNow(30_000);

  const [fecha, setFecha] = useState(() => todayInClinic());
  const [busqueda, setBusqueda] = useState('');
  const [elegidaId, setElegidaId] = useState<string | null>(null);
  const [pacienteSuelto, setPacienteSuelto] = useState<string | null>(null);
  const [pestana, setPestana] = useState<PatientTab>('sesion');
  const [pedidoCierre, setPedidoCierre] = useState(0);
  const [buscador, setBuscador] = useState(false);
  const [conMotivo, setConMotivo] = useState<AccionConMotivo | null>(null);
  const [emergencia, setEmergencia] = useState<AppointmentSummary | null>(null);
  const [historial, setHistorial] = useState<AppointmentSummary | null>(null);

  const rol = useMemo(() => effectiveRole(roles), [roles]);

  const diaQuery = useDayView(fecha);
  const dia = diaQuery.data;

  const visibles = useMemo(() => citasDeLaCola(dia, busqueda), [dia, busqueda]);

  /**
   * Cita en curso. Cuando el doctor pulsa una fila de la cola manda esa cita; si la
   * cita desaparece de la jornada (la reprogramaron a otro día), se vuelve a la que
   * toca por estado y hora en lugar de dejar la pantalla en blanco.
   */
  const cita = useMemo(
    () => resolverSeleccion(visibles, elegidaId, ahora),
    [visibles, elegidaId, ahora],
  );

  /**
   * Paciente del centro: el de la cita en curso o, si el doctor buscó con `F2` a
   * alguien que hoy no tiene cita, el que eligió a mano.
   */
  const pacienteId = pacienteSuelto ?? cita?.patientId ?? null;

  /** Acciones que la máquina de estados y los permisos permiten a esa cita. */
  const accionesDeLaCita = useMemo(
    () => (cita === null ? [] : accionesDeFila(cita, { role: rol, hasPermission, now: ahora })),
    [cita, rol, hasPermission, ahora],
  );

  /* ── Caché ─────────────────────────────────────────────────────────────── */

  /**
   * Aplica a la jornada en caché las citas que devolvieron las mutaciones, sin
   * volver a pedir el día: `applyDayChanges` recalcula citas, franjas, contadores y
   * cupo a partir del estado anterior.
   */
  const parchearJornada = (cambios: readonly AppointmentChange[]) => {
    const clave = schedulingKeys.day(fecha);
    if (cliente.getQueryData(clave) === undefined) return;
    cliente.setQueryData<DayView>(clave, (actual) =>
      actual === undefined ? undefined : applyDayChanges(actual, cambios),
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
  const ejecutarSimple = async (accion: AccionSimple, appointment: AppointmentSummary) => {
    try {
      const actualizada = await simple.mutateAsync({ accion, appointment });
      parchearJornada([{ appointment: actualizada, previous: appointment }]);
      invalidarHistorial();
      setElegidaId(actualizada.id);
      exito(hechoDeAccion(accion, actualizada.patientName));
    } catch (fallo) {
      avisarError(apiErrorMessage(fallo), t('secretaria.error.accion'));
    }
  };

  const alAccionar = (accion: AccionSecretaria, appointment: AppointmentSummary) => {
    // «Atendido» e «inasistencia» piden motivo en su diálogo; el resto se aplica.
    if (accion === 'attend' || accion === 'no-show') {
      setConMotivo({ tipo: accion, appointment });
      return;
    }
    void ejecutarSimple(accion, appointment);
  };

  /**
   * Atajos y botones de la barra: `F4` llama a la cita en curso y `F8` cierra la
   * sesión clínica del paciente que está en el centro (la pestaña se pone delante
   * para que se vea el diálogo).
   */
  const cerrarSesion = useCallback(() => {
    if (cita === null && pacienteSuelto === null) {
      avisarError(t('flujo.cerrar.sinPaciente'), t('flujo.atajo.cerrar'));
      return;
    }
    setPestana('sesion');
    setPedidoCierre((valor) => valor + 1);
  }, [avisarError, cita, pacienteSuelto]);

  const alAtajo = useCallback(
    (accion: AccionFlujo) => {
      if (accion === 'buscar') {
        setBuscador(true);
        return;
      }
      if (accion === 'llamar') {
        if (cita === null) {
          avisarError(t('flujo.llamar.sinPaciente'), t('flujo.atajo.llamar'));
          return;
        }
        if (!accionesDeLaCita.includes('call')) {
          avisarError(t('flujo.llamar.noDisponible'), t('flujo.atajo.llamar'));
          return;
        }
        void ejecutarSimple('call', cita);
        return;
      }
      cerrarSesion();
    },
    // `ejecutarSimple` se rehace en cada dibujado y solo depende de lo que ya está.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [accionesDeLaCita, avisarError, cita, cerrarSesion],
  );

  /**
   * Teclado: `F2`, `F4` y `F8` desde cualquier punto de la página. Se ignoran con un
   * diálogo abierto (dentro, `F4` no debe llamar al paciente de atrás) y se evita el
   * comportamiento del navegador (`F4` no abre nada, pero `F2` sí puede).
   */
  useEffect(() => {
    const alPulsar = (event: KeyboardEvent) => {
      const accion = accionDeTecla(event);
      if (accion === null || hayDialogoAbierto()) return;
      event.preventDefault();
      alAtajo(accion);
    };
    window.addEventListener('keydown', alPulsar);
    return () => window.removeEventListener('keydown', alPulsar);
  }, [alAtajo]);

  /* ── Render ────────────────────────────────────────────────────────────── */

  return (
    <div className="space-y-5">
      <NoticeBanner notice={notice} onClose={limpiar} />

      <FlowTopBar
        date={fecha}
        day={dia}
        isFetching={diaQuery.isFetching}
        onShift={(dias) => setFecha((valor) => shiftDate(valor, dias))}
        onToday={() => setFecha(todayInClinic())}
        onDateChange={setFecha}
        onReload={() => {
          void diaQuery.refetch();
        }}
        appointment={cita}
        role={rol}
        hasPermission={hasPermission}
        busy={simple.isPending}
        now={ahora}
        onAction={alAccionar}
        onEmergencyCall={setEmergencia}
        onHistory={setHistorial}
        onShortcut={alAtajo}
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

      <div className="grid gap-5 lg:grid-cols-[20rem_minmax(0,1fr)]">
        <DayQueue
          appointments={visibles}
          selectedId={cita?.id ?? null}
          search={busqueda}
          loading={diaQuery.isPending}
          onSearch={setBusqueda}
          onSelect={(fila) => {
            setElegidaId(fila.id);
            setPacienteSuelto(null);
            setPestana('sesion');
          }}
        />

        <div className="min-w-0">
          {diaQuery.isPending ? (
            <div className="py-16">
              <Spinner label={t('secretaria.cargando')} showLabel />
            </div>
          ) : pacienteId === null ? (
            <div className="rounded-card border border-dashed border-border px-6 py-16 text-center">
              <ContactRound className="mx-auto size-6 text-ink-subtle" aria-hidden />
              <p className="mt-2 text-sm font-medium text-ink">{t('flujo.sinPaciente')}</p>
              <p className="mt-1 text-sm text-ink-muted">{t('flujo.sinPacienteTexto')}</p>
              <div className="mt-4 flex justify-center">
                <Button variant="secondary" onClick={() => setBuscador(true)}>
                  {t('flujo.atajo.buscar')}
                </Button>
              </div>
            </div>
          ) : (
            <PatientWorkspace
              key={pacienteId}
              patientId={pacienteId}
              puedeEscribir={hasPermission('clinical:write')}
              puedeVerOdontograma={hasPermission('odontogram:read')}
              puedeEditarOdontograma={hasPermission('odontogram:write')}
              tab={pestana}
              onTabChange={setPestana}
              exitLabel={t('flujo.volverCola')}
              // La cita que el flujo tiene delante respalda la sesión que se abra.
              appointmentId={cita?.id ?? null}
              onExit={() => {
                setPacienteSuelto(null);
                setElegidaId(null);
              }}
              closeSessionRequest={pedidoCierre}
            />
          )}
        </div>
      </div>

      <PatientSearchDialog
        open={buscador}
        onClose={() => setBuscador(false)}
        onSelect={(paciente) => {
          // Si el paciente tiene cita hoy, se elige **su cita**: así la barra de
          // arriba actúa sobre la cita correcta y su fila queda marcada en la cola.
          const fila = visibles.find((cita) => cita.patientId === paciente.id);
          if (fila === undefined) {
            setPacienteSuelto(paciente.id);
            setElegidaId(null);
          } else {
            setPacienteSuelto(null);
            setElegidaId(fila.id);
          }
          setPestana('sesion');
        }}
      />

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
            setElegidaId(llamado.id);
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
