import { resolveScreenText, type ScreenTextKey } from '@odontocrm/contracts';
import { useQuery } from '@tanstack/react-query';
import { useCallback } from 'react';

import { settingsApi } from '../lib/endpoints';
import { interpolar, t } from '../lib/i18n';
import { APP_SETTINGS_QUERY_KEY } from '../lib/queryKeys';

/** Traduce un texto del kiosko: el personalizado si lo hay, el de fábrica si no. */
export type ScreenTextTranslator = (
  key: ScreenTextKey,
  params?: Record<string, string | number>,
) => string;

/**
 * Los **textos del kiosko** que el consultorio personalizó (ADR 0060), desde el panel de
 * configuración.
 *
 * **¿Por qué no usa `SettingsProvider`?** Porque las pantallas kiosko se autentican con un
 * **token de dispositivo** (rol `pantalla`) y no pasan por la sesión del personal: el
 * proveedor solo pide la configuración con sesión de usuario. El kiosko la pide por su
 * cuenta con el mismo cliente (`api`), que ya lleva su token.
 *
 * Devuelve un traductor con la **misma forma que `t`**: si no hay personalización, es
 * indistinguible del diccionario, y si la hay, se interpolan sus `{marcadores}` igual.
 */
export const useScreenTexts = (): ScreenTextTranslator => {
  const consulta = useQuery({
    queryKey: APP_SETTINGS_QUERY_KEY,
    queryFn: ({ signal }) => settingsApi.get(signal),
    staleTime: 5 * 60_000,
    retry: false,
  });
  const textos = consulta.data?.screenTexts;

  return useCallback<ScreenTextTranslator>(
    (key, params) => {
      const fabrica = t(key, params);
      const personalizado = resolveScreenText(key, textos, fabrica);
      // `resolveScreenText` devuelve el de fábrica cuando no hay personalización (ya
      // interpolado); si hay, hay que interpolar sus marcadores.
      return personalizado === fabrica ? fabrica : interpolar(personalizado, params);
    },
    [textos],
  );
};
