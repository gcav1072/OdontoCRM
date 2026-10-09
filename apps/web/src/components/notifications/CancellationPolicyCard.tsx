import { MAX_PATIENT_CANCEL_CUTOFF_DAYS, type NotificationSettings } from '@odontocrm/contracts';
import {
  Alert,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Field,
  Input,
  Spinner,
} from '@odontocrm/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarX2 } from 'lucide-react';
import { useEffect, useState } from 'react';

import { apiErrorMessage } from '../../lib/api';
import { notificationsApi } from '../../lib/endpoints';
import { t } from '../../lib/i18n';
import { notificationKeys } from '../../lib/notifications';

export interface CancellationPolicyCardProps {
  onNotice: (variant: 'success' | 'danger', message: string) => void;
}

/**
 * **Política de cancelación del paciente** (ADR 0057): cuántos días de antelación
 * como mínimo hacen falta para cancelar por el bot una cita que el paciente **ya
 * confirmó**.
 *
 * La tarjeta solo se monta si el usuario tiene `scheduling:cancel_policy` (`admin` y
 * odontólogo); la API exige lo mismo, así que la secretaría recibiría 403. En 0 no hay
 * corte y el paciente cancela como siempre. Las citas sin confirmar se cancelan
 * siempre, con corte o sin él: por eso el texto lo dice.
 */
export const CancellationPolicyCard = ({ onNotice }: CancellationPolicyCardProps) => {
  const cliente = useQueryClient();
  const [valor, setValor] = useState('');

  const ajustesQuery = useQuery({
    queryKey: notificationKeys.settings,
    queryFn: ({ signal }) => notificationsApi.settings(signal),
  });

  // El campo refleja lo que hay guardado; al llegar (o al guardar) se sincroniza.
  useEffect(() => {
    if (ajustesQuery.data !== undefined)
      setValor(String(ajustesQuery.data.patientCancelCutoffDays));
  }, [ajustesQuery.data]);

  const guardar = useMutation({
    mutationFn: (patientCancelCutoffDays: number) =>
      notificationsApi.updateSettings({ patientCancelCutoffDays }),
    onSuccess: (guardado) => {
      cliente.setQueryData<NotificationSettings>(notificationKeys.settings, guardado);
      setValor(String(guardado.patientCancelCutoffDays));
      onNotice('success', t('notificaciones.politica.guardado'));
    },
    onError: (fallo) => onNotice('danger', apiErrorMessage(fallo)),
  });

  const numero = Number(valor);
  const valido =
    valor.trim() !== '' &&
    Number.isInteger(numero) &&
    numero >= 0 &&
    numero <= MAX_PATIENT_CANCEL_CUTOFF_DAYS;
  const actual = ajustesQuery.data?.patientCancelCutoffDays ?? null;
  const sinCambios = actual !== null && valido && numero === actual;

  return (
    <Card>
      <CardHeader>
        <CardTitle as="h2" className="flex items-center gap-2">
          <CalendarX2 className="size-4 text-primary" aria-hidden="true" />
          {t('notificaciones.politica.titulo')}
        </CardTitle>
        <CardDescription>{t('notificaciones.politica.descripcion')}</CardDescription>
      </CardHeader>

      <CardContent className="space-y-4">
        {ajustesQuery.isError ? (
          <Alert variant="danger" title={t('notificaciones.politica.error')}>
            {apiErrorMessage(ajustesQuery.error)}
          </Alert>
        ) : ajustesQuery.isPending ? (
          <Spinner label={t('notificaciones.bot.cargando')} showLabel />
        ) : (
          <>
            <div className="flex flex-wrap items-end gap-3">
              <Field
                label={t('notificaciones.politica.campo')}
                hint={t('notificaciones.politica.ayuda')}
                error={
                  valor.trim() !== '' && !valido ? t('notificaciones.politica.invalido') : undefined
                }
              >
                <Input
                  type="number"
                  min={0}
                  max={MAX_PATIENT_CANCEL_CUTOFF_DAYS}
                  inputMode="numeric"
                  className="max-w-32"
                  value={valor}
                  onChange={(event) => setValor(event.target.value)}
                  disabled={guardar.isPending}
                />
              </Field>

              <Button
                loading={guardar.isPending}
                loadingLabel={t('notificaciones.politica.guardando')}
                disabled={!valido || sinCambios}
                onClick={() => guardar.mutate(numero)}
              >
                {t('notificaciones.politica.guardar')}
              </Button>
            </div>

            <Alert variant={actual === 0 ? 'info' : 'warning'}>
              {actual === 0
                ? t('notificaciones.politica.desactivado')
                : t('notificaciones.politica.activo', { dias: actual ?? 0 })}
            </Alert>
          </>
        )}
      </CardContent>
    </Card>
  );
};
