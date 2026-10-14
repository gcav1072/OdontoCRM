import {
  PAYMENT_METHODS,
  findPaymentMethod,
  igtfPercentLabel,
  rateDateInCaracas,
  vesCentimosFromUsd,
  type CollectPaymentInput,
  type IgtfCollectedCurrency,
} from '@odontocrm/contracts';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Alert, Badge, Button, Checkbox, Dialog, Field, Input, Select } from '@odontocrm/ui';
import { useEffect, useState } from 'react';

import { apiErrorMessage } from '../../lib/api';
import {
  formatBs,
  igtfPrevisto,
  imputacionPrevista,
  parseUsdToCents,
  tasaEnTexto,
} from '../../lib/caja';
import { billingApi } from '../../lib/endpoints';
import { t } from '../../lib/i18n';

export interface FacturaParaCobrar {
  id: string;
  /** `A-000123`; el borrador no llega aquí. */
  numberLabel: string;
  totalCentsUsd: number;
  balanceCentsUsd: number;
  /** La tasa **congelada** al emitir: es la del papel. */
  exchangeRateMicros: number | null;
  /** Cuándo se emitió (instante ISO): la Fecha Valor no puede ser anterior. */
  issuedAt: string | null;
}

export interface CobroDialogProps {
  factura: FacturaParaCobrar;
  /** La tasa vigente de hoy y si arrastra más días de los tolerados (M8). */
  rateMicros: number | null;
  needsConfirmation: boolean;
  onClose: () => void;
  onDone: (mensaje: string) => void;
}

/**
 * **Cobrar**: lo que el paciente entrega, en la moneda del medio de pago, con su **Fecha Valor**
 * (ADR 0069).
 *
 * La previsión de lo que se imputa la hace `imputacionPrevista` (y el IGTF, `igtfPrevisto`), con los
 * mismos ayudantes del contrato que usa el servicio —la pantalla no tiene su propia aritmética de
 * dinero—, así que lo que se ve antes de confirmar es lo que va a quedar escrito: la imputación
 * histórica a la tasa de emisión, el diferencial cambiario a la tasa de la fecha valor y, si hay
 * residuo de redondeo, el badge que dice que se absorbe y la deuda se salda al 100 %.
 */
