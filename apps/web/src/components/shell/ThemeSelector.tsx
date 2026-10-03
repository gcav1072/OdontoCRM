import { cn } from '@odontocrm/ui';
import { Monitor, Moon, Sun } from 'lucide-react';

import { t } from '../../lib/i18n';
import { useTheme, type ThemeMode } from '../../providers/ThemeProvider';

const OPCIONES: readonly {
  modo: ThemeMode;
  clave: 'tema.claro' | 'tema.oscuro' | 'tema.sistema';
  icono: typeof Sun;
}[] = [
  { modo: 'claro', clave: 'tema.claro', icono: Sun },
  { modo: 'oscuro', clave: 'tema.oscuro', icono: Moon },
  { modo: 'sistema', clave: 'tema.sistema', icono: Monitor },
];

/**
 * Selector de tema (claro / oscuro / sistema) como grupo de botones
 * conmutables: `aria-pressed` comunica cuál está activo y se recorre con Tab.
 */
export const ThemeSelector = ({ className }: { className?: string }) => {
  const { mode, setMode } = useTheme();

  return (
    <div
      role="group"
      aria-label={t('tema.titulo')}
      className={cn(
        'inline-flex rounded-control border border-border bg-surface-muted p-0.5',
        className,
      )}
    >
      {OPCIONES.map(({ modo, clave, icono: Icono }) => {
        const activo = mode === modo;
        return (
          <button
            key={modo}
            type="button"
            aria-pressed={activo}
            onClick={() => setMode(modo)}
            className={cn(
              'inline-flex items-center gap-1.5 rounded-[calc(var(--radius-control)-2px)] px-2.5 py-1.5 text-xs font-medium transition-colors',
              'focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-solid focus-visible:outline-focus',
              activo
                ? 'bg-surface text-ink shadow-card'
                : 'text-ink-muted hover:bg-surface/60 hover:text-ink',
            )}
          >
            <Icono className="size-3.5" aria-hidden="true" />
            {t(clave)}
          </button>
        );
      })}
    </div>
  );
};
