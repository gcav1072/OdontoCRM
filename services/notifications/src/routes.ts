import {
  CHANNEL_IDS,
  adminAlertSchema,
  appointmentNotificationFiltersSchema,
  channelTestInputSchema,
  markContactedSchema,
  messageTemplateInputSchema,
  notificationFiltersSchema,
  notificationSettingsInputSchema,
  retryNotificationSchema,
  toE164Digits,
  whatsappPairInputSchema,
  type ChannelStatus,
  type WhatsAppSessionView,
} from '@odontocrm/contracts';
import {
  ForbiddenError,
  NotFoundError,
  parseOrThrow,
  parseQuery,
  requirePermission,
} from '@odontocrm/kernel';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import QRCode from 'qrcode';
import { z } from 'zod';
import { desc } from 'drizzle-orm';

import { appointmentsInInbox } from './appointments.js';
import { channelsInInbox } from './channels.js';
import { botConversations } from './db/schema.js';
import {
  createLinkCode,
  findIcsArtifact,
  listNotifications,
  listTemplates,
  markContacted,
  maskDireccion,
  notificationCounts,
  processQueue,
  queueSnapshot,
  resetTemplate,
  retryNotification,
  unlinkPatient,
  updateTemplate,
} from './messaging.js';
import { getNotificationSettings, updateNotificationSettings } from './settings.js';
import type { NotificationsServices } from './services.js';

const idParamsSchema = z.object({ id: z.uuid() });
const keyParamsSchema = z.object({ key: z.string().trim().min(1).max(60) });
const patientParamsSchema = z.object({ patientId: z.uuid() });
const linkCodeSchema = z.object({ patientId: z.uuid() });
const channelsQuerySchema = z.object({ patientId: z.uuid().optional() });
const unlinkQuerySchema = z.object({ channel: z.enum(CHANNEL_IDS).optional() });
const icsParamsSchema = z.object({ appointmentId: z.uuid() });
const webhookParamsSchema = z.object({ canal: z.enum(CHANNEL_IDS) });

/** Código del deep link: corto de dictar y sin caracteres que se confundan. */
const newLinkCode = (): string => {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = randomBytes(8);
  return [...bytes].map((byte) => alphabet[byte % alphabet.length] ?? 'A').join('');
};

/**
 * Cuerpo **crudo** de la petición: la firma de Meta se calcula sobre los bytes
 * exactos que envió, así que re-serializar el JSON la invalidaría. Lo guarda el
 * analizador de contenido registrado en `server.ts`.
 */
const rawBodyOf = (request: FastifyRequest): string => {
  const raw = (request as FastifyRequest & { rawBody?: string }).rawBody;
  if (typeof raw === 'string') return raw;
  return request.body === undefined ? '' : JSON.stringify(request.body);
};

const jsonBodyOf = (request: FastifyRequest): unknown => {
  if (typeof request.body !== 'string') return request.body ?? null;
  try {
    return JSON.parse(request.body) as unknown;
  } catch {
    return null;
  }
};

const headersOf = (request: FastifyRequest): Readonly<Record<string, string | undefined>> => {
  const headers: Record<string, string | undefined> = {};
  for (const [clave, valor] of Object.entries(request.headers)) {
    headers[clave] = Array.isArray(valor) ? valor.join(', ') : valor;
  }
  return headers;
};

