import { and, eq, like } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createNotificationsDatabase, type NotificationsDatabaseHandle } from '../../db/client.js';
import { whatsappAuth } from '../../db/schema.js';
import { usePostgresAuthState } from './auth-store.js';

/**
 * La sesión Signal de Baileys sobre PostgreSQL (ADR 0073): ida y vuelta de los
 * `Buffer`, borrado, cifrado en reposo y error claro cuando falta la clave.
 */
const databaseUrl = process.env['TEST_NOTIFICATIONS_DATABASE_URL'];
const ready = databaseUrl !== undefined;
const describeWithDatabase = ready ? describe : describe.skip;

const CLAVE = Buffer.alloc(32, 7).toString('base64url');
const sessionId = `prueba-auth-${String(Date.now()).slice(-8)}`;
/** Una sesión distinta por caso: el estado cifrado de uno no ensucia al siguiente. */
const sesion = (nombre: string): string => `${sessionId}-${nombre}`;

describeWithDatabase('auth store de WhatsApp en PostgreSQL', () => {
  let handle: NotificationsDatabaseHandle;

  beforeAll(() => {
    handle = createNotificationsDatabase({
      DATABASE_URL: databaseUrl ?? '',
      DATABASE_POOL_MAX: 2,
    });
  });

  afterAll(async () => {
    await handle.db.delete(whatsappAuth).where(like(whatsappAuth.sessionId, `${sessionId}%`));
    await handle.close();
  });

  it('guarda credenciales y claves binarias, y las devuelve iguales', async () => {
    const auth = await usePostgresAuthState(handle.db, {
      sessionId: sesion('ida'),
      encryptionKey: CLAVE,
    });
    expect(await auth.hasCreds()).toBe(false);

    await auth.saveCreds();
    expect(await auth.hasCreds()).toBe(true);

    const publicKey = Buffer.from('clave-publica-de-prueba');
    const privateKey = Buffer.from('clave-privada-de-prueba');
    await auth.state.keys.set({
      'pre-key': {
        '1': { public: publicKey, private: privateKey },
      },
    });

    const leidas = await auth.state.keys.get('pre-key', ['1']);
    expect(Buffer.from(leidas['1']?.public ?? [])).toEqual(publicKey);
    expect(Buffer.from(leidas['1']?.private ?? [])).toEqual(privateKey);
  });

  it('borra una clave cuando el valor es null y toda la sesión con clear', async () => {
    const sesionBorrado = sesion('borrado');
    const auth = await usePostgresAuthState(handle.db, {
      sessionId: sesionBorrado,
      encryptionKey: CLAVE,
    });
    await auth.state.keys.set({
      session: { a: new Uint8Array([1, 2, 3]) },
    });
    expect(Object.keys(await auth.state.keys.get('session', ['a']))).toHaveLength(1);

    await auth.state.keys.set({ session: { a: null } });
    // La caché de Baileys representa el borrado como `null`; en la base no queda fila.
    const filas = await handle.db
      .select()
      .from(whatsappAuth)
      .where(and(eq(whatsappAuth.sessionId, sesionBorrado), eq(whatsappAuth.categoria, 'session')));
    expect(filas).toHaveLength(0);

    await auth.clear();
    expect(await auth.hasCreds()).toBe(false);
  });

  it('cifra en reposo: la columna no contiene el JSON en claro', async () => {
    const sesionCifrada = sesion('cifrado');
    const auth = await usePostgresAuthState(handle.db, {
      sessionId: sesionCifrada,
      encryptionKey: CLAVE,
    });
    await auth.saveCreds();

    const filas = await handle.db
      .select({ valor: whatsappAuth.valor })
      .from(whatsappAuth)
      .where(and(eq(whatsappAuth.sessionId, sesionCifrada), eq(whatsappAuth.categoria, 'creds')));
    expect(filas[0]?.valor.startsWith('enc:')).toBe(true);
    expect(filas[0]?.valor).not.toContain('registrationId');
  });

  it('si la fila está cifrada y falta la clave, falla con un mensaje claro', async () => {
    const sesionSinClave = sesion('sin-clave');
    const auth = await usePostgresAuthState(handle.db, {
      sessionId: sesionSinClave,
      encryptionKey: CLAVE,
    });
    await auth.saveCreds();

    // El error se lanza al abrir el store: sin clave no se puede ni leer la sesión.
    await expect(usePostgresAuthState(handle.db, { sessionId: sesionSinClave })).rejects.toThrow(
      /STORAGE_ENCRYPTION_KEY/,
    );
  });

  it('sin clave guarda en claro y lo avisa (solo desarrollo)', async () => {
    const avisos: string[] = [];
    const sesionPlana = sesion('plano');
    const auth = await usePostgresAuthState(handle.db, {
      sessionId: sesionPlana,
      warn: (mensaje) => avisos.push(mensaje),
    });
    await auth.saveCreds();
    const filas = await handle.db
      .select({ valor: whatsappAuth.valor })
      .from(whatsappAuth)
      .where(and(eq(whatsappAuth.sessionId, sesionPlana), eq(whatsappAuth.categoria, 'creds')));
    expect(filas[0]?.valor.startsWith('plain:')).toBe(true);
    expect(avisos.join(' ')).toContain('STORAGE_ENCRYPTION_KEY');
  });
});
