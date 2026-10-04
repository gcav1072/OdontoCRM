# Auditoría de conexiones antes de la Fase 6

> Fecha: 2026-10-04 · Alcance: **todo lo construido en las fases 0 a 5 + 4.1**.
> Objetivo: entrar en la Fase 6 (historia clínica + odontograma) sin deuda de
> integración. Cada comprobación de este documento se puede repetir con el comando
> que se indica; ninguna afirmación va sin su evidencia.

## 1. Veredicto

**Las conexiones están sanas.** Las cinco matrices (eventos, HTTP, auditoría, bases,
permisos) salen sin huecos abiertos: el outbox de los cinco servicios está a **0
pendientes**, ninguna ruta queda inalcanzable, ninguna llamada de la interfaz apunta a
un prefijo que no exista y las rutas internas no se alcanzan por el gateway ni con un
JWT de administrador.

Los dos huecos de integración que **sí** aparecieron en los últimos días (el aviso a
mano del botón «Notificar» y el estado del paciente) **ya están cerrados y cubiertos
por pruebas**; esta auditoría confirma que no queda ninguno de esa familia.

Quedan tres cosas que no son fallos de conexión sino **deuda de mantenimiento**, con
su arreglo propuesto en §5: los trabajos muertos de la cola compartida, las variables
de configuración sin documentar y dos temas del catálogo de eventos que se declaran y
no se publican.

## 2. Cómo se hizo (reproducible)

| Comprobación | Comando |
| :--- | :--- |
| **Todo de una pasada** | **`npm run audit`** (y `-- --solo eventos\|http\|permisos\|datos`) |
| Matriz de eventos | `npm run audit -- --solo eventos` |
| Matriz HTTP | `npm run audit -- --solo http` |
| Permisos y configuración | `npm run audit -- --solo permisos` |
| Bases y cola | `npm run audit -- --solo datos` |
| Migraciones desde cero | `npm run db:verify-migrations` |
| Suite de integración | `npm run test:integration` |
| Humos de punta a punta | `npm run smoke:auth · patients · agenda · notifications · screens` |
| La SPA monta | `npm run check:web` |
| Menú del bot | `npm run telegram:menu` |

La auditoría quedó como **herramienta del proyecto** (`tools/audit-conexiones.mjs`, `npm run audit`):
sale con código 1 solo si encuentra algo estructural (ruta inalcanzable, ruta interna expuesta,
outbox atascado o cola con basura) e informa aparte de la deuda y de lo que aún no existe por ser
de una fase futura. Conviene ejecutarla al cerrar cada fase.

## 3. Las matrices

### 3.1 Eventos (catálogo ↔ productores ↔ consumidores)

- **Todos los temas que se publican tienen quien los escuche** o quedan auditados por
  la forma genérica (`domainAuditPayloadSchema`, `services/identity/src/audit/event-consumer.ts`).
- **Temas con consumidor funcional:** `appointment.scheduled` → notificaciones +
  pacientes (+ auditoría); `appointment.rescheduled` → notificaciones + pantallas;
  `appointment.cancelled` → notificaciones + pantallas; `appointment.notified` →
  notificaciones; `checked_in`/`called`/`in_consultation`/`attended`/`no_show` →
  pantallas; `patient.created`/`updated`/`deleted` → auditoría.
- **Sin consumidor funcional y sin necesitarlo** (solo auditoría):
  `request.created`, `request.cancelled`, `capacity.changed`, `overbook.authorized`.
- **Declarados para la Fase 6** (contrato ya escrito, sin productor todavía):
  `clinical.record.*`, `clinical.session.*`, `clinical.prescription.*`,
  `odontogram.finding.*` — 10 temas listos.
- **Declarados sin usar** (hallazgo 3 de §5): `identity.user.*`,
  `identity.session.*`, `patients.file.uploaded`, `notifications.message.sent`,
  `notifications.message.failed`, `notifications.patient_channel.linked`.

### 3.2 HTTP (gateway ↔ servicios ↔ interfaz)

