import type { HealthCheckResult, SystemHealthService } from '@odontocrm/contracts';
import { Badge, Button, Card, CardContent, CardHeader, CardTitle, Spinner } from '@odontocrm/ui';
import { useQuery } from '@tanstack/react-query';
import { Activity, CircleAlert, CircleCheck, CircleX, RefreshCw } from 'lucide-react';

import { apiErrorMessage } from '../../lib/api';
import {
  SYSTEM_HEALTH_QUERY_KEY,
  SYSTEM_HEALTH_REFRESH_MS,
  fetchSystemHealth,
} from '../../lib/system';
import { t } from '../../lib/i18n';

/**
 * Panel de **estado del sistema**, solo para el administrador (mejora 1 del plan
 * post-Fase 11).
 *
 * Hasta ahora, saber si un consumidor de eventos se había atascado o si un servicio tenía
 * la base a medio gas obligaba a entrar por SSH y leer registros: el `/ready` de cada
 * servicio existía, pero nadie lo miraba desde la interfaz. Aquí se ve de un vistazo qué
 * servicio responde, cuánto tarda, cuántas conexiones usa y cuántos eventos tiene sin
 * publicar —y, sobre todo, **cuál** está mal, que es lo que faltaba—.
 *
 * La consulta se hace solo cuando este panel se pinta (el rol ya lo comprueba el gateway,
 * pero pedir un 403 en cada carga del inicio sería ruido). Se refresca cada medio minuto
 * mientras está abierto.
 */
export const SystemHealthPanel = () => {
  const consulta = useQuery({
    queryKey: SYSTEM_HEALTH_QUERY_KEY,
    queryFn: ({ signal }) => fetchSystemHealth(signal),
    refetchInterval: SYSTEM_HEALTH_REFRESH_MS,
    staleTime: SYSTEM_HEALTH_REFRESH_MS / 2,
    retry: false,
  });

  if (consulta.isPending) {
    return (
      <Card>
        <CardHeader>
          <CardTitle as="h2">{t('sistema.titulo')}</CardTitle>
        </CardHeader>
        <CardContent>
          <Spinner label={t('sistema.cargando')} showLabel />
        </CardContent>
      </Card>
    );
  }

  if (consulta.isError) {
    return (
      <Card>
        <CardHeader>
          <CardTitle as="h2">{t('sistema.titulo')}</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="rounded-control border border-danger/40 bg-danger/5 px-4 py-3 text-sm text-danger">
            {apiErrorMessage(consulta.error)}
          </p>
        </CardContent>
      </Card>
    );
  }

  const informe = consulta.data;

  return (
    <Card>
      <CardHeader className="gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-1">
          <CardTitle as="h2">{t('sistema.titulo')}</CardTitle>
          <p className="text-sm text-ink-muted">{t('sistema.texto')}</p>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant={tonoDelEstado(informe.gateway.status)}>
            {t(`sistema.estado.${informe.gateway.status}`)}
          </Badge>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            leadingIcon={<RefreshCw className="size-4" aria-hidden />}
            disabled={consulta.isFetching}
            onClick={() => void consulta.refetch()}
          >
            {t('sistema.refrescar')}
          </Button>
        </div>
      </CardHeader>

      <CardContent className="space-y-4">
        <dl className="flex flex-wrap gap-x-6 gap-y-2 text-sm">
          <Dato etiqueta={t('sistema.total.ok')} valor={String(informe.totals.ok)} />
          <Dato etiqueta={t('sistema.total.error')} valor={String(informe.totals.error)} />
          <Dato
            etiqueta={t('sistema.total.sinRespuesta')}
            valor={String(informe.totals.unreachable)}
          />
          <Dato
            etiqueta={t('sistema.total.outbox')}
            valor={String(informe.totals.conOutboxAtrasado)}
          />
          <Dato
            etiqueta={t('sistema.total.latencia')}
            valor={`${String(informe.totals.latenciaMediaMs)} ms`}
          />
        </dl>

        <ul className="divide-y divide-border">
          {informe.services.map((servicio) => (
            <FilaServicio key={servicio.name} servicio={servicio} />
          ))}
        </ul>
      </CardContent>
    </Card>
  );
};

const Dato = ({ etiqueta, valor }: { etiqueta: string; valor: string }) => (
  <div>
    <dt className="text-xs uppercase tracking-wide text-ink-subtle">{etiqueta}</dt>
    <dd className="font-medium text-ink">{valor}</dd>
  </div>
);

const tonoDelEstado = (estado: string): 'success' | 'warning' | 'danger' =>
  estado === 'ok' ? 'success' : estado === 'degraded' ? 'warning' : 'danger';

/** Icono del semáforo: verde si responde bien, ámbar si responde a medias, rojo si no está. */
const IconoEstado = ({ servicio }: { servicio: SystemHealthService }) => {
  if (!servicio.reachable) return <CircleX className="size-4 shrink-0 text-danger" aria-hidden />;
  if (servicio.status === 'ok')
    return <CircleCheck className="size-4 shrink-0 text-success" aria-hidden />;
  return <CircleAlert className="size-4 shrink-0 text-warning" aria-hidden />;
};

/** Las cifras de un chequeo, ya en texto (`pool 3/10 · 2 libres · 0 en espera`). */
const detallesEnTexto = (check: HealthCheckResult): string | null => {
  const detalles = check.details;
  if (detalles === undefined) return null;

  if (check.name === 'database') {
    const total = detalles['total'];
    const max = detalles['max'];
    const idle = detalles['idle'];
    const waiting = detalles['waiting'];
    const partes = [
      max === undefined
        ? `${String(total)} conexiones`
        : `${String(total)}/${String(max)} conexiones`,
      `${String(idle ?? 0)} libres`,
    ];
    // Las que esperan son las que duelen: solo se nombran cuando las hay.
    if (typeof waiting === 'number' && waiting > 0) partes.push(`${String(waiting)} en espera`);
    return partes.join(' · ');
  }

  if (check.name === 'outbox') {
    const pendientes = detalles['pendientes'];
    const segundos = detalles['masAntiguoSegundos'];
    if (pendientes === undefined) return null;
    const base = `${String(pendientes)} sin publicar`;
    return typeof segundos === 'number' && pendientes !== 0
      ? `${base} · el más antiguo hace ${String(segundos)} s`
      : base;
  }

  return null;
};

const FilaServicio = ({ servicio }: { servicio: SystemHealthService }) => {
  const fallos = servicio.checks.filter((check) => check.status === 'error');
  const cifras = servicio.checks
    .map((check) => {
      const texto = detallesEnTexto(check);
      return texto === null ? null : `${check.name}: ${texto}`;
    })
    .filter((linea): linea is string => linea !== null);

  return (
    <li className="space-y-1 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <IconoEstado servicio={servicio} />
        <span className="font-medium text-ink">{servicio.name}</span>
        <span className="text-xs text-ink-subtle">
          {servicio.reachable
            ? `${String(servicio.latencyMs)} ms${servicio.version === null ? '' : ` · v${servicio.version}`}`
            : t('sistema.sinRespuesta')}
        </span>
      </div>

      {servicio.error !== null && (
        <p className="break-words text-xs text-danger">{servicio.error}</p>
      )}

      {fallos.map((fallo) => (
        <p key={fallo.name} className="text-xs text-danger">
          <Activity className="mr-1 inline size-3" aria-hidden />
          {fallo.name}: {fallo.message ?? t('sistema.checkFallido')}
        </p>
      ))}

      {cifras.length > 0 && <p className="text-xs text-ink-muted">{cifras.join(' · ')}</p>}
    </li>
  );
};
