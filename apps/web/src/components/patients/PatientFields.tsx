import {
  DOC_TYPES,
  SEXES,
  ageFromBirthDate,
  isMinor,
  type DocType,
  type Sex,
} from '@odontocrm/contracts';
import { Alert, Field, Input, Select } from '@odontocrm/ui';
import { CalendarDays, NotebookPen, Phone, UserRound } from 'lucide-react';
import type { ReactNode } from 'react';
import { Controller, type FieldErrors, type UseFormReturn } from 'react-hook-form';

import { DOC_TYPE_LABELS, SEX_LABELS, t } from '../../lib/i18n';
import {
  formatDocNumberInput,
  normalizeDocInput,
  patientFormSchema,
  readDocumentInput,
  type PatientFormValues,
} from '../../lib/patients';

/**
 * Campos compartidos del paciente: los usan el alta de `/registro`, la ficha de
 * `/pacientes/:id` y el modo lectura/edición. Están escritos una sola vez para
 * que las tres pantallas validen y muestren exactamente lo mismo.
 */

export type PatientFormApi = UseFormReturn<PatientFormValues>;
export type PatientFormErrors = FieldErrors<PatientFormValues>;

/** Sección con título e icono, para no repetir el mismo encabezado. */
const Seccion = ({
  titulo,
  icono,
  children,
  descripcion,
}: {
  titulo: string;
  icono: ReactNode;
  children: ReactNode;
  descripcion?: string;
}) => (
  <fieldset className="space-y-4 rounded-card border border-border bg-surface p-4">
    <legend className="flex items-center gap-2 px-1 text-sm font-semibold text-ink">
      <span className="grid size-6 place-items-center rounded-control bg-primary/10 text-primary">
        {icono}
      </span>
      {titulo}
    </legend>
    {descripcion && <p className="text-xs text-ink-subtle">{descripcion}</p>}
    {children}
  </fieldset>
);

export interface DocumentNumberFieldProps {
  label: string;
  /** Nombre del campo dentro del formulario (`docNumber`, `guardian.docNumber`). */
  name: 'docNumber' | 'guardian.docNumber';
  form: PatientFormApi;
  docType: DocType;
  onDocTypeChange: (type: DocType) => void;
  error?: string;
  hint?: string;
  disabled?: boolean;
  required?: boolean;
  /** El documento del representante también deja elegir el tipo. */
  showTypeSelector?: boolean;
  className?: string;
}

/**
 * Entrada de documento con selector de tipo y máscara de miles.
 *
 * Acepta que se pegue `V-12.345.678` o `v 12.345.678`: al soltar el texto se
 * separa el prefijo —cambiando el selector solo— y el número se agrupa por
 * miles mientras se escribe. Para `P` y `SC` no hay máscara: son alfanuméricos.
 * El formulario guarda el número **sin** puntos; los puntos son presentación.
 */
export const DocumentNumberField = ({
  label,
  name,
  form,
  docType,
  onDocTypeChange,
  error,
  hint,
  disabled = false,
  required = false,
  showTypeSelector = true,
  className,
}: DocumentNumberFieldProps) => (
  <div className={className}>
    <Field label={label} error={error} hint={hint} required={required}>
      <Controller
        control={form.control}
        name={name}
        render={({ field, fieldState }) => {
          const aplicar = (bruto: string, onValueChange: (valor: string) => void) => {
            const leido = readDocumentInput(bruto, docType);
            if (leido.docType !== docType) onDocTypeChange(leido.docType);
            onValueChange(normalizeDocInput(leido.docType, leido.display));
          };

          return (
            <div className="flex gap-2">
              {showTypeSelector && (
                <Select
                  aria-label={t('pacientes.campo.docType')}
                  className="w-32 shrink-0"
                  value={docType}
                  disabled={disabled}
                  onChange={(event) => {
                    const nuevo = event.target.value as DocType;
                    onDocTypeChange(nuevo);
                    field.onChange(normalizeDocInput(nuevo, field.value));
                  }}
                >
                  {DOC_TYPES.map((tipo) => (
                    <option key={tipo} value={tipo}>
                      {DOC_TYPE_LABELS[tipo]}
                    </option>
                  ))}
                </Select>
              )}

              <Input
                ref={field.ref}
                name={field.name}
                onBlur={field.onBlur}
                value={formatDocNumberInput(docType, field.value)}
                inputMode={docType === 'V' || docType === 'E' ? 'numeric' : 'text'}
                autoComplete="off"
                spellCheck={false}
                aria-invalid={fieldState.invalid || undefined}
                placeholder={
                  docType === 'V' || docType === 'E'
                    ? t('pacientes.doc.numeroPlaceholder')
                    : t('pacientes.doc.placeholder')
                }
                disabled={disabled}
                onChange={(event) => aplicar(event.target.value, field.onChange)}
              />
            </div>
          );
        }}
      />
    </Field>
  </div>
);

