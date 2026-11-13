import {
  MAX_REMINDER_DAYS_BEFORE,
  REMINDER_SEND_HOUR_MAX,
  REMINDER_SEND_HOUR_MIN,
  type NotificationSettings,
  type NotificationSettingsInput,
} from '@odontocrm/contracts';
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
  Select,
  Spinner,
  Switch,
} from '@odontocrm/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BellRing } from 'lucide-react';
import { useEffect, useState } from 'react';

import { apiErrorMessage } from '../../lib/api';
import { notificationsApi } from '../../lib/endpoints';
import { t } from '../../lib/i18n';
import {
  notificationKeys,
  reminderHourOptions,
  reminderHourText,
  reminderPolicyChanges,
  reminderPolicyFrom,
  reminderPolicyIsValid,
  reminderPolicySummary,
  type ReminderPolicyDraft,
} from '../../lib/notifications';

export interface ReminderPolicyCardProps {
  onNotice: (variant: 'success' | 'danger', message: string) => void;
}

/**
 * **Recordatorios automáticos de citas** (v1.2), en el panel del `admin`.
 *
 * Comparte el `GET/PATCH /notifications/settings` con la política de cancelación
 * (ADR 0057): cada tarjeta edita su parte y el `PATCH` es **parcial**, así que
 * guardar aquí no reescribe el corte de cancelación ni al revés. Los días en 0
 * apagan los recordatorios; la hora es la local del consultorio y el resumen vivo
 * va diciendo, mientras se edita, qué se enviará y cuándo.
 */
