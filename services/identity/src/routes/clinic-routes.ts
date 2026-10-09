import {
  completeOnboardingSchema,
  updateClinicProfileSchema,
  updateDentistProfileSchema,
} from '@odontocrm/contracts';
import {
  AppError,
  ForbiddenError,
  parseOrThrow,
  requireIdentity,
  requirePermission,
} from '@odontocrm/kernel';
import type { MultipartFile } from '@fastify/multipart';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { writeAuditEvent } from '../audit/audit-service.js';
import {
  completeOnboarding,
  getDentistProfileForUser,
  getStoredClinicProfile,
  isTitular,
  readDentistProfile,
  resolveEffectiveIdentity,
  saveClinicLogo,
  updateDentistProfile,
  upsertClinicProfile,
} from '../clinic/identity-service.js';
import type { IdentityServices } from '../services.js';
import { requestContext } from './context.js';

const userParamsSchema = z.object({ id: z.uuid() });

/** MIME que se acepta para el logo del consultorio: un SVG (lo que pide la marca). */
const LOGO_MIME = 'image/svg+xml';

/**
 * Campos que cambiaron entre dos versiones de un perfil, para la auditoría.
 *
 * Se compara por valor (no por referencias) y se ignoran las claves `reason`/`updatedAt`.
 * Devuelve nombres en el orden del objeto `after`: así el registro de auditoría dice
 * exactamente qué se tocó, sin tener que leer el diff completo.
 */
const camposCambiados = (
  before: Record<string, unknown> | null,
  after: Record<string, unknown>,
): string[] =>
  Object.keys(after).filter(
    (clave) => JSON.stringify(before?.[clave]) !== JSON.stringify(after[clave]),
  );

/**
 * Identidad del consultorio y perfil profesional del odontólogo (ADR 0056).
 *
 * Rutas **públicas** (por el gateway) que usa la interfaz:
 *  - `GET /api/v1/identity/clinic`: la identidad efectiva (base o respaldo del código).
 *  - `POST /api/v1/identity/onboarding`: el odontólogo completa su perfil la primera vez
 *    (el titular manda también los datos del consultorio).
 *  - `GET/PUT /api/v1/identity/users/me/dentist-profile`: su propio perfil.
 *  - `PUT /api/v1/identity/clinic` y `POST …/clinic/logo`: el titular o un administrador.
 *  - `PUT /api/v1/identity/users/:id/dentist-profile`: un administrador edita a cualquiera.
 *
 * **Todo cambio queda auditado** (`writeAuditEvent`), con `before`/`after`, los campos
 * tocados, el actor y —en las ediciones— un **motivo obligatorio**. Es el complemento
 * del blindaje: no basta con que el dato esté en la base, hay que poder decir quién lo
 * cambió y por qué.
 */
