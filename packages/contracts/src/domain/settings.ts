import { z } from 'zod';

/**
 * **Configuración de la aplicación** desde el panel de administración (ADR 0060).
 *
 * Reúne en un solo contrato las cosas que hasta ahora vivían repartidas: la
 * **marca de los imprimibles** (`brand.ts`, solo-código), el **acento de la
 * interfaz** (`tokens.css`, solo-código), los **textos del kiosko** (`i18n.ts`) y
 * los **canales de mensajería** (el `.env` del servidor). El servicio de identidad
 * las guarda en la base y las sirve —la SPA y los documentos— en runtime.
 *
 * **Qué NO entra aquí.**
 *  - Los **datos del consultorio** (nombre, RIF, odontólogos): ya tienen su contrato
 *    y su editor (`clinic-profile.ts`, ADR 0056).
 *  - Los **colores clínicos** del odontograma (rojo/azul): son un código del dominio
 *    (`CLINICAL_STATE_COLORS`), no una preferencia de marca.
 *  - La **política de cancelación** (`notification_settings`): vive en notifications
 *    porque la usa el bot; el panel la edita por su API.
 */

/* ══════════════════════════════════════════════════════════════════════════════
   Marca de los imprimibles
   ══════════════════════════════════════════════════════════════════════════════ */

/** Color en notación `#rrggbb` (seis dígitos hexadecimales). */
export const HEX_COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;

export const hexColorSchema = z
  .string()
  .trim()
  .regex(HEX_COLOR_PATTERN, 'Usa un color en formato #rrggbb (seis dígitos hexadecimales)');

/**
 * La paleta del papel: los trece colores de `BrandPalette`, editables por hex libre.
 *
 * Se editan **en crudo** (no por presets) porque el papel se imprime sobre blanco y
 * el consultorio decide su identidad; la interfaz solo avisa —no impide— si un par
 * queda con poco contraste.
 */
export const brandPaletteSchema = z.object({
  primary: hexColorSchema,
  primaryInk: hexColorSchema,
  accent: hexColorSchema,
  ink: hexColorSchema,
  inkStrong: hexColorSchema,
  inkMuted: hexColorSchema,
  inkSubtle: hexColorSchema,
  line: hexColorSchema,
  lineSoft: hexColorSchema,
  tableHeadBg: hexColorSchema,
  good: hexColorSchema,
  warn: hexColorSchema,
  bad: hexColorSchema,
});

export type BrandPaletteSettings = z.infer<typeof brandPaletteSchema>;

/** Las dos tipografías de los documentos y sus tamaños (pt). */
export const brandTypographyInputSchema = z.object({
  /** Pila de los **títulos** (el nombre del consultorio, «RÉCIPE», encabezados). */
  documentTitleSans: z.string().trim().min(1).max(300),
  /** Pila del **cuerpo** (párrafos, tablas, notas). */
  documentBodySans: z.string().trim().min(1).max(300),
  documentTitlePt: z.number().min(6).max(24),
  documentBodyPt: z.number().min(6).max(18),
  documentSmallPt: z.number().min(5).max(14),
});

export type BrandTypographyInput = z.infer<typeof brandTypographyInputSchema>;

/** Medidas del membrete y de la marca de agua (mm y opacidad). */
export const brandLetterheadSchema = z.object({
  logoHeightMm: z.number().min(6).max(60),
  watermarkWidthMm: z.number().min(20).max(200),
  watermarkOpacity: z.number().min(0).max(0.6),
});

export type BrandLetterheadSettings = z.infer<typeof brandLetterheadSchema>;

/**
 * Una fuente declarada en la marca. Las **subidas** desde el panel viven en el
 * almacén (`source: 'subido'`); las de **respaldo** son las del repositorio
 * (`assets/clinic/fonts/…`, `source: 'repo'`), que siguen existiendo para que una
 * instalación recién puesta tenga tipografía sin subir nada.
 */
