import {
  BRAND,
  CLINIC,
  clinicDentistFor,
  clinicFullAddress,
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
 * **¿Y si identity no responde?** Se degrada a `CLINIC` (el respaldo del código): el
 * récipe sale con el membrete de siempre en vez de romperse. Un fallo de identity **nunca**
 * bloquea un papel.
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
}

/** Overrides de entorno del membrete (`CLINIC_NAME`, `CLINIC_ADDRESS`, `CLINIC_EMAIL`). */
export interface ClinicOverride {
  name?: string | undefined;
  address?: string | undefined;
  email?: string | undefined;
}

/** Aplica los overrides del entorno sobre la instantánea (name/address/email). */
export const applyClinicOverride = (
  snapshot: LetterheadSnapshot,
  override: ClinicOverride,
): LetterheadSnapshot => {
  const clinic = { ...snapshot.clinic };
  if (override.name !== undefined && override.name.trim() !== '') clinic.name = override.name;
  if (override.address !== undefined && override.address.trim() !== '')
    clinic.address = override.address;
  if (override.email !== undefined && override.email.trim() !== '') clinic.email = override.email;
  return { ...snapshot, clinic };
};

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

  /** Caché por usuario (`''` = sin usuario, el titular). */
  const cache = new Map<string, { snapshot: LetterheadSnapshot; expiresAt: number }>();
  /** Lecturas en vuelo: dos peticiones simultáneas comparten una sola. */
  const inFlight = new Map<string, Promise<LetterheadSnapshot | null>>();

  const fetchOnce = async (dentist: string | null): Promise<LetterheadSnapshot | null> => {
    if (secret === undefined) return null;
    const url = new URL('/internal/v1/identity/letterhead', config.IDENTITY_URL);
    if (dentist !== null && dentist.trim() !== '') url.searchParams.set('dentist', dentist);

    try {
      const response = await fetch(url, {
        headers: { 'x-internal-token': secret },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) return null;

      const parsed = letterheadSchema.safeParse(await response.json());
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
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

    const snapshot = (await pendiente) ?? (await fallbackLetterhead(username));
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
 * consultorio con la precedencia acordada: **entorno (`CLINIC_*`) > base de datos >
 * `CLINIC` del código**.
 *
 * Es para los servicios que solo usan esos tres datos en textos (el bot, el `.ics` y el
 * encabezado de las pantallas) y los leen de `config` en muchos sitios: en vez de
 * enhebrar la lectura por cada función, se refresca **la configuración** y quien la lea
 * ya ve el dato bueno. **No hay coste por mensaje**: se llama al arrancar y, como mucho,
 * cada pocos minutos.
 *
 * Si la variable de entorno está puesta, **manda**: es el ajuste puntual de siempre y no
 * se pisa con lo de la base.
 */
export const aplicarDatosDelConsultorio = async (
  config: ClinicDataConfig,
  lookup: LetterheadLookup,
  env: Record<string, string | undefined> = process.env,
): Promise<void> => {
  const snapshot = await lookup();
  const gana = (
    envValue: string | undefined,
    deBase: string,
    actual: string | undefined,
  ): string =>
    envValue !== undefined && envValue.trim() !== ''
      ? envValue
      : deBase.trim() !== ''
        ? deBase
        : (actual ?? '');

  if (config.CLINIC_NAME !== undefined) {
    config.CLINIC_NAME = gana(env['CLINIC_NAME'], snapshot.clinic.name, config.CLINIC_NAME);
  }
  if (config.CLINIC_ADDRESS !== undefined) {
    config.CLINIC_ADDRESS = gana(
      env['CLINIC_ADDRESS'],
      clinicFullAddress(snapshot.clinic),
      config.CLINIC_ADDRESS,
    );
  }
  if (config.CLINIC_EMAIL !== undefined) {
    config.CLINIC_EMAIL = gana(
      env['CLINIC_EMAIL'],
      snapshot.clinic.email ?? '',
      config.CLINIC_EMAIL,
    );
  }
};
