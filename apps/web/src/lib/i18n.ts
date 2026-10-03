import {
  AUDIT_ACTIONS,
  PERMISSIONS,
  ROLES,
  type Permission,
  type Role,
} from '@odontocrm/contracts';

/**
 * Diccionario es-VE de la interfaz. Todo texto visible sale de aquí: los
 * componentes llaman a `t('clave')` y nunca escriben literales sueltos, de modo
 * que un cambio de redacción se hace en un solo archivo.
 */
const DICCIONARIO = {
  'app.nombre': 'OdontoCRM',
  'app.lema': 'Gestión del consultorio odontológico',
  'app.pie': 'Sistema interno del consultorio · Acceso restringido',

  // --- Comunes -------------------------------------------------------------
  'comun.cargando': 'Cargando…',
  'comun.guardando': 'Guardando…',
  'comun.enviando': 'Enviando…',
  'comun.aceptar': 'Aceptar',
  'comun.cancelar': 'Cancelar',
  'comun.cerrar': 'Cerrar',
  'comun.guardar': 'Guardar cambios',
  'comun.crear': 'Crear',
  'comun.editar': 'Editar',
  'comun.buscar': 'Buscar',
  'comun.limpiar': 'Limpiar',
  'comun.copiar': 'Copiar',
  'comun.copiado': 'Copiado',
  'comun.reintentar': 'Reintentar',
  'comun.volver': 'Volver',
  'comun.irAInicio': 'Ir al inicio',
  'comun.recargar': 'Recargar la página',
  'comun.si': 'Sí',
  'comun.no': 'No',
  'comun.obligatorio': 'Obligatorio',
  'comun.opcional': 'Opcional',
  'comun.sinDato': '—',
  'comun.desconocido': 'Sin dato',
  'comun.cerrarSesion': 'Cerrar sesión',
  'comun.cerrando': 'Cerrando…',

  // --- Errores de la API (se usan cuando el servidor no manda `detail`) -----
  'api.error.sinConexion':
    'No se pudo contactar con el servidor. Verifica que el servicio esté encendido e inténtalo otra vez.',
  'api.error.cancelado': 'La solicitud se canceló.',
  'api.error.400': 'La solicitud tiene datos inválidos.',
  'api.error.401': 'Tu sesión no es válida. Vuelve a entrar.',
  'api.error.403': 'No tienes permiso para hacer esta operación.',
  'api.error.404': 'No se encontró lo que buscas.',
  'api.error.409': 'El registro ya existe.',
  'api.error.422': 'Revisa los datos del formulario.',
  'api.error.423': 'La cuenta está bloqueada temporalmente.',
  'api.error.429': 'Demasiados intentos seguidos. Espera un momento y vuelve a probar.',
  'api.error.500': 'Ocurrió un error en el servidor. Inténtalo de nuevo.',
  'api.error.generico': 'No se pudo completar la operación.',
  'api.titulo.error': 'Error de la API',
  'api.titulo.sinConexion': 'Sin conexión con el servidor',
  'api.titulo.cancelado': 'Solicitud cancelada',
  'api.titulo.respuestaInvalida': 'Respuesta inesperada del servidor',
  'api.error.respuestaInvalida':
    'El servidor devolvió una respuesta que no se pudo interpretar. Revisa que las rutas /api lleguen al servicio correcto.',

  // --- Sesión --------------------------------------------------------------
  'sesion.restaurando': 'Restaurando la sesión…',
  'sesion.usuario': 'Usuario',
  'sesion.rol': 'Rol',
  'sesion.roles': 'Roles',
  'sesion.iniciada': 'Sesión iniciada',
  'sesion.iniciadaA': 'Sesión iniciada a las {hora}',
  'sesion.desde': 'Desde {tiempo}',
  'sesion.duracion': 'Duración',
  'sesion.caduca': 'Caduca {tiempo}',
  'sesion.caducidad': 'Caducidad del acceso',
  'sesion.caducaA': 'Caduca a las {hora}',
  'sesion.caducada': 'Tu sesión caducó. Vuelve a entrar para continuar.',
  'sesion.ip': 'IP',
  'sesion.equipo': 'Equipo',
  'sesion.permisos': 'Permisos',
  'sesion.permisosCuenta': '{total} permisos activos',
  'sesion.activa': 'Sesión activa',
  'sesion.refrescar': 'Renovar la sesión',

  // --- Tema ----------------------------------------------------------------
  'tema.titulo': 'Tema',
  'tema.claro': 'Claro',
  'tema.oscuro': 'Oscuro',
  'tema.sistema': 'Sistema',
  'tema.descripcion': 'Se guarda en este equipo y se recuerda al volver.',

  // --- Panel inferior ------------------------------------------------------
  'panel.titulo': 'Panel de sesión',
  'panel.abrir': 'Abrir el panel de sesión',
  'panel.cerrar': 'Cerrar el panel de sesión',
  'panel.atajo': 'Ctrl + J',
  'panel.ayuda': 'Panel de sesión · {atajo}',

  // --- Menú lateral --------------------------------------------------------
  'menu.titulo': 'Módulos del sistema',
  'menu.colapsar': 'Colapsar el menú',
  'menu.expandir': 'Expandir el menú',
  'menu.seccion.principal': 'Principal',
  'menu.seccion.operacion': 'Operación',
  'menu.seccion.analisis': 'Análisis',
  'menu.seccion.admin': 'Administración',

  // --- Módulos -------------------------------------------------------------
  'modulo.inicio.titulo': 'Inicio',
  'modulo.inicio.descripcion': 'Tablero de bienvenida con el estado de tu sesión.',
  'modulo.recepcion.titulo': 'Recepción',
  'modulo.recepcion.descripcion': 'Llegada de pacientes y entrega de tickets de espera.',
  'modulo.registro.titulo': 'Registro',
  'modulo.registro.descripcion': 'Registro y actualización de pacientes con motivo auditado.',
  'modulo.programacion.titulo': 'Programación',
  'modulo.programacion.descripcion': 'Jornada, cupos, franjas y notificación de citas.',
  'modulo.secretaria.titulo': 'Secretaría',
  'modulo.secretaria.descripcion': 'Calendario del día, sala de espera y acciones del flujo.',
  'modulo.consultorio.titulo': 'Consultorio',
  'modulo.consultorio.descripcion': 'Historia clínica, sesiones, odontograma y récipes.',
  'modulo.reportes.titulo': 'Reportes',
  'modulo.reportes.descripcion': 'Indicadores operativos y clínicos del consultorio.',
  'modulo.auditoria.titulo': 'Auditoría',
  'modulo.auditoria.descripcion': 'Bitácora de accesos y de cambios sensibles.',
  'modulo.usuarios.titulo': 'Usuarios',
  'modulo.usuarios.descripcion': 'Cuentas, roles, contraseñas y bloqueos.',
  'modulo.pantallas.titulo': 'Pantallas',
  'modulo.pantallas.descripcion': 'Dispositivos y tokens de las pantallas de sala y consultorio.',

  // --- Módulos en construcción --------------------------------------------
  'placeholder.titulo': 'Módulo en construcción',
  'placeholder.texto':
    'Este módulo se construye en la Fase {fase} del plan. La navegación y los permisos ya están listos; la funcionalidad se conecta en esa fase.',
  'placeholder.fase': 'Fase {fase}',
  'placeholder.permiso': 'Permiso que lo habilita',
  'placeholder.ruta': 'Ruta',
  'placeholder.disponible': 'Disponible',

  // --- Login ---------------------------------------------------------------
  'login.titulo': 'Entrar al sistema',
  'login.subtitulo': 'Usa tu usuario del consultorio',
  'login.usuario': 'Usuario',
  'login.usuarioPlaceholder': 'tu.usuario',
  'login.contrasena': 'Contraseña',
  'login.entrar': 'Entrar',
  'login.entrando': 'Entrando…',
  'login.mostrarContrasena': 'Mostrar la contraseña',
  'login.ocultarContrasena': 'Ocultar la contraseña',
  'login.avisoBloqueo':
    'Tras {intentos} intentos fallidos la cuenta queda bloqueada {minutos} minutos.',
  'login.bloqueada': 'Cuenta bloqueada',
  'login.credenciales': 'No se pudo entrar',

  // --- Inicio --------------------------------------------------------------
  'inicio.saludo': 'Hola, {nombre}',
  'inicio.fecha': 'Hoy es {fecha}',
  'inicio.tablero': 'Tu tablero',
  'inicio.tableroTexto':
    'Este es el punto de partida: desde aquí llegas a los módulos que tu rol tiene permitidos.',
  'inicio.tuRol': 'Tu rol',
  'inicio.puedesHacer': 'Lo que puedes hacer',
  'inicio.sinPermisos': 'Tu rol todavía no tiene permisos asignados.',
  'inicio.modulos': 'Módulos disponibles',
  'inicio.sinModulos': 'Tu rol no tiene módulos adicionales en esta fase del plan.',
  'inicio.abrir': 'Abrir',
  'inicio.estado': 'Estado del sistema',
  'inicio.estado.servidor': 'Servidor',
  'inicio.estado.conectado': 'Conectado',
  'inicio.estado.sinConexion': 'Sin conexión',
  'inicio.estado.comprobando': 'Comprobando…',
  'inicio.estado.detalle':
    'La interfaz consulta la API en {ruta} bajo el mismo origen, con la cookie de refresco httpOnly.',
  'inicio.estado.revisar': 'Volver a comprobar',
  'inicio.pantallaNota':
    'Esta cuenta es para las pantallas de la sala de espera: el kiosko se habilita en la Fase 5.',
  'inicio.debeCambiar':
    'Estás usando una contraseña temporal. Cámbiala para dejar de ver este aviso.',
  'inicio.cambiarAhora': 'Cambiar la contraseña',

  // --- Cambio de contraseña ------------------------------------------------
  'contrasena.titulo': 'Cambiar la contraseña',
  'contrasena.tituloObligatorio': 'Debes cambiar tu contraseña',
  'contrasena.textoObligatorio':
    'Estás usando una contraseña temporal. Define una propia para poder usar el sistema.',
  'contrasena.texto': 'Actualiza tu contraseña cuando lo necesites.',
  'contrasena.actual': 'Contraseña actual',
  'contrasena.nueva': 'Contraseña nueva',
  'contrasena.nuevaAyuda': 'Mínimo 10 caracteres y distinta de la actual.',
  'contrasena.repetir': 'Repite la contraseña nueva',
  'contrasena.enviar': 'Cambiar la contraseña',
  'contrasena.ok': 'Contraseña actualizada. Ya puedes usar el sistema.',
  'contrasena.politica':
    'La contraseña se guarda cifrada con scrypt; nunca se almacena en texto plano.',

  // --- Usuarios ------------------------------------------------------------
  'usuarios.titulo': 'Usuarios',
  'usuarios.descripcion': 'Cuentas del consultorio, roles, contraseñas y bloqueos.',
  'usuarios.nuevo': 'Nuevo usuario',
  'usuarios.buscar': 'Buscar',
  'usuarios.buscarPlaceholder': 'Usuario o nombre completo',
  'usuarios.columna.usuario': 'Usuario',
  'usuarios.columna.nombre': 'Nombre completo',
  'usuarios.columna.roles': 'Roles',
  'usuarios.columna.estado': 'Estado',
  'usuarios.columna.ultimoAcceso': 'Último acceso',
  'usuarios.columna.creado': 'Creado',
  'usuarios.columna.acciones': 'Acciones',
  'usuarios.estado.activo': 'Activo',
  'usuarios.estado.inactivo': 'Inactivo',
  'usuarios.estado.bloqueado': 'Bloqueado',
  'usuarios.estado.debeCambiar': 'Contraseña temporal',
  'usuarios.intentos': '{intentos} intentos fallidos',
  'usuarios.sinResultados': 'Sin resultados',
  'usuarios.vacio': 'No hay usuarios que coincidan con la búsqueda.',
  'usuarios.paginacion': 'Página {pagina} de {paginas} · {total} usuarios',
  'usuarios.anterior': 'Anterior',
  'usuarios.siguiente': 'Siguiente',
  'usuarios.porPagina': 'Por página',
  'usuarios.indicador': 'Mostrando {desde}–{hasta} de {total}',
  'usuarios.nunca': 'Nunca',
  'usuarios.creado': 'Usuario creado.',
  'usuarios.actualizado': 'Usuario actualizado.',
  'usuarios.activado': 'Usuario activado.',
  'usuarios.desactivado': 'Usuario desactivado.',
  'usuarios.cargando': 'Cargando usuarios…',
  'usuarios.error': 'No se pudieron cargar los usuarios.',
  'usuarios.acciones': 'Acciones para {usuario}',
  'usuarios.acciones.editar': 'Editar',
  'usuarios.acciones.restablecer': 'Restablecer contraseña',
  'usuarios.acciones.activar': 'Activar',
  'usuarios.acciones.desactivar': 'Desactivar',
  'usuarios.acciones.tuCuenta': 'No puedes desactivar tu propia cuenta.',
  'usuarios.acciones.activarTitulo': 'Activar a {usuario}',
  'usuarios.acciones.desactivarTitulo': 'Desactivar a {usuario}',
  'usuarios.acciones.activarTexto': 'El usuario podrá volver a entrar con su contraseña actual.',
  'usuarios.acciones.desactivarTexto':
    'El usuario no podrá entrar al sistema. Su historial y su auditoría se conservan.',

  // Formulario de usuario
  'usuarios.form.crearTitulo': 'Nuevo usuario',
  'usuarios.form.editarTitulo': 'Editar {usuario}',
  'usuarios.form.descripcion':
    'Los cambios de usuarios y contraseñas quedan registrados en la auditoría.',
  'usuarios.form.usuario': 'Usuario',
  'usuarios.form.usuarioAyuda':
    'Entre 3 y 32 caracteres: minúsculas, números, punto, guion o guion bajo.',
  'usuarios.form.nombre': 'Nombre completo',
  'usuarios.form.correo': 'Correo electrónico',
  'usuarios.form.correoAyuda': 'Opcional; se usa solo para contacto interno.',
  'usuarios.form.contrasena': 'Contraseña inicial',
  'usuarios.form.contrasenaAyuda': 'Mínimo 10 caracteres. El usuario podrá cambiarla.',
  'usuarios.form.roles': 'Roles',
  'usuarios.form.rolesAyuda': 'Los permisos se suman; abajo ves el resultado.',
  'usuarios.form.permisos': 'Permisos que otorgan los roles elegidos',
  'usuarios.form.sinPermisos': 'Elige al menos un rol para ver sus permisos.',
  'usuarios.form.mustChange': 'Pedir cambio de contraseña al entrar',
  'usuarios.form.mustChangeAyuda':
    'Recomendado: así el usuario define su propia contraseña y nadie más la conoce.',
  'usuarios.form.activo': 'Usuario activo',
  'usuarios.form.activoAyuda': 'Un usuario inactivo no puede entrar al sistema.',
  'usuarios.form.motivo': 'Motivo del cambio',
  'usuarios.form.motivoAyuda': 'Obligatorio: queda registrado en la auditoría.',
  'usuarios.form.motivoPlaceholder': 'p. ej. Rotación del personal de secretaría',
  'usuarios.form.motivoLargo': 'El motivo es demasiado largo',
  'usuarios.form.estado': 'Estado',
  'usuarios.form.crear': 'Crear usuario',

  // Restablecer contraseña
  'usuarios.reset.titulo': 'Restablecer la contraseña de {usuario}',
  'usuarios.reset.texto':
    'Si dejas la contraseña vacía, el servidor genera una temporal y se muestra una sola vez.',
  'usuarios.reset.nueva': 'Contraseña nueva',
  'usuarios.reset.nuevaAyuda': 'Opcional. Si la escribes, debe tener al menos 10 caracteres.',
  'usuarios.reset.motivoCorto': 'Indica el motivo del restablecimiento',
  'usuarios.reset.ok':
    'Contraseña restablecida. El usuario deberá cambiarla la próxima vez que entre.',
  'usuarios.reset.enviar': 'Restablecer',
  'usuarios.reset.temporalTitulo': 'Contraseña temporal',
  'usuarios.reset.temporalAviso':
    'Cópiala ahora y entrégala en mano: no se volverá a mostrar. El usuario deberá cambiarla al entrar.',
  'usuarios.reset.copiada': 'Contraseña copiada al portapapeles.',
  'usuarios.reset.sinTemporal':
    'La contraseña se restableció, pero el servidor no devolvió ninguna temporal.',

  // --- 403 / 404 -----------------------------------------------------------
  'prohibido.titulo': 'Sin permiso',
  'prohibido.texto':
    'Tu rol no tiene el permiso «{permiso}», necesario para abrir este módulo. Si lo necesitas, pídeselo al administrador.',
  'prohibido.sinPermiso': 'No tienes permiso para ver esta página.',
  'noEncontrado.titulo': 'Página no encontrada',
  'noEncontrado.texto': 'La dirección {ruta} no existe en el sistema.',

  // --- Error de la interfaz ------------------------------------------------
  'error.titulo': 'Algo se rompió en la interfaz',
  'error.texto':
    'Ocurrió un error inesperado al dibujar la pantalla. Puedes volver al inicio o recargar la página.',
  'error.detalle': 'Detalle técnico',

  // --- Tiempo --------------------------------------------------------------
  'tiempo.ahora': 'hace unos segundos',
  'tiempo.enAhora': 'en unos segundos',
  'tiempo.haceMin': 'hace {n} min',
  'tiempo.enMin': 'en {n} min',
  'tiempo.haceHoras': 'hace {n} h',
  'tiempo.enHoras': 'en {n} h',
  'tiempo.haceUnDia': 'hace 1 día',
  'tiempo.haceDias': 'hace {n} días',
  'tiempo.enUnDia': 'en 1 día',
  'tiempo.enDias': 'en {n} días',
  'tiempo.menosDeUnMinuto': 'menos de un minuto',
  'tiempo.duracionMinutos': '{minutos} min',
  'tiempo.duracionHoras': '{horas} h',
  'tiempo.duracionHorasMinutos': '{horas} h {minutos} min',

  // --- Roles ---------------------------------------------------------------
  'rol.admin': 'Administrador',
  'rol.secretario': 'Secretaría',
  'rol.odontologo': 'Odontólogo',
  'rol.pantalla': 'Pantalla de sala',
  'rol.descripcion.admin': 'Acceso total: usuarios, configuración y todos los módulos.',
  'rol.descripcion.secretario':
    'Recepción y registro de pacientes, agenda, notificaciones y pantallas.',
  'rol.descripcion.odontologo':
    'Consulta clínica: historia, sesiones, odontograma y reportes clínicos.',
  'rol.descripcion.pantalla':
    'Solo lectura para las pantallas de la sala de espera y del consultorio.',

  // --- Permisos (§5.4 del plan) -------------------------------------------
  'permiso.users:manage': 'Gestionar usuarios y contraseñas',
  'permiso.patients:read': 'Consultar pacientes',
  'permiso.patients:write': 'Registrar y editar pacientes',
  'permiso.patients:edit_sensitive': 'Editar datos sensibles del paciente',
  'permiso.scheduling:read': 'Consultar la agenda',
  'permiso.scheduling:write': 'Programar la jornada y asignar cupos',
  'permiso.scheduling:notify': 'Enviar notificaciones de citas',
  'permiso.screens:manage': 'Administrar pantallas y dispositivos',
  'permiso.screens:display': 'Ver las pantallas de sala y consultorio',
  'permiso.clinical:read': 'Consultar la historia clínica',
  'permiso.clinical:write': 'Escribir historia clínica y récipes',
  'permiso.odontogram:read': 'Consultar el odontograma',
  'permiso.odontogram:write': 'Actualizar el odontograma',
  'permiso.reports:read': 'Ver reportes',
  'permiso.audit:read': 'Consultar la auditoría',

  // --- Acciones de auditoría ----------------------------------------------
  'auditoria.login': 'Inicio de sesión',
  'auditoria.login_failed': 'Intento de acceso fallido',
  'auditoria.login_blocked': 'Cuenta bloqueada por intentos fallidos',
  'auditoria.logout': 'Cierre de sesión',
  'auditoria.refresh': 'Renovación de la sesión',
  'auditoria.refresh_reuse_detected': 'Reuso de token de refresco detectado',
  'auditoria.session_revoked': 'Sesión revocada',
  'auditoria.user_created': 'Usuario creado',
  'auditoria.user_updated': 'Usuario actualizado',
  'auditoria.user_activated': 'Usuario activado',
  'auditoria.user_deactivated': 'Usuario desactivado',
  'auditoria.password_changed': 'Contraseña cambiada',
  'auditoria.password_reset': 'Contraseña restablecida',
  'auditoria.device_token_created': 'Token de pantalla creado',
  'auditoria.device_token_revoked': 'Token de pantalla revocado',
} as const;