export const brandFontFileSchema = z.object({
  /** Ruta relativa al almacén (subida) o a la raíz del repositorio (de respaldo). */
  path: z.string().trim().min(1).max(400),
  weight: z.number().int().min(100).max(900),
  style: z.enum(['normal', 'italic']),
  source: z.enum(['repo', 'subido']).default('repo'),
  /** Nombre original del archivo subido, para listarlo en el panel. */
  label: z.string().trim().max(160).nullable().default(null),
});

export type BrandFontFileSettings = z.infer<typeof brandFontFileSchema>;

export const brandFontsSchema = z.object({
  /** Nombre de familia que declara el `@font-face` y abre las dos pilas. */
  family: z.string().trim().min(1).max(60),
  files: z.array(brandFontFileSchema).max(12),
});

export type BrandFontsSettings = z.infer<typeof brandFontsSchema>;

/**
 * La marca como la guarda y la sirve el panel: paleta, tipografías, medidas y
 * fuentes. El logo **no** está aquí: ya se sube desde Mi perfil / `/usuarios`
 * (`clinic_profiles.logo_blob_key`) y el panel lo reutiliza, no lo duplica.
 */
export const brandSettingsSchema = z.object({
  palette: brandPaletteSchema,
  typography: brandTypographyInputSchema,
  letterhead: brandLetterheadSchema,
  fonts: brandFontsSchema,
});

export type BrandSettings = z.infer<typeof brandSettingsSchema>;

/** Editar la marca (solo admin). */
export const brandSettingsInputSchema = brandSettingsSchema;

export type BrandSettingsInput = z.infer<typeof brandSettingsInputSchema>;

/* ══════════════════════════════════════════════════════════════════════════════
   Acento de la interfaz (10 presets del espectro)
   ══════════════════════════════════════════════════════════════════════════════ */

/** Los cinco tokens del cromo que mueve un acento, en un modo (claro u oscuro). */
export interface UIPalette {
  primary: string;
  primaryHover: string;
  primaryInk: string;
  accent: string;
  focus: string;
}

export interface UIAccent {
  label: string;
  light: UIPalette;
  dark: UIPalette;
}

/**
 * Los **diez acentos** de la interfaz, en orden de espectro (azul → verde, pasando
 * por índigo, violeta, fucsia, rosa, rojo, vino, naranja y ámbar). Solo afectan al
 * **cromo** de la pantalla: los imprimibles tienen su propia paleta y los colores
 * clínicos del odontograma (rojo/azul) no se tocan.
 */
export const UI_ACCENT_IDS = [
  'teal',
  'azul',
  'indigo',
  'violeta',
  'fucsia',
  'rosa',
  'rojo',
  'vino',
  'naranja',
  'verde',
] as const;

export type UIAccentId = (typeof UI_ACCENT_IDS)[number];

