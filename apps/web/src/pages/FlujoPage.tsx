import { Alert, Button, Spinner } from '@odontocrm/ui';
import { ContactRound } from 'lucide-react';
import { useMemo, useState } from 'react';

import { PatientWorkspace, type PatientTab } from '../components/clinical/PatientWorkspace';
import { DayQueue } from '../components/flujo/DayQueue';
import { citasDeLaCola, resolverSeleccion } from '../components/flujo/flujo';
import { FlowTopBar } from '../components/flujo/FlowTopBar';
import { useDayView } from '../hooks/useDayView';
import { apiErrorMessage } from '../lib/api';
import { t } from '../lib/i18n';
import { shiftDate, todayInClinic } from '../lib/scheduling';
import { useAuth } from '../providers/AuthProvider';

/**
 * `/flujo` (Fase 8): **el día completo en una sola pantalla**.
 *
 * A la izquierda la cola del día —con su selector de fecha y su buscador—, en el
 * centro el paciente en curso con su historia, su sesión (adjuntos y récipe
 * incluidos) y su odontograma, y arriba las acciones de secretaría de la cita
 * seleccionada.
 *
 * Todo lo que se ve aquí es lo mismo que hay en `/secretaria` y `/consultorio`: el
 * área del paciente es el componente `PatientWorkspace`, así que la ruta unificada
 * no puede quedarse corta respecto a las rutas individuales.
 */
export const FlujoPage = () => {
  const { hasPermission } = useAuth();

  const [fecha, setFecha] = useState(() => todayInClinic());
  const [busqueda, setBusqueda] = useState('');
  const [elegidaId, setElegidaId] = useState<string | null>(null);
  const [pacienteSuelto, setPacienteSuelto] = useState<string | null>(null);
  const [pestana, setPestana] = useState<PatientTab>('sesion');

  const diaQuery = useDayView(fecha);
  const dia = diaQuery.data;

  const visibles = useMemo(() => citasDeLaCola(dia, busqueda), [dia, busqueda]);

  /**
   * Cita en curso. Cuando el doctor pulsa una fila de la cola manda esa cita; si la
   * cita desaparece de la jornada (la reprogramaron a otro día), se vuelve a la que
   * toca por estado y hora en lugar de dejar la pantalla en blanco.
   */
  const cita = useMemo(() => resolverSeleccion(visibles, elegidaId), [visibles, elegidaId]);

  /** Paciente del centro: el de la cita en curso o el que se haya abierto a mano. */
  const pacienteId = pacienteSuelto ?? cita?.patientId ?? null;

  return (
    <div className="space-y-5">
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
              onExit={() => {
                setPacienteSuelto(null);
                setElegidaId(null);
              }}
            />
          )}
        </div>
      </div>
    </div>
  );
};
