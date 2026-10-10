import {
  BRAND,
  brandSettingsSchema,
  type BrandSettings,
  type BrandThemePayload,
  type EffectiveBrand,
} from '@odontocrm/contracts';
import {
  fontFaceCssFromResolved,
  readFontFileDataUri,
  type ResolvedFontFace,
} from '@odontocrm/kernel';
import type { BlobStore } from '@odontocrm/storage';
import { eq } from 'drizzle-orm';

import type { IdentityDb } from '../db/client.js';
import { brandSettings } from '../db/schema.js';
import { effectiveLogoDataUri } from '../clinic/identity-service.js';

/**
 * La **marca de los imprimibles** guardada en la base (ADR 0060).
 *
 * Una **sola fila** (`id = 1`). Mientras no exista, la marca sale del respaldo del
 * código (`BRAND`); a partir de la primera escritura, la base manda y todos los
 * imprimibles (récipe, dossier, reporte, factura…) la leen por la ruta interna
 * `/internal/v1/identity/brand`.
 *
 * El **logo** no está aquí: ya vive en `clinic_profiles` (ADR 0056) y esta marca lo
 * reutiliza a través de `effectiveLogoDataUri`.
 */

const FILA = 1;

/** Prefijo del almacén para las fuentes subidas desde el panel. */
const FONT_KEY_PREFIX = 'identity/brand/fonts';

/** La marca de fábrica (`BRAND`) en la forma del contrato editable. */
export const defaultBrandSettings = (): BrandSettings => ({
  palette: { ...BRAND.palette },
  typography: {
    documentTitleSans: BRAND.typography.documentTitleSans,
    documentBodySans: BRAND.typography.documentBodySans,
    documentTitlePt: BRAND.typography.documentTitlePt,
    documentBodyPt: BRAND.typography.documentBodyPt,
    documentSmallPt: BRAND.typography.documentSmallPt,
  },
  letterhead: { ...BRAND.letterhead },
  fonts: {
    family: BRAND.fonts.family,
    files: BRAND.fonts.files.map((file) => ({
      path: file.path,
      weight: file.weight,
      style: file.style,
      source: 'repo' as const,
      label: null,
    })),
  },
});

const readRow = async (db: IdentityDb) => {
  const rows = await db.select().from(brandSettings).where(eq(brandSettings.id, FILA)).limit(1);
  return rows[0] ?? null;
};

/**
 * La marca **efectiva** (lo guardado sobre el respaldo del código, campo a campo).
 *
 * `fromDatabase` distingue si hay fila guardada; el panel lo usa para el aviso de
 * «esta marca viene del código».
 */
export const readBrandSettings = async (
  db: IdentityDb,
): Promise<{ settings: BrandSettings; fromDatabase: boolean; updatedAt: Date | null }> => {
  const row = await readRow(db);
  const defaults = defaultBrandSettings();
  if (row === null) return { settings: defaults, fromDatabase: false, updatedAt: null };

  return {
    settings: {
      palette: row.palette ?? defaults.palette,
      typography: row.typography ?? defaults.typography,
      letterhead: row.letterhead ?? defaults.letterhead,
      fonts: row.fonts ?? defaults.fonts,
    },
    fromDatabase: true,
    updatedAt: row.updatedAt,
  };
};

/** El tema (paleta + tipografías completas + medidas) que incrustan los documentos. */
const themeOf = (settings: BrandSettings): BrandThemePayload => ({
  palette: settings.palette,
  typography: {
    // Las pilas de la **interfaz** no se editan aquí: son del tema de pantalla.
    uiSans: BRAND.typography.uiSans,
    uiMono: BRAND.typography.uiMono,
    documentTitleSans: settings.typography.documentTitleSans,
    documentBodySans: settings.typography.documentBodySans,
    documentTitlePt: settings.typography.documentTitlePt,
    documentBodyPt: settings.typography.documentBodyPt,
    documentSmallPt: settings.typography.documentSmallPt,
  },
  letterhead: settings.letterhead,
});

/** Resuelve cada fuente a su `data:` URI (del almacén las subidas, del repositorio las de respaldo). */
const resolveFaces = async (
  blobStore: BlobStore | null,
  settings: BrandSettings,
): Promise<ResolvedFontFace[]> => {
  const faces = await Promise.all(
    settings.fonts.files.map(async (file): Promise<ResolvedFontFace | null> => {
      let dataUri: string | null;
      if (file.source === 'subido') {
        if (blobStore === null) return null;
        try {
          const data = await blobStore.read(file.path);
          dataUri = `data:font/woff2;base64,${data.toString('base64')}`;
        } catch {
          return null;
        }
      } else {
        dataUri = await readFontFileDataUri(file.path);
      }
      return dataUri === null
        ? null
        : { family: settings.fonts.family, weight: file.weight, style: file.style, dataUri };
    }),
  );
  return faces.filter((face): face is ResolvedFontFace => face !== null);
};

