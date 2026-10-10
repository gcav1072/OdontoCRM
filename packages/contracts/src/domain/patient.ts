import { z } from 'zod';

import {
  DOC_TYPES,
  PATIENT_STATUSES,
  SEXES,
  type DocType,
  type PatientStatus,
  type Sex,
} from './enums.js';
/**
 * Identificación del paciente (ADR 0007):
 *   V  → venezolano, 6 a 8 dígitos
 *   E  → extranjero, 6 a 8 dígitos
 *   P  → pasaporte, 5 a 15 alfanuméricos
 *   SC → menor sin cédula, código temporal de 4 a 8 alfanuméricos
 *
 * La normalización es agresiva a propósito: «v 12.345.678», «V-12345678» y
 * «12345678» deben resolver al **mismo** paciente.
 */
export const DOC_NUMBER_RULES: Readonly<
  Record<DocType, { pattern: RegExp; min: number; max: number; hint: string }>
> = {
  V: { pattern: /^\d{6,8}$/, min: 6, max: 8, hint: 'La cédula debe tener entre 6 y 8 dígitos' },
  E: { pattern: /^\d{6,8}$/, min: 6, max: 8, hint: 'La cédula debe tener entre 6 y 8 dígitos' },
  P: {
    pattern: /^[A-Z0-9]{5,15}$/,
    min: 5,
    max: 15,
    hint: 'El pasaporte debe tener entre 5 y 15 letras o números',
  },
  SC: {
    pattern: /^[A-Z0-9]{4,8}$/,
    min: 4,
    max: 8,
    hint: 'El código del menor sin cédula debe tener entre 4 y 8 caracteres',
  },
};

/** Quita puntos, espacios, guiones y barras; deja mayúsculas y alfanuméricos. */
export const normalizeDocNumber = (value: string): string =>
  value
    .normalize('NFKC')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');

/**
 * Limpia texto libre: normaliza unicode, convierte caracteres de control en
 * espacios y colapsa los espacios repetidos. El contenido se guarda **como
 * dato**, nunca como SQL (todas las consultas van parametrizadas), así que las
 * comillas y los guiones son válidos: «O'Brien» es un apellido real.
 */
export const cleanText = (value: string): string =>
  value
    .normalize('NFKC')
    // eslint-disable-next-line no-control-regex -- se buscan justamente los caracteres de control para limpiarlos
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

export const normalizeDocType = (value: string): DocType | null => {
  const candidate = value.trim().toUpperCase();
  return (DOC_TYPES as readonly string[]).includes(candidate) ? (candidate as DocType) : null;
};

/** Clave única de búsqueda: `V:12345678`. */
export const documentKey = (type: DocType, number: string): string =>
  `${type}:${normalizeDocNumber(number)}`;

/** Formato de presentación: `V-12345678`. */
export const formatDocument = (type: DocType, number: string): string =>
  `${type}-${normalizeDocNumber(number)}`;

export interface ParsedDocument {
  type: DocType;
  number: string;
}

/**
 * Lee lo que escriba una persona (o el bot): `V-12345678`, `v 12.345.678`,
 * `e1234567`, `P A123456`, `SC-0042`. Si no hay prefijo se usa `defaultType`
 * (por defecto `V`, que es el caso habitual en el mostrador).
 */
export const parseDocumentText = (value: string, defaultType: DocType = 'V'): ParsedDocument => {
  const cleaned = value.normalize('NFKC').trim().toUpperCase();
  const match = /^(?<prefix>V|E|P|SC)?[\s.\-/]*(?<number>[A-Z0-9.\-\s]+)$/.exec(cleaned);

  if (match?.groups === undefined) {
    return { type: defaultType, number: normalizeDocNumber(cleaned) };
  }

  const prefix = match.groups['prefix'];
  const type = prefix === undefined ? defaultType : (prefix as DocType);
  return { type, number: normalizeDocNumber(match.groups['number'] ?? '') };
};

export interface DocumentValidationResult {
  ok: boolean;
  type: DocType;
  number: string;
  formatted: string;
  message?: string;
}

