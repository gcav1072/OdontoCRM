import {
  CLINICAL_STATE_COLORS,
  CLINICAL_STATE_LABELS,
  CONDITION_LABELS,
  surfaceLabelFor,
  TOOTH_FINDING_HISTORY_EVENTS,
  isToothNumber,
  type ToothFindingHistoryEntry,
  type ToothFindingHistoryEvent,
} from '@odontocrm/contracts';
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  EmptyState,
  Field,
  Input,
  Select,
} from '@odontocrm/ui';
import { Activity, CalendarDays, Clock, ListFilter, StickyNote, UserRound } from 'lucide-react';
import { useMemo, useState } from 'react';

import { TIME_ZONE, formatDate, formatTime, toDate } from '../../lib/format';
import { t } from '../../lib/i18n';

/**
 * Evolución del odontograma (Fase 6B).
 *
 * El servidor guarda el histórico como una lista *append-only* de
 * `ToothFindingHistoryEntry`: cada fila es un cambio que ya ocurrió, no un estado.
 * Aquí se lee como una línea de tiempo: los cambios se agrupan por día y, dentro
 * del día, van del más reciente al más antiguo.
 *
 * Dos decisiones que conviene no deshacer:
 *  - La agrupación usa la zona del **consultorio** (`TIME_ZONE`), no la del
 *    navegador: un cambio de las 11:30 p. m. pertenece a ese día se abra la ficha
 *    donde se abra (misma regla que `format.ts`, ADR 0025).
 *  - El agrupador por defecto es el día. La Fase 7 (sesiones clínicas) podrá
 *    agrupar por sesión pasando `sessionOf`; el contrato del histórico todavía no
 *    trae el dato de sesión, así que no se inventa un campo: se deja el hueco.
 *
 * Las condiciones, caras y estados se etiquetan con los rótulos del contrato
 * (`CONDITION_LABELS`, `SURFACE_LABELS`, `CLINICAL_STATE_LABELS`) y su color sale
 * de `CLINICAL_STATE_COLORS` —rojo pendiente, azul completado—: son el mismo
 * vocabulario clínico que usa el gráfico, y duplicarlo aquí lo dejaría divergir.
 */

/* ── Agrupación y filtrado (puros: los cubre `history.test.ts`) ─────────────── */

/** Filtros de la línea de tiempo; `null` significa «sin filtrar» en ese campo. */
export interface HistoryFilters {
  /** Pieza FDI exacta (11–48 o 51–85). */
  toothNumber: number | null;
  /** Tipo de cambio del histórico. */
  event: ToothFindingHistoryEvent | null;
}

/** Sesión clínica de un grupo (Fase 7): identificador y etiqueta visible. */
export interface HistorySession {
  id: string;
  label: string;
}

/**
 * Traduce una entrada a su sesión clínica. Quien conozca la relación la aporta por
 * aquí; devolver `null` deja esa entrada en el grupo del día. Es el punto de
 * enganche de la Fase 7, no un campo del contrato.
 */
export type HistorySessionResolver = (entry: ToothFindingHistoryEntry) => HistorySession | null;

/** Un grupo de la línea de tiempo: un día o, en la Fase 7, una sesión clínica. */
export interface HistoryGroup {
  /** Clave estable: `2026-10-02` para un día y `sesion:<id>` para una sesión. */
  key: string;
  /** Instante de la entrada más reciente del grupo, para encabezar y ordenar. */
  occurredAt: string;
  /** Sesión del grupo, o `null` cuando se agrupa por día. */
  session: HistorySession | null;
  entries: ToothFindingHistoryEntry[];
}

const formateadorClaveDia = new Intl.DateTimeFormat('en-CA', {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  timeZone: TIME_ZONE,
});

/** Milisegundos de una fecha del histórico; `0` si el servidor mandó algo ilegible. */
const instante = (value: string): number => toDate(value)?.getTime() ?? 0;

/**
 * Clave del día del consultorio (`2026-10-02`). Se arma con las partes que da
 * `Intl` en vez de recortar el ISO: el ISO viene en UTC y recortarlo agruparía mal
 * todo lo registrado después de las 8 p. m. de Venezuela.
 */
