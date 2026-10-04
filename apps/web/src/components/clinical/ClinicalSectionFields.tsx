import { Button, Checkbox, Field, Input, Select, cn } from '@odontocrm/ui';
import { Plus, Trash2 } from 'lucide-react';

import {
  CLINICAL_PRIORITIES,
  clinicalCatalogItemLabel,
  clinicalCatalogTitle,
  clinicalFieldLabel,
  clinicalOptionLabel,
  clinicalPriorityLabel,
  type ClinicalFieldSpec,
} from '../../lib/clinical';
import { t } from '../../lib/i18n';

/** Valor de un catálogo tipificado: casillas + texto libre para «otros». */
export interface CatalogValue {
  items: string[];
  otros: string | null;
}

export interface ProcedureValue {
  descripcion: string;
  prioridad: string;
  pieza: string | null;
  presupuesto: number | null;
}

const asText = (value: unknown): string => (typeof value === 'string' ? value : '');

const asBool = (value: unknown): boolean => value === true;

const asCatalog = (value: unknown): CatalogValue => {
  if (typeof value !== 'object' || value === null) return { items: [], otros: null };
  const items = (value as { items?: unknown }).items;
  const otros = (value as { otros?: unknown }).otros;
  return {
    items: Array.isArray(items)
      ? items.filter((item): item is string => typeof item === 'string')
      : [],
    otros: typeof otros === 'string' ? otros : null,
  };
};

const asProcedures = (value: unknown): ProcedureValue[] =>
  Array.isArray(value)
    ? value.map((item) => {
        const row = (typeof item === 'object' && item !== null ? item : {}) as Record<
          string,
          unknown
        >;
        return {
          descripcion: asText(row['descripcion']),
          prioridad: asText(row['prioridad']) || 'media',
          pieza: asText(row['pieza']) || null,
          presupuesto: typeof row['presupuesto'] === 'number' ? row['presupuesto'] : null,
        };
      })
    : [];

const TEXTAREA_CLASSES =
  'w-full rounded-control border border-border-strong bg-surface px-3 py-2 text-sm text-ink shadow-xs transition-colors placeholder:text-ink-subtle focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-solid focus-visible:outline-focus disabled:cursor-not-allowed disabled:bg-surface-muted disabled:text-ink-muted';

export interface CatalogChecklistProps {
  group: string;
  codes: readonly string[];
  value: CatalogValue;
  onChange: (value: CatalogValue) => void;
  disabled?: boolean;
}

/**
 * Casillas de un catálogo tipificado con el «otros» inputable: marcar «otros»
 * abre el campo de texto y sin texto el contrato no valida (es lo que permite
 * segmentar en reportes sin perder lo que se escribió a mano).
 */
export const CatalogChecklist = ({
  group,
  codes,
  value,
  onChange,
  disabled = false,
}: CatalogChecklistProps) => {
  const toggle = (code: string): void => {
    const items = value.items.includes(code)
      ? value.items.filter((item) => item !== code)
      : [...value.items, code];
    onChange({ items, otros: items.includes('otros') ? value.otros : null });
  };

  return (
    <fieldset disabled={disabled} className="min-w-0">
      <legend className="text-sm font-medium text-ink">{clinicalCatalogTitle(group)}</legend>
      <div className="mt-2 flex flex-wrap gap-2">
        {codes.map((code) => {
          const active = value.items.includes(code);
          return (
            <label
              key={code}
              className={cn(
                'flex cursor-pointer items-center gap-2 rounded-control border px-3 py-1.5 text-sm transition-colors',
                active
                  ? 'border-primary bg-primary/10 text-primary'
                  : 'border-border-strong bg-surface text-ink hover:bg-surface-muted',
                disabled && 'cursor-not-allowed opacity-60',
              )}
            >
              <input
                type="checkbox"
                className="sr-only"
                checked={active}
                onChange={() => toggle(code)}
              />
              <span>{clinicalCatalogItemLabel(group, code)}</span>
            </label>
          );
        })}
      </div>
      {value.items.includes('otros') && (
        <Field label={t('clinica.catalogo.otros.etiqueta')} className="mt-3 max-w-md">
          <Input
            value={value.otros ?? ''}
            disabled={disabled}
            placeholder={t('clinica.catalogo.otros.placeholder')}
            maxLength={200}
            onChange={(event) =>
              onChange({ items: value.items, otros: event.target.value || null })
            }
          />
        </Field>
      )}
    </fieldset>
  );
};

