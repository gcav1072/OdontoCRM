import { MonitorPlay } from 'lucide-react';
import type { ReactNode } from 'react';

import { t } from '../../lib/i18n';

/**
 * Estados de espera de las pantallas kiosko (sin token, sin permiso, cargando,
 * sala vacía). Se pintan a tamaño grande porque se ven de lejos: el personal tiene
 * que entender qué le pasa al televisor sin acercarse.
 *
 * Usa las variables `--kiosk-*`, así que respeta el modo claro/oscuro y el acento de
 * la pantalla (no los de la aplicación).
 */
export interface KioskNoticeProps {
  titulo: string;
  texto?: string;
  /** Acción opcional (reintentar). Sin ella solo se informa. */
  onReintentar?: () => void;
  icono?: ReactNode;
}

export const KioskNotice = ({ titulo, texto, onReintentar, icono }: KioskNoticeProps) => (
  <div
    role="status"
    className="kiosk-aparece mx-auto flex max-w-4xl flex-col items-center gap-4 rounded-card border border-[var(--kiosk-border)] bg-[var(--kiosk-surface)] px-8 py-12 text-center"
  >
    <span className="grid size-14 place-items-center rounded-full bg-[var(--kiosk-accent-soft)] text-[var(--kiosk-accent)]">
      {icono ?? <MonitorPlay className="size-7" aria-hidden="true" />}
    </span>
    <h2 className="text-3xl font-semibold text-[var(--kiosk-ink)]">{titulo}</h2>
    {texto !== undefined && texto !== '' && (
      <p className="max-w-2xl text-lg text-[var(--kiosk-ink-muted)]">{texto}</p>
    )}
    {onReintentar !== undefined && (
      <button
        type="button"
        onClick={onReintentar}
        className="rounded-control border border-[var(--kiosk-accent)] px-4 py-2 font-semibold text-[var(--kiosk-accent)] transition-colors hover:bg-[var(--kiosk-accent-soft)]"
      >
        {t('comun.reintentar')}
      </button>
    )}
  </div>
);
