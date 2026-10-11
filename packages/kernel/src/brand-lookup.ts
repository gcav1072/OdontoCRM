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
  /**
   * Aviso de que **no** se pudo leer la marca efectiva y se está usando el respaldo del
   * código (`BRAND`). Se llama como mucho una vez por minuto.
   *
   * Existe para que el respaldo **no sea silencioso**: si la lectura interna falla
   * —identity caído, un despliegue con la ruta vieja, un secreto distinto, una respuesta
   * que no cumple el contrato— los imprimibles salen con los **colores, las fuentes y el
   * membrete del código**, y sin este aviso nadie se entera. Es el fallo de «cambié el
   * color en el panel y el papel salió igual».
   */
  onFallback?: ((motivo: string) => void) | undefined;
}

/** El tema del contrato a partir de un `BrandTheme` (paleta, tipografías y medidas). */
const themeOf = (brand: BrandTheme): EffectiveBrand['theme'] => ({
  palette: brand.palette,
  typography: brand.typography,
  letterhead: brand.letterhead,
  recipePaper: brand.recipePaper,
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
  /*
   * La marca se pide con una caché **muy corta**: un cambio en el panel de configuración
   * tiene que llegar a los imprimibles en segundos, sin reiniciar nada (ADR 0064). El
   * coste por documento es despreciable —la identidad resuelve fuentes y logo de su lado—,
   * y con un minuto de caché «guardé el cambio» y «el papel sigue igual» convivían.
   */
  const cacheTtlMs = config.cacheTtlMs ?? 1_000;
  const secret = config.INTERNAL_SERVICE_SECRET;
  const onFallback = config.onFallback;

  /** Una lectura: la marca o el motivo por el que no se pudo leer (para el aviso). */
  type Lectura = { ok: true; brand: EffectiveBrand } | { ok: false; motivo: string };

  let cache: { brand: EffectiveBrand; expiresAt: number } | null = null;
  let inFlight: Promise<Lectura> | null = null;
  /** Última vez que se avisó del respaldo: el aviso va como mucho una vez por minuto. */
  let ultimoAviso = 0;

  const avisar = (motivo: string): void => {
    if (onFallback === undefined || Date.now() - ultimoAviso < 60_000) return;
    ultimoAviso = Date.now();
    onFallback(motivo);
  };

  const fetchOnce = async (): Promise<Lectura> => {
    if (secret === undefined) {
      return { ok: false, motivo: 'no hay INTERNAL_SERVICE_SECRET configurado' };
    }

    try {
      const response = await fetch(new URL('/internal/v1/identity/brand', config.IDENTITY_URL), {
        headers: { 'x-internal-token': secret },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) {
        return {
          ok: false,
          motivo: `identity respondió ${String(response.status)} en /internal/v1/identity/brand`,
        };
      }

      const parsed = effectiveBrandSchema.safeParse(await response.json());
      return parsed.success
        ? { ok: true, brand: parsed.data }
        : { ok: false, motivo: 'la marca que sirvió identity no cumple el contrato' };
    } catch (error) {
      return {
        ok: false,
        motivo: `no se pudo leer la marca de identity: ${
          error instanceof Error ? error.message : 'error de red'
        }`,
      };
    }
  };

  return async () => {
    if (cacheTtlMs > 0 && cache !== null && cache.expiresAt > Date.now()) return cache.brand;

    inFlight ??= fetchOnce().finally(() => {
      inFlight = null;
    });

    const lectura = await inFlight;
    if (!lectura.ok) avisar(lectura.motivo);
    const brand = lectura.ok ? lectura.brand : fallbackBrand();
    if (cacheTtlMs > 0) cache = { brand, expiresAt: Date.now() + cacheTtlMs };
    return brand;
  };
};