const ProcedureList = ({
  value,
  onChange,
  disabled,
}: {
  value: ProcedureValue[];
  onChange: (rows: ProcedureValue[]) => void;
  disabled: boolean;
}) => {
  const update = (index: number, patch: Partial<ProcedureValue>): void => {
    onChange(value.map((row, position) => (position === index ? { ...row, ...patch } : row)));
  };

  return (
    <div className="space-y-3">
      {value.length === 0 && (
        <p className="text-sm text-ink-subtle">{t('clinica.plan.sinProcedimientos')}</p>
      )}
      {value.map((row, index) => (
        <div
          key={index}
          className="grid grid-cols-1 gap-3 rounded-control border border-border p-3 sm:grid-cols-[1fr_8rem_6rem_8rem_auto]"
        >
          <Field label={t('clinica.plan.descripcion')}>
            <Input
              value={row.descripcion}
              disabled={disabled}
              maxLength={200}
              onChange={(event) => update(index, { descripcion: event.target.value })}
            />
          </Field>
          <Field label={t('clinica.plan.prioridad')}>
            <Select
              value={row.prioridad}
              disabled={disabled}
              onChange={(event) => update(index, { prioridad: event.target.value })}
            >
              {CLINICAL_PRIORITIES.map((priority) => (
                <option key={priority} value={priority}>
                  {clinicalPriorityLabel(priority)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t('clinica.plan.pieza')}>
            <Input
              value={row.pieza ?? ''}
              disabled={disabled}
              maxLength={12}
              onChange={(event) => update(index, { pieza: event.target.value || null })}
            />
          </Field>
          <Field label={t('clinica.plan.presupuesto')}>
            <Input
              type="number"
              min={0}
              step="0.01"
              value={row.presupuesto ?? ''}
              disabled={disabled}
              onChange={(event) =>
                update(index, {
                  presupuesto: event.target.value === '' ? null : Number(event.target.value),
                })
              }
            />
          </Field>
          <div className="flex items-end">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={disabled}
              onClick={() => onChange(value.filter((_, position) => position !== index))}
              leadingIcon={<Trash2 className="size-4" aria-hidden />}
            >
              {t('comun.quitar')}
            </Button>
          </div>
        </div>
      ))}
      <Button
        type="button"
        variant="secondary"
        size="sm"
        disabled={disabled}
        leadingIcon={<Plus className="size-4" aria-hidden />}
        onClick={() =>
          onChange([
            ...value,
            { descripcion: '', prioridad: 'media', pieza: null, presupuesto: null },
          ])
        }
      >
        {t('clinica.plan.agregarProcedimiento')}
      </Button>
    </div>
  );
};

export interface ClinicalSectionFieldsProps {
  fields: readonly ClinicalFieldSpec[];
  content: Record<string, unknown>;
  onChange: (name: string, value: unknown) => void;
  disabled?: boolean;
}

/** Pinta los campos de una sección a partir de su declaración. */
export const ClinicalSectionFields = ({
  fields,
  content,
  onChange,
  disabled = false,
}: ClinicalSectionFieldsProps) => (
  <div className="space-y-5">
    {fields.map((field) => {
      const value = content[field.name];
      switch (field.kind) {
        case 'text':
          return (
            <Field
              key={field.name}
              label={clinicalFieldLabel(field.labelKey)}
              required={field.required === true}
              className="max-w-xl"
            >
              <Input
                value={asText(value)}
                disabled={disabled}
                maxLength={field.maxLength}
                aria-required={field.required === true}
                onChange={(event) => onChange(field.name, event.target.value || null)}
              />
            </Field>
          );
        case 'textarea':
          return (
            <Field
              key={field.name}
              label={clinicalFieldLabel(field.labelKey)}
              required={field.required === true}
            >
              <textarea
                className={TEXTAREA_CLASSES}
                rows={field.rows ?? 3}
                value={asText(value)}
                disabled={disabled}
                aria-required={field.required === true || undefined}
                onChange={(event) => onChange(field.name, event.target.value || null)}
              />
            </Field>
          );
        case 'date':
          return (
            <Field key={field.name} label={clinicalFieldLabel(field.labelKey)} className="max-w-xs">
              <Input
                type="date"
                value={asText(value)}
                disabled={disabled}
                onChange={(event) => onChange(field.name, event.target.value || null)}
              />
            </Field>
          );
        case 'checkbox':
          return (
            <Checkbox
              key={field.name}
              checked={asBool(value)}
              disabled={disabled}
              label={clinicalFieldLabel(field.labelKey)}
              onChange={(event) => onChange(field.name, event.target.checked)}
            />
          );
        case 'select':
          return (
            <Field key={field.name} label={clinicalFieldLabel(field.labelKey)} className="max-w-xs">
              <Select
                value={asText(value)}
                disabled={disabled}
                onChange={(event) => onChange(field.name, event.target.value || null)}
              >
                <option value="">{t('clinica.opcion.sinDato')}</option>
                {field.options.map((option) => (
                  <option key={option} value={option}>
                    {clinicalOptionLabel(field.group, option)}
                  </option>
                ))}
              </Select>
            </Field>
          );
        case 'catalog':
          return (
            <CatalogChecklist
              key={field.name}
              group={field.group}
              codes={field.codes}
              value={asCatalog(value)}
              disabled={disabled}
              onChange={(next) => onChange(field.name, next)}
            />
          );
        case 'procedures':
          return (
            <div key={field.name}>
              <p className="text-sm font-medium text-ink">{clinicalFieldLabel(field.labelKey)}</p>
              <div className="mt-2">
                <ProcedureList
                  value={asProcedures(value)}
                  disabled={disabled}
                  onChange={(rows) => onChange(field.name, rows)}
                />
              </div>
            </div>
          );
        default:
          return null;
      }
    })}
  </div>
);
