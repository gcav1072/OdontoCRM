import {
  markContactedSchema,
  messageTemplateInputSchema,
  notificationFiltersSchema,
  retryNotificationSchema,
} from '@odontocrm/contracts';
import {
  ForbiddenError,
  NotFoundError,
  parseOrThrow,
  parseQuery,
  requirePermission,
} from '@odontocrm/kernel';
import type { FastifyInstance } from 'fastify';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import QRCode from 'qrcode';
import { z } from 'zod';
import { desc } from 'drizzle-orm';

import { botConversations } from './db/schema.js';
import {
  createLinkCode,
  findIcsArtifact,
  listChannels,
  listNotifications,
  listTemplates,
  markContacted,
  maskChatId,
  notificationCounts,
  processQueue,
  queueSnapshot,
  resetTemplate,
  retryNotification,
  unlinkPatient,
  updateTemplate,
} from './messaging.js';
import type { NotificationsServices } from './services.js';

const idParamsSchema = z.object({ id: z.uuid() });
const keyParamsSchema = z.object({ key: z.string().trim().min(1).max(60) });
const patientParamsSchema = z.object({ patientId: z.uuid() });
const linkCodeSchema = z.object({ patientId: z.uuid() });
const channelsQuerySchema = z.object({ patientId: z.uuid().optional() });
const icsParamsSchema = z.object({ appointmentId: z.uuid() });

/** Código del deep link: corto de dictar y sin caracteres que se confundan. */
const newLinkCode = (): string => {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = randomBytes(8);
  return [...bytes].map((byte) => alphabet[byte % alphabet.length] ?? 'A').join('');
};

