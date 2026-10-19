import {
  DEFAULT_SLOT_MINUTES,
  weekdayName,
  type SlotTemplate,
  type WeekScheduleInput,
} from '@odontocrm/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Button, Dialog, Field, Select, Spinner } from '@odontocrm/ui';
import { CalendarDays, Plus, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';

import { apiErrorMessage } from '../../lib/api';
import { agendaApi } from '../../lib/endpoints';
import { t } from '../../lib/i18n';
import { schedulingKeys } from '../../lib/scheduling';
import {
  WEEKDAY_ORDER,
  countSlots,
  factoryShifts,
  validateShifts,
  type ShiftDraft,
} from '../../lib/schedule-config';
import { Hora12hField } from './Hora12hField';

export interface ScheduleConfigDialogProps {
  /** Día que se está viendo en la jornada; el diálogo abre en él. */
  weekday: number;
  onClose: () => void;
  onSaved: () => void;
}

/** Duraciones habituales; si la guardada no está, se añade para no perderla. */
const DURACIONES = [10, 15, 20, 30, 45, 60];

type AplicarA = 'dia' | 'semana' | 'todos';

const capitalizar = (value: string): string =>
  value === '' ? value : value.charAt(0).toUpperCase() + value.slice(1);

const diasDe = (dia: number, aplicarA: AplicarA): number[] => {
  if (aplicarA === 'dia') return [dia];
  if (aplicarA === 'semana') return [1, 2, 3, 4, 5];
  return [0, 1, 2, 3, 4, 5, 6];
};

/**
 * Configurador de la jornada: **turnos de atención** y duración de la franja.
 *
 * Sustituye al viejo «Editar el cupo»: el cupo no se escribe, se deduce. Los turnos
 * se guardan como plantillas por día de la semana, así que un cambio afecta también a
 * los días ya programados (las citas existentes **no** se mueven).
 *
 * Solo edita el horario **común** (el de todos los consultorios); un consultorio con
 * horario propio lo conserva, y el diálogo lo avisa.
 */
export const ScheduleConfigDialog = ({ weekday, onClose, onSaved }: ScheduleConfigDialogProps) => {
  const cliente = useQueryClient();
  const plantillasQuery = useQuery({
    queryKey: schedulingKeys.templates,
    queryFn: ({ signal }) => agendaApi.templates(signal),
  });

  const [dia, setDia] = useState(weekday);
  const [shifts, setShifts] = useState<ShiftDraft[]>([]);
  const [slotMinutes, setSlotMinutes] = useState(DEFAULT_SLOT_MINUTES);
  const [aplicarA, setAplicarA] = useState<AplicarA>('dia');
  const [errorGeneral, setErrorGeneral] = useState<string | null>(null);

  const plantillas: readonly SlotTemplate[] = plantillasQuery.data?.items ?? [];
  const cargando = plantillasQuery.isPending;

  // Al cambiar de día se recarga su horario guardado (un día a la vez).
  useEffect(() => {
    const items = plantillasQuery.data?.items;
    if (items === undefined) return;
    const delDia = items.filter(
      (plantilla) => plantilla.weekday === dia && plantilla.chairId === null && plantilla.isActive,
    );
    setShifts(
      delDia
        .map((plantilla) => ({
          startTime: plantilla.startTime,
          endTime: plantilla.endTime,
        }))
        .sort((left, right) => left.startTime.localeCompare(right.startTime)),
    );
    setSlotMinutes(delDia[0]?.slotMinutes ?? DEFAULT_SLOT_MINUTES);
  }, [plantillasQuery.data, dia]);

  const guardar = useMutation({
    mutationFn: (input: WeekScheduleInput) => agendaApi.setWeekSchedule(input),
  });

  const issues = validateShifts(shifts, slotMinutes);
  const bloqueado = issues.length > 0;
  const total = countSlots(shifts, slotMinutes);
  const cerrado = shifts.length === 0;
  const hayHorarioPropio = plantillas.some(
    (plantilla) => plantilla.chairId !== null && plantilla.isActive,
  );
  const duracionActual = DURACIONES.includes(slotMinutes) ? slotMinutes : null;

  const cambiarTurno = (index: number, cambio: Partial<ShiftDraft>) => {
    setShifts((actuales) =>
      actuales.map((turno, posicion) => (posicion === index ? { ...turno, ...cambio } : turno)),
    );
  };

  const errorDe = (index: number): string | undefined => {
    const issue = issues.find((candidato) => candidato.index === index);
    if (issue === undefined) return undefined;
    if (issue.kind === 'vacio') return t('programacion.jornada.error.vacio');
    if (issue.kind === 'invertido') return t('programacion.jornada.error.invertido');
    if (issue.kind === 'corta')
      return t('programacion.jornada.error.corta', {
        minutos: issue.minutos,
        franja: slotMinutes,
      });
    return t('programacion.jornada.error.solape');
  };

  const enviar = async () => {
    setErrorGeneral(null);
    try {
      await guardar.mutateAsync({
        weekdays: diasDe(dia, aplicarA),
        chairId: null,
        slotMinutes,
        shifts: shifts.map((turno) => ({
          startTime: turno.startTime,
          endTime: turno.endTime,
        })),
      });
      // La jornada y el horario cambian a la vez: el cupo se recalcula solo. Se esperan
      // las dos invalidaciones para que, cuando el diálogo se cierre, la rejilla que hay
      // detrás ya esté repintada (no queda un parpadeo con las franjas viejas).
      await Promise.all([
        cliente.invalidateQueries({ queryKey: schedulingKeys.daysRoot }),
        cliente.invalidateQueries({ queryKey: schedulingKeys.templates }),
      ]);
      onSaved();
    } catch (fallo) {
      setErrorGeneral(apiErrorMessage(fallo));
    }
  };

  return (
    <Dialog
      open
      onClose={onClose}
      size="lg"
      title={t('programacion.jornada.titulo')}
      description={t('programacion.jornada.texto')}
      dismissOnBackdrop={false}
      closeLabel={t('comun.cerrar')}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={guardar.isPending}>
            {t('comun.cancelar')}
          </Button>
          <Button
            type="submit"
            form="formulario-horario"
            loading={guardar.isPending}
            loadingLabel={t('comun.guardando')}
            disabled={cargando || bloqueado}
          >
            {t('comun.guardar')}
          </Button>
        </>
      }
    >
      {cargando ? (
        <Spinner label={t('programacion.jornada.cargando')} showLabel />
      ) : plantillasQuery.isError ? (
        <Alert variant="danger" title={t('programacion.jornada.errorCarga')}>
          {apiErrorMessage(plantillasQuery.error)}
        </Alert>
      ) : (
        <form
          id="formulario-horario"
          noValidate
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            void enviar();
          }}
        >
          {errorGeneral !== null && <Alert variant="danger">{errorGeneral}</Alert>}

          <div className="grid gap-4 @2xl:grid-cols-2">
            <Field label={t('programacion.jornada.dia')}>
              <Select value={dia} onChange={(event) => setDia(Number(event.target.value))}>
                {WEEKDAY_ORDER.map((numero) => (
                  <option key={numero} value={numero}>
                    {capitalizar(weekdayName(numero))}
                  </option>
                ))}
              </Select>
            </Field>

            <Field
              label={t('programacion.jornada.duracion')}
              hint={t('programacion.jornada.duracionAyuda', { minutos: slotMinutes })}
            >
              <Select
                value={slotMinutes}
                onChange={(event) => setSlotMinutes(Number(event.target.value))}
              >
                {duracionActual === null && <option value={slotMinutes}>{slotMinutes}</option>}
                {DURACIONES.map((minutos) => (
                  <option key={minutos} value={minutos}>
                    {t('programacion.jornada.minutosValor', { minutos })}
                  </option>
                ))}
              </Select>
            </Field>
          </div>

          <Field label={t('programacion.jornada.aplicarA')}>
            <div className="flex flex-wrap gap-2">
              {(['dia', 'semana', 'todos'] as const).map((opcion) => (
                <label
                  key={opcion}
                  className={
                    aplicarA === opcion
                      ? 'flex cursor-pointer items-center gap-2 rounded-control border border-primary bg-primary/5 px-3 py-2 text-sm text-ink'
                      : 'flex cursor-pointer items-center gap-2 rounded-control border border-border px-3 py-2 text-sm text-ink-muted'
                  }
                >
                  <input
                    type="radio"
                    name="aplicar-horario"
                    className="size-4 accent-primary"
                    value={opcion}
                    checked={aplicarA === opcion}
                    onChange={() => setAplicarA(opcion)}
                  />
                  {opcion === 'dia'
                    ? t('programacion.jornada.aplicar.dia', {
                        dia: weekdayName(dia),
                      })
                    : opcion === 'semana'
                      ? t('programacion.jornada.aplicar.semana')
                      : t('programacion.jornada.aplicar.todos')}
                </label>
              ))}
            </div>
          </Field>

          <section className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h3 className="text-sm font-medium text-ink">{t('programacion.jornada.turnos')}</h3>
                <p className="text-xs text-ink-subtle">{t('programacion.jornada.turnosAyuda')}</p>
              </div>
              <div className="flex flex-wrap gap-2">
                {cerrado && (
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => setShifts(factoryShifts())}
                    leadingIcon={<CalendarDays className="size-4" aria-hidden="true" />}
                  >
                    {t('programacion.jornada.fabrica')}
                  </Button>
                )}
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() =>
                    setShifts((actuales) => [...actuales, { startTime: '08:00', endTime: '12:00' }])
                  }
                  leadingIcon={<Plus className="size-4" aria-hidden="true" />}
                >
                  {t('programacion.jornada.anadir')}
                </Button>
              </div>
            </div>

            {cerrado ? (
              <Alert variant="warning">{t('programacion.jornada.cerrado')}</Alert>
            ) : (
              <ul className="space-y-3">
                {shifts.map((turno, index) => (
                  <li
                    key={`turno-${String(index)}`}
                    className="rounded-control border border-border bg-surface-muted p-3"
                  >
                    <div className="flex flex-wrap items-end gap-2">
                      <Hora12hField
                        className="min-w-40 flex-1"
                        label={t('programacion.jornada.inicio')}
                        value={turno.startTime}
                        error={errorDe(index)}
                        onChange={(startTime) => cambiarTurno(index, { startTime })}
                      />
                      <Hora12hField
                        className="min-w-40 flex-1"
                        label={t('programacion.jornada.fin')}
                        value={turno.endTime}
                        onChange={(endTime) => cambiarTurno(index, { endTime })}
                      />
                      <Button
                        variant="ghost"
                        className="text-danger"
                        aria-label={t('programacion.jornada.quitar', { numero: index + 1 })}
                        title={t('programacion.jornada.quitar', { numero: index + 1 })}
                        onClick={() =>
                          setShifts((actuales) =>
                            actuales.filter((_, posicion) => posicion !== index),
                          )
                        }
                        leadingIcon={<Trash2 className="size-4" aria-hidden="true" />}
                      >
                        {t('programacion.jornada.quitarCorto')}
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
            )}

            <p className="text-sm text-ink-muted">
              {t('programacion.jornada.resumen', { total, minutos: slotMinutes })}
            </p>
          </section>

          {hayHorarioPropio && (
            <Alert variant="info">{t('programacion.jornada.avisoSillon')}</Alert>
          )}
          <Alert variant="info">{t('programacion.jornada.avisoCitas')}</Alert>
          {aplicarA !== 'dia' && (
            <Alert variant="warning">{t('programacion.jornada.avisoSemana')}</Alert>
          )}
        </form>
      )}
    </Dialog>
  );
};
