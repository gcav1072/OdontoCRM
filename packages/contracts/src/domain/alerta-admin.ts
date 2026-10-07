import { z } from 'zod';

/**
 * **Aviso al administrador**: cómo un servicio (o una herramienta de consola) le dice al
 * dueño del consultorio que algo se rompió, sin que nadie tenga que mirar un registro.
 *
 * Va por el **bot de administración**, que es un bot de Telegram aparte del que habla con
 * los pacientes: el de los pacientes lo ven las familias y no debe recibir mensajes de
 * infraestructura —«el outbox de clinical lleva 40 minutos sin publicar» no es para un
 * paciente, y quien lo lea tiene que ser quien puede arreglarlo—.
 *
 * El aviso es un **texto libre con etiquetas**, no un evento de dominio: no se audita ni se
 * proyecta, se manda. Por eso vive en su propio archivo y no en el catálogo de eventos.
 */

/**
 * Gravedad del aviso. Decide el icono del mensaje y poco más: la diferencia real es que
 * `critical` es «hay algo roto y se pierden datos» y `warning`, «esto va a romperse».
 */
export const ADMIN_ALERT_LEVELS = ['critical', 'warning', 'info'] as const;
export type AdminAlertLevel = (typeof ADMIN_ALERT_LEVELS)[number];

export const adminAlertSchema = z.object({
  level: z.enum(ADMIN_ALERT_LEVELS).default('warning'),
  /** Una línea: lo que se lee en la notificación del móvil. */
  title: z.string().trim().min(3).max(160),
  /** El detalle, si lo hay: el error, los números, qué mirar. */
  detail: z.string().trim().max(2000).nullable().default(null),
  /** Quién avisa (`screens`, `verify-backup`…): sin esto no se sabe de dónde viene. */
  source: z.string().trim().min(1).max(60),
  /**
   * Datos sueltos que ayuden a diagnosticar (cola, evento, reintentos, paciente…). Se
   * imprimen como líneas `clave: valor`; nunca se meten secretos aquí.
   */
  context: z.record(z.string(), z.unknown()).default({}),
});

export type AdminAlert = z.infer<typeof adminAlertSchema>;

/** Lo que responde el servicio de notificaciones: si salió y, si no, por qué no. */
export const adminAlertResultSchema = z.object({
  enviado: z.boolean(),
  /** Motivo legible cuando no salió (sin bot configurado, Telegram no respondió…). */
  motivo: z.string().nullable(),
});
export type AdminAlertResult = z.infer<typeof adminAlertResultSchema>;

/** Estado del bot de administración (lo enseña el panel de estado del administrador). */
export const adminAlertStatusSchema = z.object({
  /** Hay token: el bot puede mandar mensajes. */
  configurado: z.boolean(),
  /** Hay chat de destino: sin él el bot no sabe a quién escribir. */
  chatConfigurado: z.boolean(),
  enviados: z.number().int().nonnegative(),
  ultimoEnvio: z.string().nullable(),
});
export type AdminAlertStatus = z.infer<typeof adminAlertStatusSchema>;

/**
 * Formatea el aviso como el texto que viaja por Telegram.
 *
 * Vive en el contrato —y no en el servicio— porque lo usan **dos** caminos que no comparten
 * proceso: el servicio de notificaciones (cuando un servicio avisa por la red interna) y las
 * herramientas de consola (`tools/lib/alerta-admin.mjs`, que habla con Telegram directamente
 * porque corre fuera de la pila). Un mismo aviso tiene que leerse igual por los dos.
 */
export const formatAdminAlert = (alert: AdminAlert, at: Date = new Date()): string => {
  const icono = alert.level === 'critical' ? '🔴' : alert.level === 'warning' ? '🟠' : '🔵';
  const etiqueta =
    alert.level === 'critical' ? 'CRÍTICO' : alert.level === 'warning' ? 'AVISO' : 'INFO';

  const hora = new Intl.DateTimeFormat('es-VE', {
    timeZone: 'America/Caracas',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(at);

  const lineas = [`${icono} ${etiqueta} · OdontoCRM`, '', alert.title];
  if (alert.detail !== null && alert.detail !== '') lineas.push('', alert.detail);

  const contexto = Object.entries(alert.context)
    .map(
      ([clave, valor]) =>
        [clave, typeof valor === 'string' ? valor : JSON.stringify(valor)] as const,
    )
    .filter(([, valor]) => valor !== undefined && valor !== '' && valor !== 'null');

  if (contexto.length > 0) {
    lineas.push('');
    for (const [clave, valor] of contexto) lineas.push(`${clave}: ${String(valor)}`);
  }

  lineas.push('', `${hora} · ${alert.source}`);
  return lineas.join('\n');
};
