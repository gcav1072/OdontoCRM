import type { SystemMeta } from '@odontocrm/contracts';
import { useQuery } from '@tanstack/react-query';
import { FlaskConical } from 'lucide-react';

import { t } from '../../lib/i18n';
import { fetchSystemMeta, SYSTEM_META_QUERY_KEY } from '../../lib/system';

export interface TestModeBannerProps {
  /** Estado del sistema; `undefined` mientras se consulta (no se pinta nada). */
  meta: SystemMeta | undefined;
}

/**
 * Banner de **MODO TEST** (ADR 0020): rojo, pegado arriba y visible en toda la
 * aplicación —incluida la pantalla de acceso y las pantallas kiosko—, porque lo
 * que anuncia es que **esta instalación no sirve para pacientes reales**.
 *
 * Se pinta a partir del estado que publica el gateway (`/api/v1/meta`), y si el
 * servicio dice que el modo test está apagado no ocupa ni un píxel. En papel
 * (`print:hidden`) no sale: los documentos ya llevan su propia marca.
 */
export const TestModeBanner = ({ meta }: TestModeBannerProps) => {
  if (meta === undefined || !meta.testMode.enabled) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="banner-modo-test"
      className="sticky top-0 z-50 flex flex-wrap items-center justify-center gap-x-3 gap-y-1 border-b-2 border-danger-strong bg-danger-strong px-3 py-1.5 text-center text-sm font-semibold text-danger-strong-ink print:hidden"
    >
      <span className="inline-flex items-center gap-2">
        <FlaskConical aria-hidden="true" className="size-4 shrink-0" />
        {t('modoTest.titulo')}
      </span>
      <span className="font-normal">{t('modoTest.detalle')}</span>
      <span className="font-normal opacity-90">
        {t('modoTest.semilla', { semilla: meta.fixtures.seed })}
      </span>
    </div>
  );
};

/**
 * Banner conectado al servidor: consulta el estado una vez y lo mantiene. Un
 * fallo (gateway apagado) **no** pinta nada: el aviso de conexión ya lo da la
 * pantalla que corresponda y un banner rojo inventado asustaría de más.
 */
export const TestModeBannerLive = () => {
  const metaQuery = useQuery({
    queryKey: SYSTEM_META_QUERY_KEY,
    queryFn: ({ signal }) => fetchSystemMeta(signal),
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
  });

  return <TestModeBanner meta={metaQuery.data} />;
};
