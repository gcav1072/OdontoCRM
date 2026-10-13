# Plan Maestro de Pruebas Manuales End-to-End (QA) — OdontoCRM

**Proyecto:** OdontoCRM (Arquitectura de 9 Microservicios + API Gateway + SPA Web)  
**Propósito:** Validación funcional exhaustiva, pruebas de reglas de negocio (ADRs), casos límite (*edge cases*), pruebas negativas y verificación de efectos secundarios asíncronos (`pg-boss`, Outbox, SSE, Vistas Materializadas y Auditoría).

---

## 1. Lista de Verificación Previa (Pre-Flight Check)

Antes de iniciar la ejecución manual en el navegador, ejecuta y verifica los siguientes puntos en la terminal del entorno:

- [ ] **PRE-01 — Estado de los servicios:** Ejecutar `node tools/estado.mjs` (o verificar en `SystemHealthPanel`) y comprobar que el `gateway` y los $9$ microservicios (`identity`, `patients`, `scheduling`, `clinical`, `odontogram`, `notifications`, `screens`, `billing`, `reporting`) respondan en estado saludable (`OK`).
- [ ] **PRE-02 — Migraciones al día:** Ejecutar `node tools/verify-migrations.mjs` para confirmar que todas las bases de datos PostgreSQL por servicio tienen los esquemas de Drizzle sincronizados.
- [ ] **PRE-03 — Verificación de entorno y secretos:** Ejecutar `node tools/env-check.mjs` y `node tools/audit-conexiones.mjs` sin errores.
- [ ] **PRE-04 — Semilla de datos (Opcional para entorno limpio):** Si se prueba sobre una base limpia, ejecutar `node tools/db-reset.mjs` y `node tools/seed-test.mjs` seguidos de `node tools/seed-verify.mjs` (ADR `0042`).
- [ ] **PRE-05 — Identificación de Modo Test:** Verificar en la interfaz si aparece el banner superior de **Modo Test** (`TestModeBanner.tsx`, ADR `0020`), el cual intercepta los envíos reales de Telegram/WhatsApp hacia el adaptador simulado (`canales/simulado.ts`).

---

## 2. Flujo End-to-End (E2E) Transversal: Ciclo de Vida Completo del Paciente

> **Objetivo:** Validar sin interrupciones el recorrido completo de un paciente a través de los $9$ microservicios y sus eventos de dominio.

### Caso `E2E-01` al `E2E-07`: De la Solicitud de Cita al Cierre Contable y Auditoría

- [ ] **Paso 1 (`E2E-01` — Captación y Solicitud):**
  - Registrar un paciente nuevo en `/pacientes/nuevo` (`PatientRegistryPage.tsx`).
  - Crear una solicitud de cita para ese paciente desde `NewRequestDialog.tsx` (o mediante el bot conversacional en `services/notifications`).
  - **Resultado esperado:** El paciente existe en `services/patients` y su solicitud aparece como pendiente en `RequestQueuePanel.tsx` (`services/scheduling`).
- [ ] **Paso 2 (`E2E-02` — Asignación de Sillón, Ticket y Notificación `.ics`):**
  - Desde `SchedulingPage.tsx`, tomar la solicitud de la cola y abrir `AssignAppointmentDialog.tsx`.
  - Seleccionar un sillón activo y una franja horaria disponible en `SlotGrid.tsx`.
  - **Resultado esperado:** Se crea la cita con un **ticket consecutivo** del día (ADR `0011`), se descuenta $1$ cupo en `DayCapacityCard.tsx` y se encola una notificación de cita agendada con archivo de calendario `.ics` adjunto (`messaging.ics.test.ts`).
- [ ] **Paso 3 (`E2E-03` — Confirmación de Asistencia por el Paciente):**
  - Desde el canal del bot (o simulador en Modo Test), enviar la respuesta de confirmación de cita del paciente (ADR `0052`).
  - **Resultado esperado:** El estado de la cita cambia automáticamente a **Confirmada** en `DayAppointmentsTable.tsx` y `SecretariaAppointmentsTable.tsx` vía sincronización en tiempo real (`RealtimeSyncProvider.tsx`).
