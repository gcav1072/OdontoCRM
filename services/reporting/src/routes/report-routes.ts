import {
  reportFileName,
  reportFiltersSchema,
  reportParamsSchema,
  reportPermissionFor,
  reportToCsv,
  type ReportKey,
} from '@odontocrm/contracts';
import {
  ForbiddenError,
  ServiceUnavailableError,
  ValidationError,
  parseOrThrow,
  parseQuery,
  requirePermission,
} from '@odontocrm/kernel';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { timingSafeEqual } from 'node:crypto';

import { refreshMaterializedViews } from '../refresh.js';
import { reportHtml } from '../report-html.js';
import {
  buildReportDocument,
  buildReportSummary,
  hoyEnElConsultorio,
  rangoDeFiltros,
} from '../reports/index.js';
import { readModelStatus } from '../reports/status.js';
import type { ReportContext } from '../reports/shared.js';
import type { ReportingServices } from '../services.js';

const safeEquals = (left: string, right: string): boolean => {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
};

/**
 * Rutas del servicio de reportes:
 *
 *  - **reportes** (`GET /api/v1/reports/…`): el catálogo cerrado del contrato. El
 *    permiso **depende del reporte** (`reportPermissionFor`): los operativos van con
 *    `reports:read` y los clínicos con `reports:clinical` ([ADR 0039](../../../../docs/adr/0039-reportes-clinicos-con-permiso-propio.md)).
 *  - **exportación** (`…/export.csv` y `…/export.pdf`): mismo permiso que el reporte y
 *    el mismo documento, para que lo descargado sea exactamente lo que se ve.
 *  - **interno**: el refresco manual de las vistas y el diagnóstico del read model,
 *    protegidos con el token compartido (el gateway no los publica).
 */
export const registerReportRoutes = (app: FastifyInstance, services: ReportingServices): void => {
  const { db, config, pdf } = services;
  const read = requirePermission('reports:read');
  const clinical = requirePermission('reports:clinical');

  /** Permiso que exige cada clave del catálogo. */
  const permisoDe = (key: ReportKey): ((request: FastifyRequest) => Promise<void>) =>
    reportPermissionFor(key) === 'reports:clinical' ? clinical : read;

  /**
   * Guardia de las rutas con `:key`: valida la clave (400 si no existe) y exige el
   * permiso que le toca. Se hace en el `preHandler` y no en el manejador para que un
   * reporte clínico no llegue ni a construirse sin permiso.
   */
  const conPermisoDelReporte = async (request: FastifyRequest): Promise<void> => {
    const { key } = parseOrThrow(reportParamsSchema, request.params);
    await permisoDe(key)(request);
  };

  const hoy = (): string => hoyEnElConsultorio(config.TZ);

  /** Filtros + rango resuelto + instante de generación: lo que recibe cada reporte. */
  const contexto = (request: FastifyRequest): ReportContext => {
    const filters = parseQuery(reportFiltersSchema, request.query);
    try {
      return {
        filters,
        range: rangoDeFiltros(filters, hoy()),
        generatedAt: new Date().toISOString(),
      };
    } catch (error) {
      // El contrato lanza un `Error` legible («el rango empieza después de
      // terminar»): se convierte en 400 en vez de en un 500 sin explicación.
      throw new ValidationError(
        error instanceof Error ? error.message : 'El rango del reporte no es válido',
        [{ path: 'from/to', message: 'Rango de fechas inválido' }],
      );
    }
  };

  /* ── Tablero del día ─────────────────────────────────────────────────────── */

  app.get('/api/v1/reports/summary', { preHandler: read }, async (_request, reply) =>
    reply.status(200).send(await buildReportSummary({ db }, hoy())),
  );

  /* ── Documento del reporte ───────────────────────────────────────────────── */

  app.get('/api/v1/reports/:key', { preHandler: conPermisoDelReporte }, async (request, reply) => {
    const { key } = parseOrThrow(reportParamsSchema, request.params);
    return reply.status(200).send(await buildReportDocument(key, { db }, contexto(request)));
  });

  /* ── Exportación ─────────────────────────────────────────────────────────── */

  app.get(
    '/api/v1/reports/:key/export.csv',
    { preHandler: conPermisoDelReporte },
    async (request, reply) => {
      const { key } = parseOrThrow(reportParamsSchema, request.params);
      const ctx = contexto(request);
      const documento = await buildReportDocument(key, { db }, ctx);
      return reply
        .status(200)
        .header(
          'content-disposition',
          `attachment; filename="${reportFileName(key, ctx.range, 'csv')}"`,
        )
        .type('text/csv; charset=utf-8')
        .send(reportToCsv(documento));
    },
  );

  app.get(
    '/api/v1/reports/:key/export.pdf',
    { preHandler: conPermisoDelReporte },
    async (request, reply) => {
      const { key } = parseOrThrow(reportParamsSchema, request.params);
      const ctx = contexto(request);
      const documento = await buildReportDocument(key, { db }, ctx);

      let cuerpo: Buffer;
      try {
        cuerpo = await pdf.render(reportHtml(documento));
      } catch (error) {
        request.log.error({ err: error, key }, 'No se pudo generar el PDF del reporte');
        throw new ServiceUnavailableError(
          'No se pudo generar el PDF en este momento. Vuelve a intentarlo en un minuto.',
        );
      }

      return reply
        .status(200)
        .header(
          'content-disposition',
          `attachment; filename="${reportFileName(key, ctx.range, 'pdf')}"`,
        )
        .type('application/pdf')
        .send(cuerpo);
    },
  );

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

  /** Refresco manual de las vistas materializadas (también lo hace el job nocturno). */
  app.post('/internal/v1/reporting/refresh', async (_request, reply) => {
    const resultado = await refreshMaterializedViews(db, { trigger: 'manual' });
    services.lastError = resultado.ok ? null : resultado.error;
    return reply.status(resultado.ok ? 200 : 500).send(resultado);
  });

  /** Diagnóstico del read model: conteos, última ingesta y último refresco. */
  app.get('/internal/v1/reporting/status', async (_request, reply) =>
    reply.status(200).send(await readModelStatus(db, config)),
  );
};
