import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

import { readStorage, STORAGE_KEYS, writeStorage } from '../lib/storage';

/**
 * Tema de la interfaz: claro, oscuro o sistema.
 *
 * El modo se guarda en `localStorage` (`odontocrm:tema`) y se traduce a la clase
 * `dark` en `<html>`, que es lo que leen los tokens de `packages/ui`. El modo
 * «sistema» sigue `prefers-color-scheme` en vivo, sin recargar.
 */

export type ThemeMode = 'claro' | 'oscuro' | 'sistema';
export type ResolvedTheme = 'claro' | 'oscuro';

export interface ThemeContextValue {
  mode: ThemeMode;
  resolved: ResolvedTheme;
  setMode: (mode: ThemeMode) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

export const useTheme = (): ThemeContextValue => {
  const contexto = useContext(ThemeContext);
  if (!contexto) throw new Error('useTheme debe usarse dentro de <ThemeProvider>');
  return contexto;
};

const esModo = (valor: string | null): valor is ThemeMode =>
  valor === 'claro' || valor === 'oscuro' || valor === 'sistema';

const leerModoGuardado = (): ThemeMode => {
  const valor = readStorage(STORAGE_KEYS.tema);
  return esModo(valor) ? valor : 'sistema';
};

const prefiereOscuro = (): boolean =>
  typeof window.matchMedia === 'function' &&
  window.matchMedia('(prefers-color-scheme: dark)').matches;

const aplicarTema = (resolved: ResolvedTheme): void => {
  const raiz = document.documentElement;
  raiz.classList.toggle('dark', resolved === 'oscuro');
  // `color-scheme` hace que los controles nativos (selects, barras) acompañen.
  raiz.style.colorScheme = resolved === 'oscuro' ? 'dark' : 'light';
};

const resolverModo = (mode: ThemeMode, sistemaOscuro: boolean): ResolvedTheme =>
  mode === 'sistema' ? (sistemaOscuro ? 'oscuro' : 'claro') : mode;

/**
 * Aplica el tema guardado antes del primer render (se llama desde `main.tsx`)
 * para que no se vea un destello blanco al abrir con tema oscuro.
 */
export const aplicarTemaGuardado = (): void => {
  aplicarTema(resolverModo(leerModoGuardado(), prefiereOscuro()));
};

export const ThemeProvider = ({ children }: { children: ReactNode }) => {
  const [mode, setModeState] = useState<ThemeMode>(leerModoGuardado);
  const [sistemaOscuro, setSistemaOscuro] = useState<boolean>(prefiereOscuro);

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;

    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const alCambiar = (event: MediaQueryListEvent) => setSistemaOscuro(event.matches);
    media.addEventListener('change', alCambiar);
    return () => media.removeEventListener('change', alCambiar);
  }, []);

  const resolved = resolverModo(mode, sistemaOscuro);

  useEffect(() => {
    aplicarTema(resolved);
  }, [resolved]);

  const setMode = useCallback((nuevo: ThemeMode) => {
    setModeState(nuevo);
    writeStorage(STORAGE_KEYS.tema, nuevo);
  }, []);

  const value = useMemo<ThemeContextValue>(
    () => ({ mode, resolved, setMode }),
    [mode, resolved, setMode],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
};