- [ ] **Paso 4 (`E2E-04` — Recepción, Llamado y Pantallas Kiosko SSE):**
  - Abrir en dos pestañas adicionales las pantallas Kiosko: `/pantalla/sala` (`ScreenLobbyPage.tsx`) y `/pantalla/consultorio` (`ScreenConsultorioPage.tsx`).
  - En `SecretariaPage.tsx`, marcar la llegada del paciente y luego accionar **Llamar a consultorio**.
  - **Resultado esperado:** La pantalla de Sala anuncia el ticket/nombre mediante síntesis de voz (`kiosk-speech.ts`) vía SSE (ADR `0030`), y la pantalla de Consultorio muestra al paciente junto con sus alertas médicas críticas (`CriticalFlagsCard.tsx`, ADR `0035`).
- [ ] **Paso 5 (`E2E-05` — Atención Clínica, Odontograma, Récipe y Cierre de Sesión):**
  - Con sesión de Odontólogo en `ConsultorioPage.tsx` / `PatientDetailPage.tsx`, abrir el `PatientWorkspace.tsx`.
  - Llenar la historia clínica (`MedicalRecordForm.tsx`) incluyendo una alerta crítica (ej. alergia a AINEs), registrar el consentimiento (`ConsentDialog.tsx`) y firmar la historia (`SignRecordDialog.tsx`, ADR `0016`).
  - En `OdontogramPanel.tsx`, registrar hallazgos por cara y de pieza completa, además de una prótesis (`ProsthesisDialog.tsx`).
  - En `SessionPanel.tsx`, documentar la evolución de la sesión, emitir un récipe PDF (`PrescriptionDialog.tsx`) y cerrar la sesión (`CloseSessionDialog.tsx`) agendando el próximo control (`ScheduleNextAppointmentDialog.tsx`).
  - **Resultado esperado:** Historia firmada e inmutable; odontograma versionado; récipe PDF en dos mitades archivado con código QR verificable; sesión cerrada y cita pasada a estado **Atendida**.
- [ ] **Paso 6 (`E2E-06` — Caja, Tasa BCV, Cobro Mixto con IGTF y Facturación):**
  - Ir a `CajaPage.tsx`, verificar o fijar la tasa del día (`TasaDelDia.tsx`, ADR `0046`).
  - Abrir `CobroDialog.tsx` para el paciente atendido, agregar partidas del catálogo y $1$ partida manual a mano (ADR `0067`).
  - Registrar un pago mixto (parte en Bolívares y parte en USD efectivo) y emitir la factura.
  - **Resultado esperado:** Se calcula el IVA según el régimen tributario y el `$3\%$` de IGTF únicamente sobre la porción en divisas (ADR `0045`); se genera y archiva el PDF (`0048`) y se registra en el Libro de Ventas.
- [ ] **Paso 7 (`E2E-07` — Refresco de Reportes y Trazabilidad en Auditoría):**
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
  - [ ] Intentar iniciar sesión con un correo inexistente y luego con una contraseña errónea.
  - [ ] Desactivar un usuario de prueba desde una cuenta administradora (`UserStatusDialog.tsx`) e intentar iniciar sesión con dicho usuario.
  - [ ] Iniciar sesión con credenciales válidas de un usuario activo.
- **Resultado esperado:** Mensajes de error claros en español sin filtrar detalles internos del servidor; bloqueo total de acceso a usuarios inactivos; inicio de sesión exitoso y persistencia de sesión segura para el usuario activo.

