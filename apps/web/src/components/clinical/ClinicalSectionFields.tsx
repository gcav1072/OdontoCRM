import { Badge, Button, Checkbox, Dialog, Field, Input, Select, Textarea, cn } from '@odontocrm/ui';
import { Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';

import {
  CLINICAL_PRIORITIES,
  asDiagnosisItems,
  clinicalCatalogItemLabel,
  clinicalCatalogTitle,
  clinicalFieldLabel,
  clinicalOptionLabel,
  clinicalPriorityLabel,
  newDiagnosisItem,
  type ClinicalFieldSpec,
  type DiagnosisItemDraft,
} from '../../lib/clinical';
import { t } from '../../lib/i18n';

/** Valor de un catálogo tipificado: casillas + texto libre para «otros». */
export interface CatalogValue {
  items: string[];
  otros: string | null;
}

/**
 * Un procedimiento del plan tal como vive en el borrador (v1.2): `diagnosticoId`
 * lo une a su hallazgo del diagnóstico; los ítems libres van con `null`.
 */
export interface ProcedureValue {
  diagnosticoId: string | null;
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

/** Lee los procedimientos del plan de un contenido sin validar. */
export const asProcedures = (value: unknown): ProcedureValue[] =>
  Array.isArray(value)
    ? value.map((item) => {
        const row = (typeof item === 'object' && item !== null ? item : {}) as Record<
          string,
          unknown
        >;
        const diagnosticoId = asText(row['diagnosticoId']);
        return {
          diagnosticoId: diagnosticoId === '' ? null : diagnosticoId,
          descripcion: asText(row['descripcion']),
          prioridad: asText(row['prioridad']) || 'media',
          pieza: asText(row['pieza']) || null,
          presupuesto: typeof row['presupuesto'] === 'number' ? row['presupuesto'] : null,
        };
      })
    : [];

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

/**
 * Lista de hallazgos del diagnóstico (cambio 3, v1.2).
 *
 * Cada fila es un ítem con su UUID; agregarlo abre **en el acto** su
 * procedimiento en el plan (lo hace la sincronización del formulario). Quitar un
 * ítem cuyo procedimiento ya tiene tratamiento cargado pide confirmación: se
 * borran los dos, porque el plan no puede quedar apuntando a un diagnóstico que
 * ya no existe.
 */
const DiagnosisItemList = ({
  value,
  planProcedures,
  onChange,
  disabled,
}: {
  value: DiagnosisItemDraft[];
  planProcedures: readonly ProcedureValue[];
  onChange: (rows: DiagnosisItemDraft[]) => void;
  disabled: boolean;
}) => {
  const [porBorrar, setPorBorrar] = useState<DiagnosisItemDraft | null>(null);

  const procedimientoEnlazado = (id: string): ProcedureValue | undefined =>
    planProcedures.find((row) => row.diagnosticoId === id);

  const actualizar = (index: number, patch: Partial<DiagnosisItemDraft>): void => {
    onChange(value.map((row, position) => (position === index ? { ...row, ...patch } : row)));
  };

  const pedirBorrado = (item: DiagnosisItemDraft): void => {
    const enlazado = procedimientoEnlazado(item.id);
    const conContenido =
      enlazado !== undefined &&
      (enlazado.descripcion.trim() !== '' || enlazado.presupuesto !== null);
    if (conContenido) setPorBorrar(item);
    else onChange(value.filter((row) => row.id !== item.id));
  };

  const confirmarBorrado = (): void => {
    if (porBorrar === null) return;
    onChange(value.filter((row) => row.id !== porBorrar.id));
    setPorBorrar(null);
  };

  const planDescripcion =
    porBorrar === null ? '' : (procedimientoEnlazado(porBorrar.id)?.descripcion ?? '');

  return (
    <div className="space-y-3">
      {value.length === 0 && (
        <p className="text-sm text-ink-subtle">{t('clinica.diagnostico.sinItems')}</p>
      )}
      {value.map((item, index) => (
        <div
          key={item.id === '' ? `diagnostico-${index}` : item.id}
          className="grid grid-cols-1 gap-3 rounded-control border border-border p-3 @2xl:grid-cols-[minmax(0,1fr)_12rem_auto]"
        >
          <Field label={t('clinica.diagnostico.descripcion')} required>
            <Input
              value={item.descripcion}
              disabled={disabled}
              maxLength={500}
              placeholder={t('clinica.diagnostico.descripcionPlaceholder')}
              onChange={(event) => actualizar(index, { descripcion: event.target.value })}
            />
          </Field>
          <Field label={t('clinica.diagnostico.piezas')}>
            <Input
              value={item.piezas ?? ''}
              disabled={disabled}
              maxLength={60}
              placeholder={t('clinica.diagnostico.piezasPlaceholder')}
              onChange={(event) => actualizar(index, { piezas: event.target.value || null })}
            />
          </Field>
          <div className="flex items-end">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={disabled}
              onClick={() => pedirBorrado(item)}
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
        onClick={() => onChange([...value, newDiagnosisItem()])}
      >
        {t('clinica.diagnostico.agregar')}
      </Button>

      <Dialog
        open={porBorrar !== null}
        onClose={() => setPorBorrar(null)}
        title={t('clinica.diagnostico.confirmarTitulo')}
        footer={
          <>
            <Button variant="secondary" onClick={() => setPorBorrar(null)}>
              {t('comun.cancelar')}
            </Button>
            <Button variant="danger" onClick={confirmarBorrado}>
              {t('clinica.diagnostico.confirmarAccion')}
            </Button>
          </>
        }
      >
        <p className="text-sm text-ink-muted">
          {t('clinica.diagnostico.confirmarTexto', { descripcion: planDescripcion })}
        </p>
      </Dialog>
    </div>
  );
};

/**
 * Lista de procedimientos del plan distinguiendo los **vinculados** a un
 * diagnóstico (pieza fijada por el diagnóstico, sin botón de quitar: se gestiona
 * desde la lista de diagnósticos) de los **libres** (todos los campos
 * editables).
 */
const ProcedureList = ({
  value,
  diagnosisItems,
  onChange,
  disabled,
}: {
  value: ProcedureValue[];
  diagnosisItems: readonly DiagnosisItemDraft[];
  onChange: (rows: ProcedureValue[]) => void;
  disabled: boolean;
}) => {
  // El plan siempre va «vinculados en orden del diagnóstico + libres al final»:
  // así lo deja la sincronización del contrato y así se edita aquí.
  const ordenados = [
    ...value.filter((row) => row.diagnosticoId !== null),
    ...value.filter((row) => row.diagnosticoId === null),
  ];

  const actualizar = (index: number, patch: Partial<ProcedureValue>): void => {
    onChange(ordenados.map((row, position) => (position === index ? { ...row, ...patch } : row)));
  };

  const vinculos = ordenados.filter((row) => row.diagnosticoId !== null);
  const libres = ordenados.filter((row) => row.diagnosticoId === null);

  return (
    <div className="space-y-3">
      {ordenados.length === 0 && (
        <p className="text-sm text-ink-subtle">{t('clinica.plan.sinProcedimientos')}</p>
      )}

      {vinculos.map((row, index) => {
        const item = diagnosisItems.find((diagnostico) => diagnostico.id === row.diagnosticoId);
        const piezas = item?.piezas ?? row.pieza;
        const pendiente = row.descripcion.trim() === '';
        const diagnosticoDescripcion =
          item === undefined || item.descripcion.trim() === ''
            ? t('clinica.plan.diagnosticoPendienteDescripcion')
            : item.descripcion;
        return (
          <div
            key={row.diagnosticoId ?? `vinculado-${index}`}
            className="rounded-control border border-border p-3"
          >
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="info">
                {t('clinica.plan.diagnosticoVinculado', { descripcion: diagnosticoDescripcion })}
              </Badge>
              {piezas !== null && piezas !== '' && (
                <Badge variant="neutral">{t('clinica.plan.piezasVinculadas', { piezas })}</Badge>
              )}
              {pendiente && (
                <Badge variant="warning">{t('clinica.plan.pendientePorCompletar')}</Badge>
              )}
            </div>
            <div className="mt-2 grid grid-cols-1 gap-3 @2xl:grid-cols-[minmax(0,1fr)_9rem_8rem]">
              <Field label={t('clinica.plan.descripcion')}>
                <Input
                  value={row.descripcion}
                  disabled={disabled}
                  maxLength={200}
                  placeholder={t('clinica.plan.tratamientoPlaceholder')}
                  aria-invalid={pendiente || undefined}
                  onChange={(event) => actualizar(index, { descripcion: event.target.value })}
                />
              </Field>
              <Field label={t('clinica.plan.prioridad')}>
                <Select
                  value={row.prioridad}
                  disabled={disabled}
                  onChange={(event) => actualizar(index, { prioridad: event.target.value })}
                >
                  {CLINICAL_PRIORITIES.map((priority) => (
                    <option key={priority} value={priority}>
                      {clinicalPriorityLabel(priority)}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label={t('clinica.plan.presupuesto')}>
                <Input
                  type="number"
                  min={0}
                  step="0.01"
                  value={row.presupuesto ?? ''}
                  disabled={disabled}
                  onChange={(event) =>
                    actualizar(index, {
                      presupuesto: event.target.value === '' ? null : Number(event.target.value),
                    })
                  }
                />
              </Field>
            </div>
          </div>
        );
      })}

      {libres.map((row, index) => {
        const posicion = vinculos.length + index;
        return (
          <div
            key={row.diagnosticoId ?? `libre-${index}`}
            className="grid grid-cols-1 gap-3 rounded-control border border-border p-3 @2xl:grid-cols-[minmax(0,1fr)_8rem_6rem_8rem_auto]"
          >
            <Field label={t('clinica.plan.descripcion')}>
              <Input
                value={row.descripcion}
                disabled={disabled}
                maxLength={200}
                onChange={(event) => actualizar(posicion, { descripcion: event.target.value })}
              />
            </Field>
            <Field label={t('clinica.plan.prioridad')}>
              <Select
                value={row.prioridad}
                disabled={disabled}
                onChange={(event) => actualizar(posicion, { prioridad: event.target.value })}
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
                maxLength={60}
                onChange={(event) => actualizar(posicion, { pieza: event.target.value || null })}
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
                  actualizar(posicion, {
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
                onClick={() => onChange(ordenados.filter((_, position) => position !== posicion))}
                leadingIcon={<Trash2 className="size-4" aria-hidden />}
              >
                {t('comun.quitar')}
              </Button>
            </div>
          </div>
        );
      })}

      <Button
        type="button"
        variant="secondary"
        size="sm"
        disabled={disabled}
        leadingIcon={<Plus className="size-4" aria-hidden />}
        onClick={() =>
          onChange([
            ...ordenados,
            {
              diagnosticoId: null,
              descripcion: '',
              prioridad: 'media',
              pieza: null,
              presupuesto: null,
            },
          ])
        }
      >
        {t('clinica.plan.agregarProcedimientoAdicional')}
      </Button>
    </div>
  );
};

export interface ClinicalSectionFieldsProps {
  fields: readonly ClinicalFieldSpec[];
  content: Record<string, unknown>;
  onChange: (name: string, value: unknown) => void;
  disabled?: boolean;
  /** Ítems del diagnóstico vigentes: el plan muestra el vínculo y su pieza. */
  diagnosisItems?: readonly DiagnosisItemDraft[];
  /** Procedimientos del plan: el diagnóstico los consulta antes de borrar. */
  planProcedures?: readonly ProcedureValue[];
}

/** Pinta los campos de una sección a partir de su declaración. */
export const ClinicalSectionFields = ({
  fields,
  content,
  onChange,
  disabled = false,
  diagnosisItems = [],
  planProcedures = [],
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
              <Textarea
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
                  diagnosisItems={diagnosisItems}
                  disabled={disabled}
                  onChange={(rows) => onChange(field.name, rows)}
                />
              </div>
            </div>
          );
        case 'diagnosis_items':
          return (
            <div key={field.name}>
              <p className="text-sm font-medium text-ink">{clinicalFieldLabel(field.labelKey)}</p>
              <div className="mt-2">
                <DiagnosisItemList
                  value={asDiagnosisItems(value)}
                  planProcedures={planProcedures}
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
