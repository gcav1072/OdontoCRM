import type { AppointmentSummary } from '@odontocrm/contracts';
import { useMutation } from '@tanstack/react-query';
import { Alert, Button, Dialog, Field, Input } from '@odontocrm/ui';
import { useState } from 'react';

import { apiErrorMessage } from '../../lib/api';
import { appointmentsApi } from '../../lib/endpoints';
import { t } from '../../lib/i18n';
import { CODIGO_INASISTENCIA_PRONTO, codigoDeProblema } from './acciones';

export interface NoShowDialogProps {
  appointment: AppointmentSummary;
  onClose: () => void;
  onDone: (appointment: AppointmentSummary) => void;
}

/**
 * Inasistencia, con motivo opcional. La tolerancia la aplica el servidor (hora
 * de la cita + 15 minutos) y también la fila, que no ofrece la acción antes de
 * tiempo; si el rechazo llega igualmente (el reloj del equipo iba adelantado, por
 * ejemplo) se muestra su `detail` sin traducir, que ya dice cuánto falta.
 */
export const NoShowDialog = ({ appointment, onClose, onDone }: NoShowDialogProps) => {
  const [motivo, setMotivo] = useState('');
  const [errorGeneral, setErrorGeneral] = useState<string | null>(null);
  const [muyPronto, setMuyPronto] = useState(false);

  const marcarNoAsistio = useMutation({
    mutationFn: () => {
      const recortado = motivo.trim();
      return appointmentsApi.noShow(appointment.id, recortado === '' ? {} : { reason: recortado });
    },
  });

  const confirmar = async () => {
    setErrorGeneral(null);
    setMuyPronto(false);
    try {
      onDone(await marcarNoAsistio.mutateAsync());
    } catch (fallo) {
      setMuyPronto(codigoDeProblema(fallo) === CODIGO_INASISTENCIA_PRONTO);
      setErrorGeneral(apiErrorMessage(fallo));
    }
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title={t('secretaria.noAsistio.titulo')}
      description={t('secretaria.noAsistio.texto', { paciente: appointment.patientName })}
      dismissOnBackdrop={false}
      closeLabel={t('comun.cerrar')}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={marcarNoAsistio.isPending}>
            {t('comun.cancelar')}
          </Button>
          <Button
            variant="danger"
            onClick={() => {
              void confirmar();
            }}
            loading={marcarNoAsistio.isPending}
            loadingLabel={t('comun.guardando')}
          >
            {t('secretaria.noAsistio.confirmar')}
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

        {muyPronto && <Alert variant="warning">{t('secretaria.noAsistio.muyPronto')}</Alert>}

        <Field label={t('secretaria.noAsistio.motivo')}>
          <Input
            autoComplete="off"
            value={motivo}
            onChange={(event) => setMotivo(event.target.value)}
          />
        </Field>
      </div>
    </Dialog>
  );
};