export const registerNotificationRoutes = (
  app: FastifyInstance,
  services: NotificationsServices,
): void => {
  const { db, config, canales } = services;
  const read = requirePermission('scheduling:read');
  const notify = requirePermission('scheduling:notify');
  /** Sesión de WhatsApp (QR/cierre): solo el admin, igual que los canales. */
  const manage = requirePermission('settings:manage');
  /** Política de cancelación (ADR 0057): solo `admin` y odontólogo. */
  const policy = requirePermission('scheduling:cancel_policy');

  app.get('/api/v1/notifications', { preHandler: read }, async (request, reply) => {
    const filters = parseQuery(notificationFiltersSchema, request.query);
    return reply.status(200).send(await listNotifications(db, filters));
  });

  /**
   * **Citas próximas** (ADR 0052): la sección desde la que la secretaría ve lo que
   * viene, por dónde se le puede avisar a cada paciente y si ya confirmó. Los datos
   * se componen en el servicio —agenda + canales + avisos— y llegan listos para
   * pintar; ver el porqué en `appointmentsInInbox`.
   */
  app.get('/api/v1/notifications/appointments', { preHandler: read }, async (request, reply) => {
    const filters = parseQuery(appointmentNotificationFiltersSchema, request.query);
    return reply.status(200).send(await appointmentsInInbox(db, services.clients, filters));
  });

  /** Estado de los canales y de la cola: lo que pinta la cabecera de la bandeja. */
  app.get('/api/v1/notifications/status', { preHandler: read }, async (_request, reply) => {
    const [estados, counts, queue, conversations] = await Promise.all([
      Promise.all(
        canales.registry.all.map(async (adapter): Promise<ChannelStatus> => {
          const identidad = await adapter.identidad().catch(() => ({
            nombre: null,
            usuario: null,
            conectado: false,
          }));
          const detalle =
            adapter.id === 'whatsapp'
              ? canales.whatsapp !== null
                ? (await canales.whatsapp.vista()).estado
                : canales.modoWhatsApp === 'cloud_api'
                  ? 'cloud_api'
                  : null
              : null;
          return {
            canal: adapter.id,
            nombre: identidad.nombre,
            usuario: identidad.usuario,
            conectado: identidad.conectado,
            detalle,
            capacidades: adapter.capacidades,
          };
        }),
      ),
      notificationCounts(db),
      queueSnapshot(db),
      db.select().from(botConversations).orderBy(desc(botConversations.updatedAt)).limit(20),
    ]);

    const telegram = estados.find((estado) => estado.canal === 'telegram');
    const mode = canales.modoTelegram;

    return reply.status(200).send({
      mode,
      testMode: canales.modoTest,
      botUsername: telegram?.usuario ?? null,
      botName: telegram?.nombre ?? null,
      connected: mode === 'real' && (telegram?.conectado ?? false),
      lastUpdateAt: conversations[0]?.updatedAt.toISOString() ?? null,
      lastError: services.lastError,
      // Conversaciones a medio camino: lo que el plan llama «actualizaciones pendientes».
      pendingUpdates: conversations.filter((row) => row.state !== 'inicio').length,
      conversations: conversations.map((row) => ({
        canal: row.canal,
        direccionMasked: maskDireccion(row.direccion),
        state: row.state,
        draft: row.draft,
        patientId: row.patientId,
        usuario: row.usuario,
        messageCount: row.messageCount,
        windowStartedAt: row.windowStartedAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
      })),
      canales: estados,
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
    return reply.status(200).send(await channelsInInbox(db, services.clients, query.patientId));
  });

  /**
   * **Política de cancelación del paciente** (ADR 0057): el corte de días que se
   * aplica a una cita confirmada. La ven y la editan **solo el `admin` y el
   * odontólogo** (`scheduling:cancel_policy`), así que la secretaría recibe 403 y la
   * tarjeta ni se le pinta.
   */
  app.get('/api/v1/notifications/settings', { preHandler: policy }, async (_request, reply) => {
    return reply.status(200).send(await getNotificationSettings(db));
  });

  app.patch('/api/v1/notifications/settings', { preHandler: policy }, async (request, reply) => {
    const input = parseOrThrow(notificationSettingsInputSchema, request.body);
    const actorId = request.headers['x-user-id'];
    return reply
      .status(200)
      .send(
        await updateNotificationSettings(db, input, typeof actorId === 'string' ? actorId : null),
      );
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

      // Enlace de WhatsApp (D13): el paciente abre wa.me y el texto ya lleva
      // «VINCULAR <código>», que el asistente entiende sin comandos con barra.
      let whatsappLink: string | null = null;
      let whatsappQrDataUrl: string | null = null;
      const vistaWhatsApp = canales.whatsapp === null ? null : await canales.whatsapp.vista();
      if (
        vistaWhatsApp !== null &&
        vistaWhatsApp.estado === 'conectado' &&
        vistaWhatsApp.numero !== null
      ) {
        whatsappLink = `https://wa.me/${vistaWhatsApp.numero}?text=${encodeURIComponent(
          `VINCULAR ${code}`,
        )}`;
        whatsappQrDataUrl = await QRCode.toDataURL(whatsappLink, {
          margin: 1,
          width: 320,
          errorCorrectionLevel: 'M',
        });
      }

      return reply.status(200).send({
        patientId: input.patientId,
        code,
        expiresAt: expiresAt.toISOString(),
        deepLink,
        botUsername,
        ...(qrDataUrl === null ? {} : { qrDataUrl }),
        whatsappLink,
        whatsappQrDataUrl,
      });
    },
  );

  app.delete(
    '/api/v1/notifications/channels/:patientId',
    { preHandler: notify },
    async (request, reply) => {
      const { patientId } = parseOrThrow(patientParamsSchema, request.params);
      const { channel } = parseQuery(unlinkQuerySchema, request.query);
      await unlinkPatient(db, patientId, channel);
      return reply.status(204).send();
    },
  );

  /**
   * La sesión de Baileys. Si el canal todavía no está construido, se fuerza una
   * recarga de los canales antes de rendirse: el admin pudo acabar de guardar el
   * interruptor en el panel y el sondeo periódico aún no lo ha visto.
   */
  const sesionWhatsApp = async () => {
    if (canales.whatsapp === null) {
      await services.recargarCanales?.({ forzar: true }).catch(() => undefined);
    }
    if (canales.whatsapp === null) {
      throw new NotFoundError(
        'El canal WhatsApp no está activo. Enciéndelo en Configuración → Canales y guarda los cambios para vincularlo.',
      );
    }
    return canales.whatsapp;
  };

  /** La vista de la sesión; `desactivado` cuando el proveedor Baileys no está en marcha. */
  const vistaWhatsApp = async (): Promise<WhatsAppSessionView> => {
    if (canales.whatsapp === null) {
      await services.recargarCanales?.({ forzar: true }).catch(() => undefined);
    }
    if (canales.whatsapp !== null) return canales.whatsapp.vista();
    return {
      estado: 'desactivado',
      numero: null,
      nombre: null,
      qrDataUrl: null,
      qrRaw: null,
      qrExpiraEn: null,
      pairingCode: null,
      conectadoDesde: null,
      ultimaDesconexion: null,
      motivo: 'El canal WhatsApp no está activo en este momento',
    };
  };

  const actorDe = (request: FastifyRequest) => {
    const id = request.headers['x-user-id'];
    const username = request.headers['x-user-username'];
    return {
      id: typeof id === 'string' ? id : null,
      username: typeof username === 'string' ? username : null,
    };
  };

  /**
   * **Sesión de WhatsApp** (ADR 0073): vincular con QR o código, ver el estado,
   * reconectar y cerrar sesión. Exige `settings:manage`, igual que el resto del
   * panel de canales: un QR concede el control de la cuenta de WhatsApp.
   */
  app.get(
    '/api/v1/notifications/whatsapp/session',
    { preHandler: manage },
    async (_request, reply) => reply.status(200).send(await vistaWhatsApp()),
  );

  app.post(
    '/api/v1/notifications/whatsapp/session/pair',
    { preHandler: manage },
    async (request, reply) => {
      const input = parseOrThrow(whatsappPairInputSchema, request.body ?? {});
      const sesion = await sesionWhatsApp();
      return reply.status(200).send(await sesion.pair(input, actorDe(request)));
    },
  );

  app.post(
    '/api/v1/notifications/whatsapp/session/restart',
    { preHandler: manage },
    async (_request, reply) => {
      const sesion = await sesionWhatsApp();
      return reply.status(200).send(await sesion.restart());
    },
  );

  app.post(
    '/api/v1/notifications/whatsapp/session/logout',
    { preHandler: manage },
    async (request, reply) => {
      const sesion = await sesionWhatsApp();
      await sesion.logout(actorDe(request));
      return reply.status(200).send(await sesion.vista());
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

  /**
   * Webhook de un canal que **empuja** (WhatsApp Cloud API). Es la **única** ruta
   * pública del servicio además de la salud: Meta no manda JWT, así que la
   * seguridad la da la firma (`x-hub-signature-256` con el `app_secret`), que el
   * adaptador verifica antes de procesar nada. El gateway la deja pasar sin token
   * por el mismo motivo.
   */
  const atenderWebhook = async (
    request: FastifyRequest<{ Params: { canal: string } }>,
    reply: Parameters<Parameters<FastifyInstance['route']>[0]['handler']>[1],
  ): Promise<unknown> => {
    const { canal } = parseOrThrow(webhookParamsSchema, request.params);
    const adapter = canales.registry.get(canal);
    if (adapter?.webhook === undefined) {
      throw new NotFoundError(`El canal «${canal}» no recibe webhooks`);
    }

    const respuesta = await adapter.webhook({
      metodo: request.method === 'GET' ? 'GET' : 'POST',
      query: request.query as Readonly<Record<string, string | undefined>>,
      headers: headersOf(request),
      rawBody: rawBodyOf(request),
      json: jsonBodyOf(request),
    });

    if (respuesta.contentType !== undefined) reply.type(respuesta.contentType);
    return reply.status(respuesta.estado).send(respuesta.cuerpo ?? '');
  };

  app.get('/api/v1/notifications/webhook/:canal', atenderWebhook);
  app.post('/api/v1/notifications/webhook/:canal', atenderWebhook);

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

  // Gemelas internas de la sesión de WhatsApp: las usa la CLI `whatsapp`.
  app.get('/internal/v1/notifications/whatsapp/session', async (_request, reply) =>
    reply.status(200).send(await vistaWhatsApp()),
  );

  app.post('/internal/v1/notifications/whatsapp/session/pair', async (request, reply) => {
    const input = parseOrThrow(whatsappPairInputSchema, request.body ?? {});
    const sesion = await sesionWhatsApp();
    return reply.status(200).send(await sesion.pair(input, actorDe(request)));
  });

  app.post('/internal/v1/notifications/whatsapp/session/restart', async (_request, reply) => {
    const sesion = await sesionWhatsApp();
    return reply.status(200).send(await sesion.restart());
  });

  app.post('/internal/v1/notifications/whatsapp/session/logout', async (request, reply) => {
    const sesion = await sesionWhatsApp();
    await sesion.logout(actorDe(request));
    return reply.status(200).send(await sesion.vista());
  });

  /** Fuerza un ciclo de la cola de envíos (pruebas y operación). */
  app.post('/internal/v1/notifications/process', async (_request, reply) => {
    const result = await processQueue(db, canales.registry, config, {
      appointmentLoader: (id) => services.clients.getAppointment(id),
    });
    return reply.status(200).send(result);
  });

  /**
   * **Aviso al administrador** (mejora 1 del plan post-Fase 11).
   *
   * Es por donde los demás servicios cuentan que algo se rompió —un evento que agotó sus
   * reintentos, una comprobación que falla— sin tener el token del bot: solo el servicio de
   * notificaciones lo tiene, y aquí se convierte en un mensaje.
   *
   * Responde 200 con `enviado: false` cuando el bot no está configurado: quien avisa está
   * atendiendo otra cosa y un 500 le haría creer que el aviso se perdió. Lo que sí se pierde
   * —el evento, el fallo— ya está apuntado en su sitio.
   */
  app.post('/internal/v1/notifications/admin-alert', async (request, reply) => {
    const alerta = parseOrThrow(adminAlertSchema, request.body ?? {});
    return reply.status(200).send(await services.adminAlerter.enviar(alerta));
  });

  /** Estado del bot de administración: si hay token, si hay chat y cuántos avisos salieron. */
  app.get('/internal/v1/notifications/admin-alert/status', async (_request, reply) =>
    reply.status(200).send(services.adminAlerter.estado()),
  );

  /**
   * **Prueba de un canal** desde el panel de configuración (ADR 0060). Identity no tiene el
   * bot, así que el panel delega aquí: se manda un mensaje de diagnóstico por el canal
   * pedido y se devuelve el resultado. Nunca lanza por un fallo del canal: responde
   * `ok: false` con el motivo, que es lo que el panel enseña.
   */
  app.post('/internal/v1/notifications/channels/test', async (request, reply) => {
    const input = parseOrThrow(channelTestInputSchema, request.body ?? {});
    const texto =
      'OdontoCRM · Prueba de configuración: si lees esto, el canal está bien configurado.';

    if (input.canal === 'admin') {
      const resultado = await services.adminAlerter.enviar({
        level: 'info',
        title: 'Prueba del panel de configuración',
        detail: texto,
        context: { origen: 'panel' },
        source: 'panel',
      });
      return reply.status(200).send({
        ok: resultado.enviado,
        detalle: resultado.enviado
          ? 'Aviso enviado al chat del administrador'
          : (resultado.motivo ?? 'No se pudo enviar'),
      });
    }

    const adaptador = canales.registry.get(input.canal);
    if (adaptador === null) {
      return reply.status(200).send({
        ok: false,
        detalle: `El canal ${input.canal} no está activo en esta instalación`,
      });
    }
    if (input.destino === undefined) {
      return reply
        .status(200)
        .send({ ok: false, detalle: 'Indica un destino (chat o número) para la prueba' });
    }

    const destino =
      input.canal === 'whatsapp'
        ? toE164Digits(input.destino, config.WHATSAPP_DEFAULT_COUNTRY_CODE)
        : input.destino;
    if (destino === '') {
      return reply
        .status(200)
        .send({ ok: false, detalle: 'El número de destino de WhatsApp no es válido' });
    }

    try {
      await adaptador.enviar({ direccion: destino, texto });
      return reply
        .status(200)
        .send({ ok: true, detalle: `Mensaje de prueba enviado por ${input.canal}` });
    } catch (error) {
      return reply.status(200).send({
        ok: false,
        detalle: error instanceof Error ? error.message : 'No se pudo enviar el mensaje',
      });
    }
  });
};
