import {
  surfaceLabelFor,
  type ClinicalSessionContent,
  type SessionMaterial,
  type SessionProcedure,
  type ToothSurface,
} from '@odontocrm/contracts';
import { Button, Field, Input, Select, cn } from '@odontocrm/ui';
import { Plus, Trash2 } from 'lucide-react';

import {
  SESSION_EXAM_FIELDS,
  SESSION_MATERIAL_OPTIONS,
  SESSION_PROCEDURE_OPTIONS,
  SESSION_VITAL_FIELDS,
  emptyMaterial,
  emptyProcedure,
  surfacesForTooth,
} from '../../lib/clinical-session';
import { clinicalOptionLabel } from '../../lib/clinical';
import { t } from '../../lib/i18n';

/**
 * Formulario de la sesión clínica: el documento del día.
 *
 * Es un componente **controlado**: recibe el documento y avisa de cada cambio; quien
 * lo monta decide cuándo autoguardar. Nada de reglas propias: los rangos de los
 * signos vitales, el catálogo de procedimientos y las caras de cada pieza salen del
 * contrato, que es el mismo que valida el servidor.
 */

const TEXTAREA_CLASSES =
  'w-full rounded-control border border-border-strong bg-surface px-3 py-2 text-sm text-ink shadow-xs transition-colors placeholder:text-ink-subtle focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-solid focus-visible:outline-focus disabled:cursor-not-allowed disabled:bg-surface-muted disabled:text-ink-muted';

export interface SessionFormProps {
  content: ClinicalSessionContent;
  onChange: (content: ClinicalSessionContent) => void;
  /** Sin permiso de escritura (la secretaría lee) el formulario va deshabilitado. */
  disabled?: boolean;
}

/** Campo de texto largo del documento. */
const AreaField = ({
  label,
  value,
  rows = 3,
  disabled,
  placeholder,
  onChange,
}: {
  label: string;
  value: string | null;
  rows?: number;
  disabled?: boolean;
  placeholder?: string;
  onChange: (value: string | null) => void;
}) => (
  <Field label={label}>
    <textarea
      className={TEXTAREA_CLASSES}
      rows={rows}
      disabled={disabled}
      placeholder={placeholder}
      value={value ?? ''}
      onChange={(event) => onChange(event.target.value === '' ? null : event.target.value)}
    />
  </Field>
);

/* ── Signos vitales ────────────────────────────────────────────────────────── */

const VitalsBlock = ({ props }: { props: SessionFormProps }) => {
  const { content, onChange, disabled = false } = props;

  const setVital = (name: string, raw: string): void => {
    const value = raw.trim() === '' ? null : Number(raw.replace(',', '.'));
    onChange({
      ...content,
      vitals: {
        ...content.vitals,
        [name]: value === null || Number.isNaN(value) ? null : value,
      },
    });
  };

  return (
    <fieldset disabled={disabled} className="min-w-0">
      <legend className="text-sm font-medium text-ink">{t('clinica.sesion.vitales')}</legend>
      <p className="mt-0.5 text-xs text-ink-subtle">{t('clinica.sesion.vitales.ayuda')}</p>
      <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {SESSION_VITAL_FIELDS.map((field) => {
          const value = content.vitals[field.name as keyof typeof content.vitals];
          return (
            <Field
              key={field.name}
              label={t(field.labelKey as never)}
              hint={field.unit === undefined ? undefined : field.unit}
            >
              <Input
                inputMode="decimal"
                autoComplete="off"
                placeholder={field.placeholder}
                value={value === null || value === undefined ? '' : String(value)}
                onChange={(event) => setVital(field.name, event.target.value)}
              />
            </Field>
          );
        })}
      </div>
    </fieldset>
  );
};

/* ── Examen del día ────────────────────────────────────────────────────────── */