export const UI_ACCENTS: Readonly<Record<UIAccentId, UIAccent>> = {
  teal: {
    label: 'Verde azulado',
    light: {
      primary: '#0e7490',
      primaryHover: '#155e75',
      primaryInk: '#ffffff',
      accent: '#0d9488',
      focus: '#0891b2',
    },
    dark: {
      primary: '#2aa7c9',
      primaryHover: '#46bcd9',
      primaryInk: '#04222c',
      accent: '#2dd4bf',
      focus: '#38bdf8',
    },
  },
  azul: {
    label: 'Azul',
    light: {
      primary: '#1d4ed8',
      primaryHover: '#1e40af',
      primaryInk: '#ffffff',
      accent: '#2563eb',
      focus: '#3b82f6',
    },
    dark: {
      primary: '#60a5fa',
      primaryHover: '#93c5fd',
      primaryInk: '#06122b',
      accent: '#3b82f6',
      focus: '#93c5fd',
    },
  },
  indigo: {
    label: 'Índigo',
    light: {
      primary: '#4338ca',
      primaryHover: '#3730a3',
      primaryInk: '#ffffff',
      accent: '#4f46e5',
      focus: '#6366f1',
    },
    dark: {
      primary: '#818cf8',
      primaryHover: '#a5b4fc',
      primaryInk: '#100a2e',
      accent: '#6366f1',
      focus: '#a5b4fc',
    },
  },
  violeta: {
    label: 'Violeta',
    light: {
      primary: '#7c3aed',
      primaryHover: '#6d28d9',
      primaryInk: '#ffffff',
      accent: '#8b5cf6',
      focus: '#a78bfa',
    },
    dark: {
      primary: '#a78bfa',
      primaryHover: '#c4b5fd',
      primaryInk: '#1b0a3a',
      accent: '#8b5cf6',
      focus: '#c4b5fd',
    },
  },
  fucsia: {
    label: 'Fucsia',
    light: {
      primary: '#c026d3',
      primaryHover: '#a21caf',
      primaryInk: '#ffffff',
      accent: '#d946ef',
      focus: '#e879f9',
    },
    dark: {
      primary: '#e879f9',
      primaryHover: '#f0abfc',
      primaryInk: '#2b0726',
      accent: '#d946ef',
      focus: '#f5d0fe',
    },
  },
  rosa: {
    label: 'Rosa',
    light: {
      primary: '#e11d48',
      primaryHover: '#be123c',
      primaryInk: '#ffffff',
      accent: '#f43f5e',
      focus: '#fb7185',
    },
    dark: {
      primary: '#fb7185',
      primaryHover: '#fda4af',
      primaryInk: '#33040f',
      accent: '#f43f5e',
      focus: '#fecdd3',
    },
  },
  rojo: {
    label: 'Rojo',
    light: {
      primary: '#dc2626',
      primaryHover: '#b91c1c',
      primaryInk: '#ffffff',
      accent: '#ef4444',
      focus: '#f87171',
    },
    dark: {
      primary: '#f87171',
      primaryHover: '#fca5a5',
      primaryInk: '#350505',
      accent: '#ef4444',
      focus: '#fecaca',
    },
  },
  vino: {
    label: 'Rojo oscuro',
    light: {
      primary: '#7f1d1d',
      primaryHover: '#991b1b',
      primaryInk: '#fdecec',
      accent: '#991b1b',
      focus: '#b91c1c',
    },
    dark: {
      primary: '#b91c1c',
      primaryHover: '#dc2626',
      primaryInk: '#fdecec',
      accent: '#dc2626',
      focus: '#f87171',
    },
  },
  naranja: {
    label: 'Naranja',
    light: {
      primary: '#c2410c',
      primaryHover: '#9a3412',
      primaryInk: '#ffffff',
      accent: '#ea580c',
      focus: '#f97316',
    },
    dark: {
      primary: '#fb923c',
      primaryHover: '#fdba74',
      primaryInk: '#2c1005',
      accent: '#f97316',
      focus: '#fdba74',
    },
  },
  verde: {
    label: 'Verde',
    light: {
      primary: '#15803d',
      primaryHover: '#166534',
      primaryInk: '#ffffff',
      accent: '#16a34a',
      focus: '#22c55e',
    },
    dark: {
      primary: '#4ade80',
      primaryHover: '#86efac',
      primaryInk: '#04240f',
      accent: '#22c55e',
      focus: '#86efac',
    },
  },
};

/** El acento por defecto: el verde-teal que ya traía el sistema. */
export const DEFAULT_UI_ACCENT: UIAccentId = 'teal';

/**
 * CSS que fija los tokens de acento (`--color-*`) del tema claro y oscuro.
 *
 * Lo inyecta la SPA en un `<style>` y **gana** sobre `tokens.css` por orden de
 * cascada (misma especificidad, declarado después). Los nombres son los de
 * `@theme` de Tailwind, así que las utilidades (`bg-primary`, `text-primary`…)
 * lo siguen sin tocar ningún componente.
 */
export const uiAccentCss = (accent: UIAccent): string =>
  [
    ':root {',
    `  --color-primary: ${accent.light.primary};`,
    `  --color-primary-hover: ${accent.light.primaryHover};`,
    `  --color-primary-ink: ${accent.light.primaryInk};`,
    `  --color-accent: ${accent.light.accent};`,
    `  --color-focus: ${accent.light.focus};`,
    '}',
    '.dark {',
    `  --color-primary: ${accent.dark.primary};`,
    `  --color-primary-hover: ${accent.dark.primaryHover};`,
    `  --color-primary-ink: ${accent.dark.primaryInk};`,
    `  --color-accent: ${accent.dark.accent};`,
    `  --color-focus: ${accent.dark.focus};`,
    '}',
  ].join('\n');

