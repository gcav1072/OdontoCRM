import {
  BRAND_LIMITS,
  buildLetterheadView,
  CLINIC,
  clinicDentistFor,
  clinicDentistLine,
  clinicIdentityFromView,
  LETTERHEAD_LINE_KEYS,
  type BrandLetterheadSettings,
  type BrandSettings,
  type LetterheadLineKey,
  type LogoHorizontalAlign,
  type LogoVerticalAlign,
} from '@odontocrm/contracts';
import { Alert, Button, Field, Input, Select } from '@odontocrm/ui';
import { ArrowDown, ArrowUp, Eye, EyeOff, Stamp } from 'lucide-react';
import type { Dispatch, SetStateAction } from 'react';

import { clinicLogoUrl } from '../../lib/marca';
import { t } from '../../lib/i18n';
import { useOptionalAuth } from '../../providers/AuthProvider';
import { useClinicIdentity } from '../../providers/ClinicIdentityProvider';
import { RolTipografico } from './RolTipografico';

export interface MembreteSectionProps {
  form: BrandSettings;
  setForm: Dispatch<SetStateAction<BrandSettings>>;
}

/** Rótulo de cada línea configurable del membrete. */
const LINE_LABEL: Readonly<Record<LetterheadLineKey, string>> = {
  address: t('config.membrete.linea.direccion'),
  rif: t('config.membrete.linea.rif'),
  contact: t('config.membrete.linea.contacto'),
  website: t('config.membrete.linea.web'),
  dentist: t('config.membrete.linea.especialista'),
};

/** Rótulo y valor CSS de cada alineación horizontal del logo. */
const ALIGN_OPTIONS: readonly { value: LogoHorizontalAlign; label: string }[] = [
  { value: 'left', label: t('config.membrete.logo.izquierda') },
  { value: 'center', label: t('config.membrete.logo.centro') },
  { value: 'right', label: t('config.membrete.logo.derecha') },
];

/** Rótulo y valor CSS de cada alineación vertical del logo. */
const VALIGN_OPTIONS: readonly { value: LogoVerticalAlign; label: string }[] = [
  { value: 'top', label: t('config.membrete.logo.arriba') },
  { value: 'center', label: t('config.membrete.logo.medio') },
  { value: 'bottom', label: t('config.membrete.logo.abajo') },
];

const ALIGN_CSS: Readonly<Record<LogoHorizontalAlign, string>> = {
  left: 'flex-start',
  center: 'center',
  right: 'flex-end',
};

const VALIGN_CSS: Readonly<Record<LogoVerticalAlign, string>> = {
  top: 'flex-start',
  center: 'center',
  bottom: 'flex-end',
};

/** ¿El número cae dentro de los límites que aplica el esquema? */
const enRango = (valor: number, rango: { min: number; max: number }): boolean =>
  Number.isFinite(valor) && valor >= rango.min && valor <= rango.max;

/** Mensaje de «fuera de rango» con los límites, para no enviarlo y recibir un 400 genérico. */
const errorRango = (valor: number, rango: { min: number; max: number }): string | undefined =>
  enRango(valor, rango)
    ? undefined
    : t('config.marca.rangoInvalido', { min: rango.min, max: rango.max });

/**
 * La **subsección «Membrete»** del panel (ADR 0064): todo lo que decide cómo se ve el
 * bloque de identidad de los imprimibles —alto y posición del logo, tipografía propia del
 * nombre, tamaño de las líneas, qué líneas salen y en qué orden, un pie y el velo—.
 *
 * Los **datos** (nombre, RIF, dirección, teléfonos, logo) se editan en Mi perfil /
 * `/usuarios`: aquí solo se elige cómo se pintan. La **vista previa** dibuja el membrete
 * con los datos reales del consultorio y los ajustes del formulario **al instante**, sin
 * guardar, para que nadie configure a ciegas.
 *
 * Es una sección **controlada**: comparte el formulario de la marca (`form`/`setForm` con
 * `MarcaSection`), así que un solo «Guardar» persiste marca y membrete juntos.
 */
