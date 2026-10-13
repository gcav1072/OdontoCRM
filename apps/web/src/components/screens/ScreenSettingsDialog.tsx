import { SCREEN_THEMES, UI_ACCENT_IDS, type ScreenDevice } from '@odontocrm/contracts';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Alert, Button, Dialog, Field, Input, Switch, cn } from '@odontocrm/ui';
import { Moon, Sun } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';

import { AccentPicker } from '../config/AccentPicker';
import { apiErrorMessage } from '../../lib/api';
import { screensApi } from '../../lib/endpoints';
import { t } from '../../lib/i18n';
import { screenKeys } from '../../lib/screens';

/**
 * Esquema del formulario de ajustes.
 *
 * Los rangos son los mismos que aplica el servidor (`screenSettingsSchema` de
 * los contratos): 0–1 de volumen, 3–120 segundos en pantalla y 0–300 de repetición
 * (0 = no repetir). Aquí **no** se usan los valores por defecto del contrato
 * porque el formulario siempre trae los ajustes actuales de la pantalla.
 * El `_` del nombre es porque el esquema solo se usa para deducir los tipos: la
 * validación real la hace el `PATCH` en el servidor.
 */
const _esquemaAjustes = z.object({
  voz: z.boolean(),
  volumen: z.coerce.number().min(0, 'Entre 0 y 1').max(1, 'Entre 0 y 1'),
  resalteSegundos: z.coerce
    .number()
    .int()
    .min(3, 'Entre 3 y 120 segundos')
    .max(120, 'Entre 3 y 120 segundos'),
  repetirSegundos: z.coerce
    .number()
    .int()
    .min(0, 'Entre 0 y 300 segundos')
    .max(300, 'Entre 0 y 300 segundos'),
  /** El aspecto es **propio de la pantalla**: modo, acento y marca de agua. */
  tema: z.enum(SCREEN_THEMES),
  acento: z.enum(UI_ACCENT_IDS),
  logoMarcaAgua: z.boolean(),
});

type ValoresFormulario = z.input<typeof _esquemaAjustes>;
type ValoresEnviados = z.output<typeof _esquemaAjustes>;

export interface ScreenSettingsDialogProps {
  /** `null` cierra el diálogo. */
  pantalla: ScreenDevice | null;
  onClose: () => void;
  /** Ajustes guardados: la página avisa con el nombre de la pantalla. */
  onSaved: (mensaje: string, nombre: string) => void;
}

/**
 * Ajustes de voz y resalte de una pantalla (`PATCH /screens/devices/:id`).
 *
 * El volumen se teclea como número entre 0 y 1 y los tiempos en segundos: son
 * los tres valores que la pantalla aplica en vivo, sin reinstalar nada.
 */