/* ══════════════════════════════════════════════════════════════════════════════
   Textos del kiosko (conjunto curado)
   ══════════════════════════════════════════════════════════════════════════════ */

/** Una clave de texto del kiosko que el consultorio puede reescribir. */
export interface ScreenTextDefinition {
  key: ScreenTextKey;
  label: string;
  /** Marcadores `{…}` que la plantilla interpola (para el editor). */
  placeholders: readonly string[];
}

/**
 * El **conjunto curado** de textos del kiosko que se pueden personalizar. No es
 * todo el diccionario —eso sería un editor de i18n y una forma estupenda de romper
 * la interfaz—: son los rótulos que un consultorio cambia de verdad («Pase a…»,
 * «Turno…», el título de la sala). Lo que no esté aquí sigue en `i18n.ts`.
 */
export const SCREEN_TEXT_KEYS = [
  'pantalla.lobby.titulo',
  'pantalla.lobby.pasar',
  'pantalla.lobby.turno',
  'pantalla.lobby.segundoLlamado',
  'pantalla.lobby.enSala',
  'pantalla.sala.count',
  'pantalla.consultorio.titulo',
  'pantalla.consultorio.libre',
  'pantalla.consultorio.llamado',
  'pantalla.consultorio.enConsulta',
] as const;

export type ScreenTextKey = (typeof SCREEN_TEXT_KEYS)[number];

/** Rótulos y marcadores de cada texto, para que el panel los presente. */
export const SCREEN_TEXT_DEFINITIONS: readonly ScreenTextDefinition[] = [
  { key: 'pantalla.lobby.titulo', label: 'Título de la sala de espera', placeholders: [] },
  { key: 'pantalla.lobby.pasar', label: 'Aviso de pasar al consultorio', placeholders: ['sillon'] },
  { key: 'pantalla.lobby.turno', label: 'Rótulo del turno', placeholders: ['turno'] },
  { key: 'pantalla.lobby.segundoLlamado', label: 'Aviso de segundo llamado', placeholders: [] },
  { key: 'pantalla.lobby.enSala', label: 'Pacientes en sala (lobby)', placeholders: ['total'] },
  { key: 'pantalla.sala.count', label: 'Pacientes en sala (contador)', placeholders: ['total'] },
  { key: 'pantalla.consultorio.titulo', label: 'Título del consultorio', placeholders: [] },
  { key: 'pantalla.consultorio.libre', label: 'Consultorio libre', placeholders: [] },
  { key: 'pantalla.consultorio.llamado', label: 'Consultorio: llamado', placeholders: [] },
  { key: 'pantalla.consultorio.enConsulta', label: 'Consultorio: en consulta', placeholders: [] },
];

/**
 * Los textos **personalizados** del kiosko. Todos son opcionales: lo que falte sale
 * del diccionario (`i18n.ts`), así que guardar un texto vacío es «volver al de
 * fábrica» y nunca deja un rótulo en blanco.
 */
export const screenTextsSchema = z.object({
  'pantalla.lobby.titulo': z.string().trim().min(1).max(200).optional(),
  'pantalla.lobby.pasar': z.string().trim().min(1).max(200).optional(),
  'pantalla.lobby.turno': z.string().trim().min(1).max(200).optional(),
  'pantalla.lobby.segundoLlamado': z.string().trim().min(1).max(200).optional(),
  'pantalla.lobby.enSala': z.string().trim().min(1).max(200).optional(),
  'pantalla.sala.count': z.string().trim().min(1).max(200).optional(),
  'pantalla.consultorio.titulo': z.string().trim().min(1).max(200).optional(),
  'pantalla.consultorio.libre': z.string().trim().min(1).max(200).optional(),
  'pantalla.consultorio.llamado': z.string().trim().min(1).max(200).optional(),
  'pantalla.consultorio.enConsulta': z.string().trim().min(1).max(200).optional(),
});

export type ScreenTexts = z.infer<typeof screenTextsSchema>;

