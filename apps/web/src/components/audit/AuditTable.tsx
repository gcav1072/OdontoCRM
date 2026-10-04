import type { AuditEventRecord } from '@odontocrm/contracts';
import {
  Badge,
  Button,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@odontocrm/ui';

import { actionLabel, changedFieldsLabel, entityTypeLabel } from '../../lib/audit';
import { formatDateTime } from '../../lib/format';
import { t } from '../../lib/i18n';

export interface AuditTableProps {
  events: readonly AuditEventRecord[];
  onSelect: (event: AuditEventRecord) => void;
  /** Línea del contador («1–50 de 320»): es el `caption` de la tabla. */
  caption: string;
}

/** Primeros 8 caracteres de un UUID: suficiente para reconocerlo sin ocupar media celda. */
const idCorto = (id: string): string => (id.length > 8 ? `${id.slice(0, 8)}…` : id);

/**
 * Tabla de eventos de auditoría: fecha, usuario, acción, entidad, resumen, motivo
 * e indicador de campos cambiados.
 *
 * Cada fila abre el detalle al pulsarla, pero **la fila no es el control**: el
 * botón «Ver detalle» de la última celda es el que recibe el foco y el que anuncia
 * el lector de pantalla (una `<tr>` con `onClick` no se puede enfocar ni activar
 * con Enter sin inventarle un rol que rompería la tabla).
 */
export const AuditTable = ({ events, onSelect, caption }: AuditTableProps) => (
  <Table caption={caption}>
    <TableHeader>
      <TableRow className="hover:bg-transparent">
        <TableHead>{t('auditoria.tabla.fecha')}</TableHead>
        <TableHead>{t('auditoria.tabla.usuario')}</TableHead>
        <TableHead>{t('auditoria.tabla.accion')}</TableHead>
        <TableHead>{t('auditoria.tabla.entidad')}</TableHead>
        <TableHead>{t('auditoria.tabla.resumen')}</TableHead>
        <TableHead>{t('auditoria.tabla.motivo')}</TableHead>
        <TableHead>{t('auditoria.tabla.campos')}</TableHead>
        <TableHead className="text-right">{t('auditoria.tabla.detalle')}</TableHead>
      </TableRow>
    </TableHeader>

    <TableBody>
      {events.map((event) => (
        <TableRow key={event.id} className="cursor-pointer" onClick={() => onSelect(event)}>
          <TableCell className="text-sm whitespace-nowrap text-ink-muted">
            {formatDateTime(event.occurredAt)}
          </TableCell>

          <TableCell className="text-sm text-ink">
            {event.actorUsername ?? t('comun.sinDato')}
          </TableCell>

          <TableCell className="text-sm font-medium text-ink">
            {actionLabel(event.action)}
          </TableCell>

          <TableCell>
            <span className="block text-sm text-ink">{entityTypeLabel(event.entityType)}</span>
            {event.entityId !== null && (
              <span className="block font-mono text-xs text-ink-subtle" title={event.entityId}>
                {idCorto(event.entityId)}
              </span>
            )}
          </TableCell>

          <TableCell className="max-w-xs">
            <span className="block truncate text-sm text-ink-muted" title={event.summary ?? ''}>
              {event.summary ?? t('comun.sinDato')}
            </span>
          </TableCell>

          <TableCell className="max-w-xs">
            <span className="block truncate text-sm text-ink-muted" title={event.reason ?? ''}>
              {event.reason ?? t('comun.sinDato')}
            </span>
          </TableCell>

          <TableCell>
            {event.changedFields.length === 0 ? (
              <span className="text-sm text-ink-muted">{t('comun.sinDato')}</span>
            ) : (
              <Badge variant="info" title={event.changedFields.join(', ')}>
                {changedFieldsLabel(event.changedFields.length)}
              </Badge>
            )}
          </TableCell>

          <TableCell>
            <span className="flex justify-end">
              <Button
                variant="ghost"
                size="sm"
                aria-label={t('auditoria.tabla.detalleAria', {
                  texto: event.summary ?? actionLabel(event.action),
                })}
                onClick={() => onSelect(event)}
              >
                {t('auditoria.tabla.detalle')}
              </Button>
            </span>
          </TableCell>
        </TableRow>
      ))}
    </TableBody>
  </Table>
);
