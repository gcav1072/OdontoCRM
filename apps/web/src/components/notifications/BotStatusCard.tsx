import type { BotStatus } from '@odontocrm/contracts';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Spinner,
} from '@odontocrm/ui';
import { Bot, RefreshCw } from 'lucide-react';

import { apiErrorMessage } from '../../lib/api';
import { formatDateTime, formatRelative, formatNumber } from '../../lib/format';
import { CHANNEL_LABELS, t } from '../../lib/i18n';
import { BOT_STATUS_REFRESH_MS } from '../../lib/notifications';
import { useNow } from '../../hooks/useNow';

export interface BotStatusCardProps {
  status: BotStatus | undefined;
  /** Marca de la última lectura correcta: se muestra como tiempo relativo. */
  updatedAt: number | null;
  isPending: boolean;
  isFetching: boolean;
  error: unknown;
  onReload: () => void;
}

interface Counter {
  key: keyof BotStatus['counts'];
  labelKey:
    | 'notificaciones.bot.contador.queued'
    | 'notificaciones.bot.contador.sent'
    | 'notificaciones.bot.contador.failed'
    | 'notificaciones.bot.contador.manualPending';
}

const CONTADORES: readonly Counter[] = [
  { key: 'queued', labelKey: 'notificaciones.bot.contador.queued' },
  { key: 'sent', labelKey: 'notificaciones.bot.contador.sent' },
  { key: 'failed', labelKey: 'notificaciones.bot.contador.failed' },
  { key: 'manualPending', labelKey: 'notificaciones.bot.contador.manualPending' },
];

/** Color del contador: rojo si hay fallidos, ámbar si hay avisos manuales. */
const varianteContador = (key: Counter['key'], valor: number): string => {
  if (key === 'failed' && valor > 0) return 'text-danger';
  if (key === 'manualPending' && valor > 0) return 'text-warning';
  return 'text-ink';
};

/**
 * Cabecera de la bandeja: en qué modo está el bot, si está conectado, cuántas
 * actualizaciones quedan por procesar y cómo van los contadores de envíos.
 *
 * Se refresca sola (TanStack Query con `refetchInterval`): los mensajes entran
 * a cada rato y no tiene sentido obligar a recargar la página para verlos.
 */
export const BotStatusCard = ({
  status,
  updatedAt,
  isPending,
  isFetching,
  error,
  onReload,
}: BotStatusCardProps) => {
  const ahora = useNow(BOT_STATUS_REFRESH_MS);

  if (isPending) {
    return (
      <Card>
        <CardContent className="py-10">
          <Spinner label={t('notificaciones.bot.cargando')} showLabel />
        </CardContent>
      </Card>
    );
  }

  if (status === undefined) {
    return (
      <Card>
        <CardContent className="pt-5">
          <Alert variant="danger" title={t('notificaciones.bot.error')}>
            {apiErrorMessage(error)}
          </Alert>
        </CardContent>
      </Card>
    );
  }

  const esReal = status.mode === 'real';
  const titulo = t('notificaciones.bot.titulo');

  return (
    <Card>
      <CardHeader className="gap-3">
        <div className="flex flex-wrap items-start gap-3">
          <span
            className={
              esReal
                ? 'grid size-10 shrink-0 place-items-center rounded-control bg-success/10 text-success'
                : 'grid size-10 shrink-0 place-items-center rounded-control bg-warning/10 text-warning'
            }
          >
            <Bot className="size-5" aria-hidden="true" />
          </span>

          <div className="min-w-0 flex-1">
            <CardTitle as="h2" className="flex flex-wrap items-center gap-2">
              {titulo}
              <Badge variant={esReal ? 'success' : 'warning'} dot>
                {t(esReal ? 'notificaciones.bot.modo.real' : 'notificaciones.bot.modo.simulado')}
              </Badge>
              <Badge variant={status.connected ? 'success' : 'neutral'} dot>
                {t(
                  status.connected
                    ? 'notificaciones.bot.conectado'
                    : 'notificaciones.bot.desconectado',
                )}
              </Badge>
            </CardTitle>

            <p className="flex flex-wrap items-center gap-x-3 gap-y-1 pt-1.5 text-sm text-ink-muted">
              <span className="font-mono">
                {status.botUsername === null
                  ? t('notificaciones.bot.sinUsuario')
                  : `@${status.botUsername}`}
              </span>
              <span aria-hidden="true">·</span>
              <span>
                {t('notificaciones.bot.pendientes')}: {formatNumber(status.pendingUpdates)}
              </span>
            </p>

            <p className="pt-1 text-xs text-ink-subtle">
              {status.lastUpdateAt === null
                ? t('notificaciones.bot.ultimaActualizacion') + ': ' + t('comun.sinDato')
                : `${t('notificaciones.bot.ultimaActualizacion')}: ${formatDateTime(status.lastUpdateAt)}`}
              {updatedAt !== null &&
                ` · ${t('notificaciones.bot.actualizado', { cuando: formatRelative(updatedAt, ahora) })}`}
            </p>
          </div>

          <Button
            variant="secondary"
            size="sm"
            loading={isFetching}
            loadingLabel={t('comun.cargando')}
            leadingIcon={<RefreshCw className="size-4" aria-hidden="true" />}
            onClick={() => {
              onReload();
            }}
          >
            {t('notificaciones.bot.recargar')}
          </Button>
        </div>
      </CardHeader>

      <CardContent className="space-y-4">
        {esReal ? (
          <Alert variant={status.connected ? 'success' : 'warning'}>
            {t(
              status.connected
                ? 'notificaciones.bot.real.texto'
                : 'notificaciones.bot.real.sinConexion',
            )}
          </Alert>
        ) : (
          <Alert variant="warning" title={t('notificaciones.bot.modo.simulado')}>
            {t('notificaciones.bot.simulado.texto')}
          </Alert>
        )}

        {status.lastError !== null && (
          <Alert variant="danger" title={t('notificaciones.detalle.error')}>
            {status.lastError}
          </Alert>
        )}

        {/* Los canales activos: desde la Fase 4.1 el asistente no es solo Telegram. */}
        {status.canales.length > 0 && (
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs font-medium tracking-wide text-ink-subtle uppercase">
              {t('notificaciones.bot.canales')}
            </span>
            {status.canales.map((canal) => (
              <Badge key={canal.canal} variant={canal.conectado ? 'success' : 'neutral'} dot>
                {CHANNEL_LABELS[canal.canal]}
                {' · '}
                {canal.usuario ?? t('notificaciones.bot.canal.sinConfigurar')}
              </Badge>
            ))}
          </div>
        )}

        <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {CONTADORES.map((contador) => (
            <div
              key={contador.key}
              className="rounded-control border border-border bg-surface-muted/60 px-3.5 py-3"
            >
              <dt className="text-xs font-medium tracking-wide text-ink-subtle uppercase">
                {t(contador.labelKey)}
              </dt>
              <dd
                className={`pt-1 text-2xl font-semibold tabular-nums ${varianteContador(
                  contador.key,
                  status.counts[contador.key],
                )}`}
              >
                {formatNumber(status.counts[contador.key])}
              </dd>
            </div>
          ))}
        </dl>
      </CardContent>
    </Card>
  );
};
