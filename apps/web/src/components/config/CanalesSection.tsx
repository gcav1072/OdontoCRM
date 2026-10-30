import {
  CHANNEL_LABELS,
  WHATSAPP_RATE_DEFAULTS,
  type AppSettingsView,
  type ChannelSettingsInput,
  type WhatsAppProvider,
  type WhatsAppSessionView,
} from '@odontocrm/contracts';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Dialog,
  Field,
  Input,
  Select,
  Spinner,
  Switch,
} from '@odontocrm/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link2, MessageSquare, PlugZap, RefreshCw, Send, ShieldAlert, Unplug } from 'lucide-react';
import { useEffect, useState, type ReactElement } from 'react';

import { apiErrorMessageConCampos } from '../../lib/api';
import { settingsApi, whatsappApi } from '../../lib/endpoints';
import { t, type TranslationKey } from '../../lib/i18n';
import { notificationKeys } from '../../lib/notifications';
import { APP_SETTINGS_QUERY_KEY } from '../../lib/queryKeys';
import { WhatsAppPairDialog } from './WhatsAppPairDialog';

export interface CanalesSectionProps {
  vista: AppSettingsView;
  onNotice: (variant: 'success' | 'danger', message: string) => void;
}

/** Campos de texto no secretos (llegan siempre con valor de la vista). */
interface NoSecretos {
  telegramBotUsername: string;
  adminTelegramChatId: string;
  whatsappPhoneId: string;
  whatsappApiBase: string;
  whatsappSendMinIntervalMs: string;
  whatsappSendMaxIntervalMs: string;
  whatsappDailySendCap: string;
}

/** Campos secretos (nunca llegan con su valor: solo «configurado» o no). */
type Secreto =
  | 'telegramBotToken'
  | 'adminTelegramBotToken'
  | 'whatsappToken'
  | 'whatsappVerifyToken'
  | 'whatsappAppSecret';

const SECRETOS: readonly Secreto[] = [
  'telegramBotToken',
  'adminTelegramBotToken',
  'whatsappToken',
  'whatsappVerifyToken',
  'whatsappAppSecret',
];

const ESTADO_WHATSAPP: Readonly<Record<WhatsAppSessionView['estado'], TranslationKey>> = {
  desactivado: 'config.canales.whatsapp.estado.desactivado',
  sin_vincular: 'config.canales.whatsapp.estado.sin_vincular',
  esperando_qr: 'config.canales.whatsapp.estado.esperando_qr',
  conectando: 'config.canales.whatsapp.estado.conectando',
  conectado: 'config.canales.whatsapp.estado.conectado',
  reconectando: 'config.canales.whatsapp.estado.reconectando',
  sesion_cerrada: 'config.canales.whatsapp.estado.sesion_cerrada',
  reemplazada: 'config.canales.whatsapp.estado.reemplazada',
};

/**
 * **Canales de mensajería** (ADR 0060/0072): tokens de los bots de Telegram y
 * la configuración de WhatsApp. WhatsApp tiene dos proveedores detrás del
 * mismo canal: Baileys (por defecto, sesión vinculada por QR) y Cloud API (la
 * alternativa oficial que se conserva). Los secretos se guardan cifrados y no
 * vuelven por el API.
 */
