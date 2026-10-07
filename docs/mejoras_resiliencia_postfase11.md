Fecha: 7 de octubre de 2026
# Plan de Mejoras Arquitectónicas, Operativas y de Resiliencia: OdontoCRM

Este documento detalla técnica y operativamente las cinco áreas de mejora identificadas para el ecosistema OdontoCRM tras la consolidación de la Fase 10 y la construcción de la Fase 11 (`billing`). El objetivo es maximizar la resiliencia en entornos locales con infraestructura inestable, facilitar auditorías técnicas y acelerar la viabilidad comercial del producto.

---

## 1. Observabilidad Unificada y Monitoreo de Eventos

### Diagnóstico Actual

El sistema orquesta 9 servicios independientes (10 al haberse incorporado `billing`), cada uno con su propio bucle de eventos, conexión a PostgreSQL y proceso en segundo plano gestionado por `systemd` o PM2. Actualmente, si un consumidor de `pg-boss` falla en procesar un evento de dominio tras agotar sus reintentos, el incidente solo es detectable revisando manualmente los registros del servicio o inspeccionando la tabla de trabajos fallidos de Postgres.

### Propuesta Técnica

```
                    ┌────────────────────────────────────────┐
                    │            API Gateway                 │
                    │   GET /api/v1/system/health/detailed   │
                    └───────────────────┬────────────────────┘
                                        │ Ping paralelo
     ┌──────────────────┬───────────────┴────┬──────────────────┐
     ▼                  ▼                    ▼                  ▼
[ Identity ]      [ Clinical ]         [ Billing ]       [ Event Bus ]
 (DB Check)        (DB Check)           (DB Check)      (pg-boss stats)
     │                  │                    │                  │
     └──────────────────┴───────────────┬────┴──────────────────┘
                                        │
                                        ▼ Fallo crítico / Reintentos agotados
                         ┌─────────────────────────────┐
                         │ Bot Telegram / Log Crítico  │
                         │ (Dead-Letter Alert Handler) │
                         └─────────────────────────────┘

```

#### A. Healthcheck Enriquecido con Agregación en Gateway

Ampliar el endpoint de salud del API Gateway (`apps/gateway/src/routes.ts`) para proveer un estado consolidado:

* **Inspección en Cascada:** El Gateway consulta concurrentemente a `/internal/health` de cada servicio activo.


* **Métricas Clave Expuestas:**
* Estado de la conexión al pool de base de datos (`connected`, `idle_connections`, `waiting_clients`).


* Retardo de réplica o tiempo de respuesta promedio por servicio.
* Número de eventos pendientes en la tabla `outbox` local de cada servicio.





#### B. Gestión de Dead-Letter Queue (DLQ) y Alertas Proactivas

Integrar en el consumidor central de `packages/db/src/boss.ts` un manejador de fallos terminales (`job.failed` con `retryCount >= maxRetries`):

* **Persistencia de Fallos:** Mover el evento no procesable a una tabla explícita `dead_letter_events` con el payload original, stack trace y timestamps.
* **Canal de Notificación Directa:** Conectar el despachador de alertas existente en `tools/lib/alertas.mjs` hacia el bot administrativo de Telegram para emitir un aviso inmediato cuando un evento del Outbox quede varado. Esto implicaría la creación de un bot nuevo e implicaría editar los scripts de instalación en producción en fedora / windows parea solicitar la activación de dicho bot (confirmar activación y solicitud de HTTP token).

Todas estas mejoras de healtcheck solo las puede ver el rol `admin`



---

## 2. Bus de Sincronización en Tiempo Real para la Interfaz (Extensión SSE)

### Diagnóstico Actual

Actualmente, las interfaces de secretaría (`/flujo`), consultorio (`/consultorio`) y pantallas de sala operan de manera desacoplada. Mientras que las pantallas de sala aprovechan Server-Sent Events (SSE) a través de `services/screens`, la actualización del flujo entre la recepción y el sillón dental depende de recargas manuales o de la revalidación reactiva al cerrar modales locales en TanStack Query.

### Propuesta Técnica

```
 [ Odontólogo en /consultorio ]             [ Secretaría en /flujo ]
               │                                       │
               │ 1. Cierra sesión clínica              │
               ▼                                       │
      [ services/clinical ]                            │
               │                                       │
               │ 2. clinical.session.closed            │
               ▼                                       │
      [ services/screens / SSE Hub ]                   │
               │                                       │
               │ 3. Broadcast SSE: "queue.updated"     │
               ├──────────────────────────────────────►│
               │                                       ▼
               │                          TanStack Query invalida caché:
               │                          ['day-queue', 'appointments']
               ▼                                       │
     Pantalla de espera actualiza                      ▼
         ticket de atención                   Fila pasa automáticamente
                                               a "Pendiente por Cobro"

```

