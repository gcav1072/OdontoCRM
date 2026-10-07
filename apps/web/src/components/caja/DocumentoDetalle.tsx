import type { BillingInvoiceDetail, BillingInvoiceListItem } from '@odontocrm/contracts';
import { Alert, Badge, Button, Spinner } from '@odontocrm/ui';
import { Printer } from 'lucide-react';
import { useState } from 'react';

import { apiErrorMessage } from '../../lib/api';
import {
  estadoDeFactura,
  formatBs,
  puedeReimprimirse,
  reimpresionesEnTexto,
  tasaEnTexto,
} from '../../lib/caja';
import { billingApi } from '../../lib/endpoints';
import { formatDateTime } from '../../lib/format';
import { t } from '../../lib/i18n';

export interface DocumentoDetalleProps {
  documento: BillingInvoiceListItem;
  detalle: BillingInvoiceDetail | undefined;
  cargando: boolean;
  error: unknown;
  puedeCobrar: boolean;
  puedeAnular: boolean;
  /** Anular un cobro exige `billing:collect` (el dinero), no solo leer. */
  puedeAnularCobros: boolean;
  onCobrar: () => void;
  onAnular: () => void;
  onAnularCobro: (cobro: { id: string; receiptLabel: string; amountCentsUsd: number }) => void;
  onAviso: (mensaje: string) => void;
  onError: (mensaje: string) => void;
}

/**
 * El **detalle de un documento** del historial: lo que se emitió, lo que se cobró y lo que se puede
 * hacer con él.
 *
 * Reimprimir no vuelve a componer el papel: descarga el PDF **archivado** al emitir (ADR 0048) y deja
 * constancia (`…/printed`), que es lo que cuenta la reimpresión y lo que queda en la auditoría. La
 * factura, cada recibo y la nota de crédito se reimprimen cada uno por su ruta.
 */
