import type { CriticalFlag } from '@odontocrm/contracts';
import { Badge, cn } from '@odontocrm/ui';
import { Stethoscope, TriangleAlert } from 'lucide-react';

import { t } from '../../lib/i18n';
import { ordenarCriticos } from '../../lib/screens';

/**
 * Datos críticos del paciente en curso, con semáforo de riesgo.
 *
 * Es la parte de la pantalla del consultorio que el doctor mira de reojo antes
 * de entrar: alergias, crónicos, anticoagulantes. Por eso el color y el tamaño
 * van por delante del texto (rojo = para y lee) y el orden lo decide
 * `ordenarCriticos`, que pone primero lo que mata.
 */

const VARIANTE_POR_SEVERIDAD: Readonly<
  Record<CriticalFlag['severidad'], 'danger' | 'warning' | 'info'>
> = {
  alto: 'danger',
  medio: 'warning',
  info: 'info',
};

/** Etiqueta del nivel de riesgo (`pantallas.riesgo.*`). */
export const etiquetaSeveridad = (severidad: CriticalFlag['severidad']): string =>
  t(`pantallas.riesgo.${severidad}`);

/**
 * Clases del semáforo. Son de tema oscuro fijo (la pantalla del consultorio se
 * pinta oscura para el televisor), con borde y texto del color del riesgo.
 */
const CLASES_SEVERIDAD: Readonly<Record<CriticalFlag['severidad'], string>> = {
  alto: 'border-red-500/70 bg-red-500/10',
  medio: 'border-amber-400/70 bg-amber-400/10',
  info: 'border-slate-500/60 bg-slate-500/10',
};

export interface CriticalFlagsCardProps {
  flags: readonly CriticalFlag[];
}

export const CriticalFlagsCard = ({ flags }: CriticalFlagsCardProps) => {
  const ordenados = ordenarCriticos(flags);

  if (ordenados.length === 0) {
    return (
      <div className="rounded-card border border-slate-700 bg-slate-900/60 px-6 py-5 text-slate-300">
        <p className="flex items-center gap-2 text-sm font-semibold text-slate-200">
          <Stethoscope className="size-4" aria-hidden="true" />
          {t('pantalla.consultorio.criticos')}
        </p>
        <p className="pt-1 text-sm">{t('pantalla.consultorio.sinCriticos')}</p>
      </div>
    );
  }

  return (
    <section aria-label={t('pantalla.consultorio.criticos')} className="space-y-3">
      <h2 className="flex items-center gap-2 text-xl font-semibold text-slate-200">
        <TriangleAlert className="size-5" aria-hidden="true" />
        {t('pantalla.consultorio.criticos')}
      </h2>

      <ul className="grid gap-3 md:grid-cols-2">
        {ordenados.map((flag, indice) => (
          <li
            key={`${flag.tipo}-${flag.etiqueta}-${String(indice)}`}
            className={cn('rounded-card border-2 px-6 py-5', CLASES_SEVERIDAD[flag.severidad])}
          >
            <Badge variant={VARIANTE_POR_SEVERIDAD[flag.severidad]}>
              {etiquetaSeveridad(flag.severidad)}
            </Badge>
            <p className="pt-2 text-3xl font-bold text-white">{flag.etiqueta}</p>
            {flag.detalle !== null && flag.detalle !== '' && (
              <p className="pt-1 text-lg text-slate-200">{flag.detalle}</p>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
};
