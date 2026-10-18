# Plan Maestro de Pruebas Manuales End-to-End (QA) — OdontoCRM

**Proyecto:** OdontoCRM (Arquitectura de 9 Microservicios + API Gateway + SPA Web)  
**Propósito:** Validación funcional exhaustiva, pruebas de reglas de negocio (ADRs), casos límite (*edge cases*), pruebas negativas y verificación de efectos secundarios asíncronos (`pg-boss`, Outbox, SSE, Vistas Materializadas y Auditoría).

---

## 1. Lista de Verificación Previa (Pre-Flight Check)

Antes de iniciar la ejecución manual en el navegador, ejecuta y verifica los siguientes puntos en la terminal del entorno:

- [x] **PRE-01 — Estado de los servicios:** Ejecutar `node tools/estado.mjs` (o verificar en `SystemHealthPanel`) y comprobar que el `gateway` y los $9$ microservicios (`identity`, `patients`, `scheduling`, `clinical`, `odontogram`, `notifications`, `screens`, `billing`, `reporting`) respondan en estado saludable (`OK`).
- [x] **PRE-02 — Migraciones al día:** Ejecutar `node tools/verify-migrations.mjs` para confirmar que todas las bases de datos PostgreSQL por servicio tienen los esquemas de Drizzle sincronizados.
- [x] **PRE-03 — Verificación de entorno y secretos:** Ejecutar `node tools/env-check.mjs` y `node tools/audit-conexiones.mjs` sin errores.
- [x] **PRE-04 — Semilla de datos (Opcional para entorno limpio):** Si se prueba sobre una base limpia, ejecutar `node tools/db-reset.mjs` y `node tools/seed-test.mjs` seguidos de `node tools/seed-verify.mjs` (ADR `0042`).
- [x] **PRE-05 — Identificación de Modo Test:** Verificar en la interfaz si aparece el banner superior de **Modo Test** (`TestModeBanner.tsx`, ADR `0020`), el cual intercepta los envíos reales de Telegram/WhatsApp hacia el adaptador simulado (`canales/simulado.ts`).

---

## 2. Flujo End-to-End (E2E) Transversal: Ciclo de Vida Completo del Paciente

> **Objetivo:** Validar sin interrupciones el recorrido completo de un paciente a través de los $9$ microservicios y sus eventos de dominio.

### Caso `E2E-01` al `E2E-07`: De la Solicitud de Cita al Cierre Contable y Auditoría

- [x] **Paso 1 (`E2E-01` — Captación y Solicitud):**
  - Registrar un paciente nuevo en `/pacientes/nuevo` (`PatientRegistryPage.tsx`).
  - Crear una solicitud de cita para ese paciente desde `NewRequestDialog.tsx` (o mediante el bot conversacional en `services/notifications`).
  - **Resultado esperado:** El paciente existe en `services/patients` y su solicitud aparece como pendiente en `RequestQueuePanel.tsx` (`services/scheduling`).
- [x] **Paso 2 (`E2E-02` — Asignación de Sillón, Ticket y Notificación `.ics`):**
  - Desde `SchedulingPage.tsx`, tomar la solicitud de la cola y abrir `AssignAppointmentDialog.tsx`.
  - Seleccionar un sillón activo y una franja horaria disponible en `SlotGrid.tsx`.
  - **Resultado esperado:** Se crea la cita con un **ticket consecutivo** del día (ADR `0011`), se descuenta $1$ cupo en `DayCapacityCard.tsx` y se encola una notificación de cita agendada con archivo de calendario `.ics` adjunto (`messaging.ics.test.ts`).
- [x] **Paso 3 (`E2E-03` — Confirmación de Asistencia por el Paciente):**
  - Desde el canal del bot (o simulador en Modo Test), enviar la respuesta de confirmación de cita del paciente (ADR `0052`).
  - **Resultado esperado:** El estado de la cita cambia automáticamente a **Confirmada** en `DayAppointmentsTable.tsx` y `SecretariaAppointmentsTable.tsx` vía sincronización en tiempo real (`RealtimeSyncProvider.tsx`).
- [x] **Paso 4 (`E2E-04` — Recepción, Llamado y Pantallas Kiosko SSE):**
  - Abrir en dos pestañas adicionales las pantallas Kiosko: `/pantalla/sala` (`ScreenLobbyPage.tsx`) y `/pantalla/consultorio` (`ScreenConsultorioPage.tsx`).
  - En `SecretariaPage.tsx`, marcar la llegada del paciente y luego accionar **Llamar a consultorio**.
  - **Resultado esperado:** La pantalla de Sala anuncia el ticket/nombre mediante síntesis de voz (`kiosk-speech.ts`) vía SSE (ADR `0030`), y la pantalla de Consultorio muestra al paciente junto con sus alertas médicas críticas (`CriticalFlagsCard.tsx`, ADR `0035`).
- [x] **Paso 5 (`E2E-05` — Atención Clínica, Odontograma, Récipe y Cierre de Sesión):**
  - Con sesión de Odontólogo en `ConsultorioPage.tsx` / `PatientDetailPage.tsx`, abrir el `PatientWorkspace.tsx`.
  - Llenar la historia clínica (`MedicalRecordForm.tsx`) incluyendo una alerta crítica (ej. alergia a AINEs), registrar el consentimiento (`ConsentDialog.tsx`) y firmar la historia (`SignRecordDialog.tsx`, ADR `0016`).
  - En `OdontogramPanel.tsx`, registrar hallazgos por cara y de pieza completa, además de una prótesis (`ProsthesisDialog.tsx`).
  - En `SessionPanel.tsx`, documentar la evolución de la sesión, emitir un récipe PDF (`PrescriptionDialog.tsx`) y cerrar la sesión (`CloseSessionDialog.tsx`) agendando el próximo control (`ScheduleNextAppointmentDialog.tsx`).
  - **Resultado esperado:** Historia firmada e inmutable; odontograma versionado; récipe PDF en dos mitades archivado con código QR verificable; sesión cerrada y cita pasada a estado **Atendida**.
- [x] **Paso 6 (`E2E-06` — Caja, Tasa BCV, Cobro con Fecha Valor, Diferencial e IGTF y Facturación):**
  - Ir a `CajaPage.tsx`, verificar o fijar la tasa del día (`TasaDelDia.tsx`, ADR `0046`).
  - Abrir `CobroDialog.tsx` para el paciente atendido, agregar partidas del catálogo y $1$ partida manual a mano (ADR `0067`).
  - Declarar la **Fecha Valor** del cobro (la del comprobante bancario) y registrar un pago mixto (parte en Bolívares y parte en USD efectivo); emitir la factura.
  - **Resultado esperado:** El recibo desglosa lo recibido, lo imputado a la tasa de emisión y el **diferencial cambiario**, valora el cobro con la tasa de su **Fecha Valor** y calcula el **IGTF** según la alícuota configurada y la moneda de percepción declarada (ADR `0045`, `0069`); se genera y archiva el PDF (`0048`) y se registra en el Libro de Ventas.
- [x] **Paso 7 (`E2E-07` — Refresco de Reportes y Trazabilidad en Auditoría):**
  - Ir a `ReportesPage.tsx`, ejecutar el refresco del modelo de lectura (ADR `0040`) y revisar las pestañas de KPIs.
  - Ir a `AuditoriaPage.tsx` y filtrar los eventos del día.
  - **Resultado esperado:** Los reportes reflejan la nueva cita atendida, los hallazgos de salud bucal y el récipe emitido; la tabla de auditoría muestra todos los eventos con sus resúmenes y diferencias (`AuditDiffDialog.tsx`).

---

## 3. Matriz Exhaustiva de Pruebas por Módulo

---

### Módulo A: Identidad, Autenticación, Roles y Seguridad (`services/identity` y `apps/gateway`)

#### `ID-01` — Inicio de sesión válido, inválido y bloqueo de usuario inactivo
- **Rutas / Componentes:** `LoginPage.tsx`, `PasswordInput.tsx`, `auth-routes.ts` (ADR `0005`, `0023`).
- **Pasos de prueba:**
  - [x] Intentar iniciar sesión con un correo inexistente y luego con una contraseña errónea.
  - [x] Desactivar un usuario de prueba desde una cuenta administradora (`UserStatusDialog.tsx`) e intentar iniciar sesión con dicho usuario.
  - [x] Iniciar sesión con credenciales válidas de un usuario activo.
- **Resultado esperado:** Mensajes de error claros en español sin filtrar detalles internos del servidor; bloqueo total de acceso a usuarios inactivos; inicio de sesión exitoso y persistencia de sesión segura para el usuario activo.

