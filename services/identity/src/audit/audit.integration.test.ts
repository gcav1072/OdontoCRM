import { AUDIT_EXPORT_COLUMNS, type AuditEventRecord } from '@odontocrm/contracts';
import { generateKeyPairPem, importPrivateKeyPem, type PrivateKey } from '@odontocrm/kernel';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { loadIdentityConfig } from '../config.js';
import { createIdentityDatabase, type IdentityDatabaseHandle } from '../db/client.js';
import { auditEvents } from '../db/schema.js';
import { createIdentityServer } from '../server.js';

/**
 * Auditoría contra PostgreSQL real: lo que la pantalla de la Fase 9 necesita de
 * verdad —el diff antes/después con autor y motivo, la búsqueda por día, entidad
 * y campo, y el CSV con los mismos filtros—.
 *
 * Se ejecuta solo con `TEST_IDENTITY_DATABASE_URL` (o `TEST_DATABASE_URL`, que
 * `npm run test:integration` rellena desde el `.env` de identity); sin ella la
 * suite se salta sola.
 */
const connectionString =
  process.env['TEST_IDENTITY_DATABASE_URL'] ?? process.env['TEST_DATABASE_URL'];
const describeWithDatabase = connectionString === undefined ? describe.skip : describe;

const suffix = String(Date.now()).slice(-6);
const USUARIO = `prueba.auditoria.${suffix}`;
/** Entidad propia de esta corrida: los filtros no dependen de lo que haya en la base. */
const PACIENTE = globalThis.crypto.randomUUID();
const PACIENTE_DIA = globalThis.crypto.randomUUID();

const TELEFONO_ANTES = '+584121111111';
const TELEFONO_DESPUES = '+584142222222';
const MOTIVO = 'el paciente cambió de número';

