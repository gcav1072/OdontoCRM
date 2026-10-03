import { PERMISSIONS, type Permission, type Role } from '@odontocrm/contracts';
import { Checkbox, cn } from '@odontocrm/ui';
import { CircleCheck } from 'lucide-react';

import { PERMISSION_LABELS, ROLE_LABELS, t } from '../../lib/i18n';

/** Rol del catálogo (`GET /users/roles`) o del respaldo local de los contratos. */
export interface RoleOption {
  name: Role;
  description: string;
  permissions: readonly Permission[];
}

export interface RolePickerProps {
  opciones: readonly RoleOption[];
  seleccionados: readonly Role[];
  onToggle: (rol: Role) => void;
  disabled?: boolean;
  error?: string;
}

/**
 * Selección de roles con sus permisos a la vista: quien asigna un rol tiene que
 * poder ver qué está concediendo sin abrir otra pantalla.
 */
export const RolePicker = ({
  opciones,
  seleccionados,
  onToggle,
  disabled = false,
  error,
}: RolePickerProps) => {
  const permisosEfectivos = PERMISSIONS.filter((permiso) =>
    opciones.some(
      (opcion) => seleccionados.includes(opcion.name) && opcion.permissions.includes(permiso),
    ),
  );

  return (
    <div className="space-y-3">
      <div className="space-y-2">
        {opciones.map((opcion) => {
          const activo = seleccionados.includes(opcion.name);
          return (
            <div
              key={opcion.name}
              className={cn(
                'rounded-control border p-3 transition-colors',
                activo ? 'border-primary/40 bg-primary/5' : 'border-border',
              )}
            >
              <Checkbox
                label={ROLE_LABELS[opcion.name]}
                description={opcion.description}
                checked={activo}
                disabled={disabled}
                onChange={() => onToggle(opcion.name)}
              />
            </div>
          );
        })}
      </div>

      {error && (
        <p role="alert" className="text-xs font-medium text-danger">
          {error}
        </p>
      )}

      <div className="rounded-control border border-border bg-surface-muted/60 p-3">
        <p className="pb-2 text-xs font-semibold tracking-wide text-ink-subtle uppercase">
          {t('usuarios.form.permisos')}
        </p>
        {permisosEfectivos.length === 0 ? (
          <p className="text-xs text-ink-muted">{t('usuarios.form.sinPermisos')}</p>
        ) : (
          <ul className="grid gap-1.5 sm:grid-cols-2">
            {permisosEfectivos.map((permiso) => (
              <li key={permiso} className="flex items-start gap-2 text-xs text-ink-muted">
                <CircleCheck className="mt-0.5 size-3.5 shrink-0 text-success" aria-hidden="true" />
                <span>{PERMISSION_LABELS[permiso]}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
};
