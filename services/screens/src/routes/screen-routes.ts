import {
  SSE_KEEPALIVE,
  criticalFlagsInputSchema,
  formatSseFrame,
  screenDeviceInputSchema,
  screenDeviceUpdateSchema,
  type ScreenDevice,
  type ScreenDeviceList,
} from '@odontocrm/contracts';
import {
  ForbiddenError,
  parseOrThrow,
  requireIdentity,
  requirePermission,
} from '@odontocrm/kernel';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

import type { ScreensServices } from '../services.js';
import {
  consultationState,
  createDevice,
  deactivateDevice,
  deviceByTokenId,
  listDevices,
  lobbyState,
  setCriticalFlags,
  toScreenDevice,
  touchDevice,
  updateDevice,
} from '../sala/estado-service.js';
import type { PantallaKind } from '../sala/broadcast.js';

const idParamsSchema = z.object({ id: z.uuid() });

const safeEquals = (left: string, right: string): boolean => {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
};

/**
 * Rutas de las pantallas de sala y consultorio:
 *
 *  - **administración** (`screens:manage`): registrar pantallas, ajustar su voz y
 *    desactivarlas;
 *  - **kiosko** (`screens:display`): estado y flujo SSE, con el token de
 *    dispositivo canjeado en identity (el gateway publica su id en `x-user-id`);
 *  - **interno**: los datos críticos del paciente en curso, que se **leen** de la
 *    historia clínica al pintar el estado ([ADR 0035](../../../docs/adr/0035-datos-criticos-leidos-no-empujados.md));
 *    la ruta interna sigue disponible como respaldo.
 */
