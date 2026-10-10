import { cn } from '@odontocrm/ui';
import { PanelLeft, Stethoscope } from 'lucide-react';
import { NavLink } from 'react-router-dom';

import { t } from '../../lib/i18n';
import { MODULES, NAV_SECTIONS } from '../../lib/nav';
import { useAuth } from '../../providers/AuthProvider';

export interface SidebarNavProps {
  /**
   * Colapsado → solo iconos (el raíl de escritorio estrecho). En el cajón móvil va
   * siempre expandido, así que allí las etiquetas se ven enteras.
   */
  collapsed: boolean;
  /** Se llama al pulsar un enlace: el cajón móvil lo usa para cerrarse solo. */
  onNavigate?: (() => void) | undefined;
  className?: string;
}

/**
 * Lista de navegación (secciones + enlaces), **compartida** por el raíl de escritorio
 * y por el cajón móvil.
 *
 * El menú se filtra por permiso: un rol sin `users:manage` (por ejemplo secretaría) no
 * ve la entrada de Usuarios. Cada enlace lleva `aria-label` porque en modo colapsado
 * solo se ve el icono.
 */
export const SidebarNav = ({ collapsed, onNavigate, className }: SidebarNavProps) => {
  const { hasPermission } = useAuth();
  const etiquetaOculta = collapsed ? 'hidden' : '';

  return (
    <nav
      aria-label={t('menu.titulo')}
      // `pb-16`: el panel inferior ocultable es fijo y de ancho completo, así que
      // sin este relleno el último módulo queda tapado por la pestaña «Abrir el
      // panel de sesión» y no hay forma de alcanzarlo. Con el panel desplegado el
      // `Sidebar` amplía este relleno (`className`) para dejar sitio a su cuerpo.
      className={cn('min-h-0 flex-1 overflow-y-auto px-2 pt-3 pb-16', className)}
    >
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
                etiquetaOculta,
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
                      onClick={onNavigate}
                      className={({ isActive }) =>
                        cn(
                          'flex items-center gap-2.5 rounded-control px-2 py-2 text-sm font-medium transition-colors',
                          'focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-solid focus-visible:outline-focus',
                          collapsed ? 'justify-center' : 'justify-start',
                          isActive
                            ? 'bg-primary/10 text-primary'
                            : 'text-ink-muted hover:bg-surface-muted hover:text-ink',
                        )
                      }
                    >
                      <Icono className="size-4 shrink-0" aria-hidden="true" />
                      <span className={cn('truncate', etiquetaOculta)}>{etiqueta}</span>
                    </NavLink>
                  </li>
                );
              })}
            </ul>
          </div>
        );
      })}
    </nav>
  );
};

export interface SidebarProps {
  collapsed: boolean;
  onToggle: () => void;
  /** El panel de sesión está desplegado: hay que reservar su altura al pie del menú. */
  panelAbierto: boolean;
}

/**
 * Navegación lateral de **escritorio**.
 *
 * En pantallas pequeñas el raíl desaparece (`hidden lg:flex`): allí navega el cajón
 * ([`MobileNav`](./MobileNav.tsx), `lg:hidden`), que muestra las etiquetas completas.
 * En escritorio se puede colapsar a una banda de iconos; cada enlace lleva `aria-label`
 * para ese modo.
 *
 * Con el panel de sesión abierto el menú se desplaza por encima de él (`pb-[20rem]`,
 * la misma reserva que el contenido usa en `lg`) en vez de quedar debajo.
 */
export const Sidebar = ({ collapsed, onToggle, panelAbierto }: SidebarProps) => (
  <aside
    className={cn(
      // `print:hidden`: al imprimir un reporte el papel lleva el documento, no el menú.
      'sticky top-0 z-30 hidden h-dvh shrink-0 flex-col border-r border-border bg-surface transition-[width] duration-200 lg:flex print:hidden',
      collapsed ? 'w-16' : 'w-64',
    )}
  >
    <div className="flex h-14 items-center gap-2 border-b border-border px-3">
      <span className="grid size-8 shrink-0 place-items-center rounded-control bg-primary text-primary-ink">
        <Stethoscope className="size-4" aria-hidden="true" />
      </span>
      {!collapsed && (
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-semibold text-ink">{t('app.nombre')}</span>
          <span className="block truncate text-xs text-ink-subtle">{t('app.lema')}</span>
        </span>
      )}
      <button
        type="button"
        onClick={onToggle}
        aria-label={collapsed ? t('menu.expandir') : t('menu.colapsar')}
        aria-expanded={!collapsed}
        className={cn(
          'shrink-0 rounded-control p-1.5 text-ink-subtle transition-colors hover:bg-surface-muted hover:text-ink',
          'focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-solid focus-visible:outline-focus',
          collapsed && 'mx-auto',
        )}
      >
        <PanelLeft className="size-4" aria-hidden="true" />
      </button>
    </div>

    {/* Con el panel abierto el relleno crece (tailwind-merge resuelve el conflicto
        con el `pb-16` base): `pb-[20rem]` es la reserva que el contenido ya usa en
        `lg`, el único ancho en el que existe este raíl. */}
    <SidebarNav collapsed={collapsed} className={panelAbierto ? 'pb-[20rem]' : undefined} />
  </aside>
);
