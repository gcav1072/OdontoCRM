import {
  REFRESH_COOKIE_NAME,
  adminLicensingViewSchema,
  decodeLicenseRequest,
  permissionsForRoles,
  publicLicensingViewSchema,
  readOnlyPermissions,
  type LicenseClaims,
} from '@odontocrm/contracts';
import {
  generateKeyPairPem,
  hashPassword,
  importPrivateKeyPem,
  importPublicKeyPem,
  signLicenseToken,
  verifyAccessToken,
  type PrivateKey,
  type PublicKey,
} from '@odontocrm/kernel';
import { and, eq, inArray } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { loadIdentityConfig } from './config.js';
import { createIdentityDatabase, type IdentityDatabaseHandle } from './db/client.js';
import { auditEvents, installation, userRoles, users } from './db/schema.js';
import { readInstallation } from './licensing/licensing-service.js';
import { createIdentityServer } from './server.js';

/**
 * Pruebas de integración del **licenciamiento offline** (ADR 0075) contra PostgreSQL
 * real: activación válida, licencia de otra instalación, firma y vencimiento, el
 * **modo consulta** en la emisión de tokens (login, refresco y `/auth/me`) y las
 * rutas internas que usa el bot de administración.
 *
 * Solo se ejecutan con `TEST_DATABASE_URL` (`npm run test:integration`).
 */
const connectionString = process.env['TEST_DATABASE_URL'];
const describeWithDatabase = connectionString === undefined ? describe.skip : describe;

const PASSWORD = 'prueba-licencias-2026';
const INTERNAL = 'secreto-interno-de-prueba-para-licencias';
const DAY_MS = 86_400_000;

const suffix = String(Date.now()).slice(-6);
const ADMIN = `prueba.licencias.admin.${suffix}`;

const esperadosSoloLectura = new Set(readOnlyPermissions(permissionsForRoles(['admin'])));