/** Valida un documento ya separado en tipo y número. */
export const validateDocument = (type: DocType, number: string): DocumentValidationResult => {
  const normalized = normalizeDocNumber(number);
  const rule = DOC_NUMBER_RULES[type];
  const formatted = formatDocument(type, normalized);

  if (normalized === '') {
    return {
      ok: false,
      type,
      number: normalized,
      formatted,
      message: 'Escribe el número del documento',
    };
  }
  if (!rule.pattern.test(normalized)) {
    return { ok: false, type, number: normalized, formatted, message: rule.hint };
  }
  if ((type === 'V' || type === 'E') && /^0+$/.test(normalized)) {
    return {
      ok: false,
      type,
      number: normalized,
      formatted,
      message: 'El número no puede ser todo ceros',
    };
  }
  return { ok: true, type, number: normalized, formatted };
};

export const docTypeSchema = z.enum(DOC_TYPES as unknown as [DocType, ...DocType[]]);
export const sexSchema = z.enum(SEXES as unknown as [Sex, ...Sex[]]);
export const patientStatusSchema = z.enum(
  PATIENT_STATUSES as unknown as [PatientStatus, ...PatientStatus[]],
);

export const documentSchema = z
  .object({ docType: docTypeSchema, docNumber: z.string().min(1, 'Escribe el documento') })
  .superRefine((value, ctx) => {
    const result = validateDocument(value.docType, value.docNumber);
    if (!result.ok) {
      ctx.addIssue({
        code: 'custom',
        path: ['docNumber'],
        message: result.message ?? 'Documento inválido',
      });
    }
  })
  .transform((value) => ({
    docType: value.docType,
    docNumber: normalizeDocNumber(value.docNumber),
  }));

/**
 * Teléfono de Venezuela normalizado a `+58XXXXXXXXXX`. Acepta `0412-1234567`,
 * `+58 412 123 45 67`, `4121234567` y descarta cualquier otra cosa.
 */
export const normalizePhone = (value: string): string => {
  const digits = value.replace(/\D/g, '');
  if (digits === '') return '';
  if (digits.startsWith('58')) return `+${digits}`;
  if (digits.startsWith('0')) return `+58${digits.slice(1)}`;
  return `+58${digits}`;
};

export const phoneSchema = z
  .string()
  .trim()
  .min(1, 'Escribe el teléfono')
  .transform(normalizePhone)
  .refine((value) => /^\+58\d{10}$/.test(value), {
    message: 'El teléfono debe tener 11 dígitos (por ejemplo 0412-1234567)',
  });

/**
 * Campos opcionales: aceptan `null` y `''` como «vacío» (los formularios y los
 * clientes JSON envían cualquiera de los dos) y se guardan siempre como `null`.
 */
const optionalPhoneSchema = z
  .union([z.null(), z.literal(''), phoneSchema])
  .optional()
  .transform((value) => (value === '' || value === null || value === undefined ? null : value));

const optionalText = (max: number) =>
  z
    .union([z.null(), z.literal(''), z.string().overwrite(cleanText).max(max)])
    .optional()
    .transform((value) => (value === '' || value === null || value === undefined ? null : value));

const requiredText = (min: number, max: number, message: string) =>
  z.string().overwrite(cleanText).pipe(z.string().min(min, message).max(max));

const birthDateSchema = z
  .string()
  .trim()
  .min(1, 'Escribe la fecha de nacimiento')
  .refine((value) => !Number.isNaN(new Date(value).getTime()), 'La fecha no es válida')
  .refine((value) => new Date(value).getTime() <= Date.now(), 'La fecha no puede ser futura')
  .refine(
    (value) => Date.now() - new Date(value).getTime() < 120 * 365.25 * 24 * 3600 * 1000,
    'Revisa la fecha de nacimiento',
  )
  .transform((value) => value.slice(0, 10));

/**
 * Años cumplidos a una fecha dada (por defecto hoy).
 *
 * Se compara en **UTC** de principio a fin: las fechas de nacimiento llegan como
 * `YYYY-MM-DD` (que JavaScript interpreta como medianoche UTC) y mezclar eso con
 * los getters locales adelantaba o atrasaba el cumpleaños un día según la zona.
 * En Venezuela (UTC-4) eso convertía a un menor de 18 en mayor el día anterior.
 */
