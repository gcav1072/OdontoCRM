import { cn } from '@odontocrm/ui';
import { Wifi, WifiOff } from 'lucide-react';

import { formatTime } from '../../lib/format';
import { t } from '../../lib/i18n';

/**
 * Indicador de conexión de una pantalla kiosko.
 *
 * Una pantalla que se queda muda es el peor fallo posible (el paciente cree que
 * no lo han llamado), así que aquí se dice claramente si el flujo está abierto y
 * a qué hora llegó el último estado. Es informativo y no interactivo: nadie va a
 * pulsarlo desde el televisor.
 */
export interface KioskStatusBarProps {
  /** El flujo SSE está abierto. */
  conectada: boolean;
  /** `updatedAt` del último estado recibido. */
  actualizado: string | null;
  className?: string;
}

export const KioskStatusBar = ({ conectada, actualizado, className }: KioskStatusBarProps) => (
  <div className={cn('flex flex-wrap items-center gap-x-4 gap-y-1 text-sm', className)}>
    <span
      className={cn(
        'inline-flex items-center gap-1.5 font-medium',
        conectada ? 'text-emerald-300' : 'text-amber-300',
      )}
    >
      {conectada ? (
        <Wifi className="size-4" aria-hidden="true" />
      ) : (
        <WifiOff className="size-4" aria-hidden="true" />
      )}
      {conectada ? t('pantalla.reconectada') : t('pantalla.desconectada')}
    </span>

    {actualizado !== null && (
      <span className="text-slate-400">
        {t('pantalla.actualizado', { hora: formatTime(actualizado) })}
      </span>
    )}
  </div>
);
