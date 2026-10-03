import {
  formatTime12h,
  type AppointmentSummary,
  type DaySlot,
  type DayView,
  type RequestSummary,
} from '@odontocrm/contracts';
import { Alert, Badge, Card, CardContent, CardHeader, CardTitle, cn } from '@odontocrm/ui';
import { LayoutGrid } from 'lucide-react';
import { useState, type DragEvent } from 'react';

import { SLOT_KIND_LABELS, SLOT_STATE_LABELS, t } from '../../lib/i18n';
import { AppointmentStatusBadge } from './AppointmentStatusBadge';

export interface SlotGridProps {
  day: DayView;
  /** Solicitud seleccionada en la cola: es la que se asigna con clic o teclado. */
  selectedRequest: RequestSummary | null;
  /** `scheduling:write`: sin el permiso la rejilla solo se consulta. */
  canAssign: boolean;
  /** Pide asignar la solicitud (la seleccionada o la arrastrada) a esa hora. */
  onRequestTime: (startTime: string, requestId?: string) => void;
  onOpenAppointment: (appointment: AppointmentSummary) => void;
}

const claveDeFranja = (slot: DaySlot): string => `${slot.kind}-${slot.startTime}`;

/**
 * Rejilla de franjas del día. Las franjas libres son destinos de arrastre
 * (HTML5 drag & drop) **y** botones: al pulsarlas —o con Enter— asignan la
 * solicitud seleccionada en la cola, de modo que el arrastre es un atajo y no
 * la única vía. Las ocupadas muestran el paciente y su estado, y abren la cita.
 */
export const SlotGrid = ({
  day,
  selectedRequest,
  canAssign,
  onRequestTime,
  onOpenAppointment,
}: SlotGridProps) => {
  const [sobre, setSobre] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);

  const libres = day.slots.filter((slot) => slot.state === 'libre').length;

  const alSoltar = (event: DragEvent<HTMLButtonElement>, slot: DaySlot) => {
    event.preventDefault();
    setSobre(null);
    if (slot.state !== 'libre' || !canAssign) return;

    const id = event.dataTransfer.getData('text/plain');
    if (id.length === 0) {
      setAviso(t('programacion.franja.sinSeleccion'));
      return;
    }
    setAviso(null);
    onRequestTime(slot.startTime, id);
  };

  const alPulsar = (slot: DaySlot) => {
    if (slot.state === 'ocupada' && slot.appointment !== null) {
      onOpenAppointment(slot.appointment);
      return;
    }
    if (slot.state !== 'libre') return;
    if (!canAssign) {
      setAviso(t('programacion.franja.sinPermiso'));
      return;
    }
    if (selectedRequest === null) {
      setAviso(t('programacion.franja.sinSeleccion'));
      return;
    }
    setAviso(null);
    onRequestTime(slot.startTime);
  };

  return (
    <Card>
      <CardHeader className="gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <CardTitle as="h2" className="flex items-center gap-2">
            <LayoutGrid className="size-4 text-primary" aria-hidden="true" />
            {t('programacion.franja.titulo')}
          </CardTitle>
          <p className="pt-1 text-sm text-ink-muted">{t('programacion.franja.ayuda')}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="neutral">
            {t('programacion.franja.total', { total: day.slots.length })}
          </Badge>
          <Badge variant="success">{`${t('programacion.franja.libre')}: ${libres}`}</Badge>
        </div>
      </CardHeader>

      <CardContent className="space-y-3">
        {canAssign && selectedRequest !== null && (
          <p className="text-sm text-ink-muted" aria-live="polite">
            {t('programacion.franja.seleccionada', {
              ticket: selectedRequest.ticket,
              paciente: selectedRequest.patientName,
            })}
          </p>
        )}

        {aviso !== null && (
          <Alert variant="info" onDismiss={() => setAviso(null)}>
            {aviso}
          </Alert>
        )}

        {day.slots.length === 0 ? (
          <Alert variant="info">{t('programacion.franja.vacio')}</Alert>
        ) : (
          <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-4">
            {day.slots.map((slot) => {
              const ocupada = slot.state === 'ocupada' && slot.appointment !== null;
              const fuera = slot.state === 'fuera_de_jornada';
              const resaltada = sobre === claveDeFranja(slot) && slot.state === 'libre';
              const cita = slot.appointment;

              const etiqueta = ocupada
                ? `${formatTime12h(slot.startTime)} · ${t('programacion.franja.ocupadaPor', {
                    paciente: cita?.patientName ?? '',
                  })}`
                : slot.state === 'libre'
                  ? canAssign && selectedRequest !== null
                    ? t('programacion.franja.asignarA', {
                        paciente: selectedRequest.patientName,
                        hora: formatTime12h(slot.startTime),
                      })
                    : t('programacion.franja.asignar', { hora: formatTime12h(slot.startTime) })
                  : t('programacion.franja.etiqueta', {
                      inicio: formatTime12h(slot.startTime),
                      fin: formatTime12h(slot.endTime),
                      estado: SLOT_STATE_LABELS[slot.state],
                    });

              return (
                <li key={claveDeFranja(slot)}>
                  <button
                    type="button"
                    disabled={fuera}
                    aria-label={etiqueta}
                    title={etiqueta}
                    onClick={() => alPulsar(slot)}
                    onDragOver={(event) => {
                      if (
                        slot.state !== 'libre' ||
                        !event.dataTransfer.types.includes('text/plain')
                      ) {
                        return;
                      }
                      event.preventDefault();
                      event.dataTransfer.dropEffect = 'move';
                      setSobre(claveDeFranja(slot));
                    }}
                    onDragLeave={() =>
                      setSobre((valor) => (valor === claveDeFranja(slot) ? null : valor))
                    }
                    onDrop={(event) => alSoltar(event, slot)}
                    className={cn(
                      'flex h-full w-full flex-col gap-1 rounded-control border px-3 py-2 text-left transition-colors',
                      'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-solid focus-visible:outline-focus',
                      slot.state === 'libre' &&
                        'border-dashed border-border-strong bg-surface hover:bg-surface-muted',
                      ocupada && 'border-border bg-surface',
                      fuera && 'cursor-not-allowed border-border bg-surface-muted opacity-60',
                      resaltada && 'border-solid border-primary bg-primary/10',
                    )}
                  >
                    <span className="flex items-center justify-between gap-2">
                      <span className="font-mono text-xs font-semibold text-ink">
                        {formatTime12h(slot.startTime)}
                      </span>
                      {slot.kind === 'manual' && (
                        <Badge variant="info">{SLOT_KIND_LABELS.manual}</Badge>
                      )}
                    </span>

                    {ocupada && cita !== null ? (
                      <>
                        <span className="truncate text-sm font-medium text-ink">
                          {cita.patientName}
                        </span>
                        <AppointmentStatusBadge status={cita.status} />
                      </>
                    ) : (
                      <span className="text-xs text-ink-subtle">
                        {SLOT_STATE_LABELS[slot.state]} · {formatTime12h(slot.endTime)}
                      </span>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
};
