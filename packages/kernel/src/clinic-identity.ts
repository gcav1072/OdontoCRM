import {
  BRAND,
  CLINIC,
  clinicDentistFor,
  clinicFullAddress,
  clinicNameOneLine,
  letterheadSchema,
  type ClinicIdentity,
  type LetterheadSnapshot,
} from '@odontocrm/contracts';

import { readImageDataUri } from './brand-assets.js';

/**
 * La **instantánea del membrete** que los servicios que componen documentos (y los que
 * arman avisos o pantallas) leen de identity: la identidad del consultorio, el odontólogo
 * que firma —resuelto por usuario— y el logo ya incrustado como `data:` URI.
 *
 * **¿Por qué leerla y no empujarla?** Es el mismo razonamiento del ADR 0035 (los datos
 * críticos se leen): el dato tiene que estar bien **en el momento de usarlo**, y el
 * servicio que lo necesita no tiene por qué saber cuándo cambió el perfil del consultorio.
 *
 * **¿Y si identity no responde?** Se degrada a `CLINIC` (respaldo **neutro** del
 * código, sin datos personales). El documento sale **sin** datos del consultorio y
 * marcado como incompleto (`letterheadMissingFields`) en vez de romperse: un fallo de
 * identity **nunca** bloquea un papel, pero tampoco inventa identidad.
 *
 * **Coste.** Una lectura interna por documento sería cara para las pantallas, que refrescan
 * cada pocos segundos. Por eso hay **caché con TTL** y **deduplicación de llamada en
 * vuelo**: dos peticiones simultáneas comparten una sola lectura, y durante el TTL no se
 * vuelve a preguntar. La identidad cambia rarísimas veces; un minuto de desfase es inocuo.
 */

export interface LetterheadLookupConfig {
  /** URL interna de identity (`http://127.0.0.1:4001`). */
  IDENTITY_URL: string;
  /** Secreto compartido de las rutas internas. Sin él no se pregunta (se usa el respaldo). */
  INTERNAL_SERVICE_SECRET?: string | undefined;
  /** Tiempo límite de la lectura interna (ms). */
  timeoutMs?: number;
  /** Vida de la caché (ms). `0` la desactiva. */
  cacheTtlMs?: number;
  /**
   * Aviso de que **no** se pudo leer la identidad y se está usando el respaldo del código
   * (`CLINIC`). Se llama como mucho una vez por minuto. Sin esto, un fallo de la lectura
   * interna dejaría el membrete con los datos del código sin que nadie se entere.
   */
  onFallback?: ((motivo: string) => void) | undefined;
}

/** El respaldo: el membrete de `CLINIC` (el código), con el logo del repositorio. */
export const fallbackLetterhead = async (
  username: string | null = null,
  clinic: ClinicIdentity = CLINIC,
): Promise<LetterheadSnapshot> => ({
  clinic: {
    ...clinic,
    phones: [...clinic.phones],
    dentists: clinic.dentists.map((dentist) => ({ ...dentist })),
  },
  dentist: clinicDentistFor(username, clinic),
  logoDataUri: await readImageDataUri(BRAND.logoPath),
  version: 'seed',
});

/** Una lectura de la instantánea para un usuario dado (nunca `null`: degrada al respaldo). */
export type LetterheadLookup = (username?: string | null) => Promise<LetterheadSnapshot>;

/**
 * Construye la lectura de la instantánea con caché y respaldo.
 *
 * Devuelve siempre una instantánea: si identity falla o no hay secreto configurado,
 * devuelve el respaldo del código. El llamador no tiene que preocuparse por la caída.
 */