#### `ID-02` — Compuerta obligatoria de cambio de contraseña (`MustChangePasswordGate`)
- **Rutas / Componentes:** `CreateUserDialog.tsx`, `ResetPasswordDialog.tsx`, `TemporaryPasswordDialog.tsx`, `MustChangePasswordGate.tsx`, `ChangePasswordPage.tsx`.
- **Pasos de prueba:**
  - [x] Como Administrador en `UsersPage.tsx`, crear un usuario nuevo o restablecer la contraseña de uno existente y copiar la clave temporal mostrada en `TemporaryPasswordDialog.tsx`.
  - [x] Iniciar sesión con ese usuario usando la clave temporal.
  - [x] Intentar navegar forzosamente escribiendo en la barra de direcciones `/pacientes`, `/agenda` o `/caja`.
  - [x] Completar el cambio de contraseña en `ChangePasswordPage.tsx`.
- **Resultado esperado:** Mientras la marca de cambio obligatorio esté activa, `MustChangePasswordGate` intercepta cualquier ruta y redirige a `/cambiar-contrasena`. Una vez cambiada, libera el acceso normal.

#### `ID-03` — Compuerta de perfil profesional incompleto (`NeedsProfileGate`)
- **Rutas / Componentes:** `NeedsProfileGate.tsx`, `CompleteProfilePage.tsx`, `EditUserProfileSection.tsx` (ADR `0061`).
- **Pasos de prueba:**
  - [x] Crear un usuario con rol de **Odontólogo** sin completar sus datos de perfil profesional (especialidad, número de colegio/registro sanitario).
  - [x] Iniciar sesión con dicho odontólogo y cambiar su contraseña temporal.
  - [x] Intentar acceder al consultorio sin llenar el perfil.
  - [x] Completar los datos requeridos en `CompleteProfilePage.tsx`.
- **Resultado esperado:** El sistema exige completar el perfil profesional antes de operar, garantizando que el membrete de récipes e historias siempre cuente con los datos del especialista.

#### `ID-04` — Control de acceso por rol y permisos granulares (RBAC)
- **Rutas / Componentes:** `RequirePermission.tsx`, `Sidebar.tsx`, `MobileNav.tsx`, `ForbiddenPage.tsx`, `admin-guard.ts` (ADR `0005`, `0038`, `0039`).
- **Pasos de prueba:**
  - [x] Iniciar sesión con rol **Secretaría** y verificar qué elementos aparecen en el menú lateral (`Sidebar.tsx`).
  - [x] Escribir manualmente en el navegador la ruta `/usuarios`, `/auditoria` y `/configuracion`.
  - [x] Intentar consultar la pestaña de reportes clínicos sin el permiso específico (ADR `0039`).
- **Resultado esperado:** El menú oculta los módulos no autorizados; el acceso directo por URL muestra `ForbiddenPage.tsx` (HTTP $403$ en el Gateway).

#### `ID-05` — Regla "Un odontólogo, un sillón"
- **Rutas / Componentes:** `CreateUserDialog.tsx`, `EditUserDialog.tsx`, `chair-service.ts` (ADR `0006`, `0059`).
- **Pasos de prueba:**
  - [x] Verificar la asignación de sillón al crear o editar un usuario con rol Odontólogo.
  - [x] Comprobar cómo se refleja ese sillón como recurso en `SchedulingPage.tsx` y `FlujoPage.tsx`.
- **Resultado esperado:** Cada odontólogo opera sobre su sillón asignado y el sillón actúa como el recurso primario de la agenda.

---

### Módulo B: Configuración de Clínica, Marca e Imprimibles (`ConfiguracionPage.tsx`)

#### `CFG-01` — Identidad del consultorio en base de datos
- **Rutas / Componentes:** `MarcaSection.tsx`, `ClinicIdentityProvider.tsx` (ADR `0056`, `0058`).
- **Pasos de prueba:**
  - [x] Ir a `/configuracion` (`ConfiguracionPage.tsx`) y modificar el nombre comercial del consultorio, razón social, RIF, dirección, teléfono y logo.
  - [x] Guardar los cambios y recargar la aplicación.
- **Resultado esperado:** La nueva identidad persiste en la base de datos (`services/identity`), se actualiza en `AppHeader.tsx`, `MarcaTile.tsx` y en el encabezado de todos los documentos imprimibles sin tocar el código fuente.

#### `CFG-02` — Selector de acento, tema visual y tipografías por rol
- **Rutas / Componentes:** `AcentoSection.tsx`, `AccentPicker.tsx`, `ThemeSelector.tsx`, `RolTipografico.tsx` (ADR `0055`, `0063`).
- **Pasos de prueba:**
  - [x] Cambiar el color de acento en `AccentPicker.tsx` y alternar entre modo claro y oscuro en `ThemeSelector.tsx`.
  - [x] En `RolTipografico.tsx`, cambiar la fuente de títulos/marca (ej. *Poppins*, *Montserrat*, *Dancing Script*, *Lobster*, *Pacifico*) y la fuente de cuerpo (ej. *Inter*).
- **Resultado esperado:** Los tokens CSS (`tokens.css`) se actualizan al instante en toda la interfaz y los documentos imprimibles combinan únicamente las $2$ tipografías configuradas (ADR `0055`).

#### `CFG-03` — Membrete configurable en caliente y tamaño de papel del récipe
- **Rutas / Componentes:** `MembreteSection.tsx`, `MembreteDocumento.tsx`, `MargenDeImpresion.tsx`, `MarcaDeAgua.tsx` (ADR `0054`, `0064`, `0065`).
- **Pasos de prueba:**
  - [x] Modificar la configuración del membrete (visibilidad de elementos, alineación, marca de agua, márgenes) y seleccionar el formato de papel del récipe (`0007_papel_del_recipe.sql`).
  - [x] Sin reiniciar ningún servicio, abrir la impresión de una Historia Clínica (`MedicalRecordPrintPage.tsx`), un Odontograma (`OdontogramPrintPage.tsx`) y generar un Récipe PDF.
- **Resultado esperado:** Los cambios de membrete se aplican en caliente en todos los imprimibles y el récipe se ajusta a las dimensiones del papel de la clínica.

#### `CFG-04` — Régimen tributario de la caja (Sujeto Pasivo Especial y alícuota del IGTF)
- **Rutas / Componentes:** `TributarioSection.tsx`, `ConfiguracionPage.tsx`, `CajaPage.tsx` (ADR `0045`, `0069`).
- **Pasos de prueba:**
  - [x] Entrar a `/configuracion` con el rol **Administrador** y, en **Régimen tributario**, marcar *Sujeto Pasivo Especial (Agente de Percepción IGTF)* y fijar una alícuota (ej. $3{,}00\%$); guardar.
  - [x] Abrir `CobroDialog.tsx` y comprobar que aparece el bloque del IGTF con la alícuota configurada y el selector de **moneda de percepción**.
  - [x] Iniciar sesión con **Secretaría** y escribir la URL `/configuracion` en la barra de direcciones.
- **Resultado esperado:** `PATCH /api/v1/billing/settings` guarda la configuración fiscal y el cobro la refleja; editar la configuración exige `settings:manage` (solo `admin`), así que la secretaría recibe `ForbiddenPage.tsx` (HTTP $403$).

---

### Módulo C: Gestión de Pacientes y Almacenamiento Cifrado (`services/patients`)

#### `PAC-01` — Registro de pacientes y reglas de identificación (Adultos, Menores y Extranjeros)
- **Rutas / Componentes:** `PatientRegistryPage.tsx`, `PatientForm.tsx`, `PatientFields.tsx` (ADR `0007`).
- **Pasos de prueba:**
  - [x] Registrar un paciente **Adulto** con cédula venezolana (`V-...`) válida.
  - [x] Intentar registrar un segundo paciente adulto con la **misma cédula**.
  - [x] Registrar un paciente **Menor de edad sin cédula** asociándolo a los datos de su representante.
  - [x] Registrar un paciente con documento **Extranjero / Pasaporte** (`E-...` / `P-...`).
  - [x] Probar el envío del formulario con campos obligatorios vacíos o teléfonos con formato inválido.
- **Resultado esperado:** Validaciones Zod en español (`zod-es.ts`); rechazo de cédula duplicada en titulares; creación correcta de menores sin cédula propia usando secuencia/vínculo de representante.

#### `PAC-02` — Búsqueda con *debounce*, edición y diálogo de diferencias (`Diff`)
- **Rutas / Componentes:** `PatientsPage.tsx`, `PatientSearchList.tsx`, `PatientDiffDialog.tsx`.
- **Pasos de prueba:**
  - [x] En `/pacientes`, buscar por fragmento de nombre, apellido, teléfono y número de documento.
  - [x] Entrar al detalle del paciente (`PatientDetailPage.tsx`), modificar teléfono y dirección, y confirmar en `PatientDiffDialog.tsx`.
