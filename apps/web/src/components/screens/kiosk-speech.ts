import { abbreviateName } from '@odontocrm/contracts';

/**
 * Voz del displaylobby (Web Speech API).
 *
 * La pantalla de la sala de espera es un televisor sin teclado ni ratón: lo
 * único que puede hacer por el paciente es leer el llamado en voz alta. Se usa
 * `speechSynthesis` del navegador (no hay dependencias nuevas) y **todo** está
 * envuelto en comprobaciones porque el navegador puede no traer voces: en un
 * quiosco sin voces instaladas la pantalla tiene que seguir funcionando en
 * silencio, no romperse.
 */

/** Ajustes de voz de la pantalla (los del dispositivo, si están disponibles). */
export interface KioskVoiceOptions {
  /** Si es `false`, el llamado se pinta pero no se lee. */
  voz: boolean;
  /** Volumen de 0 a 1 (el de los ajustes de la administración). */
  volumen: number;
}

export const KIOSK_VOICE_DEFAULT: KioskVoiceOptions = { voz: true, volumen: 1 };

/** ¿Este navegador puede hablar? Se comprueba antes de tocar nada más. */
export const puedeHablar = (): boolean => {
  try {
    return (
      typeof window !== 'undefined' &&
      typeof window.speechSynthesis !== 'undefined' &&
      window.speechSynthesis !== null
    );
  } catch {
    // Algunos navegadores en modo privado lanzan al leer la propiedad.
    return false;
  }
};

/** Primera voz en español disponible (preferimos es-VE, luego es-*, luego cualquiera). */
const vozEnEspanol = (voces: readonly SpeechSynthesisVoice[]): SpeechSynthesisVoice | null => {
  const normalizado = (codigo: string): string => codigo.toLowerCase().replace('_', '-');
  return (
    voces.find((voz) => normalizado(voz.lang) === 'es-ve') ??
    voces.find((voz) => normalizado(voz.lang).startsWith('es')) ??
    voces[0] ??
    null
  );
};

/**
 * Frase del llamado con las tres piezas ya resueltas: «Turno <turno>, <nombre>,
 * pase a <sillón>».
 *
 * Se arma aquí —y no con una clave de traducción— porque en el diccionario el
 * turno, el nombre y el sillón son tres textos separados y la voz necesita una
 * sola oración. El llamador decide qué pasa en cada hueco (si la cita no tenía
 * solicitud, el turno es «—»).
 */
export const fraseLlamado = (input: { turno: string; nombre: string; sillon: string }): string => {
  const partes = [input.turno, input.nombre, input.sillon].filter((parte) => parte.trim() !== '');
  return `${partes.join(', ')}.`;
};

/**
 * Atajo desde un llamado del displaylobby: arma la frase y la lee.
 *
 * El turno se resuelve con la misma regla que la pantalla (`call.ticket ?? '—'`),
 * para que la voz y el texto digan exactamente lo mismo.
 */
export const anunciarLlamado = (
  call: { ticket: string | null; patientDisplayName: string; chairLabel: string },
  opciones: KioskVoiceOptions = KIOSK_VOICE_DEFAULT,
): boolean =>
  hablar(
    fraseLlamado({
      turno: `Turno ${call.ticket ?? '—'}`,
      nombre: abbreviateName(call.patientDisplayName),
      sillon: `Pase a ${call.chairLabel}`,
    }),
    opciones,
  );

/**
 * Lee un texto en voz alta. Devuelve `false` si el navegador no puede hablar,
 * para que quien llama sepa que no hubo anuncio (y no lo dé por hecho).
 */
export const hablar = (
  texto: string,
  opciones: KioskVoiceOptions = KIOSK_VOICE_DEFAULT,
): boolean => {
  if (texto.trim() === '' || !opciones.voz || !puedeHablar()) return false;

  try {
    const sintesis = window.speechSynthesis;
    const locucion = new SpeechSynthesisUtterance(texto);
    locucion.lang = 'es-VE';
    locucion.volume = Math.min(1, Math.max(0, opciones.volumen));

    const voz = vozEnEspanol(sintesis.getVoices());
    if (voz !== null) {
      locucion.voice = voz;
      // La voz elegida manda: si es es-VE, se declara como tal.
      locucion.lang = voz.lang;
    }

    sintesis.speak(locucion);
    return true;
  } catch {
    // Sin voces o sin permiso de audio: la pantalla sigue, en silencio.
    return false;
  }
};

/** Corta lo que esté sonando (al desmontar la pantalla o al cambiar de turno). */
export const callar = (): void => {
  if (!puedeHablar()) return;
  try {
    window.speechSynthesis.cancel();
  } catch {
    // Ignorado a propósito.
  }
};
