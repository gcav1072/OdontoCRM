import { ForbiddenError, requireIdentity } from '@odontocrm/kernel';
import type { FastifyRequest } from 'fastify';

/**
 * Guardia del **panel de estado**: solo el administrador.
 *
 * El informe consolidado no es un dato clínico, pero sí de las entrañas de la instalación
 * (puertos internos, conexiones del pool, eventos sin publicar). Quien administra el
 * consultorio lo necesita para diagnosticar; la secretaría y el odontólogo no, y no
 * tienen por qué verlo.
 *
 * Se comprueba el **rol** y no un permiso suelto: es la misma regla que ya rige para
 * «¿esta persona administra el sistema?», y añadir un permiso nuevo obligaría a tocar los
 * catálogos de los tres roles para dejarlo igual que está.
 *
 * Se mantiene la regla de siempre: mientras la contraseña sea temporal, nada.
 */
export const requireAdmin = async (request: FastifyRequest): Promise<void> => {
  const identity = requireIdentity(request);
  if (identity.mustChangePassword) {
    throw new ForbiddenError('Debes cambiar tu contraseña antes de continuar');
  }
  if (!identity.roles.includes('admin')) {
    throw new ForbiddenError('Solo el administrador puede ver el estado del sistema');
  }
};
