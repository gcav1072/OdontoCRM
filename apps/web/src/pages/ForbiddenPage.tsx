import type { Permission } from '@odontocrm/contracts';
import { EmptyState } from '@odontocrm/ui';
import { ShieldAlert } from 'lucide-react';

import { LinkButton } from '../components/LinkButton';
import { PERMISSION_LABELS, t } from '../lib/i18n';

/**
 * Página 403. Se muestra tanto si el usuario llega por URL a un módulo sin
 * permiso (lo decide `RequirePermission`) como si la propia API responde 403.
 */
export const ForbiddenPage = ({ permission }: { permission?: Permission }) => (
  <EmptyState
    icon={<ShieldAlert className="size-6" aria-hidden="true" />}
    title={t('prohibido.titulo')}
    description={
      permission
        ? t('prohibido.texto', { permiso: PERMISSION_LABELS[permission] })
        : t('prohibido.sinPermiso')
    }
    action={
      <LinkButton to="/inicio" variant="secondary">
        {t('comun.irAInicio')}
      </LinkButton>
    }
  />
);
