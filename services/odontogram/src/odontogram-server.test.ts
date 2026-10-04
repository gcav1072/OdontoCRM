import { ROLE_PERMISSIONS } from '@odontocrm/contracts';
import type pg from 'pg';
import { afterEach, describe, expect, it } from 'vitest';

import { loadOdontogramConfig } from './config.js';
import type { OdontogramDatabaseHandle } from './db/client.js';
import { createOdontogramServer } from './server.js';

/**
 * Servidor del odontograma sin base de datos: comprueba el **contrato de rutas**
 * (las siete públicas y la interna, en sus rutas exactas), el **RBAC** —la
 * secretaría imprime pero no escribe— y que la validación corta antes de tocar la
 * base. La cadena de consulta simulada devuelve siempre `[]`, así que los caminos
 * «no hay odontograma» se ejercitan de verdad (`exists: false`, resumen a cero).
 */

interface ConsultaFalsa extends Promise<unknown[]> {
  select: () => ConsultaFalsa;
  insert: () => ConsultaFalsa;
  update: () => ConsultaFalsa;
  delete: () => ConsultaFalsa;
  from: () => ConsultaFalsa;
  where: () => ConsultaFalsa;
  orderBy: () => ConsultaFalsa;
  limit: () => ConsultaFalsa;
  values: () => ConsultaFalsa;
  set: () => ConsultaFalsa;
  returning: () => ConsultaFalsa;
  onConflictDoNothing: () => ConsultaFalsa;
  transaction: (fn: (tx: ConsultaFalsa) => Promise<unknown>) => Promise<unknown>;
}

/** Cadena encadenable que resuelve a una lista vacía, como una base sin filas. */
const consultaVacia = (): ConsultaFalsa => {
  const promesa = Promise.resolve([]) as unknown as ConsultaFalsa;
  const misma = (): ConsultaFalsa => promesa;
  promesa.select = () => consultaVacia();
  promesa.insert = () => consultaVacia();
  promesa.update = () => consultaVacia();
  promesa.delete = () => consultaVacia();
  promesa.from = misma;
  promesa.where = misma;
  promesa.orderBy = misma;
  promesa.limit = misma;
  promesa.values = misma;
  promesa.set = misma;
  promesa.returning = misma;
  promesa.onConflictDoNothing = misma;
  promesa.transaction = (fn) => fn(consultaVacia());
  return promesa;
};

const baseSimulada = (): OdontogramDatabaseHandle =>
  ({
    db: consultaVacia(),
    pool: { query: () => Promise.resolve({ rows: [] }) } as unknown as pg.Pool,
    close: () => Promise.resolve(),
  }) as unknown as OdontogramDatabaseHandle;

const baseEnv = {
  DATABASE_URL: 'postgres://odonto_odontogram:clave@127.0.0.1:5432/odonto_odontogram',
  LOG_LEVEL: 'silent',
  INTERNAL_SERVICE_SECRET: 'secreto-interno-de-prueba-1234',
};

/** Cabeceras que en producción inyecta el gateway tras validar el JWT. */
const identidad = (
  role: 'admin' | 'secretario' | 'odontologo',
  overrides: { mustChangePassword?: string } = {},
): Record<string, string> => ({
  'x-user-id': globalThis.crypto.randomUUID(),
  'x-user-username': role,
  'x-user-roles': role,
  'x-user-permissions': ROLE_PERMISSIONS[role].join(','),
  'x-user-must-change-password': overrides.mustChangePassword ?? 'false',
  'x-session-id': globalThis.crypto.randomUUID(),
});

const abiertos: Awaited<ReturnType<typeof createOdontogramServer>>[] = [];

const abrirServidor = async (
  env: Record<string, string | undefined> = {},
): Promise<Awaited<ReturnType<typeof createOdontogramServer>>> => {
  const app = await createOdontogramServer({
    config: loadOdontogramConfig({ ...baseEnv, ...env }),
    database: baseSimulada(),
    patientLookup: () => Promise.resolve(null),
  });
  abiertos.push(app);
  return app;
};

