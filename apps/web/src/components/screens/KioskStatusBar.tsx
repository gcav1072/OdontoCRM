import { cn } from '@odontocrm/ui';
import { Wifi, WifiOff } from 'lucide-react';

import { formatTime } from '../../lib/format';
import { t } from '../../lib/i18n';

/**
 * Indicador de conexión de una pantalla kiosko.
 *
 * Una pantalla que se queda muda es el peor fallo posible (el paciente cree que
 * no lo han llamado), así que aquí se dice claramente si el flujo está abierto y
 * a qué hora llegó el último estado. Todo va **discreto y en la esquina**: un icono
 * (verde o ámbar) y la hora de la última actualización. El texto del estado no se
 * pinta —molestaría en una TV—, pero sigue disponible para lectores de pantalla.
 */
export interface KioskStatusBarProps {
  /** El flujo SSE está abierto. */
  conectada: boolean;
  /** `updatedAt` del último estado recibido. */
  actualizado: string | null;
  className?: string;
}

export const KioskStatusBar = ({ conectada, actualizado, className }: KioskStatusBarProps) => {
  const estado = conectada ? t('pantalla.reconectada') : t('pantalla.desconectada');
  const hora = actualizado === null ? null : formatTime(actualizado);

  return (
    <span
      className={cn(
        'inline-flex items-center gap-2 text-sm',
        conectada ? 'text-[var(--kiosk-ok)]' : 'text-[var(--kiosk-warn)]',
        className,
      )}
      title={hora === null ? estado : `${estado} · ${t('pantalla.actualizado', { hora })}`}
      aria-label={hora === null ? estado : `${estado}. ${t('pantalla.actualizado', { hora })}`}
    >
      {conectada ? (
        <Wifi className="size-4" aria-hidden="true" />
      ) : (
        <WifiOff className="size-4" aria-hidden="true" />
      )}
      {hora !== null && <span className="tabular-nums">{hora}</span>}
    </span>
  );
};
