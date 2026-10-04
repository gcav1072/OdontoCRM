import type { ReportKey } from '@odontocrm/contracts';
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
import { ChartColumn, RefreshCw } from 'lucide-react';
import { useMemo, useState } from 'react';

import { NoticeBanner } from '../components/NoticeBanner';
import { ReportChart } from '../components/reports/ReportChart';
import { ReportExportBar } from '../components/reports/ReportExportBar';
import { ReportFilters } from '../components/reports/ReportFilters';
import { ReportKpis } from '../components/reports/ReportKpis';
import { ReportTable } from '../components/reports/ReportTable';
import { ReportTabs, reportPanelId, reportTabId } from '../components/reports/ReportTabs';
import { useNotice } from '../hooks/useNotice';
import { apiErrorMessage } from '../lib/api';
import { reportsApi } from '../lib/endpoints';
import { formatDateTime } from '../lib/format';
import { t } from '../lib/i18n';
import {
  blockedReportKeys,
  defaultReportFilters,
  formatIsoDay,
  hasReportData,
  isDateRangeInverted,
  reportKeys,
  reportRangeLabel,
  summaryKpis,
  toQueryParams,
  visibleReportKeys,
  type ReportFiltersState,
} from '../lib/reports';
import { useAuth } from '../providers/AuthProvider';

/**
 * `/reportes` (Fase 9, [ADR 0019](../../../../docs/adr/0019-reportes-y-kpis.md)).
 *
 * Una sola pantalla para los seis reportes del catálogo: arriba el tablero del
 * día (`GET /reports/summary`), debajo las pestañas, los filtros comunes y el
 * documento del reporte activo (KPIs, gráficas y tabla) con su exportación.
 *
 * Todo lo que se pinta viene del contrato —títulos, cifras, series, columnas y
 * notas—, así que un reporte nuevo del servicio no necesita tocar la interfaz.
 * Los clínicos (perfil clínico, salud bucal y récipes) solo se abren con
 * `reports:clinical`: sin él se ven deshabilitados y se explica por qué.
 */
