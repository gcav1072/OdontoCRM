import type { AppointmentSummary } from '@odontocrm/contracts';
import { useMutation } from '@tanstack/react-query';
import { Alert, Button, Dialog } from '@odontocrm/ui';
import { useState } from 'react';

import { apiErrorMessage } from '../../lib/api';
import { appointmentsApi } from '../../lib/endpoints';
import { t } from '../../lib/i18n';

export interface EmergencyCallDialogProps {
  appointment: AppointmentSummary;
  onClose: () => void;
  /** Cita tras la llegada y cita tras el llamado, en ese orden. */
  onCalled: (checkedIn: AppointmentSummary, called: AppointmentSummary) => void;
}

/**
 * Llamado fuera de orden. La máquina de estados no permite `call` desde
 * «programada» ni «notificada», así que se encadenan las dos transiciones que sí
 * permite desde ahí: primero `check-in` y después `call`.
 *
 * Van en dos peticiones, y no en una, porque el historial de la cita tiene que
 * guardar las dos transiciones con su actor y su hora: el paciente llegó y se le
 * llamó, aunque no le tocara por orden de agenda.
 */
export const EmergencyCallDialog = ({
  appointment,
  onClose,
  onCalled,
}: EmergencyCallDialogProps) => {
  const [errorGeneral, setErrorGeneral] = useState<string | null>(null);

  const llamar = useMutation({
    mutationFn: async () => {
      const enSala = await appointmentsApi.checkIn(appointment.id);
      const llamado = await appointmentsApi.call(appointment.id);
      return { enSala, llamado };
    },
  });

  const confirmar = async () => {
    setErrorGeneral(null);
    try {
      const { enSala, llamado } = await llamar.mutateAsync();
      onCalled(enSala, llamado);
    } catch (fallo) {
      // El `detail` del servidor explica cuál de los dos pasos falló y por qué.
      setErrorGeneral(apiErrorMessage(fallo));
    }
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title={t('secretaria.emergencia.titulo')}
      description={t('secretaria.emergencia.texto', { paciente: appointment.patientName })}
      dismissOnBackdrop={false}
      closeLabel={t('comun.cerrar')}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={llamar.isPending}>
            {t('comun.cancelar')}
          </Button>
          <Button
            onClick={() => {
              void confirmar();
            }}
            loading={llamar.isPending}
            loadingLabel={t('comun.enviando')}
          >
            {t('secretaria.emergencia.confirmar')}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {errorGeneral !== null && (
          <Alert variant="danger" title={t('secretaria.error.accion')}>
            {errorGeneral}
          </Alert>
        )}

        {/* Se enseña el par de transiciones para que nadie dude de lo que queda
            auditado en la cita al confirmar. */}
        <ol className="list-decimal space-y-1 pl-5 text-sm text-ink-muted">
          <li>{t('secretaria.acciones.checkIn')}</li>
          <li>{t('secretaria.acciones.llamar')}</li>
        </ol>
      </div>
    </Dialog>
  );
};