const ExamBlock = ({ props }: { props: SessionFormProps }) => {
  const { content, onChange, disabled = false } = props;

  return (
    <fieldset disabled={disabled} className="min-w-0">
      <legend className="text-sm font-medium text-ink">{t('clinica.sesion.examen')}</legend>
      <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {SESSION_EXAM_FIELDS.selects.map((field) => {
          const value = content.exam[field.name as keyof typeof content.exam];
          return (
            <Field key={field.name} label={t(`clinica.sesion.campo.${field.name}` as never)}>
              <Select
                value={typeof value === 'string' ? value : ''}
                onChange={(event) =>
                  onChange({
                    ...content,
                    exam: {
                      ...content.exam,
                      [field.name]: event.target.value === '' ? null : event.target.value,
                    },
                  })
                }
              >
                <option value="">{t('clinica.sesion.sinDato')}</option>
                {field.options.map((option) => (
                  <option key={option} value={option}>
                    {clinicalOptionLabel(field.group, option)}
                  </option>
                ))}
              </Select>
            </Field>
          );
        })}
      </div>
      <div className="mt-3 grid gap-3 lg:grid-cols-2">
        <Field label={t('clinica.sesion.campo.sondaje')}>
          <Input
            autoComplete="off"
            placeholder={t('clinica.sesion.campo.sondajePlaceholder')}
            value={content.exam.sondaje ?? ''}
            onChange={(event) =>
              onChange({
                ...content,
                exam: {
                  ...content.exam,
                  sondaje: event.target.value === '' ? null : event.target.value,
                },
              })
            }
          />
        </Field>
        <AreaField
          label={t('clinica.sesion.campo.hallazgos')}
          value={content.exam.hallazgos}
          disabled={disabled}
          onChange={(value) =>
            onChange({ ...content, exam: { ...content.exam, hallazgos: value } })
          }
        />
      </div>
    </fieldset>
  );
};

/* ── Procedimientos ────────────────────────────────────────────────────────── */

const ProcedureRow = ({
  procedure,
  disabled,
  onChange,
  onRemove,
}: {
  procedure: SessionProcedure;
  disabled: boolean;
  onChange: (procedure: SessionProcedure) => void;
  onRemove: () => void;
}) => {
  const caras = surfacesForTooth(procedure.toothNumber);

  const toggleSurface = (surface: ToothSurface): void => {
    const surfaces = procedure.surfaces.includes(surface)
      ? procedure.surfaces.filter((item) => item !== surface)
      : [...procedure.surfaces, surface];
    onChange({ ...procedure, surfaces });
  };

  return (
    <li className="rounded-control border border-border p-3">
      <div className="grid gap-3 lg:grid-cols-[minmax(0,2fr)_7rem_minmax(0,1fr)_2.5rem] lg:items-end">
        <Field label={t('clinica.sesion.procedimiento')}>
          <Select
            disabled={disabled}
            value={procedure.code}
            onChange={(event) =>
              onChange({ ...procedure, code: event.target.value as SessionProcedure['code'] })
            }
          >
            {SESSION_PROCEDURE_OPTIONS.map((option) => (
              <option key={option.code} value={option.code}>
                {option.label}
              </option>
            ))}
          </Select>
        </Field>

        <Field label={t('clinica.sesion.pieza')}>
          <Input
            disabled={disabled}
            autoComplete="off"
            inputMode="numeric"
            placeholder="26"
            value={procedure.toothNumber === null ? '' : String(procedure.toothNumber)}
            onChange={(event) => {
              const raw = event.target.value.replace(/\D/g, '');
              const pieza = raw === '' ? null : Number(raw);
              // Cambiar de pieza limpia las caras que esa pieza no tiene.
              const permitidas = surfacesForTooth(pieza);
              onChange({
                ...procedure,
                toothNumber: pieza,
                surfaces: procedure.surfaces.filter((surface) => permitidas.includes(surface)),
              });
            }}
          />
        </Field>

        <Field label={t('clinica.sesion.notasProcedimiento')}>
          <Input
            disabled={disabled}
            autoComplete="off"
            value={procedure.notas ?? ''}
            onChange={(event) =>
              onChange({
                ...procedure,
                notas: event.target.value === '' ? null : event.target.value,
              })
            }
          />
        </Field>

        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={disabled}
          aria-label={t('clinica.sesion.quitarProcedimiento')}
          onClick={onRemove}
        >
          <Trash2 className="size-4" aria-hidden />
        </Button>
      </div>

      {procedure.code === 'otros' && (
        <Field label={t('clinica.sesion.detalle')} className="mt-3">
          <Input
            disabled={disabled}
            autoComplete="off"
            placeholder={t('clinica.sesion.detallePlaceholder')}
            value={procedure.detalle ?? ''}
            onChange={(event) =>
              onChange({
                ...procedure,
                detalle: event.target.value === '' ? null : event.target.value,
              })
            }
          />
        </Field>
      )}

      {procedure.toothNumber !== null && caras.length > 0 && (
        <div className="mt-3">
          <p className="text-xs font-medium text-ink-muted">{t('clinica.sesion.caras')}</p>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {caras.map((surface) => {
              const activa = procedure.surfaces.includes(surface);
              return (
                <button
                  key={surface}
                  type="button"
                  disabled={disabled}
                  aria-pressed={activa}
                  onClick={() => toggleSurface(surface)}
                  className={cn(
                    'rounded-control border px-2.5 py-1 text-xs transition-colors',
                    activa
                      ? 'border-primary bg-primary/10 text-primary'
                      : 'border-border-strong bg-surface text-ink-muted hover:bg-surface-muted',
                    disabled && 'cursor-not-allowed opacity-60',
                  )}
                >
                  {surfaceLabelFor(procedure.toothNumber as number, surface)}
                </button>
              );
            })}
          </div>
          <p className="mt-1 text-xs text-ink-subtle">
            {procedure.surfaces.length === 0
              ? t('clinica.sesion.caras.ayuda')
              : t('clinica.sesion.caras.elegidas', { total: procedure.surfaces.length })}
          </p>
        </div>
      )}
    </li>
  );
};

