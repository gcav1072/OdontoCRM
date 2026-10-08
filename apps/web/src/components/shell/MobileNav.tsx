import { cn } from '@odontocrm/ui';
import { Stethoscope, X } from 'lucide-react';
import { useEffect } from 'react';

import { t } from '../../lib/i18n';
import { SidebarNav } from './Sidebar';

export interface MobileNavProps {
  open: boolean;
  onClose: () => void;
}

/**
 * **Cajón de navegación para móvil** (`lg:hidden`).
 *
 * El raíl de escritorio desaparece por debajo de `lg` y en su lugar se abre este
 * cajón: a diferencia de la banda de iconos, muestra **las etiquetas y los títulos de
 * sección completos**, que es lo que en el móvil faltaba. Se cierra al navegar (el
 * `onNavigate` del enlace), con el botón de cerrar, tocando el fondo o con Escape.
 *
 * El fondo (`bg-overlay`) es el mismo velo que usan los diálogos, para que el
 * comportamiento se sienta igual en toda la aplicación.
 */
export const MobileNav = ({ open, onClose }: MobileNavProps) => {
  useEffect(() => {
    if (!open) return;
    const alPulsar = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', alPulsar);
    return () => window.removeEventListener('keydown', alPulsar);
  }, [open, onClose]);

  return (
    <div className={cn('fixed inset-0 z-50 lg:hidden', open ? '' : 'pointer-events-none')}>
      <div
        aria-hidden="true"
        onClick={onClose}
        className={cn(
          'absolute inset-0 bg-overlay transition-opacity duration-200',
          open ? 'opacity-100' : 'opacity-0',
        )}
      />
      <aside
        aria-label={t('menu.titulo')}
        aria-hidden={!open}
        className={cn(
          'absolute inset-y-0 left-0 flex w-72 max-w-[85vw] flex-col border-r border-border bg-surface shadow-panel transition-transform duration-200',
          open ? 'translate-x-0' : '-translate-x-full',
        )}
      >
        <div className="flex h-14 items-center gap-2 border-b border-border px-3">
          <span className="grid size-8 shrink-0 place-items-center rounded-control bg-primary text-primary-ink">
            <Stethoscope className="size-4" aria-hidden="true" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-semibold text-ink">{t('app.nombre')}</span>
            <span className="block truncate text-xs text-ink-subtle">{t('app.lema')}</span>
          </span>
          <button
            type="button"
            onClick={onClose}
            aria-label={t('menu.cerrar')}
            className={cn(
              'shrink-0 rounded-control p-1.5 text-ink-subtle transition-colors hover:bg-surface-muted hover:text-ink',
              'focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-solid focus-visible:outline-focus',
            )}
          >
            <X className="size-4" aria-hidden="true" />
          </button>
        </div>

        <SidebarNav collapsed={false} onNavigate={onClose} />
      </aside>
    </div>
  );
};
