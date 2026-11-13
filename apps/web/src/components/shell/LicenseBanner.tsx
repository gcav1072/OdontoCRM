import type { PublicLicensingView } from '@odontocrm/contracts';
import { cn } from '@odontocrm/ui';
import { useQuery } from '@tanstack/react-query';
import { KeyRound, ShieldAlert, TriangleAlert } from 'lucide-react';

import { licensingApi } from '../../lib/endpoints';
import { t } from '../../lib/i18n';
import { bannerDeLicencia, licensingKeys, type BannerTono } from '../../lib/licensing';
import { useOptionalAuth } from '../../providers/AuthProvider';

/** Clases del aviso por tono. El rojo repite el del banner de MODO TEST. */
const CLASES: Readonly<Record<BannerTono, string>> = {
  info: 'border-info/40 bg-info/10 text-info',
  warning: 'border-warning/50 bg-warning/10 text-warning',
  danger: 'border-danger-strong bg-danger-strong text-danger-strong-ink',
};

const ICONOS: Readonly<Record<BannerTono, typeof KeyRound>> = {
  info: KeyRound,
  warning: TriangleAlert,
  danger: ShieldAlert,
};

export interface LicenseBannerProps {
  /** Estado público de la licencia; `undefined` mientras se consulta o si falló. */
  vista: PublicLicensingView | undefined;
  /**
   * `true` cuando quien mira puede entrar a `/licencia` (el administrador). Sin
   * sesión —el banner también se ve en el login— no hay enlace a la página.
   */
  puedeActivar?: boolean;
}

/**
 * Banner del **licenciamiento offline** ([ADR 0075](../../../docs/adr/0075-licenciamiento-offline-y-modo-consulta.md)).
 *
 * Mismo papel que el banner de MODO TEST: se monta **fuera de las rutas** para que se
 * vea en el login y en las pantallas kiosko, y no ocupa ni un píxel cuando la licencia
 * está vigente (no hay nada que avisar). Con el sistema en modo consulta, en cambio,
 * queda pegado arriba: es la explicación de por qué los botones de escritura
 * desaparecieron.
 *
 * El enlace a `/licencia` es un `<a>` normal, no un `Link`: el banner también vive
 * fuera del shell (login y kiosko) y, en esos casos, una recarga es exactamente lo que
 * se quiere para volver a leer el estado y los permisos.
 */
export const LicenseBanner = ({ vista, puedeActivar = false }: LicenseBannerProps) => {
  const aviso = bannerDeLicencia(vista);
  if (aviso === null) return null;

  const Icono = ICONOS[aviso.tono];
  const enModoConsulta = aviso.tono === 'danger';

  return (
    <div
      role={enModoConsulta ? 'alert' : 'status'}
      aria-live="polite"
      data-testid="banner-licencia"
      className={cn(
        'flex flex-wrap items-center justify-center gap-x-3 gap-y-1 border-b-2 px-3 py-1.5 text-center text-sm font-semibold print:hidden',
        CLASES[aviso.tono],
        // Solo el aviso rojo se queda fijo: los informativos acompañan arriba de la
        // página y no deben taparle contenido a nadie.
        enModoConsulta && 'sticky top-0 z-40',
      )}
    >
      <span className="inline-flex items-center gap-2">
        <Icono aria-hidden="true" className="size-4 shrink-0" />
        {aviso.titulo}
      </span>
      <span className="font-normal">{aviso.detalle}</span>
      {puedeActivar ? (
        <a
          href="/licencia"
          className="rounded-control font-semibold underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-solid focus-visible:outline-current"
        >
          {enModoConsulta ? t('licencia.banner.activar') : t('licencia.banner.ver')}
        </a>
      ) : (
        enModoConsulta && (
          <span className="font-normal opacity-90">{t('licencia.banner.pideAdmin')}</span>
        )
      )}
    </div>
  );
};

/**
 * Banner conectado al servidor: consulta el estado **público** (sin sesión) para que
 * también se vea en la pantalla de acceso. Un fallo no pinta nada: el aviso de conexión
 * ya lo da la pantalla que corresponda y un «licencia vencida» inventado asustaría de
 * más. El estado se refresca al volver a la pestaña y, tras activar, la página
 * invalida esta consulta.
 */
export const LicenseBannerLive = () => {
  const consulta = useQuery({
    queryKey: licensingKeys.publico,
    queryFn: ({ signal }) => licensingApi.public(signal),
    staleTime: 60_000,
    retry: false,
  });
  const sesion = useOptionalAuth();
  const puedeActivar = sesion?.hasPermission('licensing:manage') ?? false;

  return <LicenseBanner vista={consulta.data} puedeActivar={puedeActivar} />;
};
