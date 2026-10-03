import type { BotConversation } from '@odontocrm/contracts';
import {
  Alert,
  Badge,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  EmptyState,
  Spinner,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@odontocrm/ui';
import { MessageSquareDashed, UserRound } from 'lucide-react';

import { apiErrorMessage } from '../../lib/api';
import { formatDateTime, formatRelative } from '../../lib/format';
import { botStateLabel, t } from '../../lib/i18n';

export interface BotConversationsCardProps {
  conversations: readonly BotConversation[] | undefined;
  isPending: boolean;
  error: unknown;
}

/**
 * Conversaciones activas del asistente: chat enmascarado, paso en el que va y
 * cuándo se movió por última vez. Es informativa a propósito — sirve para ver
 * quién está a medio camino y para saber si hay que llamar a alguien —, así que
 * no ofrece acciones: la conversación la continúa el propio bot en Telegram.
 */
export const BotConversationsCard = ({
  conversations,
  isPending,
  error,
}: BotConversationsCardProps) => {
  const total = conversations?.length ?? 0;

  return (
    <Card className="flex h-full flex-col">
      <CardHeader>
        <CardTitle as="h2" className="flex items-center gap-2">
          <MessageSquareDashed className="size-4 text-primary" aria-hidden="true" />
          {t('notificaciones.conversaciones.titulo')}
        </CardTitle>
        <p className="text-sm text-ink-muted">{t('notificaciones.conversaciones.texto')}</p>
      </CardHeader>

      <CardContent className="min-h-0 flex-1">
        {isPending ? (
          <Spinner label={t('notificaciones.conversaciones.cargando')} showLabel />
        ) : error !== null && error !== undefined ? (
          <Alert variant="danger" title={t('notificaciones.bot.error')}>
            {apiErrorMessage(error)}
          </Alert>
        ) : total === 0 ? (
          <EmptyState
            icon={<MessageSquareDashed className="size-6" aria-hidden="true" />}
            title={t('notificaciones.conversaciones.titulo')}
            description={t('notificaciones.conversaciones.vacio')}
          />
        ) : (
          <Table
            caption={t('notificaciones.conversaciones.total', { total })}
            containerClassName="border-border"
          >
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>{t('notificaciones.conversaciones.columna.chat')}</TableHead>
                <TableHead>{t('notificaciones.conversaciones.columna.paso')}</TableHead>
                <TableHead>{t('notificaciones.conversaciones.columna.actualizada')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {conversations?.map((conversacion) => (
                <TableRow key={`${conversacion.canal}:${conversacion.direccionMasked}`}>
                  <TableCell>
                    <Badge variant="neutral">{t(`comun.canal.${conversacion.canal}`)}</Badge>
                    <span className="block pt-1 font-mono text-xs text-ink-muted">
                      {conversacion.direccionMasked}
                    </span>
                    {conversacion.usuario !== null && (
                      <span className="block text-xs text-ink-subtle">@{conversacion.usuario}</span>
                    )}
                  </TableCell>
                  <TableCell>
                    <Badge variant="info">{botStateLabel(conversacion.state)}</Badge>
                    <span className="flex items-center gap-1.5 pt-1 text-xs text-ink-subtle">
                      <UserRound className="size-3.5" aria-hidden="true" />
                      {conversacion.patientId === null
                        ? t('notificaciones.conversaciones.sinPaciente')
                        : t('notificaciones.conversaciones.paciente')}
                    </span>
                  </TableCell>
                  <TableCell className="text-sm text-ink-muted">
                    <span className="block">{formatDateTime(conversacion.updatedAt)}</span>
                    <span className="block text-xs text-ink-subtle">
                      {formatRelative(conversacion.updatedAt)}
                    </span>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
};
