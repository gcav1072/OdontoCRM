import {
  BRAND_LIMITS,
  HEX_COLOR_PATTERN,
  type AppSettingsView,
  type BrandPaletteSettings,
  type BrandSettings,
  type RecipePaper,
} from '@odontocrm/contracts';
import {
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

import { apiErrorMessageConCampos } from '../../lib/api';
import { settingsApi } from '../../lib/endpoints';
import { t } from '../../lib/i18n';
import { APP_SETTINGS_QUERY_KEY } from '../../lib/queryKeys';
import { MembreteSection } from './MembreteSection';
import { PESOS_FUENTE, RolTipografico } from './RolTipografico';

export interface MarcaSectionProps {
  vista: AppSettingsView;
  onNotice: (variant: 'success' | 'danger', message: string) => void;
}

/** La opción del desplegable de subida para dar de alta una familia nueva. */
const FAMILIA_NUEVA = '__nueva__';

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

/** ¿La pila de un rol es válida? Una pila vacía deja el papel sin tipografía. */
const pilaValida = (pila: string): boolean => pila.trim() !== '';

/** ¿El número cae dentro de los límites del esquema? */
const enRango = (valor: number, rango: { min: number; max: number }): boolean =>
  Number.isFinite(valor) && valor >= rango.min && valor <= rango.max;

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
  /** Familia a la que se sube la fuente (existente o el nombre de una nueva). */
  const [familiaFuente, setFamiliaFuente] = useState<string>('');
  const [nombreNuevaFamilia, setNombreNuevaFamilia] = useState('');
  /** Peso y estilo de la fuente que se va a subir (los elige quien sube). */
  const [pesoFuente, setPesoFuente] = useState<number>(400);
  const [estiloFuente, setEstiloFuente] = useState<'normal' | 'italic'>('normal');
  const inputFuente = useRef<HTMLInputElement | null>(null);

  const nombresFamilia = form.fonts.families.map((una) => una.name);
  /** El valor efectivo del desplegable de subida (cae en la primera familia si no hay). */
  const familiaParaSubir =
    familiaFuente === FAMILIA_NUEVA || nombresFamilia.includes(familiaFuente)
      ? familiaFuente
      : (nombresFamilia[0] ?? FAMILIA_NUEVA);

  // El formulario refleja lo guardado; al llegar (o al guardar) se sincroniza.
  useEffect(() => setForm(vista.brand), [vista.brand]);

  const guardar = useMutation({
    mutationFn: () => settingsApi.updateBrand(form),
    onSuccess: () => {
      void consultas.invalidateQueries({ queryKey: APP_SETTINGS_QUERY_KEY });
      onNotice('success', t('config.guardado'));
    },
    onError: (fallo) => onNotice('danger', apiErrorMessageConCampos(fallo)),
  });

  const subirFuente = async (file: File): Promise<void> => {
    const familia =
      familiaParaSubir === FAMILIA_NUEVA ? nombreNuevaFamilia.trim() : familiaParaSubir;
    if (familia === '') {
      onNotice('danger', t('config.marca.faltaFamilia'));
      return;
    }
    setSubiendo(true);
    try {
      await settingsApi.uploadFont(file, {
        family: familia,
        weight: pesoFuente,
        style: estiloFuente,
      });
      await consultas.invalidateQueries({ queryKey: APP_SETTINGS_QUERY_KEY });
      onNotice('success', t('config.guardado'));
      setNombreNuevaFamilia('');
      setFamiliaFuente(familia);
    } catch (fallo) {
      onNotice('danger', apiErrorMessageConCampos(fallo));
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
      onNotice('danger', apiErrorMessageConCampos(fallo));
    }
  };

  const paletaOk = paletaValida(form.palette);
  /** La pila de los títulos y del cuerpo no puede quedar vacía (el papel saldría sin fuente). */
  const tituloOk = pilaValida(form.typography.documentTitleSans);
  const cuerpoOk = pilaValida(form.typography.documentBodySans);
  /** `null` = «la de los títulos»; una cadena vacía sí es un error. */
  const membreteOk = form.letterhead.titleSans === null || pilaValida(form.letterhead.titleSans);
  /**
   * Todas las medidas del esquema: si una sale del rango, el servidor devolvería un 400
   * genérico. Se valida aquí para poder señalarla antes de enviar.
   */
  const medidasOk =
    enRango(form.typography.documentTitlePt, BRAND_LIMITS.documentTitlePt) &&
    enRango(form.typography.documentBodyPt, BRAND_LIMITS.documentBodyPt) &&
    enRango(form.typography.documentSmallPt, BRAND_LIMITS.documentSmallPt) &&
    enRango(form.letterhead.logoHeightMm, BRAND_LIMITS.logoHeightMm) &&
    enRango(form.letterhead.titlePt, BRAND_LIMITS.titlePt) &&
    enRango(form.letterhead.linePt, BRAND_LIMITS.linePt) &&
    enRango(form.letterhead.watermarkWidthMm, BRAND_LIMITS.watermarkWidthMm) &&
    enRango(form.letterhead.watermarkOpacity, BRAND_LIMITS.watermarkOpacity);
  const marcaOk = paletaOk && tituloOk && cuerpoOk && membreteOk && medidasOk;

  /** Mensaje de «fuera de rango» con los límites que aplica el esquema. */
  const errorRango = (valor: number, rango: { min: number; max: number }): string | undefined =>
    enRango(valor, rango)
      ? undefined
      : t('config.marca.rangoInvalido', { min: rango.min, max: rango.max });

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
          <div className="grid gap-4 @2xl:grid-cols-2 @5xl:grid-cols-3">
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
                      className="h-9 w-10 shrink-0 cursor-pointer rounded-control border border-border bg-surface"
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
          <div className="space-y-3">
            <RolTipografico
              etiqueta={t('config.marca.fuenteTitulos')}
              pila={form.typography.documentTitleSans}
              peso={form.typography.documentTitleWeight}
              familias={form.fonts.families}
              muestra="Dr. Juan Pérez · RÉCIPE"
              error={tituloOk ? undefined : t('config.marca.pilaRequerida')}
              onPila={(pila) =>
                setForm((prev) => ({
                  ...prev,
                  typography: { ...prev.typography, documentTitleSans: pila },
                }))
              }
              onPeso={(peso) =>
                setForm((prev) => ({
                  ...prev,
                  typography: { ...prev.typography, documentTitleWeight: peso },
                }))
              }
            />
            <RolTipografico
              etiqueta={t('config.marca.fuenteCuerpo')}
              pila={form.typography.documentBodySans}
              peso={form.typography.documentBodyWeight}
              familias={form.fonts.families}
              muestra="La paciente acude a consulta por dolor en el primer molar superior derecho."
              error={cuerpoOk ? undefined : t('config.marca.pilaRequerida')}
              onPila={(pila) =>
                setForm((prev) => ({
                  ...prev,
                  typography: { ...prev.typography, documentBodySans: pila },
                }))
              }
              onPeso={(peso) =>
                setForm((prev) => ({
                  ...prev,
                  typography: { ...prev.typography, documentBodyWeight: peso },
                }))
              }
            />
          </div>
          <div className="grid gap-2 @2xl:grid-cols-3">
            <Field
              label={t('config.marca.tamanoTitulo')}
              error={errorRango(form.typography.documentTitlePt, BRAND_LIMITS.documentTitlePt)}
            >
              <Input
                type="number"
                step="0.5"
                min={BRAND_LIMITS.documentTitlePt.min}
                max={BRAND_LIMITS.documentTitlePt.max}
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
            </Field>{' '}
            <Field
              label={t('config.marca.tamanoCuerpo')}
              error={errorRango(form.typography.documentBodyPt, BRAND_LIMITS.documentBodyPt)}
            >
              <Input
                type="number"
                step="0.5"
                min={BRAND_LIMITS.documentBodyPt.min}
                max={BRAND_LIMITS.documentBodyPt.max}
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
            <Field
              label={t('config.marca.tamanoMenudo')}
              error={errorRango(form.typography.documentSmallPt, BRAND_LIMITS.documentSmallPt)}
            >
              <Input
                type="number"
                step="0.5"
                min={BRAND_LIMITS.documentSmallPt.min}
                max={BRAND_LIMITS.documentSmallPt.max}
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

          {/* El papel del récipe: tiene que ser el de la bandeja. Una hoja A4 apaisada mide
              210 mm de alto y no entra en una carta (215,9 mm): la impresora parte lo que
              sobra —en blanco— a una segunda hoja. */}
          <div className="grid gap-2 @2xl:grid-cols-3">
            <Field label={t('config.marca.papel')} hint={t('config.marca.papelAyuda')}>
              <Select
                value={form.recipePaper}
                onChange={(event) =>
                  setForm((prev) => ({
                    ...prev,
                    recipePaper: event.target.value as RecipePaper,
                  }))
                }
              >
                <option value="letter">{t('config.marca.papelCarta')}</option>
                <option value="A4">{t('config.marca.papelA4')}</option>
              </Select>
            </Field>
          </div>
        </section>

        {/* Medidas del logo y del velo, tipografía del nombre, líneas y pie: la
            subsección «Membrete» los agrupa y añade una vista previa en vivo. */}
        <MembreteSection form={form} setForm={setForm} />

        {/* Fuentes */}
        <section className="space-y-3">
          <h3 className="text-sm font-semibold text-ink">{t('config.marca.fuentes')}</h3>
          <p className="text-sm text-ink-muted">{t('config.marca.fuentesAyuda')}</p>
          <ul className="space-y-3">
            {form.fonts.families.map((familia) => (
              <li key={familia.name} className="space-y-2">
                <p className="text-xs font-semibold text-ink">{familia.name}</p>
                <ul className="space-y-2">
                  {familia.files.map((file) => (
                    <li
                      key={file.path}
                      className="flex flex-wrap items-center justify-between gap-2 rounded-control border border-border px-3 py-2 text-sm"
                    >
                      <span className="font-mono text-xs text-ink-muted">
                        {file.label ?? file.path}
                      </span>
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

          {/* Familia, peso y estilo del archivo que se va a subir: elegirlos antes de
              subir es lo que hace útil el archivo. Subir el mismo peso/estilo de la
              misma familia reemplaza el anterior. */}
          <div className="flex flex-wrap items-end gap-3">
            <Field label={t('config.marca.familia')}>
              <Select
                value={familiaParaSubir}
                onChange={(event) => setFamiliaFuente(event.target.value)}
                className="max-w-56"
                disabled={subiendo}
              >
                {nombresFamilia.map((nombre) => (
                  <option key={nombre} value={nombre}>
                    {nombre}
                  </option>
                ))}
                <option value={FAMILIA_NUEVA}>{t('config.marca.familiaNueva')}</option>
              </Select>
            </Field>
            {familiaParaSubir === FAMILIA_NUEVA && (
              <Field label={t('config.marca.nombreFamilia')}>
                <Input
                  value={nombreNuevaFamilia}
                  onChange={(event) => setNombreNuevaFamilia(event.target.value)}
                  className="max-w-56"
                  disabled={subiendo}
                />
              </Field>
            )}
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
              disabled={familiaParaSubir === FAMILIA_NUEVA && nombreNuevaFamilia.trim() === ''}
              onClick={() => inputFuente.current?.click()}
              leadingIcon={<Upload className="size-4" aria-hidden="true" />}
            >
              {t('config.marca.subirFuente')}
            </Button>
          </div>
          <p className="text-xs text-ink-subtle">{t('config.marca.fuenteReemplaza')}</p>
        </section>

        <Button
          loading={guardar.isPending}
          loadingLabel={t('comun.guardando')}
          disabled={!marcaOk}
          onClick={() => guardar.mutate()}
        >
          {t('comun.guardar')}
        </Button>
      </CardContent>
    </Card>
  );
};