- **Resultado esperado:** Búsqueda fluida sin sobrecargar la red (`useDebouncedValue.ts`); el diálogo `PatientDiffDialog` muestra claramente el valor anterior frente al valor nuevo antes de guardar.

#### `PAC-03` — Adjuntos de pacientes y cifrado en reposo (`Blob Store`)
- **Rutas / Componentes:** `PatientAttachments.tsx`, `packages/storage/src/blob-store.ts`, `crypto.ts`.
- **Pasos de prueba:**
  - [x] Subir una imagen (`.jpg`/`.png`) y un documento `.pdf` en la sección de adjuntos del paciente.
  - [x] Previsualizar o descargar ambos archivos desde la interfaz web. Ojo: Se puede eliminar/descarga rel archivo, pero verlo directamente en la web no.
  - [x] Inspeccionar el archivo físico guardado en el directorio de almacenamiento en disco (o ejecutar `node tools/verificar-almacen.mjs`).
- **Resultado esperado:** El usuario autorizado descarga el archivo original desencriptado al vuelo, mientras que en el disco duro el blob está cifrado criptográficamente y no es legible directamente. (Faltaría probar lo del blob cuando se corrja la visualización)

#### `PAC-04` — Cambio de estado y borrado lógico (*Soft Delete*)
- **Rutas / Componentes:** `PatientStatusDialog.tsx`, `PatientDeleteDialog.tsx` (ADR `0027`).
- **Pasos de prueba:**
  - [x] Cambiar el estado de un paciente a inactivo desde `PatientStatusDialog.tsx`.
  - [x] Ejecutar el borrado de un paciente con historial desde `PatientDeleteDialog.tsx`.
- **Resultado esperado:** El paciente se marca con borrado lógico en base de datos; desaparece de los listados activos para agendar nuevas citas, pero sus citas históricas, sesiones clínicas y facturas previas no se rompen ni pierden referencia.

---

### Módulo D: Agenda, Cupos, Solicitudes y Tickets (`services/scheduling`)

#### `AGE-01` — Horario de atención, franjas y cupo en franjas, en formato de $12\text{ h}$
- **Rutas / Componentes:** `SchedulingPage.tsx`, `DayToolbar.tsx`, `ScheduleConfigDialog.tsx`, `Hora12hField.tsx`, `DayCapacityCard.tsx` (ADR `0070`, `0025`).
- **Pasos de prueba:**
  - [ ] Abrir `/programacion` y pulsar **Configurar la jornada** en la tarjeta del cupo (o **Horario y franjas** en la barra).
  - [ ] Comprobar que el día propuesto es el que se está viendo, que los turnos se leen en 12 h (`8:00 a. m. – 12:00 p. m.` y `2:00 p. m. – 5:00 p. m.`) y que la franja es de 30 minutos.
  - [ ] Añadir un turno, quitar otro, cambiar la franja a 60 minutos y aplicar el horario a **Lunes a viernes**.
  - [ ] Intentar guardar dos turnos solapados y un turno más corto que la franja.
  - [ ] Quitar todos los turnos de un día (por ejemplo un domingo) y guardar.
  - [ ] Asignar una cita manual de dos horas sobre franjas de 30 minutos en un día de consulta.
- **Resultado esperado:** Los turnos solapados y el turno más corto que la franja **no** dejan guardar (error en línea); el horario guardado recalcula el cupo de la jornada sin mover las citas; el día sin turnos queda **cerrado** (cupo 0, aviso «Día cerrado») y asignar ahí exige sobrecupo de admin con motivo; la cita de dos horas ocupa **cuatro** franjas y el contador sube 4; todas las horas visibles y editables están en formato de 12 horas.

#### `AGE-02` — Cola de solicitudes, asignación de cita y ticket consecutivo
- **Rutas / Componentes:** `RequestQueuePanel.tsx`, `NewRequestDialog.tsx`, `AssignAppointmentDialog.tsx`, `SlotPickerFields.tsx` (ADR `0011`).
- **Pasos de prueba:**
  - [x] Crear $3$ solicitudes de cita en `NewRequestDialog.tsx`.
  - [x] Asignar las $3$ solicitudes al mismo día y sillón mediante `AssignAppointmentDialog.tsx`.
  - [x] Intentar asignar una cuarta cita en una franja cuyo cupo ya llegó a $0$.
- **Resultado esperado:** Las $3$ citas reciben tickets consecutivos ordenados ($1, 2, 3$); el sistema bloquea la sobreasignación cuando el cupo de la franja se agota.

#### `AGE-03` — Máquina de estados, reprogramación y devolución del ticket al cancelar
- **Rutas / Componentes:** `AppointmentActionDialog.tsx`, `RescheduleAppointmentDialog.tsx`, `AppointmentHistoryDialog.tsx`, `RequestCancelDialog.tsx` (ADR `0012`, `0028`).
- **Pasos de prueba:**
  - [ ] Cancelar la cita que tenía asignado el ticket número $2$ del día.
  - [ ] Asignar inmediatamente una nueva cita para otro paciente en ese mismo día y franja liberada.
  - [ ] Reprogramar otra cita activa hacia una fecha distinta con `RescheduleAppointmentDialog.tsx`.
  - [ ] Abrir `AppointmentHistoryDialog.tsx` en ambas citas.
- **Resultado esperado:** Al cancelar la cita, el cupo se libera y **el número de ticket se devuelve/reutiliza** según `0028-cancelar-devuelve-el-ticket.md`; el historial de la cita muestra cada transición de estado con fecha y usuario responsable.

#### `AGE-04` — Notificación en lote de la jornada
- **Rutas / Componentes:** `NotifyBatchDialog.tsx` (ADR `0010`).
- **Pasos de prueba:**
  - [ ] En un día con múltiples citas agendadas pendientes de notificar, abrir `NotifyBatchDialog.tsx` y disparar el envío en lote.
- **Resultado esperado:** El servicio emite los eventos de notificación para todas las citas seleccionadas del lote y actualiza su estado de notificación.

---

### Módulo E: Secretaría, Recepción y Flujo Diario (`SecretariaPage.tsx`, `FlujoPage.tsx`)

#### `SEC-01` — Tablero de Secretaría, contadores del día, No-Show y Llamado de Emergencia
- **Rutas / Componentes:** `SecretariaToolbar.tsx`, `DayCounters.tsx`, `SecretariaAppointmentsTable.tsx`, `NoShowDialog.tsx`, `EmergencyCallDialog.tsx`.
- **Pasos de prueba:**
  - [ ] Verificar los contadores iniciales en `DayCounters.tsx` (Agendadas, Confirmadas, En sala, En atención, Atendidas, Canceladas/No-Show).
  - [ ] Marcar un paciente como **No asistió (No-Show)** usando `NoShowDialog.tsx`.
  - [ ] Accionar el botón de **Llamado de Emergencia** (`EmergencyCallDialog.tsx`) indicando el consultorio/sillón.
- **Resultado esperado:** Los contadores se recalculan al instante; el llamado de emergencia dispara una alerta prioritaria hacia las pantallas Kiosko.

#### `SEC-02` — Flujo operativo de sillón y permisos de "Marcar Atendido"
- **Rutas / Componentes:** `FlujoPage.tsx`, `FlowTopBar.tsx`, `DayQueue.tsx`, `AttendDialog.tsx` (ADR `0017`, `0038`).
- **Pasos de prueba:**
  - [ ] Abrir `FlujoPage.tsx` con el rol **Odontólogo** y con el rol **Secretaría**.
  - [ ] Avanzar un paciente por la cola del día (`DayQueue.tsx`) hasta concluir la atención con `AttendDialog.tsx`.
- **Resultado esperado:** Se respetan los permisos del odontólogo sobre su flujo (ADR `0038`) y el cierre de atención vincula o actualiza correctamente el estado de la cita (ADR `0017`).

---

### Módulo F: Historia Clínica, Sesiones, Récipe PDF y Dossier (`services/clinical`)

#### `CLI-01` — Historia Clínica, Alertas Críticas Leídas (No Empujadas) y Vista de Impresión
- **Rutas / Componentes:** `MedicalRecordForm.tsx`, `ClinicalSectionFields.tsx`, `ClinicalAlerts.tsx`, `MedicalRecordDocument.tsx`, `MedicalRecordPrintPage.tsx` (ADR `0035`, `formato_historia.md`).
- **Pasos de prueba:**
  - [ ] Llenar todas las secciones de la historia clínica de un paciente en `MedicalRecordForm.tsx`, marcando patologías de alerta crítica (ej. Diabetes, Alergia a Anestésicos, Embarazo).
  - [ ] Guardar y observar el banner `ClinicalAlerts.tsx` en el espacio de trabajo y `CriticalFlagsCard.tsx` en la pantalla Kiosko del consultorio.
  - [ ] Abrir la vista de impresión en `MedicalRecordPrintPage.tsx`.
