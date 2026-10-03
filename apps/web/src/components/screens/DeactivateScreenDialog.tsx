import type { ScreenDevice } from '@odontocrm/contracts';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Alert, Button, Dialog } from '@odontocrm/ui';
import { useEffect, useState } from 'react';

import { apiErrorMessage } from '../../lib/api';
import { devicesApi, screensApi } from '../../lib/endpoints';
import { t } from '../../lib/i18n';
import { screenKeys } from '../../lib/screens';

export interface DeactivateScreenDialogProps {
  /** `null` cierra el diálogo. */
  pantalla: ScreenDevice | null;
  onClose: () => void;
  onDone: (mensaje: string, nombre: string) => void;
}

/**
 * Desactivar una pantalla: se quita de la sala (`DELETE /screens/devices/:id`)
 * y, si todavía tiene token de dispositivo, se **revoca** en identity. Son dos
 * pasos a propósito: si el token siguiera vivo, la pantalla desactivada podría
 * volver a pedir un JWT y quedarse con la conexión abierta.
 */
export const DeactivateScreenDialog = ({
  pantalla,
  onClose,
  onDone,
}: DeactivateScreenDialogProps) => {
  const cliente = useQueryClient();
  const [errorGeneral, setErrorGeneral] = useState<string | null>(null);

  useEffect(() => {
    if (pantalla !== null) setErrorGeneral(null);
  }, [pantalla]);

  const desactivar = useMutation({
    mutationFn: async (objetivo: ScreenDevice) => {
      await screensApi.deleteDevice(objetivo.id);
      // `tokenId` puede ser `null` en pantallas registradas antes del cambio de
      // emisión de tokens: en ese caso no hay nada que revocar.
      if (objetivo.tokenId !== null) await devicesApi.revoke(objetivo.tokenId);
      return objetivo.label;
    },
  });

  const confirmar = async () => {
    if (pantalla === null) return;
    setErrorGeneral(null);
    const nombre = pantalla.label;
    try {
      await desactivar.mutateAsync(pantalla);
      void cliente.invalidateQueries({ queryKey: screenKeys.devices });
      void cliente.invalidateQueries({ queryKey: screenKeys.conectadas });
      onClose();
      onDone(t('pantallas.desactivada'), nombre);
    } catch (fallo) {
      setErrorGeneral(apiErrorMessage(fallo));
    }
  };

  return (
    <Dialog
      open={pantalla !== null}
      onClose={onClose}
      size="sm"
      title={t('pantallas.desactivar.titulo', { pantalla: pantalla?.label ?? '' })}
      dismissOnBackdrop={false}
      closeLabel={t('comun.cerrar')}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={desactivar.isPending}>
            {t('comun.cancelar')}
          </Button>
          <Button variant="danger" loading={desactivar.isPending} onClick={() => void confirmar()}>
            {t('pantallas.desactivar.confirmar')}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {errorGeneral && (
          <Alert variant="danger" title={t('pantallas.errorAccion')}>
            {errorGeneral}
          </Alert>
        )}
        <Alert variant="warning">{t('pantallas.desactivar.texto')}</Alert>
      </div>
    </Dialog>
  );
};
