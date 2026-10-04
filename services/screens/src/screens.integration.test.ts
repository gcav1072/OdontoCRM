import { createDomainEvent, EVENT_TOPICS, type DomainEvent } from '@odontocrm/events';
import { eq, inArray, like, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { loadScreensConfig, type ScreensConfig } from './config.js';
import { handleDomainEvent, handleDomainEvents } from './consumer.js';
import { createScreensDatabase, type ScreensDatabaseHandle } from './db/client.js';
import { callEvents, roomState, screenDevices } from './db/schema.js';
import { createScreenBroadcaster } from './sala/broadcast.js';
import { consultationState, lobbyState } from './sala/estado-service.js';
import type { ScreensServices } from './services.js';
import { createScreensServer } from './server.js';

/**
 * Pruebas de integración de la Fase 5 contra PostgreSQL real:
 *  - un llamado en la agenda aparece **en el lobby** como un llamado vigente;
 *  - el 2.º llamado queda marcado como tal (el displaylobby lo pinta en rojo);
 *  - pasar a consulta deja al paciente en la pantalla del consultorio con su
 *    motivo, y al terminar sale de la sala;
 *  - los llamados son idempotentes: el mismo evento no llama dos veces;
 *  - el **flujo SSE** entrega el estado al conectar y al cambiar la sala;
 *  - una pantalla no registrada (o desactivada) no ve nada.
 *
 * El servidor se levanta en un puerto libre porque el flujo SSE necesita una
 * conexión de verdad (con `inject` no se puede leer un `text/event-stream`).
 */
const databaseUrl = process.env['TEST_SCREENS_DATABASE_URL'];
const ready = databaseUrl !== undefined;
const describeWithDatabase = ready ? describe : describe.skip;

const MARK = `PRUEBA-F5-${String(Date.now()).slice(-6)}`;

/** Evento de agenda, con la forma que publica `scheduling`. */
const appointmentEvent = (input: {
  topic: string;
  appointmentId: string;
  patientId?: string | null;
  patientName?: string;
  ticket?: string | null;
  reason?: string | null;
  actorId?: string | null;
  /** Hora del evento: la cola puede entregar el lote desordenado. */
  occurredAt?: Date;
}): DomainEvent =>
  createDomainEvent({
    topic: input.topic as (typeof EVENT_TOPICS)[keyof typeof EVENT_TOPICS],
    aggregateId: input.appointmentId,
    producer: 'scheduling',
    ...(input.actorId === undefined ? {} : { actorId: input.actorId }),
    ...(input.occurredAt === undefined ? {} : { occurredAt: input.occurredAt }),
    payload: {
      appointment: {
        id: input.appointmentId,
        date: '2026-10-05',
        startTime: '09:00',
        endTime: '09:30',
        status: 'llamado',
        requestId: null,
      },
      notification: {
        appointmentId: input.appointmentId,
        patientId: input.patientId ?? null,
        patientName: `${input.patientName ?? 'Paciente'} ${MARK}`,
        patientPhone: '+584121234567',
        ticket: input.ticket ?? '#000123',
        date: '2026-10-05',
        startTime: '09:00',
        endTime: '09:30',
        place: 'Consultorio de prueba',
        subject: 'Confirmación de tu cita',
        body: 'Cuerpo',
        channel: 'telegram',
        templateKey: 'cita_confirmada',
        icsSequence: 0,
        reason: input.reason ?? 'Dolor en la muela del juicio',
      },
    },
  });

describeWithDatabase('sala y pantallas (PostgreSQL real)', () => {
  let handle: ScreensDatabaseHandle;
  let config: ScreensConfig;
  let services: ScreensServices;

  beforeAll(async () => {
    if (databaseUrl === undefined) throw new Error('falta TEST_SCREENS_DATABASE_URL');

    config = loadScreensConfig({
      DATABASE_URL: databaseUrl,
      LOG_LEVEL: 'silent',
      CHAIR_LABEL: 'Consultorio 1',
      INTERNAL_SERVICE_SECRET: 'secreto-interno-de-prueba-1234',
    });
    handle = createScreensDatabase(config);

    /**
     * Esta base es la misma que usa el servicio de pantallas en desarrollo, y ese
     * servicio **consume los eventos de las otras suites** (la de agenda publica
     * citas de sus pacientes de prueba y las proyecta aquí). Esas filas ajenas
     * dejarían a otro paciente «en el consultorio» y esta suite lee un único
     * paciente, así que se limpia lo que no es de esta corrida.
     */
    await handle.db.execute(sql`delete from room_state where patient_name not like ${`%${MARK}%`}`);

    services = {
      config,
      db: handle.db,
      pool: handle.pool,
      broadcast: createScreenBroadcaster(),
      lastError: null,
      // Sin servicio clínico en la suite: se usa lo que quedó en la proyección.
      alertLookup: async () => null,
    };
  }, 30_000);

  afterAll(async () => {
    if (!ready) return;
    await handle.db.delete(callEvents).where(like(callEvents.patientDisplayName, `%${MARK}%`));
    await handle.db.delete(roomState).where(like(roomState.patientName, `%${MARK}%`));
    await handle.db.execute(sql`delete from screen_devices where label like ${`%${MARK}%`}`);
    await handle.close();
  });

  const aplicar = async (event: DomainEvent): Promise<string> =>
    (await handleDomainEvent({ db: handle.db, config }, event)).estado;

  it('un llamado llega al lobby con el nombre abreviado y el turno', async () => {
    const appointmentId = globalThis.crypto.randomUUID();
    const patientId = globalThis.crypto.randomUUID();

    await aplicar(
      appointmentEvent({
        topic: EVENT_TOPICS.appointmentCheckedIn,
        appointmentId,
        patientId,
        patientName: 'Juan Pérez Gómez',
      }),
    );
    await aplicar(
      appointmentEvent({
        topic: EVENT_TOPICS.appointmentCalled,
        appointmentId,
        patientId,
        patientName: 'Juan Pérez Gómez',
      }),
    );

    const estado = await lobbyState(handle.db, config);
    const llamado = estado.calls.find((call) => call.appointmentId === appointmentId);

    expect(llamado).toBeDefined();
    expect(llamado?.patientDisplayName).toBe('Juan P.');
    expect(llamado?.callNumber).toBe(1);
    expect(llamado?.chairLabel).toBe('Consultorio 1');
    expect(llamado?.ticket).toBe('#000123');
    expect(estado.updatedAt).toContain('T');
  }, 40_000);

  it('el segundo llamado queda marcado y el mismo evento no llama dos veces', async () => {
    const appointmentId = globalThis.crypto.randomUUID();
    const t0 = new Date(Date.now() - 2_000);
    await aplicar(
      appointmentEvent({
        topic: EVENT_TOPICS.appointmentCheckedIn,
        appointmentId,
        occurredAt: t0,
      }),
    );

    const primero = appointmentEvent({
      topic: EVENT_TOPICS.appointmentCalled,
      appointmentId,
      occurredAt: new Date(t0.getTime() + 500),
    });
    const segundo = appointmentEvent({
      topic: EVENT_TOPICS.appointmentCalled,
      appointmentId,
      occurredAt: new Date(t0.getTime() + 1_000),
    });

    expect(await aplicar(primero)).toBe('aplicado');
    expect(await aplicar(segundo)).toBe('aplicado');
    // El mismo evento repetido (mismo eventId) no vuelve a llamar.
    expect(await aplicar(segundo)).toBe('duplicado');

    const filas = await handle.db
      .select()
      .from(callEvents)
      .where(eq(callEvents.appointmentId, appointmentId));
    expect(filas).toHaveLength(2);
    expect(filas.map((fila) => fila.callNumber).sort()).toEqual([1, 2]);

    const estado = await lobbyState(handle.db, config);
    expect(estado.calls.find((call) => call.appointmentId === appointmentId)?.callNumber).toBe(2);
  }, 40_000);

  it('pasar a consulta deja al paciente en la pantalla del consultorio y al salir desaparece', async () => {
    const appointmentId = globalThis.crypto.randomUUID();
    const patientId = globalThis.crypto.randomUUID();

    await aplicar(
      appointmentEvent({
        topic: EVENT_TOPICS.appointmentCheckedIn,
        appointmentId,
        patientId,
        patientName: 'María Rojas',
      }),
    );
    await aplicar(
      appointmentEvent({
        topic: EVENT_TOPICS.appointmentCalled,
        appointmentId,
        patientId,
        patientName: 'María Rojas',
      }),
    );

    const enSala = await consultationState(handle.db);
    // Todavía no ha entrado: la pantalla muestra a quién se llamó.
    expect(enSala.patientDisplayName).toBe('María R.');
    expect(enSala.since).toBeNull();

    await aplicar(
      appointmentEvent({
        topic: EVENT_TOPICS.appointmentInConsultation,
        appointmentId,
        patientId,
        patientName: 'María Rojas',
        ticket: '#000124',
        reason: 'Limpieza dental',
      }),
    );

    const enConsulta = await consultationState(handle.db);
    expect(enConsulta.appointmentId).toBe(appointmentId);
    expect(enConsulta.patientDisplayName).toBe('María R.');
    expect(enConsulta.reason).toBe('Limpieza dental');
    // El ticket es el de la cita: el evento solo lo actualiza si viene.
    expect(enConsulta.ticket).toBe('#000124');
    expect(enConsulta.since).not.toBeNull();
    expect(enConsulta.criticalFlags).toEqual([]);

    // Los datos críticos los envía la historia clínica (Fase 6).
    await handle.db
      .update(roomState)
      .set({
        criticalFlags: [
          { tipo: 'alergia', etiqueta: 'Penicilina', severidad: 'alto', detalle: null },
          { tipo: 'cronico', etiqueta: 'Hipertensión', severidad: 'medio', detalle: null },
        ],
      })
      .where(eq(roomState.appointmentId, appointmentId));

    const conFlags = await consultationState(handle.db);
    expect(conFlags.criticalFlags).toHaveLength(2);
    expect(conFlags.criticalFlags[0]).toMatchObject({ tipo: 'alergia', severidad: 'alto' });

    /**
     * Lo que se lee de la historia clínica manda sobre lo empujado: el doctor puede
     * escribir la anamnesis con el paciente ya sentado, y la alergia aparece en la
     * pantalla sin esperar a que nadie la empuje.
     */
    const frescos = await consultationState(handle.db, {
      alertLookup: async (id) =>
        id === patientId
          ? [
              {
                tipo: 'alergia',
                etiqueta: 'Alergia a la penicilina',
                severidad: 'alto',
                detalle: null,
              },
            ]
          : null,
    });
    expect(frescos.criticalFlags).toHaveLength(1);
    expect(frescos.criticalFlags[0]?.etiqueta).toBe('Alergia a la penicilina');

    // Si el servicio clínico no responde, queda lo empujado y la pantalla no se rompe.
    const sinServicio = await consultationState(handle.db, { alertLookup: async () => null });
    expect(sinServicio.criticalFlags).toHaveLength(2);

    // Marcarla como atendida la saca de la sala.
    expect(
      await aplicar(
        appointmentEvent({
          topic: EVENT_TOPICS.appointmentAttended,
          appointmentId,
          patientId,
          patientName: 'María Rojas',
        }),
      ),
    ).toBe('aplicado');

    const filas = await handle.db
      .select()
      .from(roomState)
      .where(eq(roomState.appointmentId, appointmentId));
    // La fila queda como lápida (`left_at`): no vuelve a la sala, pero se conserva.
    expect(filas).toHaveLength(1);
    expect(filas[0]?.leftAt).not.toBeNull();

    const estadoFinal = await consultationState(handle.db);
    expect(estadoFinal.appointmentId).not.toBe(appointmentId);
  }, 40_000);

  it('el lote se aplica en orden aunque la cola lo entregue al revés', async () => {
    const appointmentId = globalThis.crypto.randomUUID();
    const paciente = `Orden ${MARK}`;
    // Horas recientes: un llamado de hace horas ya no está en pantalla.
    const t0 = new Date(Date.now() - 2_000);

    // `pg-boss` entrega el lote sin garantizar el orden: aquí llega el llamado
    // ANTES del registro de llegada, que es lo que dejaba la sala al revés.
    const llamado = appointmentEvent({
      topic: EVENT_TOPICS.appointmentCalled,
      appointmentId,
      patientName: paciente,
      occurredAt: new Date(t0.getTime() + 1_000),
    });
    const llegada = appointmentEvent({
      topic: EVENT_TOPICS.appointmentCheckedIn,
      appointmentId,
      patientName: paciente,
      occurredAt: t0,
    });

    const resultados = await handleDomainEvents({ db: handle.db, config }, [llamado, llegada]);
    expect(resultados.filter((resultado) => resultado.estado === 'aplicado')).toHaveLength(2);

    // El estado final es el del evento más reciente: el paciente está llamado.
    const filas = await handle.db
      .select()
      .from(roomState)
      .where(eq(roomState.appointmentId, appointmentId));
    expect(filas[0]?.estado).toBe('llamado');

    const estado = await lobbyState(handle.db, config);
    expect(estado.calls.some((call) => call.appointmentId === appointmentId)).toBe(true);

    await handle.db.delete(callEvents).where(eq(callEvents.appointmentId, appointmentId));
    await handle.db.delete(roomState).where(eq(roomState.appointmentId, appointmentId));
  }, 40_000);

  it('un evento tardío no resucita a quien ya salió de la sala', async () => {
    const appointmentId = globalThis.crypto.randomUUID();
    const paciente = `Tardío ${MARK}`;
    const t0 = new Date(Date.now() - 3_000);

    await aplicar(
      appointmentEvent({
        topic: EVENT_TOPICS.appointmentCheckedIn,
        appointmentId,
        patientName: paciente,
        occurredAt: t0,
      }),
    );
    await aplicar(
      appointmentEvent({
        topic: EVENT_TOPICS.appointmentInConsultation,
        appointmentId,
        patientName: paciente,
        occurredAt: new Date(t0.getTime() + 60_000),
      }),
    );
    await aplicar(
      appointmentEvent({
        topic: EVENT_TOPICS.appointmentAttended,
        appointmentId,
        patientName: paciente,
        occurredAt: new Date(t0.getTime() + 120_000),
      }),
    );

    // Llega tarde el evento de consulta (anterior a la salida): no debe volver.
    await aplicar(
      appointmentEvent({
        topic: EVENT_TOPICS.appointmentInConsultation,
        appointmentId,
        patientName: paciente,
        occurredAt: new Date(t0.getTime() + 60_000),
      }),
    );

    const filas = await handle.db
      .select()
      .from(roomState)
      .where(eq(roomState.appointmentId, appointmentId));
    expect(filas[0]?.leftAt).not.toBeNull();

    const estado = await consultationState(handle.db);
    expect(estado.appointmentId).not.toBe(appointmentId);

    await handle.db.delete(roomState).where(eq(roomState.appointmentId, appointmentId));
  }, 40_000);

  it('el flujo SSE entrega el estado al conectar y cuando cambia la sala', async () => {
    const server = await createScreensServer({ config, database: handle, services });
    const baseUrl = await server.listen({ port: 0, host: '127.0.0.1' });

    const tokenId = globalThis.crypto.randomUUID();
    const device = await handle.db
      .insert(screenDevices)
      .values({ label: `Lobby ${MARK}`, kind: 'lobby', tokenId })
      .returning({ id: screenDevices.id });
    expect(device[0]?.id).toBeDefined();

    const headers = {
      'x-user-id': tokenId,
      'x-user-username': 'Lobby',
      'x-user-roles': 'pantalla',
      'x-user-permissions': 'screens:display',
      'x-user-must-change-password': 'false',
      'x-session-id': globalThis.crypto.randomUUID(),
    };

    /** Lee del flujo hasta que el texto cumpla la condición (con tope de tiempo). */
    const conTiempo = async <T>(promesa: Promise<T>, ms: number, que: string): Promise<T> => {
      let temporizador: ReturnType<typeof setTimeout> | undefined;
      const limite = new Promise<never>((_resolve, reject) => {
        temporizador = setTimeout(() => {
          reject(new Error(`tiempo agotado esperando ${que}`));
        }, ms);
      });
      try {
        return await Promise.race([promesa, limite]);
      } finally {
        if (temporizador !== undefined) clearTimeout(temporizador);
      }
    };

    try {
      const respuesta = await conTiempo(
        fetch(`${baseUrl}/api/v1/screens/lobby/stream`, { headers }),
        10_000,
        'la conexión al flujo',
      );
      expect(respuesta.status).toBe(200);
      expect(respuesta.headers.get('content-type')).toContain('text/event-stream');

      const lector = respuesta.body?.getReader();
      expect(lector).toBeDefined();
      const decoder = new TextDecoder();
      let texto = '';

      const leerHasta = async (
        condicion: (acumulado: string) => boolean,
        ms: number,
      ): Promise<void> => {
        while (!condicion(texto)) {
          const { value, done } = await conTiempo(lector!.read(), ms, 'una trama del lobby');
          if (done === true) throw new Error(`El flujo se cerró. Recibido: ${texto}`);
          texto += decoder.decode(value);
        }
      };

      // 1) Al conectar llega el estado inicial: la pantalla no arranca en blanco.
      await leerHasta((acumulado) => acumulado.includes('event: lobby'), 5_000);
      expect(texto).toContain('waitingCount');

      // 2) Un llamado nuevo se empuja sin que la pantalla pregunte.
      const appointmentId = globalThis.crypto.randomUUID();
      const paciente = `Sofía Márquez ${MARK}`;

      await aplicar(
        appointmentEvent({
          topic: EVENT_TOPICS.appointmentCheckedIn,
          appointmentId,
          patientName: paciente,
        }),
      );
      await aplicar(
        appointmentEvent({
          topic: EVENT_TOPICS.appointmentCalled,
          appointmentId,
          patientName: paciente,
        }),
      );
      // El servicio avisa al terminar el lote (aquí se hace explícito).
      services.broadcast.publicar('lobby', await lobbyState(handle.db, config));

      await leerHasta((acumulado) => acumulado.includes('Sofía M.'), 5_000);
      expect(texto).toContain('Sofía M.');

      await lector!.cancel();
    } finally {
      await server.close();
    }
  }, 60_000);

  it('una pantalla no registrada no ve la sala', async () => {
    const server = await createScreensServer({ config, database: handle, services });
    const baseUrl = await server.listen({ port: 0, host: '127.0.0.1' });

    const headers = {
      'x-user-id': globalThis.crypto.randomUUID(),
      'x-user-username': 'Intruso',
      'x-user-roles': 'pantalla',
      'x-user-permissions': 'screens:display',
      'x-user-must-change-password': 'false',
      'x-session-id': globalThis.crypto.randomUUID(),
    };

    try {
      const lobby = await fetch(`${baseUrl}/api/v1/screens/lobby`, { headers });
      expect(lobby.status).toBe(403);

      // Sin permiso tampoco: el rol `pantalla` solo tiene `screens:display`.
      const sinPermiso = await fetch(`${baseUrl}/api/v1/screens/devices`, { headers });
      expect(sinPermiso.status).toBe(403);
    } finally {
      await server.close();
    }
  }, 40_000);

  it('una pantalla desactivada deja de ver la sala', async () => {
    const tokenId = globalThis.crypto.randomUUID();
    const filas = await handle.db
      .insert(screenDevices)
      .values({ label: `Consultorio ${MARK}`, kind: 'consultorio', tokenId, isActive: false })
      .returning({ id: screenDevices.id });
    expect(filas[0]?.id).toBeDefined();

    const server = await createScreensServer({ config, database: handle, services });
    const baseUrl = await server.listen({ port: 0, host: '127.0.0.1' });

    try {
      const respuesta = await fetch(`${baseUrl}/api/v1/screens/consultorio`, {
        headers: {
          'x-user-id': tokenId,
          'x-user-username': 'Consultorio',
          'x-user-roles': 'pantalla',
          'x-user-permissions': 'screens:display',
          'x-user-must-change-password': 'false',
          'x-session-id': globalThis.crypto.randomUUID(),
        },
      });
      expect(respuesta.status).toBe(403);
    } finally {
      await server.close();
    }
  }, 40_000);

  it('reemitir el enlace apunta la pantalla al token nuevo y el viejo deja de ver la sala', async () => {
    const tokenViejo = globalThis.crypto.randomUUID();
    const filas = await handle.db
      .insert(screenDevices)
      .values({ label: `Lobby enlace ${MARK}`, kind: 'lobby', tokenId: tokenViejo })
      .returning({ id: screenDevices.id });
    const pantallaId = filas[0]?.id;
    expect(pantallaId).toBeDefined();

    const server = await createScreensServer({ config, database: handle, services });
    const baseUrl = await server.listen({ port: 0, host: '127.0.0.1' });

    const comoPantalla = (id: string) => ({
      'x-user-id': id,
      'x-user-username': 'Pantalla',
      'x-user-roles': 'pantalla',
      'x-user-permissions': 'screens:display',
      'x-user-must-change-password': 'false',
      'x-session-id': globalThis.crypto.randomUUID(),
    });

    /** Quien administra las pantallas (`screens:manage`). */
    const comoAdmin = {
      'x-user-id': globalThis.crypto.randomUUID(),
      'x-user-username': 'admin',
      'x-user-roles': 'admin',
      'x-user-permissions': 'screens:manage',
      'x-user-must-change-password': 'false',
      'x-session-id': globalThis.crypto.randomUUID(),
      'content-type': 'application/json',
    };

    try {
      // Con el token viejo la pantalla ve la sala.
      const antes = await fetch(`${baseUrl}/api/v1/screens/lobby`, {
        headers: comoPantalla(tokenViejo),
      });
      expect(antes.status).toBe(200);

      // Reemitir: la pantalla pasa a reconocer otro token de dispositivo.
      const tokenNuevo = globalThis.crypto.randomUUID();
      const patch = await fetch(`${baseUrl}/api/v1/screens/devices/${pantallaId ?? ''}`, {
        method: 'PATCH',
        headers: comoAdmin,
        body: JSON.stringify({ tokenId: tokenNuevo }),
      });
      expect(patch.status).toBe(200);
      const actualizada = (await patch.json()) as { tokenId: string };
      expect(actualizada.tokenId).toBe(tokenNuevo);

      // El enlace viejo muere en el acto…
      const conViejo = await fetch(`${baseUrl}/api/v1/screens/lobby`, {
        headers: comoPantalla(tokenViejo),
      });
      expect(conViejo.status).toBe(403);

      // …y el nuevo funciona sin tocar nada más.
      const conNuevo = await fetch(`${baseUrl}/api/v1/screens/lobby`, {
        headers: comoPantalla(tokenNuevo),
      });
      expect(conNuevo.status).toBe(200);

      // Sin permiso de administración no se puede reemitir.
      const sinPermiso = await fetch(`${baseUrl}/api/v1/screens/devices/${pantallaId ?? ''}`, {
        method: 'PATCH',
        headers: { ...comoPantalla(tokenNuevo), 'content-type': 'application/json' },
        body: JSON.stringify({ tokenId: globalThis.crypto.randomUUID() }),
      });
      expect(sinPermiso.status).toBe(403);
    } finally {
      await server.close();
    }
  }, 40_000);

  it('los llamados caducan: un llamado viejo sale del lobby', async () => {
    const appointmentId = globalThis.crypto.randomUUID();
    await aplicar(appointmentEvent({ topic: EVENT_TOPICS.appointmentCheckedIn, appointmentId }));
    await aplicar(appointmentEvent({ topic: EVENT_TOPICS.appointmentCalled, appointmentId }));

    const estado = await lobbyState(handle.db, config);
    expect(estado.calls.some((call) => call.appointmentId === appointmentId)).toBe(true);

    // Como si el llamado hubiera sido hace media hora.
    await handle.db
      .update(roomState)
      .set({ updatedAt: new Date(Date.now() - 3_600_000) })
      .where(eq(roomState.appointmentId, appointmentId));

    const caducado = await lobbyState(handle.db, config);
    expect(caducado.calls.some((call) => call.appointmentId === appointmentId)).toBe(false);

    await handle.db.delete(callEvents).where(inArray(callEvents.appointmentId, [appointmentId]));
    await handle.db.delete(roomState).where(eq(roomState.appointmentId, appointmentId));
  }, 40_000);
});