export const ReportesPage = () => {
  const { hasPermission } = useAuth();
  const { notice, exito, error: avisarError, limpiar } = useNotice();

  const [activo, setActivo] = useState<ReportKey>('funnel');
  const [filtros, setFiltros] = useState<ReportFiltersState>(() => defaultReportFilters());

  const visibles = useMemo(() => visibleReportKeys(hasPermission), [hasPermission]);
  const bloqueados = useMemo(() => blockedReportKeys(hasPermission), [hasPermission]);
  const hayCatalogo = visibles.length > 0;
  // Si el reporte elegido deja de estar permitido (permisos recargados), se cae
  // al primero que sí lo esté en vez de dejar la pantalla en blanco.
  const claveActiva: ReportKey = visibles.includes(activo) ? activo : (visibles[0] ?? 'funnel');

  const parametros = toQueryParams(filtros);
  const fechasInvertidas = isDateRangeInverted(filtros);

  const resumenQuery = useQuery({
    queryKey: reportKeys.summary(),
    queryFn: ({ signal }) => reportsApi.summary(signal),
  });

  const reporteQuery = useQuery({
    queryKey: reportKeys.document(claveActiva, parametros),
    queryFn: ({ signal }) => reportsApi.document(claveActiva, parametros, signal),
    // Un rango de fechas invertido lo rechaza el contrato: se avisa en los
    // filtros en vez de mandar una consulta que va a fallar.
    enabled: hayCatalogo && !fechasInvertidas,
    placeholderData: keepPreviousData,
  });

  // `keepPreviousData` conserva el documento anterior mientras llega el nuevo:
  // si es de otro reporte no se pinta, porque se verían el título y las cifras
  // de una pestaña bajo otra.
  const documento = reporteQuery.data?.key === claveActiva ? reporteQuery.data : undefined;
  const resumen = resumenQuery.data;

  /** Vuelve a pedir el reporte con los filtros que ya están puestos. */
  const actualizarReporte = (): void => {
    // Con el rango de fechas invertido la consulta está apagada: pedirla a mano
    // solo traería un error del servidor que la pantalla ya está explicando.
    if (fechasInvertidas) return;
    void reporteQuery.refetch();
  };

  const detalleResumen =
    resumen === undefined
      ? ''
      : [
          t('reportes.resumen.fecha', { fecha: formatIsoDay(resumen.date) }),
          resumen.refreshedAt === null
            ? t('reportes.resumen.sinActualizar')
            : t('reportes.resumen.actualizado', { fecha: formatDateTime(resumen.refreshedAt) }),
        ].join(' · ');

  return (
    <div className="space-y-5">
      <NoticeBanner notice={notice} onClose={limpiar} className="mb-0 print:hidden" />

      {/* Tablero del día: no depende de los filtros y no se imprime (el papel
          lleva el reporte elegido, igual que el PDF que genera el servidor). */}
      <Card className="print:hidden">
        <CardHeader className="gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <CardTitle as="h2">{t('reportes.resumen.titulo')}</CardTitle>
            <p className="pt-1 text-sm text-ink-muted">
              {resumenQuery.isPending ? t('reportes.resumen.cargando') : detalleResumen}
            </p>
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void resumenQuery.refetch()}
            loading={resumenQuery.isFetching}
            leadingIcon={<RefreshCw className="size-4" aria-hidden="true" />}
          >
            {t('reportes.filtros.actualizar')}
          </Button>
        </CardHeader>

        <CardContent>
          {resumenQuery.isPending ? (
            <div className="py-8">
              <Spinner label={t('reportes.resumen.cargando')} showLabel />
            </div>
          ) : resumenQuery.isError ? (
            <Alert variant="danger" title={t('reportes.resumen.error')}>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <span>{apiErrorMessage(resumenQuery.error)}</span>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => void resumenQuery.refetch()}
                  leadingIcon={<RefreshCw className="size-4" aria-hidden="true" />}
                >
                  {t('comun.reintentar')}
                </Button>
              </div>
            </Alert>
          ) : (
            resumen !== undefined && <ReportKpis kpis={summaryKpis(resumen)} />
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="print:hidden">
          <CardTitle as="h2">{t('reportes.titulo')}</CardTitle>
          <p className="text-sm text-ink-muted">{t('reportes.descripcion')}</p>
        </CardHeader>

        <CardContent className="space-y-4">
          {hayCatalogo && (
            <ReportTabs
              keys={visibles}
              blockedKeys={bloqueados}
              active={claveActiva}
              onSelect={setActivo}
              className="print:hidden"
            />
          )}

          {bloqueados.length > 0 && (
            <Alert
              variant="info"
              title={t('reportes.pestanas.clinicaAvisoTitulo')}
              className="print:hidden"
            >
              {t('reportes.pestanas.clinicaAviso')}
            </Alert>
          )}

          <ReportFilters
            value={filtros}
            onChange={setFiltros}
            onReset={() => setFiltros(defaultReportFilters())}
            onRefresh={actualizarReporte}
            isFetching={reporteQuery.isFetching && !fechasInvertidas}
            className="print:hidden"
          />

          <div
            role="tabpanel"
            id={reportPanelId(claveActiva)}
            /* Sin pestañas (rol sin reportes) no hay `tab` a la que apuntar. */
            aria-labelledby={hayCatalogo ? reportTabId(claveActiva) : undefined}
            tabIndex={-1}
            className="space-y-4"
          >
            {!hayCatalogo ? (
              <EmptyState
                icon={<ChartColumn className="size-6" aria-hidden="true" />}
                title={t('reportes.catalogo.vacioTitulo')}
                description={t('reportes.catalogo.vacio')}
              />
            ) : fechasInvertidas ? (
              <Alert variant="warning" title={t('reportes.filtros.fechasInvalidas')}>
                {t('reportes.filtros.rangoBloqueado')}
              </Alert>
            ) : reporteQuery.isError ? (
              <Alert variant="danger" title={t('reportes.reporte.error')}>
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <span>{apiErrorMessage(reporteQuery.error)}</span>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => void reporteQuery.refetch()}
                    leadingIcon={<RefreshCw className="size-4" aria-hidden="true" />}
                  >
                    {t('comun.reintentar')}
                  </Button>
                </div>
              </Alert>
            ) : documento === undefined ? (
              <div className="py-10">
                <Spinner label={t('reportes.reporte.cargando')} showLabel />
              </div>
            ) : (
              <>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <h3 className="text-lg font-semibold text-ink">{documento.title}</h3>
                    {documento.subtitle !== '' && (
                      <p className="pt-0.5 text-sm text-ink-muted">{documento.subtitle}</p>
                    )}
                    <p className="pt-1 text-xs text-ink-subtle">
                      {reportRangeLabel(documento.range)} ·{' '}
                      {t('reportes.reporte.generado', {
                        fecha: formatDateTime(documento.generatedAt),
                      })}
                      {reporteQuery.isFetching && ` · ${t('reportes.reporte.actualizando')}`}
                    </p>
                  </div>

                  <ReportExportBar
                    reportKey={documento.key}
                    range={documento.range}
                    filters={parametros}
                    onSuccess={exito}
                    onError={avisarError}
                    className="print:hidden"
                  />
                </div>

                {documento.notes.length > 0 && (
                  <div className="space-y-2">
                    {documento.notes.map((nota, indice) => (
                      <Alert key={`${String(indice)}-${nota}`} variant="info">
                        {nota}
                      </Alert>
                    ))}
                  </div>
                )}

                {!hasReportData(documento) ? (
                  <EmptyState
                    icon={<ChartColumn className="size-6" aria-hidden="true" />}
                    title={t('reportes.reporte.vacioTitulo')}
                    description={t('reportes.reporte.vacio')}
                  />
                ) : (
                  <>
                    <ReportKpis title={t('reportes.reporte.kpis')} kpis={documento.kpis} />

                    <div className="space-y-3">
                      <h3 className="text-sm font-semibold text-ink-muted">
                        {t('reportes.reporte.graficas')}
                      </h3>
                      {documento.series.some((serie) => serie.points.length > 0) ? (
                        <div className="grid gap-4 xl:grid-cols-2">
                          {documento.series
                            .filter((serie) => serie.points.length > 0)
                            .map((serie) => (
                              <ReportChart key={serie.id} series={serie} />
                            ))}
                        </div>
                      ) : (
                        <p className="text-sm text-ink-muted">
                          {t('reportes.reporte.sinGraficas')}
                        </p>
                      )}
                    </div>

                    <ReportTable
                      title={t('reportes.reporte.detalle')}
                      table={documento.table}
                      caption={t('reportes.tabla.caption', { reporte: documento.title })}
                    />
                  </>
                )}
              </>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
};
