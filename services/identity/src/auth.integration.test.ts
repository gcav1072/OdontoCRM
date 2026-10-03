import { REFRESH_COOKIE_NAME } from '@odontocrm/contracts';
import {
  generateKeyPairPem,
  hashPassword,
  importPrivateKeyPem,
  type PrivateKey,
} from '@odontocrm/kernel';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { loadIdentityConfig } from './config.js';
import { createIdentityDatabase, type IdentityDatabaseHandle } from './db/client.js';
import { createIdentityServer } from './server.js';
import { auditEvents, userRoles, users } from './db/schema.js';
import { eq, inArray, sql } from 'drizzle-orm';

/**
 * Pruebas de integración de la autenticación contra PostgreSQL real. Se ejecutan
 * solo con `TEST_DATABASE_URL` (ver `npm run test:integration`):
 * login, bloqueo por intentos, rotación del refresco con detección de reuso,
 * cierre de sesión y rastro en la auditoría.
 */
const connectionString = process.env['TEST_DATABASE_URL'];
const describeWithDatabase = connectionString === undefined ? describe.skip : describe;

const PASSWORD = 'prueba-odontocrm-2026';
const WRONG_PASSWORD = 'otra-clave-cualquiera';

const suffix = String(Date.now()).slice(-6);
const SECRETARY = `prueba.secre.${suffix}`;
const LOCKED = `prueba.lock.${suffix}`;

