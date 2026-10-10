import {
  HEX_COLOR_PATTERN,
  type AppSettingsView,
  type BrandPaletteSettings,
  type BrandSettings,
} from '@odontocrm/contracts';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Field,
  Input,
  Select,
} from '@odontocrm/ui';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Paintbrush, Trash2, Upload } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import { apiErrorMessage } from '../../lib/api';
import { settingsApi } from '../../lib/endpoints';
import { t } from '../../lib/i18n';
import { APP_SETTINGS_QUERY_KEY } from '../../lib/queryKeys';

export interface MarcaSectionProps {
  vista: AppSettingsView;
  onNotice: (variant: 'success' | 'danger', message: string) => void;
}

/**
 * Pesos que se ofrecen al subir una fuente. Son los múltiplos de 100 de la
 * especificación `font-weight`: 400 es el cuerpo normal y 700 el de los títulos.
 */
const PESOS_FUENTE = [100, 200, 300, 400, 500, 600, 700, 800, 900] as const;

/** Los trece colores de la paleta con su rótulo. */
const PALETA: readonly { key: keyof BrandPaletteSettings; label: string }[] = [
  { key: 'primary', label: t('config.paleta.primary') },
  { key: 'primaryInk', label: t('config.paleta.primaryInk') },
  { key: 'accent', label: t('config.paleta.accent') },
  { key: 'ink', label: t('config.paleta.ink') },
  { key: 'inkStrong', label: t('config.paleta.inkStrong') },
  { key: 'inkMuted', label: t('config.paleta.inkMuted') },
  { key: 'inkSubtle', label: t('config.paleta.inkSubtle') },
  { key: 'line', label: t('config.paleta.line') },
  { key: 'lineSoft', label: t('config.paleta.lineSoft') },
  { key: 'tableHeadBg', label: t('config.paleta.tableHeadBg') },
  { key: 'good', label: t('config.paleta.good') },
  { key: 'warn', label: t('config.paleta.warn') },
  { key: 'bad', label: t('config.paleta.bad') },
];

/** ¿Todos los colores de la paleta son hex válidos? */
const paletaValida = (palette: BrandPaletteSettings): boolean =>
  Object.values(palette).every((color) => HEX_COLOR_PATTERN.test(color));

/**
 * **Marca de los imprimibles** (ADR 0060): paleta, tipografías, medidas y fuentes.
 *
 * Los colores se editan **en hex libre** (el papel se imprime sobre blanco y el
 * consultorio decide su identidad); el aviso de contraste es informativo, no bloquea. Las
 * fuentes `.woff2` subidas van al almacén y valen para el PDF del servidor y para lo que
 * imprime el navegador: son los mismos archivos.
 */
