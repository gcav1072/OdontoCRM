import { ForbiddenError, parseQuery } from '@odontocrm/kernel';
import type { FastifyInstance } from 'fastify';
import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

import { letterheadSnapshot } from '../clinic/identity-service.js';
import type { IdentityServices } from '../services.js';

const letterheadQuerySchema = z.object({
  /** Usuario que va a firmar: resuelve **qué** odontólogo devuelve la instantánea. */
  dentist: z.string().trim().max(32).optional(),
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
};