describeWithDatabase('autenticación (PostgreSQL real)', () => {
  let app: FastifyInstance;
  let database: IdentityDatabaseHandle;
  let privateKey: PrivateKey;
  let adminId = '';
  let adminUsername = '';

  const identityHeaders = (roles: string, permissions: string): Record<string, string> => ({
    'x-user-id': adminId,
    'x-user-username': adminUsername,
    'x-user-roles': roles,
    'x-user-permissions': permissions,
    'x-user-must-change-password': 'false',
    'x-session-id': globalThis.crypto.randomUUID(),
  });

  const login = async (
    username: string,
    password: string,
  ): Promise<Awaited<ReturnType<FastifyInstance['inject']>>> =>
    app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { username, password },
    });

  const refreshCookieOf = (response: { cookies: Array<{ name: string; value: string }> }):
    | string
    | undefined => response.cookies.find((cookie) => cookie.name === REFRESH_COOKIE_NAME)?.value;

  const refreshWith = async (token: string) =>
    app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      headers: { cookie: `${REFRESH_COOKIE_NAME}=${token}` },
    });

  beforeAll(async () => {
    if (connectionString === undefined) throw new Error('sin TEST_DATABASE_URL');

    const config = loadIdentityConfig({
      DATABASE_URL: connectionString,
      LOG_LEVEL: 'silent',
      COOKIE_SECURE: 'false',
    });
    database = createIdentityDatabase(config);

    const pair = await generateKeyPairPem();
    privateKey = await importPrivateKeyPem(pair.privatePem);
    app = await createIdentityServer({ config, database, privateKey });

    // Usuario administrador de prueba (la base de integración ya tiene las tablas).
    adminUsername = `prueba.admin.${suffix}`;
    const inserted = await database.db
      .insert(users)
      .values({ username: adminUsername, fullName: 'Admin de prueba', passwordHash: await hashPassword(PASSWORD) })
      .returning({ id: users.id });
    adminId = inserted[0]?.id ?? '';
    await database.db.insert(userRoles).values({ userId: adminId, role: 'admin' });

    const secretary = await database.db
      .insert(users)
      .values({ username: SECRETARY, fullName: 'Secretaria de prueba', passwordHash: await hashPassword(PASSWORD) })
      .returning({ id: users.id });
    await database.db
      .insert(userRoles)
      .values({ userId: secretary[0]?.id ?? '', role: 'secretario' });
  });

  afterAll(async () => {
    const usernames = [adminUsername, SECRETARY, LOCKED, `prueba.pass.${suffix}`];
    await database.db
      .delete(auditEvents)
      .where(
        sql`${auditEvents.actorUsername} in (${sql.join(
          usernames.map((name) => sql`${name}`),
          sql`, `,
        )})`,
      );
    // Los tokens de refresco se van en cascada con el usuario.
    await database.db.delete(users).where(inArray(users.username, usernames));
    await app.close();
  });

  it('inicia sesión, devuelve el token y la cookie de refresco, y lo audita', async () => {
    const response = await login(adminUsername, PASSWORD);
    const body = response.json<{
      accessToken: string;
      expiresIn: number;
      user: { username: string; roles: string[]; permissions: string[] };
    }>();

    expect(response.statusCode).toBe(200);
    expect(body.accessToken.split('.')).toHaveLength(3);
    expect(body.expiresIn).toBe(15 * 60);
    expect(body.user.roles).toEqual(['admin']);
    expect(body.user.permissions).toContain('users:manage');

    const cookie = refreshCookieOf(response);
    expect(cookie).toBeTruthy();

    const audited = await database.db
      .select({ action: auditEvents.action })
      .from(auditEvents)
      .where(eq(auditEvents.actorUsername, adminUsername));
    expect(audited.map((row) => row.action)).toContain('login');
  });

  it('rechaza credenciales incorrectas sin revelar si el usuario existe', async () => {
    const response = await login(adminUsername, WRONG_PASSWORD);
    expect(response.statusCode).toBe(401);
    expect(response.json<{ detail: string }>().detail).toBe('Usuario o contraseña incorrectos');

    const unknown = await login(`no.existe.${suffix}`, PASSWORD);
    expect(unknown.statusCode).toBe(401);
    expect(unknown.json<{ detail: string }>().detail).toBe('Usuario o contraseña incorrectos');
  });

  it('bloquea la cuenta 15 minutos después de 5 intentos fallidos', async () => {
    await database.db
      .insert(users)
      .values({
        username: LOCKED,
        fullName: 'Usuario a bloquear',
        passwordHash: await hashPassword(PASSWORD),
      })
      .returning({ id: users.id });

    for (let attempt = 1; attempt <= 4; attempt += 1) {
      const response = await login(LOCKED, WRONG_PASSWORD);
      expect(response.statusCode).toBe(401);
    }

    const fifth = await login(LOCKED, WRONG_PASSWORD);
    expect(fifth.statusCode).toBe(423);
    expect(fifth.json<{ detail: string }>().detail).toContain('bloqueada');

    // Aunque escriba la contraseña correcta, sigue bloqueado.
    const correct = await login(LOCKED, PASSWORD);
    expect(correct.statusCode).toBe(423);

    const rows = await database.db
      .select({ lockedUntil: users.lockedUntil })
      .from(users)
      .where(eq(users.username, LOCKED));
    const lockedUntil = rows[0]?.lockedUntil;
    expect(lockedUntil).not.toBeNull();
    expect((lockedUntil?.getTime() ?? 0) - Date.now()).toBeGreaterThan(13 * 60 * 1000);
  });

  it('rota el token de refresco y detecta el reuso revocando la sesión', async () => {
    const first = await login(adminUsername, PASSWORD);
    const firstCookie = refreshCookieOf(first);
    expect(firstCookie).toBeTruthy();

    const rotated = await refreshWith(firstCookie ?? '');
    expect(rotated.statusCode).toBe(200);
    const rotatedCookie = refreshCookieOf(rotated);
    expect(rotatedCookie).toBeTruthy();
    expect(rotatedCookie).not.toBe(firstCookie);

    // El token nuevo sirve…
    const again = await refreshWith(rotatedCookie ?? '');
    expect(again.statusCode).toBe(200);

    // …y el viejo solo dentro de la ventana de gracia (carrera entre pestañas).
    const withinGrace = await refreshWith(firstCookie ?? '');
    expect(withinGrace.statusCode).toBe(200);

    // Forzamos que la rotación sea antigua para simular un reuso real
    // (dentro de la ventana de gracia el token viejo se acepta a propósito).
    await database.db.execute(
      sql`update refresh_tokens set rotated_at = now() - interval '5 minutes' where rotated_at is not null`,
    );

    const replay = await refreshWith(firstCookie ?? '');
    expect(replay.statusCode).toBe(401);
    expect(replay.json<{ detail: string }>().detail).toContain('seguridad');

    // Toda la familia quedó revocada: el token más reciente tampoco sirve.
    const afterReuse = await refreshWith(rotatedCookie ?? '');
    expect(afterReuse.statusCode).toBe(401);

    const audited = await database.db
      .select({ action: auditEvents.action })
      .from(auditEvents)
      .where(eq(auditEvents.action, 'refresh_reuse_detected'));
    expect(audited.length).toBeGreaterThan(0);
  });

  it('cierra la sesión y deja de aceptar el refresco', async () => {
    const session = await login(adminUsername, PASSWORD);
    const cookie = refreshCookieOf(session);

    const logout = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      headers: { cookie: `${REFRESH_COOKIE_NAME}=${cookie ?? ''}` },
    });
    expect(logout.statusCode).toBe(204);

    const afterLogout = await refreshWith(cookie ?? '');
    expect(afterLogout.statusCode).toBe(401);
  });

  it('protege los módulos por permiso (403 para secretaría) y permite al administrador', async () => {
    const forbidden = await app.inject({
      method: 'GET',
      url: '/api/v1/users',
      headers: identityHeaders('secretario', 'patients:read,patients:write'),
    });
    expect(forbidden.statusCode).toBe(403);

    const allowed = await app.inject({
      method: 'GET',
      url: '/api/v1/users',
      headers: identityHeaders('admin', 'users:manage'),
    });
    expect(allowed.statusCode).toBe(200);
    expect(allowed.json<{ total: number }>().total).toBeGreaterThan(0);

    const audit = await app.inject({
      method: 'GET',
      url: '/api/v1/audit/events?action=login&pageSize=5',
      headers: identityHeaders('admin', 'audit:read'),
    });
    expect(audit.statusCode).toBe(200);
    expect(audit.json<{ items: unknown[] }>().items.length).toBeGreaterThan(0);
  });

  it('cambia la propia contraseña y exige la actual', async () => {
    const created = await database.db
      .insert(users)
      .values({
        username: `prueba.pass.${suffix}`,
        fullName: 'Usuario de contraseña',
        passwordHash: await hashPassword(PASSWORD),
      })
      .returning({ id: users.id });
    const userId = created[0]?.id ?? '';

    const wrongCurrent = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/password/change',
      headers: {
        'x-user-id': userId,
        'x-user-username': `prueba.pass.${suffix}`,
        'x-user-roles': 'secretario',
        'x-user-permissions': 'patients:read',
        'x-user-must-change-password': 'true',
      },
      payload: {
        currentPassword: WRONG_PASSWORD,
        newPassword: 'nueva-clave-segura-2026',
        repeatPassword: 'nueva-clave-segura-2026',
      },
    });
    expect(wrongCurrent.statusCode).toBe(400);

    const changed = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/password/change',
      headers: {
        'x-user-id': userId,
        'x-user-username': `prueba.pass.${suffix}`,
        'x-user-roles': 'secretario',
        'x-user-permissions': 'patients:read',
        'x-user-must-change-password': 'true',
      },
      payload: {
        currentPassword: PASSWORD,
        newPassword: 'nueva-clave-segura-2026',
        repeatPassword: 'nueva-clave-segura-2026',
      },
    });
    expect(changed.statusCode).toBe(200);
    expect(changed.json<{ user: { mustChangePassword: boolean } }>().user.mustChangePassword).toBe(
      false,
    );

    // Ya puede iniciar sesión con la contraseña nueva.
    const loginWithNew = await login(`prueba.pass.${suffix}`, 'nueva-clave-segura-2026');
    expect(loginWithNew.statusCode).toBe(200);

    await database.db.delete(users).where(eq(users.id, userId));
  });
});