export const ageFromBirthDate = (birthDate: string | Date, at: Date = new Date()): number => {
  const birth = typeof birthDate === 'string' ? new Date(birthDate) : birthDate;
  if (Number.isNaN(birth.getTime())) return 0;

  let age = at.getUTCFullYear() - birth.getUTCFullYear();
  const monthDiff = at.getUTCMonth() - birth.getUTCMonth();
  if (monthDiff < 0 || (monthDiff === 0 && at.getUTCDate() < birth.getUTCDate())) age -= 1;
  return Math.max(0, age);
};

export const MINOR_AGE = 18;
export const isMinor = (birthDate: string | Date, at: Date = new Date()): boolean =>
  ageFromBirthDate(birthDate, at) < MINOR_AGE;

export const guardianSchema = z.object({
  fullName: requiredText(3, 120, 'Escribe el nombre del representante'),
  docType: docTypeSchema.optional(),
  docNumber: optionalText(20),
  relationship: requiredText(3, 60, 'Indica el parentesco'),
  phone: optionalPhoneSchema,
});

export type GuardianInput = z.infer<typeof guardianSchema>;

export const patientCoreSchema = z.object({
  docType: docTypeSchema,
  docNumber: z.string().min(1, 'Escribe el documento'),
  fullName: requiredText(3, 120, 'Escribe el nombre completo'),
  birthDate: birthDateSchema,
  sex: sexSchema,
  phone: phoneSchema,
  phoneAlt: optionalPhoneSchema,
  email: z
    .union([z.null(), z.literal(''), z.email('El correo no es válido')])
    .optional()
    .transform((value) =>
      value === '' || value === null || value === undefined ? null : value.toLowerCase(),
    ),
  address: optionalText(240),
  occupation: optionalText(80),
  notes: optionalText(500),
});

/** Alta de paciente. El representante es obligatorio para menores de edad. */
export const createPatientSchema = patientCoreSchema
  .extend({ guardian: guardianSchema.optional() })
  .superRefine((value, ctx) => {
    const validation = validateDocument(value.docType, value.docNumber);
    if (!validation.ok) {
      ctx.addIssue({
        code: 'custom',
        path: ['docNumber'],
        message: validation.message ?? 'Documento inválido',
      });
    }
    if (isMinor(value.birthDate) && value.guardian === undefined) {
      // Igual que en el formulario: el aviso apunta al **nombre del representante**
      // para que el error del servidor caiga en un campo visible (`applyApiFieldErrors`).
      ctx.addIssue({
        code: 'custom',
        path: ['guardian', 'fullName'],
        message: 'Para un menor de edad hay que registrar al representante',
      });
    }
  })
  .transform((value) => ({
    ...value,
    docNumber: normalizeDocNumber(value.docNumber),
  }));

export type CreatePatientInput = z.infer<typeof createPatientSchema>;

/** Edición: exige **motivo** (queda en auditoría, decisión del usuario). */
export const updatePatientSchema = patientCoreSchema
  .partial()
  .extend({
    guardian: guardianSchema.nullable().optional(),
    reason: z.string().trim().min(3, 'Indica el motivo del cambio').max(300),
    status: patientStatusSchema.optional(),
  })
  .superRefine((value, ctx) => {
    if (value.docNumber !== undefined && (value.docType === undefined || value.docNumber === '')) {
      ctx.addIssue({ code: 'custom', path: ['docNumber'], message: 'Indica el tipo y el número' });
    }
  });

export type UpdatePatientInput = z.infer<typeof updatePatientSchema>;

/** Cambio de estado sin editar datos (activar, inactivar). */
export const changePatientStatusSchema = z.object({
  status: patientStatusSchema,
  reason: z.string().trim().min(3, 'Indica el motivo del cambio').max(300),
});

export type ChangePatientStatusInput = z.infer<typeof changePatientStatusSchema>;

/**
 * Borrado lógico: exige motivo y está reservado al `admin` (permiso
 * `patients:delete`, ADR 0027). Nada se destruye: el paciente y sus archivos
 * quedan marcados y desaparecen de listas, búsquedas y fichas, pero el rastro
 * (documentos, historial y auditoría) se conserva y el documento vuelve a quedar
 * libre por si hubo un error de tecleo.
 */
export const deletePatientSchema = z.object({
  reason: z.string().trim().min(3, 'Indica el motivo del borrado').max(300),
});

export type DeletePatientInput = z.infer<typeof deletePatientSchema>;