export const registerScreenRoutes = (app: FastifyInstance, services: ScreensServices): void => {
  const { db, config, broadcast, alertLookup } = services;
  const manage = requirePermission('screens:manage');
  const display = requirePermission('screens:display');

  /**
   * Comprueba que quien pide estado es una pantalla **registrada y activa**: no
   * basta con un JWT de rol `pantalla`, la pantalla tiene que existir en este
   * servicio (si el admin la desactivó, deja de ver la sala).
   */
  const pantallaDe = async (
    request: FastifyRequest,
  ): Promise<{ id: string; kind: PantallaKind }> => {
    const identity = requireIdentity(request);
    const device = await deviceByTokenId(db, identity.userId);
    if (device === null) {
      throw new ForbiddenError(
        'Esta pantalla no está registrada o fue desactivada. Pide que la registren de nuevo.',
      );
    }
    await touchDevice(db, device.id);
    return { id: device.id, kind: device.kind as PantallaKind };
  };

  /* ── Administración ──────────────────────────────────────────────────────── */

  app.get('/api/v1/screens/devices', { preHandler: manage }, async (_request, reply) => {
    const items: ScreenDevice[] = await listDevices(db);
    const lista: ScreenDeviceList = { items, total: items.length };
    return reply.status(200).send(lista);
  });

  app.post('/api/v1/screens/devices', { preHandler: manage }, async (request, reply) => {
    const input = parseOrThrow(screenDeviceInputSchema, request.body);
    return reply.status(201).send(await createDevice(db, input));
  });

  app.patch('/api/v1/screens/devices/:id', { preHandler: manage }, async (request, reply) => {
    const { id } = parseOrThrow(idParamsSchema, request.params);
    const input = parseOrThrow(screenDeviceUpdateSchema, request.body ?? {});
    return reply.status(200).send(await updateDevice(db, id, input));
  });

  app.delete('/api/v1/screens/devices/:id', { preHandler: manage }, async (request, reply) => {
    const { id } = parseOrThrow(idParamsSchema, request.params);
    await deactivateDevice(db, id);
    return reply.status(204).send();
  });

  /* ── Estado (kiosko) ─────────────────────────────────────────────────────── */

  /**
   * Ficha de **esta** pantalla, con sus ajustes (voz, volumen, resalte). La
   * pantalla lo pide al arrancar: los ajustes viven aquí, no en identity, así que
   * no pueden venir en el login del dispositivo.
   */
  app.get('/api/v1/screens/device', { preHandler: display }, async (request, reply) => {
    const identity = requireIdentity(request);
    const device = await deviceByTokenId(db, identity.userId);
    if (device === null) {
      throw new ForbiddenError(
        'Esta pantalla no está registrada o fue desactivada. Pide que la registren de nuevo.',
      );
    }
    await touchDevice(db, device.id);
    return reply.status(200).send(toScreenDevice(device));
  });

  app.get('/api/v1/screens/lobby', { preHandler: display }, async (request, reply) => {
    await pantallaDe(request);
    return reply.status(200).send(await lobbyState(db, config));
  });

  app.get('/api/v1/screens/consultorio', { preHandler: display }, async (request, reply) => {
    await pantallaDe(request);
    return reply.status(200).send(await consultationState(db, { alertLookup }));
  });

  /** Cuántas pantallas están conectadas en vivo (para la administración). */
  app.get('/api/v1/screens/conectadas', { preHandler: manage }, async (_request, reply) =>
    reply.status(200).send({
      lobby: broadcast.conectadas('lobby'),
      consultorio: broadcast.conectadas('consultorio'),
    }),
  );

  /* ── Flujo en vivo (SSE) ─────────────────────────────────────────────────── */

  const abrirFlujo = async (
    request: FastifyRequest,
    reply: FastifyReply,
    kind: PantallaKind,
  ): Promise<void> => {
    await pantallaDe(request);
    const estado =
      kind === 'lobby'
        ? await lobbyState(db, config)
        : await consultationState(db, { alertLookup });

    // A partir de aquí la respuesta la controla el flujo de eventos.
    reply.hijack();
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      // Evita el buffering de proxys intermedios (nginx, Cloudflare…).
      'x-accel-buffering': 'no',
    });
    // Cuánto espera el navegador antes de reconectar y el estado inicial: la
    // pantalla pinta algo ya, sin esperar al primer cambio.
    reply.raw.write('retry: 3000\n\n');
    reply.raw.write(
      formatSseFrame({
        id: `inicial-${String(Date.now())}`,
        evento: kind,
        datos: estado,
      }),
    );

    const baja = broadcast.suscribir(kind, (trama) => {
      reply.raw.write(trama);
    });

    const latido = setInterval(() => {
      reply.raw.write(SSE_KEEPALIVE);
    }, config.SCREEN_KEEPALIVE_SECONDS * 1000);
    latido.unref?.();

    const cerrar = (): void => {
      clearInterval(latido);
      baja();
    };
    request.raw.on('close', cerrar);
    request.raw.on('error', cerrar);
  };

  app.get('/api/v1/screens/lobby/stream', { preHandler: display }, async (request, reply) => {
    await abrirFlujo(request, reply, 'lobby');
  });

  app.get('/api/v1/screens/consultorio/stream', { preHandler: display }, async (request, reply) => {
    await abrirFlujo(request, reply, 'consultorio');
  });

  /* ── Rutas internas (solo entre servicios, con el secreto compartido) ────── */

  app.addHook('onRequest', async (request) => {
    if (!request.url.startsWith('/internal/')) return;
    const expected = config.INTERNAL_SERVICE_SECRET;
    if (expected === undefined) {
      throw new ForbiddenError('Las rutas internas están deshabilitadas en este entorno');
    }
    const provided = request.headers['x-internal-token'];
    if (typeof provided !== 'string' || !safeEquals(provided, expected)) {
      throw new ForbiddenError('Token interno inválido');
    }
  });

  /**
   * Datos críticos del paciente en curso (alergias, crónicos, anticoagulantes).
   * Los envía el servicio clínico al abrir la consulta; hasta entonces la pantalla
   * muestra el aviso de que aún no hay historia clínica (Fase 6).
   */
  app.post('/internal/v1/screens/room/critical-flags', async (request, reply) => {
    const input = parseOrThrow(criticalFlagsInputSchema, request.body ?? {});
    const actualizadas = await setCriticalFlags(db, input.appointmentId, input.flags);
    const estado = await consultationState(db, { alertLookup });
    broadcast.publicar('consultorio', estado);
    return reply.status(200).send({ actualizadas, estado });
  });
};
