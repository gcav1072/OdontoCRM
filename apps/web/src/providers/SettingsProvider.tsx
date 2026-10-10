import { UI_ACCENTS, uiAccentCss, type AppSettingsView } from '@odontocrm/contracts';
import { useQuery } from '@tanstack/react-query';
import { createContext, useContext, useEffect, type ReactNode } from 'react';

import { settingsApi } from '../lib/endpoints';
import { APP_SETTINGS_QUERY_KEY } from '../lib/queryKeys';
import { useAuth } from './AuthProvider';

/**
 * La **configuración de la aplicación** para toda la interfaz (ADR 0060): la marca de los
 * imprimibles, el acento del cromo, los textos del kiosko y los canales. La lee **una sola
 * vez** este proveedor y la reparten por contexto los componentes que la necesitan.
 *
 * **Qué hace además de repartirla**: aplica el **acento** y la **marca** al documento
 * inyectando dos `<style>` en `<head>` —
 *
 *  - `themeCss` (que ya trae `--brand-*` y las `@font-face` resueltas por identity), para
 *    que el membrete impreso desde el navegador use la MISMA marca que el PDF del servidor;
 *  - el acento del preset elegido (`--color-primary`, `--color-accent`…), que **gana** sobre
 *    `tokens.css` por orden de cascada.
 *
 * **Sin sesión no se pide** (igual que la identidad del consultorio): la consulta espera a
 * que haya sesión, y el login y el arranque en frío no ensucian la red. `null` significa «no
 * lo sé»: los componentes caen a los valores del código hasta que llegue.
 */
const SettingsContext = createContext<AppSettingsView | null>(null);

const STYLE_BRAND_ID = 'odontocrm-marca-runtime';
const STYLE_ACCENT_ID = 'odontocrm-acento-runtime';

/** Crea o reemplaza un `<style>` del `<head>` por su `id`. */
const aplicarEstilo = (id: string, css: string): void => {
  if (typeof document === 'undefined') return;
  let estilo = document.getElementById(id) as HTMLStyleElement | null;
  if (estilo === null) {
    estilo = document.createElement('style');
    estilo.id = id;
    document.head.append(estilo);
  }
  if (estilo.textContent !== css) estilo.textContent = css;
};

/** Aplica el acento y la marca al documento (idempotente). */
export const aplicarAjustes = (vista: AppSettingsView): void => {
  aplicarEstilo(STYLE_BRAND_ID, vista.themeCss);
  aplicarEstilo(STYLE_ACCENT_ID, uiAccentCss(UI_ACCENTS[vista.accentEffective]));
};

export const SettingsProvider = ({ children }: { children: ReactNode }) => {
  const { status } = useAuth();

  const consulta = useQuery({
    queryKey: APP_SETTINGS_QUERY_KEY,
    queryFn: ({ signal }) => settingsApi.get(signal),
    // Solo con sesión: sin ella la consulta daría 401 y no hay nada que aplicar.
    enabled: status === 'autenticado',
    staleTime: 5 * 60_000,
    retry: false,
  });

  useEffect(() => {
    if (consulta.data !== undefined) aplicarAjustes(consulta.data);
  }, [consulta.data]);

  return (
    <SettingsContext.Provider value={consulta.data ?? null}>{children}</SettingsContext.Provider>
  );
};

/** Expuesto para quien edita la configuración (invalidar la consulta al guardar). */
export { APP_SETTINGS_QUERY_KEY };

/** La configuración efectiva, o `null` si aún no se ha cargado (o no hay proveedor). */
export const useSettings = (): AppSettingsView | null => useContext(SettingsContext);