export const CobroDialog = ({
  factura,
  rateMicros,
  needsConfirmation,
  onClose,
  onDone,
}: CobroDialogProps) => {
  const [method, setMethod] = useState<string>('pago_movil');
  const [tenderedText, setTenderedText] = useState('');
  const [reference, setReference] = useState('');
  const [confirmRate, setConfirmRate] = useState(false);
  /** Fecha Valor (ADR 0069): la del comprobante bancario; por defecto, hoy. */
  const [effectiveDate, setEffectiveDate] = useState(rateDateInCaracas());
  /** En qué moneda entregó el paciente el IGTF que percibe la clínica. */
  const [igtfCollectedCurrency, setIgtfCollectedCurrency] = useState<IgtfCollectedCurrency | ''>(
    '',
  );
  const [igtfPaymentMethod, setIgtfPaymentMethod] = useState('');
  const [igtfPaymentReference, setIgtfPaymentReference] = useState('');

  const hoy = rateDateInCaracas();
  const diaEmision =
    factura.issuedAt === null ? null : rateDateInCaracas(new Date(factura.issuedAt));

  // La configuración fiscal de la clínica (SPE, alícuota y política) y la tasa de la Fecha Valor.
  const ajustes = useQuery({
    queryKey: ['billing', 'settings'],
    queryFn: ({ signal }) => billingApi.settings(signal),
  });
  const tasaValor = useQuery({
    queryKey: ['billing', 'rate', effectiveDate],
    queryFn: ({ signal }) => billingApi.rateToday(signal, effectiveDate),
    enabled: effectiveDate !== '',
  });

  const moneda = findPaymentMethod(method)?.currency ?? 'VES';
  const politica = ajustes.data?.imputationPolicy ?? 'tasa_del_pago';
  /** La tasa que valoriza este cobro: la de la Fecha Valor (o la impresa, con `tasa_de_la_factura`). */
  const tasaCobro =
    politica === 'tasa_de_la_factura'
      ? (factura.exchangeRateMicros ?? null)
      : (tasaValor.data?.current?.rateMicros ?? rateMicros ?? null);
  const tasaEmision = factura.exchangeRateMicros ?? null;

  const previsto = imputacionPrevista({
    tenderedText,
    method,
    rateMicros: tasaCobro,
    invoiceRateMicros: tasaEmision,
    policy: politica,
    balanceCentsUsd: factura.balanceCentsUsd,
  });

  const igtf = igtfPrevisto({
    method,
    amountCentsUsd: previsto.cents ?? 0,
    rateMicros: tasaCobro,
    isSpecialTaxpayer: ajustes.data?.isSpecialTaxpayer ?? false,
    igtfRateBp: ajustes.data?.igtfRateBp ?? 300,
  });

  // El saldo entero a la tasa de la fecha valor: lo que se autocompleta en el mostrador.
  useEffect(() => {
    if (tenderedText !== '' || moneda !== 'VES' || tasaCobro === null || tasaCobro <= 0) return;
    setTenderedText(formatBs(vesCentimosFromUsd(factura.balanceCentsUsd, tasaCobro)));
  }, [tenderedText, moneda, tasaCobro, factura.balanceCentsUsd]);

  const faltaDestinoIgtf = igtf.aplica && igtfCollectedCurrency === '';
  const requiereConfirmar = tasaValor.data?.needsConfirmation ?? needsConfirmation;
  const puedeConfirmar =
    previsto.cents !== null &&
    previsto.cents > 0 &&
    previsto.aviso === null &&
    !faltaDestinoIgtf &&
    (!requiereConfirmar || confirmRate);

  const cobrar = useMutation({
    mutationFn: (input: CollectPaymentInput) => billingApi.collect(factura.id, input),
  });

  const confirmar = async (): Promise<void> => {
    try {
      const salida = await cobrar.mutateAsync({
        method: method as CollectPaymentInput['method'],
        tenderedAmount: parseUsdToCents(tenderedText) ?? 0,
        reference: reference.trim() === '' ? null : reference.trim(),
        effectiveDate,
        ...(igtf.aplica && igtfCollectedCurrency !== ''
          ? {
              igtfCollectedCurrency,
              igtfPaymentMethod:
                igtfPaymentMethod.trim() === '' ? null : igtfPaymentMethod.trim(),
              igtfPaymentReference:
                igtfPaymentReference.trim() === '' ? null : igtfPaymentReference.trim(),
            }
          : { igtfPaymentMethod: null, igtfPaymentReference: null }),
        confirmRate,
      });
      onDone(t('caja.cobro.exito', { recibo: salida.payment.receiptLabel }));
    } catch {
      // El error se muestra abajo; no se cierra el diálogo para poder corregir el monto.
    }
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title={t('caja.cobro.titulo', { numero: factura.numberLabel })}
      description={t('caja.cobro.texto')}
      dismissOnBackdrop={false}
      closeLabel={t('comun.cerrar')}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={cobrar.isPending}>
            {t('comun.cancelar')}
          </Button>
          <Button
            onClick={() => {
              void confirmar();
            }}
            disabled={!puedeConfirmar}
            loading={cobrar.isPending}
            loadingLabel={t('comun.guardando')}
          >
            {t('caja.cobrar')}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {cobrar.isError && (
          <Alert variant="danger" title={t('secretaria.error.accion')}>
            {apiErrorMessage(cobrar.error)}
          </Alert>
        )}

        {tasaCobro === null && <Alert variant="warning">{t('caja.tasa.sinTasa')}</Alert>}
        {tasaCobro !== null && requiereConfirmar && (
          <Alert variant="warning">{t('caja.tasa.confirmar')}</Alert>
        )}

        <Field label={t('caja.cobro.medio')}>
          <Select value={method} onChange={(evento) => setMethod(evento.target.value)}>
            {PAYMENT_METHODS.map((medio) => (
              <option key={medio.code} value={medio.code}>
                {medio.label} ({medio.currency})
              </option>
            ))}
          </Select>
        </Field>

        <Field label={t('caja.cobro.fechaValor')} hint={t('caja.cobro.fechaValorAyuda')}>
          <Input
            type="date"
            value={effectiveDate}
            min={diaEmision ?? undefined}
            max={hoy}
            onChange={(evento) => setEffectiveDate(evento.target.value)}
          />
        </Field>

        <Field
          label={t('caja.cobro.monto')}
          hint={moneda === 'USD' ? t('caja.cobro.montoUsd') : t('caja.cobro.montoBs')}
        >
          <Input
            inputMode="decimal"
            autoComplete="off"
            value={tenderedText}
            placeholder="0,00"
            onChange={(evento) => setTenderedText(evento.target.value)}
          />
        </Field>

        <Field label={t('caja.cobro.referencia')} hint={t('caja.cobro.referenciaAyuda')}>
          <Input
            autoComplete="off"
            value={reference}
            onChange={(evento) => setReference(evento.target.value)}
          />
        </Field>

        <dl className="grid grid-cols-2 gap-x-4 gap-y-1 rounded-card border border-border bg-surface-muted px-4 py-3 text-sm">
          <dt className="text-ink-muted">{t('caja.cobro.total')}</dt>
          <dd className="text-right tabular-nums text-ink">
            US$ {formatBs(factura.totalCentsUsd)}
          </dd>
          <dt className="text-ink-muted">{t('caja.cobro.saldo')}</dt>
          <dd className="text-right tabular-nums text-ink">
            US$ {formatBs(factura.balanceCentsUsd)}
          </dd>
          <dt className="text-ink-muted">{t('caja.cobro.imputa')}</dt>
          <dd className="text-right tabular-nums text-ink">
            {previsto.cents === null ? '—' : `US$ ${formatBs(previsto.cents)}`}
          </dd>
          <dt className="text-ink-muted">{t('caja.doc.tasa')}</dt>
          <dd className="text-right tabular-nums text-ink">{tasaEnTexto(tasaCobro)}</dd>
          {moneda === 'VES' && previsto.historicalVesCentimos !== null && (
            <>
              <dt className="text-ink-muted">
                {t('caja.cobro.imputacionHistorica')} ({tasaEnTexto(tasaEmision)})
              </dt>
              <dd className="text-right tabular-nums text-ink">
                Bs. {formatBs(previsto.historicalVesCentimos)}
              </dd>
            </>
          )}
          {moneda === 'VES' && previsto.exchangeDiffVesCentimos !== null && (
            <>
              <dt className="text-ink-muted">
                {t('caja.cobro.diferencial')} ({tasaEnTexto(tasaCobro)})
              </dt>
              <dd className="text-right tabular-nums text-ink">
                {previsto.exchangeDiffVesCentimos > 0 ? '+' : ''} Bs.{' '}
                {formatBs(previsto.exchangeDiffVesCentimos)}
                <span className="ml-2 text-xs text-ink-muted">
                  {previsto.exchangeDiffVesCentimos >= 0
                    ? t('caja.cobro.ganancia')
                    : t('caja.cobro.perdida')}
                </span>
              </dd>
            </>
          )}
        </dl>

        {previsto.absorbeRedondeo && (
          <Badge variant="info">{t('caja.cobro.redondeoAbsorbido')}</Badge>
        )}

        {igtf.aplica && (
          <div className="space-y-3 rounded-card border border-border bg-surface-muted px-4 py-3">
            <div className="flex items-center justify-between gap-2">
              <span className="text-sm font-medium text-ink">
                {t('caja.cobro.igtfTitulo')} — {igtfPercentLabel(igtf.basisPoints)}
              </span>
              <span className="text-sm tabular-nums text-ink">
                US$ {formatBs(igtf.amountCentsUsd)}
                {igtf.amountVesCentimos !== null && (
                  <span className="ml-2 text-xs text-ink-muted">
                    Bs. {formatBs(igtf.amountVesCentimos)}
                  </span>
                )}
              </span>
            </div>
            <Field label={t('caja.cobro.igtfDestino')}>
              <Select
                value={igtfCollectedCurrency}
                onChange={(evento) =>
                  setIgtfCollectedCurrency(evento.target.value as IgtfCollectedCurrency | '')
                }
              >
                <option value="">{t('caja.elegir')}</option>
                <option value="USD">{t('caja.cobro.igtfEnUsd')}</option>
                <option value="VES">{t('caja.cobro.igtfEnBs')}</option>
              </Select>
            </Field>
            {igtfCollectedCurrency === 'VES' && (
              <div className="grid grid-cols-2 gap-3">
                <Field label={t('caja.cobro.igtfMedio')}>
                  <Input
                    autoComplete="off"
                    value={igtfPaymentMethod}
                    onChange={(evento) => setIgtfPaymentMethod(evento.target.value)}
                  />
                </Field>
                <Field label={t('caja.cobro.igtfReferencia')}>
                  <Input
                    autoComplete="off"
                    value={igtfPaymentReference}
                    onChange={(evento) => setIgtfPaymentReference(evento.target.value)}
                  />
                </Field>
              </div>
            )}
            {faltaDestinoIgtf && (
              <Alert variant="warning">{t('caja.cobro.igtfFaltaDestino')}</Alert>
            )}
          </div>
        )}
        {moneda === 'USD' &&
          !igtf.aplica &&
          (ajustes.data?.isSpecialTaxpayer ?? false) &&
          igtf.motivo !== '' && <Alert variant="info">{igtf.motivo}</Alert>}

        {previsto.aviso !== null && <Alert variant="warning">{previsto.aviso}</Alert>}

        {needsConfirmation && (
          <Checkbox
            checked={confirmRate}
            onChange={(evento) => setConfirmRate(evento.target.checked)}
            label={t('caja.cobro.confirmarTasa')}
          />
        )}
      </div>
    </Dialog>
  );
};