/**
 * La marca **efectiva** que sirve la ruta interna: el tema, las `@font-face` ya
 * resueltas (cada `.woff2` como `data:` URI) y el logo incrustado. Los servicios de
 * documentos la leen y componen el papel sin saber de dónde sale.
 */
export const effectiveBrand = async (
  db: IdentityDb,
  blobStore: BlobStore | null,
): Promise<EffectiveBrand> => {
  const [{ settings, fromDatabase, updatedAt }, logoDataUri] = await Promise.all([
    readBrandSettings(db),
    effectiveLogoDataUri(db, blobStore),
  ]);
  const faces = await resolveFaces(blobStore, settings);

  return {
    theme: themeOf(settings),
    fontFaceCss: fontFaceCssFromResolved(faces),
    logoDataUri,
    version: updatedAt?.toISOString() ?? 'seed',
    fromDatabase,
  };
};

/** Guarda la marca completa (alta o reemplazo de la fila única). */
export const updateBrandSettings = async (
  db: IdentityDb,
  input: BrandSettings,
  actorId: string | null,
): Promise<void> => {
  const valores = {
    palette: input.palette,
    typography: input.typography,
    letterhead: input.letterhead,
    fonts: input.fonts,
    updatedAt: new Date(),
    updatedBy: actorId,
  };
  const existing = await readRow(db);
  if (existing === null) {
    await db.insert(brandSettings).values({ id: FILA, ...valores });
    return;
  }
  await db.update(brandSettings).set(valores).where(eq(brandSettings.id, FILA));
};

/**
 * Guarda una fuente `.woff2` subida y la añade a la marca. Devuelve la marca resultante
 * para que el panel confirme sin recargar.
 *
 * La fuente va al **almacén compartido** (el mismo del logo), así que persiste igual en
 * desarrollo y en el servidor. Se le da una clave estable por `familia-peso-estilo`.
 */
export const addBrandFont = async (
  db: IdentityDb,
  blobStore: BlobStore,
  file: { data: Buffer; originalName: string; weight: number; style: 'normal' | 'italic' },
  actorId: string | null,
): Promise<BrandSettings> => {
  const { settings } = await readBrandSettings(db);

  const safeFamily = settings.fonts.family
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const key = `${FONT_KEY_PREFIX}/${safeFamily}-${String(file.weight)}-${file.style}.woff2`;
  const { path } = await blobStore.save({ key, data: file.data });

  // Reemplaza la fuente del mismo peso y estilo (subirla otra vez la actualiza, no duplica).
  const restantes = settings.fonts.files.filter(
    (font) => !(font.weight === file.weight && font.style === file.style),
  );
  const fonts = {
    family: settings.fonts.family,
    files: [
      ...restantes,
      {
        path,
        weight: file.weight,
        style: file.style,
        source: 'subido' as const,
        label: file.originalName,
      },
    ],
  };

  await updateBrandSettings(db, { ...settings, fonts }, actorId);
  return { ...settings, fonts };
};

/**
 * Quita una fuente **subida** de la marca y borra su archivo del almacén. Las fuentes
 * de **respaldo** (las del repositorio) no se pueden quitar: si no, una marca sin
 * fuentes subidas se quedaría sin tipografía.
 */
export const removeBrandFont = async (
  db: IdentityDb,
  blobStore: BlobStore | null,
  path: string,
  actorId: string | null,
): Promise<BrandSettings> => {
  const { settings } = await readBrandSettings(db);
  const objetivo = settings.fonts.files.find((font) => font.path === path);
  if (objetivo === undefined) return settings;

  const fonts = {
    family: settings.fonts.family,
    files: settings.fonts.files.filter((font) => font.path !== path),
  };
  await updateBrandSettings(db, { ...settings, fonts }, actorId);

  if (objetivo.source === 'subido' && blobStore !== null) {
    await blobStore.remove(path).catch(() => undefined);
  }
  return { ...settings, fonts };
};

/** Valida que un objeto sea una marca bien formada (lo usa la ruta antes de guardar). */
export const parseBrandSettings = (value: unknown): BrandSettings =>
  brandSettingsSchema.parse(value);