/**
 * Resuelve un texto del kiosko: lo personalizado si está, y si no el de fábrica.
 * Es puro y lo usan la SPA (página kiosko) y quien precarga el estado.
 */
export const resolveScreenText = (
  key: ScreenTextKey,
  texts: ScreenTexts | null | undefined,
  fallback: string,
): string => {
  const custom = texts?.[key];
  return custom === undefined || custom.trim() === '' ? fallback : custom;
};

/* ══════════════════════════════════════════════════════════════════════════════
   Canales de mensajería (Telegram y WhatsApp)
   ══════════════════════════════════════════════════════════════════════════════ */

/** Base por defecto de la Graph API de Meta cuando el consultorio no la fija. */
export const DEFAULT_WHATSAPP_API_BASE = 'https://graph.facebook.com/v21.0';

/**
 * Credenciales y datos de los canales. Los **secretos** viajan hacia el servidor
 * (nunca de vuelta tal cual: la vista los enmascara) y se guardan **cifrados** en la
 * base con la clave del almacén (`STORAGE_ENCRYPTION_KEY`).
 *
 * Semántica de entrada: `undefined` = no tocar lo guardado; `''` = borrar; un valor
 * = fijarlo. Así el panel puede cambiar solo el teléfono de WhatsApp sin reescribir
 * el token.
 */
export const channelSettingsInputSchema = z.object({
  telegramBotToken: z.string().trim().max(200).optional(),
  telegramBotUsername: z.string().trim().max(80).optional(),
  adminTelegramBotToken: z.string().trim().max(200).optional(),
  adminTelegramChatId: z.string().trim().max(80).optional(),
  whatsappToken: z.string().trim().max(1000).optional(),
  whatsappPhoneId: z.string().trim().max(60).optional(),
  whatsappVerifyToken: z.string().trim().max(200).optional(),
  whatsappAppSecret: z.string().trim().max(200).optional(),
  whatsappApiBase: z.string().trim().url('Debe ser una URL completa').max(200).optional(),
});

export type ChannelSettingsInput = z.infer<typeof channelSettingsInputSchema>;

/** Un secreto tal como se puede **mostrar**: existe o no, y una pista de sus últimos caracteres. */
export const channelSecretViewSchema = z.object({
  configured: z.boolean(),
  /** Últimos cuatro caracteres para reconocerlo (p. ej. «…a1b2»); nunca el valor entero. */
  preview: z.string().nullable(),
});

export type ChannelSecretView = z.infer<typeof channelSecretViewSchema>;

/** La vista pública de los canales: datos no secretos en claro, secretos enmascarados. */
export const channelSettingsViewSchema = z.object({
  telegramBotUsername: z.string().nullable(),
  adminTelegramChatId: z.string().nullable(),
  whatsappPhoneId: z.string().nullable(),
  whatsappApiBase: z.string(),
  telegramBotToken: channelSecretViewSchema,
  adminTelegramBotToken: channelSecretViewSchema,
  whatsappToken: channelSecretViewSchema,
  whatsappVerifyToken: channelSecretViewSchema,
  whatsappAppSecret: channelSecretViewSchema,
  /** `true` si los secretos están cifrados en reposo (hay clave de almacén). */
  encrypted: z.boolean(),
  updatedAt: z.string().nullable(),
  updatedByUserId: z.uuid().nullable(),
});

export type ChannelSettingsView = z.infer<typeof channelSettingsViewSchema>;

/**
 * Las credenciales **en claro**, ya resueltas, que consume el servicio de
 * notificaciones por la ruta interna para construir sus adaptadores. Nunca salen
 * por una ruta pública.
 */
export const channelCredentialsSchema = z.object({
  telegramBotToken: z.string().nullable(),
  telegramBotUsername: z.string().nullable(),
  adminTelegramBotToken: z.string().nullable(),
  adminTelegramChatId: z.string().nullable(),
  whatsappToken: z.string().nullable(),
  whatsappPhoneId: z.string().nullable(),
  whatsappVerifyToken: z.string().nullable(),
  whatsappAppSecret: z.string().nullable(),
  whatsappApiBase: z.string(),
});

