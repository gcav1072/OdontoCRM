/**
 * Acceso tolerante a `localStorage`.
 *
 * Aquí solo se guardan preferencias de interfaz (tema, panel abierto, menú
 * colapsado) y **nunca** datos de sesión: el token de acceso vive en memoria.
 * Todo va envuelto en `try` porque en modo privado o con el almacenamiento
 * lleno el navegador lanza, y eso no debe romper la pantalla.
 */

export const STORAGE_KEYS = {
  tema: 'odontocrm:tema',
  panelInferior: 'odontocrm:panel-inferior',
  menuLateral: 'odontocrm:menu-lateral',
} as const;

export const readStorage = (key: string): string | null => {
  try {
    return window.localStorage.getItem(key);
  } catch {
    // Sin persistencia disponible: se usa el valor por defecto.
    return null;
  }
};

export const writeStorage = (key: string, value: string): void => {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Sin persistencia disponible: la preferencia dura solo esta sesión.
  }
};

export const readFlag = (key: string): boolean | null => {
  const valor = readStorage(key);
  if (valor === null) return null;
  return valor === 'true';
};

export const writeFlag = (key: string, value: boolean): void => {
  writeStorage(key, value ? 'true' : 'false');
};
