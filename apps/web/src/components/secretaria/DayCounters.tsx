import type { DayView } from '@odontocrm/contracts';
import { Card, cn } from '@odontocrm/ui';

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
  /**
   * Franja estrecha y sin tarjeta propia: la usa la barra superior de `/flujo`,
   * donde los contadores van **dentro** de la tarjeta del día. En `/secretaria`
   * (por defecto) siguen siendo una tarjeta con su relleno.
   */
  dense?: boolean;
}

/**
 * Contadores del día tal como los cuenta el servidor (`day.counts`): el número
 * de citas de cada tramo del flujo. La cifra se lee de un vistazo, sin abrir
 * ninguna cita.
 */
export const DayCounters = ({ counts, dense = false }: DayCountersProps) => {
  const lista = (
    <dl className={cn('grid grid-cols-2 gap-3 sm:grid-cols-4', dense ? 'gap-2' : 'p-5')}>
      {CONTADORES.map(({ clave, etiqueta }) => (
        <div
          key={clave}
          className={cn(
            'rounded-control border border-border bg-surface-muted',
            dense ? 'px-2.5 py-1.5' : 'px-3.5 py-2.5',
          )}
        >
          <dt className="text-xs font-medium text-ink-muted">{t(etiqueta)}</dt>
          <dd className={cn('font-mono font-semibold text-ink', dense ? 'text-base' : 'text-xl')}>
            {counts[clave]}
          </dd>
        </div>
      ))}
    </dl>
  );

  return dense ? lista : <Card>{lista}</Card>;
};
