import type { AuditEventRecord } from '@odontocrm/contracts';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import {
  Alert,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  EmptyState,
  Spinner,
} from '@odontocrm/ui';
import { RotateCcw, ScrollText } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

import { AuditDiffDialog } from '../components/audit/AuditDiffDialog';
import { AuditExportButton } from '../components/audit/AuditExportButton';
import { AuditFilters } from '../components/audit/AuditFilters';
import { AuditTable } from '../components/audit/AuditTable';
import { NoticeBanner } from '../components/NoticeBanner';
import { useDebouncedValue } from '../hooks/useDebouncedValue';
import { useNotice } from '../hooks/useNotice';
import { apiErrorMessage } from '../lib/api';
import {
  auditKeys,
  emptyAuditFilters,
  summaryLine,
  toQueryParams,
  type AuditFilterState,
} from '../lib/audit';
import { auditApi } from '../lib/endpoints';
import { formatNumber } from '../lib/format';
import { t } from '../lib/i18n';

/** Filas por página del listado (el máximo de la API es 200; la exportación usa otro tamaño). */
const POR_PAGINA = 50;

/**
 * `/auditoria` (Fase 9): bitácora de accesos y de cambios sensibles con búsqueda
 * por rango de fechas, usuario, acción, tipo de entidad, identificador y campo,
 * diff antes/después por evento y exportación CSV de lo filtrado.
 *
 * Solo el rol `admin` tiene `audit:read` (la ruta ya lo exige), así que la
 * pantalla no repite lógica de permisos.
 */
export const AuditoriaPage = () => {
  const [filtros, setFiltros] = useState<AuditFilterState>(emptyAuditFilters);
  const [pagina, setPagina] = useState(1);
  const [seleccionado, setSeleccionado] = useState<AuditEventRecord | null>(null);
  const { notice, limpiar, exito, error } = useNotice();

  // Solo se difieren los textos que se escriben a mano: un `<Select>` o una fecha
  // se aplican al instante, que es lo que espera quien los toca.
  const usuario = useDebouncedValue(filtros.usuario, 350);
  const identificador = useDebouncedValue(filtros.identificador, 350);
  const campo = useDebouncedValue(filtros.campo, 350);
  const { desde, hasta, accion, tipoEntidad } = filtros;

  const parametros = useMemo(
    () => toQueryParams({ desde, hasta, usuario, accion, tipoEntidad, identificador, campo }),
    [desde, hasta, usuario, accion, tipoEntidad, identificador, campo],
  );

  // Cualquier cambio de filtro vuelve a la primera página (`parametros` cambia de
  // identidad solo cuando cambia un valor, así que este efecto no pelea con los
  // botones de paginación).
  useEffect(() => {
    setPagina(1);
  }, [parametros]);

  const consulta = useQuery({
    queryKey: auditKeys.events({ ...parametros, page: pagina, pageSize: POR_PAGINA }),
    queryFn: ({ signal }) =>
      auditApi.events({ ...parametros, page: pagina, pageSize: POR_PAGINA }, signal),
    placeholderData: keepPreviousData,
  });

  const datos = consulta.data;
  const total = datos?.total ?? 0;
  const totalPaginas = datos?.totalPages ?? 1;
  const resumen = summaryLine({
    page: datos?.page ?? pagina,
    pageSize: datos?.pageSize ?? POR_PAGINA,
    total,
  });

  const limpiarFiltros = (): void => setFiltros(emptyAuditFilters());

  /** «Ver todo de esta entidad»: deja solo los filtros de esa entidad. */
  const filtrarPorEntidad = (entidad: string, id: string): void => {
    setFiltros({ ...emptyAuditFilters(), tipoEntidad: entidad, identificador: id });
    setSeleccionado(null);
  };

  return (
    <div className="space-y-5">
      <NoticeBanner notice={notice} onClose={limpiar} />

      <Card>
        <CardHeader className="gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div className="flex-1">
            <CardTitle as="h2">{t('auditoria.titulo')}</CardTitle>
            <p className="pt-1 text-sm text-ink-muted">{t('auditoria.descripcion')}</p>
          </div>
          <AuditExportButton
            params={parametros}
            onDone={() => exito(t('auditoria.exportacion.lista'))}
            onError={(mensaje) => error(mensaje, t('auditoria.exportacion.error'))}
          />
        </CardHeader>

        <CardContent className="space-y-4">
          <AuditFilters value={filtros} onChange={setFiltros} onClear={limpiarFiltros} />

          {consulta.isError && (
            <Alert variant="danger" title={t('auditoria.error')}>
              <p>{apiErrorMessage(consulta.error)}</p>
              <div className="pt-2">
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => void consulta.refetch()}
                  leadingIcon={<RotateCcw className="size-4" aria-hidden="true" />}
                >
                  {t('comun.reintentar')}
                </Button>
              </div>
            </Alert>
          )}

          {consulta.isPending ? (
            <div className="py-10">
              <Spinner label={t('auditoria.cargando')} showLabel />
            </div>
          ) : datos === undefined ? null : datos.items.length === 0 ? (
            <EmptyState
              icon={<ScrollText className="size-6" aria-hidden="true" />}
              title={t('auditoria.vacio.titulo')}
              description={t('auditoria.vacio.texto')}
            />
          ) : (
            <AuditTable events={datos.items} onSelect={setSeleccionado} caption={resumen} />
          )}

          {datos !== undefined && (
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-xs text-ink-subtle" aria-live="polite">
                {resumen}
              </p>
              <div className="flex items-center gap-2">
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={pagina <= 1 || consulta.isFetching}
                  onClick={() => setPagina((valor) => Math.max(1, valor - 1))}
                >
                  {t('auditoria.anterior')}
                </Button>
                <span className="text-xs text-ink-muted">
                  {t('auditoria.paginacion', {
                    pagina: formatNumber(pagina),
                    paginas: formatNumber(totalPaginas),
                  })}
                </span>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={pagina >= totalPaginas || consulta.isFetching}
                  onClick={() => setPagina((valor) => valor + 1)}
                >
                  {t('auditoria.siguiente')}
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <AuditDiffDialog
        open={seleccionado !== null}
        evento={seleccionado}
        onClose={() => setSeleccionado(null)}
        onFiltrarEntidad={filtrarPorEntidad}
      />
    </div>
  );
};