describeWithDatabase('auditoría (PostgreSQL real)', () => {
  let app: FastifyInstance;
  let database: IdentityDatabaseHandle;
  let privateKey: PrivateKey;

  const headers = (permissions = 'audit:read', roles = 'admin'): Record<string, string> => ({
    'x-user-id': globalThis.crypto.randomUUID(),
    'x-user-username': USUARIO,
    'x-user-roles': roles,
    'x-user-permissions': permissions,
    'x-user-must-change-password': 'false',
    'x-session-id': globalThis.crypto.randomUUID(),
  });

  const insertarEvento = async (input: {
    occurredAt: string;
    entityId: string;
    changedFields: string[];
    before: Record<string, unknown> | null;
    after: Record<string, unknown> | null;
    reason?: string | null;
  }): Promise<void> => {
    await database.db.insert(auditEvents).values({
      occurredAt: new Date(input.occurredAt),
      actorUsername: USUARIO,
      action: 'patient_updated',
      entityType: 'patient',
      entityId: input.entityId,
      summary: 'Paciente editado',
      before: input.before,
      after: input.after,
      changedFields: input.changedFields,
      reason: input.reason ?? null,
      ip: '127.0.0.1',
      userAgent: 'Mozilla/5.0 (prueba)',
      requestId: 'req-auditoria',
    });
  };

  const consultar = async (query: string): Promise<AuditEventRecord[]> => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/audit/events?${query}`,
      headers: headers(),
    });
    expect(response.statusCode).toBe(200);
    return response.json<{ items: AuditEventRecord[] }>().items;
  };

  beforeAll(async () => {
    if (connectionString === undefined) throw new Error('sin TEST_IDENTITY_DATABASE_URL');

    const config = loadIdentityConfig({
      DATABASE_URL: connectionString,
      LOG_LEVEL: 'silent',
      COOKIE_SECURE: 'false',
    });
    database = createIdentityDatabase(config);

    const pair = await generateKeyPairPem();
    privateKey = await importPrivateKeyPem(pair.privatePem);
    app = await createIdentityServer({ config, database, privateKey });

    // El cambio que pide la fase: el teléfono del paciente, con autor y motivo.
    await insertarEvento({
      occurredAt: '2026-10-01T14:03:00.000Z',
      entityId: PACIENTE,
      changedFields: ['phone'],
      before: { phone: TELEFONO_ANTES },
      after: { phone: TELEFONO_DESPUES },
      reason: MOTIVO,
    });
    // Segundo cambio de la misma ficha, en otro campo: sirve para el filtro por campo.
    await insertarEvento({
      occurredAt: '2026-10-02T14:03:00.000Z',
      entityId: PACIENTE,
      changedFields: ['address'],
      before: { address: 'Av. Bolívar' },
      after: { address: 'Av. Sucre' },
      reason: null,
    });
    // Dos instantes del mismo día de Venezuela: la 01:00 y las 10:00.
    await insertarEvento({
      occurredAt: '2026-10-03T01:00:00.000Z',
      entityId: PACIENTE_DIA,
      changedFields: ['phone'],
      before: { phone: '+580000000001' },
      after: { phone: '+580000000002' },
    });
    await insertarEvento({
      occurredAt: '2026-10-03T14:00:00.000Z',
      entityId: PACIENTE_DIA,
      changedFields: ['phone'],
      before: { phone: '+580000000003' },
      after: { phone: '+580000000004' },
    });
  });

  afterAll(async () => {
    // Solo las filas de esta corrida: el actor es único por ejecución.
    await database.db.delete(auditEvents).where(eq(auditEvents.actorUsername, USUARIO));
    await app.close();
  });

  it('el cambio de un teléfono llega con el valor anterior, el nuevo, el autor y el motivo', async () => {
    const items = await consultar(
      `actorUsername=${USUARIO}&entityType=patient&entityId=${PACIENTE}&field=phone`,
    );

    expect(items).toHaveLength(1);
    const evento = items[0];
    expect(evento?.before).toEqual({ phone: TELEFONO_ANTES });
    expect(evento?.after).toEqual({ phone: TELEFONO_DESPUES });
    expect(evento?.actorUsername).toBe(USUARIO);
    expect(evento?.reason).toBe(MOTIVO);
    expect(evento?.changedFields).toEqual(['phone']);
  });

  it('una fecha suelta trae el día completo de Venezuela, no desde la medianoche UTC', async () => {
    // 2026-10-03T01:00Z es el 2 de octubre a las 21:00 en Caracas: queda fuera del día 3.
    const delDia3 = await consultar(`entityId=${PACIENTE_DIA}&from=2026-10-03&to=2026-10-03`);
    expect(delDia3.map((evento) => evento.after?.['phone'])).toEqual(['+580000000004']);

    // Y sí aparece al buscar el día 2, que es el día al que pertenece en la clínica.
    const delDia2 = await consultar(`entityId=${PACIENTE_DIA}&from=2026-10-02&to=2026-10-02`);
    expect(delDia2.map((evento) => evento.after?.['phone'])).toEqual(['+580000000002']);
  });

  it('el CSV baja los mismos filtros, con la fila del diff en texto legible', async () => {
    const response = await app.inject({
      method: 'GET',
      url:
        '/api/v1/audit/events/export.csv' + `?entityId=${PACIENTE}&from=2026-10-01&to=2026-10-01`,
      headers: headers(),
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/csv');
    expect(response.headers['content-disposition']).toBe(
      'attachment; filename="auditoria-2026-10-01_2026-10-01.csv"',
    );

    const csv = response.body;
    // BOM UTF-8: sin él, Excel en Windows rompe los acentos.
    expect(csv.startsWith('\uFEFF')).toBe(true);
    expect(csv.split('\r\n')[0]).toContain(AUDIT_EXPORT_COLUMNS.map((c) => c.label).join(';'));
    expect(csv).toContain(TELEFONO_ANTES);
    expect(csv).toContain(TELEFONO_DESPUES);
    expect(csv).toContain(USUARIO);
    expect(csv).toContain(MOTIVO);
    // Del día 1 solo hay un evento de esta ficha: el del teléfono.
    expect(csv).not.toContain('Av. Sucre');
  });

  it('la exportación exige el permiso de auditoría', async () => {
    // El rol va sin `audit:read` (el rol concede permisos además de las cabeceras).
    const sinPermiso = await app.inject({
      method: 'GET',
      url: '/api/v1/audit/events/export.csv',
      headers: headers('patients:read', 'secretario'),
    });
    expect(sinPermiso.statusCode).toBe(403);

    const sinSesion = await app.inject({
      method: 'GET',
      url: '/api/v1/audit/events/export.csv',
    });
    expect(sinSesion.statusCode).toBe(401);
  });
});
