import {
  createPatientSchema,
  guardianSchema,
  isMinor,
  normalizeDocNumber,
  patientCoreSchema,
  SENSITIVE_PATIENT_FIELDS,
  validateDocument,
  type CreatePatientInput,
  type DocType,
  type GuardianInput,
  type PatientDetail,
  type PatientSummary,
  type SensitivePatientField,
  type Sex,
  type UpdatePatientInput,
} from '@odontocrm/contracts';
import { z } from 'zod';

import { isApiError } from './api';
import { t } from './i18n';

/**
 * Piezas compartidas del módulo de pacientes (Fase 2).
 *
 * Aquí vive lo que comparten `/registro`, `/pacientes` y `/pacientes/:id`:
 * el manejo del documento mientras se teclea (selector de tipo + máscara), la
 * conversión de la ficha a valores de formulario, el cálculo del cambio y el
 * resumen de la confirmación. La validación de fondo sigue siendo la de
 * `@odontocrm/contracts`: este archivo no inventa reglas, solo las conecta.
 */

// --- Documento --------------------------------------------------------------

const GRUPO_MILES = /\B(?=(\d{3})+(?!\d))/g;

/** Solo los dígitos del número (para V/E). */
export const digitsOf = (value: string): string => value.replace(/\D/g, '');

/**
 * Aplica la máscara mientras se escribe. `V`/`E` se agrupan por miles
 * (`12.345.678`); `P`/`SC` son alfanuméricos en mayúsculas y no se agrupan
 * (un pasaporte puede tener letras). Acepta `null`/`undefined` porque el valor
 * de un campo de react-hook-form puede venir vacío.
 */
export const formatDocNumberInput = (type: DocType, value: string | null | undefined): string => {
  const bruto = value ?? '';
  if (type === 'V' || type === 'E') {
    const digitos = digitsOf(bruto).slice(0, 8);
    return digitos.replace(GRUPO_MILES, '.');
  }
  return normalizeDocNumber(bruto).slice(0, 15);
};

/** Lo que se guarda en el formulario: el número sin puntos ni espacios. */
export const normalizeDocInput = (type: DocType, value: string | null | undefined): string =>
  type === 'V' || type === 'E' ? digitsOf(value ?? '') : normalizeDocNumber(value ?? '');

/** Documento listo para mostrar o enviar: `V-12345678` (sin puntos). */
export const documentFrom = (type: DocType, number: string): string =>
  `${type}-${normalizeDocNumber(number)}`;

export interface DocumentInput {
  docType: DocType;
  /** Lo que hay que enseñar en el campo (con máscara). */
  display: string;
}

/**
 * Lee el campo de documento aceptando cualquier forma: `V-12345678`,
 * `v 12.345.678`, `e1234567`, `P A123456`, `SC-0042` o solo `12345678` (para lo
 * que se conserva el tipo elegido en el selector). Devuelve el tipo detectado y
 * el texto que debe quedar en el campo.
 */
export const readDocumentInput = (raw: string, fallbackType: DocType): DocumentInput => {
  const texto = raw.normalize('NFKC').trim().toUpperCase();
  const coincidencia = /^(?<prefix>SC|V|E|P)?[\s.\-/]*(?<rest>[A-Z0-9.\-\s]*)$/.exec(texto);

  const prefijo = coincidencia?.groups?.['prefix'];
  const docType = prefijo === undefined ? fallbackType : (prefijo as DocType);
  const resto = coincidencia?.groups?.['rest'] ?? texto;

  return { docType, display: formatDocNumberInput(docType, resto) };
};

/** Validación del contrato para lo que hay ahora mismo en el campo. */
export const checkDocument = (type: DocType, display: string) =>
  validateDocument(type, normalizeDocNumber(display));

// --- Valores del formulario -------------------------------------------------

export type GuardianFormValues = z.input<typeof guardianSchema>;

/**
 * Esquema del formulario de paciente. Reutiliza los campos del contrato
 * (`patientCoreSchema` y `guardianSchema`: mismos teléfonos, mismas fechas,
 * mismos límites de texto) y solo cambia `docNumber`, que en el formulario se
 * teclea y se valida aquí para no perder el texto mientras se escribe.
 */
export const patientFormSchema = z
  .object({
    ...patientCoreSchema.omit({ docNumber: true, sex: true }).shape,
    docNumber: z.string().trim().min(1, 'Escribe el documento'),
    sex: z.union([z.literal(''), patientCoreSchema.shape.sex]),
    guardian: guardianSchema.optional(),
  })
  .superRefine((value, ctx) => {
    const documento = validateDocument(value.docType, value.docNumber);
    if (!documento.ok) {
      ctx.addIssue({
        code: 'custom',
        path: ['docNumber'],
        message: documento.message ?? 'Documento inválido',
      });
    }
    if (value.sex === '') {
      ctx.addIssue({ code: 'custom', path: ['sex'], message: 'Indica el sexo' });
    }
    if (isMinor(value.birthDate) && value.guardian === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['guardian'],
        message: 'Para un menor de edad hay que registrar al representante',
      });
    }
  })
  .transform((value) => ({ ...value, docNumber: normalizeDocNumber(value.docNumber) }));

