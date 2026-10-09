import { formatTime12h, type AppointmentActivityKind } from '@odontocrm/contracts';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Spinner,
} from '@odontocrm/ui';
import { useQuery } from '@tanstack/react-query';
import { CalendarCheck, CalendarClock, CalendarX2 } from 'lucide-react';
import { useState } from 'react';

import { apiErrorMessage } from '../../lib/api';
import { appointmentsApi } from '../../lib/endpoints';
import { formatDate, formatRelative } from '../../lib/format';
import { t } from '../../lib/i18n';

/** Cuántas se piden y cuántas se ven antes de desplegar (ADR 0057). */
const PEDIDAS = 20;
const VISIBLES = 5;
/** Refresco del feed: los pacientes escriben al bot en cualquier momento. */
const REFRESCO_MS = 30_000;

const ICONOS: Readonly<Record<AppointmentActivityKind, typeof CalendarCheck>> = {
  confirmada: CalendarCheck,
  cancelada: CalendarX2,
  confirmada_y_cancelada: CalendarClock,
};

const VARIANTES: Readonly<Record<AppointmentActivityKind, 'success' | 'warning' | 'neutral'>> = {
  confirmada: 'success',
  cancelada: 'neutral',
  confirmada_y_cancelada: 'warning',
};

const etiqueta = (kind: AppointmentActivityKind): string => {
  if (kind === 'confirmada') return t('inicio.novedades.confirmada');
  if (kind === 'cancelada') return t('inicio.novedades.cancelada');
  return t('inicio.novedades.confirmadaYCancelada');
};

/**
 * **Novedades** del inicio (ADR 0057): lo último que hicieron los pacientes con sus
 * citas por Telegram o WhatsApp.
 *
 * Trae las últimas 20 y muestra 5: la tarjeta es un vistazo, no un listado (para eso
 * está `/programacion`, con sus pestañas de citas y cancelaciones). El botón despliega
 * el resto sin salir del inicio.
 *
 * Solo se monta si el usuario tiene `scheduling:read` (`admin`, secretaría y
 * odontólogo); la API exige lo mismo.
 */
export const HomeActivityCard = () => {
  const [desplegado, setDesplegado] = useState(false);

  const consulta = useQuery({
    queryKey: ['inicio', 'novedades'],
    queryFn: ({ signal }) => appointmentsApi.activity({ limit: PEDIDAS }, signal),
    refetchInterval: REFRESCO_MS,
  });

  const items = consulta.data?.items ?? [];
  const visibles = desplegado ? items : items.slice(0, VISIBLES);

  return (
    <Card>
      <CardHeader>
        <CardTitle as="h2" className="flex items-center gap-2">
          <CalendarClock className="size-4 text-primary" aria-hidden="true" />
          {t('inicio.novedades.titulo')}
        </CardTitle>
        <CardDescription>{t('inicio.novedades.descripcion')}</CardDescription>
      </CardHeader>

      <CardContent className="space-y-3">
        {consulta.isError ? (
          <Alert variant="danger" title={t('inicio.novedades.error')}>
            {apiErrorMessage(consulta.error)}
          </Alert>
        ) : consulta.isPending ? (
          <Spinner label={t('inicio.novedades.cargando')} showLabel />
        ) : items.length === 0 ? (
          <p className="text-sm text-ink-muted">{t('inicio.novedades.vacio')}</p>
        ) : (
          <>
            <ul id="novedades-lista" className="flex flex-col gap-2">
              {visibles.map((novedad) => {
                const Icono = ICONOS[novedad.kind];
                return (
                  <li
                    key={novedad.id}
                    className="flex items-start gap-3 rounded-control border border-border bg-surface-muted/50 p-3"
                  >
                    <Icono className="mt-0.5 size-4 shrink-0 text-ink-muted" aria-hidden="true" />
                    <div className="min-w-0 flex-1">
                      <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-ink">
                        <span className="font-medium">{novedad.patientName}</span>
                        <span className="text-ink-muted">{etiqueta(novedad.kind)}</span>
                        <Badge variant={VARIANTES[novedad.kind]}>
                          {t(`comun.canal.${novedad.channel}`)}
                        </Badge>
                      </p>
                      <p className="pt-0.5 text-xs text-ink-subtle">
                        {t('notificaciones.citas.columna.fecha')}: {formatDate(novedad.date)} ·{' '}
                        {formatTime12h(novedad.startTime)} · {formatRelative(novedad.occurredAt)}
                      </p>
                    </div>
                  </li>
                );
              })}
            </ul>

            {items.length > VISIBLES && (
              <Button
                variant="ghost"
                size="sm"
                aria-expanded={desplegado}
                aria-controls="novedades-lista"
                onClick={() => setDesplegado((valor) => !valor)}
              >
                {desplegado
                  ? t('inicio.novedades.verMenos')
                  : t('inicio.novedades.verTodas', { total: items.length })}
              </Button>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
};
