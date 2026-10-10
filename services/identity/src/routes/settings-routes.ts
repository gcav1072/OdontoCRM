import {
  appSettingsInputSchema,
  brandRootBlock,
  brandSettingsInputSchema,
  channelSettingsInputSchema,
  channelTestInputSchema,
  DEFAULT_UI_ACCENT,
  type AppSettingsView,
  type ChannelTestResult,
} from '@odontocrm/contracts';
import { AppError, parseOrThrow, requireIdentity, requirePermission } from '@odontocrm/kernel';
import type { MultipartFile } from '@fastify/multipart';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { writeAuditEvent } from '../audit/audit-service.js';
import type { IdentityServices } from '../services.js';
import { effectiveAccent, readAppSettings, updateAppSettings } from '../settings/app-service.js';
import {
  addBrandFont,
  defaultBrandSettings,
  effectiveBrand,
  readBrandSettings,
  removeBrandFont,
  updateBrandSettings,
} from '../settings/brand-service.js';
import { readChannelView, updateChannelSettings } from '../settings/channel-service.js';
import { requestContext } from './context.js';

/** Tope del archivo de fuente (un subconjunto `latin` ronda los 30–60 KiB; 1 MiB sobra). */
const MAX_FONT_BYTES = 1024 * 1024;

/** MIME que se acepta para una fuente subida. */
const FONT_MIME = 'font/woff2';

const fuenteCamposSchema = z.object({
  /** Familia a la que pertenece el archivo (el nombre del `@font-face`). */
  family: z.string().trim().min(1).max(60),
  weight: z.coerce.number().int().min(100).max(900),
  style: z.enum(['normal', 'italic']),
});

const borrarFuenteSchema = z.object({ path: z.string().trim().min(1).max(400) });

/**
 * Valor de un campo de un `multipart/form-data`: con `attachFieldsToBody` los campos de
 * texto llegan como objeto (`{ value }`) y los archivos como `MultipartFile`.
 */
const campoTexto = (campo: unknown): string | undefined => {
  if (typeof campo === 'string') return campo;
  const value = (campo as { value?: unknown } | undefined)?.value;
  return typeof value === 'string' ? value : undefined;
};

/** Campos del diff que se registran en la auditoría (para no volcar los secretos). */
const CAMPOS_CANAL = [
  'telegramBotToken',
  'telegramBotUsername',
  'adminTelegramBotToken',
  'adminTelegramChatId',
  'whatsappToken',
  'whatsappPhoneId',
  'whatsappVerifyToken',
  'whatsappAppSecret',
  'whatsappApiBase',
] as const;

/** Los campos de canal que el actor **tocó** (los `undefined` no cuentan). */
const camposCanalTocados = (input: Record<string, unknown>): string[] =>
  CAMPOS_CANAL.filter((campo) => input[campo] !== undefined).map(String);

/**
 * **Configuración de la aplicación** (ADR 0060). Prefijo público `/api/v1/settings`.
 *
 *  - `GET /` — la configuración efectiva (marca, acento, textos y canales). La lee
 *    cualquier sesión válida: la necesita el proveedor que aplica la marca y el acento
 *    a toda la SPA al arrancar.
 *  - `PUT /brand`, `POST/DELETE /brand/fonts`, `PUT /app`, `PUT /channels`,
 *    `POST /channels/test` — **solo `settings:manage`** (el `admin`).
 *
 * Todo cambio queda **auditado**. Los **secretos** nunca se devuelven: la vista los
 * enmascara y las credenciales en claro solo salen por la ruta interna.
 */
