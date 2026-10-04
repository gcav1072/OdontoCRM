import { formatTime12h, type AppointmentSummary } from '@odontocrm/contracts';
import {
  Badge,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  EmptyState,
  Input,
  Spinner,
} from '@odontocrm/ui';
import { CalendarClock, Search } from 'lucide-react';

import { t } from '../../lib/i18n';
import { AppointmentStatusBadge } from '../scheduling/AppointmentStatusBadge';

export interface DayQueueProps {
  /** Citas del día ya filtradas por el buscador y ordenadas por hora. */
  appointments: readonly AppointmentSummary[];
  /** Cita en curso (la que ocupa el centro de la pantalla). */
  selectedId: string | null;
  search: string;
  /** La jornada todavía se está pidiendo: no es lo mismo vacío que sin cargar. */
  loading?: boolean;
  onSearch: (value: string) => void;
  onSelect: (appointment: AppointmentSummary) => void;
}

/**
 * Cola del día: la jornada a la izquierda de `/flujo`.
 *
 * Una fila por cita con su hora, su paciente y su estado. Pulsar una fila **lleva
 * ese paciente al centro** de la pantalla; las acciones no viven aquí sino en la
 * barra superior, que es lo que mantiene la columna estrecha y táctil. El estado se
 * ve de un vistazo: la fila de quien está en el consultorio queda marcada.
 */
export const DayQueue = ({
  appointments,
  selectedId,
  search,
  loading = false,
  onSearch,
  onSelect,
}: DayQueueProps) => (
  <Card className="lg:sticky lg:top-4 lg:max-h-[calc(100dvh-2rem)] lg:overflow-hidden">
    <CardHeader className="gap-3 pb-3">
      <CardTitle as="h2" className="flex items-center gap-2 text-base">
        <CalendarClock className="size-4 text-primary" aria-hidden />
        {t('flujo.cola.titulo')}
      </CardTitle>

      <div className="relative">
        <Search
          className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-ink-subtle"
          aria-hidden
        />
        <Input
          type="search"
          className="pl-9"
          value={search}
          aria-label={t('secretaria.buscar')}
          placeholder={t('secretaria.buscarPlaceholder')}
          onChange={(event) => onSearch(event.target.value)}
        />
      </div>
    </CardHeader>

    <CardContent className="lg:max-h-[calc(100dvh-14rem)] lg:overflow-y-auto">
      {loading ? (
        <div className="py-10">
          <Spinner label={t('secretaria.cargando')} showLabel />
        </div>
      ) : appointments.length === 0 ? (
        <EmptyState
          icon={<CalendarClock className="size-5" aria-hidden />}
          title={t('flujo.cola.vacia')}
          description={search.trim() === '' ? t('secretaria.vacio') : t('secretaria.sinResultados')}
        />
      ) : (
        <ul aria-label={t('flujo.cola.titulo')} className="divide-y divide-border">
          {appointments.map((cita) => {
            const seleccionada = cita.id === selectedId;
            return (
              <li key={cita.id}>
                {/* Dos líneas por cita: la hora y el estado arriba, el paciente
                    debajo. En la columna estrecha del escritorio, una sola línea
                    partía la hora y comía el nombre. */}
                <button
                  type="button"
                  onClick={() => onSelect(cita)}
                  aria-current={seleccionada ? 'true' : undefined}
                  className={`w-full px-2 py-3 text-left transition-colors ${
                    seleccionada
                      ? 'rounded-control bg-primary/10 ring-1 ring-primary/40'
                      : 'hover:bg-surface-muted'
                  }`}
                >
                  <span className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
                    <span className="font-mono text-xs font-semibold whitespace-nowrap text-ink">
                      {formatTime12h(cita.startTime)}
                    </span>
                    <span className="flex shrink-0 flex-wrap items-center gap-1">
                      <AppointmentStatusBadge status={cita.status} />
                      {cita.callCount > 0 && (
                        <Badge variant={cita.callCount >= 2 ? 'danger' : 'neutral'}>
                          {t('programacion.accion.llamados', { total: cita.callCount })}
                        </Badge>
                      )}
                    </span>
                  </span>
                  <span className="mt-1 block truncate text-sm font-medium text-ink">
                    {cita.patientName}
                  </span>
                  <span className="block truncate text-xs text-ink-subtle">
                    {cita.patientDocument ?? t('comun.sinDato')}
                    {cita.ticket !== null ? ` · ${cita.ticket}` : ''}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </CardContent>
  </Card>
);