export const ScreenSettingsDialog = ({ pantalla, onClose, onSaved }: ScreenSettingsDialogProps) => {
  const cliente = useQueryClient();
  const [errorGeneral, setErrorGeneral] = useState<string | null>(null);

  const formulario = useForm<ValoresFormulario, unknown, ValoresEnviados>({
    defaultValues: {
      voz: true,
      volumen: '1',
      resalteSegundos: '20',
      repetirSegundos: '0',
      tema: 'oscuro',
      acento: 'teal',
      logoMarcaAgua: false,
    },
  });

  const { reset } = formulario;
  useEffect(() => {
    if (pantalla === null) return;
    setErrorGeneral(null);
    // Los números se pasan como texto: los campos del formulario son de texto y
    // Zod los convierte al enviar.
    reset({
      voz: pantalla.settings.voz,
      volumen: String(pantalla.settings.volumen),
      resalteSegundos: String(pantalla.settings.resalteSegundos),
      repetirSegundos: String(pantalla.settings.repetirSegundos),
      tema: pantalla.settings.tema,
      acento: pantalla.settings.acento,
      logoMarcaAgua: pantalla.settings.logoMarcaAgua,
    });
  }, [pantalla, reset]);

  const guardar = useMutation({
    mutationFn: async (valores: ValoresEnviados) => {
      if (pantalla === null) throw new Error('No hay pantalla seleccionada');
      return screensApi.updateDevice(pantalla.id, { settings: valores });
    },
  });

  const enviar = async (valores: ValoresEnviados) => {
    if (pantalla === null) return;
    setErrorGeneral(null);
    const nombre = pantalla.label;
    try {
      await guardar.mutateAsync(valores);
      void cliente.invalidateQueries({ queryKey: screenKeys.devices });
      onClose();
      onSaved(t('pantallas.ajustes.guardado'), nombre);
    } catch (fallo) {
      setErrorGeneral(apiErrorMessage(fallo));
    }
  };

  const { errors, isSubmitting } = formulario.formState;
  const temaActual = formulario.watch('tema');
  const acentoActual = formulario.watch('acento');

  return (
    <Dialog
      open={pantalla !== null}
      onClose={onClose}
      size="md"
      title={t('pantallas.ajustes')}
      description={pantalla?.label}
      dismissOnBackdrop={false}
      closeLabel={t('comun.cerrar')}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={isSubmitting}>
            {t('comun.cancelar')}
          </Button>
          <Button
            type="submit"
            form="formulario-ajustes-pantalla"
            loading={isSubmitting}
            loadingLabel={t('comun.guardando')}
          >
            {t('pantallas.ajustes.guardar')}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {errorGeneral && (
          <Alert variant="danger" title={t('pantallas.errorAccion')}>
            {errorGeneral}
          </Alert>
        )}

        <form
          id="formulario-ajustes-pantalla"
          noValidate
          className="space-y-4"
          onSubmit={(event) => {
            void formulario.handleSubmit(enviar)(event);
          }}
        >
          <Switch label={t('pantallas.ajustes.voz')} {...formulario.register('voz')} />

          <div className="grid gap-4 @2xl:grid-cols-3">
            <Field label={t('pantallas.ajustes.volumen')} error={errors.volumen?.message} required>
              <Input
                type="number"
                min={0}
                max={1}
                step={0.05}
                inputMode="decimal"
                {...formulario.register('volumen')}
              />
            </Field>

            <Field
              label={t('pantallas.ajustes.resalte')}
              error={errors.resalteSegundos?.message}
              required
            >
              <Input
                type="number"
                min={3}
                max={120}
                step={1}
                inputMode="numeric"
                {...formulario.register('resalteSegundos')}
              />
            </Field>

            <Field
              label={t('pantallas.ajustes.repetir')}
              error={errors.repetirSegundos?.message}
              required
            >
              <Input
                type="number"
                min={0}
                max={300}
                step={1}
                inputMode="numeric"
                {...formulario.register('repetirSegundos')}
              />
            </Field>
          </div>

          {/* Aspecto propio de la pantalla: no sigue el tema de la aplicación. */}
          <div className="space-y-4 border-t border-border pt-4">
            <div>
              <p className="text-sm font-semibold text-ink">{t('pantallas.ajustes.estetica')}</p>
              <p className="text-xs text-ink-muted">{t('pantallas.ajustes.estetica.ayuda')}</p>
            </div>

            <div className="space-y-2">
              <p className="text-sm font-medium text-ink">{t('pantallas.ajustes.tema')}</p>
              <div
                role="radiogroup"
                aria-label={t('pantallas.ajustes.tema')}
                className="flex flex-wrap gap-3"
              >
                {SCREEN_THEMES.map((modo) => {
                  const elegido = temaActual === modo;
                  const Icono = modo === 'claro' ? Sun : Moon;
                  return (
                    <button
                      key={modo}
                      type="button"
                      role="radio"
                      aria-checked={elegido}
                      onClick={() => formulario.setValue('tema', modo, { shouldDirty: true })}
                      className={cn(
                        'flex items-center gap-2 rounded-control border-2 px-3 py-2 text-sm transition-colors',
                        elegido
                          ? 'border-primary bg-surface-muted'
                          : 'border-border hover:bg-surface-muted',
                      )}
                    >
                      <Icono className="size-4" aria-hidden="true" />
                      {t(`pantallas.ajustes.tema.${modo}`)}
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="space-y-2">
              <p className="text-sm font-medium text-ink">{t('pantallas.ajustes.acento')}</p>
              <AccentPicker
                value={acentoActual}
                onChange={(valor) => formulario.setValue('acento', valor, { shouldDirty: true })}
                ariaLabel={t('pantallas.ajustes.acento')}
              />
            </div>

            <div className="space-y-1">
              <Switch
                label={t('pantallas.ajustes.marcaAgua')}
                {...formulario.register('logoMarcaAgua')}
              />
              <p className="text-xs text-ink-muted">{t('pantallas.ajustes.marcaAgua.ayuda')}</p>
            </div>
          </div>
        </form>
      </div>
    </Dialog>
  );
};
