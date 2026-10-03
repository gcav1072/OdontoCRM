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
| 10 | Confirmaciones | Asignar deja la cita en `PROGRAMADA`/`pendiente de notificar`; botón **«Notificar»** envía **en lote con vista previa** y permite **reenviar individual**. |
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
| 1 | `apps/gateway` | Punto único de entrada, proxy por recurso, verificación de JWT/token de dispositivo, rate limit, CORS, correlación de peticiones. | — | 8080 |
| 2 | `services/identity` | Usuarios, roles/permisos, login, refresh rotativo, cambio/restablecimiento de contraseña, bloqueo por intentos, **auditoría** (eventos + consulta con diff). | `odonto_identity` | 4001 |
| 3 | `services/patients` | Paciente único (cédula V/E/P/SC), datos de contacto, representante de menores, estado (`en_espera_cita`, `activo`, `inactivo`), búsqueda/duplicados, **almacenamiento de archivos** (abstracción S3-ready sobre disco). | `odonto_patients` | 4002 |
| 4 | `services/scheduling` | Solicitudes (**ticket**), cola «en espera de cita», cupo diario editable, plantilla de franjas, asignación/reprogramación/cancelación, estados de la cita, inasistencias. | `odonto_scheduling` | 4003 |
| 5 | `services/notifications` | Bot de Telegram (long polling), asistente validado, plantillas, cola de envíos con reintentos e idempotencia, vinculación chat↔paciente por deep link, **generación de `.ics`**. | `odonto_notifications` | 4004 |
| 6 | `services/clinical` | Historia clínica estructurada (según `formato_historia.md`), sesiones clínicas, diagnósticos, **récipes**, adjuntos imagenológicos, **PDF A5** y QR de verificación. | `odonto_clinical` | 4005 |
| 7 | `services/odontogram` | Odontograma FDI de 2 dígitos, captura por excepción, histórico de hallazgos, eventos. Implementa `implementation_plan_odontogram_microservice.md`. | `odonto_odontogram` | 4006 |
| 8 | `services/screens` | Estado de las pantallas de sala y consultorio, turnos, llamados (1.º/2.º), **SSE** para actualización en vivo, registro de dispositivos kiosko. | `odonto_screens` | 4007 |
| 9 | `services/reporting` | Read model por eventos, vistas materializadas, KPIs, filtros (fecha, rango de edad, sexo, estado), exportación CSV/PDF. | `odonto_reporting` | 4008 |

> **Costo asumido:** 9 procesos + 8 bases + outbox es más operación que un monolito modular. Se mitiga con un único comando de arranque (`npm run dev`), migraciones y seeds automatizados, health checks y el `ecosystem.config.cjs` de PM2. Si en la práctica resulta pesado, el camino de repliegue es fusionar `odontogram` + `clinical` y `screens` + `reporting` sin tocar contratos públicos.

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
- `patient_guardians` (representante de menores: nombre, cédula, parentesco, teléfono).
- `patient_contacts_history` (teléfono/dirección anteriores → alimenta auditoría de datos sensibles).
- `files` (metadatos de adjuntos: `owner_type`, `owner_id`, `kind` (`radiografia|foto|pdf|consentimiento`), `mime`, `size`, `sha256`, `storage_path`, `uploaded_by`). El binario vive en `storage/` con **abstracción `BlobStore`** (implementación disco hoy, S3/MinIO mañana sin cambiar llamadas).
- `ticket_counters` no va aquí: el consecutivo de ticket pertenece a `scheduling`.

### 4.3 `scheduling`
- `appointment_requests` (**ticket**): `ticket_number bigint` ← `SEQUENCE`, `ticket_display` (`#000123` / `A-000001`), `channel` (`telegram|registro|telefono|presencial`), `patient_id`, `reason` (motivo de consulta), `status`, `priority`, `requested_at`, `notes`, `created_by`.
- `appointments`: `patient_id`, `request_id`, `appointment_date`, `start_time`, `end_time`, `dentist_id`, `chair_id`, `status`, `call_count`, `checked_in_at`, `started_at`, `finished_at`, `no_show_reason?`, `force_attended_reason?`, `rescheduled_from_id?`, `ics_sequence` (se incrementa al reprogramar).
- `day_capacities`: `date` (PK), `capacity` (**editable en cualquier momento, incluso después de asignar**), `notes`, `updated_by`.
- `slot_templates`: `weekday`, `start_time`, `end_time`, `slot_minutes`, `breaks jsonb`, `is_active`.
- `status_history` (transiciones con actor y timestamp → alimenta reportes de tiempos de espera).
- `audit_outbox*`: la tabla `outbox_events` la crea `packages/db` en cada BD.
- **Consecutivo:** `CREATE SEQUENCE ticket_seq START 1;` → `nextval` es atómico: dos solicitudes simultáneas nunca colisionan. `cycle = floor((n-1)/999999)`; prefijo `''` para ciclo 0, `A`…`Z`, luego `AA`… si algún día hiciera falta.

