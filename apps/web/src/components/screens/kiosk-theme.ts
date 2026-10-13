import { UI_ACCENTS, type ScreenSettings, type ScreenTheme } from '@odontocrm/contracts';
import { useMemo, type CSSProperties } from 'react';

/**
 * Estética **propia** de las pantallas kiosko.
 *
 * La pantalla es un televisor, no una aplicación: su modo (claro/oscuro) y su color de
 * acento se configuran **por pantalla** y no siguen a los de la aplicación. Aquí se
 * traducen esos ajustes a un puñado de variables CSS (`--kiosk-*`) que el contenedor raíz
 * de la pantalla pone como estilo en línea; los componentes del kiosko las consumen con
 * utilidades de Tailwind (`bg-[var(--kiosk-surface)]`…), así que cambiar el tema es
 * inmediato y no depende de la clase `dark` del `<html>` (que es de la app).
 */

/** Variables CSS del kiosko: se aceptan las `--kiosk-*` además de las del DOM. */
export type KioskCssVars = CSSProperties & Record<`--kiosk-${string}`, string>;

export interface KioskTheme {
  /** Modo resuelto de la pantalla (nunca depende de la app). */
  tema: ScreenTheme;
  /** Variables CSS que hay que poner en el contenedor raíz de la pantalla. */
  vars: KioskCssVars;
}

/**
 * Convierte `#rrggbb` en `rgb(r g b / a)`. Se usa para derivar los velos translúcidos
 * del acento (glow, fondo suave) sin depender de `color-mix`, que no está en navegadores
 * de televisores algo viejos.
 */
const hexToRgba = (hex: string, alpha: number): string => {
  const limpio = hex.replace('#', '');
  const rojo = Number.parseInt(limpio.slice(0, 2), 16);
  const verde = Number.parseInt(limpio.slice(2, 4), 16);
  const azul = Number.parseInt(limpio.slice(4, 6), 16);
  return `rgb(${rojo} ${verde} ${azul} / ${alpha})`;
};

/**
 * Superficies base de cada modo. Son tonos neutros con un sesgo azulado; el acento
 * (lo que sí elige el consultorio) se superpone encima en forma de glows y bordes.
 */
const SUPERFICIES: Readonly<Record<ScreenTheme, Record<string, string>>> = {
  oscuro: {
    '--kiosk-bg': '#070b16',
    '--kiosk-bg-2': '#0d1424',
    '--kiosk-surface': 'rgb(18 27 44 / 0.72)',
    '--kiosk-surface-solid': '#121b2c',
    '--kiosk-border': '#26324a',
    '--kiosk-border-strong': '#3a4a66',
    '--kiosk-ink': '#eef4fb',
    '--kiosk-ink-muted': '#a8b6ca',
    '--kiosk-ink-subtle': '#7f8ea6',
    '--kiosk-shadow': '0 24px 55px rgb(0 0 0 / 0.5)',
    '--kiosk-ok': '#4ade80',
    '--kiosk-warn': '#fbbf24',
    '--kiosk-warn-soft': 'rgb(251 191 36 / 0.14)',
    '--kiosk-danger': '#f87171',
    '--kiosk-danger-soft': 'rgb(248 113 113 / 0.14)',
  },
  claro: {
    '--kiosk-bg': '#eef3f9',
    '--kiosk-bg-2': '#ffffff',
    '--kiosk-surface': 'rgb(255 255 255 / 0.82)',
    '--kiosk-surface-solid': '#ffffff',
    '--kiosk-border': '#d8e0ea',
    '--kiosk-border-strong': '#b8c4d4',
    '--kiosk-ink': '#101c2e',
    '--kiosk-ink-muted': '#4a5a70',
    '--kiosk-ink-subtle': '#6b7a90',
    '--kiosk-shadow': '0 24px 55px rgb(15 23 42 / 0.14)',
    '--kiosk-ok': '#15803d',
    '--kiosk-warn': '#b45309',
    '--kiosk-warn-soft': 'rgb(180 83 9 / 0.1)',
    '--kiosk-danger': '#b91c1c',
    '--kiosk-danger-soft': 'rgb(185 28 28 / 0.1)',
  },
};

/**
 * Arma las variables de una pantalla a partir de su tema y su acento. El acento sale de
 * los **mismos diez presets** de la interfaz (`UI_ACCENTS`), pero aplicado al cromo del
 * kiosko: no hay una paleta aparte que mantener en sincronía.
 */
export const construirVars = (
  tema: ScreenTheme,
  acento: ScreenSettings['acento'],
): KioskCssVars => {
  const oscuro = tema === 'oscuro';
  // La paleta del preset nombra sus dos variantes `light`/`dark`; el modo de la
  // pantalla se llama `claro`/`oscuro`. Aquí es donde se cruzan.
  const palette = UI_ACCENTS[acento][oscuro ? 'dark' : 'light'];

  return {
    ...SUPERFICIES[tema],
    '--kiosk-accent': palette.accent,
    '--kiosk-accent-strong': palette.primary,
    '--kiosk-accent-ink': palette.primaryInk,
    '--kiosk-focus': palette.focus,
    /** Fondo tenue del acento (tiles resaltados, badges). */
    '--kiosk-accent-soft': hexToRgba(palette.accent, oscuro ? 0.16 : 0.12),
    /** Halo del acento (animación de «vigente», focos). */
    '--kiosk-accent-glow': hexToRgba(palette.accent, oscuro ? 0.3 : 0.2),
  };
};

/**
 * Tema efectivo de la pantalla. Sin ajustes (la primera vez, antes de que el servicio
 * responda) se usa el modo oscuro de fábrica, que es el que mejor se ve en una TV.
 */
export const useKioskTheme = (ajustes: ScreenSettings | null): KioskTheme => {
  const tema = ajustes?.tema ?? 'oscuro';
  const acento = ajustes?.acento ?? 'teal';
  const vars = useMemo(() => construirVars(tema, acento), [tema, acento]);
  return { tema, vars };
};
