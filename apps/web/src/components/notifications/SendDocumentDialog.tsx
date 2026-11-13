import type {
  DocumentNotificationKind,
  SendDocumentNotificationResult,
} from '@odontocrm/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Badge, Button, Dialog, Spinner, cn } from '@odontocrm/ui';
import { MessageCircle, Send } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';

import { apiErrorMessage } from '../../lib/api';
import {
  documentSendInput,
  documentSendMessageKey,
  groupDocumentChannels,
} from '../../lib/document-send';
import { notificationsApi } from '../../lib/endpoints';
import { CHANNEL_LABELS, t } from '../../lib/i18n';
import { notificationKeys } from '../../lib/notifications';
import { LinkButton } from '../LinkButton';

/**
 * **Enviar un documento por chat** (v1.2): el disparador manual de récipes,
 * facturas y recibos.
 *
 * Se comparte entre las tres pantallas para no duplicar la lógica: al abrir la
 * acción se consultan los chats del paciente y, si la ficha tiene **un solo
 * vínculo**, se envía directo; con varios se ofrece el selector (canal, dirección
 * enmascarada y cuál es el principal); sin ninguno, un aviso con enlace a
 * `/notificaciones`. El `clientRequestId` se genera **al abrir** y viaja en los
 * reintentos, para que dos clics no encolen el documento dos veces.
 */

export interface SendDocumentDialogProps {
  kind: DocumentNotificationKind;
  entityId: string;
  patientId: string;
  /** Cómo se llama el documento en el título: «Récipe A-000012». */
  documentLabel: string;
  onClose: () => void;
  /** El envío se encoló (o ya estaba en cola): la pantalla muestra el aviso. */
  onSent: (result: SendDocumentNotificationResult) => void;
}