export const createLetterheadLookup = (config: LetterheadLookupConfig): LetterheadLookup => {
  const timeoutMs = config.timeoutMs ?? 5_000;
  const cacheTtlMs = config.cacheTtlMs ?? 60_000;
  const secret = config.INTERNAL_SERVICE_SECRET;
  const onFallback = config.onFallback;

  /** Una lectura: la instantánea o el motivo por el que no se pudo leer (para el aviso). */
  type Lectura = { ok: true; snapshot: LetterheadSnapshot } | { ok: false; motivo: string };

  /** Caché por usuario (`''` = sin usuario, el titular). */
  const cache = new Map<string, { snapshot: LetterheadSnapshot; expiresAt: number }>();
  /** Lecturas en vuelo: dos peticiones simultáneas comparten una sola. */
  const inFlight = new Map<string, Promise<Lectura>>();
  /** Última vez que se avisó del respaldo (como mucho una vez por minuto). */
  let ultimoAviso = 0;

  const avisar = (motivo: string): void => {
    if (onFallback === undefined || Date.now() - ultimoAviso < 60_000) return;
    ultimoAviso = Date.now();
    onFallback(motivo);
  };

  const fetchOnce = async (dentist: string | null): Promise<Lectura> => {
    if (secret === undefined) {
      return { ok: false, motivo: 'no hay INTERNAL_SERVICE_SECRET configurado' };
    }
    const url = new URL('/internal/v1/identity/letterhead', config.IDENTITY_URL);
    if (dentist !== null && dentist.trim() !== '') url.searchParams.set('dentist', dentist);

    try {
      const response = await fetch(url, {
        headers: { 'x-internal-token': secret },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) {
        return {
          ok: false,
          motivo: `identity respondió ${String(response.status)} en /internal/v1/identity/letterhead`,
        };
      }

      const parsed = letterheadSchema.safeParse(await response.json());
      return parsed.success
        ? { ok: true, snapshot: parsed.data }
        : { ok: false, motivo: 'la identidad que sirvió identity no cumple el contrato' };
    } catch (error) {
      return {
        ok: false,
        motivo: `no se pudo leer la identidad de identity: ${
          error instanceof Error ? error.message : 'error de red'
        }`,
      };
    }
  };

  return async (username = null) => {
    const clave = username?.trim() ?? '';

    if (cacheTtlMs > 0) {
      const guardada = cache.get(clave);
      if (guardada !== undefined && guardada.expiresAt > Date.now()) return guardada.snapshot;
    }

    const pendiente =
      inFlight.get(clave) ??
      (() => {
        const lectura = fetchOnce(clave === '' ? null : clave).finally(() => {
          inFlight.delete(clave);
        });
        inFlight.set(clave, lectura);
        return lectura;
      })();

    const leida = await pendiente;
    if (!leida.ok) avisar(leida.motivo);
    const snapshot = leida.ok ? leida.snapshot : await fallbackLetterhead(username);
    if (cacheTtlMs > 0) {
      cache.set(clave, { snapshot, expiresAt: Date.now() + cacheTtlMs });
    }
    return snapshot;
  };
};

/** Los campos del consultorio que algunos servicios llevan en su configuración. */
export interface ClinicDataConfig {
  CLINIC_NAME?: string | undefined;
  CLINIC_ADDRESS?: string | undefined;
  CLINIC_EMAIL?: string | undefined;
}

/**
 * Deja en la **configuración** del servicio el nombre, la dirección y el correo del
 * consultorio leídos del **registro** (identity → `clinic_profiles`). Ya **no** hay
 * variables de entorno `CLINIC_*`: la identidad se sirve **solo** desde el registro que
 * completa el titular.
 *
 * Es para los servicios que solo usan esos tres datos en textos (el bot, el `.ics` y el
 * encabezado de las pantallas) y los leen de `config` en muchos sitios: en vez de
 * enhebrar la lectura por cada función, se refresca **la configuración** y quien la lea
 * ya ve el dato bueno. **No hay coste por mensaje**: se llama al arrancar y, como mucho,
 * cada pocos minutos.
 *
 * Si el consultorio **aún no está configurado** (no hay nombre ni dirección), el campo
 * queda **sin valor**: quien lo necesite difiere la generación o el envío en vez de
 * componer un documento a medias.
 *
 * **Los tres campos se escriben siempre, sin condición.** Antes el guard era
 * `if (config.CAMPO !== undefined)`, que funcionaba mientras el esquema traía un valor
 * por defecto (nunca `undefined`); ahora los campos son **opcionales** y zod **omite** la
 * clave cuando falta, así que ese guard dejaba de entrar y el dato nunca se escribía. Un
 * servicio que no declare uno de los tres (screens solo usa `CLINIC_NAME`) simplemente
 * lleva la propiedad de más: no la lee.
 */
export const aplicarDatosDelConsultorio = async (
  config: ClinicDataConfig,
  lookup: LetterheadLookup,
): Promise<void> => {
  const snapshot = await lookup();
  // El nombre va en **una línea** en estos textos (bot, .ics, encabezado de las pantallas):
  // el membrete es lo único que respeta el salto de línea que parte el nombre en dos.
  const nombre = clinicNameOneLine(snapshot.clinic.name);
  const direccion = clinicFullAddress(snapshot.clinic).trim();
  const correo = (snapshot.clinic.email ?? '').trim();

  config.CLINIC_NAME = nombre === '' ? undefined : nombre;
  config.CLINIC_ADDRESS = direccion === '' ? undefined : direccion;
  config.CLINIC_EMAIL = correo === '' ? undefined : correo;
};
