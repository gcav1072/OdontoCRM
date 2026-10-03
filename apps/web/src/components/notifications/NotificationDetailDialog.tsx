import type { NotificationRecord } from '@odontocrm/contracts';
import {
  Alert,
  Badge,
  Button,
  Dialog,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@odontocrm/ui';
import type { ReactNode } from 'react';

import { formatDateTime, formatNumber } from '../../lib/format';
import { CHANNEL_LABELS, t, templateName } from '../../lib/i18n';
import {
  notificationMessage,
  notificationPayloadEntries,
  notificationPayloadFields,
} from '../../lib/notifications';
import { DescriptionList } from './DescriptionList';
import { NotificationStatusBadge } from './NotificationStatusBadge';

export interface NotificationDetailDialogProps {
  record: NotificationRecord;
  onClose: () => void;
}

/**
 * Detalle de un envío: el mensaje que se mandó (o se mandará) al paciente, los
 * datos con los que se preparó y el rastro de intentos, errores y contacto
 * manual.
 *
 * El texto se muestra renderizado con los valores del `payload`; si el servidor
 * no incluye el cuerpo, se dice claramente en vez de dejar el hueco en blanco.
 */
export const NotificationDetailDialog = ({ record, onClose }: NotificationDetailDialogProps) => {
  const campos = notificationPayloadFields(record.payload);
  const mensaje = notificationMessage(record);
  const datos = notificationPayloadEntries(record.payload);

  const filas: (readonly [string, ReactNode])[] = [
    [t('notificaciones.detalle.plantilla'), templateName(record.templateKey)],
    [t('notificaciones.detalle.canal'), CHANNEL_LABELS[record.channel]],
    [t('notificaciones.detalle.destino'), record.recipient ?? t('comun.sinDato')],
    [t('notificaciones.detalle.creado'), `${formatDateTime(record.createdAt)}`],
    [t('notificaciones.detalle.enviado'), formatDateTime(record.sentAt)],
    [
      t('notificaciones.detalle.intentos'),
      `${formatNumber(record.attempts)}/${formatNumber(record.maxAttempts)}`,
    ],
  ];

  if (campos.ticket !== null) filas.push([t('notificaciones.detalle.ticket'), campos.ticket]);
  if (campos.date !== null) filas.push([t('notificaciones.detalle.fecha'), campos.date]);
  if (campos.time !== null) filas.push([t('notificaciones.detalle.hora'), campos.time]);
  if (campos.place !== null) filas.push([t('notificaciones.detalle.lugar'), campos.place]);

  return (
    <Dialog
      open
      onClose={onClose}
      size="lg"
      title={t('notificaciones.detalle.titulo')}
      description={`${record.patientName ?? t('comun.desconocido')} · ${t('notificaciones.detalle.texto')}`}
      closeLabel={t('comun.cerrar')}
      footer={
        <Button variant="secondary" onClick={onClose}>
          {t('comun.cerrar')}
        </Button>
      }
    >
      <div className="space-y-5">
        <div className="flex flex-wrap items-center gap-2">
          <NotificationStatusBadge status={record.status} />
          <Badge variant="neutral">{CHANNEL_LABELS[record.channel]}</Badge>
          <Badge variant="primary">{templateName(record.templateKey)}</Badge>
          {record.contactedAt !== null && (
            <Badge variant="success">
              {record.contactedBy === null
                ? t('notificaciones.bandeja.contactoHechoSinActor', {
                    fecha: formatDateTime(record.contactedAt),
                  })
                : t('notificaciones.bandeja.contactoHecho', {
                    fecha: formatDateTime(record.contactedAt),
                    actor: record.contactedBy,
                  })}
            </Badge>
          )}
        </div>

        {record.status === 'skipped_no_channel' && (
          <Alert variant="warning">{t('notificaciones.estado.avisoManual')}</Alert>
        )}

        <section className="space-y-2">
          <h3 className="text-sm font-semibold text-ink">{t('notificaciones.detalle.mensaje')}</h3>
          {mensaje === null ? (
            <Alert variant="info">{t('notificaciones.detalle.sinMensaje')}</Alert>
          ) : (
            <p className="rounded-control border border-border bg-surface-muted px-3.5 py-3 text-sm whitespace-pre-wrap text-ink">
              {mensaje}
            </p>
          )}
        </section>

        <DescriptionList items={filas} />

        {record.lastError !== null && (
          <Alert variant="danger" title={t('notificaciones.detalle.error')}>
            {record.lastError}
          </Alert>
        )}

        {record.manualNote !== null && (
          <Alert variant="success" title={t('notificaciones.detalle.nota')}>
            {record.manualNote}
          </Alert>
        )}

        {record.nextAttemptAt !== null && record.status !== 'sent' && (
          <p className="text-sm text-ink-muted">
            {t('notificaciones.bandeja.proximoIntento', {
              cuando: formatDateTime(record.nextAttemptAt),
            })}
          </p>
        )}

        {datos.length > 0 && (
          <section className="space-y-2">
            <h3 className="text-sm font-semibold text-ink">{t('notificaciones.detalle.datos')}</h3>
            <Table containerClassName="border-border">
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead>{t('notificaciones.detalle.dato')}</TableHead>
                  <TableHead>{t('notificaciones.detalle.valor')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {datos.map(([clave, valor]) => (
                  <TableRow key={clave}>
                    <TableHead scope="row" className="font-mono text-xs normal-case text-ink-muted">
                      {clave}
                    </TableHead>
                    <TableCell className="text-sm break-words text-ink">{valor}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </section>
        )}
      </div>
    </Dialog>
  );
};