describeWithDatabase('licenciamiento offline (PostgreSQL real)', () => {
  let app: FastifyInstance;
  let database: IdentityDatabaseHandle;
  let privateKey: PrivateKey;
  let jwtPublicKey: PublicKey;
  let licensePrivateKey: PrivateKey;
  let licensePublicKey: PublicKey;
  let adminId = '';

  const claims = (overrides: Partial<LicenseClaims> = {}): LicenseClaims => ({
    v: 1,
    lic: `LIC-2026-${suffix}`,
    tipo: 'mensual',
    instalacion: '',
    cliente: { nombre: 'Consultorio de integración', rif: 'J-12345678-9' },
    emitidaEn: new Date().toISOString(),
    venceEn: new Date(Date.now() + 30 * DAY_MS).toISOString(),
    modulos: ['*'],
    ...overrides,
  });

  /**
   * Deja la instalación como recién instalada (prueba de 30 días y sin licencia).
   * Es una fila **global**: se vuelve a dejar limpia al final de cada prueba para no
   * desestabilizar a las demás suites de identity, que comparten la misma base.
   */
  const resetInstallation = async (estado: { licencia?: LicenseClaims | null } = {}) => {
    const ahora = new Date();
    const licencia = estado.licencia ?? null;
    await database.db
      .update(installation)
      .set({
        installedAt: ahora,
        lastSeenAt: ahora,
        licenseToken: licencia === null ? null : 'token-de-prueba',
        licenseClaims: licencia,
        licenseActivatedAt: licencia === null ? null : ahora,
        licenseActivatedBy: null,
        licenseActivationReason: licencia === null ? null : 'prueba',
        updatedAt: ahora,
      })
      .where(eq(installation.id, 1));
    return readInstallation(database.db);
  };

  const encabezados = (permisos = 'licensing:manage'): Record<string, string> => ({
    'x-user-id': adminId,
    'x-user-username': ADMIN,
    'x-user-roles': 'admin',
    'x-user-permissions': permisos,
    'x-user-must-change-password': 'false',
    'x-session-id': globalThis.crypto.randomUUID(),
  });

  beforeAll(async () => {
    if (connectionString === undefined) throw new Error('sin TEST_DATABASE_URL');

    const config = loadIdentityConfig({
      DATABASE_URL: connectionString,
      LOG_LEVEL: 'silent',
      COOKIE_SECURE: 'false',
      INTERNAL_SERVICE_SECRET: INTERNAL,
    });
    database = createIdentityDatabase(config);

    const parJwt = await generateKeyPairPem();
    privateKey = await importPrivateKeyPem(parJwt.privatePem);
    jwtPublicKey = await importPublicKeyPem(parJwt.publicPem);

    const parLicencias = await generateKeyPairPem();
    licensePrivateKey = await importPrivateKeyPem(parLicencias.privatePem);
    licensePublicKey = await importPublicKeyPem(parLicencias.publicPem);

    app = await createIdentityServer({ config, database, privateKey, licensePublicKey });

    const insertado = await database.db
      .insert(users)
      .values({
        username: ADMIN,
        fullName: 'Admin de licencias',
        passwordHash: await hashPassword(PASSWORD),
      })
      .returning({ id: users.id });
    adminId = insertado[0]?.id ?? '';
    await database.db.insert(userRoles).values({ userId: adminId, role: 'admin' });

    await resetInstallation();
  });

  afterAll(async () => {
    await resetInstallation();
    if (adminId !== '') await database.db.delete(users).where(inArray(users.id, [adminId]));
    await app.close();
    await database.close();
  });

  describe('estado público', () => {
    it('publica la prueba de 30 días sin sesión y sin datos del consultorio', async () => {
      const fila = await resetInstallation();

      const respuesta = await app.inject({ method: 'GET', url: '/api/v1/licensing/public' });
      expect(respuesta.statusCode).toBe(200);

      const vista = publicLicensingViewSchema.parse(respuesta.json());
      expect(vista.estado).toBe('trial');
      expect(vista.soloLectura).toBe(false);
      expect(vista.diasRestantes).toBe(30);
      expect(JSON.stringify(vista)).not.toContain(fila.installationId);
      expect(JSON.stringify(vista)).not.toContain('RIF');
    });
  });

  describe('estado y activación por la API (administrador)', () => {
    it('exige sesión y el permiso `licensing:manage`', async () => {
      const sinSesion = await app.inject({ method: 'GET', url: '/api/v1/licensing/status' });
      expect(sinSesion.statusCode).toBe(401);

      const secretaria = await app.inject({
        method: 'GET',
        url: '/api/v1/licensing/status',
        headers: {
          ...encabezados('patients:read'),
          'x-user-roles': 'secretario',
        },
      });
      expect(secretaria.statusCode).toBe(403);

      const fila = await resetInstallation();
      const admin = await app.inject({
        method: 'GET',
        url: '/api/v1/licensing/status',
        headers: encabezados(),
      });
      expect(admin.statusCode).toBe(200);

      const vista = adminLicensingViewSchema.parse(admin.json());
      expect(vista.instalacion).toBe(fila.installationId);
      expect(vista.licencia).toBeNull();
      // El consultorio puede no haber completado su identidad todavía (respaldo neutro);
      // lo que no puede faltar es el UUID que ata la licencia a esta instalación.
      expect(typeof vista.consultorio.nombre).toBe('string');
      expect(vista.solicitud.codigo.startsWith('ODO-REQ1.')).toBe(true);
      const solicitud = decodeLicenseRequest(vista.solicitud.codigo);
      expect(solicitud?.instalacion).toBe(fila.installationId);
      expect(solicitud?.cliente.nombre.length ?? 0).toBeGreaterThan(0);
    });

    it('activa una licencia válida, la guarda y la audita', async () => {
      const fila = await resetInstallation();
      const licencia = claims({ lic: `LIC-ACTIVA-${suffix}`, instalacion: fila.installationId });
      const token = await signLicenseToken(licencia, { privateKey: licensePrivateKey });

      const respuesta = await app.inject({
        method: 'POST',
        url: '/api/v1/licensing/activate',
        headers: encabezados(),
        payload: { licencia: token },
      });
      expect(respuesta.statusCode).toBe(200);

      const vista = adminLicensingViewSchema.parse(respuesta.json());
      expect(vista.soloLectura).toBe(false);
      expect(vista.origen).toBe('licencia');
      expect(vista.tipo).toBe('mensual');
      expect(vista.licencia?.id).toBe(licencia.lic);

      const guardada = await readInstallation(database.db);
      expect(guardada.licenseToken).toBe(token);
      expect(guardada.licenseClaims?.lic).toBe(licencia.lic);
      expect(guardada.licenseActivatedBy).toBe(adminId);

      const auditoria = await database.db
        .select()
        .from(auditEvents)
        .where(
          and(eq(auditEvents.action, 'license_activated'), eq(auditEvents.entityId, licencia.lic)),
        )
        .limit(1);
      expect(auditoria[0]?.actorId).toBe(adminId);
      expect(auditoria[0]?.reason).toBe('activación desde la web');
    });

    it('activa una vitalicia: no se rechaza por vencida y no lleva fecha', async () => {
      const fila = await resetInstallation();
      const vitalicia = claims({
        lic: `LIC-VITALICIA-${suffix}`,
        tipo: 'vitalicia',
        venceEn: null,
        instalacion: fila.installationId,
      });
      const token = await signLicenseToken(vitalicia, { privateKey: licensePrivateKey });

      const respuesta = await app.inject({
        method: 'POST',
        url: '/api/v1/licensing/activate',
        headers: encabezados(),
        payload: { licencia: token },
      });
      expect(respuesta.statusCode).toBe(200);

      const vista = adminLicensingViewSchema.parse(respuesta.json());
      expect(vista.estado).toBe('licencia_vigente');
      expect(vista.soloLectura).toBe(false);
      expect(vista.tipo).toBe('vitalicia');
      expect(vista.venceEn).toBeNull();
      expect(vista.diasRestantes).toBeNull();
      expect(vista.licencia?.venceEn).toBeNull();

      const guardada = await readInstallation(database.db);
      expect(guardada.licenseClaims?.tipo).toBe('vitalicia');
      expect(guardada.licenseClaims?.venceEn).toBeNull();

      // La vista pública tampoco inventa un vencimiento.
      const publica = await app.inject({ method: 'GET', url: '/api/v1/licensing/public' });
      const publicaVista = publicLicensingViewSchema.parse(publica.json());
      expect(publicaVista.estado).toBe('licencia_vigente');
      expect(publicaVista.venceEn).toBeNull();

      const auditoria = await database.db
        .select()
        .from(auditEvents)
        .where(
          and(eq(auditEvents.action, 'license_activated'), eq(auditEvents.entityId, vitalicia.lic)),
        )
        .limit(1);
      expect(auditoria[0]?.summary).toContain('sin vencimiento');
    });

    it('rechaza (y audita) una licencia de otra instalación', async () => {
      const fila = await resetInstallation();
      const licencia = claims({
        lic: `LIC-AJENA-${suffix}`,
        instalacion: globalThis.crypto.randomUUID(),
      });
      const token = await signLicenseToken(licencia, { privateKey: licensePrivateKey });

      const respuesta = await app.inject({
        method: 'POST',
        url: '/api/v1/licensing/activate',
        headers: encabezados(),
        payload: { licencia: token },
      });
      expect(respuesta.statusCode).toBe(400);
      expect(String(respuesta.json().type)).toMatch(/\/license_installation_mismatch$/);

      const guardada = await readInstallation(database.db);
      expect(guardada.licenseClaims).toBeNull();
      expect(guardada.installationId).toBe(fila.installationId);

      const auditoria = await database.db
        .select()
        .from(auditEvents)
        .where(eq(auditEvents.action, 'license_activation_rejected'))
        .limit(20);
      expect(auditoria.some((filaAudit) => filaAudit.reason?.includes('instalación'))).toBe(true);
    });

    it('rechaza una licencia vencida', async () => {
      const fila = await resetInstallation();
      const licencia = claims({
        lic: `LIC-VENCIDA-${suffix}`,
        instalacion: fila.installationId,
        venceEn: new Date(Date.now() - DAY_MS).toISOString(),
      });
      const token = await signLicenseToken(licencia, { privateKey: licensePrivateKey });

      const respuesta = await app.inject({
        method: 'POST',
        url: '/api/v1/licensing/activate',
        headers: encabezados(),
        payload: { licencia: token },
      });
      expect(respuesta.statusCode).toBe(400);
      expect(String(respuesta.json().type)).toMatch(/\/license_expired$/);
      expect((await readInstallation(database.db)).licenseClaims).toBeNull();
    });

    it('rechaza una licencia con firma de otra clave', async () => {
      const fila = await resetInstallation();
      const atacante = await generateKeyPairPem();
      const claveAjena = await importPrivateKeyPem(atacante.privatePem);
      const licencia = claims({ lic: `LIC-FALSA-${suffix}`, instalacion: fila.installationId });
      const token = await signLicenseToken(licencia, { privateKey: claveAjena });

      const respuesta = await app.inject({
        method: 'POST',
        url: '/api/v1/licensing/activate',
        headers: encabezados(),
        payload: { licencia: token },
      });
      expect(respuesta.statusCode).toBe(400);
      expect(String(respuesta.json().type)).toMatch(/\/license_invalid$/);
    });
  });

  describe('modo consulta en la emisión de tokens', () => {
    it('con la licencia vencida, login, refresco y /auth/me emiten solo lectura + licensing:manage', async () => {
      const fila = await resetInstallation();
      const vencida = claims({
        lic: `LIC-MODO-CONSULTA-${suffix}`,
        instalacion: fila.installationId,
        venceEn: new Date(Date.now() - DAY_MS).toISOString(),
      });

      try {
        await resetInstallation({ licencia: vencida });

        const login = await app.inject({
          method: 'POST',
          url: '/api/v1/auth/login',
          payload: { username: ADMIN, password: PASSWORD },
        });
        expect(login.statusCode).toBe(200);

        const cuerpo = login.json() as { accessToken: string; user: { permissions: string[] } };
        const claimsToken = await verifyAccessToken(cuerpo.accessToken, jwtPublicKey);
        expect(claimsToken).not.toBeNull();

        expect(new Set(claimsToken?.permissions)).toEqual(esperadosSoloLectura);
        expect(new Set(cuerpo.user.permissions)).toEqual(esperadosSoloLectura);
        expect(claimsToken?.permissions).toContain('licensing:manage');
        expect(claimsToken?.permissions).not.toContain('patients:write');
        expect(claimsToken?.permissions).not.toContain('users:manage');

        const cookie = login.cookies.find((item) => item.name === REFRESH_COOKIE_NAME);
        expect(cookie).toBeDefined();
        const refresco = await app.inject({
          method: 'POST',
          url: '/api/v1/auth/refresh',
          headers: { cookie: `${REFRESH_COOKIE_NAME}=${cookie?.value ?? ''}` },
        });
        expect(refresco.statusCode).toBe(200);
        const claimsRefresco = await verifyAccessToken(
          (refresco.json() as { accessToken: string }).accessToken,
          jwtPublicKey,
        );
        expect(new Set(claimsRefresco?.permissions)).toEqual(esperadosSoloLectura);

        const me = await app.inject({
          method: 'GET',
          url: '/api/v1/auth/me',
          headers: encabezados(),
        });
        expect(me.statusCode).toBe(200);
        const permisosMe = (me.json() as { user: { permissions: string[] } }).user.permissions;
        expect(new Set(permisosMe)).toEqual(esperadosSoloLectura);
      } finally {
        // La fila es global para la base de integración: se restaura en seguida.
        await resetInstallation();
      }
    });

    it('con la licencia vencida, la escritura del admin da 403 y la lectura sigue en 200', async () => {
      const fila = await resetInstallation();
      const vencida = claims({
        lic: `LIC-SOLO-LECTURA-${suffix}`,
        instalacion: fila.installationId,
        venceEn: new Date(Date.now() - DAY_MS).toISOString(),
      });

      try {
        await resetInstallation({ licencia: vencida });

        const login = await app.inject({
          method: 'POST',
          url: '/api/v1/auth/login',
          payload: { username: ADMIN, password: PASSWORD },
        });
        expect(login.statusCode).toBe(200);

        const cuerpo = login.json() as {
          accessToken: string;
          user: { id: string; username: string };
        };
        const claimsToken = await verifyAccessToken(cuerpo.accessToken, jwtPublicKey);
        expect(claimsToken).not.toBeNull();
        expect(claimsToken?.permissions).toContain('licensing:manage');
        expect(claimsToken?.permissions).not.toContain('settings:manage');

        // Las cabeceras que publicaría el gateway con el token recortado.
        const cabeceras: Record<string, string> = {
          'x-user-id': cuerpo.user.id,
          'x-user-username': cuerpo.user.username,
          'x-user-roles': (claimsToken?.roles ?? ['admin']).join(','),
          'x-user-permissions': (claimsToken?.permissions ?? []).join(','),
          'x-user-must-change-password': 'false',
          'x-session-id': claimsToken?.sid ?? globalThis.crypto.randomUUID(),
        };

        // El admin conserva la lectura de todo el panel.
        const lectura = await app.inject({
          method: 'GET',
          url: '/api/v1/settings',
          headers: cabeceras,
        });
        expect(lectura.statusCode).toBe(200);

        // La escritura queda bloqueada: no hay atajo por rol admin en los permisos.
        const escritura = await app.inject({
          method: 'PUT',
          url: '/api/v1/settings/app',
          headers: cabeceras,
          payload: { accent: null, screenTexts: {} },
        });
        expect(escritura.statusCode).toBe(403);
        expect(String(escritura.json().type)).toMatch(/\/forbidden$/);

        // Y `licensing:manage` sobrevive al recorte: la página de licencia se abre.
        const estado = await app.inject({
          method: 'GET',
          url: '/api/v1/licensing/status',
          headers: cabeceras,
        });
        expect(estado.statusCode).toBe(200);
      } finally {
        await resetInstallation();
      }
    });
  });

  describe('rutas internas (bot de administración)', () => {
    it('solo responden con el secreto interno', async () => {
      const sinSecreto = await app.inject({
        method: 'GET',
        url: '/internal/v1/licensing/status',
      });
      expect(sinSecreto.statusCode).toBe(403);
    });

    it('entrega el estado y activa la licencia con actor nulo y motivo del bot', async () => {
      const fila = await resetInstallation();

      const estado = await app.inject({
        method: 'GET',
        url: '/internal/v1/licensing/status',
        headers: { 'x-internal-token': INTERNAL },
      });
      expect(estado.statusCode).toBe(200);
      expect(adminLicensingViewSchema.parse(estado.json()).instalacion).toBe(fila.installationId);

      const licencia = claims({
        lic: `LIC-BOT-${suffix}`,
        instalacion: fila.installationId,
        tipo: 'anual',
      });
      const token = await signLicenseToken(licencia, { privateKey: licensePrivateKey });

      const activada = await app.inject({
        method: 'POST',
        url: '/internal/v1/licensing/activate',
        headers: { 'x-internal-token': INTERNAL },
        payload: { licencia: token },
      });
      expect(activada.statusCode).toBe(200);
      const vista = adminLicensingViewSchema.parse(activada.json());
      expect(vista.tipo).toBe('anual');
      expect(vista.licencia?.id).toBe(licencia.lic);

      const auditoria = await database.db
        .select()
        .from(auditEvents)
        .where(
          and(eq(auditEvents.action, 'license_activated'), eq(auditEvents.entityId, licencia.lic)),
        )
        .limit(1);
      expect(auditoria[0]?.actorId).toBeNull();
      expect(auditoria[0]?.reason).toBe('bot de administración');
    });
  });

  describe('instalación sin clave pública', () => {
    it('no puede activar y lo dice con un error claro, sin tumbar el resto', async () => {
      const config = loadIdentityConfig({
        DATABASE_URL: connectionString as string,
        LOG_LEVEL: 'silent',
        COOKIE_SECURE: 'false',
        INTERNAL_SERVICE_SECRET: INTERNAL,
      });
      const appSinClave = await createIdentityServer({
        config,
        database,
        privateKey,
        licensePublicKey: null,
      });

      try {
        const fila = await resetInstallation();
        const licencia = claims({
          lic: `LIC-SIN-CLAVE-${suffix}`,
          instalacion: fila.installationId,
        });
        const token = await signLicenseToken(licencia, { privateKey: licensePrivateKey });

        const respuesta = await appSinClave.inject({
          method: 'POST',
          url: '/api/v1/licensing/activate',
          headers: encabezados(),
          payload: { licencia: token },
        });
        expect(respuesta.statusCode).toBe(503);
        expect(String(respuesta.json().type)).toMatch(/\/license_key_missing$/);

        // El estado público sigue funcionando: la app no se cae sin clave.
        const publico = await appSinClave.inject({
          method: 'GET',
          url: '/api/v1/licensing/public',
        });
        expect(publico.statusCode).toBe(200);
      } finally {
        await appSinClave.close();
        await resetInstallation();
      }
    });
  });
});