export type ChannelCredentials = z.infer<typeof channelCredentialsSchema>;

/** Petición de prueba de un canal desde el panel (solo Telegram: manda un mensaje de diagnóstico). */
export const channelTestInputSchema = z.object({
  canal: z.enum(['telegram', 'admin', 'whatsapp']),
  /** Dirección de destino para la prueba (chat de Telegram o número de WhatsApp). */
  destino: z.string().trim().min(1).max(80).optional(),
});

export type ChannelTestInput = z.infer<typeof channelTestInputSchema>;

export const channelTestResultSchema = z.object({
  ok: z.boolean(),
  detalle: z.string(),
});

export type ChannelTestResult = z.infer<typeof channelTestResultSchema>;

/* ══════════════════════════════════════════════════════════════════════════════
   Vista agregada y marca efectiva
   ══════════════════════════════════════════════════════════════════════════════ */

/** El tema efectivo que los documentos incrustan: paleta, tipografías y medidas. */
export const brandThemePayloadSchema = z.object({
  palette: brandPaletteSchema,
  typography: z.object({
    uiSans: z.string().min(1),
    uiMono: z.string().min(1),
    documentTitleSans: z.string().min(1),
    documentBodySans: z.string().min(1),
    documentTitlePt: z.number(),
    documentBodyPt: z.number(),
    documentSmallPt: z.number(),
  }),
  letterhead: brandLetterheadSchema,
});

export type BrandThemePayload = z.infer<typeof brandThemePayloadSchema>;

/**
 * La **marca efectiva** que sirve identity por su ruta interna: el tema, el
 * `@font-face` ya resuelto (cada `.woff2` como `data:` URI) y el logo incrustado.
 * Los servicios de documentos la leen y componen el papel sin saber de dónde sale.
 */
export const effectiveBrandSchema = z.object({
  theme: brandThemePayloadSchema,
  /** Reglas `@font-face` con las fuentes incrustadas (cadena vacía si no hay ninguna). */
  fontFaceCss: z.string(),
  logoDataUri: z.string().nullable(),
  /** Cambia cuando la marca cambia, para invalidar cachés. */
  version: z.string(),
  /** `false` mientras la marca salga del respaldo del código (`BRAND`). */
  fromDatabase: z.boolean(),
});

export type EffectiveBrand = z.infer<typeof effectiveBrandSchema>;

/** Editar la configuración de la aplicación (acento y textos del kiosko), solo admin. */
export const appSettingsInputSchema = z.object({
  accent: z.enum(UI_ACCENT_IDS).nullable(),
  screenTexts: screenTextsSchema,
});

export type AppSettingsInput = z.infer<typeof appSettingsInputSchema>;

/** Valores de fábrica que el panel muestra como referencia («restaurar por defecto»). */
export const settingsDefaultsSchema = z.object({
  brand: brandSettingsSchema,
  accent: z.enum(UI_ACCENT_IDS),
});

export type SettingsDefaults = z.infer<typeof settingsDefaultsSchema>;

/**
 * La configuración completa que lee la SPA al arrancar (`GET /api/v1/settings`):
 * la marca **efectiva**, el acento resuelto, los textos del kiosko y los canales.
 * Los secretos nunca viajan aquí.
 */
export const appSettingsViewSchema = z.object({
  brand: brandSettingsSchema,
  brandFromDatabase: z.boolean(),
  /**
   * El bloque `:root { --brand-* }` **más** las `@font-face` ya resueltas por identity.
   * La SPA lo inyecta tal cual: así la pantalla y el papel salen del MISMO CSS y no hay
   * dos verdades sobre la marca.
   */
  themeCss: z.string(),
  /** Acento guardado, o `null` si nunca se cambió. */
  accent: z.enum(UI_ACCENT_IDS).nullable(),
  /** Acento que se está aplicando (el guardado o el de por defecto). */
  accentEffective: z.enum(UI_ACCENT_IDS),
  screenTexts: screenTextsSchema,
  channels: channelSettingsViewSchema,
  defaults: settingsDefaultsSchema,
});

export type AppSettingsView = z.infer<typeof appSettingsViewSchema>;
