import { z } from 'zod';

/**
 * **Dossier del expediente**: el PDF A4 que reúne, en un solo documento foliado, la
 * filiación del paciente, su odontograma, la evolución de sus sesiones y sus récipes.
 *
 * Vive aquí —y no solo en el servicio clínico— porque lo leen **dos** consumidores que
 * no comparten proceso: el servicio que compone el PDF y la **página pública de
 * verificación** que abre quien tiene el papel en la mano. El número y el código de
 * verificación tienen que formatearse igual en los dos sitios, o el código del QR no
 * encontraría el documento.
 */

/** Prefijo del correlativo. La serie es **global**: `EXP-000001`, `EXP-000002`… */
export const DOSSIER_NUMBER_PREFIX = 'EXP';

/**
 * Número del dossier tal como se imprime: `EXP-000001`.
 *
 * El relleno a seis dígitos hace que los correlativos se ordenen alfabéticamente igual
 * que numéricamente —lo que necesita un libro de expedientes— y deja mil millones de
 * documentos antes de quedarse corto.
 */
export const formatDossierNumber = (value: number): string =>
  `${DOSSIER_NUMBER_PREFIX}-${String(Math.max(0, Math.trunc(value))).padStart(6, '0')}`;

/**
 * Lo que responde la página pública: que el papel es auténtico y a quién pertenece,
 * **sin datos clínicos** —ni diagnósticos, ni tratamientos, ni medicamentos—, que es
 * el mismo criterio del récipe ([ADR 0015](../../../docs/adr/0015-recipe-a5-en-pdf.md)).
 * Del paciente sale solo el nombre abreviado («María P.»), que basta para que quien
 * tenga el papel reconozca que es suyo.
 */
export const dossierVerificationSchema = z.object({
  valid: z.literal(true),
  number: z.string().min(1),
  clinicName: z.string().min(1),
  /** Fecha y hora de la exportación, en ISO (la interfaz la pasa a la zona de la clínica). */
  issuedAt: z.string(),
  /** Odontólogo que lo emitió (el que firmaría), o `null` si no consta. */
  dentistName: z.string().nullable(),
  dentistMpps: z.string().nullable(),
  patientReference: z.string().min(1),
  /** Huella del PDF archivado: cambia si alguien alterara el archivo. */
  sha256: z.string().nullable(),
});
export type DossierVerification = z.infer<typeof dossierVerificationSchema>;

/** El código no existe: el papel puede ser falso, o estar mal copiado. */
export const dossierNotVerifiedSchema = z.object({
  valid: z.literal(false),
  number: z.string().nullable(),
});

export const dossierVerificationResultSchema = z.discriminatedUnion('valid', [
  dossierVerificationSchema,
  dossierNotVerifiedSchema,
]);
export type DossierVerificationResult = z.infer<typeof dossierVerificationResultSchema>;

/** Ficha de una exportación archivada (lo que enseña la interfaz tras generarla). */
export interface DossierExport {
  id: string;
  number: string;
  patientId: string;
  issuedAt: string;
  issuedByUsername: string | null;
  /** Código de verificación ya formateado (`ABCDE-FGHJK`), con el que se arma el QR. */
  verifyCode: string | null;
  sha256: string;
  pageCount: number | null;
}
