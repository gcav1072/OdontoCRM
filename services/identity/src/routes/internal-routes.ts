import { ForbiddenError, parseOrThrow, parseQuery } from '@odontocrm/kernel';
import type { FastifyInstance } from 'fastify';
import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

import { letterheadSnapshot, listDentists } from '../clinic/identity-service.js';
import {
  activateLicense,
  MAX_LICENSE_TOKEN_LENGTH,
  readLicensingState,
  toAdminView,
} from '../licensing/licensing-service.js';
import { effectiveBrand } from '../settings/brand-service.js';
import { readChannelCredentials } from '../settings/channel-service.js';
import type { IdentityServices } from '../services.js';
import { requestContext } from './context.js';

const letterheadQuerySchema = z.object({
  /** Usuario que va a firmar: resuelve **qué** odontólogo devuelve la instantánea. */
  dentist: z.string().trim().max(32).optional(),
});

/** Activación desde el bot del consultorio: el `.lic` y el motivo que queda en auditoría. */
const licenciaInternaSchema = z.object({
  licencia: z
    .string()
    .trim()
    .min(20, 'La licencia está vacía o incompleta')
    .max(MAX_LICENSE_TOKEN_LENGTH, 'La licencia es demasiado larga para ser válida'),
  motivo: z.string().trim().max(200).optional(),
});

const safeEquals = (left: string, right: string): boolean => {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
};

/**
 * Rutas **internas** de identity (solo red interna, con el secreto compartido).
 *
 * Identity era el único servicio sin rutas internas: hasta ahora nadie leía nada suyo.
 * Con la identidad en la base (ADR 0056), los servicios que componen documentos
 * (clinical, reporting, billing) y los que arman avisos o pantallas (notifications,
 * scheduling, screens) necesitan **leerla**, y leerla por el gateway sería un rodeo
 * (además de un permiso que esos servicios no tienen por qué pedir).
 *
 * La lectura es **una sola** (`/internal/v1/identity/letterhead`) y trae ya resuelto
 * quién firma y el logo incrustado: así la regla «quién firma» y el respaldo a `CLINIC`
 * viven en un único sitio, y los consumidores solo pintan.
 *
 * Con la **licencia** (ADR 0075) se añaden dos rutas: `GET /internal/v1/licensing/status`
 * y `POST /internal/v1/licensing/activate`. Son lo que usa el bot de administración para
 * enseñar el estado y para activar el archivo `.lic` que el dueño reenvía por Telegram.
 */
export const registerInternalRoutes = (app: FastifyInstance, services: IdentityServices): void => {
  const { db, blobStore, config } = services;

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
   * La instantánea del membrete: identidad del consultorio, el odontólogo que firma
   * —según el usuario que emite el documento— y el logo como `data:` URI. Todo con
   * **respaldo al código** (`CLINIC`): si no hay perfil guardado, devuelve lo de siempre.
   */
  app.get('/internal/v1/identity/letterhead', async (request, reply) => {
    const query = parseQuery(letterheadQuerySchema, request.query);
    return reply.status(200).send(await letterheadSnapshot(db, blobStore, query.dentist ?? null));
  });

  /**
   * El catálogo de odontólogos con perfil: `id → nombre` (más MPPS y especialidad).
   * Lo lee la agenda para rotular el odontólogo de una cita sin guardar su nombre en
   * la cita, y para el selector de la interfaz. Cambia poco, así que el consumidor lo
   * cachea unos minutos.
   */
  app.get('/internal/v1/identity/dentists', async (_request, reply) => {
    const items = await listDentists(db);
    return reply.status(200).send({ items, total: items.length });
  });

  /**
   * La **marca efectiva** de los imprimibles (ADR 0060): el tema, las fuentes ya
   * incrustadas y el logo. La leen clinical, reporting y billing para componer el papel
   * sin saber si la marca viene de la base o del respaldo del código.
   */
  app.get('/internal/v1/identity/brand', async (_request, reply) => {
    return reply.status(200).send(await effectiveBrand(db, blobStore));
  });

  /**
   * Las **credenciales de los canales** en claro. Solo por la red interna: llevan los
   * tokens de Telegram y de WhatsApp, que nunca viajan por el gateway.
   */
  app.get('/internal/v1/identity/channels', async (_request, reply) => {
    return reply.status(200).send(await readChannelCredentials(db, config));
  });

  /**
   * El estado de la **licencia** (ADR 0075) para el bot de administración y para
   * `npm run estado`: es la vista del administrador, con la instalación y la
   * solicitud ya armadas.
   */
  app.get('/internal/v1/licensing/status', async (_request, reply) => {
    const estado = await readLicensingState(db);
    return reply.status(200).send(await toAdminView(db, estado));
  });

  /**
   * Activación desde el **bot de administración**: el dueño reenvía el archivo
   * `.lic` y el bot lo manda por aquí. Solo **verifica** la firma; la clave privada
   * vive en la máquina del proveedor, nunca en el consultorio. El actor es `null`
   * (no es una sesión de usuario) y el motivo queda en la auditoría.
   */
  app.post('/internal/v1/licensing/activate', async (request, reply) => {
    const input = parseOrThrow(licenciaInternaSchema, request.body ?? {});
    const context = requestContext(request);

    const vista = await activateLicense(db, {
      token: input.licencia,
      publicKey: services.licensePublicKey,
      actor: {
        motivo: input.motivo ?? 'bot de administración',
        ip: context.ip,
        userAgent: context.userAgent,
        requestId: context.requestId,
      },
    });

    return reply.status(200).send(vista);
  });
};
