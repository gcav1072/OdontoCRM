import { cn } from '@odontocrm/ui';
import { useLocation } from 'react-router-dom';

import { formatInitials } from '../../lib/format';
import { ROLE_LABELS, t } from '../../lib/i18n';
import { moduleForPath } from '../../lib/nav';
import { useAuth } from '../../providers/AuthProvider';

/**
 * Cabecera del área de contenido: nombre del módulo abierto y, a la derecha, el
 * usuario con su rol, para que siempre se sepa con qué cuenta se está
 * trabajando (algo crítico en un mostrador compartido).
 */
export const AppHeader = () => {
  const { user, roles } = useAuth();
  const location = useLocation();
  const modulo = moduleForPath(location.pathname);

  const titulo = modulo ? t(modulo.labelKey) : t('contrasena.titulo');
  const descripcion = modulo ? t(modulo.descriptionKey) : t('contrasena.texto');
  const nombreRoles = roles.map((rol) => ROLE_LABELS[rol]).join(' · ');

  return (
    <header className="sticky top-0 z-20 flex h-14 items-center gap-3 border-b border-border bg-surface/90 px-4 backdrop-blur lg:px-6 print:hidden">
      <div className="min-w-0 flex-1">
        <h1 className="truncate text-base font-semibold text-ink">{titulo}</h1>
        <p className="hidden truncate text-xs text-ink-subtle sm:block">{descripcion}</p>
      </div>

      <div className="flex shrink-0 items-center gap-3">
        <div className="hidden text-right sm:block">
          <p className="max-w-56 truncate text-sm font-medium text-ink">
            {user?.fullName ?? t('comun.sinDato')}
          </p>
          <p className="max-w-56 truncate text-xs text-ink-subtle">{nombreRoles}</p>
        </div>
        <span
          aria-hidden="true"
          className={cn(
            'grid size-9 shrink-0 place-items-center rounded-full bg-primary/10 text-sm font-semibold text-primary',
          )}
        >
          {formatInitials(user?.fullName)}
        </span>
      </div>
    </header>
  );
};