export const DocumentoDetalle = ({
  documento,
  detalle,
  cargando,
  error,
  puedeCobrar,
  puedeAnular,
  puedeAnularCobros,
  onCobrar,
  onAnular,
  onAnularCobro,
  onAviso,
  onError,
}: DocumentoDetalleProps) => {
  const [imprimiendo, setImprimiendo] = useState<string | null>(null);

  /** Abre un PDF autenticado en otra pestaña y deja la constancia que corresponda. */
  const abrir = async (
    clave: string,
    pedir: () => Promise<Blob>,
    marcar: () => Promise<unknown>,
  ) => {
    setImprimiendo(clave);
    try {
      const blob = await pedir();
      const url = URL.createObjectURL(blob);
      window.open(url, '_blank', 'noopener');
      await marcar();
      onAviso(t('caja.doc.reimprimir'));
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (fallo) {
      onError(apiErrorMessage(fallo));
    } finally {
      setImprimiendo(null);
    }
  };

  const cobros = detalle?.payments ?? [];

  return (
    <div className="space-y-4">
      {cargando && <Spinner />}
      {error !== undefined && error !== null && (
        <Alert variant="danger">{apiErrorMessage(error)}</Alert>
      )}

      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-lg font-semibold text-ink">
            {documento.numberLabel ?? t('caja.borrador')}
          </p>
          <p className="text-sm text-ink-muted">
            {documento.patientName} · {documento.patientDocType}-{documento.patientDocNumber}
          </p>
        </div>
        <Badge variant={documento.status === 'anulada' ? 'danger' : 'neutral'}>
          {estadoDeFactura(documento)}
        </Badge>
      </div>

      <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
        {documento.issuedAt !== null && (
          <>
            <dt className="text-ink-muted">{t('caja.doc.emitida')}</dt>
            <dd className="text-right text-ink">{formatDateTime(documento.issuedAt)}</dd>
          </>
        )}
        <dt className="text-ink-muted">{t('caja.doc.tasa')}</dt>
        <dd className="text-right tabular-nums text-ink">
          {tasaEnTexto(documento.exchangeRateMicros)}
        </dd>
        <dt className="text-ink-muted">{t('caja.total.general')}</dt>
        <dd className="text-right tabular-nums text-ink">
          US$ {formatBs(documento.totalCentsUsd)}
        </dd>
        <dt className="text-ink-muted">{t('caja.col.saldo')}</dt>
        <dd className="text-right tabular-nums text-ink">
          US$ {formatBs(documento.balanceCentsUsd)}
        </dd>
        <dt className="text-ink-muted">{t('caja.col.reimpresiones')}</dt>
        <dd className="text-right text-ink">{reimpresionesEnTexto(documento.printCount)}</dd>
      </dl>

      {documento.status === 'anulada' && documento.voidedAt !== null && (
        <Alert variant="warning">
          {t('caja.doc.anulada', { fecha: formatDateTime(documento.voidedAt) })}
          {documento.voidReason !== null && (
            <span className="mt-1 block text-xs">
              {t('caja.doc.motivoAnulacion', { motivo: documento.voidReason })}
            </span>
          )}
          {documento.creditNote !== null && (
            <span className="mt-1 block text-xs font-medium">
              {t('caja.doc.nota', { nota: documento.creditNote.creditNoteLabel })}
            </span>
          )}
        </Alert>
      )}

      {/* Los papeles que se pueden reimprimir: la factura, cada recibo y la nota. */}
      <div className="flex flex-wrap gap-2 border-t border-line pt-3">
        <Button
          type="button"
          variant="secondary"
          loading={imprimiendo === 'factura'}
          disabled={!puedeReimprimirse(documento)}
          onClick={() =>
            void abrir(
              'factura',
              () => billingApi.downloadInvoicePdf(documento.id),
              () => billingApi.markInvoicePrinted(documento.id),
            )
          }
        >
          <Printer className="mr-2 size-4" aria-hidden />
          {t('caja.doc.factura')}
        </Button>

        {documento.creditNote !== null && (
          <Button
            type="button"
            variant="secondary"
            loading={imprimiendo === 'nota'}
            onClick={() =>
              void abrir(
                'nota',
                () => billingApi.downloadCreditNotePdf(documento.creditNote?.id ?? ''),
                () => Promise.resolve(),
              )
            }
          >
            {t('caja.doc.notaPdf')}
          </Button>
        )}

        {(puedeCobrar || puedeAnular) && <span className="flex-1" />}
        {puedeCobrar && (
          <Button type="button" onClick={onCobrar}>
            {t('caja.cobrar')}
          </Button>
        )}
        {puedeAnular && (
          <Button type="button" variant="danger" onClick={onAnular}>
            {t('caja.anular')}
          </Button>
        )}
      </div>

      <div className="border-t border-line pt-3">
        <p className="mb-2 text-sm font-medium text-ink">{t('caja.doc.cobros')}</p>
        {cobros.length === 0 && <p className="text-sm text-ink-muted">{t('caja.doc.sinCobros')}</p>}
        <ul className="divide-y divide-line">
          {cobros.map((cobro) => (
            <li key={cobro.id} className="flex flex-wrap items-center gap-2 py-2 text-sm">
              <span className="font-medium text-ink">{cobro.receiptLabel}</span>
              <span className="text-ink-muted">{formatDateTime(cobro.createdAt)}</span>
              <span className="tabular-nums text-ink">
                {cobro.tenderedCurrency === 'USD' ? 'US$' : 'Bs.'} {formatBs(cobro.tenderedAmount)}
              </span>
              <span className="text-ink-muted">→ US$ {formatBs(cobro.amountCentsUsd)}</span>
              {cobro.voidedAt !== null && <Badge variant="danger">{t('caja.cobro.anulado')}</Badge>}
              <span className="flex-1" />
              <Button
                type="button"
                variant="ghost"
                loading={imprimiendo === cobro.id}
                onClick={() =>
                  void abrir(
                    cobro.id,
                    () => billingApi.downloadPaymentReceipt(cobro.id),
                    () => billingApi.markPaymentPrinted(cobro.id),
                  )
                }
              >
                {t('caja.doc.recibo')}
              </Button>
              {puedeAnularCobros && cobro.voidedAt === null && (
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() =>
                    onAnularCobro({
                      id: cobro.id,
                      receiptLabel: cobro.receiptLabel,
                      amountCentsUsd: cobro.amountCentsUsd,
                    })
                  }
                >
                  {t('caja.cobro.anular')}
                </Button>
              )}
            </li>
          ))}
        </ul>
      </div>

      {detalle !== undefined && detalle.clinicalSessionIds.length > 0 && (
        <p className="text-xs text-ink-muted">
          {t('caja.doc.sesiones', { cuantas: detalle.clinicalSessionIds.length })}
        </p>
      )}
    </div>
  );
};
