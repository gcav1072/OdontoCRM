/**
 * Cliente del **licenciamiento** para el bot de administración del consultorio.
 *
 * El bot corre en el servidor del consultorio y **solo verifica** licencias: activar una
 * licencia es comprobar una firma con la clave pública, no firmar nada. La clave privada vive
 * en la máquina del proveedor y aquí no existe.
 *
 * Dos rutas de identity, las que implementa el frente de licenciamiento:
 *
 *   · `GET /internal/v1/licensing/status`   — vista completa (instalación, consultorio y la
 *     solicitud ya armada). Exige la cabecera `x-internal-token` con el `INTERNAL_SERVICE_SECRET`
 *     que comparten los servicios y que el bot ya recibe por sus archivos de entorno.
 *   · `GET /api/v1/licensing/public`       — vista mínima, sin sesión. Es el **respaldo**
 *     cuando no hay secreto interno (una instalación a medio configurar): alcanza para avisar
 *     del vencimiento, aunque no para armar la solicitud.
 *   · `POST /internal/v1/licensing/activate` — activa el `.lic` firmado; responde la vista
 *     completa ya actualizada.
 *
 * Aquí no se imprime ni se registra ningún secreto: los errores de red solo llevan el motivo
 * (ECONNREFUSED, tiempo agotado), nunca la cabecera ni la URL con credenciales (no las hay).
 */
import {
  adminLicensingViewSchema,
  publicLicensingViewSchema,
  LICENSE_ISSUER,
} from '@odontocrm/contracts';

import { entornoRaiz, leerEnv, rutaEnvDe, SERVICIOS } from './servicios.mjs';

const TIMEOUT_MS = 5_000;
const IDENTITY_POR_DEFECTO = 'http://127.0.0.1:4001';
/** Tope del archivo `.lic`: es un JWT compacto, unos pocos KB. */
export const MAX_LICENCIA_BYTES = 64 * 1024;

const servicio = (nombre) => SERVICIOS.find((candidato) => candidato.name === nombre);

const limpiar = (valor) => (typeof valor === 'string' ? valor.trim() : '');

const sinBarraFinal = (url) => url.replace(/\/+$/u, '');

/**
 * `IDENTITY_URL` efectiva: la del proceso (systemd ya carga los entornos), la del `.env` de la
 * raíz y, por último, la del propio servicio; si no hay ninguna, el loopback de siempre.
 */
export const resolverIdentityUrl = () => {
  const deEntorno = sinBarraFinal(limpiar(process.env.IDENTITY_URL));
  if (deEntorno !== '') return deEntorno;

  const deRaiz = sinBarraFinal(limpiar(entornoRaiz().IDENTITY_URL));
  if (deRaiz !== '') return deRaiz;

  const identidad = servicio('identity');
  if (identidad !== undefined) {
    const propio = sinBarraFinal(limpiar(leerEnv(rutaEnvDe(identidad)).IDENTITY_URL));
    if (propio !== '') return propio;
  }

  return IDENTITY_POR_DEFECTO;
};

/**
 * `INTERNAL_SERVICE_SECRET` efectivo. En producción llega por `process.env` (la unidad de
 * systemd carga `odontocrm.env` y el entorno de notificaciones). En desarrollo el bot se
 * arranca a mano: entonces se lee del `.env` de notificaciones —el que guarda el token del
 * bot— y del de identity, que lo comparten todos los servicios.
 */
export const resolverSecretoInterno = () => {
  const deEntorno = limpiar(process.env.INTERNAL_SERVICE_SECRET);
  if (deEntorno !== '') return deEntorno;

  for (const nombre of ['notifications', 'identity']) {
    const candidato = servicio(nombre);
    if (candidato === undefined) continue;
    const valor = limpiar(leerEnv(rutaEnvDe(candidato)).INTERNAL_SERVICE_SECRET);
    if (valor !== '') return valor;
  }

  return null;
};

/** El motivo de un fallo de red, en una línea y sin secretos. */
const motivoDe = (fallo) => {
  if (fallo instanceof Error) {
    if (fallo.name === 'TimeoutError') return 'tiempo de espera agotado';
    if (fallo.name === 'AbortError') return 'petición cancelada';
    // `fetch` envuelve el error real en `cause` (ECONNREFUSED, ENOTFOUND…): es lo que orienta.
    const causa = fallo.cause;
    if (causa instanceof Error && typeof causa.code === 'string') return causa.code;
    return fallo.message;
  }
  return String(fallo);
};

/**
 * Petición JSON a identity con tiempo máximo. Devuelve `{ ok: true, cuerpo }` o
 * `{ ok: false, mensaje }`; nunca lanza, para que el bot pueda contestar algo útil.
 */
