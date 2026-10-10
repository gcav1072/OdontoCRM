import {
  generateKeyPairPem,
  hashPassword,
  importPrivateKeyPem,
  type PrivateKey,
} from '@odontocrm/kernel';
import { eq, inArray, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { auditEvents, userRoles, users } from './db/schema.js';
import { loadIdentityConfig } from './config.js';
import { createIdentityDatabase, type IdentityDatabaseHandle } from './db/client.js';
import { createIdentityServer } from './server.js';

/**
 * Pruebas de integración del **panel de configuración** (ADR 0060) contra PostgreSQL real:
 * el gate `settings:manage`, la auditoría, el **enmascarado de secretos** (el token nunca
 * vuelve por la API) y la lectura interna de las credenciales en claro.
 */
const connectionString = process.env['TEST_DATABASE_URL'];
const describeWithDatabase = connectionString === undefined ? describe.skip : describe;

const PASSWORD = 'prueba-odontocrm-2026';
const suffix = String(Date.now()).slice(-6);
const INTERNAL = 'secreto-interno-de-prueba-para-configuracion';
const TOKEN = '1234567890:token-del-panel-de-configuracion-de-prueba';
/** Clave de 32 bytes en base64url para probar el **cifrado** de los secretos en reposo. */
const STORAGE_KEY = Buffer.alloc(32, 42).toString('base64url');

describeWithDatabase('configuración de la aplicación (PostgreSQL real)', () => {
  let app: FastifyInstance;
  let database: IdentityDatabaseHandle;
  let privateKey: PrivateKey;
  let adminId = '';
  let adminUsername = '';
  let secretaryId = '';
  let secretaryUsername = '';

  const headers = (
    userId: string,
    username: string,
    roles: string,
    permissions: string,
  ): Record<string, string> => ({
    'x-user-id': userId,
    'x-user-username': username,
    'x-user-roles': roles,
    'x-user-permissions': permissions,
    'x-user-must-change-password': 'false',
    'x-session-id': globalThis.crypto.randomUUID(),
  });

  const comoAdmin = () => headers(adminId, adminUsername, 'admin', '*');
  const comoSecretaria = (): Record<string, string> =>
    headers(secretaryId, secretaryUsername, 'secretario', 'patients:read');

  beforeAll(async () => {
    if (connectionString === undefined) throw new Error('sin TEST_DATABASE_URL');

    const config = loadIdentityConfig({
      DATABASE_URL: connectionString,
      LOG_LEVEL: 'silent',
      COOKIE_SECURE: 'false',
      INTERNAL_SERVICE_SECRET: INTERNAL,
      STORAGE_ENCRYPTION_KEY: STORAGE_KEY,
    });
    database = createIdentityDatabase(config);

    const pair = await generateKeyPairPem();
    privateKey = await importPrivateKeyPem(pair.privatePem);
    app = await createIdentityServer({ config, database, privateKey });

    adminUsername = `prueba.conf.admin.${suffix}`;
    const admin = await database.db
      .insert(users)
      .values({
        username: adminUsername,
        fullName: 'Admin de configuración',
        passwordHash: await hashPassword(PASSWORD),
      })
      .returning({ id: users.id });
    adminId = admin[0]?.id ?? '';
    await database.db.insert(userRoles).values({ userId: adminId, role: 'admin' });

    secretaryUsername = `prueba.conf.secre.${suffix}`;
    const secretary = await database.db
      .insert(users)
      .values({
        username: secretaryUsername,
        fullName: 'Secretaria de configuración',
        passwordHash: await hashPassword(PASSWORD),
      })
      .returning({ id: users.id });
    secretaryId = secretary[0]?.id ?? '';
    await database.db.insert(userRoles).values({ userId: secretaryId, role: 'secretario' });
  });

  afterAll(async () => {
    if (connectionString === undefined) return;
    // Se deja la configuración **de fábrica**: la base de integración es la de desarrollo.
    await app.inject({
      method: 'PUT',
      url: '/api/v1/settings/app',
      headers: comoAdmin(),
      payload: { accent: null, screenTexts: {} },
    });
    await app.inject({
      method: 'PUT',
      url: '/api/v1/settings/channels',
      headers: comoAdmin(),
      payload: {
        telegramBotToken: '',
        telegramBotUsername: '',
        adminTelegramBotToken: '',
        adminTelegramChatId: '',
        whatsappToken: '',
        whatsappPhoneId: '',
        whatsappVerifyToken: '',
        whatsappAppSecret: '',
      },
    });

    await database.db
      .delete(auditEvents)
      .where(inArray(auditEvents.actorUsername, [adminUsername, secretaryUsername]));
    await database.db
      .delete(users)
      .where(inArray(users.username, [adminUsername, secretaryUsername]));
    await database.close();
  });

  it('la configuración la lee cualquier sesión y trae el CSS de marca y los defectos', async () => {
    const respuesta = await app.inject({
      method: 'GET',
      url: '/api/v1/settings',
      headers: comoSecretaria(),
    });
    expect(respuesta.statusCode).toBe(200);
    const cuerpo = respuesta.json();
    expect(typeof cuerpo.themeCss).toBe('string');
    expect(cuerpo.themeCss).toContain('--brand-primary');
    expect(cuerpo.defaults.brand.palette.primary).toBeTruthy();
    expect(cuerpo.defaults.accent).toBeTruthy();
    expect(cuerpo.channels.telegramBotToken.configured).toBe(false);
  });

  it('solo el admin puede editar (la secretaría recibe 403)', async () => {
    const respuesta = await app.inject({
      method: 'PUT',
      url: '/api/v1/settings/app',
      headers: comoSecretaria(),
      payload: { accent: 'azul', screenTexts: {} },
    });
    expect(respuesta.statusCode).toBe(403);
  });

  it('guarda el acento y los textos, los refleja y queda auditado', async () => {
    const guardado = await app.inject({
      method: 'PUT',
      url: '/api/v1/settings/app',
      headers: comoAdmin(),
      payload: { accent: 'vino', screenTexts: { 'pantalla.lobby.titulo': 'Recepción' } },
    });
    expect(guardado.statusCode).toBe(200);

    const leido = await app.inject({
      method: 'GET',
      url: '/api/v1/settings',
      headers: comoAdmin(),
    });
    expect(leido.json().accentEffective).toBe('vino');
    expect(leido.json().screenTexts['pantalla.lobby.titulo']).toBe('Recepción');

    const auditoria = await database.db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.action, 'app_settings_updated'));
    expect(auditoria.some((fila) => fila.actorUsername === adminUsername)).toBe(true);
  });

  it('guarda la marca y la sirve (la interna y el CSS de la vista)', async () => {
    const marca = {
      palette: {
        primary: '#7f1d1d',
        primaryInk: '#fdecec',
        accent: '#991b1b',
        ink: '#17202a',
        inkStrong: '#46535f',
        inkMuted: '#4a5560',
        inkSubtle: '#6b7680',
        line: '#cfdedd',
        lineSoft: '#e3e9ea',
        tableHeadBg: '#eef5f4',
        good: '#14663f',
        warn: '#8a5a00',
        bad: '#97231f',
      },
      typography: {
        documentTitleSans: "'Montserrat', sans-serif",
        documentBodySans: "'Montserrat', sans-serif",
        documentTitleWeight: 700,
        documentBodyWeight: 400,
        documentTitlePt: 13,
        documentBodyPt: 9,
        documentSmallPt: 7.5,
      },
      letterhead: { logoHeightMm: 18, watermarkWidthMm: 90, watermarkOpacity: 0.1 },
      fonts: { families: [{ name: 'Montserrat', files: [] }] },
    };

    const guardado = await app.inject({
      method: 'PUT',
      url: '/api/v1/settings/brand',
      headers: comoAdmin(),
      payload: marca,
    });
    expect(guardado.statusCode).toBe(200);

    const vista = await app.inject({
      method: 'GET',
      url: '/api/v1/settings',
      headers: comoAdmin(),
    });
    expect(vista.json().brandFromDatabase).toBe(true);
    expect(vista.json().themeCss).toContain('--brand-primary: #7f1d1d;');

    const interna = await app.inject({
      method: 'GET',
      url: '/internal/v1/identity/brand',
      headers: { 'x-internal-token': INTERNAL },
    });
    expect(interna.statusCode).toBe(200);
    expect(interna.json().theme.palette.primary).toBe('#7f1d1d');
  });

  it('los secretos se guardan cifrados aparte y no vuelven por la API', async () => {
    const guardado = await app.inject({
      method: 'PUT',
      url: '/api/v1/settings/channels',
      headers: comoAdmin(),
      payload: { telegramBotToken: TOKEN, telegramBotUsername: 'bot_del_panel' },
    });
    expect(guardado.statusCode).toBe(200);

    const vista = await app.inject({
      method: 'GET',
      url: '/api/v1/settings',
      headers: comoAdmin(),
    });
    const canales = vista.json().channels;
    expect(canales.telegramBotUsername).toBe('bot_del_panel');
    expect(canales.telegramBotToken.configured).toBe(true);
    expect(canales.telegramBotToken.preview).toBe(`…${TOKEN.slice(-4)}`);
    // El token completo NUNCA viaja en la respuesta.
    expect(vista.body).not.toContain(TOKEN);

    // La ruta interna sí lo devuelve en claro (es la que lo necesita para conectar).
    const interna = await app.inject({
      method: 'GET',
      url: '/internal/v1/identity/channels',
      headers: { 'x-internal-token': INTERNAL },
    });
    expect(interna.statusCode).toBe(200);
    expect(interna.json().telegramBotToken).toBe(TOKEN);

    // Y en la base no está en claro.
    const fila = await database.db.execute<{ telegram_bot_token_enc: string | null }>(
      sql`select telegram_bot_token_enc from channel_settings where id = 1`,
    );
    expect(fila.rows[0]?.telegram_bot_token_enc ?? '').not.toContain(TOKEN);
  });
});