export const historyDayKey = (value: string | number | Date | null | undefined): string => {
  const fecha = toDate(value);
  if (!fecha) return '';

  let anio = '';
  let mes = '';
  let dia = '';
  for (const parte of formateadorClaveDia.formatToParts(fecha)) {
    if (parte.type === 'year') anio = parte.value;
    else if (parte.type === 'month') mes = parte.value;
    else if (parte.type === 'day') dia = parte.value;
  }
  return `${anio}-${mes}-${dia}`;
};

/**
 * Ordena de lo más reciente a lo más antiguo. El servidor ya devuelve el histórico
 * en ese orden, pero la vista no depende de ello: si algún día cambia, la línea de
 * tiempo sigue leyéndose igual. No muta la lista que recibe.
 */
export const sortHistoryDesc = (
  entries: readonly ToothFindingHistoryEntry[],
): ToothFindingHistoryEntry[] =>
  [...entries].sort((a, b) => instante(b.occurredAt) - instante(a.occurredAt));

/** Agrupa por día del consultorio; los grupos y sus entradas van de nuevo a viejo. */
export const groupByDay = (entries: readonly ToothFindingHistoryEntry[]): HistoryGroup[] => {
  const grupos = new Map<string, HistoryGroup>();

  for (const entry of sortHistoryDesc(entries)) {
    const key = historyDayKey(entry.occurredAt);
    const grupo = grupos.get(key);
    if (grupo) grupo.entries.push(entry);
    else grupos.set(key, { key, occurredAt: entry.occurredAt, session: null, entries: [entry] });
  }

  // `Map` conserva el orden de inserción y las entradas ya vienen ordenadas: los
  // grupos salen del día más reciente al más antiguo sin volver a ordenar.
  return [...grupos.values()];
};

/**
 * Agrupa la evolución: por sesión clínica donde el resolutor la conozca (Fase 7) y
 * por día donde no. Sin resolutor es exactamente `groupByDay`.
 */
export const groupHistory = (
  entries: readonly ToothFindingHistoryEntry[],
  sessionOf?: HistorySessionResolver,
): HistoryGroup[] => {
  if (!sessionOf) return groupByDay(entries);

  const grupos = new Map<string, HistoryGroup>();
  for (const entry of sortHistoryDesc(entries)) {
    const session = sessionOf(entry);
    const key = session ? `sesion:${session.id}` : historyDayKey(entry.occurredAt);
    const grupo = grupos.get(key);
    if (grupo) grupo.entries.push(entry);
    else grupos.set(key, { key, occurredAt: entry.occurredAt, session, entries: [entry] });
  }

  return [...grupos.values()];
};

/** Aplica los filtros de pieza y de tipo de cambio conservando el orden recibido. */
export const filterEntries = (
  entries: readonly ToothFindingHistoryEntry[],
  filters: Partial<HistoryFilters>,
): ToothFindingHistoryEntry[] =>
  entries.filter(
    (entry) =>
      (filters.toothNumber === undefined ||
        filters.toothNumber === null ||
        entry.toothNumber === filters.toothNumber) &&
      (filters.event === undefined || filters.event === null || entry.event === filters.event),
  );

/** Resultado de leer el campo de pieza del filtro. */
export interface ToothFilterParse {
  /** Pieza que se aplica como filtro, o `null` si el campo no filtra todavía. */
  value: number | null;
  /** `true` cuando ya hay dos dígitos y no forman una pieza FDI válida. */
  invalid: boolean;
}

/**
 * Lee el filtro de pieza. Con un solo dígito el campo está **incompleto**, no mal:
 * mientras se teclea «1» no se filtra ni se avisa de error, que es lo que espera
 * quien escribe «16» dígito a dígito.
 */
export const parseToothFilter = (raw: string): ToothFilterParse => {
  const digitos = raw.replace(/\D/g, '').slice(0, 2);
  if (digitos.length < 2) return { value: null, invalid: false };

  const numero = Number(digitos);
  return isToothNumber(numero) ? { value: numero, invalid: false } : { value: null, invalid: true };
};

