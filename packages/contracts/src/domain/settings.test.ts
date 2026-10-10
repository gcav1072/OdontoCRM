import { describe, expect, it } from 'vitest';

import {
  DEFAULT_UI_ACCENT,
  HEX_COLOR_PATTERN,
  SCREEN_TEXT_DEFINITIONS,
  SCREEN_TEXT_KEYS,
  UI_ACCENTS,
  UI_ACCENT_IDS,
  brandSettingsSchema,
  channelSettingsInputSchema,
  hexColorSchema,
  resolveScreenText,
  screenTextsSchema,
  uiAccentCss,
} from './settings.js';

describe('acento de la interfaz', () => {
  it('declara diez acentos con etiqueta y colores completos', () => {
    expect(UI_ACCENT_IDS).toHaveLength(10);
    for (const id of UI_ACCENT_IDS) {
      const accent = UI_ACCENTS[id];
      expect(accent.label.trim().length, `${id} sin etiqueta`).toBeGreaterThan(0);
      for (const modo of [accent.light, accent.dark]) {
        for (const color of Object.values(modo)) {
          expect(HEX_COLOR_PATTERN.test(color), `${id}: ${color} no es hex`).toBe(true);
        }
      }
    }
  });

  it('el acento por defecto existe', () => {
    expect(UI_ACCENT_IDS).toContain(DEFAULT_UI_ACCENT);
  });

  it('el CSS fija los tokens del cromo en claro y en oscuro', () => {
    const css = uiAccentCss(UI_ACCENTS[DEFAULT_UI_ACCENT]);
    expect(css).toContain(':root {');
    expect(css).toContain('.dark {');
    expect(css).toContain(`--color-primary: ${UI_ACCENTS[DEFAULT_UI_ACCENT].light.primary};`);
    expect(css).toContain(`--color-primary: ${UI_ACCENTS[DEFAULT_UI_ACCENT].dark.primary};`);
    // No toca los colores clínicos del odontograma (no hay ninguna variable de marca aquí).
    expect(css).not.toContain('--brand-');
  });
});

describe('textos del kiosko', () => {
  it('cada clave tiene su definición y viceversa', () => {
    const claves = SCREEN_TEXT_DEFINITIONS.map((definicion) => definicion.key);
    expect([...claves].sort()).toEqual([...SCREEN_TEXT_KEYS].sort());
  });

  it('el esquema solo admite las claves curadas', () => {
    const resultado = screenTextsSchema.safeParse({
      'pantalla.lobby.titulo': 'Bienvenidos',
      'clave.inventada': 'no',
    });
    // Las claves desconocidas se descartan (el objeto no es estricto), pero el valor
    // válido se conserva.
    expect(resultado.success).toBe(true);
    if (resultado.success) {
      expect(resultado.data['pantalla.lobby.titulo']).toBe('Bienvenidos');
      expect(resultado.data).not.toHaveProperty('clave.inventada');
    }
  });

  it('resuelve el personalizado si está y el de fábrica si no (o si está vacío)', () => {
    const textos = { 'pantalla.lobby.titulo': 'Recepción' };
    expect(resolveScreenText('pantalla.lobby.titulo', textos, 'Sala de espera')).toBe('Recepción');
    expect(resolveScreenText('pantalla.lobby.pasar', textos, 'Pase a {sillon}')).toBe(
      'Pase a {sillon}',
    );
    expect(
      resolveScreenText('pantalla.lobby.titulo', { 'pantalla.lobby.titulo': '   ' }, 'Sala'),
    ).toBe('Sala');
  });
});

describe('validación de la configuración', () => {
  it('el color tiene que ser #rrggbb', () => {
    expect(hexColorSchema.safeParse('#14504d').success).toBe(true);
    expect(hexColorSchema.safeParse('14504d').success).toBe(false);
    expect(hexColorSchema.safeParse('#14504').success).toBe(false);
    expect(hexColorSchema.safeParse('#14504dff').success).toBe(false);
  });

  it('la marca exige la paleta de trece colores y las medidas en rango', () => {
    const valida = brandSettingsSchema.safeParse({
      palette: {
        primary: '#14504d',
        primaryInk: '#ffffff',
        accent: '#1f6f6b',
        ink: '#17202a',
        inkStrong: '#46535f',
        inkMuted: '#4a5560',
        inkSubtle: '#6b7680',
        line: '#cfdedd',
        lineSoft: '#e3e9ea',
        tableHeadBg: '#eef5f4',
        good: '#14663f',
        warn: '#8a5a00',
        bad: '#97231f',
      },
      typography: {
        documentTitleSans: "'Montserrat', sans-serif",
        documentBodySans: "'Montserrat', sans-serif",
        documentTitlePt: 13,
        documentBodyPt: 9,
        documentSmallPt: 7.5,
      },
      letterhead: { logoHeightMm: 18, watermarkWidthMm: 90, watermarkOpacity: 0.1 },
      fonts: { family: 'Montserrat', files: [] },
    });
    expect(valida.success).toBe(true);
    if (valida.success) {
      expect(valida.data.palette.primary).toBe('#14504d');
    }
  });

  it('la entrada de canales es opcional: un campo ausente no se toca', () => {
    const resultado = channelSettingsInputSchema.safeParse({ telegramBotUsername: 'bot' });
    expect(resultado.success).toBe(true);
    if (resultado.success) {
      expect(resultado.data.telegramBotUsername).toBe('bot');
      expect(resultado.data.telegramBotToken).toBeUndefined();
    }
    expect(channelSettingsInputSchema.safeParse({ whatsappApiBase: 'no-es-url' }).success).toBe(
      false,
    );
  });
});