- **Resultado esperado:** Las alertas críticas son visibles inmediatamente al consultar el paciente y el formato impreso respeta la estructura clínica oficial con el membrete activo.

#### `CLI-02` — Firma, Consentimiento Informado e Inmutabilidad con Enmiendas
- **Rutas / Componentes:** `ConsentDialog.tsx`, `SignRecordDialog.tsx`, `AmendmentDialog.tsx` (ADR `0016`).
- **Pasos de prueba:**
  - [ ] Registrar el consentimiento informado en `ConsentDialog.tsx` y firmar la historia en `SignRecordDialog.tsx`.
  - [ ] Intentar modificar directamente un campo de la historia clínica ya firmada.
  - [ ] Crear una enmienda formal mediante `AmendmentDialog.tsx` explicando la adición o corrección clínica.
- **Resultado esperado:** La historia firmada es inmutable; cualquier actualización posterior se almacena como una enmienda aditiva con sello de tiempo y autor.

#### `CLI-03` — Sesiones Clínicas (Evolución), Adjuntos de Sesión y Agendamiento de Control
- **Rutas / Componentes:** `PatientSessionsCard.tsx`, `SessionPanel.tsx`, `SessionForm.tsx`, `SessionDetailView.tsx`, `SessionAttachments.tsx`, `CloseSessionDialog.tsx`, `AmendSessionDialog.tsx`, `ScheduleNextAppointmentDialog.tsx` (ADR `0034`).
- **Pasos de prueba:**
  - [ ] Iniciar una sesión clínica para el paciente en atención, redactar el procedimiento realizado y subir una foto intraoral en `SessionAttachments.tsx`.
  - [ ] Cerrar la sesión en `CloseSessionDialog.tsx` y, desde el flujo de cierre, agendar la próxima cita en `ScheduleNextAppointmentDialog.tsx`.
  - [ ] Abrir la sesión cerrada en `SessionDetailView.tsx`, comprobar que no se puede sobrescribir y agregar una nota aclaratoria con `AmendSessionDialog.tsx`.
- **Resultado esperado:** La evolución queda sellada al cerrar la sesión, admite enmiendas posteriores y deja creada la cita o solicitud de próximo control.

#### `CLI-04` — Emisión de Récipe PDF en Dos Mitades, Autoajuste al Papel y Verificación Pública por QR
- **Rutas / Componentes:** `PrescriptionCard.tsx`, `PrescriptionDialog.tsx`, `prescription-document.ts`, `fit-to-page.ts`, `qr.ts`, `VerifyPrescriptionPage.tsx` (ADR `0015`, `0036`, `0061`, `0065`).
- **Pasos de prueba:**
  - [ ] En `PrescriptionDialog.tsx`, agregar $5$ medicamentos con posologías e indicaciones extensas.
  - [ ] Emitir el récipe y abrir el PDF generado.
  - [ ] Copiar el código de verificación o escanear el código QR del PDF y abrir `/verificar/recipe/:codigo` (`VerifyPrescriptionPage.tsx`) en una ventana de incógnito (sin sesión iniciada).
  - [ ] Probar en la misma URL un código alterado o inexistente.
- **Resultado esperado:**
  - El PDF muestra dos mitades (Medicamentos / Indicaciones) con los datos del especialista en el membrete (ADR `0061`).
  - El motor `fit-to-page.ts` escala el contenido para que entre en $1$ sola página sin cortarse (ADR `0065`).
  - El PDF queda archivado permanentemente en el almacén cifrado (ADR `0036`).
  - La página pública confirma la validez del récipe legítimo y rechaza el código alterado.

#### `CLI-05` — Emisión y Verificación Pública de Dossier Clínico Integral
- **Rutas / Componentes:** `DossierCard.tsx`, `dossier-document.ts`, `dossier-odontogram.ts`, `VerifyDossierPage.tsx`.
- **Pasos de prueba:**
  - [ ] Generar el Dossier Clínico desde `DossierCard.tsx` y descargar el PDF.
  - [ ] Verificar en una ventana de incógnito la ruta `/verificar/dossier/:codigo` (`VerifyDossierPage.tsx`).
- **Resultado esperado:** El PDF consolida datos filiatorios, historia clínica, gráfico del odontograma actual y evoluciones, con código de verificación válido públicamente.

---

### Módulo G: Odontograma Anatómico e Historial (`services/odontogram`)

#### `ODO-01` — Posición Anatómica, Nomenclatura FDI y Dentición Mixta
- **Rutas / Componentes:** `OdontogramPanel.tsx`, `OdontogramChart.tsx`, `GeometricTooth.tsx` (ADR `0033`, `0051`).
- **Pasos de prueba:**
  - [x] Inspeccionar los cuadrantes permanentes ($1, 2, 3, 4$) y temporales ($5, 6, 7, 8$) en `OdontogramChart.tsx`.
  - [x] Activar la vista de dentición mixta para un paciente pediátrico/adolescente.
- **Resultado esperado:** Disposición en posición anatómica estándar (ADR `0033`), geometría de $5$ caras por pieza y soporte simultáneo de piezas permanentes y deciduas (ADR `0051`).

#### `ODO-02` — Precedencia de Pieza Completa sobre Caras y Convivencia de Tratamientos
- **Rutas / Componentes:** `ToothFindingSheet.tsx`, `QuickEntryBar.tsx`, `chart-service.ts` (ADR `0031`, `0032`, `docs/ODONTOGRAMA_REGLAS.md`).
- **Pasos de prueba:**
  - [x] En la pieza $26$, registrar **Caries** en la cara Oclusal (`O`) y **Obturación/Restauración** en la cara Mesial (`M`).
  - [x] Sobre la misma pieza $26$, registrar un tratamiento de pieza completa compatible (ej. **Endodoncia**).
  - [x] Posteriormente, sobre la pieza $26$, registrar **Exodoncia / Diente Ausente**.
  - [x] Probar también la entrada rápida por teclado/barra en `QuickEntryBar.tsx`.
- **Resultado esperado:**
  - Al agregar Endodoncia, se conservan los hallazgos de las caras `O` y `M` según la matriz de convivencia (ADR `0032`).
  - Al marcar Diente Ausente / Exodoncia total, la condición de pieza completa prevalece sobre las caras (ADR `0031`).

#### `ODO-03` — Registro de Prótesis Removibles y Fijas
- **Rutas / Componentes:** `ProsthesisDialog.tsx`, `ProsthesisOverlay.tsx` (ADR `0062`).
- **Pasos de prueba:**
  - [x] Abrir `ProsthesisDialog.tsx` y registrar una prótesis parcial removible o puente seleccionando las piezas involucradas y su estado (en buen estado / defectuosa / planificada).
- **Resultado esperado:** `ProsthesisOverlay.tsx` renderiza gráficamente el aparato protésico sobre el arco correspondiente sin solapar erróneamente otros indicadores.

#### `ODO-04` — Historial de Snapshots e Impresión del Odontograma
- **Rutas / Componentes:** `OdontogramHistory.tsx`, `OdontogramHistoryPage.tsx`, `OdontogramStaticChart.tsx`, `OdontogramPrintPage.tsx`, `OdontogramDocument.tsx`.
- **Pasos de prueba:**
  - [x] Realizar modificaciones en el odontograma en dos momentos distintos, abrir `OdontogramHistoryPage.tsx` y seleccionar cada versión histórica.
  - [x] Abrir `OdontogramPrintPage.tsx` y generar la vista de impresión.
- **Resultado esperado:** Cada versión histórica se visualiza de forma fiel en modo lectura (`OdontogramStaticChart.tsx`) y la hoja de impresión incluye leyenda, resumen de hallazgos y membrete.

---

### Módulo H: Pantallas Kiosko y Sincronización SSE (`services/screens`)

#### `SCR-01` — Gestión de Pantallas, Tokens de Dispositivo y Desactivación
- **Rutas / Componentes:** `ScreensPage.tsx`, `NewScreenDialog.tsx`, `ScreenTokenDialog.tsx`, `ScreenSettingsDialog.tsx`, `DeactivateScreenDialog.tsx` (ADR `0030`).
- **Pasos de prueba:**
  - [ ] En `/pantallas` (`ScreensPage.tsx`), crear una pantalla de Sala y una de Consultorio (`NewScreenDialog.tsx`).
  - [ ] Obtener el token de vinculación en `ScreenTokenDialog.tsx`, abrir la pantalla Kiosko con dicho token y personalizar sus textos/avisos en `ScreenSettingsDialog.tsx`.
  - [ ] Desactivar la pantalla desde `DeactivateScreenDialog.tsx`.