export const SendDocumentDialog = ({
  kind,
  entityId,
  patientId,
  documentLabel,
  onClose,
  onSent,
}: SendDocumentDialogProps) => {
  const cliente = useQueryClient();
  /** Idempotencia del clic: se crea con el diálogo y no cambia en los reintentos. */
  const [clientRequestId] = useState(() => crypto.randomUUID());
  const [elegido, setElegido] = useState<string | null>(null);
  /** El envío automático del único chat se dispara una sola vez. */
  const autoEnviado = useRef(false);

  const canalesQuery = useQuery({
    queryKey: notificationKeys.channels(patientId),
    queryFn: ({ signal }) => notificationsApi.channels(patientId, signal),
  });

  const grupos = useMemo(
    () => groupDocumentChannels(canalesQuery.data?.items ?? []),
    [canalesQuery.data],
  );
  const opciones = useMemo(() => grupos.flatMap((grupo) => grupo.options), [grupos]);
  const unico = opciones.length === 1 ? opciones[0] : undefined;
  const hayVarios = opciones.length > 1;

  const enviar = useMutation({
    mutationFn: (channelId: string | null) =>
      notificationsApi.sendDocument(
        documentSendInput({
          kind,
          entityId,
          patientId,
          ...(channelId === null ? {} : { channelId }),
          clientRequestId,
        }),
      ),
    onSuccess: (resultado) => {
      void cliente.invalidateQueries({ queryKey: notificationKeys.listRoot });
      void cliente.invalidateQueries({ queryKey: notificationKeys.status });
      onSent(resultado);
    },
  });

  // Con un solo chat vinculado no hay nada que elegir: se envía directo.
  useEffect(() => {
    if (unico === undefined || autoEnviado.current) return;
    autoEnviado.current = true;
    enviar.mutate(unico.id);
    // `mutate` es estable en TanStack Query y el guardia impide repetirlo.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [unico?.id]);

  // Con varios chats se preselecciona el principal para no obligar a elegir.
  useEffect(() => {
    if (elegido !== null || opciones.length === 0) return;
    setElegido(opciones.find((opcion) => opcion.isPrimary)?.id ?? opciones[0]?.id ?? null);
  }, [elegido, opciones]);

  const destino = elegido ?? unico?.id ?? null;

  const enviarElegido = (): void => {
    if (destino !== null) enviar.mutate(destino);
  };

  const errorEnvio =
    enviar.isError === true ? (
      <Alert variant="danger" title={t('notificaciones.envio.error')}>
        {apiErrorMessage(enviar.error)}
      </Alert>
    ) : null;

  return (
    <Dialog
      open
      onClose={onClose}
      size="sm"
      title={t('notificaciones.envio.titulo')}
      description={t('notificaciones.envio.descripcion', { documento: documentLabel })}
      dismissOnBackdrop={!enviar.isPending}
      closeLabel={t('comun.cerrar')}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={enviar.isPending}>
            {t('comun.cerrar')}
          </Button>
          {hayVarios && (
            <Button
              loading={enviar.isPending}
              loadingLabel={t('notificaciones.envio.enviando')}
              leadingIcon={<Send className="size-4" aria-hidden="true" />}
              disabled={destino === null}
              onClick={enviarElegido}
            >
              {t('notificaciones.envio.enviar')}
            </Button>
          )}
        </>
      }
    >
      <div className="space-y-3">
        {canalesQuery.isError ? (
          <Alert variant="danger" title={t('notificaciones.envio.errorCanales')}>
            {apiErrorMessage(canalesQuery.error)}
          </Alert>
        ) : canalesQuery.isPending ? (
          <Spinner label={t('notificaciones.envio.cargando')} showLabel />
        ) : opciones.length === 0 ? (
          <Alert variant="warning" title={t('notificaciones.envio.sinCanalesTitulo')}>
            <p>{t('notificaciones.envio.sinCanalesTexto')}</p>
            <LinkButton to="/notificaciones" size="sm" variant="secondary" className="mt-2.5">
              {t('notificaciones.envio.irANotificaciones')}
            </LinkButton>
          </Alert>
        ) : unico !== undefined ? (
          enviar.isError ? (
            <div className="space-y-3">
              {errorEnvio}
              <Button
                variant="secondary"
                leadingIcon={<Send className="size-4" aria-hidden="true" />}
                onClick={() => enviar.mutate(unico.id)}
              >
                {t('comun.reintentar')}
              </Button>
            </div>
          ) : (
            <Spinner label={t('notificaciones.envio.enviando')} showLabel />
          )
        ) : (
          <div className="space-y-3">
            <p className="text-sm font-medium text-ink">{t('notificaciones.envio.elegirChat')}</p>

            <div className="space-y-3">
              {grupos.map((grupo) => (
                <fieldset key={grupo.channel}>
                  <legend className="text-xs font-semibold tracking-wide text-ink-subtle uppercase">
                    {CHANNEL_LABELS[grupo.channel]}
                  </legend>
                  <ul className="mt-1.5 space-y-1.5">
                    {grupo.options.map((opcion) => (
                      <li key={opcion.id}>
                        <label
                          className={cn(
                            'flex cursor-pointer flex-wrap items-center gap-2 rounded-control border px-3 py-2 text-sm transition-colors',
                            elegido === opcion.id
                              ? 'border-primary bg-primary/5'
                              : 'border-border bg-surface hover:bg-surface-muted',
                          )}
                        >
                          <input
                            type="radio"
                            name="documento-chat"
                            className="accent-primary"
                            checked={elegido === opcion.id}
                            disabled={enviar.isPending}
                            onChange={() => setElegido(opcion.id)}
                          />
                          <span className="font-mono text-xs text-ink">
                            {opcion.direccionMasked}
                          </span>
                          {opcion.isPrimary && (
                            <Badge variant="primary">{t('notificaciones.canales.principal')}</Badge>
                          )}
                        </label>
                      </li>
                    ))}
                  </ul>
                </fieldset>
              ))}
            </div>

            {errorEnvio}
          </div>
        )}
      </div>
    </Dialog>
  );
};

export interface SendDocumentButtonProps {
  kind: DocumentNotificationKind;
  entityId: string;
  patientId: string;
  /** Cómo se llama el documento en el título: «Récipe A-000012». */
  documentLabel: string;
  /** Texto del botón; por defecto «Enviar por chat». */
  label?: string;
  disabled?: boolean;
  /** Aviso de éxito en la pantalla que monta el botón. */
  onNotice: (variant: 'success' | 'danger', message: string) => void;
}

/**
 * Botón + diálogo de envío, listos para colgar de una fila de récipe, factura o
 * recibo. La pantalla solo decide **cuándo se puede** enviar y cómo se muestra el
 * aviso.
 */
export const SendDocumentButton = ({
  kind,
  entityId,
  patientId,
  documentLabel,
  label,
  disabled = false,
  onNotice,
}: SendDocumentButtonProps) => {
  const [abierto, setAbierto] = useState(false);

  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        disabled={disabled}
        leadingIcon={<MessageCircle className="size-4" aria-hidden="true" />}
        onClick={() => setAbierto(true)}
      >
        {label ?? t('notificaciones.envio.boton')}
      </Button>

      {abierto && (
        <SendDocumentDialog
          kind={kind}
          entityId={entityId}
          patientId={patientId}
          documentLabel={documentLabel}
          onClose={() => setAbierto(false)}
          onSent={(resultado) => {
            setAbierto(false);
            onNotice('success', t(documentSendMessageKey(resultado)));
          }}
        />
      )}
    </>
  );
};
