import { Spinner } from '@odontocrm/ui';

import { t } from '../lib/i18n';

/** Pantalla de espera a tamaño completo (restauración de sesión, carga inicial). */
export const FullScreenLoader = ({ label }: { label?: string }) => (
  <div className="grid min-h-dvh place-items-center bg-canvas px-4">
    <Spinner size="lg" label={label ?? t('comun.cargando')} showLabel />
  </div>
);
