/**
 * Los patrones que buscan secretos en el repositorio, y los archivos que nunca deben
 * versionarse. Viven aparte de `tools/check-secrets.mjs` para poder probarlos sin git ni
 * pila (`secretos.test.mjs`): el escáner solo se encarga de recorrer el árbol.
 *
 * Regla de oro al tocarlos: una regla que **no** salta deja pasar un secreto real, y una que
 * salta de más rompe la puerta de calidad en un árbol limpio (`npm run check-secrets` corre
 * en `npm run verify`). Las dos cosas ya han pasado aquí, así que cada patrón lleva su porqué
 * y todo cambio se fija con una prueba en los dos sentidos: lo que debe detectar y lo que no.
 */

export const SECRET_PATTERNS = [
  {
    name: 'posible token de bot de Telegram',
    regex: /\b\d{8,10}:[A-Za-z0-9_-]{35}\b/,
  },
  {
    name: 'clave privada PEM',
    regex: /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  },
  {
    name: 'cadena de conexión con contraseña real',
    // Detrás de los dos puntos NO vale cualquier cosa: además de los marcadores de ejemplo
    // conocidos —los que el propio instalador imprime en sus mensajes (`CAMBIAR`, `TU_PASSWORD`,
    // `TU_CLAVE`…)—, se tolera una **interpolación de variable** (`${…}`, `$(…)`, `$VAR`), que
    // es código y no una contraseña. Sin eso, `postgres://USUARIO:$([Uri]::EscapeDataString($clave))@…`
    // —la plantilla del instalador de Windows— salía como hallazgo y tumbaba `npm run verify`
    // en cualquier árbol limpio.
    regex:
      /postgres(?:ql)?:\/\/[^\s:'"@/]+:(?!CAMBIAR|TU_PASSWORD|TU_CLAVE|password|clave|CLAVE|usuario|EJEMPLO|ejemplo|\$[A-Za-z_{(]|<)[^\s@'"]{6,}@/i,
  },
  {
    name: 'clave de acceso de AWS',
    regex: /\bAKIA[0-9A-Z]{16}\b/,
  },
  {
    // Solo valores «pelados» que ocupan la línea completa: así no confunde
    // código como `password = decodeURIComponent(...)` con un secreto real.
    name: 'asignación de secreto en texto plano',
    regex:
      /^\s*(?:SECRET|TOKEN|PASSWORD|API_KEY|PRIVATE_KEY|BOT_TOKEN)\s*=\s*['"]?[A-Za-z0-9+/_-]{16,}['"]?\s*$/im,
  },
  {
    name: 'token de GitHub',
    regex: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/,
  },
];

/** Las plantillas de entorno se versionan a propósito: son las que enseñan qué hay que poner. */
export const ALLOWED_EXAMPLE = /\.env\.example$/;

/** Rutas que jamás deben llegar al repositorio, ni siquiera con un valor de ejemplo dentro. */
export const isForbiddenPath = (path) => {
  if (ALLOWED_EXAMPLE.test(path)) return false;
  return (
    /(^|\/)\.env(\.|$)/.test(path) ||
    /\.(pem|key|p12|pfx)$/.test(path) ||
    /(^|\/)secrets\//.test(path) ||
    /(^|\/)\.keys\//.test(path)
  );
};

/**
 * Los patrones que dispara una línea, por nombre. Lo usa el escáner para informar (nunca
 * imprime el valor encontrado) y las pruebas para fijar lo que salta y lo que no.
 */
export const hallazgosDeLinea = (linea) =>
  SECRET_PATTERNS.filter((patron) => patron.regex.test(linea)).map((patron) => patron.name);