export type TranslationKey = keyof typeof DICCIONARIO;

/**
 * Traduce una clave del diccionario. Los parámetros se interpolan con la forma
 * `{nombre}`; si falta un valor se deja el marcador para que el error se vea.
 */
export const t = (key: TranslationKey, params?: Record<string, string | number>): string => {
  const plantilla: string = DICCIONARIO[key];
  if (!params) return plantilla;

  return plantilla.replace(/\{(\w+)\}/g, (coincidencia, nombre: string) => {
    const valor = params[nombre];
    return valor === undefined ? coincidencia : String(valor);
  });
};

export const ROLE_LABELS: Readonly<Record<Role, string>> = {
  admin: t('rol.admin'),
  secretario: t('rol.secretario'),
  odontologo: t('rol.odontologo'),
  pantalla: t('rol.pantalla'),
};

export const ROLE_DESCRIPTIONS: Readonly<Record<Role, string>> = {
  admin: t('rol.descripcion.admin'),
  secretario: t('rol.descripcion.secretario'),
  odontologo: t('rol.descripcion.odontologo'),
  pantalla: t('rol.descripcion.pantalla'),
};

export const PERMISSION_LABELS: Readonly<Record<Permission, string>> = {
  'users:manage': t('permiso.users:manage'),
  'patients:read': t('permiso.patients:read'),
  'patients:write': t('permiso.patients:write'),
  'patients:edit_sensitive': t('permiso.patients:edit_sensitive'),
  'scheduling:read': t('permiso.scheduling:read'),
  'scheduling:write': t('permiso.scheduling:write'),
  'scheduling:notify': t('permiso.scheduling:notify'),
  'screens:manage': t('permiso.screens:manage'),
  'screens:display': t('permiso.screens:display'),
  'clinical:read': t('permiso.clinical:read'),
  'clinical:write': t('permiso.clinical:write'),
  'odontogram:read': t('permiso.odontogram:read'),
  'odontogram:write': t('permiso.odontogram:write'),
  'reports:read': t('permiso.reports:read'),
  'audit:read': t('permiso.audit:read'),
};

