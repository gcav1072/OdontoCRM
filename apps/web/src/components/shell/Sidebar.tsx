import { cn } from '@odontocrm/ui';
import { PanelLeft, Stethoscope } from 'lucide-react';
import { NavLink } from 'react-router-dom';

import { t } from '../../lib/i18n';
import { MODULES, NAV_SECTIONS } from '../../lib/nav';
import { useAuth } from '../../providers/AuthProvider';

export interface SidebarProps {
  collapsed: boolean;
  onToggle: () => void;
}

/**
 * Navegación lateral.
 *
 * El menú se filtra por permiso: un rol sin `users:manage` (por ejemplo
 * secretaría) no ve la entrada de Usuarios. En pantallas pequeñas queda como
 * banda de iconos y en pantallas grandes se puede colapsar; cada enlace lleva
 * `aria-label` porque en modo colapsado solo se ve el icono.
 */
export const Sidebar = ({ collapsed, onToggle }: SidebarProps) => {
  const { hasPermission } = useAuth();

  const etiquetaVisible = collapsed ? 'hidden' : 'hidden lg:inline';
  const etiquetaBloque = collapsed ? 'hidden' : 'hidden lg:block';

  return (
    <aside
      className={cn(
        // `print:hidden`: al imprimir un reporte (Fase 9) el papel lleva el
        // documento, no el menú.
        'sticky top-0 z-30 flex h-dvh shrink-0 flex-col border-r border-border bg-surface transition-[width] duration-200 print:hidden',
        collapsed ? 'w-16' : 'w-16 lg:w-64',
      )}
    >
      <div className="flex h-14 items-center gap-2 border-b border-border px-3">
        <span className="grid size-8 shrink-0 place-items-center rounded-control bg-primary text-primary-ink">
          <Stethoscope className="size-4" aria-hidden="true" />
        </span>
        <span className={cn('min-w-0 flex-1', etiquetaBloque)}>
          <span className="block truncate text-sm font-semibold text-ink">{t('app.nombre')}</span>
          <span className="block truncate text-xs text-ink-subtle">{t('app.lema')}</span>
        </span>
        <button
          type="button"
          onClick={onToggle}
          aria-label={collapsed ? t('menu.expandir') : t('menu.colapsar')}
          aria-expanded={!collapsed}
          className={cn(
            'hidden shrink-0 rounded-control p-1.5 text-ink-subtle transition-colors hover:bg-surface-muted hover:text-ink lg:inline-flex',
            'focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-solid focus-visible:outline-focus',
            collapsed && 'lg:mx-auto',
          )}
        >
          <PanelLeft className="size-4" aria-hidden="true" />
        </button>
      </div>

      <nav aria-label={t('menu.titulo')} className="min-h-0 flex-1 overflow-y-auto px-2 py-3">
        {NAV_SECTIONS.map((seccion) => {
          const visibles = seccion.modules
            .map((id) => MODULES[id])
            .filter((modulo) => modulo.permission === null || hasPermission(modulo.permission));

          if (visibles.length === 0) return null;

          return (
            <div key={seccion.titleKey} className="mb-4">
              <p
                className={cn(
                  'px-2 pb-1 text-xs font-semibold tracking-wide text-ink-subtle uppercase',
                  etiquetaBloque,
                )}
              >
                {t(seccion.titleKey)}
              </p>
              <ul className="space-y-1">
                {visibles.map((modulo) => {
                  const Icono = modulo.icon;
                  const etiqueta = t(modulo.labelKey);
                  return (
                    <li key={modulo.id}>
                      <NavLink
                        to={modulo.path}
                        title={etiqueta}
                        aria-label={etiqueta}
                        className={({ isActive }) =>
                          cn(
                            'flex items-center gap-2.5 rounded-control px-2 py-2 text-sm font-medium transition-colors',
                            'focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-solid focus-visible:outline-focus',
                            'justify-center lg:justify-start',
                            isActive
                              ? 'bg-primary/10 text-primary'
                              : 'text-ink-muted hover:bg-surface-muted hover:text-ink',
                          )
                        }
                      >
                        <Icono className="size-4 shrink-0" aria-hidden="true" />
                        <span className={cn('truncate', etiquetaVisible)}>{etiqueta}</span>
                      </NavLink>
                    </li>
                  );
                })}
              </ul>
            </div>
          );
        })}
      </nav>
    </aside>
  );
};
