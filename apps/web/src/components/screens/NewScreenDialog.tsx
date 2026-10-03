import type { DeviceTokenCreated } from '@odontocrm/contracts';
import { deviceTokenSchema } from '@odontocrm/contracts';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Alert, Button, Dialog, Field, Input, Select } from '@odontocrm/ui';
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import type { z } from 'zod';

import { apiErrorMessage, isApiError } from '../../lib/api';
import { devicesApi, screensApi } from '../../lib/endpoints';
import { applyApiFieldErrors } from '../../lib/forms';
import { t } from '../../lib/i18n';
import { screenKeys } from '../../lib/screens';

/**
 * Esquema del formulario: el mismo que valida el servidor al emitir el token
 * (`deviceTokenSchema`), así que la longitud del nombre y los tipos válidos son
 * idénticos en las dos partes y aquí no hay reglas duplicadas. Solo se usa para
 * deducir los tipos (la validación la aplica el servidor), de ahí el `_`.
 */
const _esquemaPantalla = deviceTokenSchema;

type ValoresFormulario = z.input<typeof _esquemaPantalla>;
type ValoresEnviados = z.output<typeof _esquemaPantalla>;

export interface NewScreenDialogProps {
  open: boolean;
  onClose: () => void;
  /** Alta terminada: la página abre el diálogo del enlace (el token se ve una vez). */
  onCreated: (registro: { label: string; token: DeviceTokenCreated }) => void;
}

/**
 * Alta de una pantalla: **dos pasos** que no se pueden separar.
 *
 * 1. `POST /devices` (identity) emite el token de dispositivo, que se devuelve
 *    una sola vez;
 * 2. `POST /screens/devices` (screens) registra la pantalla con el id de ese
 *    token.
 *
 * Si el paso 2 falla, se **revoca** el token recién creado antes de mostrar el
 * error: si no, quedaría un token huérfano que nadie puede ver ni usar (y que
 * seguiría sirviendo para entrar como pantalla).
 */
export const NewScreenDialog = ({ open, onClose, onCreated }: NewScreenDialogProps) => {
  const cliente = useQueryClient();
  const [errorGeneral, setErrorGeneral] = useState<string | null>(null);

  const formulario = useForm<ValoresFormulario, unknown, ValoresEnviados>({
    defaultValues: { label: '', kind: 'lobby' },
  });

  const { reset } = formulario;
  useEffect(() => {
    if (!open) return;
    setErrorGeneral(null);
    reset({ label: '', kind: 'lobby' });
  }, [open, reset]);

  const crear = useMutation({
    mutationFn: async (
      valores: ValoresEnviados,
    ): Promise<{ label: string; token: DeviceTokenCreated }> => {
      const token = await devicesApi.create({ label: valores.label, kind: valores.kind });
      try {
        await screensApi.createDevice({
          label: valores.label,
          kind: valores.kind,
          tokenId: token.id,
        });
      } catch (fallo) {
        // El token ya no sirve para nada: se revoca antes de propagar el error.
        await devicesApi.revoke(token.id).catch(() => undefined);
        throw fallo;
      }
      return { label: valores.label, token };
    },
  });

  const enviar = async (valores: ValoresEnviados) => {
    setErrorGeneral(null);
    try {
      const registro = await crear.mutateAsync(valores);
      void cliente.invalidateQueries({ queryKey: screenKeys.devices });
      void cliente.invalidateQueries({ queryKey: screenKeys.conectadas });
      onClose();
      onCreated(registro);
    } catch (fallo) {
      // El nombre es lo único que puede venir señalado por campo; el resto de
      // fallos (red, token revocado a medias) van como aviso general.
      if (!isApiError(fallo) || !applyApiFieldErrors(formulario.setError, fallo)) {
        setErrorGeneral(apiErrorMessage(fallo));
      }
    }
  };

  const { errors, isSubmitting } = formulario.formState;

  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="md"
      title={t('pantallas.nuevaTitulo')}
      description={t('pantallas.nuevaTexto')}
      dismissOnBackdrop={false}
      closeLabel={t('comun.cerrar')}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={isSubmitting}>
            {t('comun.cancelar')}
          </Button>
          <Button
            type="submit"
            form="formulario-nueva-pantalla"
            loading={isSubmitting}
            loadingLabel={t('pantallas.creando')}
          >
            {t('pantallas.crear')}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {errorGeneral && (
          <Alert variant="danger" title={t('pantallas.errorCrear')}>
            {errorGeneral}
          </Alert>
        )}

        <form
          id="formulario-nueva-pantalla"
          noValidate
          className="space-y-4"
          onSubmit={(event) => {
            void formulario.handleSubmit(enviar)(event);
          }}
        >
          <Field label={t('pantallas.nombre')} error={errors.label?.message} required>
            <Input
              autoComplete="off"
              placeholder={t('pantallas.nombrePlaceholder')}
              {...formulario.register('label')}
            />
          </Field>

          <Field label={t('pantallas.tipo')} error={errors.kind?.message} required>
            <Select {...formulario.register('kind')}>
              <option value="lobby">{t('pantallas.tipo.lobby')}</option>
              <option value="consultorio">{t('pantallas.tipo.consultorio')}</option>
            </Select>
          </Field>
        </form>
      </div>
    </Dialog>
  );
};