#### `ID-02` — Compuerta obligatoria de cambio de contraseña (`MustChangePasswordGate`)
- **Rutas / Componentes:** `CreateUserDialog.tsx`, `ResetPasswordDialog.tsx`, `TemporaryPasswordDialog.tsx`, `MustChangePasswordGate.tsx`, `ChangePasswordPage.tsx`.
- **Pasos de prueba:**
  - [ ] Como Administrador en `UsersPage.tsx`, crear un usuario nuevo o restablecer la contraseña de uno existente y copiar la clave temporal mostrada en `TemporaryPasswordDialog.tsx`.
  - [ ] Iniciar sesión con ese usuario usando la clave temporal.
  - [ ] Intentar navegar forzosamente escribiendo en la barra de direcciones `/pacientes`, `/agenda` o `/caja`.
  - [ ] Completar el cambio de contraseña en `ChangePasswordPage.tsx`.
- **Resultado esperado:** Mientras la marca de cambio obligatorio esté activa, `MustChangePasswordGate` intercepta cualquier ruta y redirige a `/cambiar-contrasena`. Una vez cambiada, libera el acceso normal.

#### `ID-03` — Compuerta de perfil profesional incompleto (`NeedsProfileGate`)
- **Rutas / Componentes:** `NeedsProfileGate.tsx`, `CompleteProfilePage.tsx`, `EditUserProfileSection.tsx` (ADR `0061`).
- **Pasos de prueba:**
  - [ ] Crear un usuario con rol de **Odontólogo** sin completar sus datos de perfil profesional (especialidad, número de colegio/registro sanitario).
  - [ ] Iniciar sesión con dicho odontólogo y cambiar su contraseña temporal.
  - [ ] Intentar acceder al consultorio sin llenar el perfil.
  - [ ] Completar los datos requeridos en `CompleteProfilePage.tsx`.
- **Resultado esperado:** El sistema exige completar el perfil profesional antes de operar, garantizando que el membrete de récipes e historias siempre cuente con los datos del especialista.

#### `ID-04` — Control de acceso por rol y permisos granulares (RBAC)
- **Rutas / Componentes:** `RequirePermission.tsx`, `Sidebar.tsx`, `MobileNav.tsx`, `ForbiddenPage.tsx`, `admin-guard.ts` (ADR `0005`, `0038`, `0039`).
- **Pasos de prueba:**
  - [ ] Iniciar sesión con rol **Secretaría** y verificar qué elementos aparecen en el menú lateral (`Sidebar.tsx`).
  - [ ] Escribir manualmente en el navegador la ruta `/usuarios`, `/auditoria` y `/configuracion`.
  - [ ] Intentar consultar la pestaña de reportes clínicos sin el permiso específico (ADR `0039`).
- **Resultado esperado:** El menú oculta los módulos no autorizados; el acceso directo por URL muestra `ForbiddenPage.tsx` (HTTP $403$ en el Gateway).

#### `ID-05` — Regla "Un odontólogo, un sillón"
- **Rutas / Componentes:** `CreateUserDialog.tsx`, `EditUserDialog.tsx`, `chair-service.ts` (ADR `0006`, `0059`).
- **Pasos de prueba:**
  - [ ] Verificar la asignación de sillón al crear o editar un usuario con rol Odontólogo.
  - [ ] Comprobar cómo se refleja ese sillón como recurso en `SchedulingPage.tsx` y `FlujoPage.tsx`.
- **Resultado esperado:** Cada odontólogo opera sobre su sillón asignado y el sillón actúa como el recurso primario de la agenda.

---

### Módulo B: Configuración de Clínica, Marca e Imprimibles (`ConfiguracionPage.tsx`)

#### `CFG-01` — Identidad del consultorio en base de datos
- **Rutas / Componentes:** `MarcaSection.tsx`, `ClinicIdentityProvider.tsx` (ADR `0056`, `0058`).
- **Pasos de prueba:**
  - [ ] Ir a `/configuracion` (`ConfiguracionPage.tsx`) y modificar el nombre comercial del consultorio, razón social, RIF, dirección, teléfono y logo.
  - [ ] Guardar los cambios y recargar la aplicación.
