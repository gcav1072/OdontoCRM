# OdontoCRM — Plan Maestro por Fases

> **Estado:** propuesta para aprobación · **Fecha:** 2026-10-02 · **Zona horaria:** America/Caracas (UTC-4, sin DST)
> **Docs fuente:** [`formato_historia.md`](formato_historia.md) · [`implementation_plan_odontogram_microservice.md`](implementation_plan_odontogram_microservice.md)
> **Regla de oro:** una fase = una sesión agéntica = commits atómicos al cierre + tag. No se avanza de fase sin cumplir sus criterios de aceptación.

---

## Índice

1. [Decisiones cerradas](#1-decisiones-cerradas)
2. [Arquitectura](#2-arquitectura)
3. [Estructura del repositorio](#3-estructura-del-repositorio)
4. [Modelo de datos por servicio](#4-modelo-de-datos-por-servicio)
5. [Máquina de estados](#5-máquina-de-estados)
6. [API y rutas del gateway](#6-api-y-rutas-del-gateway)
7. [Catálogo de eventos (outbox)](#7-catálogo-de-eventos-outbox)
8. [Bot de Telegram](#8-bot-de-telegram)
9. [Récipes y documentos](#9-récipes-y-documentos)
10. [Frontend: shell, panel inferior y pantallas](#10-frontend-shell-panel-inferior-y-pantallas)
11. [Seguridad y cumplimiento](#11-seguridad-y-cumplimiento)
12. [Modo test y seed determinista](#12-modo-test-y-seed-determinista)
13. [Fases de ejecución 0–10](#13-fases-de-ejecución-010)
14. [Convención de commits, ramas y tags](#14-convención-de-commits-ramas-y-tags)
15. [Qué hay que instalar](#15-qué-hay-que-instalar)
16. [Riesgos, supuestos y decisiones abiertas](#16-riesgos-supuestos-y-decisiones-abiertas)

---

## 1. Decisiones cerradas

Todas fueron confirmadas contigo en la sesión de planificación del 2026-10-02.

| # | Tema | Decisión |
| :-: | :--- | :--- |
| 1 | Infraestructura | **Nativo, sin Docker.** Windows = desarrollo/pruebas. **Fedora = producción** (documentación + scripts de instalación incluidos en la Fase 10). |
| 2 | Base de datos | **PostgreSQL 18** (ya instalado y corriendo en la máquina de desarrollo), **una base de datos por servicio** en la misma instancia, con usuario/rol propio por servicio. |
| 3 | Mensajería | **Transactional outbox + `pg-boss` sobre PostgreSQL**. Cero infraestructura extra; la interfaz `EventBus` permite migrar a RabbitMQ sin tocar dominios. |
| 4 | Granularidad | **9 servicios** (ver §2.2). |
| 5 | Autenticación | **JWT de acceso (15 min, EdDSA) + refresh rotativo en cookie `httpOnly`**; RBAC por módulo; **pantallas con token de dispositivo** (rol `pantalla`), no con usuario. |
| 6 | Personal | **Un odontólogo y un sillón.** Roles: `admin`, `secretario`, `odontologo` (+ rol técnico `pantalla`). El modelo guarda `dentist_id`/`chair_id` con un único registro por defecto para no migrar después. |
| 7 | Identificación | **V, E y P** + **menores sin cédula** con marcador temporal `SC-<código>`. Normalización a `V-12345678`; único por `(tipo, número)`. |
| 8 | Telegram | **Un único bot para siempre** (BotFather), **long polling** (funciona 100 % en LAN, sin exponer nada a internet), asistente paso a paso, **vinculación por deep link** `t.me/<bot>?start=<ticket>` y estado `notificación manual pendiente` si el paciente no tiene Telegram. |
| 9 | Programación | **Cupo diario editable** + **plantilla de franjas horarias** (duración, pausas) + **edición manual de la hora** por paciente. |
| 10 | Confirmaciones | Asignar deja la cita en `PROGRAMADA` y el aviso sale **solo** al formalizarla; el botón **«Notificar»** de la jornada **asegura** el aviso del lote (no repite el que ya salió, recupera el que quedó pendiente o fallido) y la casilla «reenviar también los ya notificados» **sí** vuelve a enviar. |
| 11 | Ticket | `#000123` con **secuencia global de PostgreSQL**; al superar 999999 salta a `A-000001` (y luego `B-…`). |
| 12 | Estados | Máquina de estados de §5 **aprobada**. |
| 13 | Frontend | **Vite + React + TS + Tailwind + shadcn/ui + TanStack Query/Table + React Hook Form + Zod**. |
| 14 | Acceso a datos | **SQL-first con Drizzle ORM** + migraciones versionadas por servicio. |
| 15 | Récipe | **PDF A5 en el servidor** (Playwright/Chromium) con **membrete configurable** (clínica + odontólogo con MPPS/especialidad), **numeración** y **QR de verificación**. |
| 16 | Firma | Registro de **«aceptado»** + documento imprimible para firmar en papel. Firma en canvas: opcional, fase posterior. |
| 17 | Marcado «atendido» | **Advertir y permitir continuar exigiendo motivo**, que queda en auditoría. |
| 18 | Alcance del bot (Fase 4) | Solicitar cita (asistente validado) + entregar ticket + **consultar estado** de la solicitud. RSVP y reprogramación: fase posterior. |
| 19 | Reportes | Embudo/tasa de inasistencia, salud bucal desde odontograma, demografía (edad/sexo), recetas por medicamento, **perfil clínico/crónicos** (viene de tu pedido original), exportación CSV/PDF. |
| 20 | Modo test | Variable de entorno + `npm run seed:test` / `seed:reset`, **banner MODO TEST**, cédulas ficticias en el rango reservado **90.000.000+**. |
| 21 | Acceso remoto futuro | **VPN mesh (Tailscale/WireGuard)**: el sistema nunca se expone a internet. El diseño ya lo asume (config por variables de entorno, sin IPs fijas, TLS interno). |
| 22 | Menú de comandos (2026-10-04) | **Menú `/` de Telegram** registrado con `setMyCommands` desde `BOT_COMMANDS` (contrato), en cada arranque y sin tocar BotFather; el botón del campo de texto muestra la lista (`setChatMenuButton`); la **ayuda** del asistente termina con la misma lista, generada del mismo catálogo, para quien no descubra el menú o use WhatsApp. Comprobación: `npm run telegram:menu`. |

---

## 2. Arquitectura

### 2.1 Vista general

```
                         ┌──────────────────────────────────────────┐
   Navegador (LAN)       │  apps/web  (React SPA + rutas kiosko)     │
   TV sala de espera ────┤  Panel inferior: sesión/tema/inicio       │
   Pantalla consultorio  └───────────────────┬──────────────────────┘
                                             │ HTTPS (interno) /api/v1/**
                                             ▼
                         ┌──────────────────────────────────────────┐
                         │  apps/gateway  (Fastify)                  │
                         │  · Proxy por recurso                      │
                         │  · Verifica JWT / token de dispositivo     │
                         │  · Rate limit · CORS · Request-Id          │
                         └───┬───────┬───────┬───────┬───────┬──────┘
                             │       │       │       │       │
        ┌────────────────────┘       │       │       │       └────────────────────┐
        ▼                            ▼       ▼       ▼                            ▼
 ┌────────────┐  ┌────────────┐  ┌────────────┐  ┌────────────┐  ┌────────────┐  ┌────────────┐
 │ identity   │  │ patients   │  │ scheduling │  │notifications│ │ clinical   │  │ odontogram │
 │ usuarios   │  │ pacientes  │  │ tickets    │  │ bot Telegram│ │ historia   │  │ FDI + SVG  │
 │ auth+audit │  │ +archivos  │  │ cupos/citas│  │ .ics/plant. │  │ sesiones   │  │ hallazgos  │
 └─────┬──────┘  └─────┬──────┘  └─────┬──────┘  └─────┬──────┘  └─────┬──────┘  └─────┬──────┘
       │               │               │               │               │               │
       │  ┌────────────┴───────────────┴───────────────┴───────────────┴───────────────┘
       │  │            ▲
       │  │            │  REST interno (service JWT) + eventos de dominio
       ▼  ▼            │
 ┌────────────┐  ┌────────────┐  ┌───────────────────────────────────────────────────┐
 │  screens   │  │ reporting  │  │  PostgreSQL 18 — una BD por servicio              │
 │ SSE kiosko │  │ KPIs/CSV   │  │  + outbox + cola pg-boss                          │
 └────────────┘  └────────────┘  └───────────────────────────────────────────────────┘
        ▲
        └── SSE: Displaylobby (llamados) y pantalla de consultorio (datos críticos)
```

**Regla de consistencia:** cada servicio es dueño exclusivo de su BD. Ningún servicio lee tablas de otro: se comunica por **REST interno** (lecturas/escrituras puntuales) o por **eventos** (propagación, read models, auditoría, KPIs).

### 2.2 Los 9 servicios

| # | Servicio | Responsabilidad | BD | Puerto dev |
| :-: | :--- | :--- | :--- | :-: |
| 1 | `apps/gateway` | Punto único de entrada, proxy por recurso, verificación de JWT/token de dispositivo, rate limit, CORS, correlación de peticiones. | — | 8090 |
| 2 | `services/identity` | Usuarios, roles/permisos, login, refresh rotativo, cambio/restablecimiento de contraseña, bloqueo por intentos, **auditoría** (eventos + consulta con diff). | `odonto_identity` | 4001 |
| 3 | `services/patients` | Paciente único (cédula V/E/P/SC), datos de contacto, representante de menores, estado (`en_espera_cita`, `activo`, `inactivo`), búsqueda/duplicados, **almacenamiento de archivos** (abstracción S3-ready sobre disco). | `odonto_patients` | 4002 |
| 4 | `services/scheduling` | Solicitudes (**ticket**), cola «en espera de cita», cupo diario editable, plantilla de franjas, asignación/reprogramación/cancelación, estados de la cita, inasistencias. | `odonto_scheduling` | 4003 |
| 5 | `services/notifications` | Bot de Telegram (long polling), asistente validado, plantillas, cola de envíos con reintentos e idempotencia, vinculación chat↔paciente por deep link, **generación de `.ics`**. | `odonto_notifications` | 4004 |
| 6 | `services/clinical` | Historia clínica estructurada (según `formato_historia.md`), sesiones clínicas, diagnósticos, **récipes**, adjuntos imagenológicos, **PDF A5** y QR de verificación. | `odonto_clinical` | 4005 |
| 7 | `services/odontogram` | Odontograma FDI de 2 dígitos, captura por excepción, histórico de hallazgos, eventos. Implementa `implementation_plan_odontogram_microservice.md`. | `odonto_odontogram` | 4006 |
| 8 | `services/screens` | Estado de las pantallas de sala y consultorio, turnos, llamados (1.º/2.º), **SSE** para actualización en vivo, registro de dispositivos kiosko. | `odonto_screens` | 4007 |
| 9 | `services/reporting` | Read model por eventos, vistas materializadas, KPIs, filtros (fecha, rango de edad, sexo, estado), exportación CSV/PDF. | `odonto_reporting` | 4008 |

> **Costo asumido:** 9 procesos + **9 bases** (las 8 de servicio más la cola de eventos) + outbox es más operación que un monolito modular. Se mitiga con un único comando de arranque (`npm run dev`), migraciones y seeds automatizados, health checks y el `ecosystem.config.cjs` de PM2. Si en la práctica resulta pesado, el camino de repliegue es fusionar `odontogram` + `clinical` y `screens` + `reporting` sin tocar contratos públicos.
>
> **La cola de eventos es compartida** (`odonto_events`, [ADR 0026](adr/0026-cola-de-eventos-compartida.md)): pg-boss guarda sus tablas en una sola base, así que una cola por servicio sería invisible para los demás. Cada servicio mantiene su propio `outbox_events` para la garantía transaccional y publica en esa cola común.

### 2.3 Comunicación

- **Síncrona (REST interno):** solo cuando se necesita la respuesta para continuar (p. ej. el bot necesita el `patientId` antes de crear la solicitud). Autenticada con **service JWT** (`HS256`, secreto interno, `sub=<servicio>`, `aud=<servicio destino>`, TTL 60 s) y ligada al `X-Request-Id`.
- **Asíncrona (outbox + pg-boss):** todo lo demás. El evento se escribe **en la misma transacción** que el cambio de datos (`outbox_events`) y un publicador lo entrega a `pg-boss` en su propia BD; los consumidores son idempotentes (clave `eventId`).
- **Tiempo real hacia pantallas:** **SSE** (`text/event-stream`) desde `screens`. Se elige SSE sobre WebSocket porque el flujo es unidireccional y sobrevive a reconexiones con `Last-Event-ID`.

### 2.4 Contratos compartidos

`packages/contracts` es la **única** fuente de verdad de DTOs, esquemas Zod, enums de estado y tipos del odontograma (los del doc existente se mueven aquí). Todo cambio de contrato es un commit propio y sube la versión del paquete; las rutas públicas viven bajo `/api/v1` (los endpoints internos bajo `/internal/v1`).

---

## 3. Estructura del repositorio

Monorepo con **npm workspaces** (Node 26 ya no incluye Corepack; `pnpm` no está instalado y no hace falta).

```
OdontoCRM/
├─ package.json                  # workspaces + scripts raíz (dev, verify, migrate, seed)
├─ tsconfig.base.json            # strict, ES2023, moduleResolution nodenext
├─ eslint.config.js  prettier     # lint/format únicos
├─ .gitignore  .env.example  .editorconfig
├─ README.md  CHANGELOG.md
├─ apps/
│  ├─ gateway/                   # Fastify + proxy + guardias
│  └─ web/                       # Vite + React SPA (+ rutas kiosko)
├─ services/
│  ├─ identity/ patients/ scheduling/ notifications/
│  └─ clinical/ odontogram/ screens/ reporting/
├─ packages/
│  ├─ contracts/                 # DTOs, Zod, enums, tipos de odontograma, catálogos
│  ├─ kernel/                    # plugins Fastify: config, logger, errors, health, requestId, auth, service-auth
│  ├─ db/                        # Drizzle: conexión, migrador, repositorio outbox, pg-boss
│  ├─ events/                    # catálogo de tópicos, envelope, publicador/consumidor
│  ├─ audit/                     # cliente de auditoría + diff de campos sensibles
│  ├─ ui/                        # design system (shadcn base + tokens de tema claro/oscuro)
│  └─ testing/                   # factories, fixtures, helpers de BD de prueba
├─ infra/
│  ├─ db/                        # bootstrap de roles/bases, plantillas SQL, backups
│  ├─ windows/                   # scripts de instalación/arranque + ecosystem PM2
│  └─ fedora/                    # dnf/systemd/scripts de producción (Fase 10)
├─ tools/                        # dev-all, migrate-all, seed:test, verify
└─ docs/
   ├─ formato_historia.md
   ├─ implementation_plan_odontogram_microservice.md
   ├─ PLAN_MAESTRO_FASES.md      # este documento
   ├─ SEGURIDAD_SECRETOS.md      # política de secretos y tokens (Fase 0)
   └─ adr/                       # una ADR por decisión de §1 (se crean en Fase 0)
```

---

## 4. Modelo de datos por servicio

Convenciones: `id uuid default gen_random_uuid()`, `created_at`/`updated_at` con `timestamptz`, `snake_case`, nombres de tabla en plural, **soft delete** solo donde la ley clínica lo exige (nunca en eventos ni auditoría).

### 4.1 `identity`
- `users` (`username` único, `full_name`, `email?`, `password_hash` **scrypt** de `node:crypto` — sin dependencias nativas en Windows, `must_change_password`, `is_active`, `failed_attempts`, `locked_until`, `last_login_at`).
- `roles` / `permissions` / `role_permissions` / `user_roles` — semilla: `admin` (todo), `secretario` (recepción, registro, secretaría, programación, reportes operativos), `odontologo` (consultorio, historia, odontograma, récipes, pantalla de consultorio), `pantalla` (solo lectura de las 2 pantallas).
- `refresh_tokens` (hash, `family_id`, `rotated_at`, `revoked_at`, `reuse_detected` → revoca la familia).
- `device_tokens` (pantallas kiosko: `label`, `token_hash`, `last_seen_at`, `is_active`).
- **Auditoría:** `audit_events` (`occurred_at`, `actor_id`, `actor_roles`, `action`, `entity_type`, `entity_id`, `before jsonb`, `after jsonb`, `changed_fields text[]`, `reason`, `ip`, `user_agent`, `request_id`) + índices por fecha, actor, entidad y campo; `audit_exports`.

### 4.2 `patients`
- `patients`: `doc_type` (`V|E|P|SC`), `doc_number`, `full_name`, `birth_date`, `sex` (`M|F|O`), `phone`, `phone_alt?`, `email?`, `address?`, `occupation?`, `status` (`en_espera_cita|activo|inactivo`), `is_fictitious` (**rango 90.000.000+ del modo test**), `notes?`, `promoted_from_sc_at?`. Único parcial: `(doc_type, doc_number) WHERE deleted_at IS NULL`.
  - **Transiciones del estado**: `en_espera_cita → activo` **sola**, cuando la agenda publica la cita asignada (proyección por evento, `services/patients/src/consumer.ts`); `activo → inactivo` y vuelta a `activo` **a mano**, con motivo y auditoría. Ningún evento revierte una baja.
- `patient_guardians` (representante de menores: nombre, cédula, parentesco, teléfono).
- `patient_contacts_history` (teléfono/dirección anteriores → alimenta auditoría de datos sensibles).
- `files` (metadatos de adjuntos: `owner_type`, `owner_id`, `kind` (`radiografia|foto|pdf|consentimiento`), `mime`, `size`, `sha256`, `storage_path`, `uploaded_by`). El binario vive en `storage/` con **abstracción `BlobStore`** (implementación disco hoy, S3/MinIO mañana sin cambiar llamadas).
- `ticket_counters` no va aquí: el consecutivo de ticket pertenece a `scheduling`.

### 4.3 `scheduling`
- `appointment_requests` (**ticket**): `ticket_number bigint` ← `SEQUENCE`, `channel` (`telegram|registro|telefono|presencial`), `patient_id`, `patient_name`/`patient_document`/`patient_phone` (copia para la cola: la ficha viva está en `patients`), `reason` (motivo de consulta), `status`, `priority`, `requested_at`, `notes`, `created_by`.
  > **Sin `ticket_display`:** el texto `#000123` / `A-000001` se formatea al vuelo desde `ticket_number` (`formatTicket`), así que hay una sola fuente de verdad; la búsqueda por ticket lo interpreta con `parseTicket` y consulta por el número.
- `appointments`: `patient_id`, `request_id`, `appointment_date`, `start_time`, `end_time`, `dentist_id`, `chair_id`, `status`, `call_count`, `checked_in_at`, `started_at`, `finished_at`, `no_show_reason?`, `force_attended_reason?`, `rescheduled_from_id?`, `ics_sequence` (se incrementa al reprogramar).
- `day_capacities`: `date` (PK), `capacity` (**editable en cualquier momento, incluso después de asignar**), `notes`, `updated_by`.
- `slot_templates`: `weekday`, `start_time`, `end_time`, `slot_minutes`, `breaks jsonb`, `is_active`.
- `status_history` (transiciones con actor y timestamp → alimenta reportes de tiempos de espera).
- `audit_outbox*`: la tabla `outbox_events` la crea `packages/db` en cada BD.
- **Consecutivo:** `CREATE SEQUENCE ticket_seq START 1;` → `nextval` es atómico: dos solicitudes simultáneas nunca colisionan. `cycle = floor((n-1)/999999)`; prefijo `''` para ciclo 0, `A`…`Z`, luego `AA`… si algún día hiciera falta.

### 4.4 `notifications`
- `patient_channels`: `patient_id`, `channel` (`telegram|whatsapp`), **`direccion`** (chat o número), `usuario?`, `linked_at`, `link_code`, `link_code_expires_at`, `is_blocked`. La identidad es `(channel, direccion)`.
- `bot_conversations`: **`(canal, direccion)`** como clave, `state` (paso del asistente), `draft jsonb`, **`opciones jsonb`** (las opciones numeradas del último mensaje), `usuario?`, `updated_at` — permite retomar el asistente si el paciente se va y vuelve.
- `message_templates` (clave, canal, asunto, cuerpo con placeholders, `is_active`) — el texto de confirmación es **editable sin recompilar**.
- `message_outbox` / `message_log`: `patient_id`, `appointment_id?`, `template_key`, `payload jsonb`, `status` (`queued|sending|sent|failed|skipped_no_channel`), `attempts`, `last_error`, `provider_message_id`, `sent_at`.
- `processed_updates`: **`(canal, evento_id)`** con `evento_id text` — `update_id` de Telegram o `wamid` de WhatsApp; es la idempotencia del núcleo.
- `ics_artifacts`: `appointment_id`, `sequence`, `content text`, `sha256`, `generated_at` (reproducible y auditable).
- Reintentos con backoff exponencial (1 m, 5 m, 15 m, 1 h, 6 h) y **modo «manual pendiente»** cuando no hay dirección vinculada.

### 4.5 `clinical`
- `medical_records` (historia clínica, **1 por paciente**): `record_number` (`HC-000001` por secuencia), `status` (`borrador|firmada`), `signed_at`, `signed_by`, y las 11 secciones de `formato_historia.md` repartidas en tablas tipificadas:
  - `record_identification` (ocupación, responsable, contacto).
  - `record_chief_complaint` (`reason_text` textual + `reason_catalog_id?`).
  - `record_medical_history` + `record_conditions` (**catálogo + «otro» tipificado** para reportes): diabetes, hipertensión, cardiopatía, hepatitis, VIH, autoinmunes, anticoagulantes, bifosfonatos, etc. + `is_chronic`, `controlled?`.
  - `record_allergies` (medicamento/anestésico/látex/metal/otro + severidad + reacción).
  - `record_medications`, `record_surgeries`, `record_family_history`, `record_habits` (tabaquismo, alcohol, bruxismo, onicofagia, respiración bucal).
  - `record_dental_history` (tratamientos previos, reacciones adversas, ansiedad, frecuencia de visitas, higiene oral).
  - `record_extraoral_exam`, `record_intraoral_exam` (tejidos blandos, periodontal/sondaje, oclusión, higiene).
  - `record_complementary_exams` (radiografías, modelos, fotos, laboratorio → enlaza `files`).
  - `record_diagnoses` (presuntivo/definitivo, por pieza o general).
  - `record_treatment_plan` (+ prioridad, presupuesto **fuera de alcance por ahora**, alternativas, aceptación).
  - `record_consents` (tipo, `accepted_at`, `accepted_by`, archivo imprimible, quién registró).
  - `record_amendments` (adendas sobre historia firmada: motivo + autor + fecha).
- `clinical_sessions` (evolución, §11 del formato): `patient_id`, `appointment_id?`, `session_number`, `status` (`borrador|cerrada`), `reason`, `vitals jsonb` (TA, FC, Temp, SpO2, peso), `exam_findings`, `procedures` (catálogo), `materials jsonb`, `diagnosis`, `post_op_instructions`, `next_appointment_note`, `closure_note`, `closed_at`, `closed_by`, `amended_from_id?`.
- `clinical_session_files` (adjuntos por sesión: radiografías/fotos, con `caption` y `tooth_ref`).
- `prescriptions`: `prescription_number` (`RX-000001`), `session_id`, `patient_id`, `status` (`borrador|emitida|anulada`), `issued_at`, `issued_by`, `pdf_file_id`, `verify_code` (para el QR), `print_count`, `last_printed_at`.
- `prescription_items`: `medication_id?`, `medication_name`, `presentation` (concentración/presentación), `route` (vía), `dose`, `frequency`, `duration`, `instructions`, `quantity?`.
- `medications_catalog` (nombre, presentaciones, vías, indicaciones frecuentes) para autocompletado.

### 4.6 `odontogram`
Se implementa el esquema de `implementation_plan_odontogram_microservice.md` §4 (`odontograms` + `tooth_findings` con `UNIQUE(odontogram_id, tooth_number, surface)`), añadiendo: `recorded_by`, `recorded_in_session_id?`, `resolved_at?`, y **tabla de histórico** `tooth_finding_history` (append-only, alimenta la auditoría del odontograma tal como pediste).

### 4.7 `screens`
- `screen_devices` (`label`, `kind` (`lobby|consultorio`), `token_id` —el token de identity, que se guarda hasheado allí—, `settings jsonb` con voz on/off, volumen, segundos de resalte y de repetición, `last_seen_at`, `is_active`).
- `call_events` (`appointment_id`, `patient_display_name`, `turn_number`, `ticket`, `call_number` 1/2, `chair_label`, `called_at`, `called_by`, `acknowledged_at`, `event_id` **único**: un evento repetido no vuelve a llamar).
- `room_state` (proyección del estado de la sala: `appointment_id` como clave, paciente y su nombre abreviado, motivo, `patient_birth_date`/`patient_sex` para calcular la edad, `estado` (`en_sala_espera|llamado|en_consulta`), `chair_label`, `critical_flags jsonb` —los envía la historia clínica—, `since` y **`left_at`** como lápida: quien salió de la sala no vuelve por un evento tardío).

### 4.8 `reporting`
Read model propio (nada de consultar BDs ajenas): `dim_patient` (edad calculada, sexo, estado, crónicos/alergias), `fact_appointment` (fecha, hora, estado, canal, tiempos de espera), `fact_clinical_event` (sesiones, procedimientos, recetas, hallazgos del odontograma), más vistas materializadas `mv_daily_kpis`, `mv_funnel`, `mv_oral_health`, `mv_demographics`, `mv_prescriptions` refrescadas por eventos y por un job nocturno. Toda consulta pesada sirve desde aquí.

---

## 5. Máquina de estados

### 5.1 Solicitud y cita

```
  [bot / registro]                    [Programación de jornada]
        │                                        │
        ▼                                        ▼
  EN_ESPERA_CITA ──asignar fecha+hora──▶ PROGRAMADA ──notificar(lote)──▶ NOTIFICADA
        │                                    │                              │
        │ cancelar                           │ reprogramar                  │ check-in en Secretaría
        ▼                                    ▼                              ▼
    CANCELADA ◀────────────────────── REPROGRAMADA                   EN_SALA_ESPERA
                                             │                              │
                                             │                              ├─ llamar ─▶ LLAMADO (1.º/2.º)
                                             │                              │                 │
                                             │                              │                 ▼
                                             │                              │           EN_CONSULTA
                                             │                              │                 │
                                             │                              │                 ▼
                                             │                              │            ATENDIDO ✅
                                             │                              │        (exige sesión cerrada;
                                             │                              │         si no, motivo + auditoría)
                                             │                              └─ inasistencia ─▶ NO_ASISTIO
                                             ▼
                                    (nuevo ticket enlazado)
```

Reglas duras:
- `ATENDIDO` requiere **sesión clínica `cerrada`** (o historia firmada en primera visita). Si no existe → **advertencia + motivo obligatorio** que va a auditoría (decisión 17).
- `NO_ASISTIO` solo después de la hora de la cita + tolerancia configurable (por defecto 15 min), con motivo opcional.
- `LLAMADO` incrementa `call_count`; el 2.º llamado se resalta en rojo en la pantalla.
- Reprogramar **no** borra: crea una cita nueva y enlaza `rescheduled_from_id`; el ticket original queda trazado.

### 5.2 Historia clínica · 5.3 Sesión

`medical_record`: `BORRADOR → FIRMADA`; tras firmar, solo **adendas** (`record_amendments`), nunca sobrescritura.
`clinical_session`: `BORRADOR → CERRADA` (inmutable); correcciones por `amended_from_id`.

### 5.4 Permisos por acción

| Acción | admin | secretario | odontologo | pantalla |
| :--- | :-: | :-: | :-: | :-: |
| Usuarios y contraseñas | ✅ | ❌ | ❌ | ❌ |
| Registro/edición de pacientes (con motivo) | ✅ | ✅ | ✅ | ❌ |
| Eliminar un paciente del registro (borrado lógico, con motivo) | ✅ | ❌ | ❌ | ❌ |
| Programar jornada, cupos, notificar | ✅ | ✅ | lectura | ❌ |
| Autorizar sobrecupo en un día completo (con motivo) | ✅ | ❌ | ❌ | ❌ |
| Llamar / pasar a consulta / no asistió | ✅ | ✅ | ✅ | ❌ |
| Marcar atendido | ✅ | ✅ (con advertencia) | ✅ | ❌ |
| Historia clínica, sesiones, récipes, odontograma | ✅ | ❌ | ✅ | ❌ |
| Reportes y auditoría | ✅ | reportes operativos | clínicos | ❌ |
| Displaylobby / pantalla consultorio | ✅ | ✅ | ✅ | ✅ (solo lectura) |

---

## 6. API y rutas del gateway

Un solo origen para el frontend: `http(s)://<host>:8090/api/v1/**`.

> **Puerto del gateway: 8090.** El plan decía 8080, pero en la máquina de desarrollo Windows el 8080 lo ocupa el servicio de red del host (`hns`/Hyper-V) y el gateway fallaba con `listen EACCES`. Se unificó en **8090** (libre en Windows y en Fedora) para que la misma configuración sirva en ambos entornos.

| Prefijo público | Servicio destino | Ejemplos |
| :--- | :--- | :--- |
| `/api/v1/auth/**` | identity | `POST /login`, `POST /refresh`, `POST /logout`, `POST /password/change` |
| `/api/v1/users/**` | identity | CRUD de usuarios, roles, reset de contraseña |
| `/api/v1/audit/**` | identity | `GET /events?from&to&userId&entityType&field` |
| `/api/v1/patients/**` | patients | `GET /by-doc?type=V&number=12345678`, `POST /`, `PATCH /:id` (exige `reason`), `GET /search`, `POST /:id/files` |
| `/api/v1/requests/**` | scheduling | `POST /` (crea ticket), `GET /?status=en_espera_cita`, `GET /tickets/:display` |
| `/api/v1/agenda/**` | scheduling | `GET /day?date=`, `PUT /capacity`, `GET /slot-templates`, `POST /assign`, `POST /:id/reschedule`, `POST /:id/no-show` |
| `/api/v1/appointments/**` | scheduling | `GET /:id`, `POST /:id/check-in`, `POST /:id/call`, `POST /:id/start`, `POST /:id/attend`, `GET /:id/ics` |
| `/api/v1/clinical/**` | clinical | historia, sesiones, récipes, PDF, adjuntos |
| `/api/v1/odontogram/**` | odontogram | `GET /patients/:id`, `POST /patients/:id/findings`, `DELETE /patients/:id/findings` |
| `/api/v1/screens/**` | screens | `POST /devices`, `GET /device`, `GET /lobby`, `GET /lobby/stream` (SSE), `GET /consultorio/stream` (SSE) · `POST /api/v1/auth/device` canjea el token de la pantalla |
| `/api/v1/reports/**` | reporting | `GET /funnel`, `GET /demographics`, `GET /oral-health`, `GET /prescriptions`, `GET /:key/export.csv` |
| `/internal/v1/**` | todos | solo red interna + service JWT (`upsert-by-cedula`, `patients/:id/summary`, …) |

Errores uniformes (RFC 7807): `{ type, title, status, detail, errors[], requestId }`.

---

## 7. Catálogo de eventos (outbox)

Envelope: `{ eventId, eventType, version, occurredAt, aggregateId, actorId, correlationId, payload }`.

| Evento | Publica | Consumidores |
| :--- | :--- | :--- |
| `identity.user.created/updated/deactivated` | identity | identity (auditoría), reporting |
| `identity.session.login/failed/logout` | identity | identity (auditoría) |
| `patients.patient.created` | patients | scheduling (cambia estado), screens, reporting |
| `patients.patient.updated` | patients | reporting, **auditoría** (`changed_fields` de nombre/teléfono/dirección) |
| `scheduling.request.created` | scheduling | notifications (acuse opcional), reporting |
| `scheduling.capacity.changed` | scheduling | reporting |
| `scheduling.appointment.scheduled/rescheduled/cancelled` | scheduling | notifications (encolar confirmación), reporting, screens |
| `scheduling.appointment.notified` | scheduling | reporting (embudo) |
| `scheduling.appointment.checked_in/called/in_consultation/attended/no_show` | scheduling | screens, reporting, clinical |
| `scheduling.overbook.authorized` | scheduling | **auditoría** |
| `notifications.message.sent/failed` | notifications | reporting |
| `notifications.patient.linked` | notifications | patients (guarda preferencia de canal), reporting |
| `clinical.record.created/signed/amended` | clinical | reporting, **auditoría** |
| `clinical.session.created/closed/amended` | clinical | scheduling (habilita `ATENDIDO`), screens, reporting |
| `clinical.prescription.issued/reprinted` | clinical | reporting, **auditoría** |
| `odontogram.finding.recorded/removed` | odontogram | clinical, reporting, **auditoría** |

---

## 8. Bot de Telegram

**Un bot, un token, para siempre.** `TELEGRAM_BOT_TOKEN` vive solo en `services/notifications/.env`. Telegram prohíbe dos `getUpdates` simultáneos (error `409 Conflict`): el poller es **un solo proceso**; si algún día se escala, se replican *workers* de envío, no el poller (o se pasa el mismo bot a webhook).

**Asistente paso a paso** (con `/start`, `/cancelar`, `/estado`, `/mi_ticket`):

| Paso | Campo | Validación y normalización |
| :-: | :--- | :--- |
| 1 | Nombre completo | 3–120 caracteres, letras/acentos/espacios/`'`/`-`, se colapsan espacios y se aplica *title case*; se rechazan números y emojis. |
| 2 | Cédula | Botones **V / E / P / SC** + número de **6–8 dígitos** (SC: 4–8). Normaliza a `V-12345678` (sin puntos ni espacios). Si ya existe → «Ya te tenemos registrado, ¿confirmas tus datos?» con los datos enmascarados. |
| 3 | Teléfono | `+58` + 10 dígitos (`0412…`, `0414…`, `0424…`, `0416…`, `0426…`, `0212…`): normaliza a `+58412XXXXXXX` y valida el prefijo. Rechaza letras y números repetidos absurdos. |
| 4 | Fecha de nacimiento | `dd/mm/aaaa` o `dd-mm-aaaa`; fecha real, no futura, edad ≤ 120 años, aviso si es menor de edad → pide nombre y cédula del representante. |
| 5 | Sexo | Botones `M` / `F` / `O`. |
| 6 | Motivo de consulta | 5–500 caracteres, texto libre saneado (se escapan caracteres de control; nunca se concatena SQL — todo va por consultas parametrizadas de Drizzle). |
| 7 | Confirmación | Resumen + botones `Confirmar` / `Corregir paso`. Al confirmar: `upsert` del paciente → creación de la solicitud → respuesta con **ticket `#000123`**, estado `EN_ESPERA_CITA` y expectativa de contacto. |

Salvaguardas:
- **Idempotencia** por `update_id` (una pulsación repetida no genera dos tickets) y **anti-flood** (máx. 1 solicitud activa por `chat_id`; máx. 10 mensajes/min).
- **Nada de SQL dinámico**: validación Zod + Drizzle parametrizado + `parameterized queries`; los textos se guardan como datos, nunca como SQL.
- **Deep link de vinculación**: al registrar un paciente en recepción, la UI muestra `t.me/<bot>?start=<link_code>` (o un QR); quien lo abra queda vinculado a ese paciente.
- **Sin Telegram** → la cita se muestra como «notificación manual pendiente» con el guion de llamada telefónica sugerido.
- **Datos sensibles**: el bot nunca muestra el nombre completo de otros pacientes ni datos clínicos.
- **`.ics`**: el mensaje de confirmación lleva texto con ticket, fecha, hora y dirección **+ documento `cita-<ticket>.ics`** (`sendDocument`, `text/calendar`). Telegram no renderiza el `.ics` en línea, así que se envía como archivo adjunto; además `GET /api/v1/appointments/:id/ics` permite descargarlo desde la web.

```
BEGIN:VCALENDAR / VERSION:2.0 / PRODID:-//OdontoCRM//Citas//ES
BEGIN:VEVENT
UID:cita-000123@odontocrm.local      DTSTAMP:20261002T220000Z
DTSTART;TZID=America/Caracas:20261015T090000
DTEND;TZID=America/Caracas:20261015T093000
SUMMARY:Consulta odontológica — Ticket #000123
LOCATION:Av. Luis del Valle García, C.E. Nueva Esparta, Planta Baja, Local 1-2
DESCRIPTION:Motivo: <motivo> | Ticket: #000123
STATUS:CONFIRMED   SEQUENCE:0   (+VALARM 2 h antes)
END:VEVENT / END:VCALENDAR
```

---

## 9. Récipes y documentos

- **Campos del récipe**: paciente (nombre, cédula, edad), fecha/hora, diagnóstico, y por medicamento: **nombre, presentación/concentración, vía, dosis, frecuencia, duración e indicaciones**; indicaciones generales; nombre y **MPPS** del odontólogo, especialidad, teléfono y dirección del consultorio.
- **Membrete configurable** en `clinic_settings` (nombre, RIF, dirección, teléfonos, logo, pie de página) + `dentist_profile` (nombre, MPPS, especialidad, firma escaneada opcional). El membrete nace genérico y se rellena cuando lo envíes.
- **Render**: HTML server-side → **Playwright/Chromium → PDF A5** (`@page { size: A5 }`), guardado en `files`, con **QR de verificación** que apunta a `/verificar/<verify_code>` (página pública mínima que confirma autenticidad sin exponer datos clínicos).
- **Flujo al cerrar sesión**: si hay receta, aparece el diálogo **«¿Desea guardar el récipe?»**; opciones *Guardar e imprimir*, *Guardar sin imprimir*, *Descartar* (con motivo). Al guardar se emite `RX-000001`, se archiva el PDF y se registra `print_count` (toda reimpresión queda auditada).
- Reimpresión posterior desde el historial del paciente; nunca se borra una receta emitida (se anula con motivo).

---

## 10. Frontend: shell, panel inferior y pantallas

- **Stack**: Vite + React 19 + TS + Tailwind + shadcn/ui + TanStack Query/Table + React Hook Form + Zod (los esquemas Zod se comparten con el backend vía `packages/contracts`).
- **Shell**: layout con navegación lateral por módulo, migas de pan, **banner MODO TEST** cuando aplica, y **panel inferior ocultable** (se despliega con un clic/atajo) con: cerrar sesión, **cambio de modo claro/oscuro/sistema** (persistido por usuario + `prefers-color-scheme`), **info del login** (usuario, rol, desde cuándo, IP) y **botón Inicio**.
- **Rutas**:
  - `/login`
  - `/inicio` (tablero del día)
  - `/registro` (pacientes + solicitud; cédula → autocompletado; datos existentes en **solo lectura** con botón **Editar** que exige motivo y genera auditoría)
  - `/programacion` (jornada: cola «en espera de cita», selector de fecha, cupo editable, franjas, asignación, notificación en lote con vista previa)
  - `/secretaria` (calendario, lista por hora, acciones de flujo, advertencias)
  - `/consultorio` (primera visita → historia clínica; siguientes → sesión + odontograma + recetas)
  - `/flujo` (**página unificada** secretaría + consultorio para cuando el doctor hace todo)
  - `/pacientes` · `/pacientes/:id` (historial clínico completo, adjuntos, recetas)
  - `/reportes` · `/auditoria` · `/usuarios` · `/pantallas` (dispositivos y tokens)
  - `/pantalla/lobby` y `/pantalla/consultorio` (**kiosko**, sin shell, con token de dispositivo, reconexión SSE y *fullscreen*)
- **Displaylobby**: número de turno, nombre abreviado (`Juan P.`), consultorio, animación y **TTS en español** (`Web Speech API`, voz y volumen configurables), 2.º llamado en rojo.
- **Pantalla de consultorio**: paciente actual, **alergias, crónicos (diabetes/hipertensión), medicamentos, edad, motivo y últimos signos vitales** en tipografía grande y semáforo de riesgo.
- Accesibilidad: navegación por teclado en tablas y formularios, foco visible, contraste AA, y atajos para el flujo rápido (teclear cédula → Enter).

---

## 11. Seguridad y cumplimiento

- **Contraseñas**: `scrypt` de `node:crypto` (parámetros N=2^15, r=8, p=1, salt 16 B) — sin compiladores nativos en Windows; mínimo 10 caracteres, bloqueo tras 5 intentos por 15 min, `must_change_password` para el admin inicial.
- **Tokens**: JWT de acceso EdDSA 15 min (clave en `packages/kernel`), refresh opaco 30 días rotativo en cookie `httpOnly; SameSite=Lax; Secure` con detección de reuso; tokens de dispositivo kiosko separados y revocables.
- **Anti SQL-injection**: 100 % de las consultas por Drizzle/node-postgres parametrizado; prohibido construir SQL con interpolación de strings (regla ESLint `no-restricted-syntax` + revisión en cada fase); validación Zod en el borde de cada servicio; límites de tamaño en texto libre.
- **Red**: servicios escuchando en `127.0.0.1` y solo el gateway expuesto a la LAN; TLS interno con certificado propio (Caddy o `mkcert`) para que las cookies `Secure` funcionen; CORS restringido al origen de la web; rate limit por IP y por usuario.
- **Datos clínicos**: confidencialidad de historia clínica, mínimo privilegio por rol, cifrado de la BD (Fedora), bitácora de accesos, **backups `pg_dump` diarios con retención de 30 días y restauración probada** (Fase 10). Los adjuntos se sirven por endpoint autorizado, nunca por ruta directa del sistema de archivos.
- **Auditoría obligatoria** de: cambios de nombre/teléfono/dirección/fecha de nacimiento, ediciones de historia clínica firmada, actualizaciones de odontograma, emisión/reimpresión de récipes, usuarios y contraseñas, accesos fallidos, sobrecupos y «atendido» forzado.
- **Secretos**: nunca en el repositorio ni en capturas o chats. En desarrollo viven en archivos `.env` ignorados por Git; en Fedora en `/etc/odontocrm/<servicio>.env` con permisos `0600` y propietario `root`, cargados con `EnvironmentFile=` de `systemd`. Las credenciales de cada servicio las **genera** el bootstrap y un escáner (`tools/check-secrets.mjs`) revisa lo que se va a commitear. Detalle completo en [`SEGURIDAD_SECRETOS.md`](SEGURIDAD_SECRETOS.md).

---

## 12. Modo test y seed determinista

- **Ancla temporal**: `2026-10-02` (hoy). El seed usa una **semilla fija (`SEED=odontocrm-2026`)** → mismos pacientes, mismas horas, mismos tickets en cada ejecución en cualquier máquina.
- **Contenido**: ~40 pacientes (mixto por sexo y edad: 0–12, 13–17, 18–40, 41–65, 65+), 10–15 **en espera de cita** con tickets, 25–30 citas **atendidas en fechas anteriores** (con historia clínica, sesiones cerradas, odontogramas y recetas), 3–5 no asistidos, 2 en sala/consulta, y algunos pacientes crónicos/alérgicos para que los reportes y la pantalla de consultorio muestren datos reales de prueba.
- **Marcas**: cédulas en el rango reservado **90.000.000+** y `is_fictitious = true`; **banner rojo «MODO TEST»** fijo en la UI; bloqueo del módulo de notificaciones reales (envíos simulados a un chat de prueba) mientras el modo test esté activo.
- **Comandos**: `npm run seed:test`, `npm run seed:reset` (borra solo lo ficticio, nunca toca datos reales), `npm run seed:verify` (comprueba determinismo con hashes).
- **Guardas**: en producción `NODE_ENV=production` + `ALLOW_TEST_MODE=false` deshabilitan seeds y el banner.

---

## 13. Fases de ejecución 0–10

Cada fase es **una sesión agéntica** (las marcadas con ⚠️ pueden necesitar 2), termina con **commits atómicos + tag** y no arranca hasta cumplir su *Definition of Done*.

**DoD común a todas las fases:** `npm run verify` verde (typecheck + lint + test + build) · migraciones aplicadas desde cero en BD limpia · seed ejecutable · documentación de la fase actualizada (`docs/` y `CHANGELOG.md`) · sin secretos en el repo · `.env.example` actualizado · commits atómicos con Conventional Commits.

| Fase | Nombre | Sesiones | Depende de |
| :-: | :--- | :-: | :--- |
| 0 | Fundación del repositorio e infraestructura local | 1 | — |
| 1 | Identidad, roles y shell de UI | 1 | 0 |
| 2 | Pacientes y módulo Registro | 1 ⚠️ | 1 |
| 3 | Agenda: tickets, cupos y Programación de jornada | 1 ⚠️ | 2 |
| 4 | Notificaciones y bot de Telegram | 1 ⚠️ | 3 |
| 4.1 | Núcleo conversacional y adaptadores de canal (ADR 0029) | 1 | 4 |
| 5 | Secretaría y pantallas (lobby / consultorio) | 1 ⚠️ | 3 |
| 6 | Historia clínica y odontograma | 2 ⚠️ | 1, 5 |
| 7 | Sesiones clínicas, adjuntos y récipes A5 | 2 ⚠️ | 6 |
| 8 | Página unificada del flujo completo | 1 | 5, 7 |
| 9 | Reportes, KPIs y auditoría UI | 1 ⚠️ | 4, 7 |
| 10 | Modo test, endurecimiento y despliegue Fedora | 1 ⚠️ | todas |

---

### Fase 0 — Fundación del repositorio e infraestructura local

**Objetivo:** que el repo sea trabajable y que un comando levante el entorno en Windows, y que exista la ruta documentada para Fedora.

**Entregables**
1. `.gitignore` (node_modules, dist, `.env*`, logs, `coverage/`, `storage/`, artefactos de Playwright, `*.local`), `.editorconfig`, `.env.example`, `README.md`.
2. Monorepo npm workspaces: `tsconfig.base.json` estricto, ESLint 9 flat + Prettier, scripts raíz `dev`, `build`, `typecheck`, `lint`, `test`, `verify`, `migrate`, `seed:*`.
3. `packages/kernel` (config Zod por servicio, logger con `requestId`, errores RFC 7807, `/health` y `/ready`), `packages/contracts` (enums + primer DTO), `packages/db` (conexión Drizzle, migrador, **tabla y publicador de outbox**, wrapper de `pg-boss`), `packages/events`, `packages/testing`.
4. Servicio piloto mínimo (`services/identity` con `/health` real y conexión a Postgres verificada) + `apps/gateway` proxyando `/health`.
5. `infra/db/bootstrap.sql` + script `npm run db:bootstrap`: crea las 8 BD, un rol por servicio con privilegios solo sobre su BD, y extensiones (`pgcrypto`, `pg_trgm`).
6. `infra/windows/install.md` + scripts (arranque con PM2, `ecosystem.config.cjs`) — Windows ya tiene Node 26, Git, PM2 y PostgreSQL 18, así que solo se documenta y se automatiza.
7. `infra/fedora/INSTALL.md` + scripts con el plan de instalación en Fedora (paquetes `dnf`, `postgresql18-setup`, usuario de sistema, `systemd`/`pm2 startup`, `firewalld`, SELinux, respaldos) — se completa y prueba en la Fase 10.
8. `docs/SEGURIDAD_SECRETOS.md`: política de secretos (`.env` local nunca versionado, `/etc/odontocrm/*.env` con `0600` en Fedora vía `EnvironmentFile=`, generación de credenciales por servicio en el bootstrap, rotación del token del bot, y `tools/check-secrets.mjs` como escáner previo al commit).
9. `docs/adr/` con una ADR por decisión de §1 (21 ADRs cortas) y corrección del enlace roto a `odontograma.md` en `formato_historia.md`.

**Criterios de aceptación:** `npm run verify` verde · `npm run db:bootstrap` crea las 8 BD desde cero · `GET :8090/health` responde OK con estado de la BD del servicio piloto · `npm run build` genera artefactos · `.gitignore` impide que `node_modules` y `.env` entren a git (comprobado con `git status`).

**Commits previstos:** `chore(repo): gitignore y configuración base` · `chore(tooling): monorepo ts/eslint/prettier` · `feat(kernel): plugin base, config, health y errores` · `feat(db): conexión drizzle, migrador y outbox` · `feat(infra): bootstrap de bases y roles` · `docs(setup): instalación windows y plan fedora` · `docs(adr): decisiones de arquitectura`.

---

### Fase 1 — Identidad, roles y shell de UI

**Objetivo:** entrar al sistema, con permisos reales y una UI navegable.

**Entregables:** `identity` (usuarios CRUD, roles/permisos, login, refresh rotativo con detección de reuso, logout, cambio y restablecimiento de contraseña, bloqueo por intentos, `device_tokens` para pantallas, `audit_events` con el endpoint de consulta) · gateway con verificación JWT y rate limit · `apps/web`: login, shell, rutas protegidas por rol, **panel inferior ocultable** (cerrar sesión, tema claro/oscuro/sistema, info de login, botón Inicio), i18n es-VE, `packages/ui` con tokens de tema · seed de usuarios (`admin` con cambio forzado, `secretario`, `odontologo`) · módulo `/usuarios` funcional.

**Criterios de aceptación:** login/refresh/logout correctos; usuario sin permiso recibe 403 en UI y API; 5 intentos fallidos bloquean 15 min; el panel inferior cambia de tema y persiste la preferencia; toda acción sensible deja fila en `audit_events`; pruebas de integración de auth verdes.

**Commits previstos:** `feat(identity): modelo de usuarios, roles y permisos` · `feat(identity): login con jwt y refresh rotativo` · `feat(identity): auditoría de accesos` · `feat(gateway): verificación de tokens y rate limit` · `feat(web): shell, login y panel inferior` · `feat(web): módulo de usuarios` · `test(identity): integración de auth`.

---

### Fase 2 — Pacientes y módulo Registro

**Objetivo:** registrar pacientes con validación fuerte y edición auditada.

**Entregables:** `patients` (V/E/P/SC con normalización y unicidad, representante de menores, contactos, búsqueda, estados, `files` con `BlobStore` en disco) · endpoint `upsert-by-cedula` interno · hook de auditoría de campos sensibles (nombre, teléfono, dirección, fecha de nacimiento) con `before/after` · `audit` recibiendo eventos por outbox · web `/registro`: input de cédula con selector V/E y máscara, autocompletado al salir del campo, datos existentes en **solo lectura** con botón **Editar** que exige motivo y muestra confirmación del cambio · `/pacientes` con lista, filtros y ficha · pruebas de validación (cédulas inválidas, menores, duplicados, intentos de inyección en textos libres).

**Criterios de aceptación:** `V-12345678` y `v 12.345.678` resuelven al mismo paciente; cédula duplicada → 409 con enlace al existente; el botón Editar no permite guardar sin motivo; el cambio queda en auditoría con los campos modificados; búsqueda por nombre/cédula/teléfono < 300 ms con 5.000 pacientes de prueba.

**Commits previstos:** `feat(patients): modelo, validación y normalización de cédula` · `feat(patients): guardianes, contactos y búsqueda` · `feat(patients): almacenamiento de archivos con blobstore` · `feat(audit): registro de cambios sensibles con motivo` · `feat(web): módulo registro con autocompletado y modo lectura` · `feat(web): listado y ficha de pacientes` · `test(patients): validaciones y casos borde`.

---

### Fase 3 — Agenda: tickets, cupos y Programación de jornada

**Objetivo:** que toda solicitud tenga ticket y que la secretaria arme la jornada con cupo flexible.

**Entregables:** `scheduling` (secuencia de tickets con salto a `A-000001`, cola `EN_ESPERA_CITA`, `day_capacities` editable en cualquier momento, `slot_templates` por día de la semana con duración y pausas, asignación con hora de franja o manual, reprogramación, cancelación, no asistencia, `status_history`) · validación de cupo (bloqueo por defecto; sobrecupo solo con autorización explícita de admin y registro en auditoría) · eventos de solicitud/cita · web `/programacion`: cola ordenada por ticket y antigüedad, selector de fecha, cupo editable con contador `asignados/cupo`, vista de franjas con arrastrar-y-soltar o asignación por fila, hora manual, botón **Notificar** con vista previa del lote y reenvío individual, y vista de ocupación del día.

**Criterios de aceptación:** dos solicitudes simultáneas obtienen tickets distintos (prueba de concurrencia); bajar el cupo por debajo de lo ya asignado avisa y no borra citas; reprogramar conserva el ticket original y crea el nuevo enlazado; toda transición queda en `status_history` con actor y hora; el lote de notificación muestra exactamente los mensajes que se enviarán.

**Commits previstos:** `feat(scheduling): tickets y cola de espera` · `feat(scheduling): cupos diarios y plantillas de franjas` · `feat(scheduling): asignación, reprogramación y no asistencia` · `feat(scheduling): eventos y historial de estados` · `feat(web): módulo programación de jornada` · `feat(web): notificación en lote con vista previa` · `test(scheduling): concurrencia de tickets y reglas de cupo`.

---

### Fase 4 — Notificaciones y bot de Telegram

**Objetivo:** que el paciente pida su cita por Telegram y reciba su confirmación con `.ics`.

**Entregables:** `notifications` (poller único, asistente de 7 pasos con validación/normalización, `/estado` por ticket, `/cancelar`, idempotencia por `update_id`, anti-flood, `bot_conversations` reanudables, vinculación por deep link y QR, plantillas editables, cola con reintentos y backoff, `ics_artifacts` + `GET /appointments/:id/ics`, modo «manual pendiente») · **aviso inmediato al formalizar la cita**: al recibir `scheduling.appointment.scheduled`, el bot envía al paciente la notificación con **fecha, hora y lugar** y el **`.ics` adjunto** (decisión del 2026-10-03), con reintentos e idempotencia por cita y canal · integración REST interna con `patients` y `scheduling` · modo simulado para pruebas (sin token real) · web `/notificaciones` (bandeja de envíos, errores, reintento manual, plantillas) · guion de mensajes revisable.

**Criterios de aceptación:** un flujo completo en Telegram real (o chat de pruebas) genera un ticket visible en `/programacion`; **al formalizarse una cita en la aplicación llega el mensaje con fecha, hora, lugar y el `.ics` adjunto en menos de un minuto** (y si el paciente no tiene Telegram vinculado, queda en «manual pendiente»); un `update_id` repetido no duplica tickets ni avisos; el `.ics` abre correctamente en Google Calendar y en Apple Calendario con la hora correcta de Caracas; mensaje inválido en cualquier paso no avanza y explica el error; reintentos automáticos visibles en la bandeja.

**Commits previstos:** `feat(notifications): poller y máquina de conversación del bot` · `feat(notifications): validación y normalización de datos del asistente` · `feat(notifications): creación de ticket vía scheduling` · `feat(notifications): vinculación de chat por deep link` · `feat(notifications): cola de envíos, reintentos y plantillas` · `feat(notifications): generación de ics` · `feat(web): bandeja de notificaciones` · `test(notifications): idempotencia y validaciones`.

---

### Fase 5 — Secretaría y pantallas (lobby / consultorio)

**Objetivo:** operar el día y llamar pacientes.

**Entregables:** `screens` (dispositivos y tokens kiosko, `call_events`, `room_state`, SSE para lobby y consultorio, ajustes de voz) · web `/secretaria` (calendario con selección de fecha, lista por hora, buscador, acciones: check-in, **Llamar**, **Pasar a consulta**, **No asistió**, **Atendido** con la advertencia + motivo cuando falte sesión/historia, llamada fuera de orden con marca de «emergencia») · `/pantalla/lobby` (turno, nombre abreviado, consultorio, animación, TTS español, 2.º llamado en rojo, reconexión SSE) · `/pantalla/consultorio` (datos críticos con semáforo de riesgo) · `/pantallas` para administrar dispositivos y obtener el enlace de kiosko.

**Criterios de aceptación:** llamar desde secretaría aparece en el lobby en < 1 s; se puede llamar a cualquier paciente fuera de orden; marcar atendido sin sesión cerrada exige motivo y aparece en auditoría; cerrar el navegador del lobby y reabrir recupera el estado; el token de la pantalla no permite entrar a ningún otro módulo; la pantalla de consultorio muestra alergias y crónicos del paciente en curso.

**Commits previstos:** `feat(screens): dispositivos, tokens y sse` · `feat(screens): llamados y estado de sala` · `feat(web): módulo secretaría con acciones de flujo` · `feat(web): displaylobby con tts` · `feat(web): pantalla de consultorio` · `feat(web): administración de pantallas` · `test(screens): flujo de llamados`.

---

### Fase 6 — Historia clínica y odontograma (⚠️ 2 sesiones)

**Objetivo:** que el doctor documente al paciente conforme al formato venezolano.

**Entregables (sesión A):** `clinical` con las 11 secciones de `formato_historia.md`, **catálogos tipificados + «otros» inputable** (alergias, patológicos, medicamentos, cirugías, familiares, hábitos, antecedentes odontológicos) para que los reportes puedan segmentar, estados `BORRADOR → FIRMADA`, adendas, consentimiento con registro de aceptación e impresión A4 · web: aviso obligatorio **«Primera visita del paciente, se debe llenar su historia clínica»**, formulario por pasos con guardado de borrador, validaciones clínicas (p. ej. alergia a penicilina resaltada), y bloqueo de firma sin secciones obligatorias.
**Entregables (sesión B):** `odontogram` según el doc (FDI, captura por excepción, `tooth_finding_history`, eventos) + componente SVG geométrico de §7 del doc + carga rápida por teclado (número de pieza, caries/obturación/ausente, rojo pendiente / azul completado) + vista histórica de evolución por sesión.

**Criterios de aceptación:** una historia completa se llena en < 10 min y se puede firmar; al firmar no se puede editar (solo adenda con motivo); el odontograma completo se carga por teclado en < 30 s; un hallazgo nuevo se refleja en `reporting` y en auditoría; diente sano = ausencia de fila (lectura correcta del patrón «por excepción»).

**Commits previstos (A):** `feat(clinical): modelo de historia clinica por secciones` · `feat(clinical): catalogos tipificados y otros` · `feat(clinical): firma, adendas y consentimiento` · `feat(web): formulario de historia clinica con aviso de primera visita` · `test(clinical): validaciones de historia` — **(B):** `feat(odontogram): dominio fdi y captura por excepcion` · `feat(odontogram): historico de hallazgos y eventos` · `feat(web): odontograma svg interactivo` · `feat(web): carga rapida por teclado` · `test(odontogram): geometria y reglas de hallazgos`.

---

### Fase 7 — Sesiones clínicas, adjuntos y récipes A5 (⚠️ 2 sesiones)

**Objetivo:** el formulario de sesión profesional y el récipe A5 con membrete.

**Entregables (sesión A) — formulario de sesión:** signos vitales (TA, FC, temperatura, SpO₂, peso), motivo de la visita, anamnesis breve y cambios relevantes, examen intraoral y periodontal, **procedimientos realizados desde catálogo** (con pieza y caras), materiales e insumos, diagnóstico de la sesión, indicaciones postoperatorias, próxima cita sugerida, notas internas, y **actualización del odontograma dentro de la misma sesión**; estado `BORRADOR` con autoguardado y `CERRADA` inmutable; enlace con la cita (`appointment_id`) que habilita el estado `ATENDIDO`; cierre desde el historial del paciente.
**Entregables (sesión B) — adjuntos y récipes:** subida de **imágenes/radiografías** (jpg/png/webp/pdf, ≤ 20 MB) con miniatura, visor con zoom, `caption` y referencia a pieza dental; **recetas estructuradas** (medicamento con autocompletado desde catálogo, presentación/concentración, vía, dosis, frecuencia, duración, indicaciones por medicamento + indicaciones generales); diálogo **«¿Desea guardar el récipe?»** al cerrar sesión; **PDF A5** con Playwright, membrete configurable, numeración `RX-000001` y QR de verificación; página pública `/verificar/<code>`; reimpresión auditada; descarga e impresión desde el historial.

**Criterios de aceptación:** cerrar una sesión con receta dispara el diálogo y, al aceptar, emite el PDF A5 en < 3 s con datos del paciente, odontólogo, MPPS y QR legible que valida el código; el PDF se archiva y aparece en el historial; ninguna sesión cerrada puede modificarse; las radiografías se ven en la ficha del paciente y quedan asociadas a la sesión y a la pieza.

**Commits previstos (A):** `feat(clinical): modelo de sesion clinica` · `feat(clinical): catalogos de procedimientos y materiales` · `feat(clinical): cierre de sesion y enlace con la cita` · `feat(web): formulario de sesion con autoguardado` · `feat(web): actualizacion de odontograma en la sesion` · `test(clinical): reglas de cierre` — **(B):** `feat(clinical): adjuntos de imagenes y visor` · `feat(clinical): recetas estructuradas y catalogo de medicamentos` · `feat(clinical): pdf a5 con membrete y qr` · `feat(web): dialogo de guardado e impresion del recipe` · `feat(web): pagina de verificacion publica` · `test(clinical): generacion de pdf y numeracion`.

---

### Fase 8 — Página unificada del flujo completo

**Objetivo:** que el odontólogo sin asistente haga todo en una sola pantalla.

**Entregables:** ruta `/flujo` con **cola del día a la izquierda**, **paciente en curso al centro** (historia/sesión) y **acciones de secretaría** (check-in, llamar, pasar a consulta, no asistió, atendido) en la barra superior; llamados al lobby desde la misma pantalla; selector de fecha; atajos de teclado (`F2` buscar paciente, `F4` llamar, `F8` cerrar sesión); diseño responsivo para tablet.

**Criterios de aceptación:** un doctor puede llevar el día completo sin salir de `/flujo`; ninguna capacidad de secretaría o consultorio queda inaccesible desde ahí; no hay regresiones en las rutas individuales.

**Commits previstos:** `feat(web): layout unificado de flujo diario` · `feat(web): acciones de secretaria integradas` · `feat(web): atajos de teclado y modo tablet` · `test(web): e2e del flujo completo`.

---

### Fase 9 — Reportes, KPIs y auditoría UI

**Objetivo:** decidir con datos y poder auditar.

**Entregables:** `reporting` con read model alimentado por eventos + refresco nocturno; reportes: **embudo y tasa de inasistencia** (solicitudes → programadas → notificadas → atendidas, por semana/mes), **demografía** (pirámide de edad, sexo, rango de edad editable), **salud bucal desde el odontograma** (prevalencia de caries/obturaciones/ausencias por pieza y paciente), **perfil clínico agregado** (diabéticos, hipertensos, alérgicos, anticoagulados — de tu pedido original), **recetas por medicamento y período**, filtros por fecha, rango de edad, sexo y estado; gráficas con Recharts; **exportación CSV/PDF e impresión** · módulo `/auditoria`: búsqueda por rango de fechas, usuario, tipo de entidad y campo, con **diff antes/después**, motivo y exportación.

**Criterios de aceptación:** con el seed de prueba cada reporte muestra datos coherentes y verificables contra la BD; los filtros de edad/sexo/estado se combinan correctamente; exportar CSV abre en Excel con acentos correctos; la auditoría encuentra el cambio de un teléfono con su valor anterior, nuevo, autor y motivo; ninguna consulta pesada golpea las BD operativas (< 2 s por reporte con 10.000 citas).

**Commits previstos:** `feat(reporting): read model y proyecciones por evento` · `feat(reporting): embudo e inasistencia` · `feat(reporting): demografia y perfil clinico` · `feat(reporting): salud bucal desde odontograma` · `feat(reporting): recetas y exportacion csv/pdf` · `feat(web): modulo de reportes con graficas` · `feat(web): modulo de auditoria con diff` · `test(reporting): coherencia de kpis`.

---

### Fase 10 — Modo test, endurecimiento y despliegue Fedora

**Objetivo:** entregar el sistema listo para la clínica y reproducible en producción.

**Entregables:** seed determinista completo + `seed:reset` + `seed:verify` + banner MODO TEST y bloqueo de envíos reales · `infra/fedora/` completa y **probada**: instalación de PostgreSQL 18, usuario de sistema, `systemd`/PM2, firewall (`firewalld`), SELinux, TLS interno, Tailscale, respaldo diario con `pg_dump` + rotación + **prueba de restauración documentada** · observabilidad (logs con rotación, `/health` y `/ready` de los 9 servicios, tablero de estado, alertas básicas de servicio caído y de cola de envíos atascada) · runbook (arranque, parada, respaldo, restauración, alta de usuarios, recuperación de contraseña, rotación del token del bot) · pruebas end-to-end del flujo completo (solicitud por bot → programación → notificación con `.ics` → secretaría → consultorio → historia/sesión/récipe → reportes → auditoría) · revisión de seguridad final · `README` de operación para la clínica.

**Criterios de aceptación:** instalación desde cero en Fedora siguiendo solo `infra/fedora/INSTALL.md`; tras reiniciar la máquina los 9 servicios vuelven solos; un respaldo se restaura en una BD limpia con datos íntegros; la prueba E2E completa pasa; apagar el servidor no corrompe datos; el modo test no puede activarse en producción.

**Commits previstos:** `feat(seed): datos de prueba deterministicos y reset` · `feat(web): banner y bloqueo de modo test` · `feat(infra): instalacion fedora con systemd y firewall` · `feat(infra): respaldos automatizados y restauracion` · `feat(obs): health, logs y alertas` · `test(e2e): flujo completo de la clinica` · `docs(runbook): operacion y recuperacion`.

---

## 14. Convención de commits, ramas y tags

- **Rama por fase**: `fase/N-slug` desde `main`. Al cerrar: merge `--no-ff` a `main` + tag `fase-N` + entrada en `CHANGELOG.md`. Así cada fase es revertible en bloque sin perder el detalle.
- **Commits atómicos** con Conventional Commits: `feat|fix|chore|docs|test|refactor|perf(scope): mensaje en imperativo`. Un commit = un cambio coherente que compila y pasa tests; **prohibido** mezclar migración + UI + refactor en un mismo commit.
- **Cada migración SQL** va en su propio commit (`feat(<servicio>): migracion ...`) para poder revertir esquema y código por separado.
- Antes de cada merge: `npm run verify` + `git status` limpio + revisión del diff completo por parte del Lead (o del agente revisor en sesiones con equipo).
- Mensajes de commit y CHANGELOG en español; identificadores de código y columnas en inglés.

---

## 15. Qué hay que instalar

**Windows (desarrollo/pruebas — esta máquina)**

| Qué | Estado | Nota |
| :--- | :--- | :--- |
| Node.js 26 | ✅ instalado (v26.7.0) | npm 11.19 incluido |
| Git | ✅ instalado (2.55) | |
| **PostgreSQL 18** | ✅ instalado y corriendo (`postgresql-x64-18`, puerto 5432) | Binarios en `C:\Program Files\PostgreSQL\18\bin`. Falta solo definir el **password del superusuario** en el `.env` local para que el bootstrap cree las 8 bases y sus roles. |
| PM2 | ✅ instalado global (`npm i -g pm2`) | Mantiene los 9 servicios vivos y los reinicia si se caen |
| Playwright + Chromium | ⏳ pendiente | Solo a partir de la **Fase 7** (PDF del récipe): `npx playwright install chromium` |
| Tailscale | ⏳ opcional, **Fase 10** | Para el acceso remoto sin exponer nada a internet |

**Fedora (producción — se documenta y prueba en la Fase 10):** `nodejs`, `postgresql18-server`, `postgresql18-contrib`, `firewalld`, PM2 global (o unidades `systemd`), dependencias de Chromium para Playwright (`npx playwright install-deps chromium`), usuario de sistema `odontocrm`, `pg_dump` para respaldos y Tailscale. Se instala la **misma versión mayor de PostgreSQL que en desarrollo (18)** para que las migraciones sean idénticas.

**Nada más:** al usar outbox + `pg-boss` sobre PostgreSQL **no** necesitas Docker, RabbitMQ, Redis ni MinIO. Las contraseñas usan `scrypt` de Node (sin compilador de C++), así que no hace falta Visual Studio Build Tools.

---

## 16. Riesgos, supuestos y decisiones abiertas

**Riesgos principales y mitigación**

| Riesgo | Mitigación |
| :--- | :--- |
| Sobrecarga operativa de 9 servicios | Un comando de arranque, bootstrap de BD automatizado, PM2/`systemd`, health checks; camino de repliegue: fusionar pares de servicios sin cambiar contratos. |
| Chromium/Playwright en Fedora (SELinux, dependencias) | Se prueba en la Fase 7 en Windows y se valida en la Fase 10 en Fedora; alternativa de repliegue: PDF con `pdfmake` sin navegador. |
| Doble `getUpdates` del bot (`409 Conflict`) | Poller único por diseño; si se despliegan réplicas, solo se replican workers de envío. |
| Datos clínicos reales sin respaldo probado | Respaldos diarios + restauración probada en la Fase 10 antes de usar el sistema en la clínica. |
| Desviación de alcance por sesión agéntica | DoD por fase, commits atómicos y tag por fase; lo nuevo entra como fase nueva, no dentro de una en curso. |
| Diferencias Windows↔Fedora (rutas, permisos, fin de línea) | Rutas resueltas con `node:path` y configurables por entorno, `.gitattributes` con `* text=auto eol=lf`, pruebas en ambas plataformas. |

**Supuestos (confírmame si alguno no aplica)**

1. Horario por defecto **lunes a viernes 08:00–12:00 y 13:00–17:00**, citas de **30 minutos**, tolerancia de inasistencia **15 minutos**. Todo editable.
2. Zona horaria fija **America/Caracas**; fechas en la UI `dd/mm/aaaa` y **horas en formato de 12 h con `a. m.` / `p. m.`** (ajuste tuyo del 2026-10-02). En base de datos, logs e `.ics` se guarda **24 h** (`14:30`, RFC 5545) y la conversión a 12 h ocurre solo al mostrar.
3. Uso concurrente pequeño (**2–5 usuarios** + 2 pantallas): no requiere balanceo ni caché distribuida.
4. UI en **español (es-VE)**; código, tablas y columnas en **inglés**.
5. El sistema se llamará **OdontoCRM**; la dirección de la clínica es `Av. Luis del Valle García, C.E. Nueva Esparta, Planta Baja, Local 1-2` (configurable).
6. Presupuestos, facturación, seguros, ortodoncia avanzada y WhatsApp **no** están en este plan (quedan como fases futuras).
7. Datos de prueba: rango de cédulas **90.000.000+** reservado y reservado también el prefijo `SC-` para menores ficticios.

**Decisiones cerradas (2026-10-03, con la revisión de la Fase 2)**

| Tema | Decisión |
| :--- | :--- |
| Sobrecupo | Bloqueado por defecto; `admin` puede autorizarlo con motivo y queda en auditoría. |
| Recordatorios | Telegram 24 h y 2 h antes (fase posterior al plan actual). |
| Duración de cita | 30 min por franja, editable por día. |
| Impresión | Récipe en **A5**; historia clínica y consentimiento en **A4**. |
| Copia del récipe al paciente | Descarga/impresión desde el historial; envío por Telegram queda para fase posterior. |
| Numeración de historia | `HC-000001` por paciente, secuencia global. |
| Membrete | Genérico hasta que envíes logo, RIF, teléfonos y datos del odontólogo (MPPS, especialidad). Te los pediré al construir el PDF de la Fase 7. |
| Nombre del bot | Nombre visible «Consultorio - Od. Erika Gómez» (se cambia cuando quieras). El `@usuario` es único: cambiarlo rompe los enlaces `t.me/...` ya compartidos. El token se entrega por `.env`, nunca por chat ni en el repo. |
| Aviso al formalizar la cita | **Al quedar formalizada la cita** (no solo como recordatorio), el bot envía al paciente la notificación con **fecha, hora y lugar**, e **incrusta el `.ics`** para que la agregue a su calendario. Es un envío disparado por el evento `scheduling.appointment.scheduled`, con reintentos e idempotencia; la plantilla y el `.ics` se construyen en la Fase 4. |
| Tema claro/oscuro/sistema | Preferencia **por equipo** (clave `odontocrm:tema`), no por usuario: en un consultorio con puestos compartidos el tema es del puesto y la pantalla de login ya lo respeta. |
| Cola de eventos | Se mantiene la **cola compartida** en la base `odonto_events` ([ADR 0026](adr/0026-cola-de-eventos-compartida.md)); cada servicio conserva su outbox. |
| Permisos del odontólogo sobre pacientes | **Registra y edita** (tiene `patients:write` y `patients:edit_sensitive`), igual que la secretaría y siempre con motivo auditado. **No** puede eliminar pacientes. |
| Eliminar un paciente | Se añade **borrado lógico** con motivo y **solo para `admin`** (permiso `patients:delete`, [ADR 0027](adr/0027-borrado-logico-de-pacientes.md)): nada se destruye y el documento vuelve a quedar libre. |

---

## 17. Estado de ejecución y próximo paso

### Estado de las fases

| Fase | Estado | Evidencia |
| :-: | :--- | :--- |
| **0** | ✅ **completada** (2026-10-02) | 24 commits atómicos · `npm run verify` en verde con **56 pruebas** (+4 de integración con `npm run test:integration`) · 8 bases y 8 roles creados, idempotencia comprobada y **migraciones verificadas desde cero en base limpia** (`npm run db:verify-migrations`) · outbox + `pg-boss` probados contra PostgreSQL real · `GET :8090/health`, `GET :8090/api/v1/auth/health` y `GET :4001/ready` (PostgreSQL 18.6) respondiendo 200 · `.gitignore` verificado · 25 ADRs · guía de Fedora con `bash -n` y `check` de las unidades |
| **1** | ✅ **completada** (2026-10-02) | 10 commits · `npm run verify` en verde con **98 pruebas** (+11 de integración) · identidad completa (login, refresh rotativo con detección de reuso, bloqueo tras 5 intentos, usuarios, dispositivos y auditoría) · gateway verificando el JWT y publicando la identidad · interfaz con shell, login, panel inferior ocultable, temas y módulo de usuarios · **prueba de humo del acceso** (`npm run smoke:auth`) con 17 comprobaciones en verde |
| **2** | ✅ **completada** (2026-10-03, decisiones cerradas el mismo día) | 13 commits · `npm run verify` en verde con **122 pruebas** (+20 de integración: **142 en total**) · servicio de pacientes con cédula V/E/P/SC normalizada y única, representante de menores, adjuntos en disco, búsqueda con trigramas (**< 300 ms con 5.000 pacientes**: 46 ms la peor) y **borrado lógico solo para `admin`** (ADR 0027) · edición **con motivo obligatorio** que deja `before`/`after` en la auditoría de identity pasando por el outbox y la **cola compartida** · el odontólogo registra y edita pacientes (decisión del 2026-10-03) · módulo de registro (autocompletado por cédula, solo lectura y confirmación de cambios) y lista/ficha de pacientes · **prueba de humo** (`npm run smoke:patients`) con 26 comprobaciones en verde · 27 ADRs |
| **3** | ✅ **completada** (2026-10-03) | 11 commits · `npm run verify` en verde con **145 pruebas** (+36 de integración: **181 en total**) · `scheduling` con **secuencia atómica de tickets** (20 solicitudes simultáneas, 20 tickets distintos), cola «en espera de cita» ordenada por ticket/antigüedad/prioridad, cupo diario editable (bajarlo por debajo de lo asignado **avisa y no borra**), plantillas de franjas sembradas (L-V 8:00–12:00 y 13:00–17:00 → 16 franjas), hora manual, **sobrecupo solo con `scheduling:overbook` y motivo**, índice único parcial que impide dos citas a la misma hora (incluso en paralelo), reprogramación que conserva el ticket y enlaza la cita nueva, inasistencia con tolerancia de 15 min, `status_history` con actor y hora, aviso en lote con **vista previa exacta**, y auditoría de todos los eventos con resumen legible · módulo **Programación** con cola, jornada, franjas, arrastrar y soltar, cupo y aviso en lote · **prueba de humo** (`npm run smoke:agenda`) con **41 comprobaciones** en verde · 28 ADRs |
| **4** | ✅ **completada** (2026-10-03) | 9 commits · `npm run verify` en verde con **165 pruebas** (+46 de integración: **211 en total**) · `notifications` con bot de Telegram **conectado** (@odegcrmbot, long polling único), asistente de **7 pasos** que valida y crea paciente + solicitud con ticket, `/estado`, `/cancelar`, `/mi_ticket`, vinculación por deep link y **QR**, anti-flood (10 mensajes/min) e **idempotencia por `update_id`**, 19 plantillas editables, cola con reintentos y retroceso exponencial, **aviso inmediato al formalizar la cita con el `.ics` adjunto**, «aviso manual pendiente» cuando el paciente no tiene Telegram, y `ics_artifacts` · **reparto de eventos por servicio** (cada consumidor tiene su cola: los eventos llegan a todos) · bandeja `/notificaciones` con estado del bot, envíos, reintento manual, plantillas y vinculación · **prueba de humo** (`npm run smoke:notifications`) en verde · 29 ADRs |
| **4.1** | ✅ **completada** (2026-10-03) | 7 commits · `npm run verify` en verde con **198 pruebas** (+51 de integración: **249 en total**) · **núcleo conversacional y adaptadores de canal** ([ADR 0029](adr/0029-nucleo-conversacional-y-adaptadores.md)): el asistente trabaja sobre `InboundMessage` y envía por el adaptador, con **intenciones** (no comandos) y **opciones numeradas guardadas en la conversación**; migraciones `0001` (`direccion` + `canal` + `opciones` + `evento_id text` para el `wamid`) y `0002` (plantillas sin comandos), verificadas desde cero en base limpia; **webhook público** de WhatsApp con firma obligatoria y su **excepción en el gateway**; **kit de conformidad** con el mismo juego de 24 pruebas contra Telegram, WhatsApp y simulado · **prueba de humo** (`npm run smoke:notifications`) con **24 comprobaciones** en verde y el webhook verificado contra un doble de la Graph API (verificación → 401 sin firma → 200 con firma → respuesta enviada) |
| 5 | ✅ **completada** (2026-10-03) | 8 commits · `npm run verify` en verde con **206 pruebas** (+60 de integración: **266**, **267** tras el aviso a mano del botón «Notificar») · **`services/screens`** (nuevo, puerto 4007, [ADR 0030](adr/0030-pantallas-kiosko-y-sse.md)): proyección de la sala por eventos, histórico de llamados idempotente, dispositivos con ajustes y latido, y **flujo SSE** con estado completo; **login de pantalla kiosko** (token de dispositivo → JWT de rol `pantalla`); **`/secretaría`** con las acciones del flujo (registrar llegada, llamar —segundo llamado—, pasar a consulta, atendido con motivo, inasistencia y **llamada fuera de orden**); **displaylobby** con turno, nombre abreviado, 2.º llamado en rojo y **voz en español**; **pantalla de consultorio** con motivo y datos críticos en semáforo; **`/pantallas`** para registrar televisores y desactivarlos · **prueba de humo** (`npm run smoke:screens`) con **26 comprobaciones** en verde, con el llamado llegando al lobby en **882 ms** (después, 303-443 ms con el índice y el aviso sin espera) · se corrigió el **orden de los eventos del lote** (pg-boss no lo garantiza) · 30 ADRs |
| 6 | ⏭ **siguiente** | Historia clínica y odontograma (dos sesiones) |
| 4–10 | ⏳ pendientes | Ver §13 |

### Lo que quedó funcionando

```powershell
npm run db:bootstrap            # 8 bases + 8 roles + la cola de eventos (idempotente, --rotate, --only)
npm run build                   # tsc -b (servicios) + vite build (interfaz)
npm run keys:generate           # claves EdDSA del JWT (una sola vez; .keys/ está ignorado)
npm run db:migrate              # migraciones de todos los servicios
npm run db:verify-migrations    # comprueba que migran desde cero en una base limpia
npm run seed:users              # admin, recepcion y egomez con contraseña temporal
npm run seed:demo -- --count 5000   # pacientes ficticios deterministas (--reset los borra)
npm run seed:agenda             # solicitudes y citas de ejemplo para la jornada (--reset las borra)
npm run dev                     # compilación vigilada + gateway + identity + patients + scheduling + interfaz (5173)
npm test                        # 145 pruebas unitarias y de contrato
npm run test:integration        # 181 pruebas contra PostgreSQL real (outbox, cola, sesión, pacientes, agenda y rendimiento)
npm run smoke:auth              # recorre el ciclo de sesión por el gateway real
npm run smoke:patients          # registro, duplicado, edición y borrado con motivo y auditoría por el gateway real
npm run smoke:agenda            # ticket, cupo, franja, sobrecupo, reprogramación y aviso en lote por el gateway real
npm run verify                  # secretos + lint + formato + compilación + pruebas
pm2 start infra/windows/ecosystem.config.cjs   # o infra/windows/start-services.ps1
```

### Hallazgos de la Fase 0 que cambian supuestos

1. **Puerto del gateway: 8090 en lugar de 8080.** En Windows el 8080 lo ocupa el servicio de red del
   host (`hns`/Hyper-V) y el gateway moría con `listen EACCES`. Se unificó en 8090 en todo el
   proyecto (código, `.env.example`, README, plan y guía de Fedora).
2. **TypeScript 5.9.3 en lugar de 7.x** (ver [ADR 0022](adr/0022-typescript-5-9.md)).
3. **PostgreSQL 18**, no 16, porque es el que estaba instalado; Fedora se alinea a la misma
   versión mayor para que las migraciones sean idénticas.
4. **El shell de la máquina es Windows PowerShell 5.1**: los scripts de operación usan solo
   cmdlets compatibles (nada de `utf8NoBOM` ni de operadores de PowerShell 7).

### Hallazgos de la Fase 1 que cambian supuestos

1. **Un `preHandler` síncrono cuelga la petición en Fastify.** Las guardias de permiso son
   `async` a propósito: si una función de un solo parámetro devuelve `undefined` sin llamar a
   `done()`, Fastify espera para siempre. Hay una prueba que lo vigila
   (`packages/kernel/src/auth/identity.test.ts`).
2. **drizzle-kit parametriza los `CHECK`** que se construyen con valores interpolados
   (`in ($1, $2)`) y el migrador no sustituye parámetros en DDL. Los `CHECK` de roles y tipo de
   pantalla se escriben como literales desde las constantes del contrato, y hay una prueba que
   verifica que ninguna migración contenga `$n`.
3. **Cada servicio es dueño de su prefijo público.** El gateway ya **no recorta** la ruta
   (`/api/v1/users` llega igual a identity): con varios prefijos apuntando al mismo servicio,
   recortarlos provocaba colisiones. La única excepción es el alias de salud.
4. **El puerto 5173 lo ocupa el servidor de desarrollo de la interfaz.** Antes de arrancar otro
   (`npm run dev`), comprobar que no haya un Vite vivo de una sesión anterior.
5. **La preferencia de tema se guarda por equipo, no por usuario** (`odontocrm:tema`), a
   diferencia de lo que decía §10. En un consultorio con 2–3 equipos compartidos, el tema es una
   preferencia del puesto de trabajo (y así la pantalla de login ya respeta lo elegido). Si se
   prefiere por usuario, basta con prefijar la clave con el nombre de usuario.
6. **Permisos de los módulos futuros** (los placeholders ya los respetan): recepción y
   programación → `scheduling:write`; registro → `patients:write` (registra, no solo consulta);
   secretaría → `scheduling:read`; consultorio → `clinical:read`; reportes → `reports:read`;
   auditoría → `audit:read`; pantallas → `screens:manage`.

### Hallazgos de la Fase 2 que cambian supuestos

1. **pg-boss necesita una cola compartida** ([ADR 0026](adr/0026-cola-de-eventos-compartida.md)):
   sus tablas viven en una sola base, así que una cola por servicio sería invisible para los demás
   servicios. Se creó la base `odonto_events`; cada servicio conserva su `outbox_events` para la
   garantía transaccional y publica allí. Los consumidores son idempotentes
   (`processed_events`), y hay una prueba de integración que lo verifica.
2. **La edad se calcula en UTC.** Las fechas de nacimiento llegan como `YYYY-MM-DD` (medianoche
   UTC) y los getters locales las interpretan como el día anterior en Venezuela (UTC−4): eso
   convertía a un menor de 18 en mayor un día antes. Se detectó escribiendo la prueba del
   contrato.
3. **`Expect: 100-continue` rompía el proxy.** `Invoke-WebRequest` de PowerShell (y `curl` con
   cuerpos grandes) envían esa cabecera, y el cliente HTTP del proxy (undici) la rechaza con un
   500. El gateway la elimina antes de reenviar: es una optimización, no un requisito.
4. **Los campos opcionales aceptan `null`.** Los formularios y los clientes JSON mandan `null`
   para «vacío»; el contrato lo normaliza junto con `''` en lugar de rechazarlo con 400.
5. **El seed de demo avisa en vez de chocar.** Una segunda ejecución sin `--reset` encontraba el
   índice único de documentos; ahora detecta los datos ficticios existentes y explica cómo
   regenerarlos (los datos sembrados usan el rango 90.000.000+ y el banco de pruebas el 97.000.000+,
   para que nunca se pisen).
6. **La auditoría de un cambio sensible vive en identity**, no en el servicio de pacientes: el
   evento viaja por el outbox y allí se traduce a `audit_events` con `before`, `after`, motivo,
   usuario e IP. El servicio de pacientes conserva además un historial local de datos de contacto
   para consultarlo sin salir de él.

### Hallazgos de la Fase 3 que cambian supuestos

1. **El trabajador de la cola necesitaba lotes.** Con los valores por defecto de pg-boss (un evento
   por ciclo y sondeo cada 2 s) un pico de 150 eventos tardaba **minutos** en auditarse: la cola
   quedaba con trabajos en estado `created` y la auditoría aparecía con retraso. El consumidor ahora
   toma **50 eventos por ciclo cada segundo** y la cola se vacía en segundos. Lo destapó la prueba de
   integración de auditoría, que esperaba el registro y no llegaba.
2. **Una sola silla exige una garantía en la base.** Además de comprobar el solapamiento, hay un
   **índice único parcial** en `(appointment_date, start_time)` para las citas activas: dos personas
   asignando la misma hora a la vez no pueden crear dos citas (la segunda recibe 409). El índice es
   parcial a propósito: cancelar o reprogramar libera el hueco.
3. **`cancelar` una cita devuelve el ticket a la cola** ([ADR 0028](adr/0028-cancelar-devuelve-el-ticket.md)):
   el paciente sigue esperando, así que la solicitud vuelve a `en_espera_cita` con su historial.
4. **Zod 4 no deja derivar `.partial()` de un esquema con refinamientos.** La edición parcial de las
   plantillas de franjas se declara como objeto propio (el esquema completo valida jornada y pausas).
5. **El ticket no se guarda formateado.** `#000123` se calcula desde `ticket_number` al responder, así
   que hay una sola fuente de verdad; la búsqueda por ticket lo interpreta y consulta por el número
   (ver §4.3).
6. **La auditoría ganó un `summary` legible** (migración `0003` de identity): la carga genérica de
   auditoría que publican los servicios nuevos trae la frase ya redactada («Cita para María Pérez el
   06/10/2026 a las 08:00») y la lista de auditoría no tiene que reconstruirla.
7. **`Expect: 100-continue`, lotes y demás**: el gateway ya toleraba esa cabecera desde la Fase 2; el
   `fetch` de las pruebas de humo lleva tiempo límite y corta al instante si el login falla, para que
   un fallo de sesión no convierta la prueba en una espera de minutos.

### Hallazgos de la Fase 4 que cambian supuestos

1. **Una cola compartida reparte los eventos, no los difunde.** pg-boss entrega cada trabajo a **un
   solo** trabajador: con una única cola, identity auditaba unos eventos y notifications no se
   enteraba de otros (lo destapó la prueba de humo del aviso de cita). Ahora **cada servicio declara
   su cola** (`domain-events.<servicio>`) y el publicador entrega una copia en cada una
   (`enqueueDomainEvent` descubre las colas existentes). Añadir un consumidor nuevo no toca a los
   demás, y las pruebas de integración usan su propia cola sin competir con los servicios reales.
2. **El asistente se guioniza en la base, no en el código.** El estado de cada conversación vive en
   `bot_conversations`, así que un paciente puede desaparecer y volver: el bot retoma el paso donde
   estaba. Los pasos se validan uno a uno y un mensaje inválido **no avanza** y explica el error.
3. **El aviso se arma una sola vez.** El evento `scheduling.appointment.scheduled` viaja con el
   mensaje ya redactado (fecha, hora en 12 h, lugar y ticket) y la clave de deduplicación
   `cita + plantilla + secuencia` garantiza que un reintento o un evento repetido no vuelva a
   escribirle al paciente.
4. **Los intentos se agotaban al primero.** `maxAttempts` nació en 1 y un fallo de red daba el
   aviso por perdido: ahora usa la cadena del plan (1 m, 5 m, 15 m, 1 h, 6 h) y el reintento manual
   la reinicia.
5. **El `.ics` se genera con horas UTC** (`DTSTART:20261202T123000Z`), con `SEQUENCE` que sube al
   reprogramar y un recordatorio 30 minutos antes: los calendarios actualizan el evento en vez de
   duplicarlo, y la web lo descarga desde `/api/v1/notifications/ics/:appointmentId` (el prefijo
   `/appointments` pertenece a la agenda en el gateway).

### Hallazgos de la Fase 4.1 que cambian supuestos

1. **El «paso 2» del refactor se hizo antes de la Fase 5** (decisión de la sesión del 2026-10-03):
   dejar el núcleo atado a Telegram y añadir WhatsApp después habría obligado a reescribir el
   asistente dos veces. Los adaptadores, el webhook y el kit de conformidad quedan cerrados como
   **fase-4.1**, etiqueta propia y revertible en bloque.
2. **La firma de Meta se calcula sobre los bytes exactos.** El servicio guarda el **cuerpo crudo**
   en el analizador de contenido (y el proxy del gateway ya reenviaba el texto tal cual): si se
   re-serializara el JSON, `x-hub-signature-256` no cuadraría. Es la razón de que el webhook tenga
   su propio analizador y de que la ruta se documente como «pública pero firmada».
3. **El `offset` del sondeo dejó de persistirse**: vive dentro del adaptador de Telegram y la
   idempotencia real la da `processed_updates` por `(canal, evento_id)`. Sobraba la tabla `bot_state`
   (se elimina en la migración `0001`) y sobraba el poller del servicio.
4. **Sin token no se sondea.** El adaptador de Telegram solo arranca su bucle en modo real: con el
   transporte simulado un `getUpdates` que responde al instante giraría en vacío.
5. **Un mensaje que falla no puede tumbar el lote del webhook.** Meta exige un 200 rápido y
   reintentar no ayuda (el evento ya está marcado como procesado), así que el adaptador cuenta los
   fallidos, los registra y sigue con el resto.
6. **Las opciones numeradas viven en la conversación, no en memoria.** `bot_conversations.opciones`
   guarda la última lista enviada: si el paciente tarda un día en responder «2», el asistente
   recuerda qué era.

### Hallazgos de la Fase 5 que cambian supuestos

1. **La cola no garantiza el orden del lote.** `pg-boss` entrega los trabajos de un lote
   en orden arbitrario: al aplicar `called` antes que `checked_in`, el paciente quedaba
   «en sala de espera» en vez de «llamado» (el lobby no lo mostraba) y `attended` antes
   que `in_consultation` volvía a ocupar el consultorio después de que el paciente se
   fuera. Lo destapó la prueba de humo, no las pruebas de integración (que aplicaban los
   eventos de uno en uno). Ahora el lote se **ordena por `occurredAt`** y la proyección
   **no retrocede** ni resucita a quien ya salió (lápida `left_at` en `room_state`).
2. **La latencia del llamado: un temporizador, no la base de datos.** Con el publicador
   del outbox cada 2 s y el consumidor cada 1 s, el aviso tardaba hasta 3 s. Se midió el
   reparto: **outbox 15-50 ms** (se adelanta con `kick()` en cuanto cambia un estado, en
   vez de esperar al temporizador; sin él, hasta 500 ms), **cola 34-514 ms** (12 muestras,
   media 288 ms; `pg-boss` no admite sondeo por debajo de 500 ms:
   `MIN_POLLING_INTERVAL_MS`), **proyección + trama SSE 20-50 ms** y **proxy 1 ms**. Total
   extremo a extremo: **303, 443 y 304 ms** en tres corridas limpias (~0,8 s peor caso), y
   **ninguno de esos términos depende del volumen de datos**.
3. **Una consulta del camino crítico sí crecía con los datos.** Contar los llamados de una
   cita (para numerar el 2.º) y buscar el último llamado de cada cita eran **escaneos
   secuenciales**: medido con 200.000 llamados sintéticos, 36 ms y 38 ms; con el índice
   `idx_call_events_appointment` (migración `0001`), 0,08 ms y 0,03 ms. El resto del camino
   iba por índice (O(log n)), incluidas las consultas sobre las lápidas de `room_state`,
   que siguen planas con 200.000 filas (0,10 ms).
4. **La latencia hay que medirla como la vive el televisor.** El primer intento medía con
   sondeos HTTP y daba 19 s: era el saludo TCP de cada sondeo en una máquina cargada (el
   servicio respondía en 2-4 ms). La medición buena se hace **por el flujo SSE**, que es
   una única conexión abierta antes del llamado; y para saber qué añade el gateway se
   comparó el mismo flujo directo al servicio y a través del proxy (1 ms de diferencia).
5. **Una pantalla no puede tener sesión de usuario.** El token de dispositivo se canjea
   por un JWT de rol `pantalla` (solo `screens:display`) que se renueva solo, y `screens`
   comprueba además que la pantalla siga activa: desactivarla corta el acceso al instante.
6. **`EventSource` no manda cabeceras.** El kiosko abre el SSE con `fetch` y gestiona a
   mano la reconexión, el `Last-Event-ID` y un **refresco de respaldo** por HTTP cada 20 s
   (si el flujo muere en silencio, el estado se corrige igual).
7. **Los ajustes de la pantalla no viven en identity.** El login del dispositivo no puede
   traerlos (son de `screens`), así que la pantalla pide su ficha con
   `GET /api/v1/screens/device` y de ahí salen voz, volumen y segundos de resalte.
8. **El motivo de la consulta lo publica la agenda.** Para que la pantalla del consultorio
   lo muestre sin leer la base de otro servicio, `scheduling` lo añade al evento de la
   cita; los datos clínicos (alergias, crónicos) llegan por la ruta interna que usará la
   Fase 6.
9. **Un servidor de desarrollo viejo deja una pantalla en negro sin mensaje.** El 5173
   seguía ocupado por un Vite de la sesión anterior con el grafo de módulos roto; como el
   puerto es estricto, `npm run dev` no arrancaba y el navegador miraba el servidor viejo
   (`#root` vacío, consola parada en «[vite] connecting…»). Se comprobó abriendo la página
   con Chromium sin interfaz, que es la única forma de ver este tipo de fallo. Ahora hay
   preflight de puertos (`npm run dev:check`, automático antes de `dev`), parada de restos
   (`npm run dev:stop`), comprobación de que la SPA monta (`npm run check:web`) y una
   reserva visible en la página para que el fallo nunca sea un negro mudo.
10. **Un evento publicado no es un aviso enviado.** El botón «Notificar» de la programación
   publicaba `scheduling.appointment.notified` desde la Fase 3, pero el consumidor de la
   Fase 4 solo escuchaba tres temas: **42 eventos publicados y ni un solo aviso**. La cita
   quedaba como `notificada` sin que el paciente recibiera nada, y el texto que lo advertía
   en la interfaz se leía como «obsoleto» (hablaba de la Fase 4) cuando estaba describiendo
   un hueco real. Lección para las fases siguientes: **cada tema del catálogo necesita un
   consumidor o una prueba que falle si no lo tiene** (el humo de notificaciones ya lo cubre);
   y un texto de la interfaz que promete algo debe caducar con la funcionalidad, no antes.
11. **El estado del paciente también necesitaba proyección.** Al asignarle una cita, el
   paciente seguía en `en_espera_cita` para siempre: el estado lo escribe `patients` (su base)
   y no había consumidor de los eventos de agenda, así que en `/pacientes` aparecía «En espera
   de cita» con la cita programada y el `.ics` enviado. Se arregló con un consumidor en
   `patients` (idempotente, sin resucitar bajas) y una reparación de los datos anteriores.
   Regla general: **si un evento cambia un dato de otro servicio, ese servicio necesita su
   proyección y una prueba que la cubra**; el humo de agenda ya crea un paciente nuevo y
   comprueba la transición.
12. **La cola padre `domain-events` recibe una copia que nadie trabaja.** El publicador entrega
   el evento a todas las colas conocidas (`domain-events` y `domain-events.<servicio>`), pero en
   este despliegue ningún servicio trabaja la padre: acumula trabajos en estado `created` que no
   se borran (≈970 tras un día de pruebas), porque la retención de `deleteAfterSeconds` solo
   aplica a los completados. Es **crecimiento de almacenamiento, no de latencia**. Opciones para
   la Fase 10: no publicar en la padre cuando hay colas de consumidores, trabajarla, o darle
   retención a los `created`.
13. **El buscador de la bandeja ataba la entrada al valor diferido.** El campo usaba el texto
   con retardo (350 ms) como `value`, así que las letras aparecían tarde y el cursor saltaba:
   medido en un navegador real, **406 ms por letra**. La consulta puede diferirse; **el campo,
   nunca**. Checklist para los buscadores que vengan: `value` = estado inmediato,
   `queryKey`/petición = valor diferido, y medirlo con un navegador (el retardo de red no era
   el problema: la API responde en 1-38 ms).

### Próximo paso

Arrancar la **Fase 6** en una sesión nueva (son dos): **historia clínica** con las 11
secciones de [`formato_historia.md`](formato_historia.md), catálogos tipificados + «otros»,
estados `BORRADOR → FIRMADA` y adendas; y el **odontograma FDI** con captura por excepción,
histórico de hallazgos y el componente SVG con carga por teclado.

Dos ganchos ya están puestos para esa fase:
- `POST /internal/v1/screens/room/critical-flags` recibe alergias y crónicos y los pinta la
  pantalla del consultorio con semáforo de riesgo (hoy avisa de que aún no hay datos).
- `POST /api/v1/appointments/:id/attend` acepta `clinicalSessionId`: cuando exista la sesión
  cerrada, el «atendido» deja de pedir motivo (hoy lo exige y lo deja en la auditoría).

Misma regla: `npm run verify` en verde, commits atómicos y tag `fase-6`.

> Este documento es la referencia viva del proyecto: cualquier cambio de alcance se refleja aquí
> **antes** de escribir código, y cada decisión relevante se registra como ADR en
> [`docs/adr/`](adr/README.md).