const ProceduresBlock = ({ props }: { props: SessionFormProps }) => {
  const { content, onChange, disabled = false } = props;

  const setProcedimiento = (index: number, procedure: SessionProcedure): void => {
    const procedimientos = content.procedimientos.map((item, position) =>
      position === index ? procedure : item,
    );
    onChange({ ...content, procedimientos });
  };

  return (
    <fieldset disabled={disabled} className="min-w-0">
      <legend className="text-sm font-medium text-ink">{t('clinica.sesion.procedimientos')}</legend>
      <p className="mt-0.5 text-xs text-ink-subtle">{t('clinica.sesion.procedimientos.ayuda')}</p>

      {content.procedimientos.length > 0 && (
        <ul className="mt-3 space-y-3">
          {content.procedimientos.map((procedure, index) => (
            <ProcedureRow
              key={`${String(index)}-${procedure.code}`}
              procedure={procedure}
              disabled={disabled}
              onChange={(siguiente) => setProcedimiento(index, siguiente)}
              onRemove={() =>
                onChange({
                  ...content,
                  procedimientos: content.procedimientos.filter(
                    (_, position) => position !== index,
                  ),
                })
              }
            />
          ))}
        </ul>
      )}

      <div className="mt-3">
        <Button
          type="button"
          variant="secondary"
          size="sm"
          disabled={disabled}
          leadingIcon={<Plus className="size-4" aria-hidden />}
          onClick={() =>
            onChange({ ...content, procedimientos: [...content.procedimientos, emptyProcedure()] })
          }
        >
          {t('clinica.sesion.agregarProcedimiento')}
        </Button>
      </div>
    </fieldset>
  );
};

/* ── Materiales ────────────────────────────────────────────────────────────── */