export const registerNotificationRoutes = (
  app: FastifyInstance,
  services: NotificationsServices,
): void => {
  const { db, config, transport } = services;
  const read = requirePermission('scheduling:read');
  const notify = requirePermission('scheduling:notify');

  app.get('/api/v1/notifications', { preHandler: read }, async (request, reply) => {
    const filters = parseQuery(notificationFiltersSchema, request.query);
    return reply.status(200).send(await listNotifications(db, filters));
  });

  /** Estado del bot y de la cola: lo que pinta la cabecera de la bandeja. */
  app.get('/api/v1/notifications/status', { preHandler: read }, async (_request, reply) => {
    const [identity, counts, queue, conversations] = await Promise.all([
      transport.getMe().catch(() => ({ id: '', username: null, name: null })),
      notificationCounts(db),
      queueSnapshot(db),
      db.select().from(botConversations).orderBy(desc(botConversations.updatedAt)).limit(20),
    ]);

    const mode = transport.mode;
    return reply.status(200).send({
      mode,
      botUsername: identity.username,
      botName: identity.name,
      connected: mode === 'real' && identity.username !== null,
      lastUpdateAt: conversations[0]?.updatedAt.toISOString() ?? null,
      lastError: services.lastError,
      // Conversaciones a medio camino: lo que el plan llama «actualizaciones pendientes».
      pendingUpdates: conversations.filter((row) => row.state !== 'inicio').length,
      conversations: conversations.map((row) => ({
        chatId: maskChatId(row.chatId),
        state: row.state,
        draft: row.draft,
        patientId: row.patientId,
        telegramUsername: row.telegramUsername,
        messageCount: row.messageCount,
        windowStartedAt: row.windowStartedAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
      })),
      counts: { ...counts, queued: queue.pending },
    });
  });

  app.post('/api/v1/notifications/:id/retry', { preHandler: notify }, async (request, reply) => {
    const { id } = parseOrThrow(idParamsSchema, request.params);
    const input = parseOrThrow(retryNotificationSchema, request.body ?? {});
    return reply.status(200).send(await retryNotification(db, id, input.reason));
  });

  /** «Aviso manual pendiente»: la secretaría lo llamó y deja constancia. */
  app.post(
    '/api/v1/notifications/:id/contacted',
    { preHandler: notify },
    async (request, reply) => {
      const actorId = request.headers['x-user-id'];
      const { id } = parseOrThrow(idParamsSchema, request.params);
      const input = parseOrThrow(markContactedSchema, request.body ?? {});
      return reply
        .status(200)
        .send(
          await markContacted(db, id, input.note, typeof actorId === 'string' ? actorId : null),
        );
    },
  );

  app.get('/api/v1/notifications/templates', { preHandler: read }, async (_request, reply) => {
    const items = await listTemplates(db);
    return reply.status(200).send({ items, total: items.length });
  });

  app.patch(
    '/api/v1/notifications/templates/:key',
    { preHandler: notify },
    async (request, reply) => {
      const { key } = parseOrThrow(keyParamsSchema, request.params);
      const input = parseOrThrow(messageTemplateInputSchema, request.body);
      return reply.status(200).send(await updateTemplate(db, key, input));
    },
  );

  app.post(
    '/api/v1/notifications/templates/:key/reset',
    { preHandler: notify },
    async (request, reply) => {
      const { key } = parseOrThrow(keyParamsSchema, request.params);
      return reply.status(200).send(await resetTemplate(db, key));
    },
  );

  app.get('/api/v1/notifications/channels', { preHandler: read }, async (request, reply) => {
    const query = parseQuery(channelsQuerySchema, request.query);
    const items = await listChannels(db, query.patientId);
    return reply.status(200).send({
      items: items.map((channel) => ({
        patientId: channel.patientId,
        patientName: null,
        channel: 'telegram' as const,
        chatIdMasked: maskChatId(channel.chatId),
        telegramUsername: channel.telegramUsername,
        linkedAt: channel.linkedAt.toISOString(),
        isBlocked: channel.isBlocked,
      })),
      total: items.length,
    });
  });

  /**
   * Enlace de vinculación: devuelve el `t.me/...` y el QR listo para mostrar o
   * imprimir. Quien lo abra queda vinculado a ese paciente (plan §7).
   */
  app.post(
    '/api/v1/notifications/channels/link-code',
    { preHandler: notify },
    async (request, reply) => {
      const input = parseOrThrow(linkCodeSchema, request.body);
      const code = newLinkCode();
      const expiresAt = new Date(Date.now() + 15 * 60_000);
      await createLinkCode(db, { patientId: input.patientId, code, expiresAt });

      const botUsername = config.TELEGRAM_BOT_USERNAME ?? null;
      const deepLink =
        botUsername === null ? '' : `https://t.me/${botUsername.replace(/^@/, '')}?start=${code}`;

      const qrDataUrl =
        deepLink === ''
          ? null
          : await QRCode.toDataURL(deepLink, { margin: 1, width: 320, errorCorrectionLevel: 'M' });

      return reply.status(200).send({
        patientId: input.patientId,
        code,
        expiresAt: expiresAt.toISOString(),
        deepLink,
        botUsername,
        ...(qrDataUrl === null ? {} : { qrDataUrl }),
      });
    },
  );

  app.delete(
    '/api/v1/notifications/channels/:patientId',
    { preHandler: notify },
    async (request, reply) => {
      const { patientId } = parseOrThrow(patientParamsSchema, request.params);
      await unlinkPatient(db, patientId);
      return reply.status(204).send();
    },
  );

  /**
   * Descarga del `.ics` desde la web. El plan lo escribía como
   * `GET /api/v1/appointments/:id/ics`, pero ese prefijo pertenece a la agenda en el
   * gateway; vive aquí, que es donde se generan los archivos, y la web lo enlaza.
   */
  app.get(
    '/api/v1/notifications/ics/:appointmentId',
    { preHandler: read },
    async (request, reply) => {
      const { appointmentId } = parseOrThrow(icsParamsSchema, request.params);
      const artifact = await findIcsArtifact(db, appointmentId);
      if (artifact === null)
        throw new NotFoundError('Todavía no hay ningún archivo .ics para esa cita');

      return reply
        .status(200)
        .header('content-type', 'text/calendar; charset=utf-8')
        .header('content-disposition', `attachment; filename="${artifact.filename}"`)
        .send(artifact.content);
    },
  );

  // ── Rutas internas (solo entre servicios, con el secreto compartido) ──
  app.addHook('onRequest', async (request) => {
    if (!request.url.startsWith('/internal/')) return;
    const expected = config.INTERNAL_SERVICE_SECRET;
    if (expected === undefined) {
      throw new ForbiddenError('Las rutas internas están deshabilitadas en este entorno');
    }
    const provided = request.headers['x-internal-token'];
    if (typeof provided !== 'string' || provided.length !== expected.length) {
      throw new ForbiddenError('Token interno inválido');
    }
    if (!timingSafeEqual(Buffer.from(provided), Buffer.from(expected))) {
      throw new ForbiddenError('Token interno inválido');
    }
  });

  /** Fuerza un ciclo de la cola de envíos (pruebas y operación). */
  app.post('/internal/v1/notifications/process', async (_request, reply) => {
    const result = await processQueue(db, transport, config, {
      appointmentLoader: (id) => services.clients.getAppointment(id),
    });
    return reply.status(200).send(result);
  });
};