export const ReminderPolicyCard = ({ onNotice }: ReminderPolicyCardProps) => {
  const cliente = useQueryClient();
  /** Lo que hay guardado en el servidor; con esto se calcula el `PATCH` parcial. */
  const [guardado, setGuardado] = useState<ReminderPolicyDraft | null>(null);
  const [dias, setDias] = useState('');
  const [hora, setHora] = useState(String(REMINDER_SEND_HOUR_MIN));
  const [incluirConfirmadas, setIncluirConfirmadas] = useState(false);
  const [autoDocumentos, setAutoDocumentos] = useState(false);

  const ajustesQuery = useQuery({
    queryKey: notificationKeys.settings,
    queryFn: ({ signal }) => notificationsApi.settings(signal),
  });

  // El formulario refleja lo guardado; al llegar (o al guardar) se sincroniza.
  useEffect(() => {
    if (ajustesQuery.data === undefined) return;
    const politica = reminderPolicyFrom(ajustesQuery.data);
    setGuardado(politica);
    setDias(String(politica.daysBefore));
    setHora(String(politica.sendHour));
    setIncluirConfirmadas(politica.includeConfirmed);
    setAutoDocumentos(politica.autoSendDocuments);
  }, [ajustesQuery.data]);

  const numeroDias = Number(dias);
  const diasValido =
    dias.trim() !== '' &&
    Number.isInteger(numeroDias) &&
    numeroDias >= 0 &&
    numeroDias <= MAX_REMINDER_DAYS_BEFORE;
  const numeroHora = Number(hora);
  const horaValida =
    Number.isInteger(numeroHora) &&
    numeroHora >= REMINDER_SEND_HOUR_MIN &&
    numeroHora <= REMINDER_SEND_HOUR_MAX;

  // El borrador usa lo tecleado si es válido; si no, lo guardado (así el resumen
  // nunca miente mientras el campo tiene un valor a medio escribir).
  const borrador: ReminderPolicyDraft = {
    daysBefore: diasValido ? numeroDias : (guardado?.daysBefore ?? 0),
    sendHour: horaValida ? numeroHora : (guardado?.sendHour ?? REMINDER_SEND_HOUR_MIN),
    includeConfirmed: incluirConfirmadas,
    autoSendDocuments: autoDocumentos,
  };
  const cambios: NotificationSettingsInput =
    guardado === null ? {} : reminderPolicyChanges(guardado, borrador);
  const hayCambios = Object.keys(cambios).length > 0;
  const resumen = reminderPolicySummary(borrador);

  const guardar = useMutation({
    mutationFn: (entrada: NotificationSettingsInput) => notificationsApi.updateSettings(entrada),
    onSuccess: (respuesta) => {
      // Las dos tarjetas comparten la misma consulta (`notificationKeys.settings`):
      // el `setQueryData` deja la una y la otra sincronizadas con lo guardado.
      cliente.setQueryData<NotificationSettings>(notificationKeys.settings, respuesta);
      onNotice('success', t('notificaciones.recordatorios.guardado'));
    },
    onError: (fallo) => onNotice('danger', apiErrorMessage(fallo)),
  });

  const puedeGuardar =
    guardado !== null &&
    diasValido &&
    horaValida &&
    reminderPolicyIsValid(borrador) &&
    hayCambios &&
    !guardar.isPending;

  return (
    <Card>
      <CardHeader>
        <CardTitle as="h2" className="flex items-center gap-2">
          <BellRing className="size-4 text-primary" aria-hidden="true" />
          {t('notificaciones.recordatorios.titulo')}
        </CardTitle>
        <CardDescription>{t('notificaciones.recordatorios.descripcion')}</CardDescription>
      </CardHeader>

      <CardContent className="space-y-4">
        {ajustesQuery.isError ? (
          <Alert variant="danger" title={t('notificaciones.recordatorios.error')}>
            {apiErrorMessage(ajustesQuery.error)}
          </Alert>
        ) : ajustesQuery.isPending ? (
          <Spinner label={t('notificaciones.bot.cargando')} showLabel />
        ) : (
          <>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field
                label={t('notificaciones.recordatorios.campoDias')}
                hint={t('notificaciones.recordatorios.ayudaDias')}
                error={
                  dias.trim() !== '' && !diasValido
                    ? t('notificaciones.recordatorios.invalido')
                    : undefined
                }
              >
                <Input
                  type="number"
                  min={0}
                  max={MAX_REMINDER_DAYS_BEFORE}
                  inputMode="numeric"
                  className="max-w-32"
                  value={dias}
                  onChange={(event) => setDias(event.target.value)}
                  disabled={guardar.isPending}
                />
              </Field>

              <Field
                label={t('notificaciones.recordatorios.campoHora')}
                hint={t('notificaciones.recordatorios.ayudaHora')}
                error={!horaValida ? t('notificaciones.recordatorios.invalidoHora') : undefined}
              >
                <Select
                  className="max-w-36"
                  value={hora}
                  onChange={(event) => setHora(event.target.value)}
                  disabled={guardar.isPending}
                >
                  {reminderHourOptions().map((opcion) => (
                    <option key={opcion} value={String(opcion)}>
                      {reminderHourText(opcion)}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>

            <div className="space-y-3">
              <Switch
                checked={incluirConfirmadas}
                onChange={(event) => setIncluirConfirmadas(event.target.checked)}
                disabled={guardar.isPending}
                label={t('notificaciones.recordatorios.incluirConfirmadas')}
                description={t('notificaciones.recordatorios.incluirConfirmadasAyuda')}
              />
              <Switch
                checked={autoDocumentos}
                onChange={(event) => setAutoDocumentos(event.target.checked)}
                disabled={guardar.isPending}
                label={t('notificaciones.recordatorios.autoDocumentos')}
                description={t('notificaciones.recordatorios.autoDocumentosAyuda')}
              />
            </div>

            <Alert variant={resumen.active ? 'success' : 'info'}>
              {resumen.active
                ? t('notificaciones.recordatorios.activo', {
                    dias: resumen.daysBefore,
                    hora: resumen.hourText,
                  })
                : t('notificaciones.recordatorios.desactivado')}
            </Alert>

            <div className="flex justify-end">
              <Button
                loading={guardar.isPending}
                loadingLabel={t('notificaciones.recordatorios.guardando')}
                disabled={!puedeGuardar}
                onClick={() => guardar.mutate(cambios)}
              >
                {t('notificaciones.recordatorios.guardar')}
              </Button>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
};