export const registerSettingsRoutes = (app: FastifyInstance, services: IdentityServices): void => {
  const { db, blobStore, config } = services;
  const manage = requirePermission('settings:manage');

  /** La configuración completa tal como la lee la SPA. */
  app.get('/api/v1/settings', async (request, reply) => {
    requireIdentity(request);

    const [marca, app_, canales, efectiva] = await Promise.all([
      readBrandSettings(db),
      readAppSettings(db),
      readChannelView(db, config),
      effectiveBrand(db, blobStore),
    ]);

    const vista: AppSettingsView = {
      brand: marca.settings,
      brandFromDatabase: marca.fromDatabase,
      themeCss: `${brandRootBlock(efectiva.theme)}\n${efectiva.fontFaceCss}`,
      accent: app_.accent,
      accentEffective: effectiveAccent(app_.accent),
      screenTexts: app_.screenTexts,
      channels: canales,
      defaults: {
        brand: defaultBrandSettings(),
        accent: DEFAULT_UI_ACCENT,
      },
    };
    return reply.status(200).send(vista);
  });

  /** Reemplaza la marca de los imprimibles (paleta, tipografías, medidas y fuentes). */
  app.put('/api/v1/settings/brand', { preHandler: manage }, async (request, reply) => {
    const identity = requireIdentity(request);
    const input = parseOrThrow(brandSettingsInputSchema, request.body ?? {});
    const context = requestContext(request);

    const antes = await readBrandSettings(db);
    await updateBrandSettings(db, input, identity.userId);

    await writeAuditEvent(db, {
      action: 'brand_updated',
      entityType: 'brand_settings',
      entityId: 'brand',
      actorId: identity.userId,
      actorUsername: identity.username,
      ip: context.ip,
      userAgent: context.userAgent,
      requestId: context.requestId,
      summary: `Marca de los imprimibles actualizada por ${identity.username}`,
      before: antes.fromDatabase ? (antes.settings as unknown as Record<string, unknown>) : null,
      after: input as unknown as Record<string, unknown>,
      changedFields: ['palette', 'typography', 'letterhead', 'fonts'],
    });

    return reply.status(200).send(await effectiveBrand(db, blobStore));
  });

  /**
   * Sube una fuente `.woff2` (multipart) y la añade a la **familia** indicada. El campo
   * `family` llega en el formulario; aquí solo se dice a qué familia va, con qué peso y
   * estilo.
   */
  app.post('/api/v1/settings/brand/fonts', { preHandler: manage }, async (request, reply) => {
    const identity = requireIdentity(request);
    const context = requestContext(request);
    if (blobStore === null) {
      throw new AppError({
        status: 503,
        code: 'storage_unavailable',
        message: 'El almacén no está configurado: no se pueden guardar fuentes',
      });
    }

    const body = request.body as
      { file?: MultipartFile; family?: unknown; weight?: unknown; style?: unknown } | undefined;
    const file = body?.file;
    if (file === undefined) {
      throw new AppError({
        status: 400,
        code: 'missing_file',
        message: 'Adjunta la fuente en «file»',
      });
    }
    const campos = parseOrThrow(fuenteCamposSchema, {
      family: campoTexto(body?.family),
      weight: campoTexto(body?.weight),
      style: campoTexto(body?.style),
    });
    if (file.mimetype !== FONT_MIME && !file.filename.toLowerCase().endsWith('.woff2')) {
      throw new AppError({
        status: 400,
        code: 'invalid_font_type',
        message: 'La fuente tiene que ser un .woff2',
      });
    }

    const data = await file.toBuffer();
    if (data.byteLength === 0) {
      throw new AppError({ status: 400, code: 'empty_file', message: 'El archivo llegó vacío' });
    }
    if (data.byteLength > MAX_FONT_BYTES) {
      throw new AppError({
        status: 413,
        code: 'font_too_large',
        message: 'La fuente es demasiado grande (máximo 1 MiB)',
      });
    }

    const actualizado = await addBrandFont(
      db,
      blobStore,
      { data, originalName: file.filename, weight: campos.weight, style: campos.style },
      campos.family,
      identity.userId,
    );

    await writeAuditEvent(db, {
      action: 'brand_updated',
      entityType: 'brand_settings',
      entityId: 'brand',
      actorId: identity.userId,
      actorUsername: identity.username,
      ip: context.ip,
      userAgent: context.userAgent,
      requestId: context.requestId,
      summary: `Fuente «${file.filename}» (${campos.family} · ${String(campos.weight)} ${campos.style}) añadida por ${identity.username}`,
      after: {
        font: file.filename,
        family: campos.family,
        weight: campos.weight,
        style: campos.style,
      },
      changedFields: ['fonts'],
    });

    return reply.status(200).send(actualizado);
  });

  /** Quita una fuente **subida** (las de respaldo del repositorio no se tocan). */
  app.delete('/api/v1/settings/brand/fonts', { preHandler: manage }, async (request, reply) => {
    const identity = requireIdentity(request);
    const input = parseOrThrow(borrarFuenteSchema, request.query ?? {});
    const context = requestContext(request);

    const actualizado = await removeBrandFont(db, blobStore, input.path, identity.userId);

    await writeAuditEvent(db, {
      action: 'brand_updated',
      entityType: 'brand_settings',
      entityId: 'brand',
      actorId: identity.userId,
      actorUsername: identity.username,
      ip: context.ip,
      userAgent: context.userAgent,
      requestId: context.requestId,
      summary: `Fuente «${input.path}» quitada por ${identity.username}`,
      after: { font: input.path },
      changedFields: ['fonts'],
    });

    return reply.status(200).send(actualizado);
  });

  /** Acento de la interfaz y textos del kiosko. */
  app.put('/api/v1/settings/app', { preHandler: manage }, async (request, reply) => {
    const identity = requireIdentity(request);
    const input = parseOrThrow(appSettingsInputSchema, request.body ?? {});
    const context = requestContext(request);

    const antes = await readAppSettings(db);
    await updateAppSettings(db, input, identity.userId);

    await writeAuditEvent(db, {
      action: 'app_settings_updated',
      entityType: 'app_settings',
      entityId: 'app',
      actorId: identity.userId,
      actorUsername: identity.username,
      ip: context.ip,
      userAgent: context.userAgent,
      requestId: context.requestId,
      summary: `Configuración de la aplicación actualizada por ${identity.username}`,
      before: { accent: antes.accent, screenTexts: antes.screenTexts },
      after: { accent: input.accent, screenTexts: input.screenTexts },
      changedFields: ['accent', 'screenTexts'],
    });

    return reply.status(200).send(input);
  });

  /**
   * Credenciales de los canales. Los secretos se guardan **cifrados** y nunca vuelven
   * por aquí: la respuesta es la vista enmascarada.
   */
  app.put('/api/v1/settings/channels', { preHandler: manage }, async (request, reply) => {
    const identity = requireIdentity(request);
    const input = parseOrThrow(channelSettingsInputSchema, request.body ?? {});
    const context = requestContext(request);

    await updateChannelSettings(db, input, identity.userId, config);

    await writeAuditEvent(db, {
      action: 'channel_settings_updated',
      entityType: 'channel_settings',
      entityId: 'channels',
      actorId: identity.userId,
      actorUsername: identity.username,
      ip: context.ip,
      userAgent: context.userAgent,
      requestId: context.requestId,
      summary: `Canales de mensajería actualizados por ${identity.username}`,
      // Se registran los campos tocados, **nunca** sus valores (son secretos).
      changedFields: camposCanalTocados(input as unknown as Record<string, unknown>),
    });

    return reply.status(200).send(await readChannelView(db, config));
  });

  /**
   * Prueba de un canal desde el panel: identity **delega** en notificaciones, que es
   * quien tiene el bot y el transporte. No cambia nada.
   */
  app.post('/api/v1/settings/channels/test', { preHandler: manage }, async (request, reply) => {
    requireIdentity(request);
    const input = parseOrThrow(channelTestInputSchema, request.body ?? {});

    const secret = config.INTERNAL_SERVICE_SECRET;
    if (secret === undefined) {
      const resultado: ChannelTestResult = {
        ok: false,
        detalle: 'Las rutas internas están deshabilitadas en este entorno',
      };
      return reply.status(200).send(resultado);
    }

    try {
      const respuesta = await fetch(
        new URL('/internal/v1/notifications/channels/test', config.NOTIFICATIONS_URL),
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-internal-token': secret },
          body: JSON.stringify(input),
          signal: AbortSignal.timeout(15_000),
        },
      );
      const resultado = (await respuesta.json()) as ChannelTestResult;
      return reply.status(200).send(resultado);
    } catch (error) {
      const resultado: ChannelTestResult = {
        ok: false,
        detalle: error instanceof Error ? error.message : 'No se pudo contactar al servicio',
      };
      return reply.status(200).send(resultado);
    }
  });
};