const pedir = async (url, opciones = {}) => {
  try {
    const respuesta = await fetch(url, {
      method: opciones.method ?? 'GET',
      headers: {
        accept: 'application/json',
        ...(opciones.body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(opciones.headers ?? {}),
      },
      ...(opciones.body === undefined ? {} : { body: JSON.stringify(opciones.body) }),
      signal: AbortSignal.timeout(opciones.timeoutMs ?? TIMEOUT_MS),
    });
    const cuerpo = await respuesta.json().catch(() => null);
    if (!respuesta.ok) {
      // identity responde RFC 7807: el `detail` ya viene en español y sin secretos.
      const detalle =
        typeof cuerpo?.detail === 'string' && cuerpo.detail !== ''
          ? cuerpo.detail
          : `HTTP ${String(respuesta.status)}`;
      return { ok: false, mensaje: detalle };
    }
    return { ok: true, cuerpo };
  } catch (fallo) {
    return { ok: false, mensaje: `no pude hablar con identity (${motivoDe(fallo)})` };
  }
};

/**
 * Estado por la ruta **pública** (sin secreto). Devuelve `{ ok, vista, completo: false }` o
 * `{ ok: false, mensaje }`. Es lo que usa el tablero de estado para no depender de la clave
 * interna.
 */
export const consultarLicenciaPublica = async () => {
  const resultado = await pedir(`${resolverIdentityUrl()}/api/v1/licensing/public`);
  if (!resultado.ok) return resultado;

  const vista = publicLicensingViewSchema.safeParse(resultado.cuerpo);
  if (!vista.success) {
    return { ok: false, mensaje: 'identity respondió algo que no entiendo como licencia' };
  }
  return { ok: true, vista: vista.data, completo: false };
};

/**
 * Estado **completo** para el comando `/licencia`: primero la ruta interna (instalación,
 * consultorio y solicitud); si no hay `INTERNAL_SERVICE_SECRET`, la pública, que alcanza para
 * avisar del vencimiento. Un fallo de la interna **no** se tapa con la pública: se devuelve el
 * motivo, porque puede ser justo lo que hay que arreglar.
 */
export const estadoLicencia = async () => {
  const secreto = resolverSecretoInterno();
  if (secreto === null) return consultarLicenciaPublica();

  const resultado = await pedir(`${resolverIdentityUrl()}/internal/v1/licensing/status`, {
    headers: { 'x-internal-token': secreto },
  });
  if (!resultado.ok) return resultado;

  const vista = adminLicensingViewSchema.safeParse(resultado.cuerpo);
  if (!vista.success) {
    return { ok: false, mensaje: 'identity respondió algo que no entiendo como licencia' };
  }
  return { ok: true, vista: vista.data, completo: true };
};

/**
 * Activa una licencia (el texto del `.lic`) por la ruta interna. El `motivo` queda en la
 * auditoría de identity: así se sabe que la activación la pidió el bot de administración.
 */
export const activarLicencia = async (licencia) => {
  const token = limpiar(licencia);
  if (token === '') return { ok: false, mensaje: 'la licencia está vacía' };

  const secreto = resolverSecretoInterno();
  if (secreto === null) {
    return {
      ok: false,
      mensaje:
        'falta INTERNAL_SERVICE_SECRET: sin secreto interno no puedo activar desde el bot (usa el panel /licencia)',
    };
  }

  const resultado = await pedir(`${resolverIdentityUrl()}/internal/v1/licensing/activate`, {
    method: 'POST',
    headers: { 'x-internal-token': secreto },
    body: { licencia: token, motivo: 'bot de administración' },
  });
  if (!resultado.ok) return resultado;

  const vista = adminLicensingViewSchema.safeParse(resultado.cuerpo);
  if (!vista.success) {
    return {
      ok: false,
      mensaje: 'identity activó la licencia pero respondió una vista inesperada',
    };
  }
  return { ok: true, vista: vista.data, completo: true };
};

const payloadDe = (token) => {
  try {
    const partes = token.split('.');
    if (partes.length !== 3) return null;
    const normalizado = partes[1].replaceAll('-', '+').replaceAll('_', '/');
    const relleno = '='.repeat((4 - (normalizado.length % 4)) % 4);
    const json = Buffer.from(normalizado + relleno, 'base64').toString('utf8');
    return JSON.parse(json);
  } catch {
    return null;
  }
};

/**
 * ¿El texto parece una licencia de OdontoCRM? Es un JWT compacto con tres partes y el emisor
 * de licencias dentro. Se comprueba **antes** de llamar a identity para responder al instante
 * cuando el archivo reenviado no es el que era (una foto, un PDF, un token de sesión).
 */
export const pareceLicencia = (texto) => {
  const limpio = limpiar(texto);
  if (limpio.length < 100 || Buffer.byteLength(limpio, 'utf8') > MAX_LICENCIA_BYTES) return false;
  const payload = payloadDe(limpio);
  return payload !== null && payload.iss === LICENSE_ISSUER;
};