- **14 prefijos** en el gateway, incluidos **`/api/v1/clinical`, `/api/v1/odontogram`
  y `/api/v1/reports`** que ya existen y se activan solos cuando se defina
  `CLINICAL_URL`, `ODONTOGRAM_URL` y `REPORTING_URL` en el `.env` (Fase 6 y 9).
- **68 rutas públicas** en los servicios: **0 sin prefijo** en el gateway.
- **52 llamadas de la interfaz**: **0 sin prefijo** (repartidas: 10 citas, 9
  notificaciones, 7 pacientes, 6 agenda, 6 pantallas, 5 sesión, 4 usuarios, 3
  solicitudes, 2 dispositivos).
- **9 rutas internas** (`/internal/v1/...`): ninguna coincide con un prefijo público.
  Comprobado en vivo **con un JWT de administrador**: las tres rutas internas
  principales responden **404** por el gateway (no enrutadas) y **403** si se llaman
  directas sin el secreto; la ruta pública de control responde 200.

### 3.3 Auditoría

- Forma **genérica** (`domainAuditPayloadSchema`): la usan todos los eventos de agenda
  y la usarán clínica y odontograma. Es la que hace que «toda transición quede
  auditada» sin escribir nada por servicio.
- Forma **de pacientes** (Fase 2) se mantiene por compatibilidad.
- Idempotencia por `processed_events` (un reintento de la cola no duplica auditoría).
- Verificado hoy con datos reales: el cambio de estado del paciente `V-28139170`
  aparece como `patient_status_changed` con motivo y actor «sistema».

### 3.4 Bases de datos y cola

```
SERVICIO        BASE                    TABLAS  MIGRACIONES  OUTBOX SIN PUBLICAR
identity        odonto_identity         7       4            0
patients        odonto_patients         5       1            0
scheduling      odonto_scheduling       6       2            0
notifications   odonto_notifications    7       4            0
screens         odonto_screens          4       2            0
clinical        odonto_clinical         0       —            —
odontogram      odonto_odontogram       0       —            —
reporting       odonto_reporting        0       —            —
```

- Migraciones **desde cero en bases limpias**: los cinco servicios ✔ (incluye la
  migración de datos 0003 de plantillas).
- **Ningún outbox atascado**: 0 filas sin publicar en todos los servicios.
- Las tres bases de la Fase 6 **ya existen, con su rol, su contraseña, su
  `INTERNAL_SERVICE_SECRET` y su `EVENTS_DATABASE_URL`** (`services/clinical/.env`,
  `odontogram`, `reporting`): la Fase 6 empieza escribiendo migraciones, no
  aprovisionando.
- **Cola compartida** (`pgboss.job`): la cola padre `domain-events` acumulaba trabajos
  en estado `created` que nadie trabaja y que no se borran nunca (la retención solo
  aplica a los completados) → hallazgo 1 de §5, **arreglado en esta sesión**: hoy el
  estado es **0 trabajos pendientes de procesar en colas sin trabajador**.

### 3.5 Permisos (RBAC)

17 permisos en el contrato; **12 se exigen en rutas del servidor** y los **5 restantes
son exactamente los de la Fase 6/9**: `clinical:read`, `clinical:write`,
`odontogram:read`, `odontogram:write`, `reports:read`. La matriz de roles ya está
decidida para la Fase 6:

| Rol | Clínica | Odontograma | Pacientes | Agenda | Pantallas |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `admin` | todo | todo | todo | todo | todo |
| `odontologo` | leer + escribir | leer + escribir | leer + escribir | leer | mostrar |
| `secretario` | **sin acceso** | **sin acceso** | leer + escribir | leer + escribir + notificar | mostrar |
| `pantalla` | — | — | — | — | mostrar |

> **Decisión que hay que confirmar antes de la sesión A**: el `secretario` no tiene
> `clinical:read`. Si la secretaría debe **imprimir el récipe o el consentimiento**,
> necesita al menos lectura; hoy no la tiene. Es una decisión de producto, no un
> descuido (el plan §Matriz de permisos da «❌» a la secretaría en clínica).

### 3.6 Configuración

- `.env.example` menciona **49 variables**; los servicios leen **~30 más** sin
  documentar (ajustes finos con valor por defecto). Es el hallazgo 2 de §5 y se
  arregla en esta misma sesión.
