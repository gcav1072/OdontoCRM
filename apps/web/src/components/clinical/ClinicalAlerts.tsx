import type { ClinicalAlert } from '@odontocrm/contracts';
import { Alert } from '@odontocrm/ui';

import { clinicalAlertLabel, clinicalAlertVariant } from '../../lib/clinical';
import { t } from '../../lib/i18n';

export interface ClinicalAlertsProps {
  alerts: readonly ClinicalAlert[];
  className?: string;
}

/**
 * Validaciones clínicas destacadas: la alergia a la penicilina (o a los
 * anestésicos) se pinta en rojo, y los crónicos y anticoagulantes en ámbar.
 * Son las mismas alertas que la pantalla del consultorio recibe por la ruta
 * interna del servicio clínico.
 */
export const ClinicalAlerts = ({ alerts, className }: ClinicalAlertsProps) => {
  if (alerts.length === 0) return null;

  const prioridad = alerts.some((alert) => clinicalAlertVariant(alert.code) === 'danger')
    ? 'danger'
    : alerts.some((alert) => clinicalAlertVariant(alert.code) === 'warning')
      ? 'warning'
      : 'info';

  return (
    <Alert variant={prioridad} title={t('clinica.alertas.titulo')} className={className}>
      <ul className="flex flex-wrap gap-x-4 gap-y-1">
        {alerts.map((alert) => (
          <li key={`${alert.code}-${alert.detail ?? ''}`} className="font-medium">
            {clinicalAlertLabel(alert)}
          </li>
        ))}
      </ul>
    </Alert>
  );
};
