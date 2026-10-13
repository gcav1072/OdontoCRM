import type { UIAccentId } from '@odontocrm/contracts';
import { Button, Card, CardContent, CardDescription, CardHeader, CardTitle } from '@odontocrm/ui';
import { Palette } from 'lucide-react';

import { t } from '../../lib/i18n';
import { AccentPicker } from './AccentPicker';

export interface AcentoSectionProps {
  acento: UIAccentId;
  onAcento: (accento: UIAccentId) => void;
  guardando: boolean;
  onGuardar: () => void;
}

/**
 * El **color de acento de la interfaz** (ADR 0060): diez presets que recorren el espectro.
 *
 * Solo mueve el **cromo** de la aplicación (botones, enlaces, foco): los imprimibles
 * tienen su propia paleta y los colores clínicos del odontograma (rojo/azul) no se tocan.
 * El selector es compartido con la configuración de las pantallas kiosko (`AccentPicker`).
 */
export const AcentoSection = ({ acento, onAcento, guardando, onGuardar }: AcentoSectionProps) => (
  <Card>
    <CardHeader>
      <CardTitle as="h2" className="flex items-center gap-2">
        <Palette className="size-4 text-primary" aria-hidden="true" />
        {t('config.acento.titulo')}
      </CardTitle>
      <CardDescription>{t('config.acento.descripcion')}</CardDescription>
    </CardHeader>

    <CardContent className="space-y-4">
      <AccentPicker value={acento} onChange={onAcento} ariaLabel={t('config.acento.titulo')} />

      <Button loading={guardando} loadingLabel={t('comun.guardando')} onClick={onGuardar}>
        {t('comun.guardar')}
      </Button>
    </CardContent>
  </Card>
);