- **Resultado esperado:** La pantalla Kiosko se conecta sin requerir usuario humano (usa token de dispositivo) y al desactivarse corta inmediatamente el flujo de datos SSE.

#### `SCR-02` — Kiosko de Sala de Espera (Lobby), Audio TTS y Reconexión
- **Rutas / Componentes:** `ScreenLobbyPage.tsx`, `KioskStatusBar.tsx`, `KioskNotice.tsx`, `kiosk-speech.ts`, `useKioskState.ts`.
- **Pasos de prueba:**
  - [ ] Con `ScreenLobbyPage.tsx` abierta y audio habilitado en el navegador, llamar a $2$ pacientes seguidos desde Secretaría.
  - [ ] Desconectar brevemente la red o reiniciar el servicio `screens` y observar `KioskStatusBar.tsx`.
- **Resultado esperado:** Los llamados se encolan y pronuncian claramente por voz en español (`kiosk-speech.ts`), el turno parpadea/destaca en pantalla y el cliente SSE se reconecta automáticamente si cae la red.

#### `SCR-03` — Kiosko de Consultorio y Estética Propia
- **Rutas / Componentes:** `ScreenConsultorioPage.tsx`, `CriticalFlagsCard.tsx`, `kiosk-theme.ts`, `pantalla.css` (ADR `0066`).
- **Pasos de prueba:**
  - [ ] Abrir `ScreenConsultorioPage.tsx` vinculada al Sillón $1$ y poner un paciente con alertas médicas en estado de atención en ese sillón.
- **Resultado esperado:** Visualización limpia con estética de pantalla dedicada (`pantalla.css`) mostrando el paciente actual, el odontólogo del sillón y las banderas críticas en `CriticalFlagsCard.tsx`.

---

### Módulo I: Notificaciones, Bot Conversacional y Políticas de Cancelación (`services/notifications`)

#### `NOT-01` — Estado del Bot, Configuración de Canales y Plantillas sin Comandos
- **Rutas / Componentes:** `NotificationsPage.tsx`, `BotStatusCard.tsx`, `CanalesSection.tsx`, `MessageTemplatesCard.tsx`, `TemplateResetDialog.tsx` (ADR `0008`, `0029`).
- **Pasos de prueba:**
  - [ ] Verificar el estado de conexión del bot en `BotStatusCard.tsx` y los canales activos en `CanalesSection.tsx`.
  - [ ] Editar el texto de una plantilla en `MessageTemplatesCard.tsx`, guardar y luego restaurarla con `TemplateResetDialog.tsx`.
- **Resultado esperado:** Las plantillas admiten variables dinámicas válidas, no exponen comandos técnicos crudos al paciente (`0002_plantillas_sin_comandos.sql`) y pueden restablecerse a su texto original.

#### `NOT-02` — Flujo Conversacional del Bot y Confirmación por el Paciente
- **Rutas / Componentes:** `asistente.ts`, `BotConversationsCard.tsx`, `PatientChannelCard.tsx`, `UpcomingAppointmentsCard.tsx` (ADR `0018`, `0052`).
- **Pasos de prueba:**
  - [ ] Vincular el canal de mensajería de un paciente (`PatientChannelCard.tsx`).
  - [ ] Enviar `/ayuda` o texto libre al bot para recibir el menú interactivo (`0003_ayuda_con_menu_de_comandos.sql`).
  - [ ] Confirmar una cita próxima (`0004_cita_confirmada_invita.sql`).
- **Resultado esperado:** El bot responde coherentemente, invita a agregar el evento al calendario o cancelar si es necesario (`0005_cita_invita_cancelar.sql`), actualiza la cita a **Confirmada** y registra la traza en `BotConversationsCard.tsx`.

#### `NOT-03` — Cancelación por el Paciente con Plazo Límite y Gestión de Novedades
- **Rutas / Componentes:** `CancellationPolicyCard.tsx`, `PatientCancellationsCard.tsx`, `ContactedDialog.tsx` (ADR `0053`, `0057`).
- **Pasos de prueba:**
  - [ ] En `CancellationPolicyCard.tsx`, configurar una ventana mínima de cancelación (ej. $24\text{ h}$ antes de la cita).
  - [ ] Intentar cancelar desde el bot una cita programada para dentro de $2\text{ h}$ (tiempo $\le 24\text{ h}$).
  - [ ] Cancelar desde el bot una cita programada para dentro de $48\text{ h}$ (tiempo $\ge 24\text{ h}$).
  - [ ] Ir a `SchedulingPage.tsx` / `NotificationsPage.tsx`, ubicar la novedad en `PatientCancellationsCard.tsx` y marcar al paciente como contactado en `ContactedDialog.tsx`.
- **Resultado esperado:**
  - El bot impide la cancelación libre fuera de plazo indicando los canales de contacto directo con la clínica.
  - La cancelación en plazo libera el cupo/ticket y crea un registro de novedad pendiente hasta que el personal lo gestione en `ContactedDialog.tsx`.

#### `NOT-04` — Historial de Envíos y Reintento Manual
- **Rutas / Componentes:** `NotificationsTable.tsx`, `NotificationDetailDialog.tsx`, `RetryNotificationDialog.tsx`.
- **Pasos de prueba:**
  - [ ] Abrir el detalle de una notificación en `NotificationDetailDialog.tsx` y verificar el payload/destinatario.
  - [ ] Ejecutar un reintento en `RetryNotificationDialog.tsx` sobre un registro con fallo de entrega.
- **Resultado esperado:** La notificación vuelve a procesarse por el adaptador activo y actualiza su estado a enviada/entregada.

---

### Módulo J: Caja, Facturación, Tasas BCV, Diferencial Cambiario, IVA/IGTF y Libros Fiscales (`services/billing`, `CajaPage.tsx`)

#### `CAJ-01` — Tasa BCV Histórica, Fecha Valor y Regla de Imputación
- **Rutas / Componentes:** `TasaDelDia.tsx`, `rate-service.ts`, `CobroDialog.tsx` (ADR `0046`, `0049`, `0069`).
- **Pasos de prueba:**
  - [ ] Establecer una tasa BCV de prueba (ej. $\$1 = 40{,}00\text{ Bs.}$) en `TasaDelDia.tsx` y emitir un documento de cobro.
  - [ ] Cambiar posteriormente la tasa del día a $\$1 = 42{,}50\text{ Bs.}$ y consultar el detalle del primer documento emitido.
  - [ ] Cobrar una factura declarando una **Fecha Valor** distinta de hoy (p. ej. un Pago Móvil del domingo registrado el lunes).
- **Resultado esperado:** El primer documento conserva inmutable su tasa histórica de $40{,}00\text{ Bs.}$ (ADR `0046`); el nuevo cobro se valora con la tasa **vigente para su Fecha Valor** —la del viernes, arrastrada por `rateForDate`— y no con la de hoy (ADR `0069`).

#### `CAJ-02` — Cobro, Partida Escrita a Mano y Cálculo Tributario (IVA + IGTF configurable)
- **Rutas / Componentes:** `CobroDialog.tsx`, `invoice-service.ts`, `payment-service.ts`, `TributarioSection.tsx` (ADR `0044`, `0045`, `0067`, `0069`).
- **Pasos de prueba:**
  - [ ] Abrir `CobroDialog.tsx`, seleccionar un paciente y agregar un ítem predeterminado por $\$100{,}00$.
  - [ ] Agregar una **partida escrita a mano** (concepto libre manual, ADR `0067`) por $\$50{,}00$ (Total base: $\$150{,}00$).
  - [ ] Con la clínica marcada como **Sujeto Pasivo Especial** y una alícuota de $3{,}00\%$ en `/configuracion`, registrar el pago dividiéndolo en dos métodos: $\$50{,}00$ equivalentes en Bolívares (Pago Móvil / Transferencia) y $\$100{,}00$ en Divisas Efectivo (USD).
  - [ ] Repetir el cobro con una alícuota distinta (ej. $2{,}00\%$) y comprobar que el sistema aplica el valor configurado.
- **Resultado esperado:**
  - Se aplican las alícuotas de IVA configuradas según el régimen de servicios de salud (exento o gravado según corresponda en ADR `0045`).
  - El **IGTF** se calcula con la **alícuota configurada** (por defecto $3{,}00\%$), **no** con un valor fijo: al cambiarla en `/configuracion` el cobro siguiente la refleja (ADR `0069`). En un pago mixto, el tributo se percibe solo sobre la porción percibida (en divisas), sin recargar la parte pagada en Bolívares.