- **Resultado esperado:** La nueva identidad persiste en la base de datos (`services/identity`), se actualiza en `AppHeader.tsx`, `MarcaTile.tsx` y en el encabezado de todos los documentos imprimibles sin tocar el código fuente.

#### `CFG-02` — Selector de acento, tema visual y tipografías por rol
- **Rutas / Componentes:** `AcentoSection.tsx`, `AccentPicker.tsx`, `ThemeSelector.tsx`, `RolTipografico.tsx` (ADR `0055`, `0063`).
- **Pasos de prueba:**
  - [ ] Cambiar el color de acento en `AccentPicker.tsx` y alternar entre modo claro y oscuro en `ThemeSelector.tsx`.
  - [ ] En `RolTipografico.tsx`, cambiar la fuente de títulos/marca (ej. *Poppins*, *Montserrat*, *Dancing Script*, *Lobster*, *Pacifico*) y la fuente de cuerpo (ej. *Inter*).
- **Resultado esperado:** Los tokens CSS (`tokens.css`) se actualizan al instante en toda la interfaz y los documentos imprimibles combinan únicamente las $2$ tipografías configuradas (ADR `0055`).

#### `CFG-03` — Membrete configurable en caliente y tamaño de papel del récipe
- **Rutas / Componentes:** `MembreteSection.tsx`, `MembreteDocumento.tsx`, `MargenDeImpresion.tsx`, `MarcaDeAgua.tsx` (ADR `0054`, `0064`, `0065`).
- **Pasos de prueba:**
  - [ ] Modificar la configuración del membrete (visibilidad de elementos, alineación, marca de agua, márgenes) y seleccionar el formato de papel del récipe (`0007_papel_del_recipe.sql`).
  - [ ] Sin reiniciar ningún servicio, abrir la impresión de una Historia Clínica (`MedicalRecordPrintPage.tsx`), un Odontograma (`OdontogramPrintPage.tsx`) y generar un Récipe PDF.
- **Resultado esperado:** Los cambios de membrete se aplican en caliente en todos los imprimibles y el récipe se ajusta a las dimensiones del papel de la clínica.

---

### Módulo C: Gestión de Pacientes y Almacenamiento Cifrado (`services/patients`)

#### `PAC-01` — Registro de pacientes y reglas de identificación (Adultos, Menores y Extranjeros)
- **Rutas / Componentes:** `PatientRegistryPage.tsx`, `PatientForm.tsx`, `PatientFields.tsx` (ADR `0007`).
- **Pasos de prueba:**
  - [ ] Registrar un paciente **Adulto** con cédula venezolana (`V-...`) válida.
  - [ ] Intentar registrar un segundo paciente adulto con la **misma cédula**.
  - [ ] Registrar un paciente **Menor de edad sin cédula** asociándolo a los datos de su representante.
  - [ ] Registrar un paciente con documento **Extranjero / Pasaporte** (`E-...` / `P-...`).
  - [ ] Probar el envío del formulario con campos obligatorios vacíos o teléfonos con formato inválido.
- **Resultado esperado:** Validaciones Zod en español (`zod-es.ts`); rechazo de cédula duplicada en titulares; creación correcta de menores sin cédula propia usando secuencia/vínculo de representante.

#### `PAC-02` — Búsqueda con *debounce*, edición y diálogo de diferencias (`Diff`)
- **Rutas / Componentes:** `PatientsPage.tsx`, `PatientSearchList.tsx`, `PatientDiffDialog.tsx`.
- **Pasos de prueba:**
  - [ ] En `/pacientes`, buscar por fragmento de nombre, apellido, teléfono y número de documento.
  - [ ] Entrar al detalle del paciente (`PatientDetailPage.tsx`), modificar teléfono y dirección, y confirmar en `PatientDiffDialog.tsx`.
- **Resultado esperado:** Búsqueda fluida sin sobrecargar la red (`useDebouncedValue.ts`); el diálogo `PatientDiffDialog` muestra claramente el valor anterior frente al valor nuevo antes de guardar.

