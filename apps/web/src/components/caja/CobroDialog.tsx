import {
  PAYMENT_METHODS,
  findPaymentMethod,
  vesCentimosFromUsd,
  type CollectPaymentInput,
} from '@odontocrm/contracts';
import { useMutation } from '@tanstack/react-query';
import { Alert, Button, Checkbox, Dialog, Field, Input, Select } from '@odontocrm/ui';
import { useState } from 'react';

import { apiErrorMessage } from '../../lib/api';
import { formatBs, imputacionPrevista, parseUsdToCents, tasaEnTexto } from '../../lib/caja';
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
 * **Cobrar**: lo que el paciente entrega, en la moneda del medio de pago.
 *
 * La previsión de lo que se imputa la hace `imputacionPrevista`, con los mismos ayudantes del contrato
 * que usa el servicio —la pantalla no tiene su propia aritmética de dinero—, así que lo que se ve antes
 * de confirmar es lo que va a quedar escrito. La tasa del cobro es la **del día del pago** (política
 * `tasa_del_pago` de la clínica), y si la vigente arrastra días hay que confirmarlo.
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

  const moneda = findPaymentMethod(method)?.currency ?? 'VES';
  const previsto = imputacionPrevista({
    tenderedText,
    method,
    rateMicros,
    invoiceRateMicros: factura.exchangeRateMicros,
    policy: 'tasa_del_pago',
    balanceCentsUsd: factura.balanceCentsUsd,
  });
  const puedeConfirmar =
    previsto.cents !== null &&
    previsto.cents > 0 &&
    previsto.aviso === null &&
    (!needsConfirmation || confirmRate);

  const cobrar = useMutation({
    mutationFn: (input: CollectPaymentInput) => billingApi.collect(factura.id, input),
  });

  const confirmar = async (): Promise<void> => {
    try {
      const salida = await cobrar.mutateAsync({
        method: method as CollectPaymentInput['method'],
        tenderedAmount: parseUsdToCents(tenderedText) ?? 0,
        reference: reference.trim() === '' ? null : reference.trim(),
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

        {rateMicros === null && <Alert variant="warning">{t('caja.tasa.sinTasa')}</Alert>}
        {rateMicros !== null && needsConfirmation && (
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
            {moneda === 'VES' && previsto.cents !== null && rateMicros !== null && (
              <span className="ml-2 text-xs text-ink-muted">
                {formatBs(vesCentimosFromUsd(previsto.cents, rateMicros))} Bs.
              </span>
            )}
          </dd>
          <dt className="text-ink-muted">{t('caja.doc.tasa')}</dt>
          <dd className="text-right tabular-nums text-ink">{tasaEnTexto(rateMicros)}</dd>
        </dl>

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