#### `CAJ-03` — Numeración en Modo Software vs. Formas Libres y Archivo PDF
- **Rutas / Componentes:** `DocumentoDetalle.tsx`, `issue-service.ts`, `fiscal-forms-service.ts`, `invoice-pdf.ts`, `receipt-pdf.ts` (ADR `0047`, `0048`, `0049`).
- **Pasos de prueba:**
  - [ ] Emitir dos documentos consecutivos en modo software (serie por defecto `0004_serie_por_defecto_en_software.sql`) y verificar sus números correlativos.
  - [ ] Probar el registro de lote de formas libres / números de control (`fiscal-forms-service.ts`) cuando aplica talonario fiscal.
  - [ ] Abrir `DocumentoDetalle.tsx` y descargar el PDF del documento.
- **Resultado esperado:** Correlativos sin saltos ni duplicados (ADR `0047`); el PDF descargado coincide con el snapshot archivado en el almacén cifrado (ADR `0048`).

#### `CAJ-04` — Descarte de Borradores, Anulación y Notas de Crédito (Administrativa vs. Reembolso)
- **Rutas / Componentes:** `AnularDialog.tsx`, `credit-note-service.ts`, `credit-note-pdf.ts` (`0002_descartar_borrador.sql`) (ADR `0048`, `0069`).
- **Pasos de prueba:**
  - [ ] Crear un borrador de cobro y descartarlo antes de emitir.
  - [ ] Seleccionar una factura ya cobrada (con diferencial cambiario realizado) y anularla por **corrección administrativa** (`ADMINISTRATIVE`) mediante `AnularDialog.tsx`, ingresando el motivo fiscal.
  - [ ] Repetir sobre otra factura cobrada anulando por **reembolso real** (`REFUND`).
- **Resultado esperado:**
  - El borrador descartado no consume correlativo fiscal.
  - La factura emitida genera una Nota de Crédito con su propio correlativo y PDF archivado (`credit-note-pdf.ts`), **siempre a la tasa original de la factura**.
  - La anulación `ADMINISTRATIVE` **conserva** el diferencial cambiario ya realizado; la `REFUND` lo **reversa** (ADR `0069`).

#### `CAJ-05` — Cuadre de los Libros Fiscales (Ventas, Diferencial Cambiario e IGTF)
- **Rutas / Componentes:** `book-service.ts`, `book-routes.ts`, `CajaPage.tsx` (ADR `0069`).
- **Pasos de prueba:**
  - [ ] Generar el **Libro de Ventas** del período (`GET /api/v1/billing/books/sales.csv`) tras haber emitido facturas, cobros con IGTF y una Nota de Crédito.
  - [ ] Descargar el **Estado de Ganancias y Pérdidas por Diferencial Cambiario** (`books/exchange-diff.csv`) y el **Reporte de Percepción IGTF** (`books/igtf.csv`), y consultar el resumen del período (`books/summary`).
- **Resultado esperado:** El Libro de Ventas lista cronológicamente cada factura y nota de crédito cuadrando base exenta, base imponible e IVA; el libro cambiario cuadra $\text{neto} = \text{ganancias} - \text{pérdidas} + \text{reversiones}$; y el resumen del IGTF separa el arqueo de **Caja Divisas** del de **Banco/Caja Bs.**

#### `CAJ-06` — Fecha Valor y Validación de Rango
- **Rutas / Componentes:** `CobroDialog.tsx`, `payment-service.ts`, `rate-service.ts` (ADR `0046`, `0069`).
- **Pasos de prueba:**
  - [ ] Con una tasa publicada el viernes, cobrar el lunes una factura declarando la **Fecha Valor** del domingo.
  - [ ] Intentar declarar una Fecha Valor **anterior a la emisión** de la factura y otra **posterior a hoy**.
- **Resultado esperado:** El cobro del domingo se valora con la tasa del **viernes** (`rateForDate` arrastra; el BCV no publica fines de semana); una Fecha Valor fuera del rango $\text{emisión} \le \text{Fecha Valor} \le \text{hoy}$ se **rechaza** con un mensaje claro.

#### `CAJ-07` — Descomposición Tripartita del Cobro y Recibo
- **Rutas / Componentes:** `CobroDialog.tsx`, `DocumentoDetalle.tsx`, `receipt-pdf.ts` (ADR `0069`).
- **Pasos de prueba:**
  - [ ] Emitir una factura a la tasa de $1.000{,}00\text{ Bs./US\$}$ y cobrarla con una tasa vigente de $1.020{,}00\text{ Bs./US\$}$ (el caso **CP-01**: US$ 60 → 50.000 Bs. → 10.200 Bs.).
  - [ ] Abrir el recibo emitido (PDF) y el detalle de la factura en `DocumentoDetalle.tsx`.
- **Resultado esperado:** El recibo desglosa **Imputación a factura (tasa de emisión)**, **Ajuste por diferencial cambiario** y **Total recibido**, más el bloque fiscal del IGTF; el detalle muestra el diferencial acumulado ($+200{,}00\text{ Bs.}$) y la **suma de los históricos** cuadra con el total del documento.

#### `CAJ-08` — Absorción de Redondeo (Pago Móvil enteros) y Rechazo de Sobrepago
- **Rutas / Componentes:** `CobroDialog.tsx`, `payment-service.ts`, `bsPaymentBreakdown` (`packages/contracts`) (ADR `0069`).
- **Pasos de prueba:**
  - [ ] Cobrar una deuda de $\$10{,}00$ con un Pago Móvil en bolívares **enteros** cuya conversión deja un residuo de céntimos $\le 5$ céntimos de USD.
  - [ ] Intentar un sobrepago real superior a $5$ céntimos de USD.
- **Resultado esperado:** El residuo se **absorbe** en el diferencial y el cobro **salda el 100 %** de la deuda (badge «ajuste de redondeo absorbido» en `CobroDialog.tsx`), sin dejar saldos zombi de $\$0{,}01$; el sobrepago real se **rechaza**.

#### `CAJ-09` — IGTF Configurable con Destino de Caja
- **Rutas / Componentes:** `CobroDialog.tsx`, `TributarioSection.tsx`, `CajaPage.tsx` (ADR `0045`, `0069`).
- **Pasos de prueba:**
  - [ ] Con el consultorio marcado como **SPE**, cobrar una base en divisas declarando el IGTF en **USD** (Caja Divisas).
  - [ ] Cobrar otra base declarando el IGTF en **VES** (Banco/Caja Bs.), indicando el **medio** y la **referencia** del Pago Móvil.
  - [ ] Cobrar con **tarjeta en divisas** (el tributo lo debita el banco, Art. 4.5).
- **Resultado esperado:** Con destino `USD` el IGTF entra junto a la base a Caja Divisas; con `VES` la base va a Caja Divisas y el IGTF convertido (a la tasa de la Fecha Valor) a Banco/Caja Bs.; con tarjeta en divisas la clínica **no** vuelve a percibir (ADR `0045` se conserva).

#### `CAJ-10` — Anulación Administrativa vs. Reembolso sobre Factura con Diferencial
- **Rutas / Componentes:** `AnularDialog.tsx`, `credit-note-service.ts` (ADR `0069`).
- **Pasos de prueba:**
  - [ ] Sobre una factura con **diferencial ya realizado**, elegir anulación `ADMINISTRATIVE` (refacturación, sin devolución).
  - [ ] Sobre otra igual, elegir `REFUND` (reembolso real).
- **Resultado esperado:** La `ADMINISTRATIVE` deja `reversed_exchange_diff = 0` (el diferencial se conserva); la `REFUND` reversa el diferencial acumulado de los cobros vigentes; en **ambos** casos la nota fiscal sale a la **tasa original** de la factura.

#### `CAJ-11` — Libros del Período y Arqueo
- **Rutas / Componentes:** `book-routes.ts`, `book-service.ts`, `CajaPage.tsx` (ADR `0069`).
- **Pasos de prueba:**
  - [ ] Generar un período con facturas, cobros con diferencial (ganancia y pérdida), IGTF en ambas monedas y una Nota de Crédito de cada tipo.
  - [ ] Descargar los tres CSV y consultar `books/summary`.
- **Resultado esperado:** El libro cambiario cuadra $\text{neto} = \text{ganancias} - \text{pérdidas} + \text{reversiones}$; el arqueo del IGTF separa Caja Divisas de Banco/Caja Bs.; los cobros anulados **no** cuentan como diferencial realizado.

---

### Módulo K: Reportes, Auditoría, Resiliencia y Copias de Seguridad

