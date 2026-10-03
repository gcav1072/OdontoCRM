import type { AppointmentStatus } from '@odontocrm/contracts';
import { Badge } from '@odontocrm/ui';

import { APPOINTMENT_STATUS_LABELS } from '../../lib/i18n';
import { statusBadgeVariant } from '../../lib/scheduling';

export interface AppointmentStatusBadgeProps {
  status: AppointmentStatus;
  dot?: boolean;
  className?: string;
}

/** Estado de una solicitud o cita, con el color de la variante del sistema de diseño. */
export const AppointmentStatusBadge = ({
  status,
  dot = true,
  className,
}: AppointmentStatusBadgeProps) => (
  <Badge variant={statusBadgeVariant(status)} dot={dot} className={className}>
    {APPOINTMENT_STATUS_LABELS[status]}
  </Badge>
);
