import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Alert,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  EmptyState,
  Input,
  Spinner,
} from '@odontocrm/ui';
import { Receipt, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';

import { useNotice } from '../hooks/useNotice';
import { apiErrorMessage } from '../lib/api';
import {
  formatUsd,
  lineTotalCents,
  linesReady,
  toDraftItems,
  toEditableLine,
  type EditableLine,
} from '../lib/caja';
import { billingApi } from '../lib/endpoints';
import { formatDateTime } from '../lib/format';
import { t } from '../lib/i18n';
import { useAuth } from '../providers/AuthProvider';

/**
 * La caja (Fase 11, sesión A): la cola del mostrador.
 *
 * A la izquierda, **pendientes de caja**: los borradores que dejó el cierre de cada sesión clínica,
 * con su total y el aviso de partidas sin precio. Al abrir uno, se revisa: corregir cantidades, añadir
 * un bien del arancel o quitar una línea.
 *
 * Emitir (con los dos números y el PDF archivado) y cobrar llegan con el dinero (sesión B); hasta
 * entonces el borrador se prepara y se guarda, pero no se emite.
 */
export const CajaPage = () => {
  const { hasPermission } = useAuth();
  const puedeEscribir = hasPermission('billing:write');
  const { notice, exito, error } = useNotice();
  const cliente = useQueryClient();

  const [abierto, setAbierto] = useState<string | null>(null);
  const [lineas, setLineas] = useState<EditableLine[]>([]);

  const pendientes = useQuery({
    queryKey: ['billing', 'drafts'],
    queryFn: ({ signal }) => billingApi.drafts(signal),
  });
  const catalogo = useQuery({
    queryKey: ['billing', 'catalog'],
    queryFn: ({ signal }) => billingApi.catalog(signal),
  });
  const detalle = useQuery({
    queryKey: ['billing', 'draft', abierto],
    queryFn: ({ signal }) => billingApi.draft(abierto ?? '', signal),
    enabled: abierto !== null,
  });

  useEffect(() => {
    setLineas(detalle.data === undefined ? [] : detalle.data.items.map(toEditableLine));
  }, [detalle.data]);

  const guardar = useMutation({
    mutationFn: () => billingApi.saveDraft(abierto ?? '', { items: toDraftItems(lineas) }),
    onSuccess: async (guardado) => {
      exito(t('caja.guardado'));
      setLineas(guardado.items.map(toEditableLine));
      await cliente.invalidateQueries({ queryKey: ['billing'] });
    },
    onError: (fallo: unknown) => error(apiErrorMessage(fallo)),
  });

  const cambiar = (indice: number, cambio: Partial<EditableLine>): void => {
    setLineas((actuales) =>
      actuales.map((linea, posicion) => (posicion === indice ? { ...linea, ...cambio } : linea)),
    );
  };

  const anadirDelCatalogo = (code: string): void => {
    const item = catalogo.data?.items.find((entrada) => entrada.code === code);
    if (item === undefined) return;
    setLineas((actuales) => [
      ...actuales,
      {
        code: item.code,
        description: item.name,
        toothNumber: null,
        surfaces: [],
        quantity: 1,
        priceText: item.priceCentsUsd === 0 ? '' : formatUsd(item.priceCentsUsd),
        needsPricing: item.priceCentsUsd === 0,
      },
    ]);
  };

  const lista = pendientes.data?.items ?? [];
  const totalDetalle = detalle.data?.totalCentsUsd ?? 0;

  return (
    <div className="space-y-6">
      <header className="flex items-center gap-3">
        <Receipt className="size-6 text-brand" aria-hidden />
        <div>
          <h1 className="text-xl font-semibold text-ink">{t('caja.titulo')}</h1>
          <p className="text-sm text-ink-muted">{t('modulo.caja.descripcion')}</p>
        </div>
      </header>

      {notice !== null && <Alert variant={notice.variant}>{notice.message}</Alert>}

      <Alert variant="info">{t('caja.dinero.pendiente')}</Alert>

      <div className="grid gap-6 lg:grid-cols-[22rem_1fr]">
        <Card>
          <CardHeader>
            <CardTitle>{t('caja.pendientes')}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {pendientes.isLoading && <Spinner />}
            {pendientes.isError && (
              <Alert variant="danger">{apiErrorMessage(pendientes.error)}</Alert>
            )}
            {!pendientes.isLoading && lista.length === 0 && (
              <EmptyState title={t('caja.vacio')} description={t('caja.vacio.texto')} />
            )}
            <ul className="space-y-2">
              {lista.map((borrador) => (
                <li key={borrador.id}>
                  <button
                    type="button"
                    onClick={() => setAbierto(borrador.id)}
                    className={`w-full rounded-lg border p-3 text-left transition-colors ${
                      abierto === borrador.id
                        ? 'border-brand bg-brand-soft'
                        : 'border-line hover:border-brand'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-medium text-ink">{borrador.patientName}</span>
                      <span className="tabular-nums text-ink">
                        {formatUsd(borrador.totalCentsUsd)}
                      </span>
                    </div>
                    <div className="mt-1 flex items-center justify-between text-xs text-ink-muted">
                      <span>
                        {borrador.patientDocType}-{borrador.patientDocNumber}
                      </span>
                      <span>{formatDateTime(borrador.createdAt)}</span>
                    </div>
                    {borrador.needsPricing && (
                      <p className="mt-1 text-xs text-warning">{t('caja.sinPrecio')}</p>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{t('caja.borrador')}</CardTitle>
            {detalle.data !== undefined && (
              <p className="text-sm text-ink-muted">
                {detalle.data.patientName} · {detalle.data.patientDocType}-
                {detalle.data.patientDocNumber}
              </p>
            )}
          </CardHeader>
          <CardContent className="space-y-4">
            {abierto === null && (
              <EmptyState title={t('caja.vacio')} description={t('caja.vacio.texto')} />
            )}
            {abierto !== null && detalle.isLoading && <Spinner />}
            {abierto !== null && detalle.isError && (
              <Alert variant="danger">{apiErrorMessage(detalle.error)}</Alert>
            )}

            {abierto !== null && detalle.data !== undefined && (
              <>
                <ul className="divide-y divide-line">
                  {lineas.map((linea, indice) => (
                    <li
                      key={`${linea.code}-${String(indice)}`}
                      className="flex items-end gap-3 py-3"
                    >
                      <div className="min-w-0 flex-1">
                        <p className="truncate font-medium text-ink">{linea.description}</p>
                        <p className="text-xs text-ink-muted">
                          {linea.code}
                          {linea.toothNumber !== null && ` · pieza ${String(linea.toothNumber)}`}
                          {linea.surfaces.length > 0 && ` (${linea.surfaces.join(', ')})`}
                        </p>
                      </div>
                      <label className="w-20">
                        <span className="mb-1 block text-xs text-ink-muted">
                          {t('caja.col.cantidad')}
                        </span>
                        <Input
                          type="number"
                          min={1}
                          max={99}
                          value={linea.quantity}
                          disabled={!puedeEscribir}
                          onChange={(evento) =>
                            cambiar(indice, {
                              quantity: Math.max(1, Number(evento.target.value) || 1),
                            })
                          }
                        />
                      </label>
                      <label className="w-28">
                        <span className="mb-1 block text-xs text-ink-muted">
                          {t('caja.col.precio')}
                        </span>
                        <Input
                          inputMode="decimal"
                          value={linea.priceText}
                          disabled={!puedeEscribir}
                          placeholder="0,00"
                          onChange={(evento) =>
                            cambiar(indice, { priceText: evento.target.value, needsPricing: false })
                          }
                        />
                      </label>
                      <span className="w-24 pb-2 text-right tabular-nums text-ink">
                        {formatUsd(lineTotalCents(linea))}
                      </span>
                      {puedeEscribir && (
                        <Button
                          type="button"
                          variant="ghost"
                          aria-label={t('caja.quitar')}
                          onClick={() =>
                            setLineas((actuales) =>
                              actuales.filter((_, posicion) => posicion !== indice),
                            )
                          }
                        >
                          <Trash2 className="size-4" aria-hidden />
                        </Button>
                      )}
                    </li>
                  ))}
                </ul>

                {puedeEscribir && (
                  <div className="flex flex-wrap items-end gap-3">
                    <label className="min-w-56 flex-1">
                      <span className="mb-1 block text-xs text-ink-muted">{t('caja.anadir')}</span>
                      <select
                        className="w-full rounded-md border border-line bg-surface px-3 py-2 text-ink"
                        defaultValue=""
                        onChange={(evento) => {
                          anadirDelCatalogo(evento.target.value);
                          evento.target.value = '';
                        }}
                      >
                        <option value="">{t('caja.elegir')}</option>
                        {(catalogo.data?.items ?? []).map((item) => (
                          <option key={item.id} value={item.code}>
                            {item.name} · {formatUsd(item.priceCentsUsd)}
                          </option>
                        ))}
                      </select>
                    </label>
                    <Button
                      type="button"
                      disabled={guardar.isPending || !linesReady(lineas)}
                      onClick={() => guardar.mutate()}
                    >
                      {guardar.isPending ? <Spinner /> : t('caja.guardar')}
                    </Button>
                  </div>
                )}

                {!linesReady(lineas) && <Alert variant="warning">{t('caja.sinPrecio')}</Alert>}

                <div className="flex items-center justify-between border-t border-line pt-3">
                  <div className="text-xs text-ink-muted">
                    {guardar.data !== undefined && (
                      <>
                        {t('caja.total.exento')}:{' '}
                        {formatUsd(guardar.data.totals.exemptAmountCentsUsd)} ·{' '}
                        {t('caja.total.gravado')}:{' '}
                        {formatUsd(guardar.data.totals.taxableAmountCentsUsd)} ·{' '}
                        {t('caja.total.iva')}: {formatUsd(guardar.data.totals.ivaAmountCentsUsd)}
                      </>
                    )}
                  </div>
                  <p className="text-lg font-semibold text-ink">
                    {t('caja.total.general')}:{' '}
                    <span className="tabular-nums">
                      {formatUsd(guardar.data?.totals.totalCentsUsd ?? totalDetalle)}
                    </span>
                  </p>
                </div>
              </>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
};