- La configuración se valida con Zod al arrancar: un servicio no levanta con una
  variable mal puesta (probado: los cinco arrancan y responden `/ready` con
  `database: ok`).

### 3.7 Llamadas entre servicios

Solo hay **dos clientes internos** hoy (`screens/internal-client.ts` y
`notifications/internal-client.ts`) y ambos siguen el mismo patrón, que es el que debe
copiar la Fase 6:

1. `fetch` directo a `127.0.0.1` (no por el gateway),
2. cabecera `x-internal-token` con `INTERNAL_SERVICE_SECRET`,
3. **timeout de 5 s** (`AbortSignal.timeout`),
4. **degradación limpia**: si el otro servicio no responde, se devuelve `null` y la
   operación principal sigue (la pantalla muestra menos datos, no falla).

### 3.8 Salud y arranque

- Los cinco servicios responden `/ready` con `database: ok`; el gateway responde
  `/health` y `/ready`.
- Registros de error: solo **histórico** ya resuelto (el `EACCES` del 8080 de la Fase
  0, la falta de `IDENTITY_URL` antes del bootstrap, un `ZodObject.partial()` de la
  Fase 3 y avisos de `--env-file` que ya no se emiten). Ningún error de la sesión
  actual.

## 4. Lo que la Fase 6 ya tiene hecho

| Pieza | Estado | Dónde |
| :--- | :--- | :--- |
| Bases, roles, credenciales y cola de `clinical`/`odontogram` | ✅ creadas y vacías | `services/*/.env`, `npm run db:bootstrap` |
| Permisos de clínica y odontograma + roles | ✅ en el contrato | `packages/contracts/src/domain/enums.ts` |
| Enums de estados (historia, sesión, récipe) | ✅ | `MEDICAL_RECORD_STATUSES`, `CLINICAL_SESSION_STATUSES`, `PRESCRIPTION_STATUSES` |
| 10 temas de eventos clínicos y de odontograma | ✅ declarados | `packages/events/src/topics.ts` |
| Prefijos del gateway | ✅ | `/api/v1/clinical`, `/api/v1/odontogram` |
| Auditoría de los eventos clínicos | ✅ sin escribir nada: forma genérica | `domainAuditPayloadSchema` |
| Datos críticos del paciente en pantalla (alergias/crónicos) | ✅ ruta interna lista | `POST /internal/v1/screens/room/critical-flags` |
| Enlace de la sesión clínica al «atendido» | ✅ campo en el contrato | `clinicalSessionId` en `POST /api/v1/appointments/:id/attend` |
| Adjuntos imagenológicos | ✅ almacén de archivos con `BlobStore` | `services/patients/src/files/` |
| Formato de la historia y plan del odontograma | ✅ documentos de referencia | `docs/formato_historia.md`, `docs/implementation_plan_odontogram_microservice.md` |
| Recetas en PDF A5 con Playwright | ⚠ pendiente de decidir Chromium embebido | plan §13, Fase 7 |

## 5. Hallazgos y qué se hace con cada uno

| # | Hallazgo | Gravedad | Acción |
| :-: | :--- | :--- | :--- |
| 1 | **1.305 trabajos muertos en la cola padre `domain-events`** (y en la de pruebas): nadie trabaja esa cola, así que se acumulaban en `created` y no se borraban nunca | Media (almacenamiento, no latencia) | ✅ **Arreglado**: el publicador solo entrega en colas de consumidor (`domain-events.<servicio>`), la prueba del outbox usa su propia cola y la borra al terminar, y se limpiaron los 1.305 muertos. Verificado: tras un humo completo, la cola padre recibe **0** trabajos nuevos |
| 2 | **~30 variables de configuración sin documentar** en `.env.example` | Baja (sorpresas al operar) | ✅ **Arreglado**: sección «Ajustes finos» con todas (hosts, pool, cookies, anti-flood, reintentos, cola, tope de archivo, rutas de claves) y su valor por defecto |
| 3 | **Temas declarados que nadie publica**: `notifications.message.sent`, `message.failed`, `patient_channel.linked`, `patients.file.uploaded`, `identity.user.*`, `identity.session.*` | Baja (deuda de contrato) | Documentados. `message.sent/failed` conviene publicarlos en la Fase 9 (reportes y KPIs) y `file.uploaded` en la Fase 6 (adjuntos de la historia) |
| 4 | **La vinculación de canal no queda auditada** (consecuencia del anterior) | Media-baja | Recomendado antes de la Fase 9: publicar `patient_channel.linked` con la forma genérica (`auditPayload`); la auditoría lo recogería sola |
| 5 | **El `secretario` no tiene acceso a clínica** | Decisión de producto | Confirmar antes de la sesión A (¿la secretaría imprime récipes o consentimientos?) |
| 6 | **Los scripts de auditoría vivían en `tmp/`** (sin versionar) | Baja | ✅ **Arreglado**: son `tools/audit-conexiones.mjs` con `npm run audit` (cuatro secciones y veredicto), documentados en la guía de comandos |

