import {
  APPOINTMENT_STATUSES,
  AUDIT_ACTIONS,
  BOT_STEP_LABELS,
  CHANNELS,
  PERMISSIONS,
  ROLES,
  type AppointmentStatus,
  type BotConversationState,
  type CapacitySource,
  type Channel,
  type DocType,
  type NotificationStatus,
  type PatientFileKind,
  type PatientStatus,
  type Permission,
  type Role,
  type Sex,
  type SlotKind,
  type SlotState,
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
  'comun.quitar': 'Quitar',
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
  /** Nombre del canal por el que habla un paciente (bandeja y conversaciones). */
  'comun.canal.telegram': 'Telegram',
  'comun.canal.whatsapp': 'WhatsApp',
  'comun.canal.registro': 'Registro',
  'comun.canal.telefono': 'Teléfono',
  'comun.canal.presencial': 'Presencial',
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
  'modulo.flujo.titulo': 'Flujo del día',
  'modulo.flujo.descripcion':
    'La jornada completa en una pantalla: cola del día, paciente en curso y acciones del flujo.',
  'modulo.reportes.titulo': 'Reportes',
  'modulo.reportes.descripcion': 'Indicadores operativos y clínicos del consultorio.',
  'modulo.auditoria.titulo': 'Auditoría',
  'modulo.auditoria.descripcion': 'Bitácora de accesos y de cambios sensibles.',
  'modulo.usuarios.titulo': 'Usuarios',
  'modulo.usuarios.descripcion': 'Cuentas, roles, contraseñas y bloqueos.',
  'modulo.pacientes.titulo': 'Pacientes',
  'modulo.pacientes.descripcion': 'Listado, filtros y ficha completa de cada paciente.',
  'modulo.notificaciones.titulo': 'Notificaciones',
  'modulo.notificaciones.descripcion':
    'Bandeja de envíos del bot, plantillas de mensajes y vinculación de pacientes.',
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
  'inicio.sinModulos': 'Tu rol no tiene módulos adicionales por ahora.',
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
    'Esta cuenta es para las pantallas de la clínica: abre el enlace del kiosko que el administrador genera en el módulo Pantallas (/pantalla/lobby o /pantalla/consultorio) en el equipo del televisor. Aquí no hay módulos que mostrar.',
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

  // --- Pacientes (Fase 2) --------------------------------------------------
  'pacientes.doc.tipo': 'Tipo',
  'pacientes.doc.numero': 'Número de documento',
  'pacientes.doc.numeroPlaceholder': '12.345.678',
  'pacientes.doc.placeholder': 'V-12.345.678, pasaporte o código del menor',
  'pacientes.doc.ayuda':
    'Puedes escribir o pegar el documento en cualquier forma: V-12345678, v 12.345.678 o 12345678.',
  'pacientes.doc.tipoV': 'V · Venezolano',
  'pacientes.doc.tipoE': 'E · Extranjero',
  'pacientes.doc.tipoP': 'P · Pasaporte',
  'pacientes.doc.tipoSC': 'SC · Menor sin cédula',
  'pacientes.doc.invalido': 'Revisa el documento',
  'pacientes.doc.avisoSC':
    'Menor sin cédula: se guarda con un código temporal SC. Cuando obtenga su cédula se promueve el mismo registro y la historia clínica se conserva.',

  'pacientes.estado.en_espera_cita': 'En espera de cita',
  'pacientes.estado.activo': 'Activo',
  'pacientes.estado.inactivo': 'Inactivo',
  'pacientes.sexo.M': 'Masculino',
  'pacientes.sexo.F': 'Femenino',
  'pacientes.sexo.O': 'Otro',
  'pacientes.sensible': 'Dato sensible',
  'pacientes.ficticio': 'Dato de prueba',
  'pacientes.ficticioTexto':
    'Este paciente es un dato ficticio del modo test: no corresponde a una persona real.',
  'pacientes.menor': 'Menor de edad',

  'pacientes.campo.fullName': 'Nombre completo',
  'pacientes.campo.docNumber': 'Documento',
  'pacientes.campo.birthDate': 'Fecha de nacimiento',
  'pacientes.campo.phone': 'Teléfono',
  'pacientes.campo.phoneAlt': 'Teléfono alternativo',
  'pacientes.campo.email': 'Correo electrónico',
  'pacientes.campo.address': 'Dirección',
  'pacientes.campo.occupation': 'Ocupación',
  'pacientes.campo.notes': 'Notas',
  'pacientes.campo.sex': 'Sexo',
  'pacientes.campo.status': 'Estado',
  'pacientes.campo.docType': 'Tipo de documento',
  'pacientes.campo.guardian': 'Representante',

  // Formulario de paciente
  'pacientes.form.seccion': 'Datos del paciente',
  'pacientes.form.seccionContacto': 'Contacto',
  'pacientes.form.seccionNotas': 'Notas',
  'pacientes.form.edad': '{edad} años',
  'pacientes.form.edadCalculada': 'Edad calculada: {edad} años',
  'pacientes.form.edadAviso': 'Revisa la fecha de nacimiento: la edad calculada es {edad} años.',
  'pacientes.form.telefonoAyuda': 'Por ejemplo 0412-1234567.',
  'pacientes.form.correoAyuda': 'Opcional; se usa para avisos de cita.',
  'pacientes.form.notasAyuda': 'Motivo de consulta, alergias referidas u otra observación breve.',
  'pacientes.form.guardianTitulo': 'Representante del menor',
  'pacientes.form.guardianMotivo':
    'El paciente es menor de edad ({edad} años): la historia clínica necesita un adulto responsable. Los cuatro datos del representante son obligatorios.',
  'pacientes.form.guardianNombre': 'Nombre y apellido',
  'pacientes.form.guardianDocumento': 'Documento del representante',
  'pacientes.form.guardianParentesco': 'Parentesco',
  'pacientes.form.guardianParentescoPlaceholder': 'Madre, padre, abuela…',
  'pacientes.form.guardianTelefono': 'Teléfono del representante',
  'pacientes.form.guardianOpcional': 'Opcional',

  // Registro (autocompletado por cédula)
  'registro.titulo': 'Registro de pacientes',
  'registro.descripcion':
    'Escribe la cédula y el sistema busca el paciente: si ya existe se abre su ficha en solo lectura.',
  'registro.buscar': 'Buscar',
  'registro.buscando': 'Buscando…',
  'registro.noEncontrado': 'No hay registro con ese documento',
  'registro.noEncontradoTexto':
    'No existe ningún paciente con {documento}. Puedes registrarlo ahora: el documento queda cargado en el formulario.',
  'registro.registrar': 'Registrar paciente',
  'registro.otroDocumento': 'Buscar otro documento',
  'registro.creado': 'Paciente registrado con el documento {documento}.',
  'registro.duplicado': 'Ya existe un paciente con ese documento',
  'registro.duplicadoTexto':
    'El documento {documento} ya está registrado. Abre esa ficha en lugar de crear un duplicado.',
  'registro.abrirExistente': 'Abrir el paciente existente',
  'registro.errorBusqueda': 'No se pudo completar la búsqueda.',
  'registro.volverBusqueda': 'Volver a la búsqueda por documento',
  'registro.acciones': 'Acciones',

  // Alta
  'pacientes.alta.titulo': 'Nuevo paciente',
  'pacientes.alta.descripcion':
    'Los campos marcados con * son obligatorios. Los textos se guardan limpios y el documento no se puede repetir.',
  'pacientes.alta.enviar': 'Registrar paciente',
  'pacientes.alta.revisar': 'Revisa los campos marcados antes de continuar.',

  // Ficha en solo lectura
  'pacientes.lectura.rotulo': 'Modo lectura',
  'pacientes.lectura.texto':
    'Estás viendo la ficha sin permiso para modificarla. Para cambiarla pulsa «Editar» y escribe el motivo.',
  'pacientes.lectura.sinPermiso':
    'Tu rol solo puede consultar: la edición de datos sensibles la hace secretaría o administración.',

  // Edición con motivo y confirmación
  'pacientes.editar.titulo': 'Editar la ficha',
  'pacientes.editar.boton': 'Editar',
  'pacientes.editar.habilitado': 'Editando',
  'pacientes.editar.motivoTitulo': 'Motivo del cambio',
  'pacientes.editar.motivoTexto':
    'Todo cambio de paciente queda en la auditoría con su justificación. Escribe el motivo (mínimo 3 caracteres) para habilitar los campos.',
  'pacientes.editar.motivo': 'Motivo',
  'pacientes.editar.motivoPlaceholder': 'p. ej. Corrige el teléfono que dio el paciente',
  'pacientes.editar.habilitar': 'Habilitar los campos',
  'pacientes.editar.salir': 'Salir de la edición',
  'pacientes.editar.revisar': 'Revisar y guardar',
  'pacientes.editar.sinCambios': 'No cambiaste ningún dato: no hay nada que guardar.',
  'pacientes.editar.ok': 'Paciente actualizado. El cambio quedó en la auditoría.',
  'pacientes.editar.error': 'No se pudo guardar el cambio.',
  'pacientes.editar.sinPermiso': 'No tienes permiso para editar datos sensibles del paciente.',

  // Confirmación de los cambios
  'pacientes.confirmar.titulo': 'Confirmar los cambios',
  'pacientes.confirmar.texto':
    'Revisa qué cambia antes de guardar. Los cambios de datos sensibles quedan en la auditoría con tu motivo.',
  'pacientes.confirmar.columna': 'Campo',
  'pacientes.confirmar.antes': 'Valor anterior',
  'pacientes.confirmar.despues': 'Valor nuevo',
  'pacientes.confirmar.sensibles':
    'Los campos marcados como sensibles quedan en la auditoría con tu motivo.',
  'pacientes.confirmar.motivo': 'Motivo',
  'pacientes.confirmar.total': '{total} cambio(s)',
  'pacientes.confirmar.enviar': 'Confirmar y guardar',

  // Cambio de estado
  'pacientes.estado.titulo': 'Cambiar el estado de {paciente}',
  'pacientes.estado.boton': 'Cambiar estado',
  'pacientes.estado.nuevo': 'Estado nuevo',
  'pacientes.estado.motivo': 'Motivo del cambio',
  'pacientes.estado.texto':
    'El estado se cambia con motivo y queda registrado en la auditoría del paciente.',
  'pacientes.estado.ok': 'Estado actualizado.',
  'pacientes.estado.activoTexto':
    'El paciente vuelve a la lista de activos: podrá agendarse y atenderse con normalidad.',
  'pacientes.estado.inactivoTexto':
    'El paciente queda inactivo: no se agendarán citas nuevas, pero su historia y sus adjuntos se conservan.',
  'pacientes.estado.esperaTexto':
    'El paciente queda «en espera de cita»: está registrado y pendiente de programar.',

  // Borrado lógico (solo admin)
  'pacientes.borrar.boton': 'Eliminar del registro',
  'pacientes.borrar.titulo': 'Eliminar a {paciente} del registro',
  'pacientes.borrar.texto':
    'Se usa cuando alguien quedó registrado por error. El paciente desaparece de las listas y de las búsquedas, y su documento vuelve a quedar libre.',
  'pacientes.borrar.aviso':
    'No se destruye nada: la ficha, sus adjuntos y el historial de cambios se conservan marcados, y el borrado queda en la auditoría con tu motivo y tu usuario.',
  'pacientes.borrar.motivo': 'Motivo del borrado',
  'pacientes.borrar.motivoPlaceholder': 'Por ejemplo: registro duplicado por error de tecleo',
  'pacientes.borrar.enviar': 'Eliminar del registro',
  'pacientes.borrar.ok': 'Paciente eliminado del registro.',

  // Adjuntos
  'pacientes.adjuntos.titulo': 'Adjuntos',
  'pacientes.adjuntos.texto':
    'Radiografías, fotos y PDF autorizados. Se guardan en el almacén del consultorio y solo se ven desde la ficha.',
  'pacientes.adjuntos.vacio': 'Este paciente todavía no tiene adjuntos.',
  'pacientes.adjuntos.subir': 'Subir adjunto',
  'pacientes.adjuntos.subiendo': 'Subiendo…',
  'pacientes.adjuntos.archivo': 'Archivo',
  'pacientes.adjuntos.archivoAyuda': 'JPEG, PNG, WebP o PDF. Tamaño máximo {max} por archivo.',
  'pacientes.adjuntos.sinArchivo': 'Elige un archivo.',
  'pacientes.adjuntos.mimeNoPermitido': 'Solo se aceptan imágenes JPEG, PNG, WebP o PDF.',
  'pacientes.adjuntos.demasiadoGrande': 'El archivo supera el máximo de {max}.',
  'pacientes.adjuntos.tipo': 'Tipo de documento',
  'pacientes.adjuntos.leyenda': 'Leyenda',
  'pacientes.adjuntos.leyendaPlaceholder': 'p. ej. Radiografía periapical del 36',
  'pacientes.adjuntos.ok': 'Adjunto subido.',
  'pacientes.adjuntos.error': 'No se pudo subir el adjunto.',
  'pacientes.adjuntos.columna.archivo': 'Archivo',
  'pacientes.adjuntos.columna.tipo': 'Tipo',
  'pacientes.adjuntos.columna.tamano': 'Tamaño',
  'pacientes.adjuntos.columna.fecha': 'Subido',
  'pacientes.adjuntos.columna.acciones': 'Acciones',
  'pacientes.adjuntos.descargar': 'Descargar',
  'pacientes.adjuntos.descargaError': 'No se pudo descargar el adjunto.',
  'pacientes.adjuntos.borrar': 'Borrar',
  'pacientes.adjuntos.borrarTitulo': 'Borrar «{archivo}»',
  'pacientes.adjuntos.borrarTexto':
    'El archivo se elimina del almacén y no se puede recuperar. La operación queda registrada.',
  'pacientes.adjuntos.borrado': 'Adjunto borrado.',
  'pacientes.adjuntos.borradoError': 'No se pudo borrar el adjunto.',
  'pacientes.adjuntos.cargando': 'Cargando adjuntos…',
  'pacientes.adjuntos.errorLista': 'No se pudieron cargar los adjuntos.',
  'pacientes.adjuntos.total': '{total} archivo(s)',
  'pacientes.adjuntos.tipo.radiografia': 'Radiografía',
  'pacientes.adjuntos.tipo.foto': 'Foto',
  'pacientes.adjuntos.tipo.pdf': 'PDF',
  'pacientes.adjuntos.tipo.consentimiento': 'Consentimiento',
  'pacientes.adjuntos.tipo.laboratorio': 'Laboratorio',
  'pacientes.adjuntos.tipo.otro': 'Otro',

  // Historial clínico y otros módulos que llegan después
  'pacientes.historia.proximamente':
    'La historia clínica, las sesiones y los récipes llegan en las fases 6 y 7. Aquí ya quedan los datos del paciente y sus adjuntos.',

  // Lista y filtros
  'pacientes.lista.titulo': 'Pacientes',
  'pacientes.lista.descripcion':
    'Búsqueda por nombre, documento o teléfono, con filtros por estado, tipo de documento, sexo y edad.',
  'pacientes.lista.nuevo': 'Nuevo paciente',
  'pacientes.lista.buscar': 'Buscar',
  'pacientes.lista.buscarPlaceholder': 'Nombre, documento o teléfono',
  'pacientes.lista.limpiar': 'Limpiar filtros',
  'pacientes.lista.columna.documento': 'Documento',
  'pacientes.lista.columna.nombre': 'Paciente',
  'pacientes.lista.columna.sexo': 'Sexo',
  'pacientes.lista.columna.telefono': 'Teléfono',
  'pacientes.lista.columna.estado': 'Estado',
  'pacientes.lista.columna.acciones': 'Acciones',
  'pacientes.lista.ver': 'Ver la ficha',
  'pacientes.lista.vacio': 'No hay pacientes que coincidan con la búsqueda o los filtros.',
  'pacientes.lista.vacioTitulo': 'Sin resultados',
  'pacientes.lista.cargando': 'Cargando pacientes…',
  'pacientes.lista.error': 'No se pudieron cargar los pacientes.',
  'pacientes.lista.indicador': 'Mostrando {desde}–{hasta} de {total}',
  'pacientes.lista.paginacion': 'Página {pagina} de {paginas} · {total} pacientes',
  'pacientes.lista.anterior': 'Anterior',
  'pacientes.lista.siguiente': 'Siguiente',
  'pacientes.lista.porPagina': 'Por página',

  // Filtros
  'pacientes.filtro.estado': 'Estado',
  'pacientes.filtro.docType': 'Tipo de documento',
  'pacientes.filtro.sexo': 'Sexo',
  'pacientes.filtro.todos': 'Todos',
  'pacientes.filtro.edadMin': 'Edad mínima',
  'pacientes.filtro.edadMax': 'Edad máxima',
  'pacientes.filtro.edad': 'Edad',
  'pacientes.filtro.rangoInvalido': 'La edad mínima no puede superar la máxima',

  // Ficha
  'pacientes.ficha.titulo': 'Ficha del paciente',
  'pacientes.ficha.cargando': 'Cargando la ficha…',
  'pacientes.ficha.error': 'No se pudo cargar la ficha del paciente.',
  'pacientes.ficha.noEncontrado': 'No existe un paciente con ese identificador.',
  'pacientes.ficha.datos': 'Datos del paciente',
  'pacientes.ficha.contacto': 'Contacto',
  'pacientes.ficha.representante': 'Representante',
  'pacientes.ficha.sinRepresentante': 'Sin representante registrado.',
  'pacientes.ficha.actualizado': 'Última actualización',
  'pacientes.ficha.creado': 'Registrado {fecha}',
  'pacientes.ficha.verEnRegistro': 'Ver en el registro',
  'pacientes.ficha.volverLista': 'Volver al listado',
  'pacientes.ficha.verHistoria': 'Historia clínica',
  'pacientes.ficha.adjuntos': '{total} adjunto(s)',

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
    'Recepción y registro de pacientes, agenda, notificaciones, pantallas y lectura de la historia clínica para imprimir.',
  'rol.descripcion.odontologo':
    'Consulta clínica: historia, sesiones, odontograma y reportes clínicos.',
  'rol.descripcion.pantalla':
    'Solo lectura para las pantallas de la sala de espera y del consultorio.',

  // --- Permisos (§5.4 del plan) -------------------------------------------
  'permiso.users:manage': 'Gestionar usuarios y contraseñas',
  'permiso.patients:read': 'Consultar pacientes',
  'permiso.patients:write': 'Registrar y editar pacientes',
  'permiso.patients:edit_sensitive': 'Editar datos sensibles del paciente',
  'permiso.patients:delete': 'Eliminar un paciente del registro',
  'permiso.scheduling:read': 'Consultar la agenda',
  'permiso.scheduling:write': 'Programar la jornada y asignar cupos',
  'permiso.scheduling:notify': 'Enviar notificaciones de citas',
  'permiso.scheduling:overbook': 'Autorizar sobrecupo en un día completo',
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
  'auditoria.medical_record_created': 'Historia clínica abierta',
  'auditoria.medical_record_updated': 'Historia clínica actualizada',
  'auditoria.medical_record_signed': 'Historia clínica firmada',
  'auditoria.medical_record_amended': 'Adenda a la historia clínica',
  'auditoria.medical_record_printed': 'Historia clínica impresa',
  'auditoria.medical_record_consent_accepted': 'Consentimiento informado registrado',

  // --- Programación de la jornada (Fase 3) --------------------------------
  'programacion.titulo': 'Programación de la jornada',
  'programacion.descripcion':
    'Cola de solicitudes con ticket, cupo del día, franjas, citas y aviso al paciente.',

  // Estados de la cita (máquina de estados, plan §5.1)
  'programacion.estado.en_espera_cita': 'En espera de cita',
  'programacion.estado.programada': 'Programada',
  'programacion.estado.notificada': 'Notificada',
  'programacion.estado.en_sala_espera': 'En sala de espera',
  'programacion.estado.llamado': 'Llamado',
  'programacion.estado.en_consulta': 'En consulta',
  'programacion.estado.atendido': 'Atendido',
  'programacion.estado.no_asistio': 'No asistió',
  'programacion.estado.cancelada': 'Cancelada',
  'programacion.estado.reprogramada': 'Reprogramada',

  // Canales de la solicitud
  'programacion.canal.telegram': 'Telegram',
  'programacion.canal.whatsapp': 'WhatsApp',
  'programacion.canal.registro': 'Registro',
  'programacion.canal.telefono': 'Teléfono',
  'programacion.canal.presencial': 'Presencial',

  // Jornada: fecha y carga
  'programacion.fecha.anterior': 'Día anterior',
  'programacion.fecha.siguiente': 'Día siguiente',
  'programacion.fecha.hoy': 'Hoy',
  'programacion.fecha.campo': 'Fecha de la jornada',
  'programacion.fecha.recargar': 'Recargar la jornada',
  'programacion.fecha.cargando': 'Cargando la jornada…',
  'programacion.fecha.error': 'No se pudo cargar la jornada.',
  'programacion.fecha.noLaborable': 'Día no laborable',
  'programacion.fecha.noLaborableTexto':
    'No hay plantillas de franjas para {dia}: la jornada se puede programar igual con hora manual.',
  'programacion.fecha.enEspera': '{total} en espera',

  // Cupo del día
  'programacion.cupo.titulo': 'Cupo del día',
  'programacion.cupo.contador': '{asignados}/{cupo}',
  'programacion.cupo.contadorEtiqueta': 'Citas asignadas sobre el cupo del día',
  'programacion.cupo.procedencia': 'Procedencia: {fuente}',
  'programacion.cupo.fuente.explicito': 'cupo explícito',
  'programacion.cupo.fuente.plantilla': 'calculado de las plantillas de franjas',
  'programacion.cupo.fuente.defecto': 'cupo por defecto del consultorio',
  'programacion.cupo.disponibles': '{disponibles} cupo(s) disponible(s)',
  'programacion.cupo.completo': 'El día está completo',
  'programacion.cupo.completoTexto':
    'Se asignaron las {cupo} citas del cupo. Solo un administrador puede autorizar una cita por encima del cupo (sobrecupo) y queda en la auditoría.',
  'programacion.cupo.editar': 'Editar el cupo',
  'programacion.cupo.dialogoTitulo': 'Cupo del {fecha}',
  'programacion.cupo.dialogoTexto':
    'El cupo se puede cambiar en cualquier momento, incluso después de asignar. Bajarlo por debajo de lo asignado avisa pero no borra ninguna cita.',
  'programacion.cupo.numero': 'Cupo de citas del día',
  'programacion.cupo.numeroAyuda': 'Entre 0 y {max} citas.',
  'programacion.cupo.notas': 'Notas del cupo',
  'programacion.cupo.motivo': 'Motivo del cambio',
  'programacion.cupo.ok': 'Cupo actualizado.',
  'programacion.cupo.aviso': 'Aviso del cupo',
  'programacion.cupo.avisoPrevio':
    'Con {cupo} de cupo quedarían {asignados} citas asignadas: el servidor avisará y no borrará ninguna.',
  'programacion.cupo.explicito': 'Cupo explícito: {cupo}',
  'programacion.cupo.sinExplicito':
    'Sin cupo explícito: se deduce de las plantillas o del valor por defecto.',
  'programacion.ocupacion': 'Ocupación del día',
  'programacion.ocupacion.barra': 'Ocupación del día: {asignados} de {cupo} citas asignadas.',
  'programacion.contador.programadas': 'Programadas',
  'programacion.contador.notificadas': 'Notificadas',
  'programacion.contador.enSala': 'En sala',
  'programacion.contador.atendidas': 'Atendidas',
  'programacion.contador.noAsistio': 'No asistió',
  'programacion.contador.canceladas': 'Canceladas',

  // Franjas del día
  'programacion.franja.titulo': 'Franjas del día',
  'programacion.franja.ayuda':
    'Arrastra una solicitud de la cola hasta una franja libre, o selecciónala en la cola y pulsa la franja (también con Enter).',
  'programacion.franja.libre': 'Libre',
  'programacion.franja.ocupada': 'Ocupada',
  'programacion.franja.fuera_de_jornada': 'Fuera de jornada',
  'programacion.franja.tipo.franja': 'Franja',
  'programacion.franja.tipo.manual': 'Hora manual',
  'programacion.franja.vacio': 'Este día no tiene franjas definidas.',
  'programacion.franja.ocupadaPor': 'Ocupada por {paciente}',
  'programacion.franja.etiqueta': '{inicio} a {fin} · {estado}',
  'programacion.franja.asignarA': 'Asignar {paciente} a las {hora}',
  'programacion.franja.asignar': 'Asignar una solicitud a las {hora}',
  'programacion.franja.seleccionada': 'Solicitud seleccionada: {ticket} · {paciente}',
  'programacion.franja.sinSeleccion':
    'No hay ninguna solicitud seleccionada: elige una en la cola para asignarla con el teclado.',
  'programacion.franja.sinPermiso':
    'Tu rol no puede asignar citas: necesitas el permiso de programación (scheduling:write).',
  'programacion.franja.verCita': 'Ver la cita de {paciente}',
  'programacion.franja.total': '{total} franja(s)',

  // Cola de solicitudes
  'programacion.cola.titulo': 'Solicitudes',
  'programacion.cola.descripcion': 'Tickets en espera y ya programados, con su antigüedad.',
  'programacion.cola.nueva': 'Nueva solicitud',
  'programacion.cola.filtro.estado': 'Estado',
  'programacion.cola.filtro.soloEspera': 'Solo en espera',
  'programacion.cola.filtro.canal': 'Canal',
  'programacion.cola.filtro.buscar': 'Buscar',
  'programacion.cola.filtro.buscarPlaceholder': 'Ticket, nombre o documento',
  'programacion.cola.filtro.todos': 'Todos',
  'programacion.cola.orden': 'Orden',
  'programacion.cola.orden.ticket': 'Por ticket',
  'programacion.cola.orden.antiguedad': 'Por antigüedad',
  'programacion.cola.cargando': 'Cargando las solicitudes…',
  'programacion.cola.error': 'No se pudieron cargar las solicitudes.',
  'programacion.cola.vacio': 'No hay solicitudes con estos filtros.',
  'programacion.cola.vacioTitulo': 'Sin solicitudes',
  'programacion.cola.total': '{total} solicitud(es)',
  'programacion.cola.pagina': 'Página {pagina} de {paginas}',
  'programacion.cola.anterior': 'Anterior',
  'programacion.cola.siguiente': 'Siguiente',
  'programacion.cola.antiguedadHoy': 'Pidió cita hoy',
  'programacion.cola.antiguedad': '{dias} día(s) esperando',
  'programacion.cola.cita': 'Cita: {fecha} · {hora}',
  'programacion.cola.seleccionar': 'Seleccionar la solicitud {ticket} de {paciente}',
  'programacion.cola.seleccionada': 'Seleccionada',
  'programacion.cola.asignar': 'Asignar',
  'programacion.cola.cancelar': 'Cancelar',
  'programacion.cola.yaAsignada': 'Ya tiene cita',
  'programacion.cola.arrastrar': 'Arrastra la fila a una franja libre de la jornada.',

  // Nueva solicitud
  'programacion.nueva.titulo': 'Nueva solicitud',
  'programacion.nueva.texto':
    'Busca al paciente ya registrado y describe el motivo: la API entrega el ticket al crear la solicitud.',
  'programacion.nueva.paciente': 'Paciente',
  'programacion.nueva.buscar': 'Buscar paciente',
  'programacion.nueva.buscarPlaceholder': 'Nombre, documento o teléfono',
  'programacion.nueva.buscando': 'Buscando…',
  'programacion.nueva.sinResultados': 'Sin coincidencias. Prueba con otro nombre o documento.',
  'programacion.nueva.errorBusqueda': 'No se pudo buscar el paciente.',
  'programacion.nueva.documento': 'Documento exacto',
  'programacion.nueva.buscarDocumento': 'Buscar por documento',
  'programacion.nueva.noEncontrado':
    'No hay ningún paciente con el documento {documento}. Regístralo primero en el módulo Registro.',
  'programacion.nueva.elegido': 'Paciente elegido',
  'programacion.nueva.cambiar': 'Elegir otro paciente',
  'programacion.nueva.sinPaciente': 'Elige un paciente de la lista para continuar.',
  'programacion.nueva.motivo': 'Motivo de la consulta',
  'programacion.nueva.canal': 'Canal de la solicitud',
  'programacion.nueva.prioridad': 'Prioridad',
  'programacion.nueva.prioridadAyuda': 'De 0 (normal) a 9 (más urgente).',
  'programacion.nueva.notas': 'Notas',
  'programacion.nueva.enviar': 'Crear la solicitud',
  'programacion.nueva.ok': 'Solicitud creada con el ticket {ticket}.',
  'programacion.nueva.irARegistro': 'Ir al registro de pacientes',

  // Cancelar una solicitud
  'programacion.solicitud.cancelarTitulo': 'Cancelar la solicitud {ticket}',
  'programacion.solicitud.cancelarTexto':
    'La solicitud queda cancelada con su motivo en el historial; el ticket se conserva.',
  'programacion.solicitud.motivo': 'Motivo de la cancelación',
  'programacion.solicitud.ok': 'Solicitud {ticket} cancelada.',

  // Asignación de cita
  'programacion.asignar.titulo': 'Asignar cita',
  'programacion.asignar.texto':
    'La solicitud se convierte en cita con fecha y hora. La franja o la hora manual la decides aquí.',
  'programacion.asignar.ticket': 'Ticket {ticket}',
  'programacion.asignar.fecha': 'Fecha de la cita',
  'programacion.asignar.modalidad': 'Tipo de hora',
  'programacion.asignar.franja': 'Franja disponible',
  'programacion.asignar.manual': 'Hora manual',
  'programacion.asignar.hora': 'Hora (HH:MM)',
  'programacion.asignar.duracion': 'Duración (minutos)',
  'programacion.asignar.notas': 'Notas de la cita',
  'programacion.asignar.sinFranjas':
    'No quedan franjas libres ese día: usa una hora manual o cambia la fecha.',
  'programacion.asignar.enviar': 'Asignar la cita',
  'programacion.asignar.ok': 'Cita asignada a las {hora} del {fecha}.',
  'programacion.asignar.cargandoDia': 'Comprobando las franjas del día…',
  'programacion.asignar.manualAviso':
    'La hora manual no ocupa una franja de la rejilla: es para casos puntuales fuera de la jornada.',

  // Sobrecupo (solo admin)
  'programacion.sobrecupo.titulo': 'El día está completo: hace falta autorizar el sobrecupo',
  'programacion.sobrecupo.texto':
    'El {fecha} tiene {asignados} citas asignadas sobre un cupo de {cupo}. Para asignar una más hay que autorizar el sobrecupo y explicar el motivo: queda en la auditoría.',
  'programacion.sobrecupo.motivo': 'Motivo del sobrecupo',
  'programacion.sobrecupo.motivoAyuda': 'Mínimo 3 caracteres; explica por qué se autoriza.',
  'programacion.sobrecupo.autorizar': 'Autorizar el sobrecupo y asignar',
  'programacion.sobrecupo.sinPermiso':
    'El día está completo y tu rol no puede autorizar sobrecupos (permiso «scheduling:overbook», solo administración).',
  'programacion.sobrecupo.sinPermisoCorto':
    'Solo un administrador puede autorizar sobrecupo en un día completo.',

  // Reprogramar
  'programacion.reprogramar.titulo': 'Reprogramar la cita de {paciente}',
  'programacion.reprogramar.texto':
    'Reprogramar no borra nada: la cita actual queda como «reprogramada» y se crea una nueva enlazada con el mismo ticket.',
  'programacion.reprogramar.motivo': 'Motivo de la reprogramación',
  'programacion.reprogramar.enviar': 'Reprogramar la cita',
  'programacion.reprogramar.ok': 'Cita reprogramada para el {fecha} a las {hora}.',
  'programacion.reprogramar.enlazada': 'Reprogramada',

  // Acciones según la máquina de estados
  'programacion.accion.asignar': 'Asignar fecha y hora',
  'programacion.accion.notificar': 'Notificar al paciente',
  'programacion.accion.checkIn': 'Registrar llegada',
  'programacion.accion.llamado': 'Llamar al paciente',
  'programacion.accion.llamado2': 'Segundo llamado',
  'programacion.accion.consulta': 'Pasar a consulta',
  'programacion.accion.atendido': 'Marcar atendido',
  'programacion.accion.inasistencia': 'Marcar inasistencia',
  'programacion.accion.cancelar': 'Cancelar la cita',
  'programacion.accion.reprogramar': 'Reprogramar',
  'programacion.accion.historial': 'Historial',
  'programacion.accion.sinAcciones': 'Sin acciones para este estado',
  'programacion.accion.para': 'Acciones para {paciente}',
  'programacion.accion.checkInOk': 'Llegada registrada.',
  'programacion.accion.llamadoOk': 'Paciente llamado.',
  'programacion.accion.consultaOk': 'El paciente pasó a consulta.',
  'programacion.accion.inasistenciaPendiente':
    'La inasistencia se puede marcar {minutos} min después de la hora de la cita; faltan {faltan} min.',
  'programacion.accion.llamados': '{total} llamado(s)',
  'programacion.accion.segundoLlamado': '2.º llamado',
  'programacion.accion.hora': '{inicio} a {fin}',

  // Marcar atendido
  'programacion.atendido.titulo': 'Marcar atendido a {paciente}',
  'programacion.atendido.texto':
    'La historia clínica y las sesiones llegan en la Fase 6. Mientras tanto, marcar «atendido» exige un motivo que queda registrado en la auditoría; cuando exista la sesión clínica cerrada, se enlazará sola.',
  'programacion.atendido.motivo': 'Motivo (obligatorio mientras no haya historia clínica)',
  'programacion.atendido.motivoCorto': 'Escribe el motivo (mínimo 3 caracteres)',
  'programacion.atendido.motivoAyuda':
    'Por ejemplo: sesión clínica en papel, control de ortodoncia.',
  'programacion.atendido.enviar': 'Marcar atendido',
  'programacion.atendido.ok': 'Cita marcada como atendida.',

  // Inasistencia
  'programacion.inasistencia.titulo': 'Marcar la inasistencia de {paciente}',
  'programacion.inasistencia.texto':
    'Solo se puede marcar después de la hora de la cita más {minutos} minutos de tolerancia. El servidor lo valida igual.',
  'programacion.inasistencia.motivo': 'Motivo (opcional)',
  'programacion.inasistencia.enviar': 'Marcar inasistencia',
  'programacion.inasistencia.ok': 'Inasistencia registrada.',

  // Cancelar cita
  'programacion.cancelar.titulo': 'Cancelar la cita de {paciente}',
  'programacion.cancelar.texto':
    'La cita queda cancelada con su motivo en el historial y libera su lugar del cupo.',
  'programacion.cancelar.motivo': 'Motivo de la cancelación',
  'programacion.cancelar.enviar': 'Cancelar la cita',
  'programacion.cancelar.ok': 'Cita cancelada.',

  // Motivo genérico de las acciones
  'programacion.motivo.opcional': 'opcional',
  'programacion.accion.ok': 'Acción aplicada.',

  // Errores con datos útiles del cuerpo RFC 7807
  'programacion.error.diaCompleto':
    'El día tiene {asignados} citas asignadas sobre un cupo de {cupo}.',
  'programacion.error.franjaOcupada': 'La franja de las {hora} ya está ocupada por otra cita.',
  'programacion.error.transicion':
    'No se puede pasar de «{desde}» a «{hasta}». Transiciones permitidas: {permitidas}.',
  'programacion.error.permiso':
    'La operación la rechazó el servidor por permisos: pídeselo a la administración.',

  // Historial de la cita
  'programacion.historial.titulo': 'Historial de la cita',
  'programacion.historial.texto':
    'Cada cambio de estado queda registrado con su actor, su hora y su motivo.',
  'programacion.historial.cargando': 'Cargando el historial…',
  'programacion.historial.error': 'No se pudo cargar el historial.',
  'programacion.historial.vacio': 'Esta cita todavía no tiene cambios de estado.',
  'programacion.historial.total': '{total} movimiento(s)',
  'programacion.historial.columna.cambio': 'Cambio',
  'programacion.historial.columna.motivo': 'Motivo',
  'programacion.historial.columna.actor': 'Quién',
  'programacion.historial.columna.cuando': 'Cuándo',
  'programacion.historial.de': '{desde} → {hasta}',
  'programacion.historial.creacion': 'Creación de la cita',
  'programacion.historial.sistema': 'Sistema',

  // Citas del día
  'programacion.citas.titulo': 'Citas del día',
  'programacion.citas.columna.hora': 'Hora',
  'programacion.citas.columna.paciente': 'Paciente',
  'programacion.citas.columna.ticket': 'Ticket',
  'programacion.citas.columna.estado': 'Estado',
  'programacion.citas.columna.llamados': 'Llamados',
  'programacion.citas.columna.acciones': 'Acciones',
  'programacion.citas.total': '{total} cita(s) en la jornada',
  'programacion.citas.vacio':
    'Todavía no hay citas para este día. Selecciona una solicitud de la cola y pulsa una franja libre para asignar la primera.',
  'programacion.citas.manual': 'Hora manual',

  // Aviso en lote
  'programacion.notificar.boton': 'Notificar',
  'programacion.notificar.titulo': 'Avisos del {fecha}',
  'programacion.notificar.texto': 'Estos son exactamente los mensajes que se prepararán.',
  'programacion.notificar.individual': 'Aviso de {paciente}',
  'programacion.notificar.individualTexto':
    'Se prepara solo el aviso de esta cita; el resto quedan como están.',
  'programacion.notificar.envio':
    'El aviso sale por el canal del paciente (Telegram o WhatsApp) con el calendario adjunto. Si no tiene canal vinculado, queda en la bandeja como aviso manual para llamarlo por teléfono.',
  'programacion.notificar.verBandeja': 'Ver la bandeja de notificaciones',
  'programacion.notificar.cargando': 'Preparando la vista previa…',
  'programacion.notificar.error': 'No se pudo preparar la vista previa de los avisos.',
  'programacion.notificar.vacio': 'No hay citas notificables en esta fecha.',
  'programacion.notificar.total': '{total} cita(s) en el lote',
  'programacion.notificar.prepararan': '{total} mensaje(s) por preparar',
  'programacion.notificar.seEnvia': 'Se enviará',
  'programacion.notificar.noSeEnvia': 'No se enviará',
  'programacion.notificar.motivoOmision': 'Por qué no',
  'programacion.notificar.asunto': 'Asunto',
  'programacion.notificar.cuerpo': 'Mensaje',
  'programacion.notificar.destino': 'Destino: {telefono}',
  'programacion.notificar.sinTelefono': 'sin teléfono registrado',
  'programacion.notificar.hora': 'Cita: {fecha} · {hora}',
  'programacion.notificar.reenviar': 'Reenviar también los ya notificados',
  'programacion.notificar.reenviarAyuda':
    'Sin marcar, las citas que ya figuran como notificadas se omiten.',
  'programacion.notificar.confirmar': 'Preparar los avisos',
  'programacion.notificar.confirmarUno': 'Preparar el aviso',
  'programacion.notificar.ok': 'Avisos preparados: {notified}. Omitidos: {skipped}.',

  // Plantillas de franjas
  'programacion.plantillas.abrir': 'Plantillas de franjas',
  'programacion.plantillas.titulo': 'Plantillas de franjas de la semana',
  'programacion.plantillas.texto':
    'El servicio arma las franjas del día con estas plantillas cuando no hay cupo explícito. Las pausas se descartan de la rejilla.',
  'programacion.plantillas.cargando': 'Cargando las plantillas…',
  'programacion.plantillas.error': 'No se pudieron cargar las plantillas.',
  'programacion.plantillas.vacio': 'No hay plantillas configuradas.',
  'programacion.plantillas.horario': '{inicio} a {fin}',
  'programacion.plantillas.franjas': '{total} franja(s) de {minutos} min',
  'programacion.plantillas.pausas': 'Pausas: {pausas}',
  'programacion.plantillas.sinPausas': 'Sin pausas',
  'programacion.plantillas.inactiva': 'Inactiva',
  'programacion.plantillas.nota':
    'Esta vista es informativa: la plantilla se administra desde el servicio de agenda y alimenta el cupo y las franjas de cada día.',

  // --- Notificaciones y bot (Fase 4) ---------------------------------------
  'notificaciones.titulo': 'Notificaciones',
  'notificaciones.descripcion':
    'Bandeja de los envíos del asistente (Telegram y WhatsApp): qué salió, qué falló, quién espera un aviso manual, las conversaciones a medio camino y los textos que se envían.',

  // Estado del bot
  'notificaciones.bot.titulo': 'Estado del asistente y los canales',
  'notificaciones.bot.actualizado': 'Actualizado {cuando}',
  'notificaciones.bot.cargando': 'Consultando el estado del asistente…',
  'notificaciones.bot.error': 'No se pudo consultar el estado del asistente.',
  'notificaciones.bot.recargar': 'Actualizar el estado',
  'notificaciones.bot.sinUsuario': 'Sin @usuario configurado',
  'notificaciones.bot.modo.real': 'Modo real',
  'notificaciones.bot.modo.simulado': 'Modo simulado',
  'notificaciones.bot.real.texto':
    'El bot de Telegram tiene token configurado y está conectado: los mensajes salen por los canales del paciente (Telegram o WhatsApp).',
  'notificaciones.bot.real.sinConexion':
    'El bot de Telegram tiene token configurado, pero ahora mismo no está conectado: los envíos quedan en cola hasta que vuelva la conexión.',
  'notificaciones.bot.simulado.texto':
    'No hay token configurado: los mensajes quedan registrados en la bandeja, pero no se envían. Configura el token del bot para activar los envíos reales.',
  'notificaciones.bot.canales': 'Canales',
  'notificaciones.bot.canal.sinConfigurar': 'sin configurar',
  'notificaciones.bot.conectado': 'Conectado',
  'notificaciones.bot.desconectado': 'Sin conexión',
  'notificaciones.bot.pendientes': 'Actualizaciones por procesar',
  'notificaciones.bot.ultimaActualizacion': 'Última actualización recibida',
  'notificaciones.bot.contador.queued': 'En cola',
  'notificaciones.bot.contador.sent': 'Enviados',
  'notificaciones.bot.contador.failed': 'Fallidos',
  'notificaciones.bot.contador.manualPending': 'Avisos manuales pendientes',

  // Conversaciones
  'notificaciones.conversaciones.titulo': 'Conversaciones del bot',
  'notificaciones.conversaciones.texto':
    'Chats que están a medio camino en el asistente. Solo informa: la conversación la continúa el propio bot.',
  'notificaciones.conversaciones.cargando': 'Cargando las conversaciones…',
  'notificaciones.conversaciones.vacio': 'Ahora mismo no hay conversaciones abiertas.',
  'notificaciones.conversaciones.total': '{total} conversación(es)',
  'notificaciones.conversaciones.columna.chat': 'Chat',
  'notificaciones.conversaciones.columna.paso': 'Paso del asistente',
  'notificaciones.conversaciones.columna.actualizada': 'Última actualización',
  'notificaciones.conversaciones.paciente': 'Paciente vinculado',
  'notificaciones.conversaciones.sinPaciente': 'Sin paciente vinculado',
  'notificaciones.conversaciones.estado.inicio': 'Inicio',
  'notificaciones.conversaciones.estado.listo': 'Listo',
  'notificaciones.conversaciones.estado.esperando': 'Esperando {paso}',
  'notificaciones.conversaciones.estado.representante': 'Datos del representante',

  // Bandeja
  'notificaciones.bandeja.titulo': 'Bandeja de envíos',
  'notificaciones.bandeja.descripcion':
    'Cada fila es un mensaje preparado por el bot, con sus intentos y su último error.',
  'notificaciones.bandeja.cargando': 'Cargando los envíos…',
  'notificaciones.bandeja.error': 'No se pudieron cargar los envíos.',
  'notificaciones.bandeja.vacioTitulo': 'Sin envíos',
  'notificaciones.bandeja.vacio': 'No hay envíos que coincidan con estos filtros.',
  'notificaciones.bandeja.total': '{total} envío(s)',
  'notificaciones.bandeja.pagina': 'Página {pagina} de {paginas}',
  'notificaciones.bandeja.anterior': 'Anterior',
  'notificaciones.bandeja.siguiente': 'Siguiente',
  'notificaciones.bandeja.filtro.estado': 'Estado',
  'notificaciones.bandeja.filtro.canal': 'Canal',
  'notificaciones.bandeja.filtro.buscar': 'Buscar paciente',
  'notificaciones.bandeja.filtro.buscarPlaceholder': 'Nombre o documento',
  'notificaciones.bandeja.filtro.desde': 'Desde',
  'notificaciones.bandeja.filtro.hasta': 'Hasta',
  'notificaciones.bandeja.filtro.todos': 'Todos',
  'notificaciones.bandeja.columna.creado': 'Creado',
  'notificaciones.bandeja.columna.paciente': 'Paciente',
  'notificaciones.bandeja.columna.plantilla': 'Plantilla',
  'notificaciones.bandeja.columna.canal': 'Canal',
  'notificaciones.bandeja.columna.estado': 'Estado',
  'notificaciones.bandeja.columna.intentos': 'Intentos',
  'notificaciones.bandeja.columna.error': 'Último error',
  'notificaciones.bandeja.columna.enviado': 'Enviado',
  'notificaciones.bandeja.columna.acciones': 'Acciones',
  'notificaciones.bandeja.reintentar': 'Reintentar',
  'notificaciones.bandeja.contactado': 'Marcar contacto hecho',
  'notificaciones.bandeja.contactadoCorto': 'Contacto',
  'notificaciones.bandeja.ver': 'Ver detalle',
  'notificaciones.bandeja.proximoIntento': 'Próximo intento: {cuando}',
  'notificaciones.bandeja.contactoHecho': 'Contactado el {fecha} por {actor}',
  'notificaciones.bandeja.contactoHechoSinActor': 'Contactado el {fecha}',

  // Solo lectura para quien no tiene el permiso de avisos
  'notificaciones.soloLectura':
    'Puedes consultar esta sección, pero no modificarla: hace falta el permiso de avisos (`scheduling:notify`).',

  // Estados
  'notificaciones.estado.queued': 'En cola',
  'notificaciones.estado.sending': 'Enviando',
  'notificaciones.estado.sent': 'Enviado',
  'notificaciones.estado.failed': 'Falló',
  'notificaciones.estado.skipped_no_channel': 'Aviso manual pendiente',
  'notificaciones.estado.avisoManual':
    'El paciente no tiene ningún canal vinculado (Telegram o WhatsApp): hay que llamarlo y marcar el contacto como hecho.',

  // Reintento y contacto
  'notificaciones.reintento.titulo': 'Reintentar el envío',
  'notificaciones.reintento.texto':
    'El envío vuelve a la cola del bot y se intenta de nuevo con los mismos datos.',
  'notificaciones.reintento.motivo': 'Motivo del reintento',
  'notificaciones.reintento.enviar': 'Reintentar el envío',
  'notificaciones.reintento.ok': 'Envío devuelto a la cola.',
  'notificaciones.contacto.titulo': 'Marcar el contacto como hecho',
  'notificaciones.contacto.texto':
    'Se registra que la secretaría ya avisó al paciente por teléfono, con la nota y la fecha.',
  'notificaciones.contacto.nota': 'Nota del contacto',
  'notificaciones.contacto.notaAyuda': 'Entre 3 y 300 caracteres. Queda en el registro del envío.',
  'notificaciones.contacto.notaPlaceholder': 'Por ejemplo: llamé a las 9:20 y confirmó la cita.',
  'notificaciones.contacto.enviar': 'Marcar contacto hecho',
  'notificaciones.contacto.ok': 'Contacto registrado.',

  // Detalle del envío
  'notificaciones.detalle.titulo': 'Detalle del envío',
  'notificaciones.detalle.texto': 'El mensaje que se envió o que se enviará al paciente.',
  'notificaciones.detalle.mensaje': 'Mensaje',
  'notificaciones.detalle.sinMensaje':
    'El payload de este envío no trae el texto del mensaje; revisa la plantilla con la que se preparó.',
  'notificaciones.detalle.plantilla': 'Plantilla',
  'notificaciones.detalle.canal': 'Canal',
  'notificaciones.detalle.destino': 'Destino',
  'notificaciones.detalle.ticket': 'Ticket',
  'notificaciones.detalle.fecha': 'Fecha de la cita',
  'notificaciones.detalle.hora': 'Hora de la cita',
  'notificaciones.detalle.lugar': 'Lugar',
  'notificaciones.detalle.creado': 'Creado',
  'notificaciones.detalle.enviado': 'Enviado',
  'notificaciones.detalle.intentos': 'Intentos',
  'notificaciones.detalle.error': 'Último error',
  'notificaciones.detalle.nota': 'Nota del contacto',
  'notificaciones.detalle.datos': 'Datos del mensaje',
  'notificaciones.detalle.dato': 'Dato',
  'notificaciones.detalle.valor': 'Valor',

  // Plantillas
  'notificaciones.plantillas.titulo': 'Plantillas de los mensajes',
  'notificaciones.plantillas.descripcion':
    'Los textos que envía el asistente. Se envían tal cual por el canal del paciente: no se admite HTML, solo texto y saltos de línea.',
  'notificaciones.plantillas.cargando': 'Cargando las plantillas…',
  'notificaciones.plantillas.error': 'No se pudieron cargar las plantillas.',
  'notificaciones.plantillas.vacio': 'Todavía no hay plantillas configuradas.',
  'notificaciones.plantillas.total': '{total} plantilla(s)',
  'notificaciones.plantillas.modificada': 'Modificada',
  'notificaciones.plantillas.original': 'Texto por defecto',
  'notificaciones.plantillas.inactiva': 'Inactiva',
  'notificaciones.plantillas.sinGuardar': 'Sin guardar',
  'notificaciones.plantillas.editor': 'Editando «{clave}»',
  'notificaciones.plantillas.sinSeleccion':
    'Elige una plantilla de la lista para verla y editarla.',
  'notificaciones.plantillas.asunto': 'Asunto',
  'notificaciones.plantillas.asuntoAyuda': 'Solo lo usan las plantillas de avisos de cita.',
  'notificaciones.plantillas.asuntoNoAplica': 'Esta plantilla no lleva asunto.',
  'notificaciones.plantillas.cuerpo': 'Texto del mensaje',
  'notificaciones.plantillas.cuerpoAyuda':
    'Máximo {max} caracteres. Los saltos de línea se respetan tal cual.',
  'notificaciones.plantillas.cuerpoVacio': 'El texto no puede quedar vacío.',
  'notificaciones.plantillas.marcadores': 'Marcadores disponibles',
  'notificaciones.plantillas.marcadoresAyuda':
    'Pulsa uno para insertarlo en el texto, donde tengas el cursor.',
  'notificaciones.plantillas.sinMarcadores': 'Esta plantilla no usa marcadores.',
  'notificaciones.plantillas.insertar': 'Insertar el marcador {marcador}',
  'notificaciones.plantillas.vista': 'Vista previa',
  'notificaciones.plantillas.vistaAyuda': 'Con datos de ejemplo para que veas cómo llega.',
  'notificaciones.plantillas.vistaSistema': 'Así lo recibe el paciente',
  'notificaciones.plantillas.guardar': 'Guardar plantilla',
  'notificaciones.plantillas.guardada': 'Plantilla guardada.',
  'notificaciones.plantillas.guardando': 'Guardando la plantilla…',
  'notificaciones.plantillas.restaurar': 'Restaurar texto por defecto',
  'notificaciones.plantillas.restaurarTitulo': 'Restaurar «{clave}»',
  'notificaciones.plantillas.restaurarTexto':
    'El texto vuelve al que trae el sistema de fábrica y se pierde el que está guardado. La operación queda registrada.',
  'notificaciones.plantillas.restaurada': 'Plantilla restaurada al texto por defecto.',
  'notificaciones.plantillas.avisoHtml':
    'El canal recibe el texto tal cual: no se admite HTML ni formatos, solo texto y saltos de línea.',
  'notificaciones.plantillas.activa': 'Plantilla activa',
  'notificaciones.plantillas.activaAyuda':
    'Si la desactivas, el bot no encuentra texto para ese paso y avisa por el registro.',

  // Nombre de cada plantilla (las claves llegan del contrato, en snake_case)
  'notificaciones.plantilla.bienvenida': 'Bienvenida',
  'notificaciones.plantilla.ayuda': 'Ayuda',
  'notificaciones.plantilla.pedir_nombre': 'Pedir el nombre',
  'notificaciones.plantilla.pedir_documento': 'Pedir el documento',
  'notificaciones.plantilla.pedir_telefono': 'Pedir el teléfono',
  'notificaciones.plantilla.pedir_nacimiento': 'Pedir la fecha de nacimiento',
  'notificaciones.plantilla.pedir_sexo': 'Pedir el sexo',
  'notificaciones.plantilla.pedir_motivo': 'Pedir el motivo',
  'notificaciones.plantilla.confirmar': 'Confirmar los datos',
  'notificaciones.plantilla.documento_duplicado': 'Documento ya registrado',
  'notificaciones.plantilla.solicitud_recibida': 'Solicitud recibida',
  'notificaciones.plantilla.cita_confirmada': 'Cita confirmada',
  'notificaciones.plantilla.cita_reprogramada': 'Cita reprogramada',
  'notificaciones.plantilla.cita_cancelada': 'Cita cancelada',
  'notificaciones.plantilla.estado_solicitud': 'Estado de la solicitud',
  'notificaciones.plantilla.manual_pendiente': 'Aviso manual pendiente',
  'notificaciones.plantilla.servicio_no_disponible': 'Sistema no disponible',

  // Vinculación de pacientes
  'notificaciones.canales.titulo': 'Vinculación de pacientes',
  'notificaciones.canales.descripcion':
    'El paciente abre el enlace o escanea el QR y su Telegram queda vinculado; desde ahí el bot le escribe.',
  'notificaciones.canales.buscar': 'Buscar paciente',
  'notificaciones.canales.buscarPlaceholder': 'Nombre, documento o teléfono',
  'notificaciones.canales.buscando': 'Buscando pacientes…',
  'notificaciones.canales.sinResultados': 'Sin coincidencias. Prueba con otro nombre o documento.',
  'notificaciones.canales.errorBusqueda': 'No se pudo buscar el paciente.',
  'notificaciones.canales.elegido': 'Paciente elegido',
  'notificaciones.canales.cambiar': 'Elegir otro paciente',
  'notificaciones.canales.sinPaciente': 'Elige un paciente para generar su enlace.',
  'notificaciones.canales.generar': 'Generar enlace de vinculación',
  'notificaciones.canales.generando': 'Generando el enlace…',
  'notificaciones.canales.codigo': 'Código de vinculación',
  'notificaciones.canales.enlace': 'Enlace para el paciente',
  'notificaciones.canales.copiar': 'Copiar el enlace',
  'notificaciones.canales.copiado': 'Enlace copiado al portapapeles.',
  'notificaciones.canales.copiarError': 'No se pudo copiar: selecciona el enlace y cópialo a mano.',
  'notificaciones.canales.caduca': 'Caduca el {fecha}',
  'notificaciones.canales.expirado': 'Este enlace ya caducó: genera uno nuevo.',
  'notificaciones.canales.instruccion':
    'El paciente abre este enlace o escanea el QR y su Telegram queda vinculado.',
  'notificaciones.canales.qrAlt':
    'Código QR del enlace de vinculación de {paciente} con el bot de Telegram.',
  'notificaciones.canales.sinQr': 'El servicio no devolvió la imagen del QR: usa el enlace.',
  'notificaciones.canales.noDisponible':
    'El enlace estará disponible cuando se configure el token del bot. Ahora mismo el bot está en modo simulado y los mensajes no se envían.',
  'notificaciones.canales.listaTitulo': 'Canales vinculados',
  'notificaciones.canales.listaTexto':
    'Chats que ya están vinculados a un paciente. El identificador se muestra enmascarado.',
  'notificaciones.canales.cargando': 'Cargando los canales vinculados…',
  'notificaciones.canales.errorLista': 'No se pudieron cargar los canales vinculados.',
  'notificaciones.canales.vacio': 'Todavía no hay ningún paciente con un canal vinculado.',
  'notificaciones.canales.total': '{total} vínculo(s)',
  'notificaciones.canales.columna.paciente': 'Paciente',
  'notificaciones.canales.columna.chat': 'Dirección',
  'notificaciones.canales.columna.usuario': 'Usuario del canal',
  'notificaciones.canales.columna.vinculado': 'Vinculado',
  'notificaciones.canales.columna.acciones': 'Acciones',
  'notificaciones.canales.bloqueado': 'Bloqueado',
  'notificaciones.canales.desvincular': 'Desvincular',
  'notificaciones.canales.desvincularTitulo': 'Desvincular a {paciente}',
  'notificaciones.canales.desvincularTexto':
    'El chat queda bloqueado y el paciente no vuelve a recibir mensajes del bot. Podrá vincularse otra vez con un enlace nuevo.',
  'notificaciones.canales.desvinculado': 'Paciente desvinculado.',
  'notificaciones.canales.generado': 'Enlace de vinculación generado para {paciente}.',
  'notificaciones.canales.errorGenerar': 'No se pudo generar el enlace de vinculación.',

  // --- Fase 5: secretaría ---------------------------------------------------
  'secretaria.titulo': 'Secretaría del día',
  'secretaria.descripcion':
    'La jornada hora por hora: registrar llegada, llamar al paciente, pasarlo a consulta y cerrar la visita.',
  'secretaria.fecha': 'Fecha de la jornada',
  'secretaria.hoy': 'Hoy',
  'secretaria.diaAnterior': 'Día anterior',
  'secretaria.diaSiguiente': 'Día siguiente',
  'secretaria.buscar': 'Buscar paciente',
  'secretaria.buscarPlaceholder': 'Nombre, documento, teléfono o ticket',
  'secretaria.cargando': 'Cargando la jornada…',
  'secretaria.error': 'No se pudo cargar la jornada del día.',
  'secretaria.reintentar': 'Reintentar',
  'secretaria.vacio': 'No hay citas para este día.',
  'secretaria.sinResultados': 'Ninguna cita coincide con la búsqueda.',
  'secretaria.columna.hora': 'Hora',
  'secretaria.columna.paciente': 'Paciente',
  'secretaria.columna.documento': 'Documento',
  'secretaria.columna.telefono': 'Teléfono',
  'secretaria.columna.ticket': 'Ticket',
  'secretaria.columna.estado': 'Estado',
  'secretaria.columna.acciones': 'Acciones',
  'secretaria.contadores.programadas': 'Programadas',
  'secretaria.contadores.enSala': 'En sala',
  'secretaria.contadores.atendidas': 'Atendidas',
  'secretaria.contadores.noAsistio': 'No asistió',
  'secretaria.acciones.checkIn': 'Registrar llegada',
  'secretaria.acciones.llamar': 'Llamar',
  'secretaria.acciones.pasar': 'Pasar a consulta',
  'secretaria.acciones.atendido': 'Marcar atendido',
  'secretaria.acciones.noAsistio': 'No asistió',
  'secretaria.acciones.detalle': 'Ver historial',
  'secretaria.acciones.fueraDeOrden': 'Llamar fuera de orden',
  'secretaria.emergencia.titulo': 'Llamar fuera de orden',
  'secretaria.emergencia.texto':
    'Se va a llamar a {paciente} aunque no le toque por hora. Queda registrado en el historial de la cita.',
  'secretaria.emergencia.confirmar': 'Sí, llamar ahora',
  'secretaria.atendido.titulo': 'Marcar como atendido',
  'secretaria.atendido.texto': 'Confirma que la visita de {paciente} terminó.',
  'secretaria.atendido.advertencia':
    'Todavía no hay sesión clínica cerrada para esta cita: escribe el motivo para dejar constancia en la auditoría.',
  'secretaria.atendido.motivo': 'Motivo',
  'secretaria.atendido.motivoPlaceholder':
    'Por ejemplo: consulta de valoración sin sesión en el sistema',
  'secretaria.atendido.confirmar': 'Marcar atendido',
  /** Con la sesión clínica cerrada (Fase 7) el «atendido» no pide motivo. */
  'secretaria.atendido.conSesion.titulo': 'La sesión clínica de esta cita está cerrada',
  'secretaria.atendido.conSesion.texto':
    'El doctor ya cerró la sesión: {resumen}. Solo hay que confirmar la visita.',
  'secretaria.noAsistio.titulo': 'Marcar inasistencia',
  'secretaria.noAsistio.texto': 'Se marcará que {paciente} no asistió a su cita.',
  'secretaria.noAsistio.motivo': 'Motivo (opcional)',
  'secretaria.noAsistio.confirmar': 'Marcar inasistencia',
  'secretaria.noAsistio.muyPronto':
    'Todavía no se puede: hay 15 minutos de tolerancia desde la hora de la cita.',
  'secretaria.hecho.checkIn': 'Llegada registrada: {paciente}',
  'secretaria.hecho.llamado': 'Llamado a {paciente}',
  'secretaria.hecho.enConsulta': '{paciente} pasó a consulta',
  'secretaria.hecho.atendido': 'Visita de {paciente} cerrada',
  'secretaria.hecho.noAsistio': '{paciente} quedó como inasistencia',
  'secretaria.error.accion': 'No se pudo completar la acción.',
  'secretaria.historial.titulo': 'Historial de la cita',
  'secretaria.historial.texto': 'Transiciones de estado con su actor, motivo y hora.',
  'secretaria.historial.vacio': 'Sin transiciones registradas.',

  // --- Fase 8: página unificada del flujo diario ---------------------------
  'flujo.titulo': 'Flujo del día',
  'flujo.fecha': 'Fecha de la jornada',
  'flujo.cola.titulo': 'Cola del día',
  'flujo.cola.vacia': 'No hay citas que mostrar',
  'flujo.sinPaciente': 'Sin paciente en curso',
  'flujo.sinPacienteTexto':
    'Elige una cita en la cola del día o busca un paciente con F2 para abrir su expediente aquí mismo.',
  'flujo.volverCola': 'Volver a la cola del día',
  'flujo.buscar.texto': 'Escribe el nombre, el documento o el teléfono del paciente.',
  'flujo.atajo.buscar': 'Buscar paciente',
  'flujo.atajo.llamar': 'Llamar al paciente',
  'flujo.atajo.cerrar': 'Cerrar la sesión',
  'flujo.atajo.buscarAyuda': 'Abre el buscador de pacientes',
  'flujo.atajo.llamarAyuda': 'Llama al paciente en curso (sale en la pantalla de la sala)',
  'flujo.atajo.cerrarAyuda': 'Cierra la sesión clínica de la visita',
  'flujo.atajos.ayuda': '{buscar} · {llamar} · {cerrar}',
  'flujo.cerrar.sinPaciente': 'No hay ningún paciente abierto: elige su cita en la cola del día.',
  'flujo.cerrar.sinContenido':
    'Para cerrar la sesión hace falta el motivo, el diagnóstico o algún procedimiento.',
  'flujo.llamar.sinPaciente': 'No hay ninguna cita en curso a la que llamar.',
  'flujo.llamar.noDisponible':
    'Esta cita no admite un llamado ahora mismo; usa «Llamar fuera de orden» si el paciente ya está aquí.',
  'flujo.ayuda.titulo': 'Atajos de esta pantalla',
  'flujo.ayuda.texto':
    'Funcionan desde cualquier punto del flujo, salvo con un diálogo abierto. En la tableta están también como botones en la barra de arriba.',

  // --- Fase 5: pantallas kiosko --------------------------------------------
  'pantalla.cargando': 'Conectando con la pantalla…',
  'pantalla.sinToken.titulo': 'Esta pantalla no está configurada',
  'pantalla.sinToken.texto':
    'Abre el enlace que genera el módulo Pantallas en este mismo equipo: incluye el token del dispositivo y solo hace falta una vez.',
  'pantalla.sinPermiso.titulo': 'La pantalla ya no está autorizada',
  'pantalla.sinPermiso.texto':
    'El token fue revocado o la pantalla se desactivó. Pide en el módulo Pantallas que la registren de nuevo.',
  'pantalla.desconectada': 'Sin conexión con el servidor: reintentando…',
  'pantalla.reconectada': 'Conectada',
  'pantalla.actualizado': 'Actualizado a las {hora}',
  'pantalla.lobby.titulo': 'Sala de espera',
  'pantalla.lobby.vacio': 'En espera de llamados',
  'pantalla.lobby.turno': 'Turno {turno}',
  'pantalla.lobby.pasar': 'Pase a {sillon}',
  'pantalla.lobby.segundoLlamado': 'Segundo llamado',
  'pantalla.lobby.enSala': '{total} paciente(s) en sala',
  'pantalla.consultorio.titulo': 'Consultorio',
  'pantalla.consultorio.vacio': 'Sin paciente en el consultorio',
  'pantalla.consultorio.entrando': 'Llamado, entrando al consultorio',
  'pantalla.consultorio.edad': '{edad} años',
  'pantalla.consultorio.sexo': 'Sexo {sexo}',
  'pantalla.consultorio.ticket': 'Ticket {ticket}',
  'pantalla.consultorio.motivo': 'Motivo de la consulta',
  'pantalla.consultorio.criticos': 'Datos críticos',
  'pantalla.consultorio.sinCriticos':
    'Aún no hay datos clínicos de este paciente: llegan con la historia clínica (Fase 6).',
  'pantalla.consultorio.espera': 'Desde {hora}',
  'pantalla.sala.count': 'En sala: {total}',

  // --- Fase 5: administración de pantallas ---------------------------------
  'pantallas.titulo': 'Pantallas de la clínica',
  'pantallas.descripcion':
    'Registra cada televisor o monitor, ajusta su voz y desactívalo cuando se retire.',
  'pantallas.nueva': 'Nueva pantalla',
  'pantallas.nuevaTitulo': 'Registrar una pantalla',
  'pantallas.nuevaTexto':
    'Se genera un token de dispositivo que se muestra una sola vez; con él se abre la pantalla en el equipo correspondiente.',
  'pantallas.nombre': 'Nombre de la pantalla',
  'pantallas.nombrePlaceholder': 'Por ejemplo: TV de la sala de espera',
  'pantallas.tipo': 'Tipo',
  'pantallas.tipo.lobby': 'Sala de espera',
  'pantallas.tipo.consultorio': 'Consultorio',
  'pantallas.crear': 'Registrar pantalla',
  'pantallas.creando': 'Registrando…',
  'pantallas.cargando': 'Cargando las pantallas…',
  'pantallas.errorCargar': 'No se pudieron cargar las pantallas.',
  'pantallas.vacio': 'Todavía no hay ninguna pantalla registrada.',
  'pantallas.columna.nombre': 'Pantalla',
  'pantallas.columna.tipo': 'Tipo',
  'pantallas.columna.estado': 'Estado',
  'pantallas.columna.visto': 'Última señal',
  'pantallas.columna.acciones': 'Acciones',
  'pantallas.activa': 'Activa',
  'pantallas.inactiva': 'Desactivada',
  'pantallas.nuncaVista': 'Nunca',
  'pantallas.conectadas': '{total} conectada(s) ahora',
  'pantallas.token.titulo': 'Token y enlace de la pantalla',
  'pantallas.token.texto':
    'Copia el enlace y ábrelo en el equipo de la pantalla. El token no se vuelve a mostrar; si se pierde, hay que registrar la pantalla otra vez.',
  'pantallas.token.enlace': 'Enlace de la pantalla',
  'pantallas.token.copiar': 'Copiar enlace',
  'pantallas.token.copiado': 'Enlace copiado al portapapeles.',
  'pantallas.token.copiarError': 'No se pudo copiar: selecciona el enlace y cópialo a mano.',
  'pantallas.token.abrir': 'Abrir la pantalla',
  'pantallas.ajustes': 'Ajustes de la pantalla',
  'pantallas.ajustes.voz': 'Llamar en voz alta',
  'pantallas.ajustes.volumen': 'Volumen',
  'pantallas.ajustes.resalte': 'Segundos en pantalla',
  'pantallas.ajustes.repetir': 'Repetir el llamado (segundos, 0 = no repetir)',
  'pantallas.ajustes.guardar': 'Guardar ajustes',
  'pantallas.ajustes.guardado': 'Ajustes guardados.',
  'pantallas.desactivar.titulo': 'Desactivar {pantalla}',
  'pantallas.desactivar.texto':
    'La pantalla deja de ver la sala y su token no sirve para nada más. Se puede registrar de nuevo cuando haga falta.',
  'pantallas.desactivar.confirmar': 'Desactivar',
  'pantallas.desactivada': 'Pantalla desactivada.',
  'pantallas.creada': 'Pantalla «{pantalla}» registrada.',
  'pantallas.errorCrear': 'No se pudo registrar la pantalla.',
  'pantallas.errorAccion': 'No se pudo completar la acción.',
  'pantallas.ayuda.titulo': 'Cómo se pone en marcha una pantalla',
  'pantallas.ayuda.texto':
    'Registra la pantalla aquí, abre el enlace en el equipo del televisor (una sola vez), ponlo a pantalla completa y listo: se reconecta solo si se reinicia.',
  'pantallas.riesgo.alto': 'Riesgo alto',
  'pantallas.riesgo.medio': 'Atención',
  'pantallas.riesgo.info': 'Nota',

  // --- Historia clínica (Fase 6, sesión A) --------------------------------
  'clinica.seccion.identificacion': 'Identificación',
  'clinica.seccion.identificacion.ayuda': 'Datos del paciente y de su representante.',
  'clinica.seccion.motivo_consulta': 'Motivo de consulta',
  'clinica.seccion.motivo_consulta.ayuda': 'Lo que cuenta el paciente, con sus propias palabras.',
  'clinica.seccion.anamnesis': 'Anamnesis y antecedentes médicos',
  'clinica.seccion.anamnesis.ayuda': 'Antecedentes de salud, medicamentos, cirugías y hábitos.',
  'clinica.seccion.antecedentes_odontologicos': 'Antecedentes odontológicos',
  'clinica.seccion.antecedentes_odontologicos.ayuda':
    'Tratamientos previos, reacciones adversas e higiene oral.',
  'clinica.seccion.examen_extraoral': 'Examen extraoral',
  'clinica.seccion.examen_extraoral.ayuda': 'Tejidos blandos, ganglios, ATM y musculatura.',
  'clinica.seccion.examen_intraoral': 'Examen intraoral',
  'clinica.seccion.examen_intraoral.ayuda': 'Tejidos blandos, encías, oclusión e higiene.',
  'clinica.seccion.examenes_complementarios': 'Exámenes complementarios',
  'clinica.seccion.examenes_complementarios.ayuda':
    'Radiografías, modelos, fotografías y análisis de laboratorio.',
  'clinica.seccion.diagnostico': 'Diagnóstico',
  'clinica.seccion.diagnostico.ayuda': 'Diagnóstico presuntivo y definitivo, general y por pieza.',
  'clinica.seccion.plan_tratamiento': 'Plan de tratamiento',
  'clinica.seccion.plan_tratamiento.ayuda':
    'Procedimientos por prioridad clínica, alternativas y aceptación del paciente.',
  'clinica.seccion.consentimiento': 'Consentimiento informado',
  'clinica.seccion.consentimiento.ayuda': 'Riesgos y alternativas que se informaron al paciente.',
  'clinica.seccion.evolucion': 'Evolución clínica',
  'clinica.seccion.evolucion.ayuda':
    'Resumen de la atención. Las sesiones clínicas se registran en la Fase 7.',

  'clinica.estado.borrador': 'Borrador',
  'clinica.estado.firmada': 'Firmada',

  'clinica.campo.ocupacion': 'Ocupación',
  'clinica.campo.responsableNombre': 'Nombre del representante',
  'clinica.campo.responsableParentesco': 'Parentesco del representante',
  'clinica.campo.responsableTelefono': 'Teléfono del representante',
  'clinica.campo.observaciones': 'Observaciones',
  'clinica.campo.relato': 'Relato del paciente',
  'clinica.campo.tiempoEvolucion': 'Tiempo de evolución',
  'clinica.campo.inicioSintomas': 'Inicio de los síntomas',
  'clinica.campo.sinAntecedentes': 'Sin antecedentes de interés (deja las casillas vacías)',
  'clinica.campo.frecuenciaVisitas': 'Frecuencia de visitas al odontólogo',
  'clinica.campo.ultimaConsulta': 'Fecha de la última consulta',
  'clinica.campo.higieneCepillado': 'Cepillado diario',
  'clinica.campo.usaHiloDental': 'Usa hilo dental',
  'clinica.campo.tratamientoEnCurso': 'Tratamiento en curso por otro profesional',
  'clinica.campo.tejidosBlandos': 'Tejidos blandos',
  'clinica.campo.ganglios': 'Ganglios linfáticos',
  'clinica.campo.atm': 'Articulación temporomandibular (ATM)',
  'clinica.campo.musculatura': 'Musculatura masticatoria',
  'clinica.campo.hallazgos': 'Hallazgos',
  'clinica.campo.encias': 'Encías',
  'clinica.campo.sondaje': 'Profundidad de sondaje',
  'clinica.campo.oclusion': 'Oclusión dental',
  'clinica.campo.higiene': 'Higiene oral',
  'clinica.campo.diagnosticoPrincipal': 'Diagnóstico principal',
  'clinica.campo.diagnosticosSecundarios': 'Diagnósticos secundarios',
  'clinica.campo.diagnosticoPorPieza': 'Diagnóstico por pieza',
  'clinica.campo.saludBucalGeneral': 'Estado de salud bucal general',
  'clinica.campo.procedimientos': 'Procedimientos propuestos',
  'clinica.campo.alternativas': 'Alternativas presentadas',
  'clinica.campo.aceptacionPaciente': 'El paciente aceptó el plan',
  'clinica.campo.riesgosInformados': 'Riesgos informados',
  'clinica.campo.alternativasInformadas': 'Alternativas informadas',
  'clinica.campo.resumen': 'Resumen de la evolución',

  'clinica.catalogo.otros.etiqueta': 'Especifica cuáles',
  'clinica.catalogo.otros.placeholder': 'Escríbelo aquí para que quede en la historia',
  'clinica.catalogo.otros': 'Otros',
  'clinica.catalogo.alergias.titulo': 'Alergias',
  'clinica.catalogo.alergias.penicilina': 'Penicilina',
  'clinica.catalogo.alergias.anestesicos_locales': 'Anestésicos locales',
  'clinica.catalogo.alergias.latex': 'Látex',
  'clinica.catalogo.alergias.metales': 'Metales',
  'clinica.catalogo.alergias.sulfas': 'Sulfas',
  'clinica.catalogo.alergias.aines': 'AINE (aspirina, ibuprofeno)',
  'clinica.catalogo.alergias.yodo': 'Yodo',
  'clinica.catalogo.alergias.otros': 'Otros',
  'clinica.catalogo.patologicos.titulo': 'Antecedentes personales patológicos',
  'clinica.catalogo.patologicos.diabetes': 'Diabetes',
  'clinica.catalogo.patologicos.hipertension': 'Hipertensión',
  'clinica.catalogo.patologicos.cardiopatia': 'Cardiopatía',
  'clinica.catalogo.patologicos.hepatitis': 'Hepatitis',
  'clinica.catalogo.patologicos.vih': 'VIH',
  'clinica.catalogo.patologicos.enfermedad_autoimmune': 'Enfermedad autoinmune',
  'clinica.catalogo.patologicos.asma': 'Asma',
  'clinica.catalogo.patologicos.epilepsia': 'Epilepsia',
  'clinica.catalogo.patologicos.cancer': 'Cáncer',
  'clinica.catalogo.patologicos.hipotiroidismo': 'Hipotiroidismo',
  'clinica.catalogo.patologicos.otros': 'Otros',
  'clinica.catalogo.medicamentos.titulo': 'Medicamentos actuales',
  'clinica.catalogo.medicamentos.anticoagulantes': 'Anticoagulantes',
  'clinica.catalogo.medicamentos.bifosfonatos': 'Bifosfonatos',
  'clinica.catalogo.medicamentos.antihipertensivos': 'Antihipertensivos',
  'clinica.catalogo.medicamentos.antidepresivos': 'Antidepresivos',
  'clinica.catalogo.medicamentos.antidiabeticos': 'Antidiabéticos',
  'clinica.catalogo.medicamentos.corticoides': 'Corticoides',
  'clinica.catalogo.medicamentos.anticonvulsivantes': 'Anticonvulsivantes',
  'clinica.catalogo.medicamentos.otros': 'Otros',
  'clinica.catalogo.cirugias.titulo': 'Cirugías y hospitalizaciones',
  'clinica.catalogo.cirugias.extraccion_dental': 'Extracción dental',
  'clinica.catalogo.cirugias.cirugia_maxilofacial': 'Cirugía maxilofacial',
  'clinica.catalogo.cirugias.amigdalectomia': 'Amigdalectomía',
  'clinica.catalogo.cirugias.apendicectomia': 'Apendicectomía',
  'clinica.catalogo.cirugias.cesarea': 'Cesárea',
  'clinica.catalogo.cirugias.protesis_articular': 'Prótesis articular',
  'clinica.catalogo.cirugias.otros': 'Otros',
  'clinica.catalogo.familiares.titulo': 'Antecedentes familiares',
  'clinica.catalogo.familiares.diabetes': 'Diabetes',
  'clinica.catalogo.familiares.hipertension': 'Hipertensión',
  'clinica.catalogo.familiares.cardiopatia': 'Cardiopatía',
  'clinica.catalogo.familiares.cancer': 'Cáncer',
  'clinica.catalogo.familiares.enfermedad_mental': 'Enfermedad mental',
  'clinica.catalogo.familiares.malformacion_dental': 'Malformación dental',
  'clinica.catalogo.familiares.otros': 'Otros',
  'clinica.catalogo.habitos.titulo': 'Hábitos',
  'clinica.catalogo.habitos.tabaquismo': 'Tabaquismo',
  'clinica.catalogo.habitos.alcohol': 'Consumo de alcohol',
  'clinica.catalogo.habitos.bruxismo': 'Bruxismo',
  'clinica.catalogo.habitos.onicofagia': 'Onicofagia',
  'clinica.catalogo.habitos.respiracion_bucal': 'Respiración bucal',
  'clinica.catalogo.habitos.masticacion_unilateral': 'Masticación unilateral',
  'clinica.catalogo.habitos.otros': 'Otros',
  'clinica.catalogo.odontologicos.titulo': 'Tratamientos dentales anteriores',
  'clinica.catalogo.odontologicos.endodoncia': 'Endodoncia',
  'clinica.catalogo.odontologicos.extraccion': 'Extracción',
  'clinica.catalogo.odontologicos.ortodoncia': 'Ortodoncia',
  'clinica.catalogo.odontologicos.protesis': 'Prótesis',
  'clinica.catalogo.odontologicos.implante': 'Implante',
  'clinica.catalogo.odontologicos.restauracion': 'Restauración',
  'clinica.catalogo.odontologicos.blanqueamiento': 'Blanqueamiento',
  'clinica.catalogo.odontologicos.otros': 'Otros',
  'clinica.catalogo.reacciones.titulo': 'Reacciones adversas',
  'clinica.catalogo.reacciones.anestesia_local': 'A la anestesia local',
  'clinica.catalogo.reacciones.materiales': 'A materiales odontológicos',
  'clinica.catalogo.reacciones.ninguna': 'Ninguna conocida',
  'clinica.catalogo.reacciones.otros': 'Otros',
  'clinica.catalogo.experiencias.titulo': 'Experiencias previas',
  'clinica.catalogo.experiencias.traumatica': 'Experiencia traumática',
  'clinica.catalogo.experiencias.ansiedad': 'Ansiedad en la consulta',
  'clinica.catalogo.experiencias.ninguna': 'Sin novedad',
  'clinica.catalogo.experiencias.otros': 'Otros',
  'clinica.catalogo.estudios.titulo': 'Estudios solicitados',
  'clinica.catalogo.estudios.radiografia_periapical': 'Radiografía periapical',
  'clinica.catalogo.estudios.radiografia_panoramica': 'Radiografía panorámica',
  'clinica.catalogo.estudios.aleta_mordida': 'Aleta de mordida',
  'clinica.catalogo.estudios.modelos_estudio': 'Modelos de estudio',
  'clinica.catalogo.estudios.fotografias_clinicas': 'Fotografías clínicas',
  'clinica.catalogo.estudios.analisis_laboratorio': 'Análisis de laboratorio',
  'clinica.catalogo.estudios.otros': 'Otros',

  'clinica.opcion.sinDato': 'Sin evaluar',
  'clinica.opcion.evaluacion.normal': 'Normal',
  'clinica.opcion.evaluacion.alterado': 'Alterado',
  'clinica.opcion.evaluacion.no_evaluado': 'No evaluado',
  'clinica.opcion.oclusion.normal': 'Normal',
  'clinica.opcion.oclusion.apinamiento': 'Apiñamiento',
  'clinica.opcion.oclusion.mordida_abierta': 'Mordida abierta',
  'clinica.opcion.oclusion.mordida_cruzada': 'Mordida cruzada',
  'clinica.opcion.oclusion.sobremordida': 'Sobremordida',
  'clinica.opcion.oclusion.sin_dato': 'Sin dato',
  'clinica.opcion.higiene.buena': 'Buena',
  'clinica.opcion.higiene.regular': 'Regular',
  'clinica.opcion.higiene.deficiente': 'Deficiente',
  'clinica.opcion.salud.buena': 'Buena',
  'clinica.opcion.salud.regular': 'Regular',
  'clinica.opcion.salud.deficiente': 'Deficiente',
  'clinica.opcion.salud.sin_dato': 'Sin dato',
  'clinica.opcion.frecuencia.primera_vez': 'Primera vez',
  'clinica.opcion.frecuencia.semestral': 'Cada seis meses',
  'clinica.opcion.frecuencia.anual': 'Una vez al año',
  'clinica.opcion.frecuencia.cuando_molesta': 'Solo cuando le molesta',
  'clinica.opcion.frecuencia.nunca': 'Nunca ha ido',
  'clinica.opcion.cepillado.una_vez': 'Una vez al día',
  'clinica.opcion.cepillado.dos_veces': 'Dos veces al día',
  'clinica.opcion.cepillado.tres_o_mas': 'Tres o más veces al día',
  'clinica.opcion.cepillado.esporadico': 'De forma esporádica',
  'clinica.opcion.prioridad.alta': 'Prioridad alta',
  'clinica.opcion.prioridad.media': 'Prioridad media',
  'clinica.opcion.prioridad.baja': 'Prioridad baja',

  'clinica.alerta.alergia_penicilina': 'Alergia a la penicilina',
  'clinica.alerta.alergia_anestesico': 'Alergia a los anestésicos locales',
  'clinica.alerta.alergia_latex': 'Alergia al látex',
  'clinica.alerta.anticoagulante': 'Toma anticoagulantes',
  'clinica.alerta.bifosfonato': 'Toma bifosfonatos',
  'clinica.alerta.diabetes': 'Diabetes',
  'clinica.alerta.hipertension': 'Hipertensión',
  'clinica.alerta.cardiopatia': 'Cardiopatía',
  'clinica.alerta.alergia_otro': 'Alergia declarada',
  'clinica.alerta.medicamento_otro': 'Medicamento',
  'clinica.alerta.patologico_otro': 'Antecedente',
  'clinica.alertas.titulo': 'Datos críticos',

  'clinica.plan.sinProcedimientos': 'Todavía no hay procedimientos en el plan.',
  'clinica.plan.descripcion': 'Procedimiento',
  'clinica.plan.prioridad': 'Prioridad',
  'clinica.plan.pieza': 'Pieza',
  'clinica.plan.presupuesto': 'Presupuesto',
  'clinica.plan.agregarProcedimiento': 'Agregar procedimiento',

  'clinica.form.titulo': 'Historia clínica',
  'clinica.form.paso': 'Paso {actual} de {total}',
  'clinica.form.completas': 'secciones con contenido',
  'clinica.form.secciones': 'Secciones de la historia',
  'clinica.form.bloqueada':
    'La historia está firmada y no se puede editar. Registra una adenda para corregirla.',
  'clinica.form.soloLectura': 'No tienes permiso para escribir la historia clínica.',
  'clinica.form.obligatoria': 'Sección obligatoria para firmar',
  'clinica.form.guardando': 'Guardando…',
  'clinica.form.guardado': 'Borrador guardado',
  'clinica.form.sinGuardar': 'Cambios sin guardar',
  'clinica.form.anterior': 'Anterior',
  'clinica.form.siguiente': 'Siguiente',
  'clinica.form.guardarBorrador': 'Guardar borrador',

  'clinica.error.guardar': 'No se pudo guardar la sección.',
  'clinica.error.titulo': 'No se pudo cargar la historia',
  'clinica.error.sinRegistro': 'Falta el identificador de la historia.',

  'clinica.consentimiento.titulo': 'Consentimiento informado',
  'clinica.consentimiento.texto':
    'Documento firmado por el paciente o su representante antes de cualquier procedimiento invasivo.',
  'clinica.consentimiento.registrar': 'Registrar consentimiento',
  'clinica.consentimiento.registrado': 'Actualizar consentimiento',
  'clinica.consentimiento.acepta': 'Nombre de quien acepta',
  'clinica.consentimiento.documento': 'Documento de quien acepta',
  'clinica.consentimiento.relacion': 'Relación con el paciente',
  'clinica.consentimiento.relacionAyuda': 'Por ejemplo: paciente, madre, representante.',
  'clinica.consentimiento.testigo': 'Testigo',
  'clinica.consentimiento.aceptadoPor': 'Consentimiento aceptado por {nombre} ({relacion}).',

  'clinica.adenda.titulo': 'Adendas',
  'clinica.adenda.texto':
    'La historia firmada no se edita: cada corrección queda fechada, con motivo y con su autor.',
  'clinica.adenda.registrar': 'Registrar adenda',
  'clinica.adenda.agregar': 'Agregar adenda',
  'clinica.adenda.seccion': 'Sección corregida',
  'clinica.adenda.seccionAyuda': 'Déjalo en «adenda general» si afecta a toda la historia.',
  'clinica.adenda.general': 'Adenda general',
  'clinica.adenda.motivo': 'Motivo',
  'clinica.adenda.motivoPlaceholder': 'Por qué se corrige',
  'clinica.adenda.contenido': 'Texto de la adenda',

  'clinica.firma.titulo': 'Firmar la historia clínica',
  'clinica.firma.texto':
    'Al firmar, la historia queda cerrada: después solo se admiten adendas con motivo.',
  'clinica.firma.firmar': 'Firmar historia',
  'clinica.firma.aviso': 'Revisa que todo esté correcto: la firma no se puede deshacer.',
  'clinica.firma.bloqueada': 'Todavía no se puede firmar. Falta:',

  'clinica.documento.titulo': 'Historia clínica odontológica',
  'clinica.documento.abierta': 'Abierta el {fecha}',
  'clinica.documento.firmada': 'Firmada el {fecha} por {usuario}',
  'clinica.documento.paciente': 'Paciente',
  'clinica.documento.edad': 'Edad',
  'clinica.documento.anios': 'años',
  'clinica.documento.pie':
    'Documento generado por OdontoCRM. Cada impresión queda registrada en la auditoría.',
  'clinica.documento.firmaPaciente': 'Firma del paciente o representante',
  'clinica.documento.firmaOdontologo': 'Firma y sello del odontólogo',

  'clinica.imprimir.titulo': 'Vista de impresión de la historia clínica',
  'clinica.imprimir.accion': 'Imprimir',

  'clinica.selector.titulo': 'Elegir paciente',
  'clinica.selector.texto':
    'Busca por nombre, documento o teléfono para abrir su historia clínica.',
  'clinica.selector.placeholder': 'Nombre, cédula o teléfono',
  'clinica.selector.vacio': 'Sin pacientes',
  'clinica.selector.vacioTexto': 'No hay pacientes que coincidan con la búsqueda.',
  'clinica.selector.abrir': 'Abrir historia',
  'clinica.selector.cambiar': 'Cambiar de paciente',

  'clinica.primeraVisita.titulo': 'Primera visita del paciente',
  'clinica.primeraVisita.texto': 'Primera visita del paciente, se debe llenar su historia clínica.',
  'clinica.primeraVisita.abrir': 'Abrir historia clínica',
  'clinica.primeraVisita.irHistoria': 'Llenar la historia clínica',

  'clinica.paciente.desconocido': 'Paciente',
  'clinica.paciente.sinFicha':
    'No se pudo leer la ficha del paciente; la historia se muestra igual.',
  'clinica.paciente.abierta': 'Historia abierta el {fecha}',

  'clinica.exito.abierta': 'Historia clínica abierta.',
  'clinica.exito.consentimiento': 'Consentimiento informado registrado.',
  'clinica.exito.firmada': 'Historia clínica firmada.',
  'clinica.exito.adenda': 'Adenda registrada.',

  // ── Fase 7A · sesión clínica: la evolución del paciente (Lead) ─────────────
  'clinica.sesion.pestana': 'Sesión clínica',
  'clinica.sesion.titulo': 'Sesión {numero}',
  'clinica.sesion.abierta': 'Abierta el {fecha}',
  'clinica.sesion.conCita': 'enlazada a la cita del día',
  'clinica.sesion.sinCita': 'sin cita (registro libre)',
  'clinica.sesion.enmendada': 'Corrige una sesión anterior: {motivo}',
  'clinica.sesion.estado.borrador': 'En borrador',
  'clinica.sesion.estado.cerrada': 'Cerrada',

  'clinica.sesion.abrir.titulo': 'Empezar la sesión de hoy',
  'clinica.sesion.abrir.texto':
    'La sesión guarda lo que se hace en la visita: signos vitales, examen, procedimientos, materiales, diagnóstico e indicaciones. Se guarda sola mientras se escribe.',
  'clinica.sesion.abrir.cita': 'Cita que respalda la sesión',
  'clinica.sesion.abrir.citaAyuda':
    'Al cerrar la sesión, esa cita se puede pasar a «atendida» sin pedir motivo.',
  'clinica.sesion.abrir.sinCita': 'Sin cita (el paciente vino sin cita)',
  'clinica.sesion.abrir.citaOpcion': 'Cita de las {hora} · {estado}',
  'clinica.sesion.abrir.accion': 'Abrir sesión',

  'clinica.sesion.vitales': 'Signos vitales',
  'clinica.sesion.vitales.ayuda': 'Deja en blanco lo que no se tomó: vacío es «sin dato».',
  'clinica.sesion.vital.taSistolica': 'Tensión sistólica',
  'clinica.sesion.vital.taDiastolica': 'Tensión diastólica',
  'clinica.sesion.vital.fc': 'Frecuencia cardíaca',
  'clinica.sesion.vital.temperatura': 'Temperatura',
  'clinica.sesion.vital.spo2': 'Saturación de oxígeno',
  'clinica.sesion.vital.peso': 'Peso',

  'clinica.sesion.examen': 'Examen del día (intraoral y periodontal)',
  'clinica.sesion.sinDato': 'Sin dato',
  'clinica.sesion.campo.tejidosBlandos': 'Tejidos blandos',
  'clinica.sesion.campo.encias': 'Encías',
  'clinica.sesion.campo.oclusion': 'Oclusión',
  'clinica.sesion.campo.higiene': 'Higiene oral',
  'clinica.sesion.campo.sondaje': 'Sondaje periodontal',
  'clinica.sesion.campo.sondajePlaceholder': '16: 3 mm, 26: 5 mm',
  'clinica.sesion.campo.hallazgos': 'Hallazgos del examen',

  'clinica.sesion.procedimientos': 'Procedimientos realizados',
  'clinica.sesion.procedimientos.ayuda':
    'Del catálogo, con la pieza y las caras cuando correspondan: es lo que después cuenta en los reportes.',
  'clinica.sesion.procedimiento': 'Procedimiento',
  'clinica.sesion.pieza': 'Pieza (FDI)',
  'clinica.sesion.notasProcedimiento': 'Nota del procedimiento',
  'clinica.sesion.quitarProcedimiento': 'Quitar procedimiento',
  'clinica.sesion.agregarProcedimiento': 'Agregar procedimiento',
  'clinica.sesion.detalle': '¿Cuál?',
  'clinica.sesion.detallePlaceholder': 'Descríbelo tal como se hizo',
  'clinica.sesion.caras': 'Caras tratadas',
  'clinica.sesion.caras.ayuda':
    'Sin caras marcadas el procedimiento se guarda sobre la pieza completa.',
  'clinica.sesion.caras.elegidas': 'Caras marcadas: {total}',

  'clinica.sesion.materiales': 'Materiales e insumos',
  'clinica.sesion.material': 'Material',
  'clinica.sesion.cantidad': 'Cantidad',
  'clinica.sesion.cantidadPlaceholder': '1 cartucho',
  'clinica.sesion.quitarMaterial': 'Quitar material',
  'clinica.sesion.agregarMaterial': 'Agregar material',

  'clinica.sesion.campo.motivo': 'Motivo de la visita',
  'clinica.sesion.campo.motivoPlaceholder': 'Qué trae hoy al paciente',
  'clinica.sesion.campo.anamnesis': 'Anamnesis breve y cambios relevantes',
  'clinica.sesion.campo.diagnostico': 'Diagnóstico de la sesión',
  'clinica.sesion.campo.indicaciones': 'Indicaciones postoperatorias',
  'clinica.sesion.campo.proximaCitaFecha': 'Próxima cita sugerida',
  'clinica.sesion.campo.proximaCitaNota': 'Para qué la próxima cita',
  'clinica.sesion.campo.notasInternas': 'Notas internas (no se imprimen)',

  'clinica.sesion.guardado.limpio': 'Sin cambios',
  'clinica.sesion.guardado.pendiente': 'Sin guardar…',
  'clinica.sesion.guardado.guardando': 'Guardando…',
  'clinica.sesion.guardado.hecho': 'Guardado a las {hora}',
  'clinica.sesion.guardado.error': 'No se pudo guardar',
  'clinica.sesion.resumen': 'Lo registrado',
  'clinica.sesion.irOdontograma': 'Marcar en el odontograma',

  'clinica.sesion.cerrar.accion': 'Cerrar sesión',
  'clinica.sesion.cerrar.faltaContenido':
    'Para cerrar la sesión escribe al menos el motivo, un procedimiento o el diagnóstico.',
  'clinica.sesion.cerrar.titulo': 'Cerrar la sesión',
  'clinica.sesion.cerrar.texto': 'La sesión cerrada queda como documento del día.',
  'clinica.sesion.cerrar.aviso':
    'Una sesión cerrada no se puede editar: si hay que corregirla, se abre una sesión enmendada con su motivo y la original se conserva.',
  'clinica.sesion.cerrar.nota': 'Nota de cierre (opcional)',
  'clinica.sesion.cerrar.notaAyuda': 'Cómo salió el paciente o qué quedó pendiente.',
  'clinica.sesion.cerrar.confirmar': 'Cerrar la sesión',

  'clinica.sesion.corregir': 'Corregir',
  'clinica.sesion.corregir.titulo': 'Corregir la sesión {numero}',
  'clinica.sesion.corregir.texto': 'Se abre una sesión nueva en borrador con lo que tenía.',
  'clinica.sesion.corregir.aviso':
    'La sesión original se conserva tal como quedó: la corrección es una sesión nueva enlazada a ella.',
  'clinica.sesion.corregir.motivo': 'Por qué se corrige',
  'clinica.sesion.corregir.motivoAyuda': 'Queda en la auditoría y en la sesión nueva.',
  'clinica.sesion.corregir.motivoCorto': 'Escribe el motivo de la corrección',
  'clinica.sesion.corregir.confirmar': 'Abrir sesión corregida',

  'clinica.sesion.historial': 'Evolución del paciente',
  'clinica.sesion.historialTexto': 'Lo que se hizo en cada visita, de la última a la primera.',
  'clinica.sesion.sinSesiones': 'Sin sesiones',
  'clinica.sesion.sinSesionesTexto':
    'Todavía no hay visitas registradas: la primera sesión se abre desde aquí.',

  'clinica.sesion.atender.titulo': 'La cita se puede cerrar como atendida',
  'clinica.sesion.atender.texto':
    'La cita de las {hora} tiene su sesión clínica cerrada: marcar «atendida» ya no pide motivo.',
  'clinica.sesion.marcarAtendida': 'Marcar la cita como atendida',

  'clinica.sesion.exito.abierta': 'Sesión clínica abierta.',
  'clinica.sesion.exito.cerrada': 'Sesión clínica cerrada.',
  'clinica.sesion.exito.enmendada': 'Sesión corregida: tienes el borrador abierto.',
  'clinica.sesion.exito.atendida': 'Cita marcada como atendida.',

  // ── Fase 7B · adjuntos de la sesión, récipes A5 y verificación (Lead) ──────
  'clinica.adjunto.titulo': 'Radiografías, fotos y documentos',
  'clinica.adjunto.texto':
    'Lo que se sube aquí queda en la sesión y, si se indica, en su pieza: es la imagen de lo que se vio hoy.',
  'clinica.adjunto.vacio': 'Todavía no hay adjuntos en esta sesión.',
  'clinica.adjunto.subir': 'Subir un archivo',
  'clinica.adjunto.archivo': 'Archivo',
  'clinica.adjunto.tipo': 'Tipo',
  'clinica.adjunto.piezaLabel': 'Pieza (FDI)',
  'clinica.adjunto.piezaAyuda': 'Si la imagen es de una pieza concreta.',
  'clinica.adjunto.pieza': 'pieza {pieza}',
  'clinica.adjunto.leyenda': 'Pie de foto',
  'clinica.adjunto.leyendaPlaceholder': 'Periapical de la 26',
  'clinica.adjunto.subirAccion': 'Subir a la sesión',
  'clinica.adjunto.quitar': 'Quitar',
  'clinica.adjunto.abrir': 'Abrir {nombre}',
  'clinica.adjunto.acercar': 'Acercar',
  'clinica.adjunto.alejar': 'Alejar',
  'clinica.adjunto.error': 'No se pudo abrir el adjunto.',
  'clinica.adjunto.muyGrande': 'El archivo supera los 20 MB.',
  'clinica.adjunto.tipoNoValido': 'Solo se admiten JPG, PNG, WEBP o PDF.',
  'clinica.adjunto.sesionCerrada':
    'La sesión está cerrada: sus adjuntos son parte del documento y no se quitan.',
  'clinica.adjunto.exito.subido': 'Adjunto guardado en la sesión.',
  'clinica.adjunto.exito.quitado': 'Adjunto quitado.',
  'clinica.adjunto.paciente.titulo': 'Radiografías y fotos de las sesiones',
  'clinica.adjunto.paciente.texto':
    'Lo que se subió en cada visita, con su pieza cuando se indicó. Se abre pulsando la imagen.',
  'clinica.adjunto.paciente.vacio':
    'Todavía no hay radiografías ni fotos: se suben desde la sesión en la que se toman.',

  'clinica.recipe.titulo': 'Récipe de {paciente}',
  'clinica.recipe.texto':
    'Del catálogo o escrito a mano. Al emitirlo se numera, se archiva el PDF A5 y queda un código para verificarlo.',
  'clinica.recipe.buscar': 'Buscar en el catálogo',
  'clinica.recipe.buscarAyuda':
    'Escribe dos letras: al elegir uno se traen presentación, dosis y frecuencia habituales (editables).',
  'clinica.recipe.buscarPlaceholder': 'Amoxicilina…',
  'clinica.recipe.medicamento': 'Medicamento',
  'clinica.recipe.presentacion': 'Presentación',
  'clinica.recipe.via': 'Vía',
  'clinica.recipe.sinVia': 'Sin especificar',
  'clinica.recipe.cantidad': 'Cantidad',
  'clinica.recipe.dosis': 'Dosis',
  'clinica.recipe.frecuencia': 'Frecuencia',
  'clinica.recipe.duracion': 'Duración',
  'clinica.recipe.indicaciones': 'Indicaciones del medicamento',
  'clinica.recipe.quitar': 'Quitar medicamento',
  'clinica.recipe.agregar': 'Agregar medicamento',
  'clinica.recipe.generales': 'Indicaciones generales',
  'clinica.recipe.generalesAyuda': 'Lo que se le dice al paciente al entregarle el récipe.',
  'clinica.recipe.guardarBorrador': 'Guardar borrador',
  'clinica.recipe.emitir': 'Emitir récipe',
  'clinica.recipe.descargar': 'Descargar PDF',
  'clinica.recipe.imprimir': 'Imprimir',
  'clinica.recipe.anular': 'Anular',
  'clinica.recipe.motivoAnulacion': 'Por qué se anula',
  'clinica.recipe.motivoAnulacionPlaceholder': 'Salió con la dosis equivocada',
  'clinica.recipe.confirmarAnulacion': 'Anular el récipe',
  'clinica.recipe.anularTitulo': 'Anular el récipe {numero}',
  'clinica.recipe.membrete.titulo': 'Al membrete le falta información',
  'clinica.recipe.membrete.texto':
    'El récipe va a salir sin: {campos}. Se completan en packages/contracts/src/clinic.ts (sección editable del consultorio).',
  'clinica.recipe.emitido.titulo': 'Récipe emitido y archivado',
  'clinica.recipe.emitido.texto': 'N.º {numero}, emitido el {fecha}.',
  'clinica.recipe.emitido.codigo': 'Código de verificación: {codigo}',
  'clinica.recipe.emitido.impresiones': '{veces} impresión(es)',
  'clinica.recipe.anulado.titulo': 'El récipe anterior está anulado',
  'clinica.recipe.anulado.texto': 'N.º {numero}: {motivo}',
  'clinica.recipe.reimpresion':
    'Cada descarga o impresión queda registrada con su autor y su hora.',
  'clinica.recipe.lista.titulo': 'Récipes',
  'clinica.recipe.lista.texto': 'Lo recetado en esta sesión, con su PDF archivado.',
  'clinica.recipe.lista.nuevo': 'Preparar récipe',
  'clinica.recipe.lista.vacio': 'Todavía no hay récipes emitidos.',
  'clinica.recipe.lista.medicamentos': '{total} medicamento(s)',
  'clinica.recipe.lista.impresiones': '{veces} impresión(es)',
  'clinica.recipe.exito.guardado': 'Borrador del récipe guardado.',
  'clinica.recipe.exito.emitido': 'Récipe emitido: el PDF A5 quedó archivado.',
  'clinica.recipe.exito.anulado': 'Récipe anulado con su motivo.',

  'clinica.sesion.cerrar.preguntaRecipe': '¿Desea guardar el récipe?',
  'clinica.sesion.cerrar.preguntaRecipeAyuda':
    'Al cerrar la sesión se abre el récipe para prepararlo y emitirlo.',

  'verificar.subtitulo': 'Verificación de récipes',
  'verificar.titulo': '¿Este récipe es auténtico?',
  'verificar.texto':
    'Comprobación del código que lleva impreso el récipe. No se muestran datos clínicos.',
  'verificar.comprobando': 'Comprobando el código…',
  'verificar.valido': 'Récipe auténtico: consta en el sistema del consultorio.',
  'verificar.codigo': 'Código',
  'verificar.paciente': 'Paciente',
  'verificar.fecha': 'Emitido el',
  'verificar.odontologo': 'Odontólogo',
  'verificar.medicamentos': 'Medicamentos',
  'verificar.sinDato': 'Sin dato',
  'verificar.vigente': 'Vigente',
  'verificar.anulado': 'Anulado',
  'verificar.anuladoTexto':
    'Este récipe fue anulado por el consultorio: no debe usarse para dispensar medicamentos.',
  'verificar.noConsta': 'Este récipe no consta',
  'verificar.noConstaTexto':
    'El código {codigo} no corresponde a ningún récipe emitido por este consultorio. Si te lo entregaron en papel, avisa al consultorio.',
  'verificar.privacidad':
    'Esta página solo confirma la autenticidad del documento: no muestra el diagnóstico ni los medicamentos.',
  // ── Fase 6B · odontograma: pestaña, impresión A4 y accesos (Lead) ──────────
  'odonto.pestana.historia': 'Historia clínica',
  'odonto.pestana.odontograma': 'Odontograma',
  'odonto.titulo': 'Odontograma',
  'odonto.descripcion':
    'Estado de cada pieza en nomenclatura FDI: la pieza sin hallazgo está sana.',
  'odonto.imprimir.titulo': 'Impresión del odontograma',
  'odonto.imprimir.accion': 'Imprimir odontograma',
  'odonto.imprimir.documento': 'Odontograma',
  'odonto.imprimir.pie': 'Documento generado por OdontoCRM',
  'odonto.imprimir.impreso': 'Impreso el {fecha} por {usuario}',
  'odonto.imprimir.veces': 'Impresiones: {veces}',
  'odonto.historial.titulo': 'Evolución del odontograma',
  'odonto.historial.accion': 'Ver evolución',
  'odonto.hallazgos.titulo': 'Hallazgos registrados',
  'odonto.hallazgos.pieza': 'Pieza',
  'odonto.hallazgos.cara': 'Cara',
  'odonto.hallazgos.condicion': 'Condición',
  'odonto.hallazgos.estado': 'Estado',
  'odonto.hallazgos.piezaCompleta': 'Pieza completa',
  'odonto.hallazgos.notas': 'Notas',
  /** Celda vacía en el informe: se escribe que se miró, no se deja en blanco. */
  'odonto.hallazgos.sinNotas': 'Sin observaciones',
  /**
   * Notas del pie del informe: que se ve arriba no es todo lo que hay. La corona
   * cubre el muneon (el dato sigue en la historia) y la pieza ausente deja las caras
   * sin efecto.
   */
  'odonto.imprimir.notaAusente':
    'En las piezas marcadas como ausentes, las caras que hubiera quedan sin efecto.',
  /**
   * Historial de cambios en el informe (casilla de la vista de impresión): la
   * evolución del odontograma con fechas, quién y qué cambió.
   */
  'odonto.imprimir.conHistorial': 'Incluir el historial de cambios (con fechas)',
  'odonto.imprimir.historial.titulo': 'Historial de cambios del odontograma',
  'odonto.imprimir.historial.cargando': 'Cargando el historial…',
  'odonto.imprimir.historial.rango':
    'Del {desde} al {hasta} · {total} cambios, del más antiguo al más reciente',
  'odonto.imprimir.historial.recortado':
    'se muestran los {tope} más recientes; el historial completo está en la evolución',
  'odonto.imprimir.historial.fecha': 'Fecha',
  'odonto.imprimir.historial.cambio': 'Cambio',
  'odonto.imprimir.historial.quien': 'Quién y por qué',
  'odonto.imprimir.notaCorona':
    'En las piezas con corona, las caras que había debajo quedan cubiertas por la corona: el dato se conserva en la historia clínica.',
  'odonto.hallazgos.ninguno':
    'Todavía no hay hallazgos: la boca se lee como sana (captura por excepción).',
  'odonto.afectadas': 'Piezas afectadas: {total}',
  'odonto.pendientes': 'Pendientes: {total}',
  'odonto.completadas': 'Completadas: {total}',
  'odonto.error.titulo': 'No se pudo cargar el odontograma',
  'odonto.error.sinPaciente': 'Falta el paciente del odontograma.',
  'odonto.paciente.desconocido': 'Paciente',
  'odonto.paciente.sinFicha':
    'No se pudo leer la ficha del paciente; el odontograma se muestra igual.',
  'odonto.volver': 'Volver al odontograma',
  // ── Fase 6B · evolución del odontograma ───────────────────────────────────
  // El título y el botón de vuelta de la vista histórica (`odonto.historial.*` y
  // `odonto.volver`) ya están en el bloque del odontograma de arriba.
  'odontograma.historial.descripcion':
    'Todo lo que ha cambiado en el odontograma, de lo más reciente a lo más antiguo.',
  'odontograma.historial.cardTitulo': 'Cambios registrados',
  'odontograma.historial.cardTexto':
    'Cada fila es un cambio del histórico: no se edita, se consulta.',
  'odontograma.historial.cargando': 'Cargando la evolución del odontograma…',
  'odontograma.historial.total': 'Cambios: {total}',
  'odontograma.historial.timeline': 'Línea de tiempo de los cambios',
  'odontograma.historial.vacio': 'Todavía no hay cambios en el odontograma',
  'odontograma.historial.vacioTexto':
    'Cuando se registre un hallazgo aparecerá aquí, con la fecha, el cambio y quién lo hizo.',
  'odontograma.historial.filtroVacio': 'Ningún cambio coincide con los filtros',
  'odontograma.historial.filtroVacioTexto': 'Prueba con otra pieza o con otro tipo de cambio.',
  'odontograma.historial.limpiarFiltros': 'Limpiar filtros',
  'odontograma.historial.filtro.pieza': 'Pieza (FDI)',
  'odontograma.historial.filtro.piezaAyuda': 'Del 11 al 48 o del 51 al 85.',
  'odontograma.historial.filtro.piezaEjemplo': '16',
  'odontograma.historial.filtro.piezaInvalida': 'Número de pieza FDI inválido (11–48 o 51–85)',
  'odontograma.historial.filtro.evento': 'Tipo de cambio',
  'odontograma.historial.filtro.todos': 'Todos',
  'odontograma.historial.piezaFdi': 'Pieza {numero}',
  'odontograma.historial.piezaCompleta': 'Pieza completa',
  'odontograma.historial.autorDesconocido': 'Usuario no disponible',
  'odontograma.historial.motivo': 'Motivo',
  'odontograma.historial.sesion': 'Sesión {sesion}',
  'odontograma.historial.pacienteRequerido': 'Falta el paciente en la dirección de la página.',
  'odontograma.historial.sinPermiso': 'No tienes permiso para consultar el odontograma',
  'odontograma.historial.sinPermisoTexto':
    'Pide al administrador el permiso «Consultar el odontograma» para ver la evolución.',
  'odontograma.historial.sinOdontograma.titulo': 'El paciente todavía no tiene odontograma',
  'odontograma.historial.sinOdontograma.texto':
    'Cuando el odontólogo registre el primer hallazgo, aquí aparecerá su evolución.',
  'odontograma.historial.evento.registrado': 'Registrado',
  'odontograma.historial.evento.actualizado': 'Actualizado',
  'odontograma.historial.evento.eliminado': 'Eliminado',
  'odontograma.historial.evento.superado': 'Superado',
  // ── Fase 6B · odontograma (gráfico y carga rápida) ─────────────────────────
  'odonto.soloLectura': 'Solo lectura: necesitas permiso para modificar el odontograma.',
  'odonto.actualizado': 'Actualizado el {fecha}',
  'odonto.ultimaImpresion': 'Última impresión: {fecha}',
  'odonto.denticion.permanente': 'Dentición permanente',
  'odonto.denticion.temporal': 'Dentición temporal',

  // La boca sin odontograma no es un error: el patrón por excepción la lee sana.
  'odonto.sana.titulo': 'Boca sana por defecto',
  'odonto.sana.texto':
    'Este paciente todavía no tiene ningún hallazgo. En la captura por excepción la pieza sana no se guarda: no se creará nada hasta el primer hallazgo.',
  'odonto.sana.empezar': 'Empezar a registrar',

  'odonto.leyenda.titulo': 'Leyenda',
  'odonto.leyenda.pendiente': 'pendiente (rojo)',
  'odonto.leyenda.completado': 'completado (azul)',
  'odonto.leyenda.sano': 'Sano (sin hallazgo)',
  /**
   * El color no decora: dice en qué punto está el tratamiento. Rojo = hallazgo activo
   * o tratamiento indicado/pendiente; azul = preexistente o ya realizado.
   */
  'odonto.leyenda.rojo': 'Rojo: caries, obturación o tratamiento indicado (por hacer)',
  'odonto.leyenda.azul': 'Azul: tratamiento ya realizado o completado',
  /** Un mismo símbolo significa «indicado» o «realizado» según su color. */
  'odonto.leyenda.tratamiento': '{condicion}: rojo indicado · azul realizado',
  'odonto.leyenda.caras':
    'Las caras se leen de fuera hacia dentro: vestibular arriba (abajo en la mandíbula), lingual o palatino enfrente, y proximales a los lados (mesial hacia la línea media). En incisivos y caninos la cara de masticación es el borde incisal. La corona cubre lo que había debajo —el dato queda en la historia— y el conducto, el implante y la extracción indicada conviven con las caras; «ausente» las deja sin efecto, salvo con un implante, que puede sostener la pieza.',
  'odonto.arcada.superior': 'Arcada superior (18–28)',
  'odonto.arcada.inferior': 'Arcada inferior (48–38)',
  /**
   * Orientación de las caras, que es la duda clásica al leer un odontograma: en el
   * maxilar la cara externa (vestibular) mira hacia arriba y la interna es el
   * palatino; en la mandíbula se invierte, así que arriba queda el lingual.
   */
  'odonto.arcada.superior.orientacion':
    'Maxilar · vestibular arriba · palatino abajo · mesial hacia la línea media',
  'odonto.arcada.inferior.orientacion':
    'Mandíbula · lingual arriba · vestibular abajo · mesial hacia la línea media',

  // Texto accesible de una pieza: «Pieza 16, caries oclusal pendiente».
  'odonto.pieza.sana': 'Pieza {pieza} sana',
  'odonto.pieza.hallazgos': 'Pieza {pieza}, {hallazgos}',
  'odonto.pieza.condicionCara': '{condicion} {cara}',
  'odonto.pieza.condicionEntera': '{condicion} (pieza completa)',
  'odonto.pieza.hallazgoEstado': '{detalle} {estado}',

  // Carga rápida por teclado.
  'odonto.rapida.titulo': 'Carga rápida por teclado',
  'odonto.rapida.ayuda':
    'Pulsa una pieza (o escribe su número) y marca el hallazgo con una tecla: la minúscula queda pendiente y la MAYÚSCULA, completado.',
  'odonto.rapida.placeholder': 'Haz clic aquí o en una pieza y escribe su número (p. ej. 16)',
  'odonto.rapida.condiciones': 'Condición',
  'odonto.rapida.caras': 'Caras de la pieza activa',
  /** La misma tecla para la cara de masticación: oclusal en posteriores, incisal delante. */
  'odonto.rapida.caraMasticacion': 'Oclusal · Incisal',
  'odonto.rapida.pendiente': 'minúscula = pendiente',
  'odonto.rapida.completado': 'MAYÚSCULA = completado',
  'odonto.rapida.sinCaras':
    'Sin caras marcadas: la caries o la obturación van a la cara de masticación (oclusal; en incisivos y caninos, el borde incisal).',
  'odonto.rapida.piezaSana': 'La pieza {pieza} está sana.',
  'odonto.rapida.piezaTiene': 'La pieza {pieza} tiene: {detalle}.',
  'odonto.rapida.suprimir': 'borra la cara marcada o, si no hay ninguna, la de masticación',
  'odonto.rapida.soltar': 'suelta la pieza',
  'odonto.rapida.salir': 'cancela la carga rápida',

  // Deshacer: el panel guarda la pieza entera antes de cada cambio.
  'odonto.accion.hallazgo': '{detalle} en la pieza {pieza}',
  'odonto.accion.borrado': 'el borrado de {detalle} en la pieza {pieza}',
  'odonto.accion.limpieza': 'la limpieza de la cara {cara} de la pieza {pieza}',
  'odonto.deshacer.accion': 'Deshacer',
  'odonto.deshacer.ultima': 'Deshacer: {accion}',
  'odonto.exito.cambiado': 'Cambio aplicado: {accion}.',
  'odonto.exito.deshacer': 'Se deshizo el último cambio de la pieza {pieza}.',

  'odonto.aviso.sinCambios': 'Sin cambios: la pieza {pieza} ya estaba así.',
  'odonto.aviso.carasSuperadas.titulo': 'Caras superadas por la pieza completa',
  'odonto.aviso.carasSuperadas':
    'Las caras marcadas de la pieza {pieza} se dieron por superadas por «{condicion}»: {caras}.',

  // ── Fase 6B · hoja táctil de la pieza (botones grandes) ────────────────────
  'odonto.sheet.titulo': 'Pieza {pieza}',
  'odonto.sheet.cuenta': '{total} hallazgo(s)',
  'odonto.sheet.actuales': 'Lo que tiene ahora',
  'odonto.sheet.sana':
    'Nada registrado: en este odontograma la pieza sana es la que no tiene filas.',
  'odonto.sheet.quitar': 'Quitar',
  'odonto.sheet.quitarAria': 'Quitar {detalle} de esta pieza',
  'odonto.sheet.editar': 'Editar',
  'odonto.sheet.editarAria': 'Editar el estado y las notas de {detalle}',
  'odonto.sheet.editado': 'Corregido: {detalle}.',
  'odonto.sheet.notas': 'Notas del hallazgo',
  'odonto.sheet.notasPlaceholder': 'Observación clínica (opcional)',
  'odonto.sheet.notasAyuda':
    'Lo que escribas aquí acompaña a lo que marques ahora y sale en la columna NOTAS del informe. Después se puede corregir con el lápiz.',
  'odonto.sheet.guardar': 'Guardar',
  'odonto.sheet.marcarCompletado': 'Marcar completado',
  'odonto.sheet.marcarPendiente': 'Marcar pendiente',
  'odonto.sheet.caras': 'Caras',
  'odonto.sheet.carasAyuda':
    'Marca una o varias caras y elige la condición: se guardan todas de una vez. Sin ninguna marcada, la caries o la obturación van a la cara de masticación (oclusal; en incisivos y caninos, el borde incisal).',
  'odonto.sheet.estado': 'Estado',
  'odonto.sheet.condicion': 'Condición',
  'odonto.sheet.invalida': 'Esa pieza no admite el cambio.',
  'odonto.sheet.choca': 'No se puede: la pieza ya tiene «{condicion}» y no convive con «{nueva}».',
  'odonto.sheet.abrir': 'Marcar con botones',
  'odonto.activa.ninguna': 'Ninguna pieza elegida: pulsa una en el diagrama.',
  'odonto.activa.pieza': 'Pieza {pieza} elegida.',
  'odonto.tactil.ayuda':
    'Toca una pieza para marcarla con botones grandes. También puedes usar el teclado.',
  'odonto.tactil.raton':
    'Pulsa una cara para marcarla, o el número de la pieza para elegirla y teclear.',
  'odonto.aviso.piezaEntera':
    '«{condicion}» es un tratamiento de la pieza completa: no supera las caras, que se quedan como estaban.',
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
  'patients:delete': t('permiso.patients:delete'),
  'scheduling:read': t('permiso.scheduling:read'),
  'scheduling:write': t('permiso.scheduling:write'),
  'scheduling:notify': t('permiso.scheduling:notify'),
  'scheduling:overbook': t('permiso.scheduling:overbook'),
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
  medical_record_created: t('auditoria.medical_record_created'),
  medical_record_updated: t('auditoria.medical_record_updated'),
  medical_record_signed: t('auditoria.medical_record_signed'),
  medical_record_amended: t('auditoria.medical_record_amended'),
  medical_record_printed: t('auditoria.medical_record_printed'),
  medical_record_consent_accepted: t('auditoria.medical_record_consent_accepted'),
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

/** Etiquetas de los catálogos del paciente (Fase 2). */
export const DOC_TYPE_LABELS: Readonly<Record<DocType, string>> = {
  V: t('pacientes.doc.tipoV'),
  E: t('pacientes.doc.tipoE'),
  P: t('pacientes.doc.tipoP'),
  SC: t('pacientes.doc.tipoSC'),
};

export const SEX_LABELS: Readonly<Record<Sex, string>> = {
  M: t('pacientes.sexo.M'),
  F: t('pacientes.sexo.F'),
  O: t('pacientes.sexo.O'),
};

export const PATIENT_STATUS_LABELS: Readonly<Record<PatientStatus, string>> = {
  en_espera_cita: t('pacientes.estado.en_espera_cita'),
  activo: t('pacientes.estado.activo'),
  inactivo: t('pacientes.estado.inactivo'),
};

export const PATIENT_FILE_KIND_LABELS: Readonly<Record<PatientFileKind, string>> = {
  radiografia: t('pacientes.adjuntos.tipo.radiografia'),
  foto: t('pacientes.adjuntos.tipo.foto'),
  pdf: t('pacientes.adjuntos.tipo.pdf'),
  consentimiento: t('pacientes.adjuntos.tipo.consentimiento'),
  laboratorio: t('pacientes.adjuntos.tipo.laboratorio'),
  otro: t('pacientes.adjuntos.tipo.otro'),
};

/** Etiqueta de un campo del paciente; el índice incluye los que no son sensibles. */
export const PATIENT_FIELD_LABELS: Readonly<Record<string, string>> = {
  docNumber: t('pacientes.campo.docNumber'),
  docType: t('pacientes.campo.docType'),
  fullName: t('pacientes.campo.fullName'),
  birthDate: t('pacientes.campo.birthDate'),
  sex: t('pacientes.campo.sex'),
  phone: t('pacientes.campo.phone'),
  phoneAlt: t('pacientes.campo.phoneAlt'),
  email: t('pacientes.campo.email'),
  address: t('pacientes.campo.address'),
  occupation: t('pacientes.campo.occupation'),
  notes: t('pacientes.campo.notes'),
  status: t('pacientes.campo.status'),
  guardian: t('pacientes.campo.guardian'),
};

/** Etiquetas de la agenda (Fase 3). */
export const APPOINTMENT_STATUS_LABELS: Readonly<Record<AppointmentStatus, string>> = {
  en_espera_cita: t('programacion.estado.en_espera_cita'),
  programada: t('programacion.estado.programada'),
  notificada: t('programacion.estado.notificada'),
  en_sala_espera: t('programacion.estado.en_sala_espera'),
  llamado: t('programacion.estado.llamado'),
  en_consulta: t('programacion.estado.en_consulta'),
  atendido: t('programacion.estado.atendido'),
  no_asistio: t('programacion.estado.no_asistio'),
  cancelada: t('programacion.estado.cancelada'),
  reprogramada: t('programacion.estado.reprogramada'),
};

export const CHANNEL_LABELS: Readonly<Record<Channel, string>> = {
  telegram: t('programacion.canal.telegram'),
  whatsapp: t('programacion.canal.whatsapp'),
  registro: t('programacion.canal.registro'),
  telefono: t('programacion.canal.telefono'),
  presencial: t('programacion.canal.presencial'),
};

export const CAPACITY_SOURCE_LABELS: Readonly<Record<CapacitySource, string>> = {
  explicito: t('programacion.cupo.fuente.explicito'),
  plantilla: t('programacion.cupo.fuente.plantilla'),
  defecto: t('programacion.cupo.fuente.defecto'),
};

export const SLOT_STATE_LABELS: Readonly<Record<SlotState, string>> = {
  libre: t('programacion.franja.libre'),
  ocupada: t('programacion.franja.ocupada'),
  fuera_de_jornada: t('programacion.franja.fuera_de_jornada'),
};

export const SLOT_KIND_LABELS: Readonly<Record<SlotKind, string>> = {
  franja: t('programacion.franja.tipo.franja'),
  manual: t('programacion.franja.tipo.manual'),
};

/* ── Notificaciones (Fase 4) ───────────────────────────────────────────────── */

/** Estado de un envío del bot. */
export const NOTIFICATION_STATUS_LABELS: Readonly<Record<NotificationStatus, string>> = {
  queued: t('notificaciones.estado.queued'),
  sending: t('notificaciones.estado.sending'),
  sent: t('notificaciones.estado.sent'),
  failed: t('notificaciones.estado.failed'),
  skipped_no_channel: t('notificaciones.estado.skipped_no_channel'),
};

/** Variante de `Badge` por estado del envío. */
export const NOTIFICATION_STATUS_VARIANTS: Readonly<
  Record<NotificationStatus, 'neutral' | 'primary' | 'success' | 'warning' | 'danger' | 'info'>
> = {
  queued: 'neutral',
  sending: 'primary',
  sent: 'success',
  failed: 'danger',
  skipped_no_channel: 'warning',
};

/** Estados del asistente del bot que no son un paso del guion. */
export const BOT_EXTRA_STATE_LABELS: Readonly<Record<'inicio' | 'listo', string>> = {
  inicio: t('notificaciones.conversaciones.estado.inicio'),
  listo: t('notificaciones.conversaciones.estado.listo'),
};

/**
 * Paso del asistente tal como lo muestra la bandeja. Se escribe el mapa entero
 * (y no un índice sobre `BOT_STEP_LABELS`) para que el contrato pueda añadir
 * estados sin romper esta traducción en silencio.
 */
const BOT_STATE_LABELS: Readonly<Record<BotConversationState, string>> = {
  inicio: t('notificaciones.conversaciones.estado.inicio'),
  nombre: BOT_STEP_LABELS.nombre,
  documento: BOT_STEP_LABELS.documento,
  telefono: BOT_STEP_LABELS.telefono,
  nacimiento: BOT_STEP_LABELS.nacimiento,
  sexo: BOT_STEP_LABELS.sexo,
  motivo: BOT_STEP_LABELS.motivo,
  confirmacion: BOT_STEP_LABELS.confirmacion,
  representante: t('notificaciones.conversaciones.estado.representante'),
  esperando_confirmacion: t('notificaciones.conversaciones.estado.esperando', {
    paso: BOT_STEP_LABELS.confirmacion,
  }),
  listo: t('notificaciones.conversaciones.estado.listo'),
};

export const botStateLabel = (state: BotConversationState): string => BOT_STATE_LABELS[state];

/**
 * Nombre legible de una plantilla. El registro de un envío trae la clave como
 * texto libre, así que si el servicio añade una plantilla nueva se muestra una
 * versión legible de la clave en vez de la clave cruda.
 */
const NOMBRES_PLANTILLA: Readonly<Record<string, string>> = {
  bienvenida: t('notificaciones.plantilla.bienvenida'),
  ayuda: t('notificaciones.plantilla.ayuda'),
  pedir_nombre: t('notificaciones.plantilla.pedir_nombre'),
  pedir_documento: t('notificaciones.plantilla.pedir_documento'),
  pedir_telefono: t('notificaciones.plantilla.pedir_telefono'),
  pedir_nacimiento: t('notificaciones.plantilla.pedir_nacimiento'),
  pedir_sexo: t('notificaciones.plantilla.pedir_sexo'),
  pedir_motivo: t('notificaciones.plantilla.pedir_motivo'),
  confirmar: t('notificaciones.plantilla.confirmar'),
  documento_duplicado: t('notificaciones.plantilla.documento_duplicado'),
  solicitud_recibida: t('notificaciones.plantilla.solicitud_recibida'),
  cita_confirmada: t('notificaciones.plantilla.cita_confirmada'),
  cita_reprogramada: t('notificaciones.plantilla.cita_reprogramada'),
  cita_cancelada: t('notificaciones.plantilla.cita_cancelada'),
  estado_solicitud: t('notificaciones.plantilla.estado_solicitud'),
  manual_pendiente: t('notificaciones.plantilla.manual_pendiente'),
  servicio_no_disponible: t('notificaciones.plantilla.servicio_no_disponible'),
};

export const templateName = (key: string): string => {
  const conocido = NOMBRES_PLANTILLA[key];
  if (conocido !== undefined) return conocido;
  const legible = key.replace(/[_-]+/g, ' ').trim();
  return legible.length === 0
    ? key
    : legible.charAt(0).toLocaleUpperCase('es-VE') + legible.slice(1);
};

/** Comprueba en tiempo de ejecución que un texto del servidor es un estado conocido. */
export const isAppointmentStatus = (value: string): value is AppointmentStatus =>
  (APPOINTMENT_STATUSES as readonly string[]).includes(value);

/** Comprueba que un texto del servidor es un canal conocido. */
export const isChannel = (value: string): value is Channel =>
  (CHANNELS as readonly string[]).includes(value);