export const MembreteSection = ({ form, setForm }: MembreteSectionProps) => {
  const v = form.letterhead;

  const setLetterhead = (patch: Partial<BrandLetterheadSettings>): void =>
    setForm((prev) => ({ ...prev, letterhead: { ...prev.letterhead, ...patch } }));

  /** Mueve una línea hacia arriba/abajo (el orden del arreglo es el del papel). */
  const mover = (index: number, delta: number): void => {
    const destino = index + delta;
    if (destino < 0 || destino >= v.lines.length) return;
    const lines = [...v.lines];
    const [item] = lines.splice(index, 1);
    if (item === undefined) return;
    lines.splice(destino, 0, item);
    setLetterhead({ lines });
  };

  const alternar = (key: LetterheadLineKey): void =>
    setLetterhead({
      lines: v.lines.map((line) => (line.key === key ? { ...line, visible: !line.visible } : line)),
    });

  // Vista previa con los datos **reales** del consultorio; sin vista, el respaldo neutro.
  const identidad = useClinicIdentity();
  const sesion = useOptionalAuth();
  const clinic = identidad === null ? CLINIC : clinicIdentityFromView(identidad);
  const logo = identidad?.logoDataUri ?? clinicLogoUrl();
  const dentistLine = clinicDentistLine(clinicDentistFor(sesion?.user?.username, clinic));
  const previa = buildLetterheadView(clinic, dentistLine === '' ? null : dentistLine, v, {
    subtitle: clinic.legalName,
  });

  return (
    <section className="space-y-4 rounded-control border border-border p-4">
      <div>
        <h3 className="flex items-center gap-2 text-sm font-semibold text-ink">
          <Stamp className="size-4 text-primary" aria-hidden="true" />
          {t('config.membrete.titulo')}
        </h3>
        <p className="pt-1 text-sm text-ink-muted">{t('config.membrete.descripcion')}</p>
      </div>

      {/* Logo: alto y posición */}
      <div className="grid gap-4 @2xl:grid-cols-3">
        <Field
          label={t('config.membrete.altoLogo')}
          error={errorRango(v.logoHeightMm, BRAND_LIMITS.logoHeightMm)}
        >
          <Input
            type="number"
            step="1"
            min={BRAND_LIMITS.logoHeightMm.min}
            max={BRAND_LIMITS.logoHeightMm.max}
            value={v.logoHeightMm}
            onChange={(event) => setLetterhead({ logoHeightMm: Number(event.target.value) })}
          />
        </Field>
        <Field label={t('config.membrete.alineacionLogo')}>
          <Select
            value={v.logoAlign}
            onChange={(event) =>
              setLetterhead({ logoAlign: event.target.value as LogoHorizontalAlign })
            }
          >
            {ALIGN_OPTIONS.map((opcion) => (
              <option key={opcion.value} value={opcion.value}>
                {opcion.label}
              </option>
            ))}
          </Select>
        </Field>
        <Field
          label={t('config.membrete.alineacionVertical')}
          hint={t('config.membrete.alineacionVerticalAyuda')}
        >
          <Select
            value={v.logoVerticalAlign}
            onChange={(event) =>
              setLetterhead({ logoVerticalAlign: event.target.value as LogoVerticalAlign })
            }
          >
            {VALIGN_OPTIONS.map((opcion) => (
              <option key={opcion.value} value={opcion.value}>
                {opcion.label}
              </option>
            ))}
          </Select>
        </Field>
      </div>

      {/* Tipografía propia del nombre + tamaños */}
      <RolTipografico
        etiqueta={t('config.membrete.tipografiaNombre')}
        pila={v.titleSans ?? form.typography.documentTitleSans}
        peso={v.titleWeight ?? form.typography.documentTitleWeight}
        familias={form.fonts.families}
        muestra={previa.name === '' ? t('config.membrete.sinNombre') : previa.name}
        error={
          v.titleSans !== null && v.titleSans.trim() === ''
            ? t('config.marca.pilaRequerida')
            : undefined
        }
        onPila={(pila) => setLetterhead({ titleSans: pila })}
        onPeso={(peso) => setLetterhead({ titleWeight: peso })}
      />
      <div className="grid gap-4 @2xl:grid-cols-2">
        <Field
          label={t('config.membrete.tamanoNombre')}
          error={errorRango(v.titlePt, BRAND_LIMITS.titlePt)}
        >
          <Input
            type="number"
            step="0.5"
            min={BRAND_LIMITS.titlePt.min}
            max={BRAND_LIMITS.titlePt.max}
            value={v.titlePt}
            onChange={(event) => setLetterhead({ titlePt: Number(event.target.value) })}
          />
        </Field>
        <Field
          label={t('config.membrete.tamanoLineas')}
          error={errorRango(v.linePt, BRAND_LIMITS.linePt)}
        >
          <Input
            type="number"
            step="0.5"
            min={BRAND_LIMITS.linePt.min}
            max={BRAND_LIMITS.linePt.max}
            value={v.linePt}
            onChange={(event) => setLetterhead({ linePt: Number(event.target.value) })}
          />
        </Field>
      </div>

      {/* Líneas: qué se imprime y en qué orden */}
      <div className="space-y-2">
        <p className="text-sm font-semibold text-ink">{t('config.membrete.lineas')}</p>
        <p className="text-xs text-ink-subtle">{t('config.membrete.lineasAyuda')}</p>
        <ul className="space-y-1">
          {v.lines.map((line, index) => (
            <li
              key={line.key}
              className="flex items-center justify-between gap-2 rounded-control border border-border px-3 py-1.5"
            >
              <span
                className={
                  line.visible ? 'text-sm text-ink' : 'text-sm text-ink-subtle line-through'
                }
              >
                {LINE_LABEL[line.key]}
              </span>
              <span className="flex items-center gap-1">
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label={t('config.membrete.subir')}
                  title={t('config.membrete.subir')}
                  disabled={index === 0}
                  onClick={() => mover(index, -1)}
                >
                  <ArrowUp className="size-4" aria-hidden="true" />
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label={t('config.membrete.bajar')}
                  title={t('config.membrete.bajar')}
                  disabled={index === v.lines.length - 1}
                  onClick={() => mover(index, 1)}
                >
                  <ArrowDown className="size-4" aria-hidden="true" />
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  aria-pressed={line.visible}
                  aria-label={
                    line.visible ? t('config.membrete.ocultar') : t('config.membrete.mostrar')
                  }
                  title={line.visible ? t('config.membrete.ocultar') : t('config.membrete.mostrar')}
                  onClick={() => alternar(line.key)}
                >
                  {line.visible ? (
                    <Eye className="size-4" aria-hidden="true" />
                  ) : (
                    <EyeOff className="size-4" aria-hidden="true" />
                  )}
                </Button>
              </span>
            </li>
          ))}
        </ul>
        {v.lines.length !== LETTERHEAD_LINE_KEYS.length && (
          <p className="text-xs text-ink-subtle">{t('config.membrete.sinLineasOcultas')}</p>
        )}
      </div>

      {/* Pie propio */}
      <Field label={t('config.membrete.pie')} hint={t('config.membrete.pieAyuda')}>
        <Input
          value={v.footer ?? ''}
          maxLength={300}
          onChange={(event) =>
            setLetterhead({ footer: event.target.value.trim() === '' ? null : event.target.value })
          }
        />
      </Field>

      {/* Marca de agua (el mismo logo, de fondo) */}
      <div className="grid gap-4 @2xl:grid-cols-2">
        <Field
          label={t('config.marca.anchoVelo')}
          error={errorRango(v.watermarkWidthMm, BRAND_LIMITS.watermarkWidthMm)}
        >
          <Input
            type="number"
            step="1"
            min={BRAND_LIMITS.watermarkWidthMm.min}
            max={BRAND_LIMITS.watermarkWidthMm.max}
            value={v.watermarkWidthMm}
            onChange={(event) => setLetterhead({ watermarkWidthMm: Number(event.target.value) })}
          />
        </Field>
        <Field
          label={t('config.marca.opacidadVelo')}
          error={errorRango(v.watermarkOpacity, BRAND_LIMITS.watermarkOpacity)}
        >
          <Input
            type="number"
            step="0.01"
            min={BRAND_LIMITS.watermarkOpacity.min}
            max={BRAND_LIMITS.watermarkOpacity.max}
            value={v.watermarkOpacity}
            onChange={(event) => setLetterhead({ watermarkOpacity: Number(event.target.value) })}
          />
        </Field>
      </div>

      {/* Vista previa en vivo */}
      <div>
        <p className="mb-1 text-xs text-ink-subtle">{t('config.membrete.vistaPrevia')}</p>
        <div className="overflow-hidden rounded-control border border-dashed border-border bg-white p-4">
          <div
            style={{
              display: 'flex',
              justifyContent: ALIGN_CSS[v.logoAlign],
              alignItems: VALIGN_CSS[v.logoVerticalAlign],
              gap: '4mm',
              borderBottom: `0.6mm solid ${form.palette.accent}`,
              paddingBottom: '2.5mm',
            }}
          >
            {logo !== null && (
              <img
                src={logo}
                alt=""
                aria-hidden
                style={{ height: `${String(v.logoHeightMm)}mm`, width: 'auto', flex: '0 0 auto' }}
              />
            )}
            <div style={{ minWidth: 0 }}>
              <p
                style={{
                  margin: 0,
                  fontFamily: v.titleSans ?? form.typography.documentTitleSans,
                  fontWeight: v.titleWeight ?? form.typography.documentTitleWeight,
                  fontSize: `${String(v.titlePt)}pt`,
                  color: form.palette.primary,
                  // El nombre puede venir en dos líneas (se parten en Mi perfil).
                  whiteSpace: 'pre-line',
                }}
              >
                {previa.name === '' ? t('config.membrete.sinNombre') : previa.name}
              </p>
              {previa.subtitle !== null && (
                <p
                  style={{
                    margin: '0.5mm 0 0',
                    fontSize: `${String(v.linePt)}pt`,
                    color: form.palette.inkMuted,
                  }}
                >
                  {previa.subtitle}
                </p>
              )}
              {previa.lines.map((line) => (
                <p
                  key={line.key}
                  style={{
                    margin: line.key === 'dentist' ? '0.8mm 0 0' : '0.5mm 0 0',
                    fontSize: `${String(v.linePt)}pt`,
                    color: line.key === 'dentist' ? form.palette.inkStrong : form.palette.inkMuted,
                  }}
                >
                  {line.text}
                </p>
              ))}
              {previa.footer !== null && (
                <p
                  style={{
                    margin: '1mm 0 0',
                    fontSize: `${String(Math.max(v.linePt - 1, 5))}pt`,
                    color: form.palette.inkSubtle,
                  }}
                >
                  {previa.footer}
                </p>
              )}
            </div>
          </div>
          {previa.subtitle === null && previa.lines.length === 0 && previa.footer === null && (
            <p className="mt-2 text-xs text-ink-muted">{t('config.membrete.previaSinDatos')}</p>
          )}
        </div>
      </div>

      <Alert variant="info">{t('config.membrete.logoAyuda')}</Alert>
    </section>
  );
};
