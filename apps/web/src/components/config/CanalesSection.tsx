import {
  CHANNEL_LABELS,
  type AppSettingsView,
  type ChannelSettingsInput,
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
  Field,
  Input,
} from '@odontocrm/ui';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { MessageSquare, Send, ShieldAlert } from 'lucide-react';
import { useEffect, useState, type ReactElement } from 'react';

import { apiErrorMessage } from '../../lib/api';
import { settingsApi } from '../../lib/endpoints';
import { t } from '../../lib/i18n';
import { APP_SETTINGS_QUERY_KEY } from '../../lib/queryKeys';

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

/**
 * **Canales de mensajería** (ADR 0060): los tokens del bot de pacientes y del bot de
 * administración y las credenciales de WhatsApp.
 *
 * Los **secretos** se guardan cifrados en la base y **nunca vuelven** por el API: el
 * formulario solo dice si están configurados. Un secreto que no se escribe **no se toca**;
 * para borrarlo hay que pedirlo (o escribir `-`). Al guardar, el servicio de notificaciones
 * reconstruye sus adaptadores sin reiniciar.
 */
export const CanalesSection = ({ vista, onNotice }: CanalesSectionProps) => {
  const consultas = useQueryClient();
  const canales = vista.channels;

  const [noSecretos, setNoSecretos] = useState<NoSecretos>({
    telegramBotUsername: canales.telegramBotUsername ?? '',
    adminTelegramChatId: canales.adminTelegramChatId ?? '',
    whatsappPhoneId: canales.whatsappPhoneId ?? '',
    whatsappApiBase: canales.whatsappApiBase,
  });
  const [secretos, setSecretos] = useState<Record<Secreto, string>>({
    telegramBotToken: '',
    adminTelegramBotToken: '',
    whatsappToken: '',
    whatsappVerifyToken: '',
    whatsappAppSecret: '',
  });
  const [destinoPrueba, setDestinoPrueba] = useState('');
  const [probando, setProbando] = useState<string | null>(null);

  useEffect(() => {
    setNoSecretos({
      telegramBotUsername: canales.telegramBotUsername ?? '',
      adminTelegramChatId: canales.adminTelegramChatId ?? '',
      whatsappPhoneId: canales.whatsappPhoneId ?? '',
      whatsappApiBase: canales.whatsappApiBase,
    });
  }, [
    canales.telegramBotUsername,
    canales.adminTelegramChatId,
    canales.whatsappPhoneId,
    canales.whatsappApiBase,
  ]);

  /** Construye la entrada: los secretos vacíos **no se mandan** (no se tocan). */
  const construirEntrada = (): ChannelSettingsInput => {
    const entrada: ChannelSettingsInput = {
      telegramBotUsername: noSecretos.telegramBotUsername.trim(),
      adminTelegramChatId: noSecretos.adminTelegramChatId.trim(),
      whatsappPhoneId: noSecretos.whatsappPhoneId.trim(),
      whatsappApiBase: noSecretos.whatsappApiBase.trim(),
    };
    for (const clave of SECRETOS) {
      const valor = secretos[clave].trim();
      if (valor === '-')
        entrada[clave] = ''; // borrar
      else if (valor !== '') entrada[clave] = valor;
    }
    return entrada;
  };

  const guardar = useMutation({
    mutationFn: () => settingsApi.updateChannels(construirEntrada()),
    onSuccess: () => {
      void consultas.invalidateQueries({ queryKey: APP_SETTINGS_QUERY_KEY });
      setSecretos({
        telegramBotToken: '',
        adminTelegramBotToken: '',
        whatsappToken: '',
        whatsappVerifyToken: '',
        whatsappAppSecret: '',
      });
      onNotice('success', t('config.guardado'));
    },
    onError: (fallo) => onNotice('danger', apiErrorMessage(fallo)),
  });

  const probar = async (canal: 'telegram' | 'admin'): Promise<void> => {
    setProbando(canal);
    try {
      const resultado = await settingsApi.testChannel({
        canal,
        ...(canal === 'telegram' && destinoPrueba.trim() !== ''
          ? { destino: destinoPrueba.trim() }
          : {}),
      });
      onNotice(resultado.ok ? 'success' : 'danger', resultado.detalle);
    } catch (fallo) {
      onNotice('danger', apiErrorMessage(fallo));
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
          <div className="grid gap-4 sm:grid-cols-2">
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
          <div className="grid gap-4 sm:grid-cols-2">
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
        </section>

        <section className="space-y-3 border-t border-border pt-5">
          <h3 className="flex items-center gap-2 text-sm font-semibold text-ink">
            {CHANNEL_LABELS.whatsapp}
          </h3>
          <div className="grid gap-4 sm:grid-cols-2">
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
        </div>

        <Button
          loading={guardar.isPending}
          loadingLabel={t('comun.guardando')}
          onClick={() => guardar.mutate()}
        >
          {t('comun.guardar')}
        </Button>
      </CardContent>
    </Card>
  );
};