const AUDIT_ACTION_LABELS: Readonly<Record<string, string>> = {
  login: t('auditoria.login'),
  login_failed: t('auditoria.login_failed'),
  login_blocked: t('auditoria.login_blocked'),
  logout: t('auditoria.logout'),
  refresh: t('auditoria.refresh'),
  refresh_reuse_detected: t('auditoria.refresh_reuse_detected'),
  session_revoked: t('auditoria.session_revoked'),
  user_created: t('auditoria.user_created'),
  user_updated: t('auditoria.user_updated'),
  user_activated: t('auditoria.user_activated'),
  user_deactivated: t('auditoria.user_deactivated'),
  password_changed: t('auditoria.password_changed'),
  password_reset: t('auditoria.password_reset'),
  device_token_created: t('auditoria.device_token_created'),
  device_token_revoked: t('auditoria.device_token_revoked'),
};

/** Etiqueta de una acción de auditoría; si el servidor añade una nueva, se muestra tal cual. */
export const auditActionLabel = (action: string): string => AUDIT_ACTION_LABELS[action] ?? action;

/** Comprueba en tiempo de ejecución que un texto del servidor es un rol conocido. */
export const isRole = (value: string): value is Role =>
  (ROLES as readonly string[]).includes(value);

/** Comprueba en tiempo de ejecución que un texto del servidor es un permiso conocido. */
export const isPermission = (value: string): value is Permission =>
  (PERMISSIONS as readonly string[]).includes(value);

/** Acciones de auditoría declaradas en los contratos (para filtros de la Fase 9). */
export const AUDIT_ACTION_CODES = AUDIT_ACTIONS;