#### `REP-01` — Vistas Materializadas, Filtros, Permisos y Exportación CSV/PDF
- **Rutas / Componentes:** `ReportesPage.tsx`, `ReportTabs.tsx`, `ReportFilters.tsx`, `ReportKpis.tsx`, `ReportChart.tsx`, `ReportTable.tsx`, `ReportExportBar.tsx` (ADR `0019`, `0039`, `0040`).
- **Pasos de prueba:**
  - [x] En `/reportes`, presionar el botón de refrescar datos (`refresh.ts`) y recorrer las $8$ áreas de reporte: Embudo (*Funnel*), Capacidad, Ocupación por Sillón, Productividad por Odontólogo, Demografía, Perfil Clínico, Salud Bucal (incluyendo piezas extraídas `0006_extraida_salud_bucal.sql`) y Récipes.
  - [x] Cambiar el rango de fechas y el filtro de sillón en `ReportFilters.tsx`.
  - [x] Exportar un reporte en formato **CSV** y en formato **PDF** desde `ReportExportBar.tsx`.
- **Resultado esperado:** Las vistas materializadas se refrescan sin bloquear lecturas; las etiquetas multisillón (`0005_multisillon_etiquetas.sql`) aparecen bien identificadas; el CSV escapa caracteres especiales correctamente (`csv.ts`) y el PDF se genera con el membrete institucional (`report-html.ts`).

#### `AUD-01` — Consulta de Eventos de Auditoría, Diffs y Exportación
- **Rutas / Componentes:** `AuditoriaPage.tsx`, `AuditFilters.tsx`, `AuditTable.tsx`, `AuditDiffDialog.tsx`, `AuditExportButton.tsx`.
- **Pasos de prueba:**
  - [x] Filtrar por módulo/servicio, usuario actor y rango de fechas en `AuditFilters.tsx`.
  - [x] Hacer clic en un evento de modificación y revisar la comparativa de datos en `AuditDiffDialog.tsx`.
  - [x] Exportar el registro de auditoría usando `AuditExportButton.tsx`.
- **Resultado esperado:** Todos los eventos de dominio consumidos por `identity` muestran un resumen legible en español (`0003_resumen_de_auditoria.sql`) y no contienen duplicados gracias a la tabla de idempotencia (`0002_eventos_procesados.sql`).

#### `SYS-01` — Salud del Sistema, Colas Outbox / Dead-Letter y Respaldo/Restauración Completa
- **Rutas / Componentes:** `SystemHealthPanel.tsx`, `dead-letter-watcher.ts`, `tools/respaldo-manual.mjs`, `tools/verify-backup.mjs`, `odontocrm-restore.sh` / `.ps1` (ADR `0003`, `0068`).
- **Pasos de prueba:**
  - [x] Revisar en `SystemHealthPanel.tsx` el estado de todos los servicios, latencias de bases de datos y contadores de colas `outbox` y `dead-letter`.
  - [x] Ejecutar un respaldo completo con `node tools/respaldo-manual.mjs` y validarlo con `node tools/verify-backup.mjs`.
  - [x] Ejecutar el flujo de restauración y comprobar los archivos adjuntos de pacientes y PDFs de récipes/facturas (ADR `0068`).
- **Resultado esperado:** $0$ trabajos colgados en `dead-letter`; el archivo de respaldo supera la verificación de integridad y la restauración repone tanto las $9$ bases de datos PostgreSQL como el almacén de blobs cifrados (`0068-restaurar-repone-el-almacen.md`).

---

## 4. Registro de Ejecución de Pruebas (Sign-off)

| ID Bloque | Módulo / Alcance | Total Casos | Aprobados (`PASS`) | Fallidos (`FAIL`) | Bloqueados (`BLOCKED`) | Responsable QA | Fecha |
| :--- | :--- | :---: | :---: | :---: | :---: | :--- | :--- |
| `PRE` | Pre-Flight y Entorno | $5$ | $5$ | $0$ | $0$ | | 2026-10-18 |
| `E2E` | Ciclo de Vida Completo | $7$ | $6$ | $1$ | $0$ | | 2026-10-18 |
| `ID` | Identidad, Auth y RBAC | $5$ | $5$ | $0$ | $0$ | | 2026-10-18 |
| `CFG` | Configuración y Membrete | $4$ | $4$ | $0$ | $0$ | | 2026-10-18 |
| `PAC` | Pacientes y Adjuntos Cifrados | $4$ | | | | | |
| `AGE` | Agenda, Cupos y Tickets | $4$ | | | | | |
| `SEC` | Secretaría y Flujo Diario | $2$ | | | | | |
| `CLI` | Historia, Sesiones, Récipe y Dossier | $5$ | | | | | |
| `ODO` | Odontograma Anatómico | $4$ | | | | | |
| `SCR` | Pantallas Kiosko y SSE | $3$ | | | | | |
| `NOT` | Bot, Canales y Cancelaciones | $4$ | | | | | |
| `CAJ` | Caja, BCV, Diferencial, IVA/IGTF y Libros | $11$ | | | | | |
| `REP/AUD/SYS` | Reportes, Auditoría y Backups | $3$ | | | | | |

---

## 5. Registro de la corrida (2026-10-18)

Primera pasada completa de los bloques `PRE`, `E2E`, `ID` y `CFG` sobre una instalación Fedora de
pruebas (los $9$ microservicios más el gateway en pie). Los tres fallos de abajo **ya están
corregidos** en el árbol; quedan por re-ejecutar los tres casos para firmar el bloque.

| Bloque | Casos | Resultado | Observación |
| :--- | :---: | :--- | :--- |
| `PRE` | $5$ | $5$ PASS | Servicios, migraciones, entorno, semilla y banner de Modo Test correctos. |
| `E2E` | $7$ | $6$ PASS · $1$ FAIL | `E2E-04`: la pantalla del consultorio no se enteró del alta y firma de la historia. |
| `ID` | $5$ | $5$ PASS | El usuario desactivado en `ID-01` se volvió a activar al terminar la prueba. |
| `CFG` | $4$ | $4$ PASS | `CFG-04` pasó en la segunda pasada, después del arreglo del UUID: guarda y se refleja en el cobro. |

### 5.0 Hallazgos de la segunda pasada (mismo día)

Al re-probar `CFG-04` y el ciclo de caja aparecieron tres cosas más. Las tres están corregidas en el
árbol y con prueba.

#### `CAJ-12` — el historial de la caja salía **vacío** sin filtros

- **Síntoma.** `/caja` → **Historial** no listaba nada, aunque `/api/v1/billing/books/sales.csv`
  mostraba las facturas del período. Escribir un nombre en el buscador las hacía aparecer.
- **Causa.** `billingInvoiceListQuerySchema.search` usaba `optionalText`, que devuelve **`null`**
  cuando el parámetro no viene (en un cuerpo eso significa «vacía el campo»). El servicio compara
  con `undefined` para decidir si aplica el filtro, así que construía
  `patientName ilike '%null%'` y no encontraba nada. Cualquier filtro acompañado del `search`
  ausente heredaba el problema.
- **Arreglo.** `optionalQueryText` (nuevo, en `packages/contracts/src/common/optional.ts`): en una
  **URL**, ausente o vacío significa «sin filtro» y se normaliza a `undefined`. Lo usa el filtro del
  historial.
- **Cómo re-probar.** Abrir `/caja` → **Historial** sin tocar los filtros: tienen que salir las
  facturas del período. Añadir `from`/`to` o un estado y comprobar que el conjunto cambia.

#### `CLI-03` (adelanto) — «Cita que respalda la sesión» solo ofrecía «Sin cita»

- **Síntoma.** En la pestaña **Sesión clínica**, el desplegable de la cita que respalda la sesión
  mostraba únicamente «Sin cita (el paciente vino sin cita)», aunque el paciente tuviera citas
  programadas.
- **Causa.** La lista se pedía **solo del día de hoy** (`date=<hoy>`). Si la cita estaba programada
  para otro día —la sesión se abre desde la ficha del paciente, o el paciente viene antes de su
  cita— la lista llegaba vacía.
- **Arreglo.** `apps/web/src/components/clinical/session-appointments.ts` (nuevo) decide qué citas
  respaldan una sesión: las **pendientes** (`programada`, `notificada`, `confirmada`) y las del
  **circuito del día** (`en_sala_espera`, `llamado`, `en_consulta`), desde hoy y hasta dos meses;
  fuera quedan las cerradas (`atendido`, `no_asistio`, `cancelada`, `reprogramada`) y los días
  pasados. Se ordena con el paciente del sillón primero y la etiqueta muestra la **fecha** cuando
  no es de hoy. Solo se marca sola cuando no hay ambigüedad (una cita en curso o una única
  pendiente de hoy).