### 4.4 `notifications`
- `patient_channels`: `patient_id`, `channel` (`telegram`), `chat_id`, `telegram_username?`, `linked_at`, `link_code`, `link_code_expires_at`, `is_blocked`.
- `bot_conversations`: `chat_id`, `state` (paso del asistente), `draft jsonb`, `updated_at` — permite retomar el asistente si el paciente se va y vuelve.
- `message_templates` (clave, canal, asunto, cuerpo con placeholders, `is_active`) — el texto de confirmación es **editable sin recompilar**.
- `message_outbox` / `message_log`: `patient_id`, `appointment_id?`, `template_key`, `payload jsonb`, `status` (`queued|sending|sent|failed|skipped_no_channel`), `attempts`, `last_error`, `provider_message_id`, `sent_at`.
- `ics_artifacts`: `appointment_id`, `sequence`, `content text`, `sha256`, `generated_at` (reproducible y auditable).
- Reintentos con backoff exponencial (1 m, 5 m, 15 m, 1 h, 6 h) y **modo «manual pendiente»** cuando no hay `chat_id`.

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
- `screen_devices` (`label`, `kind` (`lobby|consultorio`), `device_token_id`, `last_seen_at`, `is_active`, `settings jsonb` con voz on/off, volumen, tiempo de resalte).
- `call_events` (`appointment_id`, `patient_display_name`, `turn_number`, `call_number` 1/2, `chair_label`, `called_at`, `called_by`, `acknowledged_at`).
- `room_state` (paciente en consultorio: `appointment_id`, `patient_id`, `since`, `critical_flags` — proyección de alergias/crónicos recibida por evento).

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
| Registro/edición de pacientes (con motivo) | ✅ | ✅ | lectura | ❌ |
| Programar jornada, cupos, notificar | ✅ | ✅ | lectura | ❌ |
| Llamar / pasar a consulta / no asistió | ✅ | ✅ | ✅ | ❌ |
| Marcar atendido | ✅ | ✅ (con advertencia) | ✅ | ❌ |
| Historia clínica, sesiones, récipes, odontograma | ✅ | ❌ | ✅ | ❌ |
| Reportes y auditoría | ✅ | reportes operativos | clínicos | ❌ |
| Displaylobby / pantalla consultorio | ✅ | ✅ | ✅ | ✅ (solo lectura) |

---

## 6. API y rutas del gateway

Un solo origen para el frontend: `http(s)://<host>:8080/api/v1/**`.

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
| `/api/v1/screens/**` | screens | `POST /devices`, `GET /lobby/stream` (SSE), `GET /consultorio/stream` (SSE) |
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

**Criterios de aceptación:** `npm run verify` verde · `npm run db:bootstrap` crea las 8 BD desde cero · `GET :8080/health` responde OK con estado de la BD del servicio piloto · `npm run build` genera artefactos · `.gitignore` impide que `node_modules` y `.env` entren a git (comprobado con `git status`).

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

**Entregables:** `notifications` (poller único, asistente de 7 pasos con validación/normalización, `/estado` por ticket, `/cancelar`, idempotencia por `update_id`, anti-flood, `bot_conversations` reanudables, vinculación por deep link y QR, plantillas editables, cola con reintentos y backoff, `ics_artifacts` + `GET /appointments/:id/ics`, modo «manual pendiente») · integración REST interna con `patients` y `scheduling` · modo simulado para pruebas (sin token real) · web `/notificaciones` (bandeja de envíos, errores, reintento manual, plantillas) · guion de mensajes revisable.

**Criterios de aceptación:** un flujo completo en Telegram real (o chat de pruebas) genera un ticket visible en `/programacion`; un `update_id` repetido no duplica tickets; el `.ics` abre correctamente en Google Calendar y en Apple Calendario con la hora correcta de Caracas; mensaje inválido en cualquier paso no avanza y explica el error; paciente sin Telegram queda en «manual pendiente» con su guion de llamada; reintentos automáticos visibles en la bandeja.

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

**Decisiones abiertas con default (dime si cambias alguna; si no, avanzo con el default)**

| Tema | Default propuesto |
| :--- | :--- |
| Sobrecupo | Bloqueado por defecto; `admin` puede autorizarlo con motivo y queda en auditoría. |
| Recordatorios | Telegram 24 h y 2 h antes (fase posterior al plan actual). |
| Duración de cita | 30 min por franja, editable por día. |
| Impresión | Récipe en **A5**; historia clínica y consentimiento en **A4**. |
| Copia del récipe al paciente | Descarga/impresión desde el historial; envío por Telegram queda para fase posterior. |
| Numeración de historia | `HC-000001` por paciente, secuencia global. |
| Membrete | Genérico hasta que envíes logo, RIF, teléfonos y datos del odontólogo (MPPS, especialidad). |
| Nombre del bot | Bot de BotFather con **nombre visible «Consultorio - Od. Erika Gómez»** por los momentos (el nombre visible se cambia cuando quieras). El `@usuario` es único y también se puede cambiar, pero **cambiar el `@usuario` rompe los enlaces `t.me/...` ya compartidos**; si eso pasa, se crea otro bot y se reemplaza el token. El token se entrega por archivo `.env` según `docs/SEGURIDAD_SECRETOS.md` — **nunca por chat ni en el repo**. |

---

## 17. Próximo paso

1. **Plan aprobado** (2026-10-02) con los ajustes del usuario: horas en 12 h, bot «Consultorio - Od. Erika Gómez» y PostgreSQL 18.
2. ~~Instalar PostgreSQL~~ ✅ **Ya está instalado** (`postgresql-x64-18`, puerto 5432). Falta que crees el `.env` local con el password del superusuario para que el bootstrap cree las 8 bases y sus roles (ver `docs/SEGURIDAD_SECRETOS.md`).
3. **Fase 0 en ejecución**: `.gitignore`, monorepo, kernel, outbox, bootstrap de las 8 BD, ADRs y tag `fase-0`.

> Al aprobarlo, el trabajo pasa a `docs/adr/` como decisiones formales y este documento queda como referencia viva: cualquier cambio de alcance se refleja aquí **antes** de escribir código.
