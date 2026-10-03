import { EmptyState } from '@odontocrm/ui';
import { CircleHelp } from 'lucide-react';
import { useLocation } from 'react-router-dom';

import { LinkButton } from '../components/LinkButton';
import { t } from '../lib/i18n';

/** Página 404: cualquier ruta que no exista cae aquí, dentro del shell. */
export const NotFoundPage = () => {
  const location = useLocation();

  return (
    <EmptyState
      icon={<CircleHelp className="size-6" aria-hidden="true" />}
      title={t('noEncontrado.titulo')}
      description={t('noEncontrado.texto', { ruta: location.pathname })}
      action={
        <LinkButton to="/inicio" variant="secondary">
          {t('comun.irAInicio')}
        </LinkButton>
      }
    />
  );
};