#### `PAC-03` — Adjuntos de pacientes y cifrado en reposo (`Blob Store`)
- **Rutas / Componentes:** `PatientAttachments.tsx`, `packages/storage/src/blob-store.ts`, `crypto.ts`.
- **Pasos de prueba:**
  - [ ] Subir una imagen (`.jpg`/`.png`) y un documento `.pdf` en la sección de adjuntos del paciente.
  - [ ] Previsualizar o descargar ambos archivos desde la interfaz web.
  - [ ] Inspeccionar el archivo físico guardado en el directorio de almacenamiento en disco (o ejecutar `node tools/verificar-almacen.mjs`).
- **Resultado esperado:** El usuario autorizado descarga el archivo original desencriptado al vuelo, mientras que en el disco duro el blob está cifrado criptográficamente y no es legible directamente.

#### `PAC-04` — Cambio de estado y borrado lógico (*Soft Delete*)
- **Rutas / Componentes:** `PatientStatusDialog.tsx`, `PatientDeleteDialog.tsx` (ADR `0027`).
- **Pasos de prueba:**
  - [ ] Cambiar el estado de un paciente a inactivo desde `PatientStatusDialog.tsx`.
  - [ ] Ejecutar el borrado de un paciente con historial desde `PatientDeleteDialog.tsx`.
- **Resultado esperado:** El paciente se marca con borrado lógico en base de datos; desaparece de los listados activos para agendar nuevas citas, pero sus citas históricas, sesiones clínicas y facturas previas no se rompen ni pierden referencia.

---

### Módulo D: Agenda, Cupos, Solicitudes y Tickets (`services/scheduling`)

#### `AGE-01` — Configuración de cupos, franjas únicas y formato de $12\text{ h}$
- **Rutas / Componentes:** `SchedulingPage.tsx`, `DayToolbar.tsx`, `CapacityDialog.tsx`, `TemplatesDialog.tsx`, `DayCapacityCard.tsx` (ADR `0009`, `0025`).
- **Pasos de prueba:**
  - [ ] Abrir `CapacityDialog.tsx` para una fecha futura y definir el cupo máximo y las franjas horarias por sillón.
  - [ ] Guardar una plantilla en `TemplatesDialog.tsx` y aplicarla a otro día de la semana.
  - [ ] Intentar crear dos franjas idénticas/solapadas para el mismo sillón.
- **Resultado esperado:** El índice único (`0001_indice_de_franja_unica.sql`) impide duplicar la misma franja en un sillón; todas las horas en `SlotGrid.tsx` y tablas se expresan en formato de $12\text{ horas}$ (`AM`/`PM`).

#### `AGE-02` — Cola de solicitudes, asignación de cita y ticket consecutivo
- **Rutas / Componentes:** `RequestQueuePanel.tsx`, `NewRequestDialog.tsx`, `AssignAppointmentDialog.tsx`, `SlotPickerFields.tsx` (ADR `0011`).
- **Pasos de prueba:**
  - [ ] Crear $3$ solicitudes de cita en `NewRequestDialog.tsx`.
  - [ ] Asignar las $3$ solicitudes al mismo día y sillón mediante `AssignAppointmentDialog.tsx`.
  - [ ] Intentar asignar una cuarta cita en una franja cuyo cupo ya llegó a $0$.
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
  - [ ] Inspeccionar los cuadrantes permanentes ($1, 2, 3, 4$) y temporales ($5, 6, 7, 8$) en `OdontogramChart.tsx`.
  - [ ] Activar la vista de dentición mixta para un paciente pediátrico/adolescente.
- **Resultado esperado:** Disposición en posición anatómica estándar (ADR `0033`), geometría de $5$ caras por pieza y soporte simultáneo de piezas permanentes y deciduas (ADR `0051`).

