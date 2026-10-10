import { UI_ACCENTS, UI_ACCENT_IDS, type UIAccentId } from '@odontocrm/contracts';
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  cn,
} from '@odontocrm/ui';
import { Palette } from 'lucide-react';

import { t } from '../../lib/i18n';

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
 * Cada opción enseña su color real en claro y en oscuro, así que la elección se ve antes
 * de guardar.
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
      <div
        role="radiogroup"
        aria-label={t('config.acento.titulo')}
        className="flex flex-wrap gap-3"
      >
        {UI_ACCENT_IDS.map((id) => {
          const preset = UI_ACCENTS[id];
          const elegido = id === acento;
          return (
            <button
              key={id}
              type="button"
              role="radio"
              aria-checked={elegido}
              onClick={() => onAcento(id)}
              className={cn(
                'flex items-center gap-2 rounded-control border-2 px-3 py-2 text-sm transition-colors',
                elegido
                  ? 'border-primary bg-surface-muted'
                  : 'border-border hover:bg-surface-muted',
              )}
            >
              <span
                className="inline-block size-5 rounded-full border border-border"
                style={{ background: preset.light.primary }}
                aria-hidden="true"
              />
              <span
                className="inline-block size-5 rounded-full border border-border"
                style={{ background: preset.dark.primary }}
                aria-hidden="true"
              />
              {preset.label}
            </button>
          );
        })}
      </div>

      <Button loading={guardando} loadingLabel={t('comun.guardando')} onClick={onGuardar}>
        {t('comun.guardar')}
      </Button>
    </CardContent>
  </Card>
);
