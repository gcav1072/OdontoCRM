import { timeSchema } from '@odontocrm/contracts';
import { Alert, Button, Dialog, Field, Input } from '@odontocrm/ui';
import { useMutation } from '@tanstack/react-query';
import { CalendarPlus } from 'lucide-react';
import { useState } from 'react';

import { apiErrorMessage } from '../../lib/api';
import { appointmentsApi } from '../../lib/endpoints';
import { t } from '../../lib/i18n';

export interface ScheduleNextAppointmentDialogProps {
  patientId: string;
  patientName: string;
  /** Fecha sugerida en la sesión (`AAAA-MM-DD`), que viene ya rellena. */
  fechaSugerida: string;
  /** Nota de la sesión («control de endodoncia»), que pasa a la agenda. */
  notaSugerida: string | null;
  onClose: () => void;
  /** Cita creada: quien lo abrió guarda el enlace en la sesión. */
  onCreated: (appointmentId: string, fecha: string, hora: string) => void;
}

/** Duración por defecto de una revisión: la franja habitual del consultorio. */
const MINUTOS_POR_DEFECTO = 30;

/**
 * **Cuadro de confirmación de la próxima cita** (ADR 0052).
 *
 * El odontólogo escribió en la sesión «próxima cita: 4/11, control de endodoncia», y
 * eso, por sí solo, es una nota: nadie la ve en la agenda y a nadie se le avisa. Desde
 * aquí se crea la **cita real** con la fecha que ya venía escrita —la hora se elige,
 * porque la nota no la lleva— y la cita queda como cualquier otra: se avisa, sale el
 * `.ics` y el paciente puede confirmarla por Telegram o WhatsApp.
 *
 * Si el doctor no quiere crearla, se cierra el cuadro y la nota se queda donde estaba,
 * en la sesión: no se crea nada a sus espaldas.
 *
 * Se crea con hora **manual**: la nota dice el día, no la franja, y forzar una franja
 * de la plantilla obligaría a elegir entre las que queden libres. El servidor sigue
 * validando el solapamiento y el cupo, así que un choque de hora se ve al confirmar.
 */
export const ScheduleNextAppointmentDialog = ({
  patientId,
  patientName,
  fechaSugerida,
  notaSugerida,
  onClose,
  onCreated,
}: ScheduleNextAppointmentDialogProps) => {
  const [fecha, setFecha] = useState(fechaSugerida);
  const [hora, setHora] = useState('08:00');
  const [duracion, setDuracion] = useState(String(MINUTOS_POR_DEFECTO));
  const [nota, setNota] = useState(notaSugerida ?? '');
  const [errorGeneral, setErrorGeneral] = useState<string | null>(null);

  const horaValida = timeSchema.safeParse(hora).success;
  const duracionNumero = Number(duracion);
  const duracionValida = Number.isInteger(duracionNumero) && duracionNumero >= 5;

  const crear = useMutation({
    mutationFn: () =>
      appointmentsApi.assign({
        patientId,
        patientName,
        date: fecha,
        startTime: hora,
        durationMinutes: duracionNumero,
        // Manual: la hora la pone el doctor, no sale del catálogo de franjas.
        slotKind: 'manual',
        // El sobrecupo es del admin y exige motivo: aquí no se autoriza, así que una
        // hora sin cupo se rechaza con su mensaje y el cuadro lo enseña.
        authorizeOverbook: false,
        ...(nota.trim() === '' ? {} : { notes: nota.trim() }),
      }),
  });

  const confirmar = async (): Promise<void> => {
    setErrorGeneral(null);
    try {
      const cita = await crear.mutateAsync();
      onCreated(cita.id, cita.date, cita.startTime);
    } catch (fallo) {
      setErrorGeneral(apiErrorMessage(fallo));
    }
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title={t('clinica.sesion.agendar.titulo')}
      description={t('clinica.sesion.agendar.texto')}
      dismissOnBackdrop={false}
      closeLabel={t('comun.cerrar')}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={crear.isPending}>
            {t('clinica.sesion.agendar.omitir')}
          </Button>
          <Button
            loading={crear.isPending}
            loadingLabel={t('comun.enviando')}
            disabled={!horaValida || !duracionValida || fecha === ''}
            leadingIcon={<CalendarPlus className="size-4" aria-hidden="true" />}
            onClick={() => {
              void confirmar();
            }}
          >
            {t('clinica.sesion.agendar.crear')}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {errorGeneral !== null && <Alert variant="danger">{errorGeneral}</Alert>}

        <Alert variant="info" hideIcon>
          {t('clinica.sesion.agendar.noLaborable')}
        </Alert>

        <div className="grid gap-3 sm:grid-cols-3">
          <Field label={t('clinica.sesion.agendar.fecha')}>
            <Input type="date" value={fecha} onChange={(event) => setFecha(event.target.value)} />
          </Field>
          <Field label={t('clinica.sesion.agendar.hora')}>
            <Input
              type="time"
              value={hora}
              onChange={(event) => setHora(event.target.value)}
              aria-invalid={!horaValida}
            />
          </Field>
          <Field label={t('clinica.sesion.agendar.duracion')}>
            <Input
              type="number"
              min={5}
              max={240}
              step={5}
              value={duracion}
              onChange={(event) => setDuracion(event.target.value)}
              aria-invalid={!duracionValida}
            />
          </Field>
        </div>

        {!horaValida && <Alert variant="warning">{t('clinica.sesion.agendar.faltaHora')}</Alert>}

        <Field label={t('clinica.sesion.agendar.nota')}>
          <Input value={nota} onChange={(event) => setNota(event.target.value)} maxLength={500} />
        </Field>
      </div>
    </Dialog>
  );
};