#### `ODO-02` — Precedencia de Pieza Completa sobre Caras y Convivencia de Tratamientos
- **Rutas / Componentes:** `ToothFindingSheet.tsx`, `QuickEntryBar.tsx`, `chart-service.ts` (ADR `0031`, `0032`, `docs/ODONTOGRAMA_REGLAS.md`).
- **Pasos de prueba:**
  - [ ] En la pieza $26$, registrar **Caries** en la cara Oclusal (`O`) y **Obturación/Restauración** en la cara Mesial (`M`).
  - [ ] Sobre la misma pieza $26$, registrar un tratamiento de pieza completa compatible (ej. **Endodoncia**).
  - [ ] Posteriormente, sobre la pieza $26$, registrar **Exodoncia / Diente Ausente**.
  - [ ] Probar también la entrada rápida por teclado/barra en `QuickEntryBar.tsx`.
- **Resultado esperado:**
  - Al agregar Endodoncia, se conservan los hallazgos de las caras `O` y `M` según la matriz de convivencia (ADR `0032`).
  - Al marcar Diente Ausente / Exodoncia total, la condición de pieza completa prevalece sobre las caras (ADR `0031`).

#### `ODO-03` — Registro de Prótesis Removibles y Fijas
- **Rutas / Componentes:** `ProsthesisDialog.tsx`, `ProsthesisOverlay.tsx` (ADR `0062`).
- **Pasos de prueba:**
  - [ ] Abrir `ProsthesisDialog.tsx` y registrar una prótesis parcial removible o puente seleccionando las piezas involucradas y su estado (en buen estado / defectuosa / planificada).
- **Resultado esperado:** `ProsthesisOverlay.tsx` renderiza gráficamente el aparato protésico sobre el arco correspondiente sin solapar erróneamente otros indicadores.

#### `ODO-04` — Historial de Snapshots e Impresión del Odontograma
- **Rutas / Componentes:** `OdontogramHistory.tsx`, `OdontogramHistoryPage.tsx`, `OdontogramStaticChart.tsx`, `OdontogramPrintPage.tsx`, `OdontogramDocument.tsx`.
- **Pasos de prueba:**
  - [ ] Realizar modificaciones en el odontograma en dos momentos distintos, abrir `OdontogramHistoryPage.tsx` y seleccionar cada versión histórica.
  - [ ] Abrir `OdontogramPrintPage.tsx` y generar la vista de impresión.
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

### Módulo J: Caja, Facturación, Tasas BCV, IVA/IGTF y Libros Fiscales (`services/billing`, `CajaPage.tsx`)

#### `CAJ-01` — Tasa BCV Histórica y Regla de Imputación
- **Rutas / Componentes:** `TasaDelDia.tsx`, `rate-service.ts` (ADR `0046`, `0049`).
- **Pasos de prueba:**
  - [ ] Establecer una tasa BCV de prueba (ej. $\$1 = 40{,}00\text{ Bs.}$) en `TasaDelDia.tsx` y emitir un documento de cobro.
  - [ ] Cambiar posteriormente la tasa del día a $\$1 = 42{,}50\text{ Bs.}$ y consultar el detalle del primer documento emitido.
- **Resultado esperado:** El primer documento conserva inmutable su tasa histórica de $40{,}00\text{ Bs.}$, mientras que los nuevos cobros aplican $42{,}50\text{ Bs.}$ (ADR `0046`).

#### `CAJ-02` — Cobro, Partida Escrita a Mano y Cálculo Tributario (IVA + IGTF `$3\%$`)
- **Rutas / Componentes:** `CobroDialog.tsx`, `invoice-service.ts`, `payment-service.ts` (ADR `0044`, `0045`, `0067`).
- **Pasos de prueba:**
  - [ ] Abrir `CobroDialog.tsx`, seleccionar un paciente y agregar un ítem predeterminado por $\$100{,}00$.
  - [ ] Agregar una **partida escrita a mano** (concepto libre manual, ADR `0067`) por $\$50{,}00$ (Total base: $\$150{,}00$).
  - [ ] Registrar el pago dividiéndolo en dos métodos: $\$50{,}00$ equivalentes en Bolívares (Pago Móvil / Transferencia) y $\$100{,}00$ en Divisas Efectivo (USD).
