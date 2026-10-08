import { formatTime12h, type AppointmentSummary } from '@odontocrm/contracts';
import {
  Alert,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  EmptyState,
  Field,
  Input,
  Spinner,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@odontocrm/ui';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { CalendarX, RefreshCw } from 'lucide-react';
import { useEffect, useState } from 'react';

import { apiErrorMessage } from '../../lib/api';
import { appointmentsApi, type AppointmentCancellationsParams } from '../../lib/endpoints';
import { formatRelative } from '../../lib/format';
import { CHANNEL_LABELS, t } from '../../lib/i18n';
import { formatDateOnly, schedulingKeys, todayInClinic } from '../../lib/scheduling';

const TAMANO_PAGINA = 20;
/** Días hacia atrás que se miran por defecto. */
const DIAS_POR_DEFECTO = 30;

/** Fecha `AAAA-MM-DD` desplazada N días (aritmética de calendario, no de instantes). */
const desplazar = (date: string, dias: number): string =>
  new Date(new Date(`${date}T00:00:00Z`).getTime() + dias * 86_400_000).toISOString().slice(0, 10);

/** Cita tal como la pinta esta tarjeta: la fecha original y cuándo se canceló. */
const horario = (cita: AppointmentSummary): string =>
  `${formatDateOnly(cita.date)} · ${formatTime12h(cita.startTime)}`;

/**
 * **Canceladas por el paciente** (ADR 0053): la mini-sección de `/programacion` que
 * recoge las citas que el propio paciente revocó desde el bot (Telegram o WhatsApp).
 *
 * Solo aparece lo cancelado por un **canal de paciente**: las que anula la secretaría
 * ya son conocimiento del consultorio y no se mezclan aquí. Al cancelar el paciente, su
 * ticket vuelve a la cola, así que esta tarjeta es la vista de «quién se cayó y hay que
 * reubicar».
 */
export const PatientCancellationsCard = () => {
  const hoy = todayInClinic();
  const [desde, setDesde] = useState(() => desplazar(hoy, -DIAS_POR_DEFECTO));
  const [hasta, setHasta] = useState(hoy);
  const [pagina, setPagina] = useState(1);

  // Cambiar el rango devuelve a la primera página.
  useEffect(() => {
    setPagina(1);
  }, [desde, hasta]);

  const consulta: AppointmentCancellationsParams = {
    from: desde === '' ? undefined : desde,
    to: hasta === '' ? undefined : hasta,
    page: pagina,
    pageSize: TAMANO_PAGINA,
  };

  const query = useQuery({
    queryKey: schedulingKeys.cancellations(consulta),
    queryFn: ({ signal }) => appointmentsApi.cancellations(consulta, signal),
    placeholderData: keepPreviousData,
  });

  const pagina1 = query.data;
  const total = pagina1?.total ?? 0;
  const paginas = pagina1?.totalPages ?? 1;

  return (
    <Card>
      <CardHeader>
        <CardTitle as="h2" className="flex items-center gap-2">
          <CalendarX className="size-4 text-primary" aria-hidden="true" />
          {t('programacion.cancelaciones.titulo')}
        </CardTitle>
        <p className="text-sm text-ink-muted">{t('programacion.cancelaciones.descripcion')}</p>
      </CardHeader>

      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-end gap-3">
          <Field label={t('programacion.cancelaciones.desde')} className="w-44">
            <Input type="date" value={desde} onChange={(event) => setDesde(event.target.value)} />
          </Field>
          <Field label={t('programacion.cancelaciones.hasta')} className="w-44">
            <Input type="date" value={hasta} onChange={(event) => setHasta(event.target.value)} />
          </Field>
          <Button
            variant="secondary"
            loading={query.isFetching}
            loadingLabel={t('programacion.cancelaciones.cargando')}
            onClick={() => {
              void query.refetch();
            }}
            leadingIcon={<RefreshCw className="size-4" aria-hidden="true" />}
          >
            {t('programacion.cancelaciones.recargar')}
          </Button>
        </div>

        {query.isPending ? (
          <Spinner label={t('programacion.cancelaciones.cargando')} showLabel />
        ) : query.isError ? (
          <Alert variant="danger" title={t('programacion.cancelaciones.error')}>
            {apiErrorMessage(query.error)}
          </Alert>
        ) : total === 0 ? (
          <EmptyState
            icon={<CalendarX className="size-6" aria-hidden="true" />}
            title={t('programacion.cancelaciones.titulo')}
            description={t('programacion.cancelaciones.vacio')}
          />
        ) : (
          <>
            <Table
              caption={t('programacion.cancelaciones.total', { total })}
              containerClassName="border-border"
            >
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead>{t('programacion.cancelaciones.columna.paciente')}</TableHead>
                  <TableHead>{t('programacion.cancelaciones.columna.ticket')}</TableHead>
                  <TableHead>{t('programacion.cancelaciones.columna.cita')}</TableHead>
                  <TableHead>{t('programacion.cancelaciones.columna.cancelada')}</TableHead>
                  <TableHead>{t('programacion.cancelaciones.columna.canal')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {pagina1?.items.map((cita) => (
                  <TableRow key={cita.id}>
                    <TableCell className="text-sm text-ink">{cita.patientName}</TableCell>
                    <TableCell className="font-mono text-xs text-ink-muted">
                      {cita.ticket ?? t('comun.sinDato')}
                    </TableCell>
                    <TableCell className="text-sm text-ink-muted">{horario(cita)}</TableCell>
                    <TableCell className="text-sm text-ink-muted">
                      {cita.cancelledAt === null
                        ? t('comun.sinDato')
                        : formatRelative(cita.cancelledAt)}
                    </TableCell>
                    <TableCell className="text-sm text-ink-muted">
                      {cita.cancelledChannel === null
                        ? t('comun.sinDato')
                        : CHANNEL_LABELS[cita.cancelledChannel]}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>

            {paginas > 1 && (
              <div className="flex items-center justify-between gap-3 text-sm text-ink-muted">
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={pagina <= 1}
                  onClick={() => setPagina((valor) => Math.max(1, valor - 1))}
                >
                  {t('programacion.cancelaciones.anterior')}
                </Button>
                <span>{t('programacion.cancelaciones.pagina', { pagina, paginas })}</span>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={pagina >= paginas}
                  onClick={() => setPagina((valor) => Math.min(paginas, valor + 1))}
                >
                  {t('programacion.cancelaciones.siguiente')}
                </Button>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
};