/** Lo que se teclea en el formulario (los opcionales llegan como texto). */
export type PatientFormValues = z.input<typeof patientFormSchema>;
/** Lo que devuelve el resolvedor ya validado: el tipo canónico que usa la ficha. */
export type PatientFormOutput = z.output<typeof patientFormSchema>;
/** Valores iniciales: basta con los campos que se quieran prescribir. */
export type PatientFormDraft = Partial<PatientFormValues>;
/** El sexo, tal como lo describe el contrato (`M`, `F` u `O`). */
export type PatientSex = Sex;

const texto = (value: string | null | undefined): string => value ?? '';

const telefonoVisible = (value: string | null | undefined): string => {
  if (value === null || value === undefined || value === '') return '';
  const digitos = digitsOf(value);
  const nacional = digitos.startsWith('58') ? digitos.slice(2) : digitos;
  return nacional.startsWith('0') ? nacional : `0${nacional}`;
};

/** Ficha del servidor → valores del formulario (con el documento enmascarado). */
export const formValuesFromPatient = (patient: PatientDetail): PatientFormValues => ({
  docType: patient.docType,
  docNumber: formatDocNumberInput(patient.docType, patient.docNumber),
  fullName: patient.fullName,
  birthDate: patient.birthDate.slice(0, 10),
  sex: patient.sex,
  phone: telefonoVisible(patient.phone),
  phoneAlt: telefonoVisible(patient.phoneAlt),
  email: texto(patient.email),
  address: texto(patient.address),
  occupation: texto(patient.occupation),
  notes: texto(patient.notes),
  // Sin representante, la clave se omite: así el campo no entra en el resumen.
  ...(patient.guardian === null
    ? {}
    : {
        guardian: {
          fullName: patient.guardian.fullName,
          docType: patient.guardian.docType ?? 'V',
          docNumber: texto(patient.guardian.docNumber),
          relationship: patient.guardian.relationship,
          phone: telefonoVisible(patient.guardian.phone),
        },
      }),
});

export const emptyFormValues = (
  docType: DocType = 'V',
  docNumber = '',
  fullName = '',
): PatientFormValues => ({
  docType,
  docNumber,
  fullName,
  birthDate: '',
  sex: '',
  phone: '',
  phoneAlt: '',
  email: '',
  address: '',
  occupation: '',
  notes: '',
});

/** Valores del formulario ya limpios y validados por el contrato (alta). */
export const createPayloadFromForm = (values: PatientFormValues): CreatePatientInput =>
  createPatientSchema.parse(patientFormSchema.parse(values));

// --- Cambios y confirmación -------------------------------------------------

export type PatientChangeKind = 'sensitive' | 'document' | 'status' | 'guardian';

export interface PatientChange {
  /** Campo del contrato (`fullName`, `phone`, `guardian`…). */
  field: string;
  kind: PatientChangeKind;
  before: string;
  after: string;
}

const valorVisible = (value: string | null | undefined): string =>
  value === null || value === undefined || value === '' ? t('comun.sinDato') : value;

const camposSensibles: readonly string[] = SENSITIVE_PATIENT_FIELDS;

const esSensible = (field: string): boolean =>
  camposSensibles.includes(field as SensitivePatientField);

const cambiosDeTexto = (
  base: Record<string, string | null>,
  editado: Record<string, string | null>,
): PatientChange[] => {
  const cambios: PatientChange[] = [];
  for (const campo of Object.keys(base)) {
    const antes = base[campo] ?? null;
    const despues = editado[campo] ?? null;
    if (antes === despues) continue;
    cambios.push({
      field: campo,
      kind: esSensible(campo) ? 'sensitive' : 'document',
      before: valorVisible(antes),
      after: valorVisible(despues),
    });
  }
  return cambios;
};

/** Pasa el representante del formulario por el contrato ('' → null, teléfonos). */
const guardianInputFrom = (guardian: unknown): GuardianInput | null => {
  if (guardian === null || guardian === undefined) return null;
  const resultado = guardianSchema.safeParse(guardian);
  return resultado.success ? resultado.data : null;
};

const cambiosDelRepresentante = (
  antes: GuardianInput | null,
  despues: GuardianInput | null,
): PatientChange[] => {
  if (antes === null && despues === null) return [];
  if (antes === null || despues === null) {
    return [
      {
        field: 'guardian',
        kind: 'guardian',
        before: antes === null ? t('pacientes.ficha.sinRepresentante') : antes.fullName,
        after: despues === null ? t('pacientes.ficha.sinRepresentante') : despues.fullName,
      },
    ];
  }

  const cambios: PatientChange[] = [];
  for (const clave of Object.keys(antes) as (keyof GuardianInput)[]) {
    const valorAntes = antes[clave] ?? null;
    const valorDespues = despues[clave] ?? null;
    if (valorAntes === valorDespues) continue;
    cambios.push({
      field: `guardian.${clave}`,
      kind: 'guardian',
      before: valorVisible(valorAntes),
      after: valorVisible(valorDespues),
    });
  }
  return cambios;
};