- **Resultado esperado:**
  - Se aplican las alícuotas de IVA configuradas según el régimen de servicios de salud (exento o gravado según corresponda en ADR `0045`).
  - Se calcula exactamente el `$3\%$` de **IGTF** únicamente sobre los $\$100{,}00$ pagados en divisas ($\text{IGTF} = \$3{,}00$), sin recargar los $\$50{,}00$ pagados en Bolívares.

#### `CAJ-03` — Numeración en Modo Software vs. Formas Libres y Archivo PDF
- **Rutas / Componentes:** `DocumentoDetalle.tsx`, `issue-service.ts`, `fiscal-forms-service.ts`, `invoice-pdf.ts`, `receipt-pdf.ts` (ADR `0047`, `0048`, `0049`).
- **Pasos de prueba:**
  - [ ] Emitir dos documentos consecutivos en modo software (serie por defecto `0004_serie_por_defecto_en_software.sql`) y verificar sus números correlativos.
  - [ ] Probar el registro de lote de formas libres / números de control (`fiscal-forms-service.ts`) cuando aplica talonario fiscal.
  - [ ] Abrir `DocumentoDetalle.tsx` y descargar el PDF del documento.
- **Resultado esperado:** Correlativos sin saltos ni duplicados (ADR `0047`); el PDF descargado coincide con el snapshot archivado en el almacén cifrado (ADR `0048`).

#### `CAJ-04` — Descarte de Borradores, Anulación y Notas de Crédito
- **Rutas / Componentes:** `AnularDialog.tsx`, `credit-note-service.ts`, `credit-note-pdf.ts` (`0002_descartar_borrador.sql`).
- **Pasos de prueba:**
  - [ ] Crear un borrador de cobro y descartarlo antes de emitir.
  - [ ] Seleccionar una factura ya emitida y anularla / generar Nota de Crédito mediante `AnularDialog.tsx` ingresando el motivo fiscal.
- **Resultado esperado:** El borrador descartado no consume correlativo fiscal; la factura emitida genera una Nota de Crédito con su propio correlativo y PDF archivado (`credit-note-pdf.ts`).

#### `CAJ-05` — Cuadre del Libro Fiscal de Ventas
- **Rutas / Componentes:** `book-service.ts`, `book-routes.ts`.
- **Pasos de prueba:**
  - [ ] Generar el Libro de Ventas del período actual tras haber emitido facturas, cobros con IGTF y una Nota de Crédito.
- **Resultado esperado:** El libro lista cronológicamente cada factura y nota de crédito, cuadrando las sumatorias de base exenta, base imponible, IVA e IGTF en Bolívares.

---

### Módulo K: Reportes, Auditoría, Resiliencia y Copias de Seguridad

#### `REP-01` — Vistas Materializadas, Filtros, Permisos y Exportación CSV/PDF
- **Rutas / Componentes:** `ReportesPage.tsx`, `ReportTabs.tsx`, `ReportFilters.tsx`, `ReportKpis.tsx`, `ReportChart.tsx`, `ReportTable.tsx`, `ReportExportBar.tsx` (ADR `0019`, `0039`, `0040`).
- **Pasos de prueba:**
  - [ ] En `/reportes`, presionar el botón de refrescar datos (`refresh.ts`) y recorrer las $8$ áreas de reporte: Embudo (*Funnel*), Capacidad, Ocupación por Sillón, Productividad por Odontólogo, Demografía, Perfil Clínico, Salud Bucal (incluyendo piezas extraídas `0006_extraida_salud_bucal.sql`) y Récipes.
  - [ ] Cambiar el rango de fechas y el filtro de sillón en `ReportFilters.tsx`.
  - [ ] Exportar un reporte en formato **CSV** y en formato **PDF** desde `ReportExportBar.tsx`.