export const registerClinicRoutes = (app: FastifyInstance, services: IdentityServices): void => {
  const { db, blobStore } = services;

  /** ¿Quién puede tocar la identidad del consultorio? El titular o un administrador. */
  const puedeEditarConsultorio = async (request: FastifyRequest) => {
    const identity = requireIdentity(request);
    if (identity.roles.includes('admin')) return identity;
    if (await isTitular(db, identity.userId)) return identity;
    throw new ForbiddenError(
      'Solo el odontólogo titular o un administrador pueden editar estos datos',
    );
  };

  /** La identidad efectiva para la interfaz (con el logo ya resuelto). */
  app.get('/api/v1/identity/clinic', async (request, reply) => {
    requireIdentity(request);
    return reply.status(200).send(await resolveEffectiveIdentity(db, blobStore));
  });

  /**
   * Completar el perfil en el **primer acceso**. El titular manda también los datos del
   * consultorio (y son obligatorios para él: es quien los conoce). Al guardar, el
   * servidor deja de marcar `needsProfile` en la siguiente emisión de token.
   */
  app.post('/api/v1/identity/onboarding', async (request, reply) => {
    const identity = requireIdentity(request);
    const input = parseOrThrow(completeOnboardingSchema, request.body ?? {});
    const context = requestContext(request);
    const titular = await isTitular(db, identity.userId);

    if (!identity.roles.includes('odontologo')) {
      throw new ForbiddenError('Solo un odontólogo completa un perfil profesional');
    }
    if (titular && input.clinic === undefined) {
      throw new AppError({
        status: 400,
        code: 'clinic_required',
        message: 'Eres el titular: completa también los datos del consultorio',
      });
    }

    const perfilAntes = await readDentistProfile(db, identity.userId);
    const consultorioAntes = await getStoredClinicProfile(db);

    await completeOnboarding(db, identity.userId, input, { isTitular: titular });

    await writeAuditEvent(db, {
      action: 'dentist_profile_completed',
      entityType: 'dentist_profile',
      entityId: identity.userId,
      actorId: identity.userId,
      actorUsername: identity.username,
      ip: context.ip,
      userAgent: context.userAgent,
      requestId: context.requestId,
      summary: `Perfil profesional completado por ${identity.username}`,
      after: input.dentist,
      changedFields:
        perfilAntes === null
          ? Object.keys(input.dentist)
          : camposCambiados(perfilAntes, input.dentist),
    });

    if (input.clinic !== undefined) {
      await writeAuditEvent(db, {
        action: 'clinic_profile_updated',
        entityType: 'clinic_profile',
        entityId: 'clinic',
        actorId: identity.userId,
        actorUsername: identity.username,
        ip: context.ip,
        userAgent: context.userAgent,
        requestId: context.requestId,
        summary: `Datos del consultorio completados por ${identity.username}`,
        before: consultorioAntes,
        after: input.clinic,
        changedFields: camposCambiados(consultorioAntes, input.clinic),
      });
    }

    return reply.status(204).send();
  });

  /** El perfil profesional del usuario que pregunta (para el formulario de Mi perfil). */
  app.get('/api/v1/identity/users/me/dentist-profile', async (request, reply) => {
    const identity = requireIdentity(request);
    const perfil = await getDentistProfileForUser(db, identity.userId);
    return reply.status(200).send({
      username: identity.username,
      profile: perfil,
      needsProfile: perfil === null,
    });
  });

  /** El odontólogo edita lo suyo. El motivo es obligatorio (queda en auditoría). */
  app.put('/api/v1/identity/users/me/dentist-profile', async (request, reply) => {
    const identity = requireIdentity(request);
    const input = parseOrThrow(updateDentistProfileSchema, request.body ?? {});
    const context = requestContext(request);

    const antes = await getDentistProfileForUser(db, identity.userId);
    if (antes === null) {
      throw new AppError({
        status: 409,
        code: 'profile_not_completed',
        message: 'Todavía no has completado tu perfil: usa el asistente del primer acceso',
      });
    }

    await updateDentistProfile(db, identity.userId, input, { clinic: undefined });

    await writeAuditEvent(db, {
      action: 'dentist_profile_updated',
      entityType: 'dentist_profile',
      entityId: identity.userId,
      actorId: identity.userId,
      actorUsername: identity.username,
      ip: context.ip,
      userAgent: context.userAgent,
      requestId: context.requestId,
      summary: `Perfil profesional editado por ${identity.username}`,
      before: antes,
      after: input,
      changedFields: camposCambiados(antes, input),
      reason: input.reason,
    });

    return reply.status(204).send();
  });

  /**
   * El **titular** (o un administrador) actualiza los datos del consultorio. El motivo es
   * obligatorio: es el dato que encabeza todos los documentos.
   */
  app.put('/api/v1/identity/clinic', async (request, reply) => {
    const identity = await puedeEditarConsultorio(request);
    const input = parseOrThrow(updateClinicProfileSchema, request.body ?? {});
    const context = requestContext(request);

    const antes = await getStoredClinicProfile(db);
    await upsertClinicProfile(db, input, { completed: true });

    await writeAuditEvent(db, {
      action: 'clinic_profile_updated',
      entityType: 'clinic_profile',
      entityId: 'clinic',
      actorId: identity.userId,
      actorUsername: identity.username,
      ip: context.ip,
      userAgent: context.userAgent,
      requestId: context.requestId,
      summary: `Datos del consultorio editados por ${identity.username}`,
      before: antes,
      after: input,
      changedFields: camposCambiados(antes, input),
      reason: input.reason,
    });

    return reply.status(204).send();
  });

  /**
   * Subida del **logo** (SVG). Se guarda en el almacén compartido y se sirve incrustado en
   * los PDF y en la interfaz. La **marca de agua** usa el mismo logo; su opacidad y su
   * ancho siguen siendo de la marca (`brand.ts`), que se edita solo en el código.
   */
  app.post('/api/v1/identity/clinic/logo', async (request, reply) => {
    const identity = await puedeEditarConsultorio(request);
    const context = requestContext(request);

    const body = request.body as { file?: MultipartFile } | undefined;
    const file = body?.file;
    if (file === undefined) {
      throw new AppError({
        status: 400,
        code: 'missing_file',
        message: 'Adjunta el logo en el campo «file»',
      });
    }
    if (file.mimetype !== LOGO_MIME) {
      throw new AppError({
        status: 400,
        code: 'invalid_logo_type',
        message: 'El logo tiene que ser un SVG (image/svg+xml)',
      });
    }
    if (blobStore === null) {
      throw new AppError({
        status: 503,
        code: 'storage_unavailable',
        message: 'El almacén no está configurado en este servicio',
      });
    }

    const data = await file.toBuffer();
    await saveClinicLogo(db, blobStore, {
      data,
      originalName: file.filename ?? 'logo.svg',
      mime: LOGO_MIME,
    });

    await writeAuditEvent(db, {
      action: 'clinic_logo_updated',
      entityType: 'clinic_profile',
      entityId: 'clinic',
      actorId: identity.userId,
      actorUsername: identity.username,
      ip: context.ip,
      userAgent: context.userAgent,
      requestId: context.requestId,
      summary: `Logo del consultorio actualizado por ${identity.username}`,
      changedFields: ['logo'],
    });

    return reply.status(204).send();
  });

  /** Un administrador lee el perfil profesional de un odontólogo (para editarlo). */
  app.get(
    '/api/v1/identity/users/:id/dentist-profile',
    { preHandler: requirePermission('users:manage') },
    async (request, reply) => {
      const { id } = parseOrThrow(userParamsSchema, request.params);
      const perfil = await getDentistProfileForUser(db, id);
      return reply.status(200).send({ profile: perfil, needsProfile: perfil === null });
    },
  );

  /** Un administrador edita el perfil profesional de cualquier odontólogo. */
  app.put(
    '/api/v1/identity/users/:id/dentist-profile',
    { preHandler: requirePermission('users:manage') },
    async (request, reply) => {
      const identity = requireIdentity(request);
      const { id } = parseOrThrow(userParamsSchema, request.params);
      const input = parseOrThrow(updateDentistProfileSchema, request.body ?? {});
      const context = requestContext(request);

      const antes = await getDentistProfileForUser(db, id);
      if (antes === null) {
        throw new AppError({
          status: 409,
          code: 'profile_not_completed',
          message: 'Ese odontólogo todavía no ha completado su perfil',
        });
      }

      await updateDentistProfile(db, id, input, { clinic: undefined });

      await writeAuditEvent(db, {
        action: 'dentist_profile_updated',
        entityType: 'dentist_profile',
        entityId: id,
        actorId: identity.userId,
        actorUsername: identity.username,
        ip: context.ip,
        userAgent: context.userAgent,
        requestId: context.requestId,
        summary: `Perfil profesional editado por ${identity.username} (administrador)`,
        before: antes,
        after: input,
        changedFields: camposCambiados(antes, input),
        reason: input.reason,
      });

      return reply.status(204).send();
    },
  );
};
