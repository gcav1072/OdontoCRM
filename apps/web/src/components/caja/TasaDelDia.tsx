import { rateDateInCaracas } from '@odontocrm/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Alert,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Field,
  Input,
  Spinner,
} from '@odontocrm/ui';
import { useState } from 'react';

import { apiErrorMessage } from '../../lib/api';
import { tasaEnTexto } from '../../lib/caja';
import { billingApi } from '../../lib/endpoints';
import { useNotice } from '../../hooks/useNotice';
import { t } from '../../lib/i18n';

/**
 * **La tasa del día**: el widget de la jornada.
 *
 * La caja no llama a internet (ADR 0046). Si no hay tasa publicada **no se emite ni se cobra** —y el
 * servicio lo dice con un 409, no inventa un 1—, así que aquí está el sitio donde la secretaría la
 * teclea. Corregir la tasa de un día ya publicado exige motivo: la fila anterior queda como historia
 * (lo ya emitido sigue diciendo lo que decía) y la corrección se audita.
 */
export interface TasaDelDiaProps {
  puedePublicar: boolean;
}

export const TasaDelDia = ({ puedePublicar }: TasaDelDiaProps) => {
  const cliente = useQueryClient();
  const { notice, exito, error } = useNotice();
  const [valor, setValor] = useState('');
  const [motivo, setMotivo] = useState('');

  const tasa = useQuery({
    queryKey: ['billing', 'rate'],
    queryFn: ({ signal }) => billingApi.rateToday(signal),
  });

  const publicar = useMutation({
    mutationFn: () =>
      billingApi.setRate({
        rateDate: rateDateInCaracas(),
        rate: valor.trim(),
        note: motivo.trim() === '' ? null : motivo.trim(),
      }),
    onSuccess: async () => {
      exito(t('caja.tasa.exito'));
      setValor('');
      setMotivo('');
      await cliente.invalidateQueries({ queryKey: ['billing'] });
    },
    onError: (fallo: unknown) => error(apiErrorMessage(fallo)),
  });

  const vigente = tasa.data?.current ?? null;
  const hayTasaDeHoy = vigente !== null && vigente.rateDate === rateDateInCaracas();

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('caja.tasa.titulo')}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {tasa.isLoading && <Spinner />}
        {tasa.isError && <Alert variant="danger">{apiErrorMessage(tasa.error)}</Alert>}

        {tasa.data !== undefined && (
          <>
            {vigente === null ? (
              <Alert variant="warning">{t('caja.tasa.sinTasa')}</Alert>
            ) : (
              <p className="text-sm text-ink">
                <span className="text-ink-muted">{t('caja.tasa.vigente')}: </span>
                <span className="font-semibold tabular-nums">
                  {tasaEnTexto(vigente.rateMicros)}
                </span>
                <span className="text-ink-muted"> Bs./US$ · {vigente.rateDate}</span>
                {vigente.rateDate !== rateDateInCaracas() && (
                  <span className="block text-xs text-ink-muted">
                    {t('caja.tasa.arrastra', {
                      fecha: vigente.rateDate,
                      dias: tasa.data.gapDays,
                    })}
                  </span>
                )}
              </p>
            )}

            {tasa.data.needsConfirmation && (
              <Alert variant="warning">{t('caja.tasa.confirmar')}</Alert>
            )}
          </>
        )}

        {notice !== null && <Alert variant={notice.variant}>{notice.message}</Alert>}

        {puedePublicar && (
          <div className="space-y-2 border-t border-line pt-3">
            <Field label={t('caja.tasa.valor')} hint={t('caja.tasa.valorAyuda')}>
              <Input
                inputMode="decimal"
                autoComplete="off"
                placeholder="36,5420"
                value={valor}
                onChange={(evento) => setValor(evento.target.value)}
              />
            </Field>
            {hayTasaDeHoy && (
              <Field label={t('caja.tasa.motivo')} hint={t('caja.tasa.motivoAyuda')}>
                <Input
                  autoComplete="off"
                  value={motivo}
                  onChange={(evento) => setMotivo(evento.target.value)}
                />
              </Field>
            )}
            <Button
              type="button"
              disabled={
                publicar.isPending ||
                valor.trim() === '' ||
                (hayTasaDeHoy && motivo.trim().length < 3)
              }
              onClick={() => publicar.mutate()}
            >
              {publicar.isPending
                ? t('comun.guardando')
                : hayTasaDeHoy
                  ? t('caja.tasa.corregir')
                  : t('caja.tasa.publicar')}
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
};
