import { afterEach, describe, expect, it, vi } from 'vitest';

import { createInternalClients, InternalRequestError } from './internal-client.js';
import type { NotificationsConfig } from './config.js';

/**
 * Pruebas de las llamadas internas del servicio de notificaciones (las que el bot
 * usa para dar de alta al paciente y crear su solicitud).
 *
 * Nacen de un fallo real: a mitad del asistente, con el paciente escribiendo su
 * cédula, el servicio de pacientes se estaba reiniciando y la llamada murió con
 * `ECONNREFUSED 127.0.0.1:4002`. El paciente se quedó sin respuesta. Aquí se fija
 * qué se reintenta y qué no:
 *
 *  - **Lecturas**: se repiten siempre que el fallo sea pasajero (la operación es
 *    idempotente).
 *  - **Escrituras**: solo se repiten si la petición **no llegó a salir**
 *    (`ECONNREFUSED`), porque repetir un alta o una solicitud a ciegas podría crear
 *    dos tickets.
 *  - Un 404 o un 4xx no se reintentan nunca: la respuesta del servidor es la buena.
 */

const config = {
  PATIENTS_URL: 'http://127.0.0.1:4002',
  SCHEDULING_URL: 'http://127.0.0.1:4003',
  INTERNAL_SERVICE_SECRET: 'secreto-de-prueba',
} as unknown as NotificationsConfig;

/** Error como el que lanza `fetch` cuando nadie escucha en el puerto. */
const rechazoDeConexion = (): TypeError => {
  const error = new TypeError('fetch failed');
  (error as { cause?: unknown }).cause = { code: 'ECONNREFUSED' };
  return error;
};

/** Error de conexión cortada: la petición pudo llegar (no es seguro repetirla). */
const conexionCortada = (): TypeError => {
  const error = new TypeError('fetch failed');
  (error as { cause?: unknown }).cause = { code: 'ECONNRESET' };
  return error;
};

const respuesta = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

const espia = () => vi.fn<(url: string, init?: RequestInit) => Promise<Response>>();

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('lecturas internas', () => {
  it('reintenta cuando el servicio se está reiniciando y acierta al segundo intento', async () => {
    const fetchFalso = espia()
      .mockRejectedValueOnce(rechazoDeConexion())
      .mockResolvedValueOnce(
        respuesta(404, { detail: 'no existe' }), // el 404 significa «paciente nuevo»
      );
    vi.stubGlobal('fetch', fetchFalso);

    const clients = createInternalClients(config);
    const encontrado = await clients.findPatientByDocument('V', '12345678');

    expect(encontrado).toBeNull();
    expect(fetchFalso).toHaveBeenCalledTimes(2);
  });

  it('reintenta un 5xx y se rinde tras tres intentos', async () => {
    // Una respuesta nueva por intento: el cuerpo de un `Response` solo se lee una vez.
    const fetchFalso = espia().mockImplementation(async () =>
      respuesta(503, { detail: 'sin conexión' }),
    );
    vi.stubGlobal('fetch', fetchFalso);

    const clients = createInternalClients(config);
    await expect(clients.findPatientByDocument('V', '12345678')).rejects.toBeInstanceOf(
      InternalRequestError,
    );
    expect(fetchFalso).toHaveBeenCalledTimes(3);
  });

  it('no reintenta un 4xx: la respuesta del servidor es la buena', async () => {
    const fetchFalso = espia().mockImplementation(async () =>
      respuesta(400, { detail: 'documento inválido' }),
    );
    vi.stubGlobal('fetch', fetchFalso);

    const clients = createInternalClients(config);
    await expect(clients.findPatientByDocument('V', 'x')).rejects.toMatchObject({ status: 400 });
    expect(fetchFalso).toHaveBeenCalledTimes(1);
  });
});

describe('escrituras internas', () => {
  it('una conexión cortada NO se repite: la solicitud pudo llegar y se crearía otra', async () => {
    const fetchFalso = espia().mockRejectedValue(conexionCortada());
    vi.stubGlobal('fetch', fetchFalso);

    const clients = createInternalClients(config);
    await expect(
      clients.createRequest({
        patientId: 'pac-1',
        patientName: 'María Pérez',
        channel: 'telegram',
        reason: 'control',
      }),
    ).rejects.toBeInstanceOf(TypeError);
    expect(fetchFalso).toHaveBeenCalledTimes(1);
  });

  it('un rechazo de conexión sí se repite: la petición no llegó a salir', async () => {
    const fetchFalso = espia()
      .mockRejectedValueOnce(rechazoDeConexion())
      .mockResolvedValueOnce(
        respuesta(201, {
          id: 'req-1',
          ticket: '#000001',
          status: 'en_espera_cita',
        }),
      );
    vi.stubGlobal('fetch', fetchFalso);

    const clients = createInternalClients(config);
    const solicitud = await clients.createRequest({
      patientId: 'pac-1',
      patientName: 'María Pérez',
      channel: 'telegram',
      reason: 'control',
    });

    expect(solicitud.ticket).toBe('#000001');
    expect(fetchFalso).toHaveBeenCalledTimes(2);
  });
});
