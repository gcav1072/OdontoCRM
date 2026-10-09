import type { GatewayConfig } from './config.js';

export interface ProxyRoute {
  /** Prefijo público que atiende el gateway (docs/PLAN_MAESTRO_FASES.md §6). */
  prefix: string;
  /** Servicio interno que responde. */
  upstream: string;
  description: string;
  /**
   * Reemplazo del prefijo. Si se omite, **se conserva la ruta**: cada servicio es
   * dueño de su prefijo público (`/api/v1/users/...` llega igual a identity), lo
   * que evita colisiones cuando un servicio atiende varios prefijos.
   */
  rewritePrefix?: string;
}

/**
 * Rutas del gateway. Los servicios que todavía no existen simplemente no se
 * registran: el plan se implementa fase por fase y el gateway sigue siendo
 * válido en cada una.
 */
export const buildProxyRoutes = (config: GatewayConfig): ProxyRoute[] => {
  const routes: ProxyRoute[] = [];

  const add = (
    prefix: string,
    upstream: string | undefined,
    description: string,
    rewritePrefix?: string,
  ): void => {
    if (upstream === undefined || upstream === '') return;
    routes.push({
      prefix,
      upstream,
      description,
      ...(rewritePrefix === undefined ? {} : { rewritePrefix }),
    });
  };

  add(
    '/api/v1/auth/health',
    config.IDENTITY_URL,
    'Salud de identity a través del gateway',
    '/health',
  );
  add('/api/v1/auth', config.IDENTITY_URL, 'Autenticación y sesión');
  add('/api/v1/users', config.IDENTITY_URL, 'Usuarios, roles y contraseñas');
  add('/api/v1/audit', config.IDENTITY_URL, 'Auditoría de cambios sensibles');
  add('/api/v1/devices', config.IDENTITY_URL, 'Dispositivos de pantalla (kiosko)');
  add(
    '/api/v1/identity',
    config.IDENTITY_URL,
    'Identidad del consultorio y perfiles profesionales',
  );

  add('/api/v1/patients', config.PATIENTS_URL, 'Pacientes y archivos');

  add('/api/v1/requests', config.SCHEDULING_URL, 'Solicitudes y tickets');
  add('/api/v1/agenda', config.SCHEDULING_URL, 'Cupos, franjas y programación de la jornada');
  add('/api/v1/appointments', config.SCHEDULING_URL, 'Citas y su ciclo de vida');

  add('/api/v1/notifications', config.NOTIFICATIONS_URL, 'Envíos, plantillas y bot de Telegram');
  add('/api/v1/clinical', config.CLINICAL_URL, 'Historia clínica, sesiones y récipes');
  add('/api/v1/odontogram', config.ODONTOGRAM_URL, 'Odontograma');
  add('/api/v1/screens', config.SCREENS_URL, 'Pantallas de sala y consultorio (SSE)');
  add('/api/v1/reports', config.REPORTING_URL, 'Reportes y KPIs');
  add('/api/v1/billing', config.BILLING_URL, 'Caja: borradores, facturas, cobros y tasa BCV');

  return routes;
};
