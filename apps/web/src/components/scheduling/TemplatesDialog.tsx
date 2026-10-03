import {
  expandTemplateSlots,
  formatTime12h,
  weekdayName,
  type SlotTemplate,
} from '@odontocrm/contracts';
import { useQuery } from '@tanstack/react-query';
import { Alert, Badge, Button, Dialog, Spinner } from '@odontocrm/ui';

import { apiErrorMessage } from '../../lib/api';
import { agendaApi } from '../../lib/endpoints';
import { schedulingKeys } from '../../lib/scheduling';
import { t } from '../../lib/i18n';

const ORDEN_SEMANA = [1, 2, 3, 4, 5, 6, 0] as const;

const pausasDe = (plantilla: SlotTemplate): string => {
  if (plantilla.breaks.length === 0) return t('programacion.plantillas.sinPausas');
  return plantilla.breaks
    .map((pausa) => `${formatTime12h(pausa.startTime)} – ${formatTime12h(pausa.endTime)}`)
    .join(', ');
};

/**
 * Plantillas de franjas de la semana (`GET /agenda/templates`): son el origen
 * del cupo y de la rejilla cuando el día no tiene cupo explícito. La vista es
 * informativa y usa `expandTemplateSlots` del contrato para contar las franjas
 * que produce cada plantilla, descartando las pausas.
 */
export const TemplatesDialog = ({ onClose }: { onClose: () => void }) => {
  const plantillasQuery = useQuery({
    queryKey: schedulingKeys.templates,
    queryFn: ({ signal }) => agendaApi.templates(signal),
  });

  const plantillas = [...(plantillasQuery.data?.items ?? [])].sort(
    (izquierda, derecha) =>
      ORDEN_SEMANA.indexOf(izquierda.weekday as (typeof ORDEN_SEMANA)[number]) -
        ORDEN_SEMANA.indexOf(derecha.weekday as (typeof ORDEN_SEMANA)[number]) ||
      izquierda.startTime.localeCompare(derecha.startTime),
  );

  return (
    <Dialog
      open
      onClose={onClose}
      size="lg"
      title={t('programacion.plantillas.titulo')}
      description={t('programacion.plantillas.texto')}
      closeLabel={t('comun.cerrar')}
      footer={
        <Button variant="secondary" onClick={onClose}>
          {t('comun.cerrar')}
        </Button>
      }
    >
      {plantillasQuery.isPending ? (
        <Spinner label={t('programacion.plantillas.cargando')} showLabel />
      ) : plantillasQuery.isError ? (
        <Alert variant="danger" title={t('programacion.plantillas.error')}>
          {apiErrorMessage(plantillasQuery.error)}
        </Alert>
      ) : plantillas.length === 0 ? (
        <Alert variant="info">{t('programacion.plantillas.vacio')}</Alert>
      ) : (
        <ul className="space-y-2">
          {plantillas.map((plantilla) => (
            <li
              key={plantilla.id}
              className="rounded-control border border-border bg-surface p-3 text-sm"
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium text-ink first-letter:uppercase">
                  {weekdayName(plantilla.weekday)}
                </span>
                <Badge variant="neutral">
                  {t('programacion.plantillas.horario', {
                    inicio: formatTime12h(plantilla.startTime),
                    fin: formatTime12h(plantilla.endTime),
                  })}
                </Badge>
                <Badge variant="info">
                  {t('programacion.plantillas.franjas', {
                    total: expandTemplateSlots(plantilla).length,
                    minutos: plantilla.slotMinutes,
                  })}
                </Badge>
                {!plantilla.isActive && (
                  <Badge variant="warning">{t('programacion.plantillas.inactiva')}</Badge>
                )}
              </div>
              <p className="pt-1 text-xs text-ink-subtle">
                {t('programacion.plantillas.pausas', { pausas: pausasDe(plantilla) })}
              </p>
            </li>
          ))}
        </ul>
      )}

      <p className="pt-4 text-xs text-ink-subtle">{t('programacion.plantillas.nota')}</p>
    </Dialog>
  );
};
