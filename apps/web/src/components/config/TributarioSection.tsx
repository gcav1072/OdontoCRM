import {
  igtfPercentLabel,
  type BillingSettings,
  type UpdateBillingSettingsInput,
} from '@odontocrm/contracts';
import { Alert, Button, Card, CardContent, CardHeader, CardTitle, Field, Input, Switch } from '@odontocrm/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';

import { apiErrorMessage } from '../../lib/api';
import { parseUsdToCents } from '../../lib/caja';
import { billingApi } from '../../lib/endpoints';
import { t } from '../../lib/i18n';

export interface TributarioSectionProps {
  onNotice: (variant: 'success' | 'danger', message: string) => void;
}

/**
 * **Régimen tributario** de la caja (ADR 0045 y 0069), en el panel del `admin` (`settings:manage`).
 *
 * El interruptor del **Sujeto Pasivo Especial** no es una declaración propia: lo notifica el SENIAT, y
 * por eso se guarda junto a él la fecha y el oficio de la calificación. La **alícuota** del IGTF se
 * teclea en porcentaje (3,00) y viaja como puntos básicos (300): se **copia** en cada cobro, así que
 * cambiarla aquí no reescribe lo ya percibido.
 */
export const TributarioSection = ({ onNotice }: TributarioSectionProps) => {
  const consultas = useQueryClient();
  const ajustes = useQuery({
    queryKey: ['billing', 'settings'],
    queryFn: ({ signal }) => billingApi.settings(signal),
  });

  const [isSpecialTaxpayer, setIsSpecialTaxpayer] = useState(false);
  const [speNotifiedAt, setSpeNotifiedAt] = useState('');
  const [speReference, setSpeReference] = useState('');
  const [alicuotaTexto, setAlicuotaTexto] = useState('3,00');

  useEffect(() => {
    const datos: BillingSettings | undefined = ajustes.data;
    if (datos === undefined) return;
    setIsSpecialTaxpayer(datos.isSpecialTaxpayer);
    setSpeNotifiedAt(datos.speNotifiedAt ?? '');
    setSpeReference(datos.speReference ?? '');
    setAlicuotaTexto(igtfPercentLabel(datos.igtfRateBp).replace(' %', ''));
  }, [ajustes.data]);

  /** «3,00» → 300 puntos básicos: la misma conversión de dos decimales que el dinero. */
  const alicuotaBp = parseUsdToCents(alicuotaTexto);
  const alicuotaValida = alicuotaBp !== null && alicuotaBp >= 0 && alicuotaBp <= 10_000;

  const guardar = useMutation({
    mutationFn: (): Promise<BillingSettings> => {
      const cambios: UpdateBillingSettingsInput = {
        isSpecialTaxpayer,
        speNotifiedAt: speNotifiedAt === '' ? null : speNotifiedAt,
        speReference: speReference === '' ? null : speReference,
        ...(alicuotaBp === null ? {} : { igtfRateBp: alicuotaBp }),
      };
      return billingApi.updateSettings(cambios);
    },
    onSuccess: () => {
      void consultas.invalidateQueries({ queryKey: ['billing'] });
      onNotice('success', t('config.tributario.guardado'));
    },
    onError: (fallo) => onNotice('danger', apiErrorMessage(fallo)),
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle as="h2">{t('config.tributario.titulo')}</CardTitle>
        <p className="pt-1 text-sm text-ink-muted">{t('config.tributario.descripcion')}</p>
      </CardHeader>
      <CardContent className="space-y-4">
        {ajustes.isError && (
          <Alert variant="danger">{apiErrorMessage(ajustes.error)}</Alert>
        )}

        <Switch
          checked={isSpecialTaxpayer}
          onChange={(evento) => setIsSpecialTaxpayer(evento.target.checked)}
          label={t('config.tributario.spe')}
          description={t('config.tributario.speAyuda')}
        />

        {isSpecialTaxpayer && (
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={t('config.tributario.fecha')}>
              <Input
                type="date"
                value={speNotifiedAt}
                onChange={(evento) => setSpeNotifiedAt(evento.target.value)}
              />
            </Field>
            <Field label={t('config.tributario.oficio')}>
              <Input
                autoComplete="off"
                value={speReference}
                onChange={(evento) => setSpeReference(evento.target.value)}
              />
            </Field>
            <Field label={t('config.tributario.alicuota')} hint={t('config.tributario.alicuotaAyuda')}>
              <Input
                inputMode="decimal"
                autoComplete="off"
                value={alicuotaTexto}
                onChange={(evento) => setAlicuotaTexto(evento.target.value)}
              />
            </Field>
          </div>
        )}

        <Alert variant="info">{t('config.tributario.nota')}</Alert>

        <div className="flex justify-end">
          <Button
            onClick={() => guardar.mutate()}
            loading={guardar.isPending}
            loadingLabel={t('comun.guardando')}
            disabled={!alicuotaValida || ajustes.isPending}
          >
            {t('comun.guardar')}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
};
