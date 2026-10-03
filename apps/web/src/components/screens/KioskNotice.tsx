import { Button } from '@odontocrm/ui';
import { MonitorPlay } from 'lucide-react';
import type { ReactNode } from 'react';

import { t } from '../../lib/i18n';

/**
 * Estados de espera de las pantallas kiosko (sin token, sin permiso, cargando,
 * sala vacía). Se pintan en oscuro y a tamaño grande porque se ven de lejos: el
 * personal tiene que entender qué le pasa al televisor sin acercarse.
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
    className="mx-auto flex max-w-4xl flex-col items-center gap-4 rounded-card border border-slate-700 bg-slate-900/60 px-8 py-12 text-center"
  >
    <span className="grid size-14 place-items-center rounded-full bg-sky-500/10 text-sky-300">
      {icono ?? <MonitorPlay className="size-7" aria-hidden="true" />}
    </span>
    <h2 className="text-3xl font-semibold text-white">{titulo}</h2>
    {texto !== undefined && texto !== '' && (
      <p className="max-w-2xl text-lg text-slate-300">{texto}</p>
    )}
    {onReintentar !== undefined && (
      <Button variant="secondary" onClick={onReintentar}>
        {t('comun.reintentar')}
      </Button>
    )}
  </div>
);