#### A. Centralización del Hub SSE

Reutilizar el motor de streaming implementado en `services/screens/src/sala/broadcast.ts` para convertirlo en un bus liviano de notificación UI para clientes autenticados:

* **Canales Segmentados:**
* `channel:lobby`: Eventos de llamado para televisores/monitores públicos.


* `channel:staff`: Eventos de coordinación clínica y de caja (`appointment.called`, `session.closed`, `invoice.draft_ready`).





#### B. Invalidación Reactiva en TanStack Query (`apps/web`)

En `apps/web/src/providers/`, implementar un hook global `useRealtimeSync()` conectado al canal `staff`:

* Al recibir el evento SSE `session.closed`, se dispara automáticamente `queryClient.invalidateQueries({ queryKey: ['flow-queue'] })` y `queryClient.invalidateQueries({ queryKey: ['pending-invoices'] })`.


* **Resultado Operativo:** La secretaria ve aparecer el cobro en `/caja` de forma instantánea sin necesidad de pulsar F5 ni cerrar diálogos manualmente.



---

## 3. Estrategia de Despliegue Híbrida: Nativo vs. Docker Compose (Baja Prioridad por los momentos; pero tenerlo en cuenta para un aposible implementación futura.)

### Diagnóstico Actual

El proyecto cuenta con un despliegue nativo muy optimizado para hardware de bajos recursos mediante scripts en Fedora (`systemd`, Nginx, PostgreSQL local). Sin embargo, la fricción para levantar un entorno de demostración rápido o desplegar en un servidor de pruebas en la nube (VPS) es alta debido a las dependencias manuales del sistema operativo.

### Matriz de Decisión de Entornos

| Criterio | Despliegue Nativo (`systemd` / Windows Service) | Despliegue en Contenedores (`docker-compose.yml`) |
| --- | --- | --- |
| **Destino ideal** | Consultorios físicos en Venezuela (Hardware modesto: 4-8 GB RAM).

 | Demostraciones a clientes, pruebas en VPS en la nube, CI/CD.

 |
| **Consumo de memoria** | Mínimo (~80-120 MB por servicio Node.js; ~200 MB Postgres).

 | Medio-Alto (Sobrecarga de capas de Docker y virtualización en Windows). |
| **Puesta en marcha** | Requiere correr scripts de instalación y permisos de OS (`install.sh`/`.ps1`).

 | Inmediata: un solo comando `docker compose up -d`. |
| **Mantenimiento** | Dependiente de librerías del sistema y permisos de red locales.

 | Completamente aislado y reproducible en cualquier host. |

### Propuesta Técnica: `docker-compose.yml` para Demos y Nube

Crear un archivo en la raíz que agrupe:

1. **Contenedor PostgreSQL único:** Una sola instancia configurada para inicializar las bases de datos requeridas (`odonto_identity`, `odonto_clinical`, `odonto_billing`, etc.) mediante un script en `/docker-entrypoint-initdb.d/`.


2. **Imágenes Multi-Stage para Node.js:** Aprovechar la compilación de monorepo ya configurada en `tsconfig.base.json` para empaquetar servicios en imágenes reducidas basadas en `node:20-alpine`.


3. **Contenedor Nginx / Caddy:** Con certificados automáticos o puertos mapeados internamente, exponiendo únicamente el Gateway en el puerto 80/443.



---

## 4. Auditoría Criptográfica y Procedimientos de Recuperación de Desastres (DR)

### Diagnóstico Actual

Existen herramientas de respaldo (`backup/odontocrm-backup.sh` y `odontocrm-restore.sh`), pero no existe un mecanismo programático que compruebe periódicamente si los archivos `.dump` son íntegros y restaurables. Asimismo, los archivos clínicos (radiografías, recetas generadas) residen como archivos sin cifrar en el disco del servidor (`packages/storage`).

### Propuesta Técnica

#### A. Simulacro Automatizado de Restauración (*DR Drill Script*)

Implementar una herramienta en `tools/verify-backup.mjs` integrada en un timer semanal de `systemd`:

1. Toma el último archivo de respaldo generado por `odontocrm-backup.sh`.