/** Nombre y sexo: van juntos en el alta y en la edición de la ficha. */
const NombreYSexo = ({ form, disabled }: { form: PatientFormApi; disabled: boolean }) => {
  const { errors } = form.formState;

  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <Field label={t('pacientes.campo.fullName')} error={errors.fullName?.message} required>
        <Input autoComplete="off" disabled={disabled} {...form.register('fullName')} />
      </Field>

      <Field label={t('pacientes.campo.sex')} error={errors.sex?.message} required>
        <Select disabled={disabled} {...form.register('sex')}>
          {/* El sexo es obligatorio: el hueco por defecto lo dice, no un «—» que
              parece un valor válido y luego no deja guardar. */}
          <option value="">{t('pacientes.campo.sexoPlaceholder')}</option>
          {SEXES.map((sexo: Sex) => (
            <option key={sexo} value={sexo}>
              {SEX_LABELS[sexo]}
            </option>
          ))}
        </Select>
      </Field>
    </div>
  );
};

/** Representante obligatorio de los menores de edad. */
const SeccionRepresentante = ({
  form,
  edad,
  disabled,
}: {
  form: PatientFormApi;
  edad: number;
  disabled: boolean;
}) => {
  const errores = form.formState.errors.guardian;
  const tipoDocumento = (form.watch('guardian.docType') ?? 'V') as DocType;
  // Un error anclado a la **raíz** de `guardian` (por ejemplo, una respuesta del
  // servidor) no corresponde a ningún subcampo: si no se pinta aquí, el usuario ve
  // el aviso general sin ningún campo marcado.
  const errorSeccion = errores?.root?.message;

  return (
    <Seccion
      titulo={t('pacientes.form.guardianTitulo')}
      icono={<UserRound className="size-3.5" aria-hidden="true" />}
    >
      {errorSeccion !== undefined && (
        <Alert variant="danger" aria-live="polite">
          {errorSeccion}
        </Alert>
      )}
      <Alert variant="info">{t('pacientes.form.guardianMotivo', { edad })}</Alert>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          label={t('pacientes.form.guardianNombre')}
          error={errores?.fullName?.message}
          required
        >
          <Input autoComplete="off" disabled={disabled} {...form.register('guardian.fullName')} />
        </Field>

        <Field
          label={t('pacientes.form.guardianParentesco')}
          error={errores?.relationship?.message}
          required
        >
          <Input
            autoComplete="off"
            disabled={disabled}
            placeholder={t('pacientes.form.guardianParentescoPlaceholder')}
            {...form.register('guardian.relationship')}
          />
        </Field>

        <DocumentNumberField
          label={t('pacientes.form.guardianDocumento')}
          name="guardian.docNumber"
          form={form}
          docType={tipoDocumento}
          onDocTypeChange={(tipo) => form.setValue('guardian.docType', tipo)}
          error={errores?.docNumber?.message}
          disabled={disabled}
        />

        <Field
          label={t('pacientes.form.guardianTelefono')}
          hint={t('pacientes.form.telefonoAyuda')}
          error={errores?.phone?.message}
        >
          <Input
            type="tel"
            inputMode="tel"
            autoComplete="off"
            disabled={disabled}
            {...form.register('guardian.phone')}
          />
        </Field>
      </div>
    </Seccion>
  );
};

export interface PatientFieldsProps {
  form: PatientFormApi;
  /** `true` cuando los campos no se pueden tocar (solo lectura). */
  disabled?: boolean;
  /** `false` en la ficha, donde el documento ya está en la cabecera. */
  showDocument?: boolean;
}

/**
 * Formulario del paciente, sin botones: documento, datos personales, contacto,
 * representante del menor y notas. La edad se calcula en vivo con
 * `ageFromBirthDate` del contrato.
 */