const MaterialsBlock = ({ props }: { props: SessionFormProps }) => {
  const { content, onChange, disabled = false } = props;

  const setMaterial = (index: number, material: SessionMaterial): void => {
    onChange({
      ...content,
      materiales: content.materiales.map((item, position) =>
        position === index ? material : item,
      ),
    });
  };

  return (
    <fieldset disabled={disabled} className="min-w-0">
      <legend className="text-sm font-medium text-ink">{t('clinica.sesion.materiales')}</legend>
      {content.materiales.length > 0 && (
        <ul className="mt-3 space-y-2">
          {content.materiales.map((material, index) => (
            <li
              key={`${String(index)}-${material.code}`}
              className="grid gap-2 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_2.5rem] sm:items-center"
            >
              <Select
                disabled={disabled}
                aria-label={t('clinica.sesion.material')}
                value={material.code}
                onChange={(event) =>
                  setMaterial(index, {
                    ...material,
                    code: event.target.value as SessionMaterial['code'],
                  })
                }
              >
                {SESSION_MATERIAL_OPTIONS.map((option) => (
                  <option key={option.code} value={option.code}>
                    {option.label}
                  </option>
                ))}
              </Select>
              <Input
                disabled={disabled}
                autoComplete="off"
                aria-label={t('clinica.sesion.cantidad')}
                placeholder={t('clinica.sesion.cantidadPlaceholder')}
                value={material.cantidad ?? ''}
                onChange={(event) =>
                  setMaterial(index, {
                    ...material,
                    cantidad: event.target.value === '' ? null : event.target.value,
                  })
                }
              />
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={disabled}
                aria-label={t('clinica.sesion.quitarMaterial')}
                onClick={() =>
                  onChange({
                    ...content,
                    materiales: content.materiales.filter((_, position) => position !== index),
                  })
                }
              >
                <Trash2 className="size-4" aria-hidden />
              </Button>
              {material.code === 'otros' && (
                <Input
                  className="sm:col-span-3"
                  disabled={disabled}
                  autoComplete="off"
                  aria-label={t('clinica.sesion.detalle')}
                  placeholder={t('clinica.sesion.detallePlaceholder')}
                  value={material.detalle ?? ''}
                  onChange={(event) =>
                    setMaterial(index, {
                      ...material,
                      detalle: event.target.value === '' ? null : event.target.value,
                    })
                  }
                />
              )}
            </li>
          ))}
        </ul>
      )}
      <div className="mt-3">
        <Button
          type="button"
          variant="secondary"
          size="sm"
          disabled={disabled}
          leadingIcon={<Plus className="size-4" aria-hidden />}
          onClick={() =>
            onChange({ ...content, materiales: [...content.materiales, emptyMaterial()] })
          }
        >
          {t('clinica.sesion.agregarMaterial')}
        </Button>
      </div>
    </fieldset>
  );
};

/* ── El documento completo ─────────────────────────────────────────────────── */

export const SessionForm = (props: SessionFormProps) => {
  const { content, onChange, disabled = false } = props;

  return (
    <div className="space-y-5">
      <VitalsBlock props={{ ...props, disabled }} />
      <ExamBlock props={{ ...props, disabled }} />

      <div className="grid gap-3 lg:grid-cols-2">
        <AreaField
          label={t('clinica.sesion.campo.motivo')}
          value={content.motivo}
          rows={2}
          disabled={disabled}
          placeholder={t('clinica.sesion.campo.motivoPlaceholder')}
          onChange={(value) => onChange({ ...content, motivo: value })}
        />
        <AreaField
          label={t('clinica.sesion.campo.anamnesis')}
          value={content.anamnesis}
          rows={2}
          disabled={disabled}
          onChange={(value) => onChange({ ...content, anamnesis: value })}
        />
      </div>

      <ProceduresBlock props={{ ...props, disabled }} />
      <MaterialsBlock props={{ ...props, disabled }} />

      <div className="grid gap-3 lg:grid-cols-2">
        <AreaField
          label={t('clinica.sesion.campo.diagnostico')}
          value={content.diagnostico}
          rows={3}
          disabled={disabled}
          onChange={(value) => onChange({ ...content, diagnostico: value })}
        />
        <AreaField
          label={t('clinica.sesion.campo.indicaciones')}
          value={content.indicaciones}
          rows={3}
          disabled={disabled}
          onChange={(value) => onChange({ ...content, indicaciones: value })}
        />
      </div>

      <div className="grid gap-3 lg:grid-cols-3">
        <Field label={t('clinica.sesion.campo.proximaCitaFecha')}>
          <Input
            type="date"
            disabled={disabled}
            value={content.proximaCitaFecha ?? ''}
            onChange={(event) =>
              onChange({
                ...content,
                proximaCitaFecha: event.target.value === '' ? null : event.target.value,
              })
            }
          />
        </Field>
        <AreaField
          label={t('clinica.sesion.campo.proximaCitaNota')}
          value={content.proximaCitaNota}
          rows={1}
          disabled={disabled}
          onChange={(value) => onChange({ ...content, proximaCitaNota: value })}
        />
        <AreaField
          label={t('clinica.sesion.campo.notasInternas')}
          value={content.notasInternas}
          rows={1}
          disabled={disabled}
          onChange={(value) => onChange({ ...content, notasInternas: value })}
        />
      </div>
    </div>
  );
};
