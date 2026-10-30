/**
 * Normalización de teléfonos para los canales de mensajería.
 *
 * WhatsApp trabaja con el número en **dígitos E.164 sin `+`** (`584141234567`),
 * que es el mismo `wa_id` que entrega Cloud API y el que se guarda en
 * `patient_channels.direccion`. El asistente pide el teléfono en formato local
 * (`0412-1234567`) y aquí se convierte sin perder el país.
 */

/** Código de país por defecto (Venezuela). */
export const DEFAULT_COUNTRY_CODE = '58';

/**
 * Convierte un teléfono escrito por una persona a dígitos E.164 sin `+`.
 *
 * Acepta `0414-1234567`, `4141234567`, `+58 414 1234567`, `0058...` y ya
 * normalizados (`584141234567`). Si el texto no tiene dígitos devuelve `''`.
 *
 * La regla es deliberadamente conservadora: no adivina países raros; con el
 * prefijo por defecto (`58`) resuelve el caso del consultorio y deja intacto lo
 * que ya parece un E.164 completo de otro país.
 */
export const toE164Digits = (
  texto: string,
  prefijoPorDefecto: string = DEFAULT_COUNTRY_CODE,
): string => {
  const prefijo = prefijoPorDefecto.replace(/\D/g, '');
  let digitos = texto.replace(/\D/g, '');
  if (digitos === '') return '';

  // `00` es el prefijo internacional de marcación a mano.
  if (digitos.startsWith('00')) digitos = digitos.slice(2);

  // Ya viene con el país: `58` + 10 dígitos (o más, si el país tiene otra longitud).
  if (prefijo !== '' && digitos.startsWith(prefijo) && digitos.length > prefijo.length + 6) {
    return digitos;
  }

  // Formato local venezolano: `0414...` → se quita el 0 y se antepone el país.
  if (digitos.startsWith('0')) {
    const sinCero = digitos.slice(1);
    return `${prefijo}${sinCero}`;
  }

  // `4141234567` (10 dígitos) es un local sin el 0.
  if (digitos.length === 10) return `${prefijo}${digitos}`;

  // Otro país que ya trae su prefijo: se deja tal cual.
  return digitos;
};

/**
 * ¿La dirección es un JID de WhatsApp (`...@s.whatsapp.net`, `...@lid`) y no un
 * teléfono? Las direcciones con `@` se envían tal cual; las de solo dígitos se
 * convierten a `<dígitos>@s.whatsapp.net`.
 */
export const isWhatsAppJid = (direccion: string): boolean =>
  /\d@(?:s\.whatsapp\.net|lid)$/i.test(direccion);
