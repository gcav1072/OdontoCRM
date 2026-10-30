import type { WhatsAppPairInput, WhatsAppSessionView } from '@odontocrm/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Button, Dialog, Field, Input, Spinner } from '@odontocrm/ui';
import { useEffect, useRef, useState } from 'react';

import { apiErrorMessage } from '../../lib/api';
import { whatsappApi } from '../../lib/endpoints';
import { t } from '../../lib/i18n';
import { notificationKeys, notificationQrImage } from '../../lib/notifications';
import { APP_SETTINGS_QUERY_KEY } from '../../lib/queryKeys';

const ESTADOS_ESPERA = new Set(['esperando_qr', 'conectando', 'reconectando']);

export interface WhatsAppPairDialogProps {
  open: boolean;
  metodo: 'qr' | 'codigo';
  onClose: () => void;
  onNotice: (variant: 'success' | 'danger', message: string) => void;
}

/**
 * Diálogo de vinculación de WhatsApp (ADR 0073): pide el QR o el código de
 * emparejamiento, lo pinta y refresca la sesión cada 2,5 s mientras está
 * abierto. Se cierra solo al pasar a `conectado`.
 */
export const WhatsAppPairDialog = ({
  open,
  metodo,
  onClose,
  onNotice,
}: WhatsAppPairDialogProps) => {
  const consultas = useQueryClient();
  const [telefono, setTelefono] = useState('');
  const [iniciado, setIniciado] = useState(false);
  const pedido = useRef(false);

  const sesion = useQuery({
    queryKey: notificationKeys.whatsappSession,
    queryFn: ({ signal }) => whatsappApi.session(signal),
    enabled: open,
    refetchInterval: (consulta) => {
      const estado = consulta.state.data?.estado;
      return estado !== undefined && ESTADOS_ESPERA.has(estado) ? 2_500 : false;
    },
  });

  const pedir = useMutation({
    mutationFn: (input: WhatsAppPairInput) => whatsappApi.pair(input),
    onSuccess: (vista) => {
      consultas.setQueryData(notificationKeys.whatsappSession, vista);
      consultas.invalidateQueries({ queryKey: notificationKeys.status });
      setIniciado(true);
    },
    onError: (fallo) => onNotice('danger', apiErrorMessage(fallo)),
  });

  useEffect(() => {
    if (!open) {
      pedido.current = false;
      setIniciado(false);
      setTelefono('');
      return;
    }
    if (metodo === 'qr' && !pedido.current) {
      pedido.current = true;
      pedir.mutate({ metodo: 'qr' });
    }
    // `pedir` es una mutación estable; se ejecuta una vez por apertura.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, metodo]);

  useEffect(() => {
    if (!open || sesion.data?.estado !== 'conectado') return;
    onNotice('success', t('config.canales.whatsapp.vinculado'));
    void consultas.invalidateQueries({ queryKey: APP_SETTINGS_QUERY_KEY });
    onClose();
  }, [open, sesion.data?.estado, onClose, onNotice, consultas]);

  const vista: WhatsAppSessionView | undefined = sesion.data;
  const qr = notificationQrImage(vista?.qrDataUrl);
  const esperando =
    vista?.estado === 'esperando_qr' ||
    vista?.estado === 'conectando' ||
    vista?.estado === 'reconectando';
  const pedirOtraVez = (): void => {
    pedir.mutate(
      metodo === 'qr' ? { metodo: 'qr' } : { metodo: 'codigo', telefono: telefono.trim() },
    );
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="md"
      title={
        metodo === 'qr'
          ? t('config.canales.whatsapp.vincularQr')
          : t('config.canales.whatsapp.vincularCodigo')
      }
      closeLabel={t('comun.cerrar')}
      dismissOnBackdrop={false}
      footer={
        <Button variant="secondary" onClick={onClose}>
          {t('comun.cerrar')}
        </Button>
      }
    >
      <div className="space-y-4">
        <Alert variant="info">{t('config.canales.whatsapp.instruccion')}</Alert>

        {metodo === 'codigo' && !iniciado ? (
          <div className="space-y-3">
            <Field
              label={t('config.canales.whatsapp.telefonoConsultorio')}
              hint={t('config.canales.whatsapp.telefonoAyuda')}
            >
              <Input
                value={telefono}
                onChange={(event) => setTelefono(event.target.value)}
                placeholder="0412-1234567"
                inputMode="tel"
              />
            </Field>
            <Button
              loading={pedir.isPending}
              loadingLabel={t('comun.cargando')}
              onClick={() => {
                pedir.mutate({ metodo: 'codigo', telefono: telefono.trim() });
              }}
            >
              {t('config.canales.whatsapp.pedirCodigo')}
            </Button>
          </div>
        ) : pedir.isPending && !iniciado ? (
          <Spinner label={t('config.canales.whatsapp.preparando')} showLabel />
        ) : qr !== null ? (
          <div className="flex flex-col items-center gap-2">
            <img
              src={qr}
              alt={t('config.canales.whatsapp.qrAlt')}
              width={260}
              height={260}
              className="rounded-control border border-border bg-surface p-2"
            />
            <p className="text-xs text-ink-subtle">{t('config.canales.whatsapp.qrCaduca')}</p>
            <Button
              variant="secondary"
              size="sm"
              loading={pedir.isPending}
              loadingLabel={t('config.canales.whatsapp.preparando')}
              onClick={pedirOtraVez}
            >
              {t('config.canales.whatsapp.regenerarQr')}
            </Button>
          </div>
        ) : vista?.pairingCode !== null && vista?.pairingCode !== undefined ? (
          <div className="space-y-2 text-center">
            <p className="text-sm text-ink-muted">
              {t('config.canales.whatsapp.codigoEmparejamiento')}
            </p>
            <p className="font-mono text-2xl font-semibold tracking-widest text-ink">
              {vista.pairingCode}
            </p>
          </div>
        ) : vista === undefined || sesion.isPending ? (
          <Spinner label={t('comun.cargando')} showLabel />
        ) : esperando ? (
          <div className="space-y-3 text-center">
            <Alert variant="warning">{t('config.canales.whatsapp.esperando')}</Alert>
            <Button
              variant="secondary"
              size="sm"
              loading={pedir.isPending}
              loadingLabel={t('config.canales.whatsapp.preparando')}
              onClick={pedirOtraVez}
            >
              {metodo === 'qr'
                ? t('config.canales.whatsapp.regenerarQr')
                : t('config.canales.whatsapp.pedirCodigo')}
            </Button>
          </div>
        ) : (
          <div className="space-y-3">
            <Alert variant="info" title={t('config.canales.whatsapp.sinSesionTitulo')}>
              {t('config.canales.whatsapp.sinSesionTexto')}
            </Alert>
            <Button
              variant="secondary"
              size="sm"
              loading={pedir.isPending}
              loadingLabel={t('config.canales.whatsapp.preparando')}
              onClick={pedirOtraVez}
            >
              {metodo === 'qr'
                ? t('config.canales.whatsapp.regenerarQr')
                : t('config.canales.whatsapp.pedirCodigo')}
            </Button>
          </div>
        )}

        {pedir.isError && (
          <Alert variant="danger" title={t('config.canales.whatsapp.errorSesion')}>
            {apiErrorMessage(pedir.error)}
          </Alert>
        )}

        {sesion.isError && (
          <Alert variant="danger" title={t('notificaciones.bot.error')}>
            {apiErrorMessage(sesion.error)}
          </Alert>
        )}

        {vista?.motivo !== null && vista?.motivo !== undefined && (
          <p className="text-xs text-ink-subtle">{vista.motivo}</p>
        )}
      </div>
    </Dialog>
  );
};