afterEach(async () => {
  await Promise.all(abiertos.splice(0).map((app) => app.close()));
});

const paciente = globalThis.crypto.randomUUID();

describe('servidor del odontograma', () => {
  it('/health se identifica como el servicio odontogram', async () => {
    const app = await abrirServidor();
    const response = await app.inject({ method: 'GET', url: '/health' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      service: 'odontogram',
      version: '0.1.0',
      status: 'ok',
    });
  });

  it('el odontograma que todavía no existe se lee como exists: false, nunca 404', async () => {
    const app = await abrirServidor();
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/odontogram/patients/${paciente}`,
      headers: identidad('secretario'),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ exists: false, patientId: paciente, patient: null });
  });

  it('las rutas públicas exigen identidad y responden problem+json', async () => {
    const app = await abrirServidor();

    const rutas: Array<{ method: 'GET' | 'PUT' | 'POST' | 'DELETE'; url: string }> = [
      { method: 'GET', url: `/api/v1/odontogram/patients/${paciente}` },
      { method: 'PUT', url: `/api/v1/odontogram/patients/${paciente}/findings` },
      { method: 'POST', url: `/api/v1/odontogram/patients/${paciente}/findings/batch` },
      { method: 'DELETE', url: `/api/v1/odontogram/patients/${paciente}/findings` },
      { method: 'DELETE', url: `/api/v1/odontogram/patients/${paciente}/surfaces/16/occlusal` },
      { method: 'GET', url: `/api/v1/odontogram/patients/${paciente}/history` },
      { method: 'POST', url: `/api/v1/odontogram/patients/${paciente}/printed` },
    ];

    for (const ruta of rutas) {
      const response = await app.inject(ruta);
      expect(response.statusCode, `${ruta.method} ${ruta.url}`).toBe(401);
      expect(response.headers['content-type']).toContain('application/problem+json');
    }
  });

  it('la secretaría lee e imprime, pero no escribe hallazgos', async () => {
    const app = await abrirServidor();
    const cabeceras = identidad('secretario');
    const cuerpo = { toothNumber: 16, surface: 'occlusal', condition: 'caries' };

    // Imprimir es leer: pasa el RBAC y llega al servicio (que no encuentra boca).
    const impresion = await app.inject({
      method: 'POST',
      url: `/api/v1/odontogram/patients/${paciente}/printed`,
      headers: cabeceras,
      payload: {},
    });
    expect(impresion.statusCode).toBe(404);
    expect(impresion.json()).toMatchObject({ detail: expect.stringContaining('odontograma') });

    const historial = await app.inject({
      method: 'GET',
      url: `/api/v1/odontogram/patients/${paciente}/history`,
      headers: cabeceras,
    });
    expect(historial.statusCode).toBe(404);

    // Y escribir sigue siendo del odontólogo y del admin.
    const escrituras: Array<{
      method: 'PUT' | 'POST' | 'DELETE';
      url: string;
      payload?: Record<string, unknown>;
    }> = [
      { method: 'PUT', url: `/api/v1/odontogram/patients/${paciente}/findings`, payload: cuerpo },
      {
        method: 'POST',
        url: `/api/v1/odontogram/patients/${paciente}/findings/batch`,
        payload: { findings: [cuerpo] },
      },
      {
        method: 'DELETE',
        url: `/api/v1/odontogram/patients/${paciente}/findings?toothNumber=16&surface=occlusal&condition=caries`,
      },
      { method: 'DELETE', url: `/api/v1/odontogram/patients/${paciente}/surfaces/16/occlusal` },
    ];

    for (const escritura of escrituras) {
      const response = await app.inject({ ...escritura, headers: cabeceras });
      expect(response.statusCode, `${escritura.method} ${escritura.url}`).toBe(403);
    }
    // La boca simulada está vacía, así que el odontólogo llega al servicio (404) y
    // nunca a un 403.
    for (const escritura of escrituras) {
      const response = await app.inject({ ...escritura, headers: identidad('odontologo') });
      expect(response.statusCode, `${escritura.method} ${escritura.url}`).toBe(404);
    }
  });

  it('bloquea todo mientras el usuario deba cambiar su contraseña', async () => {
    const app = await abrirServidor();
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/odontogram/patients/${paciente}`,
      headers: identidad('odontologo', { mustChangePassword: 'true' }),
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ detail: expect.stringContaining('contraseña') });
  });

  it('valida los hallazgos con el contrato antes de tocar la base', async () => {
    const app = await abrirServidor();
    const cabeceras = identidad('odontologo');

    const piezaInvalida = await app.inject({
      method: 'PUT',
      url: `/api/v1/odontogram/patients/${paciente}/findings`,
      headers: cabeceras,
      payload: { toothNumber: 99, surface: 'occlusal', condition: 'caries' },
    });
    expect(piezaInvalida.statusCode).toBe(400);

    // Una condición de pieza completa no admite cara (y al revés).
    const caraDeMas = await app.inject({
      method: 'PUT',
      url: `/api/v1/odontogram/patients/${paciente}/findings`,
      headers: cabeceras,
      payload: { toothNumber: 16, surface: 'occlusal', condition: 'ausente' },
    });
    expect(caraDeMas.statusCode).toBe(400);

    const cuerpoInvalido = await app.inject({
      method: 'POST',
      url: `/api/v1/odontogram/patients/${paciente}/findings/batch`,
      headers: cabeceras,
      payload: { findings: [] },
    });
    expect(cuerpoInvalido.statusCode).toBe(400);

    const caraInvalida = await app.inject({
      method: 'DELETE',
      url: `/api/v1/odontogram/patients/${paciente}/surfaces/16/nose`,
      headers: cabeceras,
    });
    expect(caraInvalida.statusCode).toBe(400);

    const limiteExcesivo = await app.inject({
      method: 'GET',
      url: `/api/v1/odontogram/patients/${paciente}/history?limit=9999`,
      headers: cabeceras,
    });
    expect(limiteExcesivo.statusCode).toBe(400);

    const borradoSinPieza = await app.inject({
      method: 'DELETE',
      url: `/api/v1/odontogram/patients/${paciente}/findings?condition=caries`,
      headers: cabeceras,
    });
    expect(borradoSinPieza.statusCode).toBe(400);
  });
});