export const CanalesSection = ({ vista, onNotice }: CanalesSectionProps) => {
  const consultas = useQueryClient();
  const canales = vista.channels;

  const [noSecretos, setNoSecretos] = useState<NoSecretos>({
    telegramBotUsername: canales.telegramBotUsername ?? '',
    adminTelegramChatId: canales.adminTelegramChatId ?? '',
    whatsappPhoneId: canales.whatsappPhoneId ?? '',
    whatsappApiBase: canales.whatsappApiBase,
    whatsappSendMinIntervalMs: String(canales.whatsappSendMinIntervalMs),
    whatsappSendMaxIntervalMs: String(canales.whatsappSendMaxIntervalMs),
    whatsappDailySendCap: String(canales.whatsappDailySendCap),
  });
  const [secretos, setSecretos] = useState<Record<Secreto, string>>({
    telegramBotToken: '',
    adminTelegramBotToken: '',
    whatsappToken: '',
    whatsappVerifyToken: '',
    whatsappAppSecret: '',
  });
  const [habilitado, setHabilitado] = useState(canales.whatsappEnabled);
  const [proveedor, setProveedor] = useState<WhatsAppProvider>(canales.whatsappProvider);
  const [destinoPrueba, setDestinoPrueba] = useState('');
  const [probando, setProbando] = useState<string | null>(null);
  const [dialogo, setDialogo] = useState<{ metodo: 'qr' | 'codigo' } | null>(null);
  const [cerrando, setCerrando] = useState(false);

  useEffect(() => {
    setNoSecretos({
      telegramBotUsername: canales.telegramBotUsername ?? '',
      adminTelegramChatId: canales.adminTelegramChatId ?? '',
      whatsappPhoneId: canales.whatsappPhoneId ?? '',
      whatsappApiBase: canales.whatsappApiBase,
      whatsappSendMinIntervalMs: String(canales.whatsappSendMinIntervalMs),
      whatsappSendMaxIntervalMs: String(canales.whatsappSendMaxIntervalMs),
      whatsappDailySendCap: String(canales.whatsappDailySendCap),
    });
    setHabilitado(canales.whatsappEnabled);
    setProveedor(canales.whatsappProvider);
  }, [
    canales.telegramBotUsername,
    canales.adminTelegramChatId,
    canales.whatsappPhoneId,
    canales.whatsappApiBase,
    canales.whatsappEnabled,
    canales.whatsappProvider,
    canales.whatsappSendMinIntervalMs,
    canales.whatsappSendMaxIntervalMs,
    canales.whatsappDailySendCap,
  ]);

  const sesion = useQuery({
    queryKey: notificationKeys.whatsappSession,
    queryFn: ({ signal }) => whatsappApi.session(signal),
    enabled: canales.whatsappEnabled && canales.whatsappProvider === 'baileys',
    refetchInterval: (consulta) => {
      const estado = consulta.state.data?.estado;
      return estado === 'esperando_qr' || estado === 'conectando' || estado === 'reconectando'
        ? 5_000
        : false;
    },
    retry: false,
  });

  const construirEntrada = (): ChannelSettingsInput => {
    const entrada: ChannelSettingsInput = {
      telegramBotUsername: noSecretos.telegramBotUsername.trim(),
      adminTelegramChatId: noSecretos.adminTelegramChatId.trim(),
      whatsappEnabled: habilitado,
      whatsappProvider: proveedor,
      whatsappSendMinIntervalMs: Number(noSecretos.whatsappSendMinIntervalMs),
      whatsappSendMaxIntervalMs: Number(noSecretos.whatsappSendMaxIntervalMs),
      whatsappDailySendCap: Number(noSecretos.whatsappDailySendCap),
      whatsappPhoneId: noSecretos.whatsappPhoneId.trim(),
      whatsappApiBase: noSecretos.whatsappApiBase.trim(),
    };
    for (const clave of SECRETOS) {
      const valor = secretos[clave].trim();
      if (valor === '-') entrada[clave] = '';
      else if (valor !== '') entrada[clave] = valor;
    }
    return entrada;
  };

  const guardar = useMutation({
    mutationFn: () => settingsApi.updateChannels(construirEntrada()),
    onSuccess: () => {
      void consultas.invalidateQueries({ queryKey: APP_SETTINGS_QUERY_KEY });
      void consultas.invalidateQueries({ queryKey: notificationKeys.whatsappSession });
      void consultas.invalidateQueries({ queryKey: notificationKeys.status });
      setSecretos({
        telegramBotToken: '',
        adminTelegramBotToken: '',
        whatsappToken: '',
        whatsappVerifyToken: '',
        whatsappAppSecret: '',
      });
      onNotice('success', t('config.guardado'));
    },
    onError: (fallo) => onNotice('danger', apiErrorMessageConCampos(fallo)),
  });

  const reiniciar = useMutation({
    mutationFn: () => whatsappApi.restart(),
    onSuccess: (nueva) => {
      consultas.setQueryData(notificationKeys.whatsappSession, nueva);
      void consultas.invalidateQueries({ queryKey: notificationKeys.status });
      onNotice('success', t('config.canales.whatsapp.reconectado'));
    },
    onError: (fallo) => onNotice('danger', apiErrorMessageConCampos(fallo)),
  });

  const cerrarSesion = useMutation({
    mutationFn: () => whatsappApi.logout(),
    onSuccess: (nueva) => {
      consultas.setQueryData(notificationKeys.whatsappSession, nueva);
      void consultas.invalidateQueries({ queryKey: notificationKeys.status });
      setCerrando(false);
      onNotice('success', t('config.canales.whatsapp.sesionCerrada'));
    },
    onError: (fallo) => {
      setCerrando(false);
      onNotice('danger', apiErrorMessageConCampos(fallo));
    },
  });

  const probar = async (canal: 'telegram' | 'admin' | 'whatsapp'): Promise<void> => {
    setProbando(canal);
    try {
      const resultado = await settingsApi.testChannel({
        canal,
        ...(canal !== 'admin' && destinoPrueba.trim() !== ''
          ? { destino: destinoPrueba.trim() }
          : {}),
      });
      onNotice(resultado.ok ? 'success' : 'danger', resultado.detalle);
    } catch (fallo) {
      onNotice('danger', apiErrorMessageConCampos(fallo));
    } finally {
      setProbando(null);
    }
  };

  const campoSecreto = (clave: Secreto, label: string): ReactElement => {
    const estado = canales[clave];
    return (
      <Field key={clave} label={label} hint={t('config.canales.secretoAyuda')}>
        <div className="flex items-center gap-2">
          <Input
            type="password"
            autoComplete="off"
            value={secretos[clave]}
            onChange={(event) => setSecretos((prev) => ({ ...prev, [clave]: event.target.value }))}
            placeholder={
              estado.configured ? (estado.preview ?? '') : t('config.canales.secretoVacio')
            }
          />
          <Badge variant={estado.configured ? 'success' : 'neutral'} dot>
            {estado.configured
              ? t('config.canales.secretoGuardado')
              : t('config.canales.secretoVacio')}
          </Badge>
        </div>
      </Field>
    );
  };

  const vistaSesion = sesion.data;
  const estadoSesion = vistaSesion?.estado ?? 'sin_vincular';
  const sesionDisponible = canales.whatsappEnabled && canales.whatsappProvider === 'baileys';

  return (
    <Card>
      <CardHeader>
        <CardTitle as="h2" className="flex items-center gap-2">
          <MessageSquare className="size-4 text-primary" aria-hidden="true" />
          {t('config.canales.titulo')}
        </CardTitle>
        <CardDescription>{t('config.canales.descripcion')}</CardDescription>
      </CardHeader>

      <CardContent className="space-y-6">
        {!canales.encrypted && <Alert variant="warning" title={t('config.canales.sinCifrar')} />}

        <section className="space-y-3">
          <h3 className="flex items-center gap-2 text-sm font-semibold text-ink">
            {CHANNEL_LABELS.telegram}
          </h3>
          <div className="grid gap-4 @2xl:grid-cols-2">
            {campoSecreto('telegramBotToken', t('config.canales.token'))}
            <Field label={t('config.canales.usuario')}>
              <Input
                value={noSecretos.telegramBotUsername}
                onChange={(event) =>
                  setNoSecretos((prev) => ({ ...prev, telegramBotUsername: event.target.value }))
                }
              />
            </Field>
          </div>
        </section>

        <section className="space-y-3 border-t border-border pt-5">
          <h3 className="flex items-center gap-2 text-sm font-semibold text-ink">
            {t('config.canales.admin')}
          </h3>
          <div className="grid gap-4 @2xl:grid-cols-2">
            {campoSecreto('adminTelegramBotToken', t('config.canales.token'))}
            <Field label={t('config.canales.adminChat')}>
              <Input
                value={noSecretos.adminTelegramChatId}
                onChange={(event) =>
                  setNoSecretos((prev) => ({ ...prev, adminTelegramChatId: event.target.value }))
                }
              />
            </Field>
          </div>
          <p className="text-xs text-ink-subtle">{t('config.canales.adminAviso')}</p>
        </section>

        <section className="space-y-4 border-t border-border pt-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h3 className="flex items-center gap-2 text-sm font-semibold text-ink">
              {t('config.canales.whatsapp')}
            </h3>
            {canales.whatsappEnabled && canales.whatsappProvider === 'baileys' && (
              <Badge variant={estadoSesion === 'conectado' ? 'success' : 'neutral'} dot>
                {t(ESTADO_WHATSAPP[estadoSesion])}
              </Badge>
            )}
          </div>

          <Alert variant="warning" title={t('config.canales.whatsapp.riesgoTitulo')}>
            {t('config.canales.whatsapp.riesgo')}
          </Alert>

          <div className="grid gap-4 @2xl:grid-cols-2">
            <Field
              label={t('config.canales.whatsapp.proveedor')}
              hint={t('config.canales.whatsapp.proveedorAyuda')}
            >
              <Select
                value={proveedor}
                onChange={(event) => setProveedor(event.target.value as WhatsAppProvider)}
              >
                <option value="baileys">Baileys (QR)</option>
                <option value="cloud_api">Cloud API (Meta)</option>
              </Select>
            </Field>
            <div className="flex items-end pb-2">
              <Switch
                checked={habilitado}
                onChange={(event) => setHabilitado(event.target.checked)}
                label={t('config.canales.whatsapp.activar')}
                description={t('config.canales.whatsapp.activarAyuda')}
              />
            </div>
          </div>

          {proveedor === 'baileys' ? (
            <div className="space-y-4 rounded-control border border-border bg-surface-muted/40 p-4">
              {!sesionDisponible ? (
                <Alert variant="info">{t('config.canales.whatsapp.sesionNoActiva')}</Alert>
              ) : sesion.isPending ? (
                <Spinner label={t('comun.cargando')} showLabel />
              ) : sesion.isError ? (
                <Alert variant="info">{t('config.canales.whatsapp.sesionNoActiva')}</Alert>
              ) : (
                <>
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
                    <span className="font-medium text-ink">
                      {vistaSesion?.numero ?? t('config.canales.whatsapp.sinNumero')}
                    </span>
                    {vistaSesion?.nombre !== null && vistaSesion?.nombre !== undefined && (
                      <span className="text-ink-muted">{vistaSesion.nombre}</span>
                    )}
                  </div>
                  {vistaSesion?.motivo !== null && vistaSesion?.motivo !== undefined && (
                    <p className="text-xs text-ink-subtle">{vistaSesion.motivo}</p>
                  )}
                  <div className="flex flex-wrap gap-2">
                    <Button
                      variant="secondary"
                      leadingIcon={<Link2 className="size-4" aria-hidden="true" />}
                      onClick={() => setDialogo({ metodo: 'qr' })}
                      disabled={!sesionDisponible || estadoSesion === 'conectado'}
                    >
                      {t('config.canales.whatsapp.vincularQr')}
                    </Button>
                    <Button
                      variant="secondary"
                      leadingIcon={<ShieldAlert className="size-4" aria-hidden="true" />}
                      onClick={() => setDialogo({ metodo: 'codigo' })}
                      disabled={!sesionDisponible || estadoSesion === 'conectado'}
                    >
                      {t('config.canales.whatsapp.vincularCodigo')}
                    </Button>
                    <Button
                      variant="secondary"
                      loading={reiniciar.isPending}
                      loadingLabel={t('comun.cargando')}
                      leadingIcon={<RefreshCw className="size-4" aria-hidden="true" />}
                      onClick={() => reiniciar.mutate()}
                      disabled={!sesionDisponible}
                    >
                      {t('config.canales.whatsapp.reconectar')}
                    </Button>
                    <Button
                      variant="danger"
                      leadingIcon={<Unplug className="size-4" aria-hidden="true" />}
                      onClick={() => setCerrando(true)}
                      disabled={!sesionDisponible || estadoSesion === 'sin_vincular'}
                    >
                      {t('config.canales.whatsapp.cerrarSesion')}
                    </Button>
                  </div>
                </>
              )}

              <div className="grid gap-4 @2xl:grid-cols-3">
                <Field label={t('config.canales.whatsapp.esperaMin')}>
                  <Input
                    type="number"
                    min={1}
                    max={60}
                    step={1}
                    value={noSecretos.whatsappSendMinIntervalMs}
                    onChange={(event) =>
                      setNoSecretos((prev) => ({
                        ...prev,
                        whatsappSendMinIntervalMs: event.target.value,
                      }))
                    }
                  />
                </Field>
                <Field label={t('config.canales.whatsapp.esperaMax')}>
                  <Input
                    type="number"
                    min={1}
                    max={60}
                    step={1}
                    value={noSecretos.whatsappSendMaxIntervalMs}
                    onChange={(event) =>
                      setNoSecretos((prev) => ({
                        ...prev,
                        whatsappSendMaxIntervalMs: event.target.value,
                      }))
                    }
                  />
                </Field>
                <Field label={t('config.canales.whatsapp.topeDiario')}>
                  <Input
                    type="number"
                    min={1}
                    max={1000}
                    step={1}
                    value={noSecretos.whatsappDailySendCap}
                    onChange={(event) =>
                      setNoSecretos((prev) => ({
                        ...prev,
                        whatsappDailySendCap: event.target.value,
                      }))
                    }
                  />
                </Field>
              </div>
              <p className="text-xs text-ink-subtle">
                {t('config.canales.whatsapp.ritmoAyuda', {
                  min: String(WHATSAPP_RATE_DEFAULTS.minSendIntervalMs / 1000),
                  max: String(WHATSAPP_RATE_DEFAULTS.maxSendIntervalMs / 1000),
                })}
              </p>
            </div>
          ) : (
            <div className="grid gap-4 @2xl:grid-cols-2">
              {campoSecreto('whatsappToken', t('config.canales.whatsappToken'))}
              {campoSecreto('whatsappVerifyToken', t('config.canales.whatsappVerify'))}
              {campoSecreto('whatsappAppSecret', t('config.canales.whatsappSecret'))}
              <Field label={t('config.canales.whatsappPhone')}>
                <Input
                  value={noSecretos.whatsappPhoneId}
                  onChange={(event) =>
                    setNoSecretos((prev) => ({ ...prev, whatsappPhoneId: event.target.value }))
                  }
                />
              </Field>
              <Field label={t('config.canales.whatsappBase')}>
                <Input
                  value={noSecretos.whatsappApiBase}
                  onChange={(event) =>
                    setNoSecretos((prev) => ({ ...prev, whatsappApiBase: event.target.value }))
                  }
                />
              </Field>
            </div>
          )}
        </section>

        <div className="flex flex-wrap items-end gap-3 border-t border-border pt-5">
          <Field label={t('config.canales.destino')}>
            <Input
              value={destinoPrueba}
              onChange={(event) => setDestinoPrueba(event.target.value)}
              className="max-w-56"
            />
          </Field>
          <Button
            variant="secondary"
            loading={probando === 'telegram'}
            loadingLabel={t('config.canales.probando')}
            onClick={() => void probar('telegram')}
            leadingIcon={<Send className="size-4" aria-hidden="true" />}
          >
            {t('config.canales.testTelegram')}
          </Button>
          <Button
            variant="secondary"
            loading={probando === 'admin'}
            loadingLabel={t('config.canales.probando')}
            onClick={() => void probar('admin')}
            leadingIcon={<ShieldAlert className="size-4" aria-hidden="true" />}
          >
            {t('config.canales.testAdmin')}
          </Button>
          <Button
            variant="secondary"
            loading={probando === 'whatsapp'}
            loadingLabel={t('config.canales.probando')}
            onClick={() => void probar('whatsapp')}
            leadingIcon={<PlugZap className="size-4" aria-hidden="true" />}
            disabled={!canales.whatsappEnabled}
          >
            {t('config.canales.testWhatsApp')}
          </Button>
        </div>

        <Button
          loading={guardar.isPending}
          loadingLabel={t('comun.guardando')}
          onClick={() => guardar.mutate()}
        >
          {t('comun.guardar')}
        </Button>
      </CardContent>

      {dialogo !== null && (
        <WhatsAppPairDialog
          open
          metodo={dialogo.metodo}
          onClose={() => {
            setDialogo(null);
            void consultas.invalidateQueries({ queryKey: notificationKeys.whatsappSession });
          }}
          onNotice={onNotice}
        />
      )}

      {cerrando && (
        <Dialog
          open
          onClose={() => setCerrando(false)}
          size="sm"
          title={t('config.canales.whatsapp.cerrarTitulo')}
          closeLabel={t('comun.cerrar')}
          footer={
            <>
              <Button
                variant="secondary"
                onClick={() => setCerrando(false)}
                disabled={cerrarSesion.isPending}
              >
                {t('comun.cancelar')}
              </Button>
              <Button
                variant="danger"
                loading={cerrarSesion.isPending}
                loadingLabel={t('comun.guardando')}
                onClick={() => cerrarSesion.mutate()}
              >
                {t('config.canales.whatsapp.cerrarSesion')}
              </Button>
            </>
          }
        >
          <p className="text-sm text-ink-muted">{t('config.canales.whatsapp.cerrarTexto')}</p>
        </Dialog>
      )}
    </Card>
  );
};
