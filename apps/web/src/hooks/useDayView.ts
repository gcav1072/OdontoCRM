import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import type { DayView } from '@odontocrm/contracts';

import { agendaApi } from '../lib/endpoints';
import { schedulingKeys } from '../lib/scheduling';

/**
 * Vista de la jornada de un día. Se usa desde la página y desde los diálogos de
 * asignación y reprogramación: como la clave es la fecha, cambiar de día en el
 * diálogo reutiliza la caché del mismo día y no vuelve a pedirla.
 */
export const useDayView = (date: string, enabled = true): UseQueryResult<DayView> =>
  useQuery({
    queryKey: schedulingKeys.day(date),
    queryFn: ({ signal }) => agendaApi.day(date, signal),
    enabled: enabled && date.length === 10,
  });