describe('rutas internas del odontograma', () => {
  const url = `/internal/v1/odontogram/patients/${paciente}/summary`;

  it('exigen el secreto compartido', async () => {
    const app = await abrirServidor();

    expect((await app.inject({ method: 'GET', url })).statusCode).toBe(403);
    expect(
      (
        await app.inject({
          method: 'GET',
          url,
          headers: { 'x-internal-token': 'secreto-equivocado-1234567890' },
        })
      ).statusCode,
    ).toBe(403);
  });

  it('quedan deshabilitadas si el entorno no define el secreto', async () => {
    const app = await abrirServidor({ INTERNAL_SERVICE_SECRET: undefined });
    const response = await app.inject({
      method: 'GET',
      url,
      headers: { 'x-internal-token': 'secreto-interno-de-prueba-1234' },
    });

    expect(response.statusCode).toBe(403);
  });

  it('resumen de una boca sin odontograma: a cero y sin fallar', async () => {
    const app = await abrirServidor();
    const response = await app.inject({
      method: 'GET',
      url,
      headers: { 'x-internal-token': 'secreto-interno-de-prueba-1234' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      patientId: paciente,
      hasOdontogram: false,
      affectedTeeth: 0,
      conditionCounts: {},
      pendingCount: 0,
      completedCount: 0,
    });
  });
});
