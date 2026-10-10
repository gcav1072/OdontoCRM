import {
  BRAND,
  effectiveBrandSchema,
  type BrandTheme,
  type EffectiveBrand,
} from '@odontocrm/contracts';

/**
 * La **marca efectiva** que los servicios de documentos leen de identity (ADR 0060).
 *
 * Hasta ahora la marca (`brand.ts`) era solo-código y los servicios la importaban
 * directamente. Con el panel de configuración la marca puede venir de la **base**, así
 * que clinical, reporting y billing tienen que **leerla** —igual que ya leen el
 * membrete— en vez de asumir la del código.
 *
 * **¿Por qué leerla y no empujarla?** El mismo razonamiento que en el membrete: el dato
 * tiene que estar bien **en el momento de usarlo**, y el servicio no tiene por qué saber
 * cuándo cambió el panel. Con caché corta y deduplicación, el coste por documento es
 * cero en la práctica.
 *
 * **¿Y si identity no responde?** Se degrada al **respaldo del código** (`BRAND`): el
 * papel sale con la identidad de fábrica, no roto. Un fallo de identity **nunca** deja
 * un imprimible sin marca.
 */

/** Una lectura de la marca efectiva (nunca lanza: degrada al respaldo). */
export type BrandLookup = () => Promise<EffectiveBrand>;

export interface BrandLookupConfig {
  /** URL interna de identity (`http://127.0.0.1:4001`). */
  IDENTITY_URL: string;
  /** Secreto compartido de las rutas internas. Sin él no se pregunta (se usa `BRAND`). */
  INTERNAL_SERVICE_SECRET?: string | undefined;
  /** Tiempo límite de la lectura interna (ms). */
  timeoutMs?: number;
  /** Vida de la caché (ms). `0` la desactiva. */
  cacheTtlMs?: number;
}

/** El tema del contrato a partir de un `BrandTheme` (paleta, tipografías y medidas). */
const themeOf = (brand: BrandTheme): EffectiveBrand['theme'] => ({
  palette: brand.palette,
  typography: brand.typography,
  letterhead: brand.letterhead,
});

/**
 * El respaldo del código: el tema de `BRAND`, sin fuentes incrustadas ni logo.
 *
 * Las fuentes del repositorio las resuelve **el llamador** (tiene sistema de archivos):
 * aquí solo se declara que no hay una versión «de la base» que incrustar. El logo, por
 * su parte, lo resuelve la instantánea del membrete (`letterheadSnapshot`).
 */
export const fallbackBrand = (): EffectiveBrand => ({
  theme: themeOf(BRAND),
  fontFaceCss: '',
  logoDataUri: null,
  version: 'seed',
  fromDatabase: false,
});

/**
 * Construye la lectura de la marca con caché y respaldo.
 *
 * Devuelve siempre una marca efectiva: si identity falla o no hay secreto configurado,
 * devuelve el respaldo del código. El llamador no tiene que preocuparse por la caída.
 */
export const createBrandLookup = (config: BrandLookupConfig): BrandLookup => {
  const timeoutMs = config.timeoutMs ?? 5_000;
  const cacheTtlMs = config.cacheTtlMs ?? 60_000;
  const secret = config.INTERNAL_SERVICE_SECRET;

  let cache: { brand: EffectiveBrand; expiresAt: number } | null = null;
  let inFlight: Promise<EffectiveBrand | null> | null = null;

  const fetchOnce = async (): Promise<EffectiveBrand | null> => {
    if (secret === undefined) return null;

    try {
      const response = await fetch(new URL('/internal/v1/identity/brand', config.IDENTITY_URL), {
        headers: { 'x-internal-token': secret },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) return null;

      const parsed = effectiveBrandSchema.safeParse(await response.json());
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  };

  return async () => {
    if (cacheTtlMs > 0 && cache !== null && cache.expiresAt > Date.now()) return cache.brand;

    inFlight ??= fetchOnce().finally(() => {
      inFlight = null;
    });

    const brand = (await inFlight) ?? fallbackBrand();
    if (cacheTtlMs > 0) cache = { brand, expiresAt: Date.now() + cacheTtlMs };
    return brand;
  };
};
