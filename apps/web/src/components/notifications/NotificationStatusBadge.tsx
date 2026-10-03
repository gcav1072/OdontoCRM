import type { NotificationRecord, NotificationStatus } from '@odontocrm/contracts';
import { Badge } from '@odontocrm/ui';

import { NOTIFICATION_STATUS_LABELS, NOTIFICATION_STATUS_VARIANTS, t } from '../../lib/i18n';

export interface NotificationStatusBadgeProps {
  status: NotificationStatus;
  dot?: boolean;
}

/** Estado del envío con su color y, cuando toca, la aclaración del aviso manual. */
export const NotificationStatusBadge = ({ status, dot = true }: NotificationStatusBadgeProps) => (
  <Badge
    variant={NOTIFICATION_STATUS_VARIANTS[status]}
    dot={dot}
    title={status === 'skipped_no_channel' ? t('notificaciones.estado.avisoManual') : undefined}
  >
    {NOTIFICATION_STATUS_LABELS[status]}
  </Badge>
);

/** ¿El envío se puede devolver a la cola del bot? */
export const canRetryNotification = (record: NotificationRecord): boolean =>
  record.status === 'failed' || record.status === 'skipped_no_channel';

/** ¿Falta el aviso manual por teléfono? */
export const needsManualContact = (record: NotificationRecord): boolean =>
  record.status === 'skipped_no_channel' && record.contactedAt === null;