/** Etiqueta legible del tipo de cambio; el contrato ya nombra los cinco eventos. */
const EVENT_LABELS: Readonly<Record<ToothFindingHistoryEvent, string>> = {
  registrado: t('odontograma.historial.evento.registrado'),
  actualizado: t('odontograma.historial.evento.actualizado'),
  eliminado: t('odontograma.historial.evento.eliminado'),
  superado: t('odontograma.historial.evento.superado'),
  resuelto: t('odontograma.historial.evento.resuelto'),
};

export const historyEventLabel = (event: ToothFindingHistoryEvent): string => EVENT_LABELS[event];

const esEvento = (value: string): value is ToothFindingHistoryEvent =>
  (TOOTH_FINDING_HISTORY_EVENTS as readonly string[]).includes(value);

/* ── Piezas de la vista ────────────────────────────────────────────────────── */

/** Colores del contrato con transparencia, para el fondo del rótulo de estado. */
const fondoEstado = (color: string): string => `${color}1a`;

const HistoryRow = ({ entry }: { entry: ToothFindingHistoryEntry }) => {
  const color = CLINICAL_STATE_COLORS[entry.state];

  return (
    <li className="rounded-control border border-border bg-surface p-3">
      <div className="flex flex-wrap items-center gap-2">
        {/* El punto repite el color del estado; el texto del rótulo es el que
            informa, así que el color nunca es el único portador del dato. */}
        <span
          aria-hidden="true"
          className="size-2.5 shrink-0 rounded-full"
          style={{ backgroundColor: color }}
        />
        <span className="text-sm font-medium text-ink">
          {t('odontograma.historial.piezaFdi', { numero: entry.toothNumber })}
        </span>
        <Badge variant="neutral">
          {entry.surface === null
            ? t('odontograma.historial.piezaCompleta')
            : surfaceLabelFor(entry.toothNumber, entry.surface)}
        </Badge>
        <Badge variant="neutral">{CONDITION_LABELS[entry.condition]}</Badge>
        <Badge
          variant="neutral"
          style={{
            borderColor: color,
            color,
            backgroundColor: fondoEstado(color),
          }}
        >
          {CLINICAL_STATE_LABELS[entry.state]}
        </Badge>
        <Badge variant="neutral">{historyEventLabel(entry.event)}</Badge>

        <span className="ml-auto inline-flex items-center gap-1 text-xs text-ink-subtle">
          <Clock className="size-3.5" aria-hidden="true" />
          {formatTime(entry.occurredAt)}
        </span>
      </div>

      <p className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-subtle">
        <span className="inline-flex items-center gap-1">
          <UserRound className="size-3.5" aria-hidden="true" />
          {entry.actorUsername ?? t('odontograma.historial.autorDesconocido')}
        </span>
        {entry.reason !== null && entry.reason !== '' && (
          <span>
            {t('odontograma.historial.motivo')}: {entry.reason}
          </span>
        )}
      </p>

      {entry.notes !== null && entry.notes !== '' && (
        <p className="mt-2 flex items-start gap-1.5 rounded-control bg-surface-muted px-2.5 py-2 text-sm text-ink-muted">
          <StickyNote className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
          <span className="whitespace-pre-line">{entry.notes}</span>
        </p>
      )}
    </li>
  );
};

/* ── Componente ────────────────────────────────────────────────────────────── */

export interface OdontogramHistoryProps {
  /** Histórico tal como lo devuelve `odontogramApi.history`. */
  entries: readonly ToothFindingHistoryEntry[];
  /** Agrupador por sesión clínica (Fase 7). Sin él, se agrupa por día. */
  sessionOf?: HistorySessionResolver;
}

/**
 * Línea de tiempo de la evolución: filtros de pieza y de tipo de cambio, un bloque
 * por día (o sesión) y una fila por cambio. Es solo lectura: el histórico no se
 * edita, se consulta.
 */