export interface ChangeSummary {
  changes: PatientChange[];
  /** Campos sensibles tocados: el diálogo los destaca. */
  sensitive: string[];
  /** Cuerpo del `PATCH`: solo los campos que cambian, más el motivo. */
  payload: UpdatePatientInput;
}

/**
 * Compara la ficha original con lo editado y devuelve el resumen que se enseña
 * en el diálogo de confirmación junto con el `PATCH` que se enviará.
 *
 * La comparación se hace sobre los valores **canónicos**: se validan con los
 * esquemas del contrato, así quitar los puntos de la cédula o reescribir el
 * teléfono no cuenta como cambio. `reason` lo añade quien llama.
 */
export const summarizePatientChanges = (
  original: PatientDetail,
  values: PatientFormValues,
  reason: string,
): ChangeSummary => {
  const editado = createPayloadFromForm(values);
  const cambios = cambiosDeTexto(
    {
      fullName: original.fullName,
      docNumber: original.docNumber,
      birthDate: original.birthDate.slice(0, 10),
      phone: original.phone,
      phoneAlt: original.phoneAlt,
      email: original.email,
      address: original.address,
      occupation: original.occupation,
      notes: original.notes,
    },
    {
      fullName: editado.fullName,
      docNumber: editado.docNumber,
      birthDate: editado.birthDate,
      phone: editado.phone,
      phoneAlt: editado.phoneAlt,
      email: editado.email,
      address: editado.address,
      occupation: editado.occupation,
      notes: editado.notes,
    },
  );

  if (original.sex !== editado.sex) {
    cambios.push({
      field: 'sex',
      kind: 'document',
      before: original.sex,
      after: editado.sex,
    });
  }

  const representanteAntes =
    original.guardian === null
      ? null
      : guardianSchema.parse({
          fullName: original.guardian.fullName,
          docType: original.guardian.docType,
          docNumber: original.guardian.docNumber ?? '',
          relationship: original.guardian.relationship,
          phone: original.guardian.phone ?? '',
        });

  // Al cumplir 18 años el representante deja de tener sentido: se quita. Los dos
  // lados se comparan ya normalizados por el contrato ('' → null).
  const representanteDespues = guardianInputFrom(
    isMinor(editado.birthDate) ? editado.guardian : null,
  );
  cambios.push(...cambiosDelRepresentante(representanteAntes, representanteDespues));

  const payload: UpdatePatientInput = { reason };
  for (const cambio of cambios) {
    const raiz = cambio.field.split('.')[0];
    if (raiz === undefined) continue;
    if (raiz === 'guardian') {
      payload.guardian = representanteDespues;
      continue;
    }
    if (raiz === 'fullName') payload.fullName = editado.fullName;
    else if (raiz === 'docNumber') {
      payload.docType = editado.docType;
      payload.docNumber = editado.docNumber;
    } else if (raiz === 'birthDate') payload.birthDate = editado.birthDate;
    else if (raiz === 'phone') payload.phone = editado.phone;
    else if (raiz === 'phoneAlt') payload.phoneAlt = editado.phoneAlt ?? '';
    else if (raiz === 'email') payload.email = editado.email ?? '';
    else if (raiz === 'address') payload.address = editado.address ?? '';
    else if (raiz === 'occupation') payload.occupation = editado.occupation ?? '';
    else if (raiz === 'notes') payload.notes = editado.notes ?? '';
    else if (raiz === 'sex') payload.sex = editado.sex;
  }

  return {
    changes: cambios,
    sensitive: cambios.filter((cambio) => cambio.kind === 'sensitive').map((c) => c.field),
    payload,
  };
};

// --- Errores de la API ------------------------------------------------------

/** `existingPatientId` que acompaña al 409 del documento duplicado. */
export const existingPatientIdFrom = (error: unknown): string | undefined => {
  if (!isApiError(error)) return undefined;
  const valor = error.payload?.['existingPatientId'];
  return typeof valor === 'string' && valor.length > 0 ? valor : undefined;
};

/** `true` cuando el alta chocó con un documento ya registrado. */
export const isDuplicateDocument = (error: unknown): boolean =>
  isApiError(error) && error.status === 409;

/**
 * Campos con error que devuelve el servidor, ya listos para pintar. La limpieza
 * de los textos libres la hace `cleanText` dentro de los esquemas del contrato
 * (`patientFormSchema` → `createPatientSchema`), no este archivo.
 */
export const fieldErrorsFrom = (error: unknown): readonly string[] =>
  isApiError(error) ? Object.values(error.fieldErrors) : [];

/** Resumen visible de un paciente para títulos y avisos. */
export const patientLabel = (patient: Pick<PatientSummary, 'fullName' | 'document'>): string =>
  `${patient.fullName} (${patient.document})`;