export const PatientFields = ({
  form,
  disabled = false,
  showDocument = true,
}: PatientFieldsProps) => {
  const { errors } = form.formState;
  const valores = form.watch();
  const docType = (valores.docType ?? 'V') as DocType;

  const fechaTexto = valores.birthDate ?? '';
  const fechaValida = fechaTexto.length === 10 && !Number.isNaN(new Date(fechaTexto).getTime());
  const edad = fechaValida ? ageFromBirthDate(fechaTexto) : null;
  const menor = fechaValida && isMinor(fechaTexto);

  return (
    <div className="space-y-4">
      {showDocument && (
        <Seccion
          titulo={t('pacientes.form.seccion')}
          icono={<CalendarDays className="size-3.5" aria-hidden="true" />}
          descripcion={t('pacientes.doc.ayuda')}
        >
          <DocumentNumberField
            label={t('pacientes.campo.docNumber')}
            name="docNumber"
            form={form}
            docType={docType}
            onDocTypeChange={(tipo) => form.setValue('docType', tipo)}
            error={errors.docNumber?.message}
            disabled={disabled}
            required
          />

          {docType === 'SC' && <Alert variant="warning">{t('pacientes.doc.avisoSC')}</Alert>}

          <NombreYSexo form={form} disabled={disabled} />
        </Seccion>
      )}

      {!showDocument && <NombreYSexo form={form} disabled={disabled} />}

      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          label={t('pacientes.campo.birthDate')}
          error={errors.birthDate?.message}
          hint={edad === null ? undefined : t('pacientes.form.edadCalculada', { edad })}
          required
        >
          <Input type="date" disabled={disabled} {...form.register('birthDate')} />
        </Field>

        <div className="flex flex-col gap-1.5">
          <span className="text-sm font-medium text-ink">{t('pacientes.filtro.edad')}</span>
          <p
            aria-live="polite"
            className="flex h-10 items-center rounded-control border border-border bg-surface-muted px-3 text-sm text-ink"
          >
            {edad === null ? t('comun.sinDato') : t('pacientes.form.edad', { edad })}
          </p>
        </div>
      </div>

      <Seccion
        titulo={t('pacientes.form.seccionContacto')}
        icono={<Phone className="size-3.5" aria-hidden="true" />}
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label={t('pacientes.campo.phone')}
            hint={t('pacientes.form.telefonoAyuda')}
            error={errors.phone?.message}
            required
          >
            <Input
              type="tel"
              inputMode="tel"
              autoComplete="off"
              disabled={disabled}
              {...form.register('phone')}
            />
          </Field>

          <Field
            label={t('pacientes.campo.phoneAlt')}
            hint={t('pacientes.form.telefonoAyuda')}
            error={errors.phoneAlt?.message}
          >
            <Input
              type="tel"
              inputMode="tel"
              autoComplete="off"
              disabled={disabled}
              {...form.register('phoneAlt')}
            />
          </Field>

          <Field
            label={t('pacientes.campo.email')}
            hint={t('pacientes.form.correoAyuda')}
            error={errors.email?.message}
          >
            <Input
              type="email"
              autoComplete="off"
              disabled={disabled}
              {...form.register('email')}
            />
          </Field>

          <Field label={t('pacientes.campo.occupation')} error={errors.occupation?.message}>
            <Input autoComplete="off" disabled={disabled} {...form.register('occupation')} />
          </Field>
        </div>

        <Field label={t('pacientes.campo.address')} error={errors.address?.message}>
          <Input autoComplete="off" disabled={disabled} {...form.register('address')} />
        </Field>
      </Seccion>

      {menor && <SeccionRepresentante form={form} edad={edad ?? 0} disabled={disabled} />}

      <Seccion
        titulo={t('pacientes.form.seccionNotas')}
        icono={<NotebookPen className="size-3.5" aria-hidden="true" />}
      >
        <Field
          label={t('pacientes.campo.notes')}
          hint={t('pacientes.form.notasAyuda')}
          error={errors.notes?.message}
        >
          <textarea
            rows={3}
            disabled={disabled}
            className="w-full rounded-control border border-border-strong bg-surface px-3 py-2 text-sm text-ink shadow-xs transition-colors placeholder:text-ink-subtle focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-solid focus-visible:outline-focus disabled:cursor-not-allowed disabled:bg-surface-muted disabled:text-ink-muted"
            {...form.register('notes')}
          />
        </Field>
      </Seccion>
    </div>
  );
};

/** Esquema del formulario, reexportado para quien valide fuera del componente. */
export { patientFormSchema };