### Detalle del arreglo 1 (cola)

El publicador entregaba una copia del evento a **todas** las colas conocidas, incluida
la padre `domain-events`, que en este despliegue **no la trabaja nadie**: cada evento
dejaba un trabajo `created` que pg-boss nunca borra (su retención solo aplica a los
completados). Con ~1.300 eventos acumulados en un día de trabajo, la fuga era evidente.

- `packages/db/src/boss.ts`: se publica **solo** en `domain-events.<servicio>`; la
  padre queda como último recurso si no hay ninguna cola de consumidor declarada.
- `packages/db/src/outbox.integration.test.ts`: la prueba trabaja su propia cola
  (`consumerQueueName('prueba')`) y la **borra al terminar** (mientras exista, los
  servicios reales le mandan copias que nadie recoge entre corridas).
- Limpieza de lo acumulado: 1.305 trabajos borrados (solo los `created` de colas sin
  trabajador; no se tocó nada más).
- **Verificado en vivo**: después de una prueba de humo completa (que publica decenas
  de eventos), `domain-events` recibe **0** trabajos nuevos y el estado total es 0 en
  `created`.

## 6. Recetas para la Fase 6 (lo que debe copiar)

1. **Proyección por evento, no llamada cruzada**: si la clínica necesita cambiar un
   dato que vive en otro servicio (p. ej. marcar que el paciente tiene historia), el
   servicio dueño del dato **consume el evento** y lo proyecta (como hace `patients`
   con `appointment.scheduled`), con `processed_events` o clave de deduplicación para
   ser idempotente.
2. **Consumidor con cola propia**: `registerDomainEventHandler(boss, handler, { queue:
   consumerQueueName('clinical') })` y una prueba de integración por cada camino
   (aplica, no aplica, repetido).
3. **Auditoría gratis**: publicar cada transición con `auditPayload({...})` (forma
   genérica) es lo único necesario para que aparezca en `/auditoria` con actor,
   motivo y campos cambiados.
4. **Cliente interno**: copiar `screens/internal-client.ts` (secreto, timeout 5 s,
   degradar sin romper). Nunca llamar a otro servicio por el gateway.
5. **Migraciones**: `services/<svc>/migrations/0000_*.sql` + snapshot/journal, con
   `npm run db:generate:<svc>` cuando el cambio sea de esquema; los `CHECK` con
   literales, no con parámetros `$n` (tropiezo ya documentado), y verificar con
   `npm run db:verify-migrations -- --only clinical`.
6. **Prueba de humo propia** (`tools/smoke-clinical.mjs`): recorrer el camino por el
   gateway, dejar los datos limpios al final y comprobar el efecto en la auditoría.
7. **Textos**: ninguna cadena visible debe prometer algo de una fase futura; el aviso
   «Primera visita del paciente…» de la Fase 6 ya tiene su hueco en el plan.

## 7. Conclusión

Se puede empezar la Fase 6. El andamiaje (bases, permisos, eventos, prefijos,
auditoría, hooks hacia pantallas y agenda) está puesto y verificado, y las dos
conexiones que fallaban se cerraron con pruebas que las cubren. Lo que queda de §5 son
mantenimientos acotados, no bloqueos.