export const OdontogramHistory = ({ entries, sessionOf }: OdontogramHistoryProps) => {
  const [toothInput, setToothInput] = useState('');
  const [event, setEvent] = useState<ToothFindingHistoryEvent | null>(null);

  const pieza = parseToothFilter(toothInput);
  const visibles = useMemo(
    () => filterEntries(entries, { toothNumber: pieza.value, event }),
    [entries, pieza.value, event],
  );
  const grupos = useMemo(() => groupHistory(visibles, sessionOf), [visibles, sessionOf]);
  const filtrando = toothInput !== '' || event !== null;

  const limpiarFiltros = () => {
    setToothInput('');
    setEvent(null);
  };

  return (
    <Card>
      <CardHeader className="flex-wrap items-start justify-between gap-3">
        <div>
          <CardTitle className="flex items-center gap-2">
            <Activity className="size-5 text-primary" aria-hidden="true" />
            {t('odontograma.historial.cardTitulo')}
          </CardTitle>
          <p className="pt-1 text-sm text-ink-muted">{t('odontograma.historial.cardTexto')}</p>
        </div>
        {entries.length > 0 && (
          <Badge variant="info">
            {t('odontograma.historial.total', { total: entries.length })}
          </Badge>
        )}
      </CardHeader>

      <CardContent>
        {entries.length === 0 ? (
          <EmptyState
            icon={<Activity className="size-5" aria-hidden="true" />}
            title={t('odontograma.historial.vacio')}
            description={t('odontograma.historial.vacioTexto')}
          />
        ) : (
          <>
            <div className="flex flex-wrap items-end gap-3">
              <Field
                label={t('odontograma.historial.filtro.pieza')}
                className="w-40"
                hint={t('odontograma.historial.filtro.piezaAyuda')}
                error={pieza.invalid ? t('odontograma.historial.filtro.piezaInvalida') : undefined}
              >
                <Input
                  value={toothInput}
                  inputMode="numeric"
                  autoComplete="off"
                  maxLength={2}
                  placeholder={t('odontograma.historial.filtro.piezaEjemplo')}
                  onChange={(cambio) =>
                    // Solo dígitos: el campo es un número FDI de dos cifras y así
                    // no hay que discutir con el teclado ni con el pegado.
                    setToothInput(cambio.target.value.replace(/\D/g, '').slice(0, 2))
                  }
                />
              </Field>

              <Field label={t('odontograma.historial.filtro.evento')} className="w-52">
                <Select
                  value={event ?? ''}
                  onChange={(cambio) => {
                    const valor = cambio.target.value;
                    setEvent(esEvento(valor) ? valor : null);
                  }}
                >
                  <option value="">{t('odontograma.historial.filtro.todos')}</option>
                  {TOOTH_FINDING_HISTORY_EVENTS.map((valor) => (
                    <option key={valor} value={valor}>
                      {historyEventLabel(valor)}
                    </option>
                  ))}
                </Select>
              </Field>

              {filtrando && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={limpiarFiltros}
                  leadingIcon={<ListFilter className="size-4" aria-hidden="true" />}
                >
                  {t('odontograma.historial.limpiarFiltros')}
                </Button>
              )}
            </div>

            {visibles.length === 0 ? (
              <div className="mt-5">
                <EmptyState
                  icon={<ListFilter className="size-5" aria-hidden="true" />}
                  title={t('odontograma.historial.filtroVacio')}
                  description={t('odontograma.historial.filtroVacioTexto')}
                  action={
                    <Button variant="secondary" size="sm" onClick={limpiarFiltros}>
                      {t('odontograma.historial.limpiarFiltros')}
                    </Button>
                  }
                />
              </div>
            ) : (
              <ol className="mt-5 space-y-5" aria-label={t('odontograma.historial.timeline')}>
                {grupos.map((grupo) => (
                  <li key={grupo.key}>
                    <div className="flex flex-wrap items-center gap-2 border-b border-border pb-1.5">
                      <CalendarDays className="size-4 text-ink-subtle" aria-hidden="true" />
                      <h3 className="text-sm font-semibold text-ink">
                        {grupo.session
                          ? t('odontograma.historial.sesion', { sesion: grupo.session.label })
                          : formatDate(grupo.occurredAt)}
                      </h3>
                      <Badge variant="neutral" className="ml-auto">
                        {t('odontograma.historial.total', { total: grupo.entries.length })}
                      </Badge>
                    </div>

                    <ul className="mt-2 space-y-2">
                      {grupo.entries.map((entry) => (
                        <HistoryRow key={entry.id} entry={entry} />
                      ))}
                    </ul>
                  </li>
                ))}
              </ol>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
};
