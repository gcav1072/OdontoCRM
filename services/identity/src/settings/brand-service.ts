import {
  BRAND,
  brandSettingsSchema,
  type BrandFontFileSettings,
  type BrandFontsSettings,
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
    documentTitleWeight: BRAND.typography.documentTitleWeight,
    documentBodyWeight: BRAND.typography.documentBodyWeight,
    documentTitlePt: BRAND.typography.documentTitlePt,
    documentBodyPt: BRAND.typography.documentBodyPt,
    documentSmallPt: BRAND.typography.documentSmallPt,
  },
  letterhead: { ...BRAND.letterhead },
  fonts: {
    families: BRAND.fonts.families.map((familia) => ({
      name: familia.name,
      files: familia.files.map((file) => ({
        path: file.path,
        weight: file.weight,
        style: file.style,
        source: 'repo' as const,
        label: null,
      })),
    })),
  },
});

/**
 * Normaliza lo guardado en `fonts` a la forma de **familias**. Las filas anteriores a
 * la selección por familia guardaban `{ family, files }` (una sola familia); se
 * envuelven en `families: [{ name, files }]` para no perderlas. Devuelve `null` si la
 * forma no se reconoce (el llamador usa el respaldo del código).
 */
const normalizarFuentes = (fonts: unknown): BrandFontsSettings | null => {
  if (fonts === null || typeof fonts !== 'object') return null;
  const guardado = fonts as { families?: unknown; family?: unknown; files?: unknown };
  if (Array.isArray(guardado.families)) {
    return { families: guardado.families as BrandFontsSettings['families'] };
  }
  if (typeof guardado.family === 'string' && Array.isArray(guardado.files)) {
    return {
      families: [
        {
          name: guardado.family,
          files: guardado.files as BrandFontsSettings['families'][number]['files'],
        },
      ],
    };
  }
  return null;
};

/** El nombre de la familia que abre una pila (`'Montserrat', …` → `Montserrat`). */
const familiaDeLaPila = (pila: string): string =>
  (pila.split(',')[0] ?? '').trim().replace(/^['"]|['"]$/g, '');

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
      // La fila antigua pudo guardarse sin los pesos por rol: se rellenan con el respaldo.
      typography: { ...defaults.typography, ...(row.typography ?? {}) },
      letterhead: row.letterhead ?? defaults.letterhead,
      fonts: normalizarFuentes(row.fonts) ?? defaults.fonts,
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
    documentTitleWeight: settings.typography.documentTitleWeight,
    documentBodyWeight: settings.typography.documentBodyWeight,
    documentTitlePt: settings.typography.documentTitlePt,
    documentBodyPt: settings.typography.documentBodyPt,
    documentSmallPt: settings.typography.documentSmallPt,
  },
  letterhead: settings.letterhead,
});

/**
 * Resuelve a su `data:` URI los archivos de las familias **referenciadas** por las
 * pilas de título y cuerpo (las que de verdad usa el papel). El resto del catálogo no
 * se incrusta: mantiene pequeño el `themeCss` que sirve el panel. Del almacén salen las
 * subidas y del repositorio las de respaldo.
 */
const resolveFaces = async (
  blobStore: BlobStore | null,
  settings: BrandSettings,
): Promise<ResolvedFontFace[]> => {
  const referenciadas = new Set([
    familiaDeLaPila(settings.typography.documentTitleSans),
    familiaDeLaPila(settings.typography.documentBodySans),
  ]);

  const faces = await Promise.all(
    settings.fonts.families
      .filter((familia) => referenciadas.has(familia.name))
      .flatMap((familia) =>
        familia.files.map(async (file): Promise<ResolvedFontFace | null> => {
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
            : { family: familia.name, weight: file.weight, style: file.style, dataUri };
        }),
      ),
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
 * Guarda una fuente `.woff2` subida y la añade a la **familia** indicada. Devuelve la
 * marca resultante para que el panel confirme sin recargar.
 *
 * La fuente va al **almacén compartido** (el mismo del logo), así que persiste igual en
 * desarrollo y en el servidor. Se le da una clave estable por `familia-peso-estilo`, así
 * que subir el mismo peso/estilo de la misma familia la reemplaza, no la duplica.
 */
export const addBrandFont = async (
  db: IdentityDb,
  blobStore: BlobStore,
  file: { data: Buffer; originalName: string; weight: number; style: 'normal' | 'italic' },
  family: string,
  actorId: string | null,
): Promise<BrandSettings> => {
  const { settings } = await readBrandSettings(db);

  const safeFamily = family
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const key = `${FONT_KEY_PREFIX}/${safeFamily}-${String(file.weight)}-${file.style}.woff2`;
  const { path } = await blobStore.save({ key, data: file.data });

  const nueva: BrandFontFileSettings = {
    path,
    weight: file.weight,
    style: file.style,
    source: 'subido' as const,
    label: file.originalName,
  };

  const existente = settings.fonts.families.find((familia) => familia.name === family);
  const families =
    existente === undefined
      ? [...settings.fonts.families, { name: family, files: [nueva] }]
      : settings.fonts.families.map((familia) =>
          familia.name === family
            ? {
                ...familia,
                // Reemplaza la fuente del mismo peso y estilo (subirla otra vez la actualiza).
                files: [
                  ...familia.files.filter(
                    (font) => !(font.weight === file.weight && font.style === file.style),
                  ),
                  nueva,
                ],
              }
            : familia,
        );

  const fonts = { families };
  await updateBrandSettings(db, { ...settings, fonts }, actorId);
  return { ...settings, fonts };
};

/**
 * Quita una fuente **subida** de la marca y borra su archivo del almacén. Las fuentes
 * de **respaldo** (las del repositorio) no se pueden quitar: si no, una marca sin
 * fuentes subidas se quedaría sin tipografía. Una familia que se quede **sin archivos**
 * se descarta (era una subida completa).
 */
export const removeBrandFont = async (
  db: IdentityDb,
  blobStore: BlobStore | null,
  path: string,
  actorId: string | null,
): Promise<BrandSettings> => {
  const { settings } = await readBrandSettings(db);
  let objetivo: BrandFontFileSettings | undefined;

  const families = settings.fonts.families
    .map((familia) => {
      const encontrado = familia.files.find((font) => font.path === path);
      if (encontrado !== undefined) objetivo = encontrado;
      return { ...familia, files: familia.files.filter((font) => font.path !== path) };
    })
    .filter((familia) => familia.files.length > 0);

  if (objetivo === undefined) return settings;

  const fonts = { families };
  await updateBrandSettings(db, { ...settings, fonts }, actorId);

  if (objetivo.source === 'subido' && blobStore !== null) {
    await blobStore.remove(path).catch(() => undefined);
  }
  return { ...settings, fonts };
};

/** Valida que un objeto sea una marca bien formada (lo usa la ruta antes de guardar). */
export const parseBrandSettings = (value: unknown): BrandSettings =>
  brandSettingsSchema.parse(value);