- **Cómo re-probar.** Con un paciente que tenga una cita `programada`/`confirmada` para otro día,
  abrir su tab **Sesión clínica**: la cita aparece en el desplegable con su fecha, y al abrir la
  sesión queda enlazada. Al cerrarla, «Marcar atendida» sale sin pedir motivo **si la cita está en
  consulta** (la máquina de estados solo admite `en_consulta → atendido`).

#### `CAJ-13` — el monto del cobro se quedaba con la moneda del medio anterior

- **Síntoma.** Un cobro en bolívares registraba un diferencial de céntimos aunque la tasa fuera la
  misma, y el recibo mostraba una imputación que no era el saldo.
- **Causa.** El campo del monto se rellenaba **solo si estaba vacío**. Al cambiar el medio de pago
  (por ejemplo de Zelle a Pago Móvil) el importe seguía siendo el de la otra moneda: 34,49 (US$) se
  cobraba como 34,49 **Bs.**, y la diferencia aparecía como diferencial cambiario.
- **Arreglo.** El monto es una **propuesta** mientras nadie lo escriba: se recalcula al cambiar el
  medio, la moneda, la tasa de la Fecha Valor o el saldo. Si el cajero lo escribe, se respeta. La
  fila de «Diferencial» solo se pinta cuando **no** es cero.
- **Cómo re-probar.** Abrir `CobroDialog`, cambiar de un medio en divisas a uno en bolívares y
  comprobar que el monto pasa a bolívares; cobrar sin tocarlo → `Diferencial` no aparece y queda
  `Bs. 0,00`.

#### Sobre el diferencial histórico que sigue en el libro

El libro cambiario del período conserva las pérdidas de la corrida anterior (`REC-000002`): ese
cobro se registró **antes** del arreglo, con el monto tecleado a mano y **450,05 Bs.** de menos, así
que la diferencia es real y no se puede «recalcular» sin anular el cobro. En una base de pruebas se
limpia con `AnularDialog` (reembolso) o `npm run db:reset`; en producción, el ADR `0069` manda
conservarlo tal cual.

### 5.1 `E2E-04` — la pantalla del consultorio no se refrescaba al firmar la historia

- **Síntoma.** Con la pantalla del consultorio abierta en otra pestaña, se registró la historia
  clínica con una alergia crítica y se firmó; la pantalla siguió mostrando «sin datos críticos»
  hasta pulsar **F5**. Las dos precisiones que cerraron el diagnóstico: la pestaña estaba **en
  segundo plano** y el paciente estaba **en consulta** (no solo llamado) en ese sillón.
- **Causa.** Dos capas, las dos necesarias:
  1. `services/screens` solo recalculaba y repartía estado cuando aplicaba un evento de **agenda**.
     Los eventos `clinical.record.*` se ignoraban, así que no salía ninguna trama SSE.
  2. El respaldo por HTTP (`useKioskState`, cada `SCREEN_REFRESH_MS` = 20 s) no llevaba
     `refetchIntervalInBackground`: React Query **pausa** el intervalo cuando el documento no está
     visible, que es justo como vive una pantalla de consultorio.
- **Arreglo.**
  - `services/screens/src/sala/clinical-refresh.ts` (nuevo) decide si el lote toca a un paciente que
    está **en pantalla** (`llamado` o `en_consulta`, sin `left_at`); si sí, republica el estado
    **completo** del consultorio. Las alertas se leen en vivo (`alertLookup`), así que la alergia
    recién escrita viaja en la misma trama.
  - Temas que cuentan: `clinical.record.created`, `.updated`, `.signed` y `.amended`; el paciente
    sale de `payload.profile.patientId` (la adenda ahora también publica el perfil).
  - `useKioskState` pide `refetchIntervalInBackground: true`: el respaldo de 20 s late también con la
    pestaña oculta.
- **Cómo re-probar.** Paciente **en consulta** en el sillón → abrir `/pantalla/consultorio` en otra
  pestaña y **dejarla en segundo plano** → escribir la anamnesis con una alergia y firmar → volver a
  la pestaña: la bandera crítica tiene que estar ya (objetivo: menos de $2$ s desde la firma, sin F5).

### 5.2 `CFG-04` — «Error interno de servidor» al activar el IGTF

- **Síntoma.** Marcar *Sujeto Pasivo Especial* en `/configuracion` → **Régimen tributario** devolvía
  un $500$ y no guardaba nada. El `401` que aparecía después en la consola era una re-consulta con el
  token de acceso ya caducado, no la causa.
- **Causa.** El log de billing lo dejó escrito: `ZodError: Invalid UUID` en
  `path: ["aggregateId"]`, lanzado por `toOutboxInsert` **dentro de la transacción** del `PATCH`.
  `billing_settings` es una fila única con `id` **entero** (`1`), y el sobre del evento y la carga de
  auditoría exigen un UUID; al fallar la publicación, la transacción revertía el cambio entero. El
  mismo defecto habría impedido registrar el cambio en `/auditoria` (`entityId` también es UUID).
- **Arreglo.** `stableUuid(key)` —UUID v5 determinista, que ya usaba la agenda para el cupo del
  día— se movió a `packages/kernel` y billing deriva de ahí el identificador de la configuración
  (`billing_settings:1`), tanto en `aggregateId` como en `entityId`. Es el grano correcto: el evento
  es de **la configuración**, no de la fila.
- **De paso.** `updateBillingSettingsSchema.speReference` pasa a `.optional()`: `optionalText`
  transforma el vacío a `null` pero su salida no era opcional, así que un `PATCH` que no mandara el
  oficio lo **borraba** (el PATCH promete ser parcial).
- **Cómo re-probar.** Con sesión nueva de `admin`: activar el interruptor, poner fecha y oficio,
  guardar → debe responder $200$ y verse en `/configuracion` al recargar; y en `/auditoria` tiene que
  aparecer `billing_settings_changed` con su antes y después. Con **Secretaría**, `PATCH` sigue
  dando $403$.

### 5.3 `E2E-06` — «pérdidas o ganancias por diferencial» mínimas con la misma tasa

- **Síntoma.** Cobros en bolívares a la **misma** tasa de la factura registraban un diferencial
  cambiario de céntimos.
- **Causa.** No era coma flotante: toda la aritmética es entera (`BigInt` y `divideHalfUp`). El
  diferencial de céntimos es la **absorción de redondeo** que ya prevé el ADR `0069` —se redondeó al
  bolívar entero al teclear el monto—, y el motivo de que se tecleara a mano es real: el campo se
  autocompleta con `formatBs`/`formatUsd` en `es-VE` («6.000,00») y `parseUsdToCents` **rechazaba**
  el separador de miles, así que el valor autocompletado quedaba inválido.
- **Arreglo.** `parseUsdToCents` acepta el separador de miles en las dos convenciones
  (`1.234,56` y `1,234.56`), valida el agrupado y sigue rechazando lo que no es un importe
  (`12,345`, `1.23.4`). El monto que la pantalla propone vuelve a ser el exacto.
- **Verificado en vivo** (2026-10-18, `odontocrm.local`): un cobro del saldo exacto en bolívares a la
  misma tasa (factura `A-3`, `REC-000005`) quedó con `exchangeDiffVesCentimos = 0` y
  `fxDifferenceCentsUsd = 0`. El arreglo del monto heredado de la otra moneda se describe en
  `CAJ-13` ($5.0$).
- **Cómo re-probar.** Cobrar el saldo de una factura en bolívares con la tasa de emisión vigente,
  **sin tocar** el monto autocompletado → `Diferencial` debe salir en `Bs. 0,00` y **sin** el badge
  «ajuste de redondeo absorbido». Si se teclea un monto redondeado al bolívar, el diferencial sigue
  apareciendo: es el comportamiento del ADR `0069`, no un fallo.

### 5.4 Nota de verificación automática

Los tres arreglos llevan prueba: `packages/kernel/src/stable-uuid.test.ts`,
`services/billing/src/settings.integration.test.ts` (el `PATCH` publica un sobre y una auditoría
válidos), `services/screens/src/screens.integration.test.ts` (la historia del paciente en el sillón
republica el consultorio; la de otro paciente, no) y los casos nuevos de
`apps/web/src/lib/caja.test.ts` (incluida la ida y vuelta `formatBs → parseUsdToCents`).

De la segunda pasada: `packages/contracts/src/domain/billing.test.ts` fija que el filtro sin texto
es «sin filtro» y no la cadena «null», y
`apps/web/src/components/clinical/session-appointments.test.ts` fija qué citas respaldan una sesión
y cuál se marca sola. La suite unitaria completa (`npm test`) pasa; las suites de integración se
ejecutan con `npm run test:integration`.
