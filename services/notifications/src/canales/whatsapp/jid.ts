import { DEFAULT_COUNTRY_CODE, toE164Digits } from '@odontocrm/contracts';

/**
 * Traducción entre las direcciones de OdontoCRM y los JID de WhatsApp (D6).
 *
 * La dirección guardada en `patient_channels.direccion` sigue siendo el número
 * en **dígitos E.164 sin `+`** (`584141234567`), igual que el `wa_id` de Cloud
 * API. Si WhatsApp solo entrega un LID (`123…@lid`) y no hay número alternativo,
 * se guarda el JID completo para no perder el hilo; enviar a una dirección con
 * `@` la usa tal cual.
 */

const DOMINIO_PN = '@s.whatsapp.net';
const DOMINIO_LID = '@lid';

/** `true` si la dirección es un JID anónimo de Baileys v7. */
export const esLid = (direccion: string): boolean =>
  direccion.trim().toLowerCase().endsWith(DOMINIO_LID);

/** Parte local de un JID, sin el sufijo de dispositivo (`:12`). */
const localDeJid = (jid: string): string => {
  const arroba = jid.indexOf('@');
  const local = arroba === -1 ? jid : jid.slice(0, arroba);
  return local.split(':')[0] ?? local;
};

/**
 * Dirección del interlocutor a partir del JID del mensaje.
 *
 * `remoteJidAlt` es el número alternativo que entrega Baileys v7 cuando el chat
 * viaja como LID: si viene, **manda** el número; si no, se conserva el JID para
 * poder responder.
 */
export const direccionDesdeJid = (
  remoteJid: string | null | undefined,
  remoteJidAlt: string | null | undefined,
  prefijoPorDefecto: string = DEFAULT_COUNTRY_CODE,
): string | null => {
  if (remoteJid === null || remoteJid === undefined || remoteJid.trim() === '') return null;

  const jid = remoteJid.trim();
  const alt = remoteJidAlt?.trim() ?? '';
  const candidato = alt.endsWith(DOMINIO_PN) ? alt : jid;

  if (candidato.endsWith(DOMINIO_PN)) {
    const local = localDeJid(candidato);
    return /^\d+$/.test(local) ? local : candidato;
  }

  if (candidato.endsWith(DOMINIO_LID)) return candidato;

  // Un JID de grupo, estado o canal nunca es un interlocutor válido (D11).
  if (
    candidato.endsWith('@g.us') ||
    candidato.endsWith('@newsletter') ||
    candidato.endsWith('@broadcast')
  ) {
    return null;
  }

  if (candidato.includes('@')) return candidato;

  return /^\d+$/.test(candidato) ? toE164Digits(candidato, prefijoPorDefecto) : null;
};

/**
 * JID al que enviar. Una dirección con `@` se respeta (incluido un LID); si es
 * un número local o E.164 sin `+`, se normaliza y se le pone el dominio de
 * WhatsApp.
 */
export const jidDesdeDireccion = (
  direccion: string,
  prefijoPorDefecto: string = DEFAULT_COUNTRY_CODE,
): string => {
  const limpia = direccion.trim();
  if (limpia.includes('@')) return limpia;

  const digitos = toE164Digits(limpia, prefijoPorDefecto);
  if (digitos === '') throw new Error('La dirección de WhatsApp no tiene dígitos');
  return `${digitos}${DOMINIO_PN}`;
};
