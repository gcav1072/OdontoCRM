import { formatTime12h, type NotifyBatchResult } from '@odontocrm/contracts';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Alert, Badge, Button, Checkbox, Dialog, Spinner } from '@odontocrm/ui';
import { BellRing, Send } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router-dom';

import { apiErrorMessage } from '../../lib/api';
import { agendaApi } from '../../lib/endpoints';
import { formatDateOnly, schedulingKeys } from '../../lib/scheduling';
import { CHANNEL_LABELS, t } from '../../lib/i18n';

export interface NotifyBatchDialogProps {
  date: string;
  /** Si viene, se prepara solo el aviso de esas citas (reenvío individual). */
  appointmentIds?: readonly string[];
  onClose: () => void;
  onNotified: (result: NotifyBatchResult) => void;
}

/**
 * Aviso al paciente con vista previa exacta: se pide a
 * `POST /agenda/notify/preview` lo que se preparará (asunto y cuerpo ya
 * renderizados, con `willSend` y `skipReason`) y solo al confirmar se llama a
 * `POST /agenda/notify`, que publica el evento con el que el servicio de
 * notificaciones envía el mensaje y el `.ics`. El estado de cada envío se sigue en
 * la bandeja (`/notificaciones`), que es lo que enlaza el aviso del diálogo.
 */
export const NotifyBatchDialog = ({
  date,
  appointmentIds,
  onClose,
  onNotified,
}: NotifyBatchDialogProps) => {
  const [forzar, setForzar] = useState(false);
  const [errorGeneral, setErrorGeneral] = useState<string | null>(null);

  const individual = appointmentIds !== undefined && appointmentIds.length === 1;

  const vistaQuery = useQuery({
    queryKey: schedulingKeys.notifyPreview(date, appointmentIds),
    queryFn: ({ signal }) =>
      agendaApi.notifyPreview(
        {
          date,
          appointmentIds: appointmentIds === undefined ? undefined : [...appointmentIds],
        },
        signal,
      ),
  });

  const notificar = useMutation({
    mutationFn: () =>
      agendaApi.notify({
        date,
        appointmentIds: appointmentIds === undefined ? undefined : [...appointmentIds],
        force: forzar,
      }),
  });

  const lote = vistaQuery.data;
  const enviables = lote?.willSendCount ?? 0;

  const confirmar = async () => {
    setErrorGeneral(null);
    try {
      const resultado = await notificar.mutateAsync();
      onNotified(resultado);
    } catch (fallo) {
      setErrorGeneral(apiErrorMessage(fallo));
    }
  };

  return (
    <Dialog
      open
      onClose={onClose}
      size="lg"
      title={
        individual && lote?.items[0] !== undefined
          ? t('programacion.notificar.individual', { paciente: lote.items[0].patientName })
          : t('programacion.notificar.titulo', { fecha: formatDateOnly(date) })
      }
      description={
        individual ? t('programacion.notificar.individualTexto') : t('programacion.notificar.texto')
      }
      dismissOnBackdrop={false}
      closeLabel={t('comun.cerrar')}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={notificar.isPending}>
            {t('comun.cancelar')}
          </Button>
          <Button
            loading={notificar.isPending}
            loadingLabel={t('comun.enviando')}
            disabled={vistaQuery.isPending || (enviables === 0 && !forzar)}
            leadingIcon={<Send className="size-4" aria-hidden="true" />}
            onClick={() => {
              void confirmar();
            }}
          >
            {individual
              ? t('programacion.notificar.confirmarUno')
              : t('programacion.notificar.confirmar')}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {/* El aviso se envía de verdad (el servicio de notificaciones consume el
            evento) y su estado se sigue en la bandeja. */}
        <Alert variant="info" hideIcon>
          <p className="flex items-start gap-2">
            <BellRing className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            <span>
              {t('programacion.notificar.envio')}{' '}
              <Link
                to="/notificaciones"
                className="font-medium whitespace-nowrap text-primary underline underline-offset-2"
              >
                {t('programacion.notificar.verBandeja')}
              </Link>
            </span>
          </p>
        </Alert>

        {errorGeneral !== null && <Alert variant="danger">{errorGeneral}</Alert>}

        <Checkbox
          label={t('programacion.notificar.reenviar')}
          description={t('programacion.notificar.reenviarAyuda')}
          checked={forzar}
          disabled={notificar.isPending}
          onChange={(event) => setForzar(event.target.checked)}
        />

        {vistaQuery.isPending ? (
          <Spinner label={t('programacion.notificar.cargando')} showLabel />
        ) : vistaQuery.isError ? (
          <Alert variant="danger" title={t('programacion.notificar.error')}>
            {apiErrorMessage(vistaQuery.error)}
          </Alert>
        ) : lote === undefined || lote.items.length === 0 ? (
          <Alert variant="warning">{t('programacion.notificar.vacio')}</Alert>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="neutral">
                {t('programacion.notificar.total', { total: lote.items.length })}
              </Badge>
              <Badge variant={lote.willSendCount > 0 ? 'success' : 'warning'}>
                {t('programacion.notificar.prepararan', { total: lote.willSendCount })}
              </Badge>
            </div>

            <ul className="space-y-3">
              {lote.items.map((item) => (
                <li
                  key={item.appointmentId}
                  className="rounded-control border border-border bg-surface p-3"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="text-sm font-medium text-ink">
                      {item.ticket ?? t('comun.sinDato')} · {item.patientName}
                    </p>
                    <Badge variant={item.willSend ? 'success' : 'warning'}>
                      {item.willSend
                        ? t('programacion.notificar.seEnvia')
                        : t('programacion.notificar.noSeEnvia')}
                    </Badge>
                  </div>

                  <p className="pt-1 text-xs text-ink-subtle">
                    {t('programacion.notificar.hora', {
                      fecha: formatDateOnly(item.date),
                      hora: formatTime12h(item.startTime),
                    })}
                    {' · '}
                    {CHANNEL_LABELS[item.channel]}
                    {' · '}
                    {t('programacion.notificar.destino', {
                      telefono: item.patientPhone ?? t('programacion.notificar.sinTelefono'),
                    })}
                  </p>

                  {!item.willSend && item.skipReason !== null && (
                    <p className="pt-1.5 text-xs font-medium text-warning">
                      {t('programacion.notificar.motivoOmision')}: {item.skipReason}
                    </p>
                  )}

                  <dl className="mt-2 space-y-1 rounded-control bg-surface-muted px-3 py-2">
                    <div>
                      <dt className="text-xs text-ink-subtle">
                        {t('programacion.notificar.asunto')}
                      </dt>
                      <dd className="text-sm font-medium text-ink">{item.subject}</dd>
                    </div>
                    <div>
                      <dt className="text-xs text-ink-subtle">
                        {t('programacion.notificar.cuerpo')}
                      </dt>
                      <dd className="text-sm whitespace-pre-line text-ink-muted">{item.body}</dd>
                    </div>
                  </dl>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </Dialog>
  );
};