2. Levanta una base de datos temporal con sufijo de prueba (`odonto_verify_tmp`).
3. Ejecuta el restore completo mediante `pg_restore` y valida que el código de salida sea 0.


4. Comprueba la integridad de las tablas maestras ejecutando conteos de control (`SELECT COUNT(*) FROM patients`, `SELECT COUNT(*) FROM invoices`).


5. Destruye la base temporal y registra el éxito en los logs de auditoría. Si falla, emite alerta de emergencia al administrador.



#### B. Cifrado en Reposo de Archivos Médicos y Documentos Fiscales

En `packages/storage/src/blob-store.ts`:

* Modificar el guardado de streams para aplicar cifrado envelope utilizando **AES-256-GCM** mediante el módulo nativo `crypto` de Node.js.
* La clave maestra de cifrado se deriva de una variable de entorno (`STORAGE_ENCRYPTION_KEY`) nunca versionada en el repositorio.


* **Ventaja:** Si el disco duro de la clínica es extraído o la máquina compartida sufre robo físico, los expedientes clínicos y recetas quedan inaccesibles sin la clave del servicio.



---

## 5. Consolidación del Expediente Clínico Digital (Dossier Médico Unificado)

### Diagnóstico Actual

La aplicación cuenta con componentes modulares maduros: evolución por sesiones (`PatientSessionsCard`), recetas archivadas con código QR (`PrescriptionCard`), odontograma histórico (`OdontogramChart`) y ficha demográfica (`PatientWorkspace`). Sin embargo, si un paciente es remitido a un especialista externo o solicita su historial, el odontólogo debe imprimir cada elemento por separado.

### Propuesta Técnica

```
                    GET /api/v1/patients/:id/dossier/pdf
                                     │
                                     ▼
                      [ services/clinical / DossierEngine ]
                                     │
           ┌─────────────────────────┼─────────────────────────┐
           ▼                         ▼                         ▼
   [ Patient Client ]       [ Odontogram Client ]      [ Session Service ]
   Datos filiatorios,        Estado actual SVG del      Historial cronológico,
   antecedentes y alertas    odontograma anatómico      evoluciones y recetas
           │                         │                         │
           └─────────────────────────┼─────────────────────────┘
                                     ▼
                    [ Motor Chromium (Playwright/PDF) ]
                       Renderiza documento foliado A4
                                     │
                                     ▼
                       PDF firmado con hash SHA-256

```

#### A. Endpoint de Exportación Consolidada

Crear en `services/clinical` la ruta interna y pública para generar el expediente completo en formato PDF (`@page { size: A4 }`):

1. **Filiación y Alertas:** Nombre, documento de identidad, edad, alergias y condiciones médicas de riesgo.


2. **Odontograma Diagnóstico:** Vectorial SVG en posición anatómica que refleje el estado dental consolidado al día de la exportación.


3. **Evolución Cronológica:** Tabla ordenada de todas las sesiones clínicas cerradas, tratamientos realizados y notas de evolución firmadas.


4. **Historial Farmacológico:** Listado de recetas emitidas con sus respectivos números de verificación y prescripciones.



#### B. Sello de Integridad y Trazabilidad

* Cada exportación del dossier incluye en el pie de página el identificador del profesional emisor, fecha y hora en huso horario `America/Caracas`, correlativo de emisión y código QR que apunta a la verificación criptográfica del documento (`/verify-record`).

## 6. Crear, si es posible, un archivo CSS maestro para la identidad de Marca.

- De modo que podamos colocar paleta de colores, fuentes título y cuerpo de la UI / título cuerpo de los Reportes: Odontograma, Historia médica, Facturas / título cuerpo de los récipes. Rutas para colocar SVG del logo para usarlo de múltipes formas; membrete, watermark en los imprimibles.
- De momento, coloquemos en la paleta de colores y las fuentes las que ya estamos usando. Yo estoy haciendo un SVG para que funcione de logo genérico paras las pruebas de momento.
---

## Plan de Ejecución Sugerido

1. **Inmediato:** Fases 1, 2, 4 (Mantenimiento) 5 y 6.


2. **Largo Plazo (Docker - Compose):** Contenedor `docker-compose.yml` (**Mejora 3**) para preparar el material de venta y demostración comercial.


3. **Mantenimiento y Seguridad:** Configurar la prueba automática de restauración (**Mejora 4.A**) en los entornos de producción.

Hay que teer especial atención en atender los instaladores fedora y windows para que no queden desactualizados luego de la implementación!