/** Alta o actualización desde otro servicio o desde el bot (endpoint interno). */
export const upsertPatientSchema = createPatientSchema;

export type UpsertPatientInput = z.infer<typeof upsertPatientSchema>;

export const patientSummarySchema = z.object({
  id: z.uuid(),
  docType: docTypeSchema,
  docNumber: z.string(),
  document: z.string(),
  fullName: z.string(),
  birthDate: z.string(),
  age: z.number().int().min(0),
  isMinor: z.boolean(),
  sex: sexSchema,
  phone: z.string(),
  phoneAlt: z.string().nullable(),
  status: patientStatusSchema,
  isFictitious: z.boolean(),
  hasGuardian: z.boolean(),
  createdAt: z.string(),
});

export type PatientSummary = z.infer<typeof patientSummarySchema>;

export const patientDetailSchema = patientSummarySchema.extend({
  email: z.string().nullable(),
  address: z.string().nullable(),
  occupation: z.string().nullable(),
  notes: z.string().nullable(),
  guardian: guardianSchema.extend({ id: z.uuid() }).nullable(),
  updatedAt: z.string(),
  fileCount: z.number().int().min(0),
});

export type PatientDetail = z.infer<typeof patientDetailSchema>;

export const patientFiltersSchema = z.object({
  search: z.string().trim().max(120).optional(),
  status: patientStatusSchema.optional(),
  docType: docTypeSchema.optional(),
  sex: sexSchema.optional(),
  ageMin: z.coerce.number().int().min(0).max(120).optional(),
  ageMax: z.coerce.number().int().min(0).max(120).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(25),
});

export type PatientFilters = z.infer<typeof patientFiltersSchema>;

/** Respuesta de la búsqueda por documento: o viene el paciente… o el conflicto. */
export const patientLookupResultSchema = z.discriminatedUnion('found', [
  z.object({ found: z.literal(true), patient: patientDetailSchema }),
  z.object({ found: z.literal(false), document: z.string() }),
]);

export type PatientLookupResult = z.infer<typeof patientLookupResultSchema>;

export const PATIENT_FILE_KINDS = [
  'radiografia',
  'foto',
  'pdf',
  'consentimiento',
  'laboratorio',
  'otro',
] as const;
export type PatientFileKind = (typeof PATIENT_FILE_KINDS)[number];

export const patientFileSchema = z.object({
  id: z.uuid(),
  patientId: z.uuid(),
  kind: z.enum(PATIENT_FILE_KINDS),
  originalName: z.string(),
  mime: z.string(),
  size: z.number().int().min(0),
  sha256: z.string(),
  caption: z.string().nullable(),
  uploadedBy: z.uuid().nullable(),
  createdAt: z.string(),
});

export type PatientFile = z.infer<typeof patientFileSchema>;

/** Formatos aceptados y límite de tamaño para adjuntos (imágenes y PDF). */
export const ALLOWED_FILE_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'application/pdf',
] as const;

export const MAX_FILE_BYTES = 20 * 1024 * 1024;

/**
 * Campos cuyo cambio queda registrado en la auditoría (decisión del usuario:
 * nombre, teléfono, dirección y fecha de nacimiento, más el documento y el
 * correo, que también identifican a la persona).
 */
export const SENSITIVE_PATIENT_FIELDS = [
  'fullName',
  'docNumber',
  'birthDate',
  'phone',
  'phoneAlt',
  'email',
  'address',
] as const;

export type SensitivePatientField = (typeof SENSITIVE_PATIENT_FIELDS)[number];

/** Carga que acompaña a los eventos `patients.patient.*` para poder auditar. */
export const patientAuditPayloadSchema = z.object({
  patientId: z.uuid(),
  document: z.string(),
  fullName: z.string(),
  action: z.enum(['created', 'updated', 'status_changed', 'deleted']),
  changedFields: z.array(z.string()),
  before: z.record(z.string(), z.unknown()).nullable(),
  after: z.record(z.string(), z.unknown()).nullable(),
  reason: z.string().nullable(),
  actorId: z.uuid().nullable(),
  actorUsername: z.string().nullable(),
  ip: z.string().nullable(),
  userAgent: z.string().nullable(),
  requestId: z.string().nullable(),
});

export type PatientAuditPayload = z.infer<typeof patientAuditPayloadSchema>;