export const MarcaSection = ({ vista, onNotice }: MarcaSectionProps) => {
  const consultas = useQueryClient();
  const [form, setForm] = useState<BrandSettings>(vista.brand);
  const [subiendo, setSubiendo] = useState(false);
  /** Peso y estilo de la fuente que se va a subir (los elige quien sube). */
  const [pesoFuente, setPesoFuente] = useState<number>(400);
  const [estiloFuente, setEstiloFuente] = useState<'normal' | 'italic'>('normal');
  const inputFuente = useRef<HTMLInputElement | null>(null);

  // El formulario refleja lo guardado; al llegar (o al guardar) se sincroniza.
  useEffect(() => setForm(vista.brand), [vista.brand]);

  const guardar = useMutation({
    mutationFn: () => settingsApi.updateBrand(form),
    onSuccess: () => {
      void consultas.invalidateQueries({ queryKey: APP_SETTINGS_QUERY_KEY });
      onNotice('success', t('config.guardado'));
    },
    onError: (fallo) => onNotice('danger', apiErrorMessage(fallo)),
  });

  const subirFuente = async (file: File): Promise<void> => {
    setSubiendo(true);
    try {
      await settingsApi.uploadFont(file, { weight: pesoFuente, style: estiloFuente });
      await consultas.invalidateQueries({ queryKey: APP_SETTINGS_QUERY_KEY });
      onNotice('success', t('config.guardado'));
    } catch (fallo) {
      onNotice('danger', apiErrorMessage(fallo));
    } finally {
      setSubiendo(false);
      if (inputFuente.current !== null) inputFuente.current.value = '';
    }
  };

  const quitarFuente = async (path: string): Promise<void> => {
    try {
      await settingsApi.removeFont(path);
      await consultas.invalidateQueries({ queryKey: APP_SETTINGS_QUERY_KEY });
      onNotice('success', t('config.guardado'));
    } catch (fallo) {
      onNotice('danger', apiErrorMessage(fallo));
    }
  };

  const paletaOk = paletaValida(form.palette);

  return (
    <Card>
      <CardHeader>
        <CardTitle as="h2" className="flex items-center gap-2">
          <Paintbrush className="size-4 text-primary" aria-hidden="true" />
          {t('config.marca.titulo')}
        </CardTitle>
        <CardDescription>{t('config.marca.descripcion')}</CardDescription>
      </CardHeader>

      <CardContent className="space-y-6">
        {/* Paleta */}
        <section className="space-y-3">
          <h3 className="text-sm font-semibold text-ink">{t('config.marca.paleta')}</h3>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {PALETA.map(({ key, label }) => {
              const valor = form.palette[key];
              const invalido = !HEX_COLOR_PATTERN.test(valor);
              return (
                <Field key={key} label={label} error={invalido ? 'Usa #rrggbb' : undefined}>
                  <div className="flex items-center gap-2">
                    <input
                      type="color"
                      aria-label={label}
                      value={HEX_COLOR_PATTERN.test(valor) ? valor : '#000000'}
                      onChange={(event) =>
                        setForm((prev) => ({
                          ...prev,
                          palette: { ...prev.palette, [key]: event.target.value },
                        }))
                      }
                      className="h-9 w-10 cursor-pointer rounded-control border border-border bg-surface"
                    />
                    <Input
                      value={valor}
                      onChange={(event) =>
                        setForm((prev) => ({
                          ...prev,
                          palette: { ...prev.palette, [key]: event.target.value },
                        }))
                      }
                      className="font-mono"
                    />
                  </div>
                </Field>
              );
            })}
          </div>
        </section>

        {/* Tipografías */}
        <section className="space-y-3">
          <h3 className="text-sm font-semibold text-ink">{t('config.marca.tipografia')}</h3>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={t('config.marca.familia')}>
              <Input
                value={form.fonts.family}
                onChange={(event) =>
                  setForm((prev) => ({
                    ...prev,
                    fonts: { ...prev.fonts, family: event.target.value },
                  }))
                }
              />
            </Field>
            <Field label={t('config.marca.titulos')}>
              <Input
                value={form.typography.documentTitleSans}
                onChange={(event) =>
                  setForm((prev) => ({
                    ...prev,
                    typography: { ...prev.typography, documentTitleSans: event.target.value },
                  }))
                }
              />
            </Field>
            <Field label={t('config.marca.cuerpo')}>
              <Input
                value={form.typography.documentBodySans}
                onChange={(event) =>
                  setForm((prev) => ({
                    ...prev,
                    typography: { ...prev.typography, documentBodySans: event.target.value },
                  }))
                }
              />
            </Field>
            <div className="grid grid-cols-3 gap-2">
              <Field label="Título (pt)">
                <Input
                  type="number"
                  step="0.5"
                  value={form.typography.documentTitlePt}
                  onChange={(event) =>
                    setForm((prev) => ({
                      ...prev,
                      typography: {
                        ...prev.typography,
                        documentTitlePt: Number(event.target.value),
                      },
                    }))
                  }
                />
              </Field>
              <Field label="Cuerpo (pt)">
                <Input
                  type="number"
                  step="0.5"
                  value={form.typography.documentBodyPt}
                  onChange={(event) =>
                    setForm((prev) => ({
                      ...prev,
                      typography: {
                        ...prev.typography,
                        documentBodyPt: Number(event.target.value),
                      },
                    }))
                  }
                />
              </Field>
              <Field label="Menudo (pt)">
                <Input
                  type="number"
                  step="0.5"
                  value={form.typography.documentSmallPt}
                  onChange={(event) =>
                    setForm((prev) => ({
                      ...prev,
                      typography: {
                        ...prev.typography,
                        documentSmallPt: Number(event.target.value),
                      },
                    }))
                  }
                />
              </Field>
            </div>
          </div>
        </section>

        {/* Medidas */}
        <section className="space-y-3">
          <h3 className="text-sm font-semibold text-ink">{t('config.marca.medidas')}</h3>
          <div className="grid gap-4 sm:grid-cols-3">
            <Field label={t('config.marca.altoLogo')}>
              <Input
                type="number"
                step="1"
                value={form.letterhead.logoHeightMm}
                onChange={(event) =>
                  setForm((prev) => ({
                    ...prev,
                    letterhead: { ...prev.letterhead, logoHeightMm: Number(event.target.value) },
                  }))
                }
              />
            </Field>
            <Field label={t('config.marca.anchoVelo')}>
              <Input
                type="number"
                step="1"
                value={form.letterhead.watermarkWidthMm}
                onChange={(event) =>
                  setForm((prev) => ({
                    ...prev,
                    letterhead: {
                      ...prev.letterhead,
                      watermarkWidthMm: Number(event.target.value),
                    },
                  }))
                }
              />
            </Field>
            <Field label={t('config.marca.opacidadVelo')}>
              <Input
                type="number"
                step="0.01"
                min={0}
                max={0.6}
                value={form.letterhead.watermarkOpacity}
                onChange={(event) =>
                  setForm((prev) => ({
                    ...prev,
                    letterhead: {
                      ...prev.letterhead,
                      watermarkOpacity: Number(event.target.value),
                    },
                  }))
                }
              />
            </Field>
          </div>
        </section>

        {/* Fuentes */}
        <section className="space-y-3">
          <h3 className="text-sm font-semibold text-ink">{t('config.marca.fuentes')}</h3>
          <p className="text-sm text-ink-muted">{t('config.marca.fuentesAyuda')}</p>
          <ul className="space-y-2">
            {form.fonts.files.map((file) => (
              <li
                key={file.path}
                className="flex flex-wrap items-center justify-between gap-2 rounded-control border border-border px-3 py-2 text-sm"
              >
                <span className="font-mono text-xs text-ink-muted">{file.label ?? file.path}</span>
                <span className="flex items-center gap-2">
                  <Badge variant="neutral">
                    {file.weight} · {file.style}
                  </Badge>
                  {file.source === 'repo' && (
                    <Badge variant="info">{t('config.marca.respaldo')}</Badge>
                  )}
                  {file.source === 'subido' && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => void quitarFuente(file.path)}
                      leadingIcon={<Trash2 className="size-4" aria-hidden="true" />}
                    >
                      {t('config.marca.quitarFuente')}
                    </Button>
                  )}
                </span>
              </li>
            ))}
          </ul>
          <input
            ref={inputFuente}
            type="file"
            accept=".woff2,font/woff2"
            className="hidden"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file !== undefined) void subirFuente(file);
            }}
          />

          {/* Peso y estilo del archivo que se va a subir: los títulos usan 700 y el
              cuerpo 400, así que elegirlos antes de subir es lo que hace útil el
              archivo. Subir el mismo peso/estilo reemplaza el anterior. */}
          <div className="flex flex-wrap items-end gap-3">
            <Field label={t('config.marca.peso')} hint={t('config.marca.fuenteAyuda')}>
              <Select
                value={String(pesoFuente)}
                onChange={(event) => setPesoFuente(Number(event.target.value))}
                className="max-w-40"
                disabled={subiendo}
              >
                {PESOS_FUENTE.map((peso) => (
                  <option key={peso} value={peso}>
                    {peso}
                    {peso === 400 ? ' · normal' : peso === 700 ? ' · negrita' : ''}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label={t('config.marca.estilo')}>
              <Select
                value={estiloFuente}
                onChange={(event) =>
                  setEstiloFuente(event.target.value === 'italic' ? 'italic' : 'normal')
                }
                className="max-w-40"
                disabled={subiendo}
              >
                <option value="normal">{t('config.marca.estiloNormal')}</option>
                <option value="italic">{t('config.marca.estiloItalic')}</option>
              </Select>
            </Field>
            <Button
              variant="secondary"
              loading={subiendo}
              loadingLabel={t('comun.enviando')}
              onClick={() => inputFuente.current?.click()}
              leadingIcon={<Upload className="size-4" aria-hidden="true" />}
            >
              {t('config.marca.subirFuente')}
            </Button>
          </div>
          <p className="text-xs text-ink-subtle">{t('config.marca.fuenteReemplaza')}</p>
        </section>

        <Alert variant="info">{t('config.marca.logoAyuda')}</Alert>

        <Button
          loading={guardar.isPending}
          loadingLabel={t('comun.guardando')}
          disabled={!paletaOk}
          onClick={() => guardar.mutate()}
        >
          {t('comun.guardar')}
        </Button>
      </CardContent>
    </Card>
  );
};
