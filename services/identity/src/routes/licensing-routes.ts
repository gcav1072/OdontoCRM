import { parseOrThrow, requireIdentity, requirePermission } from '@odontocrm/kernel';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import {
  activateLicense,
  MAX_LICENSE_TOKEN_LENGTH,
  readLicensingState,
  toAdminView,
  toPublicView,
} from '../licensing/licensing-service.js';
import type { IdentityServices } from '../services.js';
import { requestContext } from './context.js';

/** Cuerpo de activación: el JWT compacto pegado o el contenido del archivo `.lic`. */
const activationBodySchema = z.object({
  licencia: z
    .string()
    .trim()
    .min(20, 'La licencia está vacía o incompleta')
    .max(MAX_LICENSE_TOKEN_LENGTH, 'La licencia es demasiado larga para ser válida'),
});

/**
 * Rutas del **licenciamiento** (ADR 0075). Prefijo público `/api/v1/licensing`.
 *
 *  - `GET /public` — **sin sesión**: lo que la SPA necesita para pintar el banner de
 *    prueba/vencimiento incluso en `/login`. No lleva datos del consultorio.
 *  - `GET /status` — solo `licensing:manage` (el titular). Vista completa con la
 *    instalación y la solicitud lista para reenviar al proveedor.
 *  - `POST /activate` — solo `licensing:manage`. Verifica la firma de la licencia y
 *    la guarda; es lo que devuelve la escritura sin reiniciar (el siguiente refresco
 *    de sesión emite permisos completos otra vez).
 */
export const registerLicensingRoutes = (app: FastifyInstance, services: IdentityServices): void => {
  const { db, licensePublicKey } = services;
  const manage = requirePermission('licensing:manage');

  app.get('/api/v1/licensing/public', async (_request, reply) => {
    const estado = await readLicensingState(db);
    return reply.status(200).send(toPublicView(estado.status));
  });

  app.get('/api/v1/licensing/status', { preHandler: manage }, async (_request, reply) => {
    const estado = await readLicensingState(db);
    return reply.status(200).send(await toAdminView(db, estado));
  });

  app.post('/api/v1/licensing/activate', { preHandler: manage }, async (request, reply) => {
    const identity = requireIdentity(request);
    const input = parseOrThrow(activationBodySchema, request.body ?? {});
    const context = requestContext(request);

    const vista = await activateLicense(db, {
      token: input.licencia,
      publicKey: licensePublicKey,
      actor: {
        actorId: identity.userId,
        actorUsername: identity.username,
        motivo: 'activación desde la web',
        ip: context.ip,
        userAgent: context.userAgent,
        requestId: context.requestId,
      },
    });

    return reply.status(200).send(vista);
  });
};