- **Resultado esperado:** Las vistas materializadas se refrescan sin bloquear lecturas; las etiquetas multisillón (`0005_multisillon_etiquetas.sql`) aparecen bien identificadas; el CSV escapa caracteres especiales correctamente (`csv.ts`) y el PDF se genera con el membrete institucional (`report-html.ts`).

#### `AUD-01` — Consulta de Eventos de Auditoría, Diffs y Exportación
- **Rutas / Componentes:** `AuditoriaPage.tsx`, `AuditFilters.tsx`, `AuditTable.tsx`, `AuditDiffDialog.tsx`, `AuditExportButton.tsx`.
- **Pasos de prueba:**
  - [ ] Filtrar por módulo/servicio, usuario actor y rango de fechas en `AuditFilters.tsx`.
  - [ ] Hacer clic en un evento de modificación y revisar la comparativa de datos en `AuditDiffDialog.tsx`.
  - [ ] Exportar el registro de auditoría usando `AuditExportButton.tsx`.
- **Resultado esperado:** Todos los eventos de dominio consumidos por `identity` muestran un resumen legible en español (`0003_resumen_de_auditoria.sql`) y no contienen duplicados gracias a la tabla de idempotencia (`0002_eventos_procesados.sql`).

#### `SYS-01` — Salud del Sistema, Colas Outbox / Dead-Letter y Respaldo/Restauración Completa
- **Rutas / Componentes:** `SystemHealthPanel.tsx`, `dead-letter-watcher.ts`, `tools/respaldo-manual.mjs`, `tools/verify-backup.mjs`, `odontocrm-restore.sh` / `.ps1` (ADR `0003`, `0068`).
- **Pasos de prueba:**
  - [ ] Revisar en `SystemHealthPanel.tsx` el estado de todos los servicios, latencias de bases de datos y contadores de colas `outbox` y `dead-letter`.
  - [ ] Ejecutar un respaldo completo con `node tools/respaldo-manual.mjs` y validarlo con `node tools/verify-backup.mjs`.
  - [ ] Ejecutar el flujo de restauración y comprobar los archivos adjuntos de pacientes y PDFs de récipes/facturas (ADR `0068`).
- **Resultado esperado:** $0$ trabajos colgados en `dead-letter`; el archivo de respaldo supera la verificación de integridad y la restauración repone tanto las $9$ bases de datos PostgreSQL como el almacén de blobs cifrados (`0068-restaurar-repone-el-almacen.md`).

---

## 4. Registro de Ejecución de Pruebas (Sign-off)

| ID Bloque | Módulo / Alcance | Total Casos | Aprobados (`PASS`) | Fallidos (`FAIL`) | Bloqueados (`BLOCKED`) | Responsable QA | Fecha |
| :--- | :--- | :---: | :---: | :---: | :---: | :--- | :--- |
| `PRE` | Pre-Flight y Entorno | $5$ | | | | | |
| `E2E` | Ciclo de Vida Completo | $7$ | | | | | |
| `ID` | Identidad, Auth y RBAC | $5$ | | | | | |
| `CFG` | Configuración y Membrete | $3$ | | | | | |
| `PAC` | Pacientes y Adjuntos Cifrados | $4$ | | | | | |
| `AGE` | Agenda, Cupos y Tickets | $4$ | | | | | |
| `SEC` | Secretaría y Flujo Diario | $2$ | | | | | |
| `CLI` | Historia, Sesiones, Récipe y Dossier | $5$ | | | | | |
| `ODO` | Odontograma Anatómico | $4$ | | | | | |
| `SCR` | Pantallas Kiosko y SSE | $3$ | | | | | |
| `NOT` | Bot, Canales y Cancelaciones | $4$ | | | | | |
| `CAJ` | Caja, BCV, IVA/IGTF y Libros | $5$ | | | | | |
| `REP/AUD/SYS` | Reportes, Auditoría y Backups | $3$ | | | | | |