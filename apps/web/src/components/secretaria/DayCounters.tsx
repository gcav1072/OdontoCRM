import type { DayView } from '@odontocrm/contracts';
import { Card } from '@odontocrm/ui';

import { t, type TranslationKey } from '../../lib/i18n';

/** Contadores del día que vigila el mostrador. */
const CONTADORES: readonly { clave: keyof DayView['counts']; etiqueta: TranslationKey }[] = [
  { clave: 'programadas', etiqueta: 'secretaria.contadores.programadas' },
  { clave: 'enSala', etiqueta: 'secretaria.contadores.enSala' },
  { clave: 'atendidas', etiqueta: 'secretaria.contadores.atendidas' },
  { clave: 'noAsistio', etiqueta: 'secretaria.contadores.noAsistio' },
];

export interface DayCountersProps {
  counts: DayView['counts'];
}

/**
 * Contadores del día tal como los cuenta el servidor (`day.counts`): el número
 * de citas de cada tramo del flujo. La cifra se lee de un vistazo, sin abrir
 * ninguna cita.
 */
export const DayCounters = ({ counts }: DayCountersProps) => (
  <Card>
    <dl className="grid grid-cols-2 gap-3 p-5 sm:grid-cols-4">
      {CONTADORES.map(({ clave, etiqueta }) => (
        <div
          key={clave}
          className="rounded-control border border-border bg-surface-muted px-3.5 py-2.5"
        >
          <dt className="text-xs font-medium text-ink-muted">{t(etiqueta)}</dt>
          <dd className="font-mono text-xl font-semibold text-ink">{counts[clave]}</dd>
        </div>
      ))}
    </dl>
  </Card>
);
