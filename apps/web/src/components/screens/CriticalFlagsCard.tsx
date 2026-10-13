import type { CriticalFlag } from '@odontocrm/contracts';
import { cn } from '@odontocrm/ui';
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
 *
 * Los colores salen de las variables `--kiosk-*`, así que la tarjeta respeta el modo
 * claro/oscuro y el color de acento de la pantalla (no los de la aplicación).
 */

const CLASES_SEVERIDAD: Readonly<Record<CriticalFlag['severidad'], string>> = {
  alto: 'border-[var(--kiosk-danger)] bg-[var(--kiosk-danger-soft)]',
  medio: 'border-[var(--kiosk-warn)] bg-[var(--kiosk-warn-soft)]',
  info: 'border-[var(--kiosk-border-strong)] bg-[var(--kiosk-surface)]',
};

/** Colores del rótulo de nivel de riesgo. */
const CLASES_BADGE: Readonly<Record<CriticalFlag['severidad'], string>> = {
  alto: 'border-[var(--kiosk-danger)] text-[var(--kiosk-danger)]',
  medio: 'border-[var(--kiosk-warn)] text-[var(--kiosk-warn)]',
  info: 'border-[var(--kiosk-border-strong)] text-[var(--kiosk-ink-subtle)]',
};

/** Etiqueta del nivel de riesgo (`pantallas.riesgo.*`). */
export const etiquetaSeveridad = (severidad: CriticalFlag['severidad']): string =>
  t(`pantallas.riesgo.${severidad}`);

export interface CriticalFlagsCardProps {
  flags: readonly CriticalFlag[];
}

export const CriticalFlagsCard = ({ flags }: CriticalFlagsCardProps) => {
  const ordenados = ordenarCriticos(flags);

  if (ordenados.length === 0) {
    return (
      <div className="rounded-card border border-[var(--kiosk-border)] bg-[var(--kiosk-surface)] px-6 py-5">
        <p className="flex items-center gap-2 text-sm font-semibold text-[var(--kiosk-ink)]">
          <Stethoscope className="size-4" aria-hidden="true" />
          {t('pantalla.consultorio.criticos')}
        </p>
        <p className="pt-1 text-sm text-[var(--kiosk-ink-muted)]">
          {t('pantalla.consultorio.sinCriticos')}
        </p>
      </div>
    );
  }

  return (
    <section aria-label={t('pantalla.consultorio.criticos')} className="space-y-3">
      <h2 className="flex items-center gap-2 text-xl font-semibold text-[var(--kiosk-ink)]">
        <TriangleAlert className="size-5" aria-hidden="true" />
        {t('pantalla.consultorio.criticos')}
      </h2>

      <ul className="grid gap-3 md:grid-cols-2">
        {ordenados.map((flag, indice) => (
          <li
            key={`${flag.tipo}-${flag.etiqueta}-${String(indice)}`}
            className={cn('rounded-card border-2 px-6 py-5', CLASES_SEVERIDAD[flag.severidad])}
          >
            <span
              className={cn(
                'inline-block rounded-full border px-2.5 py-0.5 text-xs font-semibold',
                CLASES_BADGE[flag.severidad],
              )}
            >
              {etiquetaSeveridad(flag.severidad)}
            </span>
            <p className="pt-2 text-3xl font-bold text-[var(--kiosk-ink)]">{flag.etiqueta}</p>
            {flag.detalle !== null && flag.detalle !== '' && (
              <p className="pt-1 text-lg text-[var(--kiosk-ink-muted)]">{flag.detalle}</p>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
};
