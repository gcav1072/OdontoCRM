import type { BillingInvoiceListItem } from '@odontocrm/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Dialog,
  EmptyState,
  Input,
  Select,
  Spinner,
} from '@odontocrm/ui';
import { Receipt, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';

import { AnularCobroDialog, AnularFacturaDialog } from '../components/caja/AnularDialog';
import { CobroDialog } from '../components/caja/CobroDialog';
import { DocumentoDetalle } from '../components/caja/DocumentoDetalle';
import { TasaDelDia } from '../components/caja/TasaDelDia';
import { useNotice } from '../hooks/useNotice';
import { apiErrorMessage } from '../lib/api';
import {
  FILTROS_VACIOS,
  aParametrosDeConsulta,
  estadoDeFactura,
  formatBs,
  formatUsd,
  hayFiltros,
  lineTotalCents,
  linesReady,
  liveInvoiceTotals,
  puedeAnularse,
  puedeCobrarse,
  puedeDescartarse,
  rangoInvalido,
  reimpresionesEnTexto,
  taxRateForCategory,
  toDraftItems,
  toEditableLine,
  type EditableLine,
  type FiltrosDelHistorial,
} from '../lib/caja';
import { billingApi } from '../lib/endpoints';
import { formatDate, formatDateTime } from '../lib/format';
import { t } from '../lib/i18n';
import { useAuth } from '../providers/AuthProvider';

const ESTADOS = ['borrador', 'emitida', 'parcial', 'pagada', 'anulada'] as const;
const POR_PAGINA = 20;

type Vista = 'pendientes' | 'historial';
type DialogoAbierto =
  | { tipo: 'emitir'; id: string }
  | { tipo: 'anular'; id: string; numberLabel: string | null }
  | { tipo: 'descartar'; id: string }
  | { tipo: 'cobrar'; documento: BillingInvoiceListItem }
  | { tipo: 'anularCobro'; cobro: { id: string; receiptLabel: string; amountCentsUsd: number } }
  | null;

/**
 * La caja (Fase 11): el mostrador completo.
 *
 * A la izquierda, **dos listas**: los *pendientes* —los borradores que dejó el cierre de cada sesión
 * clínica— y el *historial*, con filtros por estado, fecha y paciente, que es lo que se mira cuando
 * alguien vuelve con el papel en la mano.
 *
 * A la derecha, el documento: el borrador se revisa y se **emite** (o se descarta); lo emitido se
 * **cobra**, se **reimprime** —el PDF archivado, con su constancia— y se **anula** con nota de crédito
 * (o se anula el cobro, que devuelve el saldo).
 *
 * Todo lo que se puede hacer con un documento sale de su estado (`puedeCobrarse`, `puedeAnularse`,
 * `puedeDescartarse`), no de un `if` suelto en la pantalla; y la aritmética del dinero la hacen los
 * ayudantes del contrato, los mismos que usa el servicio.
 */
export const CajaPage = () => {
  const { hasPermission } = useAuth();
  const puedeEscribir = hasPermission('billing:write');
  const puedeCobrar = hasPermission('billing:collect');
  const puedeAnular = hasPermission('billing:void');
  const puedePublicarTasa = hasPermission('billing:rates');
  const { notice, exito, error } = useNotice();
  const cliente = useQueryClient();

  const [vista, setVista] = useState<Vista>('pendientes');
  const [abierto, setAbierto] = useState<string | null>(null);
  const [lineas, setLineas] = useState<EditableLine[]>([]);
  const [filtros, setFiltros] = useState<FiltrosDelHistorial>(FILTROS_VACIOS);
  const [pagina, setPagina] = useState(1);
  const [dialogo, setDialogo] = useState<DialogoAbierto>(null);

  const pendientes = useQuery({
    queryKey: ['billing', 'drafts'],
    queryFn: ({ signal }) => billingApi.drafts(signal),
  });
  const catalogo = useQuery({
    queryKey: ['billing', 'catalog'],
    queryFn: ({ signal }) => billingApi.catalog(signal),
  });
  const tasa = useQuery({
    queryKey: ['billing', 'rate'],
    queryFn: ({ signal }) => billingApi.rateToday(signal),
  });

  const parametros = aParametrosDeConsulta(filtros, pagina, POR_PAGINA);
  const historial = useQuery({
    queryKey: ['billing', 'invoices', parametros],
    queryFn: ({ signal }) =>
      billingApi.invoices(
        {
          ...(parametros.status === undefined
            ? {}
            : { status: parametros.status as BillingInvoiceListItem['status'] }),
          ...(parametros.from === undefined ? {} : { from: parametros.from }),
          ...(parametros.to === undefined ? {} : { to: parametros.to }),
          ...(parametros.search === undefined ? {} : { search: parametros.search }),
          page: parametros.page,
          pageSize: parametros.pageSize,
        },
        signal,
      ),
    // Con un rango invertido no se consulta: se avisa (igual que en la auditoría).
    enabled: !rangoInvalido(filtros),
  });

  /** El documento abierto: un borrador se pide por su ruta y una factura por la suya. */
  const detalleBorrador = useQuery({
    queryKey: ['billing', 'draft', abierto],
    queryFn: ({ signal }) => billingApi.draft(abierto ?? '', signal),
    enabled: abierto !== null && vista === 'pendientes',
  });
  const detalleDocumento = useQuery({
    queryKey: ['billing', 'invoice', abierto],
    queryFn: ({ signal }) => billingApi.invoice(abierto ?? '', signal),
    enabled: abierto !== null && vista === 'historial',
  });

  useEffect(() => {
    setLineas(
      vista === 'pendientes' && detalleBorrador.data !== undefined
        ? detalleBorrador.data.items.map(toEditableLine)
        : [],
    );
  }, [detalleBorrador.data, vista]);

  const guardar = useMutation({
    mutationFn: () => billingApi.saveDraft(abierto ?? '', { items: toDraftItems(lineas) }),
    onSuccess: async (guardado) => {
      exito(t('caja.guardado'));
      setLineas(guardado.items.map(toEditableLine));
      await cliente.invalidateQueries({ queryKey: ['billing'] });
    },
    onError: (fallo: unknown) => error(apiErrorMessage(fallo)),
  });

  const emitir = useMutation({
    // Emitir congela lo que el **servicio** tiene guardado: se guardan primero los cambios de
    // la pantalla para que lo añadido en el mostrador no se quede fuera de la factura.
    mutationFn: async (id: string) => {
      await billingApi.saveDraft(id, { items: toDraftItems(lineas) });
      return billingApi.issue(id);
    },
    onSuccess: async (emitida) => {
      exito(t('caja.emitir.exito', { numero: emitida.numberLabel }));
      setDialogo(null);
      setVista('historial');
      setAbierto(emitida.id);
      await cliente.invalidateQueries({ queryKey: ['billing'] });
    },
    onError: (fallo: unknown) => {
      error(apiErrorMessage(fallo));
      setDialogo(null);
    },
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
        // La categoría y su alícuota se copian igual que las copiará el servicio: sin
        // esto, un bien al 16 % no sumaba su IVA en el total de la pantalla.
        taxCategory: item.taxCategory,
        taxRateBasisPoints: taxRateForCategory(item.taxCategory),
        needsPricing: item.priceCentsUsd === 0,
      },
    ]);
  };

  const avisoDeExito = (mensaje: string): void => {
    exito(mensaje);
  };

  const listaBorradores = pendientes.data?.items ?? [];
  const listaHistorial = historial.data?.items ?? [];
  const seleccionado = listaHistorial.find((item) => item.id === abierto) ?? null;
  /** El historial también lista borradores: al abrir uno se avisa y se lleva a Pendientes. */
  const esBorradorSeleccionado = seleccionado?.status === 'borrador';
  /** Los totales con lo que hay en pantalla: se mueven al añadir o editar una partida. */
  const totalesVivos = liveInvoiceTotals(lineas);
  /** La pantalla y el servicio no cuadran: hay partidas sin guardar todavía. */
  const hayCambiosSinGuardar =
    detalleBorrador.data !== undefined &&
    (detalleBorrador.data.itemCount !== lineas.length ||
      detalleBorrador.data.totalCentsUsd !== totalesVivos.totalCentsUsd);

  const abrirDocumento = (id: string): void => {
    setAbierto(id);
  };

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

      <TasaDelDia puedePublicar={puedePublicarTasa} />

      <div className="grid gap-6 lg:grid-cols-[22rem_1fr]">
        <div className="space-y-4">
          <div className="flex gap-2">
            <Button
              type="button"
              variant={vista === 'pendientes' ? 'primary' : 'secondary'}
              onClick={() => {
                setVista('pendientes');
                setAbierto(null);
              }}
            >
              {t('caja.vista.pendientes')}
              {listaBorradores.length > 0 && ` (${String(listaBorradores.length)})`}
            </Button>
            <Button
              type="button"
              variant={vista === 'historial' ? 'primary' : 'secondary'}
              onClick={() => {
                setVista('historial');
                setAbierto(null);
              }}
            >
              {t('caja.vista.historial')}
            </Button>
          </div>

          {vista === 'pendientes' ? (
            <Card>
              <CardHeader>
                <CardTitle>{t('caja.pendientes')}</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                {pendientes.isLoading && <Spinner />}
                {pendientes.isError && (
                  <Alert variant="danger">{apiErrorMessage(pendientes.error)}</Alert>
                )}
                {!pendientes.isLoading && listaBorradores.length === 0 && (
                  <EmptyState title={t('caja.vacio')} description={t('caja.vacio.texto')} />
                )}
                <ul className="space-y-2">
                  {listaBorradores.map((borrador) => (
                    <li key={borrador.id}>
                      <button
                        type="button"
                        onClick={() => abrirDocumento(borrador.id)}
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
          ) : (
            <Card>
              <CardHeader>
                <CardTitle>{t('caja.historial.titulo')}</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="space-y-2">
                  <label className="block">
                    <span className="mb-1 block text-xs text-ink-muted">
                      {t('caja.historial.estado')}
                    </span>
                    <Select
                      value={filtros.status}
                      onChange={(evento) => {
                        setFiltros((actuales) => ({ ...actuales, status: evento.target.value }));
                        setPagina(1);
                      }}
                    >
                      <option value="">{t('caja.historial.todos')}</option>
                      {ESTADOS.map((estado) => (
                        <option key={estado} value={estado}>
                          {estadoDeFactura({
                            status: estado,
                            totalCentsUsd: 0,
                            balanceCentsUsd: 0,
                          })}
                        </option>
                      ))}
                    </Select>
                  </label>

                  <div className="grid grid-cols-2 gap-2">
                    <label className="block">
                      <span className="mb-1 block text-xs text-ink-muted">
                        {t('caja.historial.desde')}
                      </span>
                      <Input
                        type="date"
                        value={filtros.from}
                        onChange={(evento) => {
                          setFiltros((actuales) => ({ ...actuales, from: evento.target.value }));
                          setPagina(1);
                        }}
                      />
                    </label>
                    <label className="block">
                      <span className="mb-1 block text-xs text-ink-muted">
                        {t('caja.historial.hasta')}
                      </span>
                      <Input
                        type="date"
                        value={filtros.to}
                        onChange={(evento) => {
                          setFiltros((actuales) => ({ ...actuales, to: evento.target.value }));
                          setPagina(1);
                        }}
                      />
                    </label>
                  </div>

                  <label className="block">
                    <span className="mb-1 block text-xs text-ink-muted">
                      {t('caja.historial.buscar')}
                    </span>
                    <Input
                      autoComplete="off"
                      value={filtros.search}
                      onChange={(evento) => {
                        setFiltros((actuales) => ({ ...actuales, search: evento.target.value }));
                        setPagina(1);
                      }}
                    />
                  </label>

                  {rangoInvalido(filtros) && (
                    <Alert variant="warning">{t('caja.historial.rangoInvalido')}</Alert>
                  )}

                  {hayFiltros(filtros) && (
                    <Button
                      type="button"
                      variant="ghost"
                      onClick={() => {
                        setFiltros(FILTROS_VACIOS);
                        setPagina(1);
                      }}
                    >
                      {t('caja.historial.limpiar')}
                    </Button>
                  )}
                </div>

                {historial.isLoading && <Spinner />}
                {historial.isError && (
                  <Alert variant="danger">{apiErrorMessage(historial.error)}</Alert>
                )}
                {historial.data !== undefined && listaHistorial.length === 0 && (
                  <EmptyState
                    title={t('caja.historial.vacio')}
                    description={t('caja.historial.vacioTexto')}
                  />
                )}

                <ul className="divide-y divide-line">
                  {listaHistorial.map((documento) => (
                    <li key={documento.id}>
                      <button
                        type="button"
                        onClick={() => abrirDocumento(documento.id)}
                        className={`w-full rounded-lg p-2 text-left transition-colors ${
                          abierto === documento.id ? 'bg-brand-soft' : 'hover:bg-surface-muted'
                        }`}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-medium text-ink">
                            {documento.numberLabel ?? t('caja.borrador')}
                          </span>
                          <span className="tabular-nums text-ink">
                            US$ {formatBs(documento.totalCentsUsd)}
                          </span>
                        </div>
                        <div className="mt-0.5 flex items-center justify-between gap-2 text-xs text-ink-muted">
                          <span className="truncate">{documento.patientName}</span>
                          <span>{formatDate(documento.issuedAt ?? documento.createdAt)}</span>
                        </div>
                        <div className="mt-1 flex items-center gap-2">
                          <Badge variant={documento.status === 'anulada' ? 'danger' : 'neutral'}>
                            {estadoDeFactura(documento)}
                          </Badge>
                          {documento.balanceCentsUsd > 0 && documento.status !== 'borrador' && (
                            <span className="text-xs text-warning">
                              {t('caja.col.saldo')}: US$ {formatBs(documento.balanceCentsUsd)}
                            </span>
                          )}
                          {documento.paymentCount > 0 && (
                            <span className="text-xs text-ink-muted">
                              {t('caja.col.cobros')}: {documento.paymentCount}
                            </span>
                          )}
                          {documento.printCount > 0 && (
                            <span className="text-xs text-ink-muted">
                              {reimpresionesEnTexto(documento.printCount)}
                            </span>
                          )}
                        </div>
                      </button>
                    </li>
                  ))}
                </ul>

                {historial.data !== undefined && historial.data.total > 0 && (
                  <div className="flex items-center justify-between border-t border-line pt-2 text-xs text-ink-muted">
                    <span>
                      {t('caja.historial.cuantos', { total: historial.data.total })} ·{' '}
                      {t('caja.historial.pagina', {
                        pagina: historial.data.page,
                        paginas: historial.data.totalPages,
                      })}
                    </span>
                    <span className="flex gap-2">
                      <Button
                        type="button"
                        variant="ghost"
                        disabled={pagina <= 1}
                        onClick={() => setPagina((actual) => Math.max(1, actual - 1))}
                      >
                        {t('caja.historial.anterior')}
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        disabled={pagina >= historial.data.totalPages}
                        onClick={() => setPagina((actual) => actual + 1)}
                      >
                        {t('caja.historial.siguiente')}
                      </Button>
                    </span>
                  </div>
                )}
              </CardContent>
            </Card>
          )}
        </div>

        <Card>
          <CardHeader>
            <CardTitle>
              {vista === 'pendientes' ? t('caja.borrador') : t('caja.doc.titulo')}
            </CardTitle>
            {vista === 'pendientes' && detalleBorrador.data !== undefined && (
              <p className="text-sm text-ink-muted">
                {detalleBorrador.data.patientName} · {detalleBorrador.data.patientDocType}-
                {detalleBorrador.data.patientDocNumber}
              </p>
            )}
          </CardHeader>
          <CardContent className="space-y-4">
            {abierto === null && (
              <EmptyState
                title={vista === 'pendientes' ? t('caja.vacio') : t('caja.historial.vacio')}
                description={vista === 'pendientes' ? t('caja.vacio.texto') : t('caja.doc.elige')}
              />
            )}

            {/* ── El borrador: revisar, guardar, emitir o descartar ─────────── */}
            {abierto !== null && vista === 'pendientes' && detalleBorrador.isLoading && <Spinner />}
            {abierto !== null && vista === 'pendientes' && detalleBorrador.isError && (
              <Alert variant="danger">{apiErrorMessage(detalleBorrador.error)}</Alert>
            )}

            {abierto !== null && vista === 'pendientes' && detalleBorrador.data !== undefined && (
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
                      <Select
                        value=""
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
                      </Select>
                    </label>
                    <Button
                      type="button"
                      variant="secondary"
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
                    {t('caja.total.exento')}: {formatUsd(totalesVivos.exemptAmountCentsUsd)} ·{' '}
                    {t('caja.total.gravado')}: {formatUsd(totalesVivos.taxableAmountCentsUsd)} ·{' '}
                    {t('caja.total.iva')}: {formatUsd(totalesVivos.ivaAmountCentsUsd)}
                  </div>
                  <p className="text-lg font-semibold text-ink">
                    {t('caja.total.general')}:{' '}
                    <span className="tabular-nums">{formatUsd(totalesVivos.totalCentsUsd)}</span>
                    {hayCambiosSinGuardar && (
                      <span className="pl-2 align-middle text-xs font-normal text-ink-muted">
                        {t('caja.total.sinGuardar')}
                      </span>
                    )}
                  </p>
                </div>

                {puedeEscribir && (
                  <div className="flex flex-wrap justify-end gap-2 border-t border-line pt-3">
                    {puedeDescartarse(detalleBorrador.data) && (
                      <Button
                        type="button"
                        variant="ghost"
                        onClick={() =>
                          setDialogo({ tipo: 'descartar', id: detalleBorrador.data.id })
                        }
                      >
                        {t('caja.descartar')}
                      </Button>
                    )}
                    <Button
                      type="button"
                      disabled={
                        !linesReady(lineas) || lineas.length === 0 || tasa.data?.current == null
                      }
                      onClick={() =>
                        setDialogo({
                          tipo: 'emitir',
                          id: detalleBorrador.data.id,
                        })
                      }
                    >
                      {t('caja.emitir')}
                    </Button>
                  </div>
                )}

                {tasa.data?.current == null && (
                  <Alert variant="warning">{t('caja.tasa.sinTasa')}</Alert>
                )}
              </>
            )}

            {/* ── El documento emitido: cobrar, reimprimir y anular ─────────── */}
            {abierto !== null && vista === 'historial' && seleccionado === null && (
              <EmptyState title={t('caja.historial.vacio')} description={t('caja.doc.elige')} />
            )}
            {abierto !== null &&
              vista === 'historial' &&
              seleccionado !== null &&
              esBorradorSeleccionado && (
                <div className="space-y-3">
                  <p className="text-sm text-ink">
                    {seleccionado.patientName} · {seleccionado.patientDocType}-
                    {seleccionado.patientDocNumber}
                  </p>
                  <Alert variant="info">{t('caja.sinPrecio')}</Alert>
                  <Button
                    type="button"
                    onClick={() => {
                      setVista('pendientes');
                      setAbierto(seleccionado.id);
                    }}
                  >
                    {t('caja.revisar')}
                  </Button>
                </div>
              )}
            {abierto !== null &&
              vista === 'historial' &&
              seleccionado !== null &&
              !esBorradorSeleccionado && (
                <DocumentoDetalle
                  documento={seleccionado}
                  detalle={detalleDocumento.data}
                  cargando={detalleDocumento.isLoading}
                  error={detalleDocumento.error}
                  puedeCobrar={puedeCobrar && puedeCobrarse(seleccionado)}
                  puedeAnular={puedeAnular && puedeAnularse(seleccionado)}
                  puedeAnularCobros={puedeCobrar}
                  onCobrar={() => setDialogo({ tipo: 'cobrar', documento: seleccionado })}
                  onAnular={() =>
                    setDialogo({
                      tipo: 'anular',
                      id: seleccionado.id,
                      numberLabel: seleccionado.numberLabel,
                    })
                  }
                  onAnularCobro={(cobro) => setDialogo({ tipo: 'anularCobro', cobro })}
                  onAviso={avisoDeExito}
                  onError={error}
                />
              )}
          </CardContent>
        </Card>
      </div>

      {/* ── Los diálogos del mostrador ─────────────────────────────────────── */}
      {dialogo?.tipo === 'emitir' && (
        <Dialog
          open
          onClose={() => setDialogo(null)}
          title={t('caja.emitir.titulo')}
          description={t('caja.emitir.texto')}
          dismissOnBackdrop={false}
          closeLabel={t('comun.cerrar')}
          footer={
            <>
              <Button
                variant="secondary"
                onClick={() => setDialogo(null)}
                disabled={emitir.isPending}
              >
                {t('comun.cancelar')}
              </Button>
              <Button
                onClick={() => emitir.mutate(dialogo.id)}
                loading={emitir.isPending}
                loadingLabel={t('comun.guardando')}
              >
                {t('caja.emitir')}
              </Button>
            </>
          }
        >
          <p className="text-sm text-ink">
            {t('caja.total.general')}:{' '}
            <span className="font-semibold tabular-nums">
              {formatUsd(totalesVivos.totalCentsUsd)}
            </span>
          </p>
        </Dialog>
      )}

      {dialogo?.tipo === 'descartar' && (
        <AnularFacturaDialog
          modo="borrador"
          documento={{ id: dialogo.id, numberLabel: null }}
          onClose={() => setDialogo(null)}
          onDone={async (mensaje) => {
            setDialogo(null);
            setAbierto(null);
            exito(mensaje);
            await cliente.invalidateQueries({ queryKey: ['billing'] });
          }}
        />
      )}

      {dialogo?.tipo === 'anular' && (
        <AnularFacturaDialog
          modo="factura"
          documento={{ id: dialogo.id, numberLabel: dialogo.numberLabel }}
          onClose={() => setDialogo(null)}
          onDone={async (mensaje) => {
            setDialogo(null);
            exito(mensaje);
            await cliente.invalidateQueries({ queryKey: ['billing'] });
          }}
        />
      )}

      {dialogo?.tipo === 'cobrar' && (
        <CobroDialog
          factura={{
            id: dialogo.documento.id,
            numberLabel: dialogo.documento.numberLabel ?? '',
            totalCentsUsd: dialogo.documento.totalCentsUsd,
            balanceCentsUsd: dialogo.documento.balanceCentsUsd,
            exchangeRateMicros: dialogo.documento.exchangeRateMicros,
          }}
          rateMicros={tasa.data?.current?.rateMicros ?? null}
          needsConfirmation={tasa.data?.needsConfirmation ?? false}
          onClose={() => setDialogo(null)}
          onDone={async (mensaje) => {
            setDialogo(null);
            exito(mensaje);
            await cliente.invalidateQueries({ queryKey: ['billing'] });
          }}
        />
      )}

      {dialogo?.tipo === 'anularCobro' && (
        <AnularCobroDialog
          cobro={dialogo.cobro}
          onClose={() => setDialogo(null)}
          onDone={async (mensaje) => {
            setDialogo(null);
            exito(mensaje);
            await cliente.invalidateQueries({ queryKey: ['billing'] });
          }}
        />
      )}
    </div>
  );
};
