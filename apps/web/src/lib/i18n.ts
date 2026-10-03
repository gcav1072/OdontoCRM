import {
  AUDIT_ACTIONS,
  PERMISSIONS,
  ROLES,
  type DocType,
  type PatientFileKind,
  type PatientStatus,
  type Permission,
  type Role,
  type Sex,
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
  'modulo.pacientes.titulo': 'Pacientes',
  'modulo.pacientes.descripcion': 'Listado, filtros y ficha completa de cada paciente.',
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
  'permiso.patients:delete': 'Eliminar un paciente del registro',
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
  'patients:delete': t('permiso.patients:delete'),
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
