# Changelog

Todos los cambios relevantes de OdontoCRM. El formato sigue
[Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/) y el proyecto usa
fases: cada fase termina con sus commits atómicos y su etiqueta `fase-N`.

## [Sin publicar] — WhatsApp por Baileys

### Cambiado
- WhatsApp pasa a usar **Baileys** por defecto: socket saliente, vinculación por QR o código y sin
  túnel ni webhook. **Cloud API se conserva** como proveedor alternativo configurable.
- Los avisos prefieren **WhatsApp** sobre Telegram (D16).
- La espera entre envíos se sortea entre 2 y 4 s (configurable) y hay un tope diario de 150
  mensajes por defecto; si no hay conexión o se agota el tope, el aviso se difiere sin gastar
  intentos.

### Añadido
- Sesión Signal **cifrada** en `odonto_notifications` (`whatsapp_auth` y `whatsapp_session`) con
  `STORAGE_ENCRYPTION_KEY`.
- Vinculación desde **Configuración → Canales** (QR, código de emparejamiento, reconectar y cerrar),
  CLI `npm run whatsapp:*` y enlace de paciente por `wa.me`.
- Alertas al bot de administración cuando la sesión se cierra, se reemplaza o lleva demasiado
  tiempo caída; auditoría `whatsapp_session_paired/logged_out/lost`.
- Intenciones con argumento en canales sin comandos (`vincular ABC123`, `estado #000123`) y
  desvinculación por canal (`?channel=telegram|whatsapp`).

### Corregido
- **El alta por WhatsApp llegaba al último paso y fallaba**: el borde interno de pacientes tenía
  una lista de canales copiada a mano sin `whatsapp`, así que el «Confirmar» respondía 400 y el
  paciente solo veía «ahora mismo no puedo consultar el sistema». Ahora usa el catálogo compartido
  `CHANNELS` y el alta se guarda con su ticket.
- **El QR no se veía al guardar el interruptor**: notifications recarga los canales al instante
  cuando se pide la sesión de WhatsApp, en vez de esperar hasta dos minutos (caché + sondeo). El
  panel además guarda Baileys y abre el QR en un solo paso desde «Vincular».
- Si el guardado final falla por un servicio caído, el bot vuelve a mostrar el **resumen y los
  botones de confirmar** en vez de dejar al paciente a mitad de la conversación.
- El QR caducado lo dice y ofrece **generar otro**; antes la pantalla se quedaba «esperando» sin
  salida.
- El paso **«Sexo»** del alta acepta `M`, `F` u `O` escritos (también «masculino», «femenino» y
  «otro», sin importar mayúsculas ni tildes), además del número de la opción.
- El **resumen final** del alta acepta «confirmar» / «corregir» (y «sí» / «no») además de `1` / `2`;
  el paso de documento duplicado también entiende «sí» y «no» escritos.
- Un paciente **vinculado** que pide otra cita va directo al **paso 6 de 7 (motivo)**: sus datos ya
  están en la ficha. Si tenía una solicitud en espera —por ejemplo, después de cancelar su cita— se
  reutiliza el mismo ticket y solo se actualiza el motivo, sin duplicar la cola.
- **Cancelar una cita desde la agenda ya no deja al bot con la fecha vieja**: el resumen de la
  solicitud solo toma la cita vigente (no la cancelada o reprogramada) y, si el paciente pregunta
  por su estado, el asistente le dice que esa cita quedó cancelada y que sigue en la cola.
- **Desvincular un chat en Notificaciones ahora borra el vínculo y la conversación**: antes solo
  lo marcaba como bloqueado y el bot retomaba la ficha anterior; al volver a escribir empieza un
  alta nueva y puede registrarse como otro paciente.
- La solicitud creada desde WhatsApp ya se audita con su canal real, no como si fuera Telegram.

### Eliminado
- Para el flujo normal desaparecen el túnel y la ruta pública de WhatsApp. La ruta de webhook se
  conserva **solo** para Cloud API.

### Seguridad
- Una ruta pública menos cuando se usa Baileys; la sesión de WhatsApp se trata como credencial
  maestra y queda cifrada en reposo.

## [1.1.0] — 2026-10-19

La v1.1 añade la **sección de periodontogramas** sin tocar el odontograma de la v1: un examen
fechado con las 32 piezas permanentes y sus 6 sitios (192 mediciones), un pad clínico táctil para
tablet y ratón, comparación longitudinal entre exámenes, informe imprimible y auditoría. El módulo
vive en el servicio de odontograma (sin microservicios nuevos ni cambios de gateway) y reutiliza
sus permisos: `odontogram:write` para sondar y finalizar, `odontogram:read` para leer, comparar e
imprimir.

Se implementó el **núcleo completo del plan** (fases 1–4 del
[plan de la v1.1](docs/v1.1_periodontograma/plan_primigenio_implementación.md)) y se corrigieron
los riesgos clínicos y de datos de la revisión
([revisión crítica y decisiones](docs/v1.1_periodontograma/revision_critica_y_decisiones.md)):
las mediciones nunca se inventan (`null` = no sondado), el examen es un snapshot del odontograma,
el guardado es optimista por revisión, el cierre es inmutable y la clasificación AAP/EFP se
**sugiere** con evidencia explicable pero la firma el odontólogo. La fase 5 (dossier, reporting,
semillas y E2E transversales) queda declarada para la v1.2; la auditoría sí entra ya por el outbox.

| Pieza | Qué cambia |
| :--- | :--- |
| `packages/contracts/src/domain/periodontogram.ts` | Dominio completo: sitios y anatomía por cuadrante, esquemas Zod (32 piezas en orden canónico, furcas anatómicas, coherencia de ausentes/implantes), métricas (BOP %, placa %, PS/NIC medios, bolsas, retratamiento, implantes), sugerencia AAP/EFP con códigos de evidencia, comparación longitudinal, DTOs y entradas de la API |
| `packages/events/src/topics.ts` · `packages/contracts/src/domain/audit.ts` | Tópicos `odontogram.periodontogram.saved/finalized/printed` y acciones de auditoría `periodontogram_*` |
| `services/odontogram/src/db/schema.ts` · migración `0004` | Tabla `periodontogram_exams` (JSONB `teeth_data`, métricas, riesgo y diagnóstico), `revision`, `schema_version`, un solo borrador por paciente y checks de coherencia |
| `services/odontogram/src/odontogram/periodontogram-service.ts` · rutas | Crear desde el odontograma/clonar/en blanco, listar, leer, guardar con revisión (409), finalizar inmutable, descartar borrador, comparar, imprimir y resumen interno; eventos de auditoría dentro de la transacción |
| `apps/web/src/components/periodontogram/**` | Pad táctil (PS/MG, signo, BOP/placa/supuración, auto-avance, undo), SVG de las dos arcadas con zonas de toque, tabla numérica, KPIs en vivo, sugerencia de clasificación, lista de exámenes y modo comparación |
| `apps/web/src/components/tooth-art/**` · `odontogram/ToothBackdrop.tsx` · `OdontogramPanel.tsx` · `OdontogramPrintPage.tsx` | Los 64 dibujos del consultorio pasan a una carpeta compartida (`tooth-art/`, con su cargador) y se usan también en el odontograma como **corona de fondo** opcional: interruptor «Piezas modeladas» **apagado de fábrica**, preferencia recordada en el navegador y `?piezas=0\|1` para que el papel salga igual que la pantalla; las piezas temporales se quedan con el esquema |
| `apps/web/src/components/periodontogram/**` · `tooth-art/**` · `PeriodontogramArchSvg.tsx` · `PeriodontogramPanel.tsx` · `PeriodontogramPrintPage.tsx` | Piezas ilustradas de fondo (64 SVG compartidos con el odontograma: 16 piezas × 2 caras × 2 arcadas) calibradas a la escala de la rejilla con la caja vectorial de cada dibujo, capa memoizada para que sondar no la repinte, implante roscado, e interruptor «Piezas modeladas» con preferencia recordada en el navegador y `?siluetas=0\|1` para que el papel salga igual que la pantalla |
| `apps/web/src/components/periodontogram/PeriodontogramDocument.tsx` · `PeriodontogramPrintPage` | Informe imprimible con membrete en carta, saltos de página y hoja de evolución: arcadas, 192 cifras con etiqueta anatómica, NIC, índices, clasificación y comparación |
| `apps/web/src/components/clinical/PatientWorkspace.tsx` · `App.tsx` · `ConsultorioPage.tsx` | Pestaña «Periodontograma», ruta de impresión y `?vista=periodontograma`; el resto del expediente queda igual |
| `tools/smoke-periodontogram.mjs` · `tools/check-responsive.mjs` | Humo contra el gateway y comprobación de anchos/targets táctiles del módulo |
| `docs/adr/0071-periodontograma-integrado.md` · `docs/PERIODONTOGRAMA_BASES_CLINICAS.md` | La decisión de arquitectura y las bases clínicas implementadas (convención de signos, NIC, índices, furcas, límites de la clasificación) |
| `package.json` · `packages/*/package.json` · `services/*/package.json` · `apps/*/package.json` | Versión `1.1.0` en la raíz y los dieciocho workspaces |
| `apps/gateway/src/config.ts` · `services/*/src/config.ts` · `.env.example` · `infra/fedora/{install.sh,instalar/aprovisionar.mjs,INSTALL.md}` | `SERVICE_VERSION` por defecto `1.1.0` y ejemplos y aprovisionamiento alineados |

## [1.0.0] — 2026-10-18

Primera versión estable del programa: la batería de pruebas manuales E2E se pasó completa y los
defectos que encontró quedaron corregidos. La versión sube de `0.1.0` a `1.0.0` en la raíz y en
los dieciocho workspaces, y `SERVICE_VERSION` —la cifra que publican `/health` y `/ready`— toma
`1.0.0` por defecto en todos los servicios y en el aprovisionamiento de Fedora.

| Pieza | Qué cambia |
| :--- | :--- |
| `package.json` · `packages/*/package.json` · `services/*/package.json` · `apps/*/package.json` | Versión `1.0.0` (raíz y workspaces) |
| `apps/gateway/src/config.ts` · `services/*/src/config.ts` | `SERVICE_VERSION` por defecto `1.0.0` |
| `.env.example` · `infra/fedora/{install.sh,instalar/aprovisionar.mjs,INSTALL.md}` | Ejemplos y aprovisionamiento alineados con `1.0.0` |

## [Programación] — la rejilla de franjas se refresca sola en las demás pantallas · 2026-10-18

Guardar los turnos de un día actualizaba la jornada de la pestaña que lo hacía, pero no la de
nadie más: la rejilla de franjas y el contador de cupo de otra pestaña —o de la recepción en otra
máquina— seguían mostrando el horario viejo hasta pulsar F5. El servidor ya publicaba
`scheduling.capacity.changed` y la auditoría lo registraba; lo que faltaba era despertar al canal
del personal con ese tema (`STAFF_TOPICS` no lo incluía), así que el aviso nunca salía por SSE.

Ahora el cambio de horario entra en los avisos del personal, y la SPA lo traduce además a las
**plantillas** que lee el configurador (no se metió en la lista común para no refetchearlas en
cada paso de cita, que es lo frecuente). El diálogo espera las dos invalidaciones antes de cerrarse,
así la rejilla que queda detrás ya está repintada.

| Pieza | Qué cambia |
| :--- | :--- |
| `services/screens/src/sala/staff-signal.ts` | `scheduling.capacity.changed` en `STAFF_TOPICS` |
| `apps/web/src/lib/realtime.ts` | Excepciones por tema: el cambio de horario invalida también `['plantillas']` |
| `apps/web/src/components/scheduling/ScheduleConfigDialog.tsx` | Espera las invalidaciones antes de avisar (`onSaved`) |
| `services/screens/src/sala/staff-signal.test.ts` · `apps/web/src/lib/realtime.test.ts` | Un guardado de varios días suena una sola vez; las plantillas solo se refrescan con el horario |

## [Caja] — los libros fiscales se exportan desde el mostrador · 2026-10-18

El libro de ventas, el estado de ganancias y pérdidas por diferencial cambiario y el reporte de
percepción del IGTF ya existían en el servidor, pero solo se obtenían pidiendo el CSV por HTTP: el
contador los pedía y había que bajar el archivo a mano, sin ver antes si las cifras cuadraban.

Ahora `/caja` tiene una tercera vista, **Libros fiscales**, junto a *Pendientes* e *Historial*:
propone el mes en curso (con atajos a este mes y al anterior), muestra en pantalla el resumen que
se declara —ganancias, pérdidas, reversiones y neto; base del IGTF y arqueo separado por caja— y
descarga cada libro en **CSV** (Excel en español) o en **PDF**. El PDF se compone con el **membrete
del consultorio** y la marca del panel, en carta horizontal y con folio, y **no se archiva ni
consume numeración**: es un informe que se pide, no un documento fiscal por operación. El período
lo resuelve una sola función (`rangoDelMes`, en contratos) para el servidor y para la pantalla, así
que el mes que se ve es el mes que se descarga; antes el fin de mes estaba duplicado en cada lado.

| Pieza | Qué cambia |
| :--- | :--- |
| `packages/contracts/src/domain/billing.ts` | `rangoDelMes`/`rangoDelMesAnterior` (calendario, sin `Date` de instante), `bookFileName` con extensión y `BooksSummary` |
| `services/billing/src/billing/book-service.ts` | El rango por defecto sale del contrato: se borra el `ultimoDiaDelMes` privado |
| `services/billing/src/documents/book-pdf.ts` | Nuevo: los tres libros en carta horizontal con el membrete compartido, cabecera de tabla repetida y resumen; formato por columna, sin adivinar |
| `services/billing/src/pdf-renderer.ts` | `render(html, { landscape, folios })`: la factura sigue en vertical y sin folio |
| `services/billing/src/routes/book-routes.ts` | `books/{sales,exchange-diff,igtf}.pdf`, con `billing:read` y el nombre de archivo del contrato |
| `apps/web/src/components/caja/LibrosFiscalesPanel.tsx` | Nuevo: período, atajos, resumen y las seis descargas; fechas con `formatDateOnly` |
| `apps/web/src/pages/CajaPage.tsx` | Tercera vista de la caja; el selector de vista sube encima de la rejilla |
| `apps/web/src/lib/{endpoints,i18n}.ts` | `billingApi.books` (CSV, PDF y resumen) y las claves `caja.libros.*` |
| `services/billing/src/{books.integration.test.ts,documents/book-pdf.test.ts}` · `tools/{smoke-billing,check-responsive}.mjs` | El PDF se prueba por el HTML que recibe Chromium; el humo baja las seis descargas y la auditoría de responsive mide la vista |

## [Agenda] — el cupo se mide en franjas ocupadas · 2026-10-18

El botón **«Editar el cupo»** pedía un número que no tenía relación con la rejilla: se podía
escribir 20 sobre una jornada de 14 franjas, y una consulta de dos horas sobre franjas de 30
minutos descontaba **una** franja aunque cruzara cuatro. La agenda prometía huecos que no
existían. Además, con el sillón como recurso (ADR 0059) guardar ese cupo fallaba: el diálogo no
enviaba `chairId`.

Ahora el botón se llama **Configurar la jornada** y edita el **horario de atención**: los turnos
de cada día de la semana y la duración de la franja, todo en 12 h con `a. m.`/`p. m.`. El cupo
deja de escribirse: **son las franjas del horario**, y una cita gasta tantas franjas como cruza
(la de dos horas sobre franjas de 30 minutos gasta 4). Un día sin turnos queda **cerrado** (cupo
0) y asignar ahí exige sobrecupo de admin con motivo. La tarde de fábrica pasa a las 14:00–17:00
(L-V, franjas de 30 min: 14 franjas al día), y el diálogo ofrece el horario de fábrica con un
clic si un día se quedó sin turnos.

Se **elimina `day_capacities`** y `PUT /api/v1/agenda/capacity`: el cupo explícito no se puede
conservar con sentido cuando el cupo son las franjas. Entra `PUT /api/v1/agenda/schedule`
(`scheduling:write`), que reconcilia los turnos por hora de inicio —conserva pausas e `id`,
inserta los nuevos y desactiva los que sobran— sin borrar ninguna cita. Reporting conserva su
cupo histórico en `dim_day_capacity`; el cupo nuevo no viaja en eventos.

| Pieza | Qué cambia |
| :--- | :--- |
| `packages/contracts/src/domain/scheduling.ts` | `usedCapacity` (una cita larga gasta varias franjas), `weekScheduleInputSchema`, `shiftsToTemplates`, `WEEKDAY_SHORT_NAMES`; fuera `setCapacitySchema`, `DEFAULT_DAY_CAPACITY` y el cupo explícito de `DayCapacity`; tarde de fábrica 14:00–17:00 |
| `services/scheduling/src/agenda/capacity-service.ts` | El cupo sale de `expandTemplateSlots` y lo ocupado de `usedCapacity`; `assertCapacityAvailable` recibe la cita propuesta; nuevo `replaceWeekSchedule` transaccional y auditado |
| `services/scheduling/src/agenda/day-view-service.ts` | Cupo agregado por franjas; origen `plantilla` \| `sin_turnos` |
| `services/scheduling/src/appointments/appointment-service.ts` | El sobrecupo se decide con el tamaño real de la cita; al reprogramar no se cuenta dos veces la original |
| `services/scheduling/src/routes/agenda-routes.ts` | `PUT /api/v1/agenda/schedule`; se retira `PUT /api/v1/agenda/capacity` |
| `services/scheduling/src/db/schema.ts` · `migrations/0007_sin_cupo_explicito.sql` | Se elimina `day_capacities`; la migración `0000` siembra la tarde a las 14:00 |
| `apps/web/src/components/scheduling/ScheduleConfigDialog.tsx` | Nuevo: día (con atajos L–V y todos), turnos, duración de la franja, resumen de franjas y avisos |
| `apps/web/src/components/scheduling/Hora12hField.tsx` | Nuevo: hora, minutos y `a. m.`/`p. m.` en tres selectores (24 h solo en los datos) |
| `apps/web/src/lib/schedule-config.ts` | Turnos del día, validación, franjas resultantes y conversión 12 h ↔ 24 h (con pruebas) |
| `apps/web/src/lib/scheduling.ts` | El parcheo del día ocupa **todas** las franjas que cruza una cita y recalcula el cupo por sillón (con pruebas) |
| `apps/web/src/components/scheduling/DayCapacityCard.tsx` | «Configurar la jornada»; contador y textos en franjas; aviso de día cerrado |
| `apps/web/src/components/scheduling/{CapacityDialog,TemplatesDialog}.tsx` | Se eliminan (los sustituye el configurador de horario) |
| `tools/{smoke-agenda,smoke-clinical-session,smoke-reporting,e2e-flujo}.mjs` · `tools/{seed-test,seed-verify}.mjs` | Sin cupo explícito; los humos envían `chairId`, leen las franjas por consultorio y prueban el sobrecupo en un domingo cerrado |

## [Corrida QA · 2.ª pasada] — el historial vacío, la cita que respalda la sesión y el monto de la otra moneda · 2026-10-18

Re-probando `CFG-04` (ya pasa: el interruptor del IGTF guarda y el cobro lo refleja) aparecieron tres
cosas que no eran del arreglo anterior y que sí se notan en el mostrador.

La primera es la más visible: **el historial de la caja salía vacío**. `billingInvoiceListQuerySchema`
declaraba `search` con `optionalText`, que devuelve `null` cuando el parámetro no viene —en un
cuerpo eso significa «vacía el campo», pero en una URL es «sin filtro»—, y el servicio compara con
`undefined` para decidir si lo aplica. Resultado: sin escribir nada en el buscador, la consulta
llevaba `patientName ilike '%null%'` y no encontraba ninguna factura. Escribir un nombre la hacía
aparecer, que es la clase de síntoma que se achaca a la caché. Ahora hay `optionalQueryText`, que
normaliza ausente y vacío a `undefined`: «no hay filtro» tiene una sola forma.

La segunda se vio en la pestaña **Sesión clínica**: el desplegable «Cita que respalda la sesión» solo
ofrecía «Sin cita». La lista se pedía con `date=<hoy>`, así que si la cita estaba programada para
otro día —la sesión se abre desde la ficha del paciente, o el paciente llega antes de su cita— no
había nada que ofrecer. Ahora se piden las citas del paciente desde hoy y hasta dos meses, se
filtran a las que pueden respaldar una sesión (pendientes y las del circuito del día; nunca las
cerradas) y se ordenan con el paciente del sillón primero. La etiqueta lleva la fecha cuando no es
de hoy, y solo se marca sola la cita cuando no hay ambigüedad.

La tercera explica los diferenciales que quedaban: el campo del monto se rellenaba **solo si estaba
vacío**, así que al cambiar el medio de pago el importe seguía siendo el de la otra moneda (34,49
dólares cobrados como 34,49 bolívares). El campo pasa a ser una propuesta: se recalcula al cambiar
el medio, la moneda, la tasa de la Fecha Valor o el saldo, y se respeta en cuanto el cajero escribe.
Además, la fila «Diferencial» ya no se pinta cuando vale cero, que era lo que hacía dudar de un cobro
correcto. Verificado en vivo: un cobro del saldo exacto en bolívares a la misma tasa deja
`exchangeDiffVesCentimos = 0`.

| Pieza | Qué cambia |
| :--- | :--- |
| `packages/contracts/src/common/optional.ts` | Nuevo `optionalQueryText`: en una URL, ausente o vacío es «sin filtro» (`undefined`) |
| `packages/contracts/src/domain/billing.ts` | El `search` del historial usa `optionalQueryText`; deja de generar `ilike '%null%'` |
| `apps/web/src/components/clinical/session-appointments.ts` | Nuevo: qué citas respaldan una sesión, en qué orden y cuál se marca sola |
| `apps/web/src/components/clinical/SessionPanel.tsx` | Pide las citas desde hoy a dos meses, filtra por estado y etiqueta con la fecha |
| `apps/web/src/components/caja/CobroDialog.tsx` | El monto se propone y se recalcula al cambiar de moneda; el diferencial en cero no se pinta |
| `apps/web/src/lib/caja.test.ts` | Ida y vuelta `formatBs`/`formatUsd` → `parseUsdToCents` |
| `packages/contracts/src/domain/billing.test.ts` | El filtro sin texto es «sin filtro», no la cadena «null» |
| `apps/web/src/components/clinical/session-appointments.test.ts` | Nuevo: estados que respaldan, orden y elección por defecto |
| `docs/plan_de_pruebas_manuales_e2e_odontocrm.md` | `CFG-04` a PASS y los hallazgos `CAJ-12`, `CAJ-13` y del adelanto de `CLI-03` |

## [Corrida QA] — el consultorio se entera de la historia, el IGTF se guarda y el monto autocompletado se puede leer · 2026-10-18

Primera pasada completa de los bloques `PRE`, `E2E`, `ID` y `CFG` del
[plan de pruebas manuales](docs/plan_de_pruebas_manuales_e2e_odontocrm.md) sobre una instalación
Fedora. Salieron tres cosas, y las tres tenían causa concreta.

La primera se vio en `E2E-04`: con la pantalla del consultorio abierta en otra pestaña, se llenó la
historia clínica con una alergia crítica y se firmó, y la pantalla siguió diciendo que no había datos
críticos hasta pulsar F5. Son dos capas: `services/screens` solo recalculaba la sala con eventos de
**agenda** —los `clinical.record.*` se ignoraban, así que no había trama SSE— y, además, el respaldo
por HTTP de 20 s no llevaba `refetchIntervalInBackground`, y React Query lo pausa en pestañas
ocultas, que es como vive una TV de consultorio. Ahora un lote clínico del paciente que está **en
pantalla** reparte el estado completo del consultorio (las alertas se leen en vivo, así que la alergia
recién escrita viaja en esa misma trama) y el respaldo late aunque la pestaña esté de fondo. La
adenda publica el perfil clínico para que también cuente.

La segunda fue `CFG-04`: activar *Sujeto Pasivo Especial* en `/configuracion` devolvía 500 y no
guardaba nada. El log de billing lo dijo sin rodeos —`ZodError: Invalid UUID` en `aggregateId`,
lanzado por `toOutboxInsert` dentro de la transacción—: `billing_settings` es una fila única con `id`
entero y el sobre del evento (y la auditoría) exigen UUID, así que la transacción revertía el cambio
entero y, de paso, el cambio fiscal nunca habría llegado a `/auditoria`. El identificador ahora sale
de `stableUuid`, el UUID v5 determinista que ya usaba la agenda para el cupo del día; se movió a
`packages/kernel` para que haya una sola implementación. El `PATCH` del oficio también se arregló:
`optionalText` transformaba el vacío a `null` pero su salida no era opcional, así que un cliente que
no mandaba el oficio lo borraba.

La tercera, `E2E-06`, parecía coma flotante y no lo era: los cobros en bolívares a la misma tasa
dejaban un diferencial de céntimos porque el monto se había tecleado a mano, y se tecleaba a mano
porque `parseUsdToCents` **rechazaba** el texto que la propia pantalla autocompleta (`formatBs`
escribe en `es-VE`: «6.000,00»). El diferencial de céntimos era la absorción de redondeo que ya
contempla el ADR 0069. El parser acepta ahora el separador de miles en las dos convenciones y sigue
rechazando lo que no es un importe.

| Pieza | Qué cambia |
| :--- | :--- |
| `packages/kernel/src/stable-uuid.ts` | Nuevo: `stableUuid(key)` (UUID v5 determinista) con su prueba; única implementación para los agregados sin id propio |
| `services/scheduling/src/shared/ids.ts` | Reexporta `stableUuid` del kernel; `dayCapacityId` no cambia |
| `services/billing/src/billing/settings-service.ts` | El evento y la auditoría de la configuración usan un UUID estable (`billing_settings:1`) en vez del `id` entero |
| `packages/contracts/src/domain/billing.ts` | `updateBillingSettingsSchema.speReference` opcional de verdad: ausente ya no borra el oficio |
| `services/billing/src/settings.integration.test.ts` | Nuevo: el `PATCH` persiste, publica un sobre y una auditoría válidos y es parcial |
| `services/screens/src/sala/clinical-refresh.ts` | Nuevo: republica el consultorio cuando la historia del paciente en pantalla cambia |
| `services/screens/src/consumer.ts` | Temas clínicos del consultorio y el paciente del evento (`payload.profile.patientId`) |
| `services/screens/src/sala/estado-service.ts` | `hasPatientOnConsultorioScreen`: quién está llamado o en consulta, sin haber salido |
| `services/screens/src/index.ts` | Engancha el refresco clínico al lote de eventos |
| `services/clinical/src/clinical/record-service.ts` | La adenda publica el perfil clínico (sus alertas cuentan para la pantalla) |
| `services/screens/src/screens.integration.test.ts` | La historia del paciente en el sillón republica; la de otro paciente o la de quien ya salió, no |
| `apps/web/src/components/screens/useKioskState.ts` | `refetchIntervalInBackground`: el respaldo no se pausa con la pestaña oculta |
| `apps/web/src/lib/caja.ts` | `parseUsdToCents` acepta el separador de miles (`1.234,56`, `1,234.56`, `6.000`) |
| `docs/plan_de_pruebas_manuales_e2e_odontocrm.md` | Registro de la corrida: resultados por bloque, los tres hallazgos y cómo re-probarlos |

## [Respaldo] — «Completado sin errores» sin volcar nada, y el simulacro se salta sin PG_ADMIN_URL · 2026-10-17

Revisando los registros de la instalación de Windows aparecieron dos cosas que no se podían
dejar así. La primera: una ejecución de `odontocrm respaldar` con **PostgreSQL caído** acabó
en «respaldo completado sin errores» **sin volcar NINGUNA base**. `Test-BaseExiste` confundía
«no pude consultar el catálogo» con «la base no existe»: las diez se «saltaron» con aviso,
nadie contó nada y el resultado fue un directorio con las copias de OTRA ejecución. De
paso, esa misma ejecución **borró el `storage.zip` bueno del intento anterior** antes de
intentar comprimir un almacén vacío: `Compress-Archive` no deja el archivo y no lanza, y el
guion daba la copia por hecha por el simple hecho de no haber fallado.

Ahora la consulta del catálogo devuelve tres estados (existe / no existe / **no se pudo
consultar**) y lo tercero es fallo del volcado; comprimir se comprueba **por efecto** (el
zip tiene que existir) y un origen sin archivos «avisa y sigue», como ya hacía el guion de
Fedora, que recibió el mismo arreglo de su lado (`base_existe` con código 2 y la guardia de
cero volcados). Y hay guardia final: **ni un volcado = el respaldo no sirve** (exit 2),
cortando antes de la retención para que una ejecución inútil no pode los respaldos buenos.

La segunda: el **simulacro semanal de restauración** (`verify-backup`) exige `PG_ADMIN_URL`
para crear sus bases temporales, y esa credencial por política no vive en el disco
([SEGURIDAD_SECRETOS.md](docs/SEGURIDAD_SECRETOS.md)): la tarea de los domingos fallaba
siempre y `40-verificar` contaba «el último respaldo NO se pudo restaurar» —sin haber
probado nada— en cada `odontocrm arrancar`. Decisión: **sin `PG_ADMIN_URL` el simulacro se
salta con aviso («restauración NO COMPROBADA») y sale en verde**, con las sumas y el almacén
sí comprobados, y la verificación del instalador lo cuenta como aviso y no como fallo. Quien
quiera el simulacro completo pasa `PG_ADMIN_URL` por entorno en una sesión suelta.

| Pieza | Qué cambia |
| :--- | :--- |
| `infra/windows/backup/odontocrm-backup.ps1` | `Test-BaseExiste` distingue «no se pudo consultar» (fallo) de «no existe» (se salta); `Comprimir-Carpeta` comprueba por efecto que el zip quedó escrito y avisa-sigue con origen vacío; guardia de **cero volcados** → exit 2 antes de la retención |
| `infra/fedora/backup/odontocrm-backup.sh` | El espejo: `base_existe` devuelve 2 si la consulta falla, cuenta los volcados y aplica la misma guardia (paridad) |
| `tools/verify-backup.mjs` | Sin `PG_ADMIN_URL`: aviso «restauración NO COMPROBADA» y exit 0 (antes: error y exit 1); el aviso del almacén menciona también el almacén vacío |
| `infra/windows/instalar/40-verificar.ps1` | El paso 8/9 omite el simulacro con aviso si no hay `PG_ADMIN_URL` (en entorno o en los `.env`): deja de contar un problema fantasma en cada arrancar |

> **Sin migración.** Son los guiones de respaldo y su verificación. Verificado en la
> instalación de Windows: con el motor parado el respaldo ahora **falla con exit 2** y no
> toca la retención; en normal vuelca las diez bases, avisa del almacén vacío y sale en 0;
> y `verify-backup` deja las sumas comprobadas y el salto explicado.

## [Instalador] — El comando `odontocrm` no mostraba la salida y `parar` decía «0 servicios» · 2026-10-17

Revisión del comando `odontocrm` sobre una instalación de Windows de verdad, con la pila en
marcha. Cuatro defectos, tres de ellos en el camino de todos los días. `odontocrm estado` y
`odontocrm alertas` **no mostraban nada**: envolvían la llamada en `exit (Invocar-Node …)`,
y PowerShell captura el flujo de éxito de la función —el tablero entero— dentro de la
expresión de `exit` y lo descarta al convertirlo a entero, quedándose además con el código
**0 siempre**. Lo peor no era la vista: `alertas` promete «sale con 1 si hay alguno» y no lo
cumplía **nunca**, con la pila caída o sin ella. `parar` decía «**0** servicio(s)
detenido(s)» con todo parado (el recuento miraba una salida redirigida a `$null`, que
siempre es falsa) y **no comprobaba** que los servicios se hubieran parado de verdad: una
orden de `pm2` rechazada habría pasado igual por «detenido». Y cada ejecución imprimía el
aviso **DEP0190** de Node («los argumentos no se escapan, solo se concatenan») porque
`estado.mjs` lanzaba los comandos con `shell: true` y lista de argumentos.

El recuento de `parar` va ahora por el código de salida de `pm2`, y después se verifica **por
efecto** —la regla de la casa— que ningún puerto del sistema siga escuchando, nombrando los
que queden. Verificado en la instalación: PM2 queda con los diez procesos en `stopped`, ningún
puerto escucha, `alertas` con la pila parada lista los diez servicios y sale con **1**, y
`arrancar`/`reiniciar` recuperan todo.

| Pieza | Qué cambia |
| :--- | :--- |
| `infra/windows/odontocrm.ps1` | `Invocar-Node` devuelve el código por `$script:CodigoDeSalida` y `estado`/`alertas` se invocan a nivel de instrucción: la salida fluye a la consola y el código 0/1 se respeta; `parar` cuenta por el código de `pm2` y verifica que ningún puerto quede escuchando |
| `tools/estado.mjs` | `intentarComando` lanza `pm2` como línea completa (es un `.cmd` y necesita shell) y el resto sin shell: se va el aviso DEP0190 de cada ejecución |
| `infra/windows/instalar/40-verificar.ps1` | La pista «míralo…» del paso 8/9 vuelve a traer la ruta del respaldo (las comillas `\"` cortaban la cadena: en PowerShell el escape es la comilla invertida) |

> **Sin migración.** Es el comando de consola y sus guiones. **Queda por decidir**: el
> simulacro semanal de restauración (`verify-backup`) exige `PG_ADMIN_URL`, que por política
> ([SEGURIDAD_SECRETOS.md](docs/SEGURIDAD_SECRETOS.md)) no vive en el disco —va al gestor de
> contraseñas—, así que la tarea de los domingos no puede crear las bases temporales y falla,
> y `40-verificar` cuenta un problema falso en cada `odontocrm arrancar`.

## [Secretos] — El escáner marcaba la plantilla del instalador como secreto · 2026-10-16

`npm run check-secrets -- --all` salía con **1 hallazgo** en un árbol limpio, y era falso:
`infra/windows/instalar/comun.ps1` compone la URL del administrador de PostgreSQL con una
plantilla (`postgres://${Usuario}:$([Uri]::EscapeDataString($clave))@…`), y el patrón de
«cadena de conexión con contraseña real» toleraba ya los marcadores de ejemplo
(`TU_PASSWORD`, `CAMBIAR`…) y la interpolación con llaves (`${…}`), pero **no** la
subexpresión de PowerShell (`$(…)`): leía el código como si fuera una contraseña. Con el
escáner en modo *staging* no salía —ese archivo no se toca a diario—, pero la auditoría
completa que documenta la política de secretos quedaba en rojo, que es justo lo que no puede
pasar: una puerta de calidad que grita en falso se acaba ignorando.

Ahora se tolera cualquier **interpolación de variable** detrás de los dos puntos (`${…}`,
`$(…)`, `$VAR`), que es código y no un valor, y el escáner sigue igual de estricto con lo
demás. Los patrones se sacan a `tools/lib/secretos.mjs` con su prueba, para poder fijarlos
**en los dos sentidos** —lo que debe detectar y lo que debe tolerar— sin git ni pila: era la
única pieza del repositorio con reglas delicadas y sin prueba, y el error de hoy es
exactamente el que la prueba habría cazado.

| Pieza | Qué cambia |
| :--- | :--- |
| `tools/lib/secretos.mjs` | Nuevo: los patrones, la lista de rutas prohibidas y `hallazgosDeLinea(linea)`, con el porqué de cada tolerancia |
| `tools/check-secrets.mjs` | Importa los patrones (deja de tenerlos copiados) y usa `hallazgosDeLinea`; el recorrido del árbol no cambia |
| `tools/lib/secretos.test.mjs` | Nuevo (13 pruebas): tolera la plantilla de PowerShell, `${…}`/`$VAR`, los marcadores de ejemplo y la conexión por socket; y **detecta** una contraseña de verdad, un token de Telegram, una clave PEM, una de AWS, un token de GitHub y una asignación en texto plano. Los secretos de mentira se arman por trozos, como en `settings.integration.test.ts`, para que el escáner no marque su propia prueba |
| `docs/SEGURIDAD_SECRETOS.md` | §3 describe las dos caras de la prueba y la tolerancia de interpolaciones |

> **Sin migración.** Es la herramienta de consola y su prueba. Tras actualizar,
> `npm run check-secrets -- --all` sale limpio (1035 archivos); si alguien tenía el hallazgo
> anotado como conocido, ya no está.

## [Docs] — La documentación alcanza las fases 11 y 12, y el plan de pruebas cubre el diferencial cambiario · 2026-10-16

Barrido de la documentación para ponerla al día tras la **Fase 11** (facturación y pagos) y la
**Fase 12** (diferencial cambiario por Fecha Valor e IGTF configurable, [ADR 0069](docs/adr/0069-diferencial-cambiario-escuela-a-e-igtf-configurable.md)):
varias partes seguían describiendo la caja como «en curso — sin dinero todavía», contaban **52 ADRs**
y hablaban de **8 servicios**. Se corrigieron las afirmaciones de **estado actual** (lo histórico de
cada fase se conserva tal como se escribió) y se añadió al README la sección que faltaba de la caja.
El **plan de pruebas manuales E2E** —escrito antes de la Fase 12— estrena los casos del **diferencial
cambiario**, el **IGTF configurable**, la **Fecha Valor**, la **absorción de redondeo** y los **libros
contables**, y suma un caso del régimen tributario del panel.

| Pieza | Qué cambia |
| :--- | :--- |
| `README.md` | Estado a **Fases 10, 11 y 12**; `(69 ADRs)`; `billing` pasa a ✅ con la Fase 12; **sección nueva «Caja y facturación (Fases 11–12)»** (endpoints, permisos, Escuela A); tabla de scripts con `billing`, `e2e:config` y `check:responsive`; arreglo del índice de scripts |
| `docs/PLAN_MAESTRO_FASES.md` | Cabecera de estado con la Fase 12; §13 pasa a **0–12** con las subsecciones de las fases 11 y 12; §17 gana sus filas de evidencia y «Próximo paso» se reescribe como **cierre del plan** |
| `docs/COMANDOS.md` · `docs/COMANDOS_PRODUCCION.md` · `docs/SEGURIDAD_SECRETOS.md` | «8/o/ocho servicios» → **9** (con `billing`); `db:generate` y las listas de `dev:*`/`start:*` incluyen `billing` y `reporting`; filas nuevas de `e2e:config`, `e2e:clinica` y `check:responsive`; `smoke:billing` refleja el **CP-01** y los libros |
| `docs/OPERACION_CLINICA.md` | **Sección 9 «La caja (cobrar y facturar)»** para el personal: tasa del día, Fecha Valor, diferencial, IGTF con destino de caja y libros |
| `docs/feat_billing.md` | Toques mínimos: «ocho servicios» → nueve; los **datos reales del consultorio** ya no son pendiente del código (ADR 0056/0058); papel del récipe/reporte sin «A5/A4» |
| `docs/plan_de_pruebas_manuales_e2e_odontocrm.md` | `E2E-06` con Fecha Valor/diferencial/IGTF; `CAJ-01/02/04/05` al día; **nuevos `CAJ-06`…`CAJ-11`**; **`CFG-04`** (régimen tributario); sign-off `CFG` 3→4 y `CAJ` 5→11 |

> **Sin migración.** Es documentación. Los cambios de papel de los imprimibles (carta en vez de A4/A5),
> la caja y el diferencial vienen de sus propias fases y ADR; aquí solo se alineó el texto.

## [Instalador] — La instalación moría con «'tsc' no se reconoce»: NODE_ENV de más en la consola · 2026-10-15

Desinstalación limpia y, al volver a instalar, el paso 2/10 moría tras el `npm ci`:
«'tsc' no se reconoce como un comando interno o externo». El `node_modules` llegaba SIN las
devDependencies —`typescript`, `vitest`, `eslint`— y solo con las de producción: la consola
traía `NODE_ENV=production`, que npm interpreta como «sin dev»… y **borra** las que ya estén
(probado: `npm ci` con esa variable quita 210 paquetes del árbol). La variable la dejaba el
propio `odontocrm`: `Invocar-Node` la ponía para sus herramientas y en el `finally` solo
limpiaba `ODONTOCRM_ENV_DIR`; ejecutado como `.ps1` **en la misma sesión** (sin pasar por el
`.cmd`), `NODE_ENV=production` se quedaba en la consola y todo `npm ci` posterior de esa ventana
quedaba cojo. Ahora `Invocar-Node` **restaura** las variables que encontró, y toda instalación
de dependencias + compilación de los guiones corre con `Con-EntornoNpmLimpio` (entorno de npm
limpio durante el build; la consola como estaba después). Con red de seguridad: si `npm ci`
deja fuera `tsc`, el paso lo dice con su causa.

| Pieza | Qué cambia |
| :--- | :--- |
| `instalar/comun.ps1` | `Con-EntornoNpmLimpio`: ejecuta un bloque SIN `NODE_ENV`/`NPM_CONFIG_OMIT`/`NPM_CONFIG_PRODUCTION` y restaura el entorno de la consola al salir |
| `instalar/30-desplegar.ps1` | El paso 2/10 (`npm ci` + build) pasa por `Con-EntornoNpmLimpio`; y si `npm ci` deja `node_modules` sin `tsc`, se muere diciendo la causa en vez del «no se reconoce» |
| `infra/windows/odontocrm.ps1` | `Invocar-Node` restaura `NODE_ENV`/`ODONTOCRM_ENV_DIR` en vez de dejarlos en la consola (la fuga); `compilar` y `recompilar` compilan con `Con-EntornoNpmLimpio` |

> **Sin migración.** Es instalador y CLI. Quien tenga una instalación a medias por esto: repite
> `30-desplegar.ps1` (idempotente); si `node_modules` quedó sin devDependencies, el propio paso
> 2/10 las vuelve a poner.

## [Instalador] — El respaldo diario no arrancaba: el rol moría con la «ó» y las bases llegaban con comillas · 2026-10-15

En una instalación limpia, el paso 10/10 terminaba con «PostgreSQL rechazó la creación del
rol» y el respaldo diario se quedaba **sin rol**. El SQL de `crear-rol-respaldo.ps1` llevaba
comentarios con acentos y PowerShell 5.1 entrega los argumentos de los comandos nativos en la
codificación ANSI de la máquina: PostgreSQL respondía «secuencia de bytes no válida para
codificación "UTF8": 0xf3» —la `ó` de «conexión»—. Y cuando el respaldo por fin corría, moría
con «Caracteres no válidos en la ruta de acceso»: `backup.env` escribe
`DATABASES="a b c"` **entre comillas** y el lector partía por espacios sin quitarlas, así que
cada base llegaba con su comilla pegada (`"odonto_identity`, `odonto_events"`) y la ruta del
volcado no era una ruta. Ahora el SQL va por **archivo UTF-8** (`psql -f`, los comentarios
pueden seguir en español) y el parseo de `DATABASES` quita las comillas envolventes. Y la
**segunda pasada del mismo día** moría en la verificación: `SHA256SUMS` cubría todo lo que había
en la carpeta del día —incluido el `manifest.txt` de la ejecución anterior— y el manifiesto se
reescribía después, con lo que su suma quedaba vieja («la suma de manifest.txt NO coincide»,
exit 3 con los volcados bien). El manifiesto queda ahora fuera de las sumas, como en
`tools/lib/admin-informes.mjs`.

| Pieza | Qué cambia |
| :--- | :--- |
| `backup/crear-rol-respaldo.ps1` | El SQL se escribe en un temporal UTF-8 y se pasa con `psql -f`: por `-c`, un acento bastaba para que PostgreSQL rechazara la consulta entera (y el rol no se creaba) |
| `backup/odontocrm-backup.ps1` | El parseo de `DATABASES` quita las comillas envolventes del valor (y de cada nombre): con `DATABASES="a b c"` los volcados morían con «Caracteres no válidos en la ruta de acceso»; y `manifest.txt` queda fuera de `SHA256SUMS` (con él dentro, la segunda pasada del día fallaba la verificación con el manifiesto viejo) |

> **Sin migración.** Es la cadena de respaldos. En una máquina donde el rol de respaldo no
> llegó a crearse: `backup\crear-rol-respaldo.ps1` (pide la contraseña de `postgres`); y
> `odontocrm respaldar` sirve para comprobar la cadena entera.

## [Instalador] — La desinstalación no borraba las bases: los pacientes sobrevivían · 2026-10-15

`desinstalar.ps1 --si` terminaba diciendo «bases y roles retirados»… y las bases seguían ahí,
con los pacientes de instalaciones anteriores (da igual que hubieran entrado por el servidor o
por `npm run dev`: las dos pilas comparten las mismas bases `odonto_*`). El paso 5/7 las
borraba **todas dentro de un bloque `DO $$…$$`**, que corre como función, y PostgreSQL responde
«DROP DATABASE no puede ser ejecutado desde una función»… con un solo aviso genérico al final
que no decía qué había pasado. Ahora se borra **base a base, una sentencia `psql` por objeto**
(como hace `desinstalar.sh` de Fedora), los roles van después de sus bases —el rol solo se
puede borrar cuando ya no es dueño de nada—, cada fallo se enseña con su motivo, y se cumple la
promesa que ya hacía el paso 1: **si el volcado de una base falló, esa base no se borra** (y si
no se pudo volcar ninguna, no se borra ninguna).

| Pieza | Qué cambia |
| :--- | :--- |
| `instalar/desinstalar.ps1` | Paso 5/7 como el de Fedora: `DROP DATABASE IF EXISTS … WITH (FORCE)` por base y `DROP ROLE IF EXISTS` por rol, cada uno con su resultado a la vista; las bases cuyo `pg_dump` falló quedan marcadas y NO se borran (tampoco si faltaba `pg_dump`/`.pgpass` y no se volcó nada) |
| `infra/windows/INSTALL.md` | §11 Desinstalar: el guardián del volcado, y el aviso de que las bases `odonto_*` son las mismas del stack de desarrollo |

> **Sin migración.** Es el desinstalador. Quien ya desinstaló y le quedaron bases vivas: vuelve
> a pasar `desinstalar.ps1 --si` (el paso 5 es idempotente) o bórralas a mano:
> `DROP DATABASE IF EXISTS "odonto_x" WITH (FORCE);`

## [Instalador] — La LAN no llegaba y todo salía en verde: la red en «Público» · 2026-10-15

Desde los aparatos de la consulta `192.168.9.119` no cargaba, y la verificación acababa de
decir «Todo correcto». Las reglas del firewall **estaban** (80 y 443, perfil privado) y Caddy
escuchaba bien; el candado era otro: Windows clasificó la red de la máquina como **Pública**
(«Red del monte 5G», lo normal en cualquier red nueva) y las reglas —a propósito— solo abren el
perfil **privado**, así que el 80/443 quedaban cerrados CON las reglas puestas. Ni el
instalador, ni `40-verificar.ps1`, ni `odontocrm red` —que promete «se puede entrar desde otro
equipo»— miraban el perfil de la red activa: por eso el verde. Ahora `30-desplegar.ps1` pasa la
red activa a perfil privado (diciéndolo), `40-verificar.ps1` lo señala como **fallo** con el
comando para arreglarlo, y `odontocrm red` lo comprueba y lo repara en su `--arreglar`.

| Pieza | Qué cambia |
| :--- | :--- |
| `instalar/30-desplegar.ps1` | `Asegurar-RedPrivada`: si la red activa está en perfil público, se pone en privado (las reglas solo cubren ese perfil) y se dice; si Windows no deja (red sin identificar), error con el paso a mano |
| `instalar/40-verificar.ps1` | 5/7 comprueba ahora el perfil de la red ACTIVA: en «Público» es un fallo —con el `Set-NetConnectionProfile` que lo arregla— aunque las dos reglas estén presentes |
| `infra/windows/odontocrm.ps1` | `red` gana el chequeo del perfil (1 de sus 4 comprobaciones) y su `--arreglar` lo pasa a privado; de paso, el SAN del certificado se lee por OID (2.5.29.17) —con el `FriendlyName` localizado decía «NO incluye la IP» con el certificado bien, y `--arreglar` reemitía sin motivo— |

> **Sin migración.** Es instalador y operación. En una máquina ya instalada con la LAN
> bloqueada: `Set-NetConnectionProfile -NetworkCategory Private` (o `odontocrm red --arreglar`).

## [Instalador] — La «contraseña temporal» de una reinstalación no abría nada · 2026-10-15

Al re-ejecutar `instalar.ps1` sobre una instalación ya existente —todo en verde—, el paso 6/10
generaba e imprimía una contraseña temporal **nueva**… que no servía para entrar: el seed
**omite los usuarios que ya existen** (sin `--reset`) y no había tocado la del `admin`. El
operador se quedaba apuntada una clave que no abría nada, mientras la original —la de la
primera siembra— se pisaba en `contrasena-inicial.txt`. Ahora el mensaje y el archivo dicen que
la temporal solo vale si la cuenta **se acaba de crear**, y llevan la receta de regeneración
(`seed.js --reset --usuarios=admin`, RUNBOOK §5).

| Pieza | Qué cambia |
| :--- | :--- |
| `instalar/30-desplegar.ps1` | La contraseña temporal se imprime y se guarda **con su condición**: solo vale si la cuenta se acaba de crear, porque el seed no cambia la de los usuarios que ya existen. El archivo incluye la receta para regenerarla |
| `infra/windows/INSTALL.md` | Fila nueva en la tabla de problemas: «La contraseña temporal del instalador no entra» |

> **Sin migración.** Solo mensajes e instalador. Si una clave ya quedó perdida, se regenera con
> `$env:SEED_PASSWORD_ADMIN='<clave nueva>'` y
> `odontocrm con-entorno identity -- node services/identity/dist/seed.js --reset --usuarios=admin`.

## [Instalador] — La verificación falseaba diez procesos ausentes y un `pm2` a destiempo colgaba la instalación · 2026-10-15

Revisión del instalador de Windows probándolo entero en la PC de pruebas. La instalación ya
terminaba, pero la verificación de cierre dejaba «10 problema(s)»… y **ninguno era del
servidor**: los diez procesos estaban en marcha y respondiendo su `/health`. El origen era el
parseo de `pm2 jlist`: su JSON trae el `env` **completo** de cada proceso, con `username` y
`USERNAME` conviviendo (claves que solo difieren en mayúsculas), y el `ConvertFrom-Json` de
PowerShell 5.1 las da por duplicadas y **lanza**… dentro de un `catch { }` que se lo tragaba.
La lista se quedaba vacía y cada proceso salía «no está en PM2». Los otros dos síntomas eran
del mismo pelo: `Get-Codigo` usaba `Invoke-WebRequest`, que sigue las redirecciones (http→https
salía «200» donde hay un 301) y **lanza** en los 4xx (el SSE sin token devuelve 401 y se veía
como «0», como si la URL estuviera rota). En los tres casos el servidor estaba bien —`curl` veía
301, 401 y 200—; el que mentía era el verificador.

Y en el camino cayó el cuelgue de verdad. El «message bus» de PM2 tarda un segundo en publicar
sus `rpc.sock`/`pub.sock` **después** de que el servicio pasa a `Running`, y el `pm2 jlist` del
instalador llegaba antes: no encontraba demonio y **se montaba uno propio** (del Administrador),
que se quedaba con los «pipes» globales. El `jlist` esperó una respuesta que nunca llegó **para
siempre**, y con él la instalación entera. Es la guerra de «pipes» que ya documentamos por la
puerta de atrás: cualquier PM2 de otra cuenta (una consola `pm2 list` de prueba; un demonio
zombie que `pm2 kill` dejó moribundo pero vivo) deja al servicio arrancando con
`connect EPERM`. Ahora los guiones **retiran los demonios sueltos** —el PM2 del servicio corre
en «no daemon mode» dentro del servicio, así que todo `Daemon.js` de la máquina es un intruso—,
esperan al bus antes de tocar el CLI, y **todas** las llamadas a `pm2` llevan techo de tiempo.

| Pieza | Qué cambia |
| :--- | :--- |
| `tools/pm2-resumen.mjs` | Nuevo (con su test): `pm2 jlist` → `[{"nombre","estado"}]`. Node se traga el JSON que PS 5.1 no puede parsear y a los guiones solo les llega lo que necesitan |
| `instalar/40-verificar.ps1` | La lista de procesos pasa por `tools\pm2-resumen.mjs` y, si no se puede leer, se dice **por qué** (antes: diez «no está en PM2» falsos); `Get-Codigo` con `HttpWebRequest`, sin redirecciones y con los 4xx/5xx como números: vuelven a verse el 301 de http y el 401 del SSE |
| `instalar/comun.ps1` | `Invocar-Pm2` (toda llamada a `pm2` con techo de tiempo; 124 = «no respondió»), `Clear-DemoniosSueltos` (retira `Daemon.js` ajenos por PID) y `Esperar-MessageBusPm2`; `Clear-Pm2Global` pasa por ellos |
| `servicios/instalar-pm2.ps1` | Los «pipes» se dejan libres **antes** del `npm run setup` (un demonio de antes tumbaba el arranque del servicio con `EPERM`); tras el arranque se espera al bus y recién entonces se habla con `pm2 jlist`, con techo; si el CLI llegó a montar demonio, se retira |
| `instalar/30-desplegar.ps1` | `pm2 delete all`/`start`/`save` por `Invocar-Pm2`: el instalador ya no se puede quedar colgado en el paso 7/10 |

> **Sin migración.** Todo es instalador y verificación. En una máquina ya instalada basta con
> volver a pasar `40-verificar.ps1` (y `servicios\instalar-pm2.ps1` si el servicio de PM2 está
> caído o quedaron demonios sueltos).

## [Instalador] — Reinstalar PM2 sobre restos no creaba ningún servicio · 2026-10-15

El segundo ensayo de instalación limpio volvió a morir con `Could not find "pm2.exe" service after 10 attempts`,
y sin desinstalar de por medio. La causa: **node-windows decide que el servicio «ya está instalado»
mirando solo los archivos** `daemon\pm2.exe` y `daemon\pm2.xml`, no el servicio de Windows. El
`desinstalar.ps1` del 10/14 borró el servicio pero dejó `C:\ProgramData\pm2`; al reinstalar,
node-windows respondió «Already installed.», **no creó ningún servicio** (lo confirma el registro de
Windows: ni servicio ni clave), y el paso que cambia la cuenta a `LocalService` se quedó buscando
`pm2.exe` en WMI diez segundos. La teoría de la víspera —servicio «marcado para eliminación»— no era:
el mensaje de «zombie» que añadimos no llegó a salir.

| Pieza | Qué cambia |
| :--- | :--- |
| `servicios/instalar-pm2.ps1` | Antes del `setup`, si hay **archivos de servicio sin servicio detrás**, se retiran (y se dice por qué): node-windows instala de verdad. Si quedan archivos y no se pueden borrar, el error apunta al «marcado para eliminación» (reiniciar Windows). Y las rutas del log que decían `$OdontoEtc\pm2\service\service.log` —que no existe— apuntan a `$PM2_HOME\service\service.log` |
| `instalar/desinstalar.ps1` | La desinstalación retira ahora `C:\ProgramData\pm2` (el wrapper de node-windows) y las variables de máquina `PM2_HOME`/`PM2_INSTALL_DIRECTORY`/`PM2_SERVICE_DIRECTORY`: sin esto, **cada desinstalar dejaba la siguiente instalación rota** |

> **Sin migración.** Es el instalador. En una máquina ya tocada basta con volver a pasar
> `servicios\instalar-pm2.ps1`: el paso nuevo detecta los restos y los retira solo.

## [Instalador] — La instalación limpia terminaba; el bot volvía a escuchar · 2026-10-14

Revisión de la salida del instalador del 2026-10-14 y de la lógica del bot de administración, con
seis defectos reales. El de fondo: **`npm run setup` fallaba** (`Could not find "pm2.exe" service
after 10 attempts` —el servicio anterior quedaba «marcado para eliminación» tras desinstalar sin
reiniciar—) y la pieza 7 seguía de todas formas con `pm2 delete all` y `pm2 start`, que arrancaban
un **demonio del Administrador** con los «pipes» globales de PM2: los procesos quedaban vivos sin
servicio detrás, y el servicio ya no podía arrancar nunca. Con eso en pie, el resto de la salida
era la cascada: la verificación **moría** en el 7/7 y no comprobaba nada de lo que venía detrás.

| Pieza | Qué cambia |
| :--- | :--- |
| `servicios/instalar-pm2.ps1` | Reintenta `npm run setup` una vez, y si el servicio quedó zombie lo dice («reinicia Windows y repite») en vez del críptico `Could not find…` |
| `30-desplegar.ps1` | **Comprueba el servicio ANTES de tocar PM2**: sin servicio no arranca nada (sería sin supervisión); certificado: se reemite con mkcert si el existente no cubre el nombre o la IP de ahora (SAN por OID 2.5.29.17) |
| `40-verificar.ps1` | `$info.servicios.name` → `.nombre` (con `StrictMode` lanzaba y mataba el paso 7/7); el SAN se lee por OID, no por `FriendlyName` (localizado en Windows en español: todo salía «NO cubierto») |
| `caddy/Caddyfile` | `/ca.crt` y `/ca.der` reescriben a `odontocrm-ca.*`: `file_server` buscaba `ca.crt` y devolvía 404 («no pude descargar la CA») |
| `backup/crear-rol-respaldo.ps1` | La contraseña ya no usa `Substring(0, 32)` sobre una base64 sin símbolos (se quedaba corta y lanzaba): ahora 32 hexadecimales de 16 bytes aleatorios |
| `10-preparar.ps1` | `listen_addresses = 'localhost'` en `postgresql.conf` (con copia previa y reinicio, que es lo único que lo aplica): el 5432 quedaba publicado en toda la LAN |
| `desinstalar.ps1` | Se retiran **las cuatro** tareas: faltaba «OdontoCRM · verificar respaldo», que seguía disparándose tras desinstalar |
| `infra/fedora/odontocrm` + `windows/odontocrm.ps1` | `parar` **silencia las alertas** (desactiva la tarea/el timer, para que aguante un reinicio) y `arrancar`/`reiniciar` las reactivan: un apagado a propósito dejaba un «N problema(s)» cada 5 minutos en el bot |
| `tools/admin-bot.mjs` | El bot ya **no sale con 0** al arrancar sin credenciales (la base de identity tarda; el panel aún no tiene el token): queda esperando y reintenta cada 60 s. Antes quedaba «muerto en verde» para PM2 y systemd y `/estado` no respondía **nunca**, aunque el botón «probar bot» del panel funcionase (ese manda desde el servicio; el bot es el que escucha). `revisarCredenciales` ya no lanza `TypeError` sobre `bot.firma` cuando `bot` es `null` |

> **Sin migración.** Todo es instalador, herramientas de consola y el bot. Para que entre en un
> servidor ya instalado basta con volver a pasar las piezas 1 y 3 (o `odontocrm parar`/`arrancar`
> para el arreglo de las alertas).

## [Fase 12] — Diferencial cambiario por Fecha Valor e IGTF configurable (ADR 0069) · 2026-10-14

El cobro en bolívares se descompone en tres montos —lo **recibido**, lo **imputado** a la tasa de
emisión y el **diferencial cambiario**— y la tasa del cobro es la de su **Fecha Valor** (la del
comprobante bancario: un pago móvil del **domingo** se valora con la tasa del **viernes**). Con eso se
cierran tres huecos de golpe: el recibo explica por qué los Bs. que entraron no son los impresos, el
residuo de un Pago Móvil redondeado al bolívar entero se **absorbe** (±0,05 USD) y salda el 100 % de la
deuda en vez de dejar un saldo zombi, y el IGTF del Sujeto Pasivo Especial se percibe con **destino
declarado** (Caja Divisas o Banco/Caja Bs., con la referencia del Pago Móvil). Las Notas de Crédito
distinguen la anulación **administrativa** (sin devolución: conserva el diferencial ya realizado) del
**reembolso real** (lo reversa), y la nota fiscal sale igual en los dos casos: siempre a la tasa
original de la factura. El diferencial no se factura con Nota de Débito (Escuela A): se rinde con el
**Estado de Ganancias y Pérdidas cambiarias** y el **Reporte de Percepción IGTF** con su arqueo.

| Pieza | Qué cambia |
| :--- | :--- |
| `packages/contracts` | `bsPaymentBreakdown`/`divisasPaymentBreakdown` (tolerancia ±5¢, `absorbsRounding`), `igtfDecision` con alícuota de configuración, `effectiveDate` e `igtf*` en el cobro, acumuladores en el detalle de la factura, `cancellationType` en la anulación, libros cambiario y de IGTF |
| `services/billing` | Migración `0005` (con backfill de los cobros previos a diferencial cero), Fecha Valor y descomposición en `payment-service`, doble escenario en `credit-note-service`, recibo con desglose y bloque fiscal, `settings-service` + `GET/PATCH /settings` (solo el `admin` toca), resúmenes de libros |
| `apps/web` | `CobroDialog`: Fecha Valor, autocompletar del saldo, tarjeta de previsualización contable, badge de redondeo y selector de destino del IGTF; `DocumentoDetalle`: deuda a doble tasa y columnas por cobro; `AnularDialog`: tipo de anulación; `TributarioSection` en el panel |
| `packages/testing` + `tools` | Fábricas con los campos nuevos, seed/verificación al día y `smoke-billing` reproduce el caso **CP-01** exacto (US$ 60 a 1.000 → 50.000 Bs. → tasa 1.020 → 10.200 Bs. = +200,00 Bs.) |

> **Migración.** `npm run db:migrate` (billing): la `0005` añade las columnas y backfillea los cobros
> previos (Fecha Valor = día del registro en Caracas; histórico = lo recibido; diferencial = 0). Para
> generar migraciones nuevas hay que reconstruir contratos antes: `npm run build -w @odontocrm/contracts`.

## [Instalador] — El proxy arranca: el binario no lo podía ejecutar el servicio · 2026-10-14

El servicio `caddy` quedaba en `Stopped`, así que desde la LAN no se entraba: la última parte del
paso 9/10 decía `la SPA devolvió 0 · la API devolvió 0 · la CA respondió 0`… y aun así el guion
informaba «✔ servicio caddy reiniciado». Dos defectos, uno tapando al otro.

El de fondo es un permiso: **Caddy corre como `LocalService`** y `caddy.exe` no era legible para esa
cuenta. Los binarios se descargan en `%TEMP%` y se mueven a `C:\ProgramData\OdontoCRM\bin`, y al
moverlos **conservan las ACL de `%TEMP%`** (del usuario Administrador, sin el servicio y con la
herencia bloqueada): la carpeta de destino sí daba permiso a `LocalService`, pero al archivo no le
llegaba. Windows lo cuenta en el registro de eventos con `El servicio caddy no pudo iniciarse
debido al siguiente error: %%5`, que es «acceso denegado» sin decir de qué archivo.

El otro es de información: `Restart-Service` fallaba y el guion seguía igual hasta el final.

| Pieza | Qué cambia |
| :--- | :--- |
| `comun.ps1` | `Permitir-EjecucionAlServicio`: da `RX` —leer **y ejecutar**— al binario, por SID. Un `R` a secas no basta: Windows exige `FILE_EXECUTE` para crear el proceso, y eso también fue parte del mismo `%%5` |
| `10-preparar.ps1` | Al colocar cada binario se le da ese permiso, y **también cuando ya estaba** (idempotente): así una instalación anterior se repara al volver a pasar por la pieza 1, sin volver a descargar nada |
| `caddy/instalar.ps1` | Comprueba el **efecto** en vez de dar por hecho el arranque: si el servicio no queda en marcha, dice que suele ser un permiso, cómo verlo (`Get-EventLog System -Source "Service Control Manager"`) y se detiene, en vez de terminar con «reiniciado» y el proxy caído |

> **Verificado**: el ayudante se probó sobre un archivo con las ACL reales del caso (mover desde
> `%TEMP%`): sin permiso → `ReadAndExecute`, idempotente, y no rompe si el archivo no existe. La
> causa se confirmó contra la máquina, con las dos ACL y el `%%5` del registro de eventos.

> **Sin migración.** Es el instalador. Para que entre en un servidor ya instalado hay que volver a
> pasar por la pieza 1 (el instalador completo): es la que revisa los permisos de los binarios.

## [Instalador] — Los tokens de los canales se comprueban y quedan guardados · 2026-10-14

En el instalador de Windows se pedían los tokens de Telegram y de WhatsApp y **no se hacía nada con
ellos**: ni se comprobaban contra la API —como sí hace el de Fedora, que responde el nombre del bot
y detecta el chat del administrador— ni existía la garantía de que quedaran escritos. Con
`--solo=desplegar` se perdían **siempre**, porque quien los escribe es la pieza 2 (el
aprovisionador) y esa pieza no se ejecuta en ese modo: se pedían, se usaban para nada y se
esfumaban al terminar, sin un solo aviso.

Ahora, en la puesta en marcha:

- El token se **comprueba contra Telegram** (`getMe`): si vale, se enseña `@nombre` y ese nombre se
  guarda como `TELEGRAM_BOT_USERNAME`, que es el que arma el enlace `t.me/<usuario>` del récipe.
  Un token más corto de 20 caracteres no se guarda (no es un token de BotFather) y uno que Telegram
  no confirme se avisa y se guarda igual, para poder corregirlo después.
- El chat del administrador **se detecta**, no se pregunta: se pide escribirle «/start» al bot y se
  lee su `chat.id` de las actualizaciones (tres intentos). Antes se pedía un número que nadie sabe
  de memoria y, sin él, el bot de administración no puede avisar de nada.
- Y las credenciales de los canales **quedan guardadas en `notifications.env` siempre**: si la
  corrida no va a ejecutar la pieza 2, se la llama en modo «solo archivos» (escribe los `.env`, sin
  tocar bases ni claves de firma) antes de desplegar.

| Pieza | Qué cambia |
| :--- | :--- |
| `instalar.ps1` | Comprueba los dos tokens (`getMe`), completa el usuario del bot, detecta el chat del administrador y guarda los canales por su cuenta cuando la pieza 2 no va a correr. Además `--solo=desplegar` vuelve a pedir la contraseña de PostgreSQL: su paso 10/10 crea el rol de respaldo y sin ella se quedaba sin crear (con aviso) |
| `comun.ps1` | `Get-BotTelegram` (`getMe`, con TLS 1.2 explícito: PowerShell 5.1 no siempre lo negocia y el fallo parece «no hay internet») y `Select-ChatDeActualizaciones` + `Get-ChatTelegram` |
| `20-aprovisionar.ps1` | Acepta `--solo-archivos` (escribe los `.env` y nada más) y en ese modo no pide la contraseña de PostgreSQL |
| `aprovisionar.mjs` | En modo «solo archivos» ya no dice «los 9 servicios tienen credencial que conecta», que era falso: ahí no se comprueba ninguna conexión |

> **Verificado** con el aprovisionador real sobre un directorio de pruebas: los tokens entran en
> `notifications.env` en la primera pasada y **se conservan** en una segunda sin ellos (la regla de
> `escribirEnv`). El extractor del chat se probó con cargas reales de Telegram, incluida la que
> trae `my_chat_member` en vez de `message` —que con `Set-StrictMode` lanzaba una excepción que el
> `catch` se comía, dejando el chat sin detectar en silencio—.

> **Sin migración.** Es el instalador: no toca el código desplegado, ni las bases, ni la SPA.

## [Instalador] — Los servicios ya arrancan de verdad: PM2 no usaba `fork` · 2026-10-14

La instalación llegaba al paso 7/10, PM2 daba los once procesos por «online» y **ninguno abría su
puerto**: la pieza se quedaba en «esperando a que escuchen…» y el servidor terminaba la instalación
sin un solo servicio en marcha. En el registro del demonio no había ni un error y los
`out.log`/`error.log` de cada aplicación estaban **vacíos**, así que el síntoma parecía un cuelgue sin
causa.

La causa está en cómo carga PM2 las aplicaciones: el ecosistema de producción declaraba
`instances: 1`, y en PM2 declarar `instances` —aunque sea `1`— cambia el modo a **cluster**. El
contenedor de cluster de PM2 5.2.2 carga la app con `import(process.env.pm_exec_path)`, es decir con
una **ruta** y no con una URL, y en Windows el cargador ESM de Node lee `C:\…` como el esquema `c:` y
lo rechaza con `ERR_UNSUPPORTED_ESM_URL_SCHEME`. El contenedor de `fork` sí lo hace bien
(`url.pathToFileURL`). En Fedora el mismo modo cluster funciona **por casualidad**: allí la ruta
absoluta es `/opt/…` y el cargador la acepta. El ecosistema de desarrollo de Windows nunca falló
porque no declara `instances`, así que PM2 usaba fork por defecto.

| Pieza | Qué cambia |
| :--- | :--- |
| `ecosystem.produccion.config.cjs` | `exec_mode: 'fork'` explícito y **sin** `instances`, en las once apps (el bot de administración incluido: además, `stop_exit_codes` solo se respeta en fork) |
| `ecosystem.config.cjs` (desarrollo) | Aviso de por qué no se añade `instances` nunca: es la línea que enciende el modo cluster |

> **Sin migración.** Es configuración de supervisión: entra con la pieza 3 (`30-desplegar.ps1`) o con
> `odontocrm actualizar`. No toca el código desplegado, ni las bases, ni la SPA.

## [Instalador] — PM2: el del servidor es el de la máquina, y el servicio arranca · 2026-10-14

La instalación llegaba al paso 7/10, `pm2-installer` terminaba con «close this window and start a new
terminal session» y el servicio de PM2 quedaba en **`Stopped`**: el servidor «estaba instalado» y no
corría ningún proceso. Eran dos defectos distintos que se tapaban entre sí.

El primero es que `pm2-installer` deja `PM2_HOME` y el prefijo global de npm en el entorno de
**máquina**, y las piezas 3 y 4 corren en la **misma sesión** que lanzó el instalador: ahí `pm2` se
resuelve por el PATH del usuario (que puede tener su propio `pm2` de desarrollo en `%APPDATA%\npm`) y
con el home por defecto (`%USERPROFILE%\.pm2`). Es decir, los procesos se habrían arrancado en un PM2
que el servicio no ve —y el instalador habría dicho que todo fue bien—. Ahora se trae el entorno de
máquina a la sesión y se usa siempre el `pm2` de la máquina, sin reiniciar ninguna consola.

El segundo es el que de verdad tumbaba el servicio, y está en PM2: en Windows nombra sus «pipes» en
**fijo y global** (`\\.\pipe\rpc.sock` y `\\.\pipe\pub.sock`; hay un `@todo` en `pm2/paths.js`), así
que en una máquina solo puede haber **un** demonio de PM2. `npm run setup` instala `pm2-logrotate`
con `pm2 install` **como administrador**, y ese demonio del administrador se queda dueño de los
pipes: el servicio, que corre como `LocalService`, recibe `connect EPERM //./pipe/pub.sock`, se cae y
`winsw` lo deja en `Stopped` tras agotar sus reintentos. Ahora se le quitan los pipes a ese demonio
justo antes de arrancar el servicio, y la comprobación es **por efecto**: `pm2 jlist` tiene que
responder, que es lo que demuestra que el demonio en marcha es el del servicio.

| Pieza | Qué cambia |
| :--- | :--- |
| `comun.ps1` | `Importar-EntornoDeMaquina` (PATH y variables de máquina, sin reiniciar la consola), `Get-Pm2Cmd` (el `pm2` de la máquina, no el del usuario), `Test-Pm2PipesLibres`, `Clear-Pm2Global` y `Confirmar-ServicioPm2` |
| `instalar-pm2.ps1` | Quita el demonio que dejó el `setup` antes de arrancar el servicio, y comprueba que el servicio sigue vivo y que su demonio responde |
| `30-desplegar.ps1` | Usa ese `pm2` y dice en pantalla cuál es y con qué `PM2_HOME` |
| `40-verificar.ps1` · `odontocrm.ps1` · `desinstalar.ps1` | Confirman el servicio antes de hablar con PM2: un `pm2` a secas **arranca un demonio de la cuenta del que llama** si no encuentra ninguno, y entonces el que ya no puede arrancar es el servicio |

> **Consecuencia: un solo PM2 por máquina.** Como los pipes son globales, el demonio que los tiene
> atiende a todos los `pm2`, así que no pueden convivir el servicio del consultorio y un PM2 de
> desarrollo en la misma máquina: en un sentido la pila de desarrollo acaba dentro del servicio, y
> en el otro el servicio no arranca. Queda dicho en `INSTALL.md` y, para el caso de la misma PC que
> desarrolla y hace de servidor, en [`DESARROLLO.md`](infra/windows/DESARROLLO.md) §3.

## [Instalador] — El instalador ya pasa de la pieza 3/4 en una máquina limpia · 2026-10-14

La pieza 3 se detenía en su primer paso con «`C:\OdontoCRM` no está vacío y no es un clon de git», y
la carpeta estaba «llena» precisamente porque **la había llenado el propio instalador**: en Windows
los datos, los logs y los respaldos viven dentro de la carpeta del código (`C:\OdontoCRM\data`,
`…\logs`, `…\backups`) y la pieza 1 los crea antes de que la pieza 3 clone. En Fedora ese choque no
existe —código en `/opt/odontocrm`, datos en `/var/lib/odontocrm`—, así que el espejo de Windows
heredó una comprobación que allí era inofensiva y aquí hacía **imposible terminar la instalación**.

Al destrabar la comprobación apareció el segundo problema, que era peor: la copia del código hacía
`Remove-Item -Recurse -Force` sobre la carpeta de destino para poner el clon en su lugar, así que
habría borrado el almacén (radiografías y PDFs), los logs y los respaldos de una instalación en
marcha, además de los permisos que la pieza 1 deja en las carpetas de datos. Ahora el clon se copia
**encima** con `robocopy /E` —que no borra lo que no está en el origen— y las carpetas del
instalador se conservan; y si en la carpeta hay algo que **no** puso el instalador, se dice cuál y no
se toca nada.

| Pieza | Qué cambia |
| :--- | :--- |
| `comun.ps1` | `Get-CarpetasPropiasDelCodigo`: los nombres de primer nivel que el instalador ya creó dentro del código (derivados de las rutas configuradas, no escritos a mano) |
| `30-desplegar.ps1` | La guardia del paso 1/10 ignora esas carpetas y, si hay algo ajeno, lo **lista** en vez de hablar de «algo dentro»; el clon se copia con `robocopy /E` en vez de borrar el destino |
| `.gitignore` | `/data/` y `/backups/`: el clon del servidor no ensucia `git status` ni sube datos clínicos en un `git add -A` |

> **Sin migración.** Es infraestructura de instalación: no toca el código desplegado, ni las bases,
> ni la SPA.

## [Instalador] — En Windows, PostgreSQL ya no deja la instalación a medias · 2026-10-14

En una PC **sin PostgreSQL**, el instalador de Windows se detenía en la pieza 2/4 con «falta el
administrador de PostgreSQL (--admin-url o PG_ADMIN_URL)», y la única salida era repetir el comando
con la contraseña de `postgres` escrita en la línea de órdenes —donde queda en el historial de
PowerShell y en la lista de procesos de la máquina—. La causa es una diferencia de fondo que el
instalador de Windows **heredó 1:1** del de Fedora: allí, sin `--admin-url`, el aprovisionador entra
como usuario del sistema `postgres` por el socket «peer» (`runuser -u postgres psql`), así que un
motor recién instalado nunca deja fuera a nadie. En Windows ese socket **no existe**.

Quedaba además el caso peor: si el motor lo instalaba la propia pieza 1 con `winget`, el manifiesto lo
lanza con `--mode unattended --unattendedmodeui none` **sin `--superpassword`**, así que el rol
`postgres` acababa sin una contraseña que nadie conoce. La instalación en limpio moría ahí, sin forma
de salir desde el propio instalador.

Ahora la contraseña **se pide** (oculta, sin quedar en el historial ni en la lista de procesos), se
**comprueba por efecto** —una credencial vale cuando conecta, no cuando se escribió el archivo— y, si
el motor venía sin credencial utilizable, se **fija** con el recurso con el que sale cualquier DBA
cuando se queda fuera: abrir la conexión local sin contraseña unos segundos (`pg_hba.conf` en
`trust`, solo `127.0.0.1`/`::1`), `ALTER ROLE … PASSWORD`, y restaurar `pg_hba.conf` tal como estaba
**aunque algo falle a mitad**. Es el equivalente en Windows del socket «peer» de Fedora.

| Pieza | Qué cambia |
| :--- | :--- |
| `comun.ps1` | `Resolver-AdminUrlPostgres` (pide la contraseña, la codifica dentro de la URL y no la imprime), `Get-ClaveDeAdminUrl`, `Probar-ClavePostgres` (por efecto, con `PGPASSWORD` y sin tocar argv) y `Reiniciar-ClavePostgres` (la «ventana de confianza») |
| `instalar.ps1` | Pregunta la contraseña **una sola vez** y la lleva a las piezas por entorno (`PG_ADMIN_URL`), nunca por argumento; gana `--admin-usuario`/`--admin-host`/`--admin-puerto` y `--recuperar-postgres` |
| `10-preparar.ps1` | Deja la contraseña del administrador **conocida y comprobada** en los tres casos: ya estaba y se sabe · lo acaba de instalar la pieza 1 (se fija la que des) · se perdió (`--recuperar-postgres`) |
| `20-aprovisionar.ps1` | Ya no exige `--admin-url`: si falta, pide la contraseña (`--sin-preguntas` lo desactiva) |
| `30-desplegar.ps1` | Al rol de respaldo le pasa el entorno en vez de la URL por argumento (la URL lleva la contraseña) |
| `desinstalar.ps1` · `crear-rol-respaldo.ps1` | Si no hay administrador en el entorno, lo piden en vez de pararse |

> **Sin migración y solo para Windows.** Es infraestructura de instalación: no toca el código
> desplegado, ni las bases, ni la SPA. No entra con `odontocrm actualizar`.

## [Odontograma] — La leyenda del odontograma impreso sale en color (y no en blanco) · 2026-10-13

Al imprimir el odontograma, los **cuadritos de la leyenda** (rojo `pendiente`, azul `completado` y el
blanco de «sano») salían **en blanco** en el papel, aunque en pantalla y en la vista previa se vieran
bien. Lo mismo, en los **puntos de estado** de las tablas del informe (hallazgos, prótesis e historial).
No era un problema del color: esos códigos se pintaban con `background-color`, y **al imprimir el
navegador descarta los fondos CSS** salvo que el usuario active «gráficos de fondo» en el diálogo de
impresión. El resto del dibujo —dientes, símbolos, doble línea— ya iba en SVG, y por eso sí salía.

El arreglo dibuja esos cuadritos y puntos también como **SVG** (`fill`): el dibujo vectorial se imprime
siempre y no depende de ninguna casilla del diálogo. Los colores **clínicos** (rojo `pendiente`,
azul `completado`, `CLINICAL_STATE_COLORS`) no cambian: solo cambia cómo se pintan.

| Pieza | Qué hace |
| :--- | :--- |
| `Swatch` (`OdontogramStaticChart`) | Los tres cuadritos de la leyenda, en SVG en vez de `<span>` con fondo |
| `StateDot` (`OdontogramDocument`) | El punto de color del estado (hallazgos, prótesis e historial), en SVG |
| `document.test.ts` | Regresión: el papel **nunca** pinta un color clínico como `background-color`; los colores van en `fill`/`stroke` |

> **Sin migración.** Solo cambia el frontend: entra con `npm run build` (o `sudo odontocrm actualizar`
> en producción).

## [Clínica] — La verificación pública enseña el consultorio de verdad, no «Odontólogo prueba» · 2026-10-13

Al abrir el **QR de un récipe** (o del expediente) la página pública confirmaba la autenticidad, pero
firmaba **«Odontólogo prueba»** y dejaba el **nombre del consultorio en blanco**: la verificación
resolvía el firmante con `clinicDentistFor(usuario)` **sin** la identidad del consultorio, así que
caía al **respaldo del código** (`CLINIC`) —que solo tiene al odontólogo del **seed**— en vez de leer
la identidad real de la base. La web, además, encabezaba con `CLINIC.name` (vacío) en lugar del
nombre que devuelve la verificación. Arregla las dos páginas públicas: el récipe (`/verificar/<código>`)
y el expediente (`/verificar-expediente/<código>`).

| Pieza | Qué hace |
| :--- | :--- |
| `verifyPrescription` / `verifyDossier` (clinical) | Reciben el `letterheadLookup` y resuelven el odontólogo que **emitió** (`issuedByUsername`) y el nombre del consultorio desde la identidad real (ADR 0056) |
| Rutas `/clinical/verify/:code` y `/clinical/verify-expediente/:code` | Pasan el `letterheadLookup` del servicio en vez del `CLINIC.name` del código |
| `VerifyPrescriptionPage` / `VerifyDossierPage` (web) | El encabezado usa el `clinicName` de la verificación (la página es pública y no puede pedir la identidad sin sesión) |
| `prescription.integration.test.ts` | La verificación devuelve el consultorio y el odontólogo de la identidad leída, no los del código |

> **Sin migración.** Es lectura, no datos. El arreglo vive en el `dist` de `services/clinical` **y** en
> el bundle de la web: en producción hace falta `sudo odontocrm actualizar` (o `recompilar`) para que
> entre; hasta entonces la verificación sigue firmando «Odontólogo prueba».

## [Odontograma] — Retirar una PPR/PRT vuelve a funcionar: el borrado valida la ruta · 2026-10-13

**Eliminar o deshacer una prótesis removible** (PPR/PRT) devolvía «Los datos enviados no son válidos
— (cuerpo) (lleva campos que no se admiten)». La ruta de retirada
(`DELETE /api/v1/odontogram/patients/:patientId/prostheses/:id`) le pasaba a Zod **el `params`
entero** —que trae `patientId` **e** `id`— al contrato `deleteProsthesisSchema`, que es `.strict()` y
**solo admite `id`**: el `patientId` sobrante se rechazaba como campo desconocido y, como el fallo de
Zod no traía `path`, el detalle caía en `(cuerpo)`. Ahora la ruta valida sus `params` con su propio
esquema y al contrato le da **solo** el `id`, igual que la ruta de «dejar la cara sana» con su input.
Arregla las dos vías que comparten el mismo cliente: **eliminar** la prótesis y **deshacer** su
registro.

| Pieza | Qué hace |
| :--- | :--- |
| `odontogram-routes.ts` | Nuevo `prosthesisParamsSchema` (`patientId` + `id`) y el borrado de prótesis le pasa al contrato solo `{ id }` |
| `odontogram-server.test.ts` | Regresión del `DELETE .../prostheses/:id` (antes 400 por el `patientId`; ahora llega al servicio) y cobertura 401/403 de `PUT`/`DELETE .../prostheses` |

> **Sin migración.** Es validación de ruta, no datos. El arreglo vive en el `dist` del servicio
> `odontogram`: en producción hay que `sudo odontocrm actualizar` (o `recompilar`) para que entre.

## [Caja] — Partida escrita a mano en la factura · 2026-10-13

La caja solo podía facturar lo que estuviera en el **arancel**: un producto o servicio suelto (un
retiro de brackets, un cepillo, un trabajo de laboratorio) había que darlo de alta en el catálogo
antes de cobrarlo. Ahora el borrador tiene un botón **«Añadir línea manual»** que agrega una partida
**escrita a mano**: descripción, **casilla «Exento de IVA»** (marcada = exento al 0 %; sin marcar =
gravado al 16 %), precio y unidades. La **descripción es obligatoria** para guardar o emitir, y la
**categoría fiscal de las partidas del arancel no se puede cambiar** (la manda el catálogo, para que
un servicio odontológico no se pueda facturar gravado desde el mostrador). La partida manual sale en
la factura con su letra **`(E)`/`(G)`** y entra en el desglose de bases como cualquier otra.

| Pieza | Qué hace |
| :--- | :--- |
| `MANUAL_LINE_CODE` (contratos) | El código centinela `manual` y el `taxCategory` opcional de la línea del borrador |
| `buildItems` (billing) | La categoría sale del catálogo si la partida está en él; solo la línea manual declara la suya |
| `CajaPage` / `caja.ts` | «Añadir línea manual», descripción obligatoria y casilla «Exento de IVA» |

> **Sin migración**: `invoice_items` ya guardaba la categoría y la alícuota de cada partida.

## [Caja] — El membrete de la factura encabeza con el nombre del consultorio · 2026-10-13

La **factura**, el **recibo** y la **nota de crédito** ponían la **razón social** de nombre del
membrete y el **nombre del consultorio** como renglón de detalle. Cuando el titular dejaba la razón
social en blanco —el campo es opcional—, el renglón grande salía **vacío** y el nombre del
consultorio quedaba pequeño: el papel parecía no llevar el nombre del consultorio. Ahora los tres
componen el membrete **igual que el récipe, el dossier y el membrete de la SPA**: el **nombre del
consultorio** encabeza (admite dos líneas) y la **razón social**, si la hay, va de subtítulo. El
bloque sale del helper compartido (`buildLetterheadView`), así que la caja deja de desviarse del
resto de los imprimibles.

| Pieza | Qué hace |
| :--- | :--- |
| `invoice-pdf.ts` | El membrete encabeza con el nombre del consultorio; la razón social va de subtítulo |
| `receipt-pdf.ts` | Lo mismo para el recibo de un cobro |
| `credit-note-pdf.ts` | Lo mismo para la nota de crédito |
| `letterhead.ts` (contracts) | Los comentarios de `LetterheadView.name`/`subtitle` dejan de decir «la factura pone la razón social» |
| `invoice-pdf.test.ts` / `cobros-pdf.test.ts` | Regresión: el nombre del consultorio encabeza aunque la razón social venga vacía |

> **Sin migración.** Es composición del membrete, no datos. Los PDF ya archivados **no** se
> regeneran: la factura emitida sigue diciendo lo que decía (ADR 0048). Las nuevas salen con el
> nombre arriba.

## [Respaldo] — Reimprimir récipes tras restaurar, y no sembrar cuentas de prueba · 2026-10-13

Dos fallos del flujo de respaldo, los dos en la restauración:

**Los récipes no se podían reimprimir después de restaurar.** Reimprimir un récipe no recompone
el PDF: vuelve a leer el archivo archivado en el almacén (cifrado con `STORAGE_ENCRYPTION_KEY`).
`odontocrm restaurar` solo restauraba las bases —no el almacén—, y al reinstalar se generaba otra
clave, así que los documentos quedaban ausentes o ilegibles. Ahora `restaurar` (con `--all`) y
`recuperar` **repueblan el almacén**, **reconcilian la clave** (copian la del respaldo a los `.env`
sin tocar el resto) y **comprueban de verdad** que un archivo de muestra se descifra
(`tools/verificar-almacen.mjs`). El simulacro de restauración (`verify-backup`) revisa también el
almacén, no solo las bases.

**Se sembraban dos cuentas de prueba en el servidor.** `30-desplegar.sh` usaba por defecto el juego
completo de desarrollo («Recepción prueba» y «Odontólogo prueba») cuando `USUARIOS_SEED` estaba
vacío, y `odontocrm actualizar` no la definía. Ahora el defecto es **solo `admin`**; el juego
completo se pide con `USUARIOS_SEED=all` (`--con-todas-las-cuentas` en el instalador). Para las
cuentas ya sembradas hay `sudo odontocrm purgar-prueba` (por defecto las **desactiva**; `--borrar`
las elimina).

| Pieza | Qué hace |
| :--- | :--- |
| `infra/fedora/backup/lib-almacen.sh` (nuevo) | Repone el almacén, reconcilia la clave y verifica que se lee |
| `tools/verificar-almacen.mjs` (nuevo) | Cuenta archivos (en claro/cifrados) y descifra una muestra; sale 1 si no se lee |
| `tools/purgar-cuentas-prueba.mjs` (nuevo) | Quita `recepcion` y los odontólogos de `clinic.ts` de identity |
| `aprovisionar.mjs` | + `--clave-almacen` (reemplaza SOLO esa línea en los `.env`; no toca el resto) |
| `odontocrm restaurar`/`recuperar` | Reponen el almacén y su clave; `restaurar --all` también reinicia |
| `odontocrm purgar-prueba` | Nuevo subcomando (Fedora y Windows) |
| `30-desplegar.sh` | Siembra solo `admin`; el juego completo es opt-in (`USUARIOS_SEED=all`) |

## [Pantallas] — Estética propia del lobby: tema, acento y logo de marca de agua · 2026-10-13

Las pantallas de la sala y del consultorio dejan de estar ancladas a la estética de la
aplicación: cada pantalla se configura en `/pantallas` con su **modo** (claro u oscuro), su
**color de acento** (los mismos diez presets de la interfaz) y la opción de mostrar el **logo
del consultorio como marca de agua** (silueta con alfa distinto según el modo). El **lobby**
se reordena: arriba y centrado el **nombre del consultorio** (el que completa el titular en su
primer login) y, debajo, la **hora** y cuánta gente hay **en sala**; abajo, en las esquinas, lo
discreto —a la izquierda «Sala de espera – ‹pantalla›» y a la derecha el indicador de conexión
(icono + última actualización, en verde o ámbar)—. Se añaden animaciones de entrada y de
resalte. **Sin migración**: el aspecto se guarda en el JSONB de ajustes de cada pantalla.

| Pieza | Qué hace |
| :--- | :--- |
| `screenSettingsSchema` (contratos) | + `tema` (`claro`/`oscuro`), `acento` (10 presets) y `logoMarcaAgua` (booleano) |
| `GET /api/v1/screens/clinic` (nuevo) | La marca del consultorio (nombre + logo) para la pantalla; reusa el lector de identity con caché |
| `useKioskTheme` (web) | Traduce los ajustes a variables CSS `--kiosk-*`; **no** sigue la clase `dark` de la app |
| `pantalla.css` (nuevo) | Estética kiosko: fondo con halo del acento, marca de agua y animaciones |
| `ScreenLobbyPage` | Cabecera centrada (nombre + hora + en sala), pie en las esquinas |
| `ScreenSettingsDialog` | Modo, acento y marca de agua por pantalla |

## [Respaldo] — `/respaldo`: la copia completa del servidor, pedida desde Telegram · 2026-10-12

El respaldo automático solo se puede lanzar como Administrador (Windows) o root (Fedora): su guion
exige ese permiso y lee el `.pgpass`, que en Windows es de solo Administradores. El bot de
administración corre como `LocalService`, así que desde Telegram no había forma de pedir una copia
en la máquina —solo `/respaldos`, que manda las **bases** por chat y se pierde los adjuntos y los
secretos—. Ahora `/respaldo` (y `npm run respaldo:manual`, la misma pieza sin Telegram) deja una
copia **completa** en el servidor: bases + **almacén** + **configuración**, con sus `SHA256SUMS` y su
`manifest.txt`, verificada (cabecera `PGDMP`, catálogo con `pg_restore --list`) y con la **misma
forma** que la del temporizador, de modo que `odontocrm recuperar --from <carpeta>` la repone tal
cual. No manda archivos: responde con la carpeta, el tamaño de cada bloque y las dos órdenes para
comprobarla y reponerla.

| Pieza | Qué hace |
| :--- | :--- |
| `tools/lib/admin-informes.mjs` | `tomarRespaldoCompleto()`: volcados + almacén + configuración, sumas, manifiesto y retención propia (5 copias, `ODONTOCRM_BACKUP_MANUAL_KEEP`) |
| `tools/admin-bot.mjs` | Atiende `/respaldo` (alias `/completo`); `/respaldos` sigue igual |
| `tools/respaldo-manual.mjs` · `npm run respaldo:manual` | Lo mismo desde la consola (`--dest`, `--conservar`, `--json`) |
| `ADMIN_BOT_COMMANDS` (contratos) | El comando nuevo entra en el menú de Telegram (y en la ayuda) por el catálogo |
| `ODONTOCRM_BACKUP_MANUAL_DIR` | Dónde se queda la copia: Fedora `/var/lib/odontocrm/respaldo-manual`, Windows `C:\OdontoCRM\data\respaldo-manual`. **Fuera** de `BACKUP_DIR` a propósito: en Windows esa carpeta es solo de Administradores, y la retención de estas copias es aparte |

La carpeta del respaldo manual se crea en el instalador (Fedora, `0700 root:root`) y la unidad del
bot la declara en `ReadWritePaths`, porque con `ProtectSystem=strict` lo que no esté ahí es de solo
lectura. Probado con el simulacro: la copia restaura las 10 bases (incluida la cola `odonto_events`)
en bases temporales y las sumas cuadran.

## [Mi perfil] — Las cuentas que no firman documentos ya no ven «te falta el perfil» · 2026-10-12

Una cuenta **sin rol Odontólogo** (Administración, Secretaría) entraba a «Mi perfil» y se encontraba
un aviso de advertencia («todavía no has completado tu perfil profesional») sobre un formulario
vacío. Técnicamente cierto —nunca va a tener perfil: el MPPS y la especialidad son de quien firma el
récipe— pero engañoso, porque ahí no hay nada que completar. Ahora esa cuenta ve un aviso
**informativo** que lo explica, y si puede gestionar usuarios un botón a `/usuarios`, que es donde
está el trabajo que sí le toca. El formulario y la consulta del perfil quedan solo para los
odontólogos, y la tarjeta del consultorio sigue siendo del **titular** (que el servidor elige entre
los odontólogos). Cambio de presentación: la API no cambia.

## [Recuperación] — `odontocrm recuperar`: la recuperación completa en un comando · 2026-10-12

Recuperar un servidor (nuevo o tras un fallo físico) obligaba a encadenar a mano `parar` +
`restaurar` + montar el almacén + `arrancar`, y el almacén ni siquiera venía en el respaldo.
Ahora hay un comando que hace el flujo entero:

```bash
sudo odontocrm recuperar --from /media/pendrive/2026-10-12 --yes
```

Para los servicios, restaura las bases (con la verificación previa del restaurador y
`--keep-old`), repone el almacén y arranca (que ya termina verificando). Es un **orquestador**:
no reimplementa nada, reutiliza lo que ya estaba probado. La **configuración no se toca** a
propósito —los `.env` del respaldo son de la máquina anterior y pisarían las contraseñas que el
instalador acaba de crear—; con `--con-config` se repone, y sin `--yes` solo dice qué haría.

El restaurador acepta ya los **volcados del bot de administración** (`<base>.dump`, sin la fecha en
el nombre), no solo los del respaldo nocturno (`<base>_<fecha>.dump`): recuperar con lo que mandó
`/respaldos` por Telegram no exige renombrar los archivos a mano. Si en la carpeta están las dos
formas, manda la del respaldo nocturno.

## [Respaldo] — El respaldo diario incluye el almacén, y hay guía de recuperación · 2026-10-12

El respaldo diario guardaba **bases + configuración**, pero **no** el almacén (radiografías y
PDFs), y la restauración **no** reponía ni el almacén ni la configuración. Consecuencia: un
fallo físico del disco dejaba la base recuperable pero **los adjuntos perdidos** — y, si el
almacén está cifrado, restaurarlo sin la configuración (sin el `STORAGE_ENCRYPTION_KEY`) lo
dejaría **ilegible**.

| Pieza | Qué cambia |
| :--- | :--- |
| `odontocrm-backup.service` (Fedora) · tarea «respaldo diario» (Windows) | El respaldo diario pasa a `--include-config --include-storage` |
| `odontocrm respaldar` (los dos CLI) | Lo mismo: el almacén entra por defecto |
| `odontocrm-backup.sh` | Si no hay almacén todavía, **avisa y sigue** (antes abortaba: siendo el valor por defecto, no puede tumbar la copia nocturna) |
| `RUNBOOK.md` (Fedora y Windows) | Nueva sección **«Recuperación completa: servidor nuevo o fallo físico»**: instalar → verificar el respaldo → parar → restaurar bases → reponer almacén y configuración → arrancar → verificar |

El respaldo ya se puede validar entero antes de tocar nada: `verify-backup.mjs` comprueba el
SHA-256 de **todos** los archivos del respaldo (bases y archivos), no solo los `.dump`.

## [Administración] — `/estado` y respaldos por el bot de administración · 2026-10-12

El bot de administración solo **enviaba** avisos; ahora también **escucha**. Un proceso aparte
(`odontocrm-admin-bot`, supervisado por PM2 en Windows y `systemd` en Fedora) atiende al dueño del
consultorio y responde con el estado del servidor (`/estado`, la misma foto que `npm run estado`) y
con un respaldo a demanda (`/respaldos`): `pg_dump` de las bases con las credenciales de cada
servicio, verificación de cada volcado y envío de los `.dump` + `SHA256SUMS` por Telegram. Solo
responde al chat anclado (`ADMIN_TELEGRAM_CHAT_ID`). El catálogo de comandos vive en el contrato
(`ADMIN_BOT_COMMANDS`), aparte del menú del bot de pacientes. Las credenciales salen del **panel**
(`/configuración` → Canales), que **manda** sobre el `.env`: las herramientas de consola y el bot
leen identity directamente (corren fuera de la pila y a menudo con los servicios caídos), así que
configurar el bot ahí es suficiente. El bot **relee las credenciales cada ~30 s**, de modo que un
cambio del panel se aplica en ~1 minuto sin reiniciar (el panel lo indica junto a los campos).

| Pieza | Qué hace |
| :--- | :--- |
| `tools/admin-bot.mjs` | El escucha: long polling, solo el chat anclado, menú y despacho |
| `tools/lib/bot-admin.mjs` · `tools/lib/admin-informes.mjs` | Transporte de Telegram y los informes (estado `--json` del tablero + respaldo ad-hoc) |
| `ADMIN_BOT_COMMANDS` (contratos) | Fuente única del menú de administración |
| `odontocrm-admin-bot` (PM2) · `odontocrm-admin-bot.service` | Supervisión en Windows y Fedora |

## [Marca] — El logo del consultorio es el favicon y la marca de producto · 2026-10-12

La pestaña y las pantallas de acceso y del raíl usaban el **estetoscopio** genérico. Ahora usan el
**logo del consultorio** (`assets/clinic/logo.svg`), el mismo del membrete impreso: el favicon se
inyecta en el arranque con `clinicLogoUrl()` (sin `public/` ni duplicar el binario) y un componente
`MarcaTile` pinta el logo **enmascarado** (hereda `currentColor`, como hacía el icono). Los
estetoscopios **semánticos** (módulo «Consultorio», secciones clínicas, kiosko) se conservan.

## [Instalador] — Windows: respaldos, binarios y `pg_hba` · 2026-10-12

Tres arreglos en el instalador de Windows. (1) El **simulacro semanal** de restauración
(`verify-backup.mjs`) buscaba los respaldos en `C:\ProgramData\OdontoCRM\backups` mientras el
respaldo los escribe en `C:\OdontoCRM\backups`: no encontraba nada y salía en **verde** (un
simulacro que no comprobaba nada). Ahora lee `BACKUP_DIR` de `backup.env`, la fuente única. (2) Los
binarios `mkcert.exe` y `caddy.exe` se descargaban **sin hash** y Caddy «la última»: ahora van con
versión y SHA-256 fijados (Caddy v2.11.7, mkcert v1.4.4) y la descarga se verifica. (3) El
`pg_hba.conf` se reescribía **con BOM** (`Set-Content -Encoding UTF8` en PowerShell 5.1), que
PostgreSQL puede rechazar: ahora se escribe sin BOM. La zona horaria, además, se **fija** en vez de
solo avisar.

## [Arreglo] — El récipe vuelve a una sola hoja: la marca de agua desbordaba · 2026-10-11

Con la marca de la clínica (logo del membrete a 30 mm, velo de 110 mm, nombre a 24 pt) el récipe
seguía saliendo en **dos hojas** aunque el arreglo del
[ADR 0065](docs/adr/0065-el-recipe-cabe-en-el-papel-de-la-clinica.md) ya estaba desplegado. La causa
**no** era el papel ni la altura de la hoja: era la **marca de agua**. La marca se centra con
`top: 50%` + `transform: translateY(-50%)`, y ese `transform` solo la mueve **a la vista**: su **caja
de layout** queda anclada al 50 % de la mitad y **se extiende hacia abajo** por toda su altura. Con un
velo grande esa caja pasaba del área imprimible y Chromium añadía una **segunda hoja en blanco** —algo
que la medición del encaje no veía, porque mide la caja de `.sheet`, no los elementos fuera de flujo—.

Ahora la marca se centra **sin transform** (`inset: 0` + `margin: auto`, con `max-height/max-width:
100 %`), de modo que su caja queda **dentro** de la mitad (misma posición a la vista) y encoge con la
hoja (`--rx-fit`). Y el encaje queda **blindado**: tras medir, el servicio **cuenta las hojas del PDF
ya compuesto** y, si el documento se pasó (una marca más alta, un membrete más grande), **aprieta la
escala y recompone** hasta que quepa en una. Así un membrete modificado ya no puede dejar la segunda
hoja.

| Pieza | Qué hace |
| :--- | :--- |
| `prescription-document.ts` (clinical) | La marca de agua se centra sin transform, con su caja dentro de la mitad |
| `pdf-renderer.ts` (clinical) | `maxPages` (por defecto 1): comprueba las hojas del PDF y aprieta la escala si se pasa |

## [Notificaciones] — El `.ics` de la cita vuelve a abrirse en el celular · 2026-10-11

El calendario que el paciente recibe por Telegram o WhatsApp dejó de abrirse en el teléfono. No era la
entrega: era el **archivo**. `CN=` —el parámetro con el nombre del consultorio— se escapaba con las reglas
de los **valores de propiedad** (`\,`), y en un **parámetro** la norma es otra (RFC 5545 §3.2): cuando el
valor lleva `,`, `;` o `:` hay que **entrecomillarlo**. El nombre real del titular («Clínica Odontológica
Sonrisa, C.A.») producía `CN=Clínica Sonrisa\, C.A.`; la coma queda suelta y un analizador estricto
rechaza el calendario entero, así que el móvil ni lo ofrece. Con `;` o `:` es peor: el parámetro se corta.
Antes no se notaba porque el nombre era una constante del código; desde que la identidad vive en la base
([ADR 0056](docs/adr/0056-la-identidad-del-consultorio-vive-en-la-base.md)) es el que escriba el titular.

Ahora los parámetros se entrecomillan **siempre** —lo que hace Google Calendar— y dentro se codifica
según RFC 6868 (`^`→`^^`, `"`→`^'`); un `\r` suelto en un valor ya no parte la línea por la mitad. Y el
documento viaja con el tipo **canónico** `text/calendar`: Telegram y WhatsApp usan esa cadena como
`mime_type` y el teléfono decide con ella qué aplicación ofrece, así que un tipo con parámetros
(`…; charset=utf-8; method=PUBLISH`) dejaba de reconocerse como calendario. El `METHOD` no se pierde: va
**dentro** del archivo, que es quien lo lee.

El arreglo llegaba a medias: el `.ics` se guarda por cita y secuencia y se **reutiliza** al reenviar, así
que las citas que ya tenían su archivo habrían seguido con el roto. La marca de **versión de formato** en
el `PRODID` resuelve eso sin migración: el servicio mira la versión guardada y, si es anterior, rehace el
archivo y actualiza **la misma fila** (la secuencia no cambia: el evento es el mismo).

| Pieza | Qué hace |
| :--- | :--- |
| `domain/ics.ts` (contratos) | `escapeIcsParam` entrecomilla y codifica (RFC 6868); `escapeIcsText` convierte un `\r` suelto |
| `domain/ics.ts` (contratos) | `ICS_FORMAT_VERSION` / `ICS_PRODID` / `icsFormatVersionOf`: el formato queda versionado en el archivo |
| `messaging.ts` (notificaciones) | Rehace el artefacto guardado con un formato anterior; `composeIcs` evita duplicar la composición |
| `messaging.ts` (notificaciones) | El documento sale con `mime: 'text/calendar'` (sin parámetros) |
| `notification.test.ts` · `messaging.ics.test.ts` | Coma, `;`, `:`, comillas, dos líneas, versión del formato y reutilización del artefacto |

## [Configuración] — El error de validación dice qué campo está mal · 2026-10-11

Al personalizar el consultorio en `/configuracion`, guardar podía responder **«Los datos enviados no son
válidos»** y nada más: sin decir qué campo. El mensaje era el `detail` genérico de `parseOrThrow` y el
detalle por campo viajaba solo en `errors[]`, que nadie pinta. Y había un segundo problema: Zod no trae
textos en español, así que el motivo salía en inglés («Too small: expected string to have >=1
characters») en un sistema que está todo en español.

Ahora el 400 **nombra los campos** —`logoHeightMm (no puede ser mayor que 60)`—, hasta tres, y resume el
resto («y 2 más»). Como el nombre va **sin dos puntos**, la censura de credenciales de `sanitizeMessage`
(`password: …`, `token: …`) no lo confunde con un secreto. Los mensajes de Zod se instalan en español en
los servicios y en la SPA, con el límite dicho en palabras, y **un texto escrito a medida en el esquema
manda**: «El correo no es válido» o «Usa un color en formato #rrggbb» se siguen leyendo igual. De paso, el
panel **valida antes de enviar** (como ya hacía la paleta): marca el campo en rojo con su rango y
deshabilita Guardar en vez de mandar algo que el servidor va a rechazar.

En el camino se cerraron dos defectos reales del panel, que eran los que hacían fallar el guardado: la
entrada de canales rechazaba `null` —la forma en que la vista devuelve un campo sin valor— y la base de
WhatsApp vacía, que el servicio interpreta como «volver a la de fábrica».

| Pieza | Qué hace |
| :--- | :--- |
| `common/zod-es.ts` (contratos, nuevo) | Los mensajes de Zod en español, diciendo el límite («no puede ser mayor que 60») y respetando los textos del esquema |
| `errors.ts` (kernel) | `ValidationError` compone `mensaje — campo (motivo) · y N más`; `errors[]` no cambia |
| `validation.ts` (kernel) | Instala los mensajes en español en los servicios: el detalle por campo deja de salir en inglés |
| `domain/settings.ts` (contratos) | Los canales aceptan `null` y `''`; `BRAND_LIMITS` es la única fuente de los mínimos y máximos |
| `MarcaSection` · `MembreteSection` · `RolTipografico` | Error en línea y Guardar deshabilitado con un valor fuera de rango o una pila vacía |
| `CanalesSection` · `PantallasSection` · `api.ts` | El aviso añade el `path` que el servidor no hubiera nombrado (una puerta antigua sigue diciendo qué corregir) |

## [Despliegue] — El build compila en limpio y avisa si el `dist` es viejo · 2026-10-11

El récipe salía en producción con la **letra encogida y en dos hojas** aunque el arreglo
([ADR 0065](docs/adr/0065-el-recipe-cabe-en-el-papel-de-la-clinica.md)) ya estaba en el repositorio. No era
el código: era el **despliegue**. `npm run build` usa `tsc -b`, que es **incremental** (`composite` +
`.tsbuildinfo` dentro de `dist/`) y puede dar por compilado un proyecto del que **no emitió todos sus
módulos**; y un `git reset --hard` (o un `checkout`) en `/opt/odontocrm` cambia el **fuente** pero **no
recompila**, así que el servicio sigue corriendo el `dist` viejo. En el servidor faltaba justo
`services/clinical/dist/prescriptions/fit-to-page.js` —el módulo nuevo del encaje— y el récipe volvía al
comportamiento anterior.

Ahora el build de la raíz **compila en limpio** (`prebuild` borra cada `dist/` y cada `*.tsbuildinfo` de
los paquetes, sin tocar `node_modules`) y deja una **marca del commit compilado** (`.odontocrm-build-commit`,
`postbuild`). El despliegue **comprueba que existen** el `index.js` de cada servicio y el del gateway (si
falta alguno, **falla** con el mensaje), y `odontocrm verificar` (Fedora) y `40-verificar.ps1` (Windows)
**avisan** cuando el `dist` desplegado no es el del código del disco. Todos los caminos —Fedora
(`compilar`/`recompilar`/`actualizar`/`30-desplegar.sh`) y Windows (`odontocrm.ps1`/`30-desplegar.ps1`)—
llaman a `npm run build`, así que heredan el arreglo sin duplicarlo.

| Pieza | Qué hace |
| :--- | :--- |
| `tools/limpiar-dist.mjs` (nuevo) | Borra todo `dist/` y `*.tsbuildinfo` del monorepo (ignora `node_modules`); lo llama `prebuild` |
| `tools/marcar-build.mjs` (nuevo) | Escribe `.odontocrm-build-commit` con el `HEAD` compilado; lo llama `postbuild` |
| `package.json` (raíz) | `prebuild` (limpia) + `postbuild` (marca) + `limpiar:dist` |
| `.gitignore` | Ignora `.odontocrm-build-commit` |
| `infra/fedora/instalar/30-desplegar.sh` | Tras compilar, exige el `dist/index.js` de cada servicio y del gateway |
| `infra/fedora/odontocrm` | Misma comprobación en `compilar`/`recompilar`; aviso de `dist` viejo en `verificar` |
| `infra/windows/instalar/comun.ps1` | `Get-EntrypointsFaltantes` y `Get-AvisoDistViejo` (compartidos) |
| `infra/windows/odontocrm.ps1` · `30-desplegar.ps1` · `40-verificar.ps1` | La comprobación y el aviso, espejo de Fedora |
| `docs/COMANDOS_PRODUCCION.md` | Nota: un `git reset/checkout` en `/opt` no recompila |

## [Interfaz] — El «teléfono alternativo» del paciente pasa a llamarse «teléfono de emergencias» · 2026-10-11

Cambio **solo de texto visible**: el campo del paciente que se rotulaba «Teléfono alternativo» ahora
se muestra como **«Teléfono de emergencias»**, con la ayuda «A quién avisar en caso de emergencia».
No cambia ningún identificador ni dato: la clave interna sigue siendo `phoneAlt` y la columna de la
base `phone_alt`, así que **no hace falta migración** y los datos guardados se conservan tal cual.
El cambio vive en el diccionario (`i18n.ts`) y en el formulario de paciente (`PatientFields.tsx`).

## [Imprimibles] — El papel de la clínica es carta en todos los imprimibles · 2026-10-11

El papel de la bandeja de la clínica es **carta**, no A4: una hoja A4 que no entra en la bandeja deja
una franja fuera que la impresora pagina a una **segunda hoja en blanco** —el mismo síntoma que abrió
el [ADR 0065](docs/adr/0065-el-recipe-cabe-en-el-papel-de-la-clinica.md)—. Ahora **todos los
imprimibles** salen en carta: la historia clínica y el odontograma (navegador), y el récipe, el
dossier, el reporte, la factura, el recibo y la nota de crédito (servidor).

El **récipe** cambia su papel de fábrica de A4 a **carta** (`recipePaper`); el panel sigue permitiendo
elegir A4 para una clínica que imprima en A4. Las hojas del servidor pasan de `@page { size: A4 … }` a
`letter` y los `page.pdf()` de `format: 'A4'` a `'Letter'`.

| Pieza | Qué hace |
| :--- | :--- |
| `brand.ts` (contracts) | `recipePaper: 'letter'` de fábrica |
| `domain/settings.ts` (contracts) | `recipePaperSchema` con `letter` por defecto |
| `invoice-pdf` / `receipt-pdf` / `credit-note-pdf` | `@page { size: letter portrait; … }` y `format: 'Letter'` |
| `dossier-document.ts` / `dossier-service.ts` | `@page { size: letter; }` y `format: 'Letter'` |
| `report-html.ts` / `pdf-renderer.ts` (reporting) | `@page { size: letter landscape; … }` y `format: 'Letter'` |
| `MarcaSection` / `i18n` | La opción de carta primero, con la de A4 como excepción |

## [Interfaz] — El nombre del consultorio admite espacios al escribirlo · 2026-10-11

Al crear la cuenta del **odontólogo titular**, el nombre del consultorio se edita en **dos líneas**,
pero **no admitía espacios**: el formulario recortaba cada línea **en cada tecla**, así que el espacio
entre dos palabras desaparecía en cuanto se tecleaba («Clínica Sonrisa» quedaba «ClínicaSonrisa»).
Ahora el formulario **no recorta mientras se escribe**; el recorte, el tope de dos líneas y el
descarte de las vacías los hace el esquema al guardar (`clinicProfileSchema.name`), que ya lo hacía.
El arreglo vive en dos ayudantes compartidos (`clinicNameLines` / `clinicNameFromLines`) que usan el
alta del titular y Mi perfil.

## [Imprimibles] — El récipe cabe en el papel de la clínica y sale en una sola hoja · 2026-10-11

En el servidor de la clínica el récipe dejaba **una segunda hoja en blanco**: el documento perfecto
en la primera y una hoja vacía detrás. Se probaron dos arreglos sobre la **altura de la hoja**
(199 mm → 185 mm) y una **escala de encaje** a ciegas, sin éxito, y el encaje dejó un efecto
secundario visible: **la letra salía más pequeña**. Eran tres causas, ninguna la altura de la hoja.

**(1) El papel no era el del consultorio.** El récipe era el **único** imprimible en carta —la
historia, el odontograma, el reporte, el dossier, la factura y el recibo salen en A4— y una hoja
**carta apaisada mide 215,9 mm de alto y no cabe en una A4 (210 mm)**: la impresora pagina la franja
que sobra —que va **en blanco**, porque el contenido muere 8 mm antes del borde— a una segunda hoja.
Ahora el papel es de la marca (`recipePaper`, **A4** de fábrica) y se elige en *Configuración →
Marca → Papel del récipe*; el mismo valor fija el `@page` de la plantilla y el tamaño del PDF, así
que no depende de quién gane. Una marca guardada antes de este ajuste sale en A4 sin migrar nada.

**(2) El encaje no medía.** Probaba escalas fijas (1 → 0,94 → … → 0,7) y contaba las hojas del PDF
ya compuesto: con un récipe largo, la escala mínima no bastaba y quedaban las dos hojas con la letra
encogida. Ahora `fit-to-page.ts` **mide**: pone la ventana del navegador con el tamaño del área
imprimible, mide la hoja a escala 1, calcula la proporción que sobra y la comprueba midiendo otra
vez. Nunca agranda un récipe corto (escala 1) ni baja del tope de legibilidad (0,7).

**(3) El encaje no escalaba la hoja y medía con el ancho de la ventana.** La altura mínima de la hoja
no se multiplicaba por la escala —así que el contenido encogía y la página seguía sin caber— y el
documento se medía en una ventana de 1 280 px, **más ancha que el papel** (263 mm): el texto se
plegaba en menos renglones al medir que al imprimir, y la cuenta decía «cabe» donde el PDF veía «no
cabe». Ahora la hoja entera se multiplica por la escala y se mide con el **ancho y el alto reales**
del área imprimible.

**La tipografía del récipe, por fin, sale del panel.** Los tres tamaños de *Configuración → Marca*
(título, cuerpo y menudo: 13 / 9 / 7,5 pt de fábrica) alimentan la escala del documento; los
intermedios son las proporciones que el récipe ya tenía sobre esos tres, así que con los valores de
fábrica el papel sale **exactamente** como salía y mover uno de los tres mueve su familia entera.
Antes los tamaños estaban escritos a mano en la plantilla y el panel no los movía.

| Pieza | Qué hace |
| :--- | :--- |
| `domain/settings.ts` (contracts) | `RECIPE_PAPERS` + `recipePaperSchema` (A4 por defecto) en la marca y en el tema efectivo |
| `brand.ts` (contracts) | `BrandTheme.recipePaper` y `recipePaperGeometry()`: el `@page`, el `format` del PDF y la medida en mm, de una sola fuente |
| `fit-to-page.ts` (clinical, **nuevo**) | El encaje medido: `fitScale`, `fitToAvailable`, el tope de 0,7 y el margen de seguridad (probado sin navegador) |
| `pdf-renderer.ts` (clinical) | `fitToPage`: mide el bloque con la **ventana del tamaño del área imprimible** y escribe la escala en `--rx-fit` |
| `prescription-document.ts` | `@page` según el papel de la marca; la tipografía del récipe sale de los tres pt del panel; la altura mínima de la hoja se multiplica por el encaje |
| `prescription-service.ts` | Compone con el papel de la marca y pasa el encaje (ancho y alto del área imprimible) |
| `MarcaSection` / `i18n` | Desplegable «Papel del récipe» (A4 apaisado / carta apaisada) |
| `brand_settings` (identity) | Columna `recipe_paper` (migración 0007); las filas anteriores salen en A4 |
| `prescription.integration.test.ts` / `smoke-prescription.mjs` | El PDF emitido se cuenta: **una sola hoja** |
| `fit-to-page.test.ts`, `prescription-document.test.ts`, `settings.test.ts`, `brand.test.ts` | El encaje, el papel y la tipografía del panel |

## [Imprimibles] — El récipe cabe en una hoja y el nombre admite dos líneas · 2026-10-10

Dos arreglos del mismo papel. **(1)** El récipe dejaba una **segunda hoja casi en blanco** con el
documento perfecto en la primera. Eran **dos causas**. La de fondo: la hoja tenía **altura fija de
199 mm** y el área imprimible de una carta apaisada con márgenes de 8 mm mide ≈200 mm — **menos de 1
mm de holgura** —, así que cualquier diferencia entre navegadores (versión de Chromium, DPI, el margen
efectivo del sistema) desbordaba **siempre**, y el encaje no lo arreglaba porque **no escala la altura
de la hoja** (de ahí «letra más pequeña y sigue la doble página»). Ahora la hoja es una **altura
mínima holgada** (185 mm): nunca roza el borde y, si el contenido pide más, crece hasta el área
imprimible en vez de partirse. La segunda causa es un récipe **muy largo**: si aun así no cabe, el
servicio lo recompone con una **escala de encaje** (1 → 0,94 → … → 0,7) hasta que sale en **una sola
página**. El récipe normal sale a escala 1, sin encoger.

**(2)** El **nombre del consultorio** puede partirse en **dos líneas** desde Mi perfil (y el primer
acceso): el membrete las imprime tal cual. Se guardan en la **misma columna de texto** con un salto
de línea — **sin migración** —, y los textos que **no** son el membrete (el bot, el `.ics` y las
pantallas de sala) las unen en **una sola línea** para que el salto no se cuele donde no toca.

| Pieza | Qué hace |
| :--- | :--- |
| `prescription-document.ts` | Hoja con `min-height` holgado (185 mm) en vez de alto fijo al límite; `--rx-fit` escala todo el documento y `withPrescriptionFit` lo reescribe |
| `prescription-service.ts` | Compone a escala 1 y, si sale en dos hojas, reintenta 0,94…0,7 hasta una página |
| `clinic.ts` | `clinicNameOneLine`: une las dos líneas del nombre para bot, `.ics` y pantallas |
| `domain/clinic-profile.ts` | El nombre admite hasta dos líneas (recorta cada una y descarta las vacías) |
| `brand.ts` | `.brand-lh-name` con `white-space: pre-line`: el membrete respeta el salto |
| `ProfilePage` / `CompleteProfilePage` | Dos campos: nombre (línea 1) y línea 2 opcional |
| `MembreteSection` | La **vista previa** del membrete respeta el salto |
| `clinic-identity.ts` | `CLINIC_NAME` sale en una línea (bot, `.ics` y cabecera de las pantallas) |

## [Imprimibles] — El respaldo de la marca deja de ser silencioso · 2026-10-10

Los documentos del servidor (récipe, dossier, reporte, factura, recibo y nota) leen la marca
efectiva de identity por la red interna (`createBrandLookup`, ADR 0060). Si esa lectura falla
—identity caído, un despliegue con la ruta vieja, el `INTERNAL_SERVICE_SECRET` distinto, una
respuesta que no cumple el contrato—, el servicio **degradaba a `BRAND` sin decir nada**: el panel
cambiaba los colores y las fuentes y el papel salía con los **del código**, que se lee como «el color
no se aplica». Ahora ese respaldo **avisa** (una vez por minuto) en el log del servicio, con el motivo.

**Verificación de la cadena.** `npm run e2e:config` comprueba ahora que el **PDF** que compone el
servidor sale con el primario del panel (infla los flujos del PDF y lee los operadores RGB), no solo
el CSS de la SPA: era el tramo que ninguna prueba miraba. Se añadieron además pruebas de que una
paleta propia llega a **las seis** plantillas (recibo y nota de crédito no tenían ninguna).

**Fallo corregido de la propia prueba.** El e2e comprobaba que la fuente subida desaparecía por
`weight === 500`, pero la familia **Inter** trae de fábrica una fuente con ese peso: la aserción era
cierta siempre y fallaba aunque la baja fuera correcta. Ahora se compara por **ruta**.

| Pieza | Qué hace |
| :--- | :--- |
| `brand-lookup.ts` / `clinic-identity.ts` | `onFallback`: el respaldo del código avisa con el motivo (máximo uno por minuto) en vez de degradar en silencio |
| `clinical`/`reporting`/`billing` (`index.ts`) | Conectan el aviso al log del servicio (logger resuelto por referencia, como el publicador) |
| `brand-lookup.test.ts` (nuevo) | La marca buena no avisa; el 404, el cuerpo inválido, el fallo de red y la falta de secreto degradan **y avisan**; el aviso no se repite |
| `invoice-pdf`, `receipt-pdf`, `credit-note-pdf`, `prescription-document`, `dossier-document`, `report-html` | Prueba de que una paleta propia sale en el papel |
| `e2e-config.mjs` | Comprueba el color del primario **dentro del PDF** del reporte; la baja de fuente pasa a compararse por ruta |

## [Imprimibles] — La tipografía del membrete llega al papel · 2026-10-10

El nombre del membrete se podía configurar con una **familia propia** (ADR 0064), pero al **imprimir**
salía con la sans del sistema aunque en la **vista previa** se viera bien: su `@font-face` no viajaba en
el CSS porque identity solo incrustaba las familias de los **títulos y el cuerpo**, no la del **nombre
del membrete**. El bug de las impresiones del membrete, en una línea.

**Dos causas, las dos cerradas.** (1) `resolveFaces` de identity ahora incrusta también la familia del
nombre del membrete —cualquier rol que de verdad use el papel—. (2) Las `@font-face` van con
`font-display: swap`: el navegador (y Chromium) pintan el texto con el respaldo y lo cambian al cargar,
así que **imprimir en ese hueco** sacaba el papel con la letra equivocada. Ahora se espera a
`document.fonts.ready` antes de `window.print()` (SPA) y antes de `page.pdf()` (récipe, factura y
reporte), y la SPA **precarga** las familias de la marca al aplicar el tema.

| Pieza | Qué hace |
| :--- | :--- |
| `brand-service.ts` (identity) | `pilasDeLaMarca`: incrusta el `@font-face` de la familia del **nombre del membrete**, no solo la de títulos y cuerpo |
| `pdf-renderer.ts` (clinical, billing, reporting) | Espera a `document.fonts.ready` antes de `page.pdf()` |
| `impresion.ts` (SPA) | `esperarFuentes()` y `precargarFuentes()`: el papel y la vista previa esperan a la tipografía |
| `MedicalRecordPrintPage`, `OdontogramPrintPage`, `ReportExportBar` | Esperan a las fuentes antes de `window.print()` |
| `SettingsProvider.tsx` | Precarga las familias de la marca al aplicar el tema |

## [Configuración] — El membrete se configura aparte y se aplica en caliente · 2026-10-10

El membrete de los imprimibles deja de estar cosido al código y gana su **subsección** en
`/configuracion`: alto y posición del logo, tipografía propia del nombre, qué líneas salen y en qué
orden, un pie y el velo, con **vista previa en vivo**. Y un cambio llega al papel en segundos, **sin
reiniciar** ([ADR 0064](docs/adr/0064-membrete-configurable-y-aplicado-en-caliente.md)).

**El bug que lo abrió.** El récipe fijaba `.logo { height: 12mm }` a mano y **no** seguía
`--brand-logo-height-mm`: el alto de logo del panel no tenía ningún efecto sobre él. Ahora las
**seis** plantillas —récipe, dossier, reporte, factura, recibo y nota de crédito— y el membrete de la
**SPA** salen del **mismo** helper, así que no puede volver a haber una copia desviada.

**El logo va a la izquierda y centrado en vertical** respecto al bloque de datos, con el alto de la
marca; el **nombre** tiene su tipografía propia (familia, peso y tamaño) y las **líneas** su tamaño.
Se puede elegir qué líneas se imprimen (dirección, RIF, teléfonos/correo, web, especialista) y
**reordenarlas**. Los **datos** siguen en Mi perfil: aquí solo se decide cómo se pintan.

**Aplicar en caliente.** La marca se lee con una caché de **1 s** (`createBrandLookup`) y el membrete
—que lleva el logo y los datos— de **5 s** en clinical, reporting y billing: guardar en el panel se
ve en el papel en segundos, sin reiniciar. El resto de servicios (pantallas, agenda, bot) conservan el
minuto: no componen papel.

| Pieza | Qué hace |
| :--- | :--- |
| `letterhead.ts` (nuevo, contracts) | `buildLetterheadView` + `letterheadHtml`: compone el bloque (nombre, subtítulo, líneas en orden y sin las vacías, pie) y escapa el texto |
| `brand.ts` | `BrandLetterhead` con alineación, tipografía propia, líneas y pie; `letterheadCss()` con las clases `.brand-lh*`; variables 25 → **31** |
| `domain/settings.ts` | `brandLetterheadSchema` ampliado (sin migración: `letterhead` es JSONB) y `DEFAULT_LETTERHEAD_LINES` |
| `prescription-document.ts` | **Quita `.logo { height: 12mm }`**; el récipe sigue la marca |
| `dossier-document.ts`, `report-html.ts`, `invoice-pdf.ts`, `receipt-pdf.ts`, `credit-note-pdf.ts` | Adoptan el helper compartido |
| `MembreteSection.tsx` (nuevo) | Subsección con logo, tipografía, líneas ordenables, pie, velo y **vista previa en vivo** |
| `MarcaSection.tsx` | Deja de duplicar `RolTipografico` (a su propio archivo) y cede «Medidas» al membrete |
| `MembreteDocumento.tsx` | El membrete de la SPA sale de `useSettings()` y de las clases `.brand-lh` |
| `brand-lookup.ts` / servicios | Caché de la marca 60 s → **1 s**; el membrete a 5 s en los tres servicios de documentos |

## [Configuración] — Las fuentes de los imprimibles se eligen por rol · 2026-10-10

La marca de los imprimibles pasa de **una sola familia** a un **catálogo de familias**, y el panel
`/configuracion` deja de pedir la pila CSS a mano: se elige **familia y peso** de los títulos y del
cuerpo en un desplegable, **con vista previa** ([ADR 0063](docs/adr/0063-seleccion-de-fuentes-por-rol.md)).

**Catálogo.** Tres sans (Montserrat, Inter, Poppins) y tres script (Lobster, Pacifico, Dancing
Script), todas OFL, auto-hospedadas en `assets/clinic/fonts/` (convención
`<familia>-latin-<peso>-normal.woff2`). Además se pueden **subir** familias nuevas desde el panel
indicando su **familia, peso y estilo**.

**Selección por rol.** Título y cuerpo tienen su propio desplegable de familia y de peso, con una
línea de **vista previa** que se dibuja al instante; un bloque **avanzado** permite editar la pila
CSS. El **peso** de los títulos deja de estar fijo en 700 y pasa a ser de la marca
(`--brand-font-doc-title-weight` / `--brand-font-doc-body-weight`).

| Pieza | Qué hace |
| :--- | :--- |
| `brand.ts` | `BrandFonts` pasa a `families[]`; `documentTitleWeight`/`documentBodyWeight`; catálogo y `fontStackFor`; 25 variables `--brand-*` |
| `domain/settings.ts` | `brandFontFamilySchema`; `brandFontsSchema.families`; pesos en la tipografía |
| `brand-service.ts` | Normaliza `{ family, files }` → `families`; resuelve **solo las familias referenciadas**; `addBrandFont` con familia |
| `settings-routes.ts` | La subida multipart acepta el campo `family` |
| Migración `0006` (identity) | Envuelve las marcas antiguas en `families` (solo datos) |
| `MarcaSection.tsx` | Desplegables de familia/peso por rol, vista previa, pila avanzada y subida por familia |
| `report-html.ts` + 5 documentos | Los títulos usan la variable de peso en vez de `font-weight: 700` fijo |

## [Odontograma] — La exodoncia realizada y las prótesis removibles · 2026-10-10

Dos estados clínicos que faltaban, anexos al [ADR 0062](docs/adr/0062-exodoncia-y-protesis-removibles.md).

**Exodoncia realizada (`extraida`).** Hasta ahora, cumplir una extracción indicada dejaba la pieza
`ausente` —el mismo estado que la agenesia—, así que se perdía **cómo** se había perdido el diente.
Se añade la condición `extraida` (hecho consumado, aspa **azul sólida**, coherente con rojo =
pendiente / azul = hecho): supera y excluye las caras, no convive con `ausente`, `extraccion_indicada`,
`corona` ni `endodoncia`, y **sí** con `implante`. La transición `extraer` pasa a producir `extraida`
y `rehabilitar` admite como origen `ausente` o `extraida`.

**Prótesis removibles (PPR/PRT).** Las prótesis no viven en una pieza: se registran como entidad de
**tramo** (PPR, elegida con **dos toques** en el gráfico) o de **arcada completa** (PRT, una por
arcada). Se dibujan como doble línea con retenedores en una franja bajo las piezas, con la misma
geometría en pantalla, papel y dossier.

**Terminología.** `restauracion` se muestra como **restauración** (antes «obturación») en todo el
esquema del odontograma.

| Pieza | Qué hace |
| :--- | :--- |
| `odontogram.ts` | `extraida` en condiciones, reglas, símbolo, capas y transiciones; `extraida` en el reporte de salud bucal |
| `prosthesis.ts` (nuevo) | Tipos, Zod, `prosthesisTrack` y `archRange` de PPR/PRT |
| Migración `0003` (odontograma) | `extraida` en los CHECK + tablas `prostheses` y `prosthesis_history` |
| `chart-service.ts` + rutas | `recordProsthesis`/`removeProsthesis`; `extraer`→`extraida`; eventos y auditoría |
| Web | Barra de prótesis, `ProsthesisDialog`, `ProsthesisOverlay`, `extraida` en la leyenda; leyenda/tabla del imprimible |
| Migración `0006` (reporting) | `extraida` en `mv_oral_health` y el reporte de salud bucal |
| `dossier-odontogram.ts` | Doble línea de la prótesis y `extraida` en el SVG del expediente |

## [Imprimibles] — El récipe en dos mitades y el especialista en el membrete · 2026-10-10

Dos mejoras que tocan **todos** los imprimibles ([ADR 0061](docs/adr/0061-recipe-en-dos-mitades-y-especialista-en-el-membrete.md)).

**El récipe cambia de forma.** Pasa de un A5 de una cara a una **hoja carta apaisada partida en dos
mitades verticales**, separadas por una línea discontinua para cortar o doblar:

- **izquierda — copia de la farmacia:** por medicamento, **Medicamento** (negrita y subrayado),
  **Presentación**, **Vía** y **Dosis**, más el paciente, el número y la fecha del récipe y el código
  de verificación como texto (sin QR);
- **derecha — copia del paciente:** el layout de siempre (tabla, indicaciones generales) con el QR.

Las dos mitades llevan **membrete y firma propios**. La interfaz **no se toca**: los mismos datos que
ya se llenan alimentan las dos caras.

**El especialista va al membrete.** Los datos del odontólogo que responde (Odontólogo ·
Especialidad · MPPS · Colegiatura) salen ahora **debajo de la dirección y el teléfono**, no bajo la
firma. Se imprimen solo los campos llenos, con el ayudante `clinicDentistLine()`. Bajo la línea de
firma queda **solo el nombre**. Se aplica a los siete imprimibles: récipe y dossier (clinical),
reporte (reporting), factura, recibo y nota de crédito (billing), e historia clínica y odontograma
(navegador). Los récipes **ya emitidos** conservan su A5 archivado; el layout nuevo aplica a los que
se emitan desde ahora.

| Pieza | Qué hace |
| :--- | :--- |
| `clinicDentistLine()` (`packages/contracts`) | Une nombre · especialidad · MPPS · colegiatura, solo lo lleno |
| `prescription-document.ts` | Hoja apaisada en dos mitades, QR solo a la derecha |
| `pdf-renderer.ts` | `format: 'Letter'` + `landscape: true` para el récipe |
| `MembreteDocumento.tsx` | La línea del especialista en la historia clínica y el odontograma |
| `report-html.ts`, `invoice-pdf.ts`, `receipt-pdf.ts`, `credit-note-pdf.ts` | La línea del especialista en el membrete |

## [Configuración] — Panel de administración de la aplicación · 2026-10-09

Poner el sistema con otro consultorio tenía una cola de ajustes que **solo se cambiaban por código o
por `.env`**: la marca de los imprimibles (`brand.ts`), el acento de la interfaz (`tokens.css`), los
textos de las pantallas (`i18n.ts`), los tokens de Telegram/WhatsApp (el `.env` de notificaciones) y
el catálogo de sillones (sin interfaz). Nace `/configuracion`, un panel **solo del admin** (permiso
nuevo `settings:manage`) que lo reúne y lo aplica **en caliente**
([ADR 0060](docs/adr/0060-configuracion-de-la-aplicacion.md)).

**Dónde vive.** Tres tablas singleton en identity (`brand_settings`, `app_settings`,
`channel_settings`), vacías de arranque: mientras no haya fila, manda el respaldo del código. La
**paleta de los imprimibles se edita en hex libre**; el **acento de la interfaz** son **diez presets
del espectro** (los colores clínicos del odontograma no se tocan); los **textos del kiosko** son un
conjunto curado; y las **credenciales de canal se guardan cifradas** (AES-256-GCM con la clave del
almacén) y **nunca vuelven** por el API (solo `configurado` y una pista).

**Cómo se aplica.** Los servicios de documentos **ya no importan `BRAND`**: leen la marca efectiva por
la ruta interna (`createBrandLookup`, con caché y respaldo a `BRAND`) y las `@font-face` viajan ya
resueltas con los `.woff2` incrustados, así el PDF del servidor y lo que imprime el navegador usan los
mismos archivos. Notificaciones lee las credenciales por su ruta interna y **reconstruye los
adaptadores** cuando cambian, sin reiniciar.

**La política de cancelación** se muda de `/notificaciones` a `/configuracion` y pasa a ser **solo del
admin**: el odontólogo pierde `scheduling:cancel_policy` (el titular la conserva por su rol `admin`).

| Pieza | Qué hace |
| :--- | :--- |
| `settings:manage` (solo `admin`) + `/configuracion` | El panel; la API lo vuelve a comprobar |
| `brand_settings` + `PUT /api/v1/settings/brand` | Paleta (13 hex), tipografías, medidas y fuentes |
| `POST/DELETE /api/v1/settings/brand/fonts` | Subida y borrado de `.woff2` en el almacén |
| `app_settings` + `PUT /api/v1/settings/app` | Acento (10 presets) y textos del kiosko |
| `channel_settings` + `PUT /api/v1/settings/channels` | Tokens cifrados; vista enmascarada y prueba de canal |
| `createBrandLookup` + `/internal/v1/identity/brand` | La marca efectiva que leen clinical, reporting y billing |
| `/internal/v1/identity/channels` | Las credenciales en claro, solo por la red interna |
| `SettingsProvider` (SPA) | Inyecta `--brand-*` y `--color-*` en `<html>` al arrancar |
| `tools/e2e-config.mjs` (`npm run e2e:config`) | Prueba de extremo a extremo del panel con la pila real |

## [Agenda] — Varios consultorios y varios odontólogos (multisillón) · 2026-10-09

El sistema nació para **un odontólogo y un sillón** ([ADR 0006](docs/adr/0006-un-odontologo-un-sillon.md)),
con `dentist_id`/`chair_id` en la cita «para no migrar después». La clínica tiene **varios
consultorios y varios odontólogos**, así que ese «después» llegó: ahora el **sillón es el recurso
que ocupa una franja** y el odontólogo un **atributo opcional** ([ADR 0059](docs/adr/0059-el-sillon-es-el-recurso-de-la-agenda.md)).

**El núcleo.** Nace el catálogo `chairs` (servicio de agenda, dueño del solapamiento). El índice
único pasa a `(fecha, hora, consultorio)`: **dos citas pueden coincidir en hora si son en salas
distintas**, nunca en la misma. El cupo (`day_capacities`) y las plantillas (`slot_templates`) son
**por consultorio** (una plantilla sin sillón es la común). La migración **sembró «Consultorio 1» y
reasignó todo el histórico** antes de poner los `NOT NULL`.

**Las pantallas.** El bloque `appointment` de los eventos lleva el consultorio y el odontólogo con
sus **nombres** ([ADR 0041](docs/adr/0041-el-evento-lleva-lo-que-el-consumidor-necesita.md)), así que
la sala y los reportes no leen bases ajenas. La **pantalla del consultorio es una sola TV compartida**
con **un tile por sillón** (paciente o «libre»), y el displaylobby dice a qué consultorio pasar. La
agenda sirve el catálogo por una ruta interna.

**La interfaz.** La jornada se ve **por consultorio** (selector + rejilla del sillón elegido); al
asignar se elige **consultorio** (obligatorio) y **odontólogo** (opcional). El catálogo de
consultorios se administra en `/programacion` con el permiso nuevo **`scheduling:manage`** (admin).

**Reportes.** Dos nuevos, operativos: **ocupación por consultorio** y **productividad por
odontólogo**.

| Pieza | Qué hace |
| :--- | :--- |
| `chairs` + `appointments.chair_id` obligatorio | El sillón es la clave del recurso; un consultorio se **desactiva**, no se borra |
| `uq_appointments_slot` por consultorio | Dos salas en paralelo; misma sala a la misma hora sigue bloqueada (409) |
| Cupo y plantillas por sillón | `day_capacities (date, chair_id)` y `slot_templates.chair_id` (nullable = común) |
| `ChairDayView` / `DayView.chairs[]` | La jornada se reparte por consultorio, con el agregado del día |
| Evento `appointment` con `chairLabel`/`dentistName` | Las pantallas y los reportes rotulan sin consultar a nadie |
| Pantalla de consultorio multi-tile | Una TV compartida, un tile por sillón, en el orden del catálogo |
| `scheduling:manage` + diálogo de consultorios | Alta y edición del catálogo, solo `admin` |
| Rutas internas `/internal/v1/agenda/chairs` y `/internal/v1/identity/dentists` | Catálogos para la TV y para el selector de odontólogo |
| Reportes `chair-occupancy` y `dentist-productivity` | Ocupación por sala y citas/atendidas por doctor |

## [Limpieza] — Sin datos personales en el código y la identidad solo desde el registro · 2026-10-09

El repositorio ya no lleva los datos de un consultorio concreto. La identidad —nombre, dirección,
RIF, teléfonos, logo y odontólogos que firman— se sirve **solo** desde el registro que completa el
**titular** en su primer acceso ([ADR 0056](docs/adr/0056-la-identidad-del-consultorio-vive-en-la-base.md)),
y el respaldo del código queda **neutro** ([ADR 0058](docs/adr/0058-sin-datos-personales-en-el-codigo.md)).

- **Se quitaron los datos personales** de `packages/contracts/src/clinic.ts`, `.env.example`,
  semillas, pruebas, guiones de instalación y documentación (incluido el histórico). El bot de
  Telegram ya aparece con nombre y `@usuario` genéricos.
- **Se eliminaron los overrides `CLINIC_NAME` / `CLINIC_ADDRESS` / `CLINIC_EMAIL`** del entorno: hay
  una sola fuente, el registro del titular.
- **Si el consultorio aún no está configurado, no se inventa identidad**: el `.ics` y los avisos de
  cita **se difieren** (quedan en la cola con el motivo «consultorio sin configurar», sin gastar
  intentos) y el texto se **re-renderiza al enviar**, así que sale correcto en cuanto el titular
  completa los datos.
- **Cuentas seed genéricas**: el servidor sigue creando **solo `admin`**; en desarrollo, `recepcion`
  pasa a «Recepción prueba» y el odontólogo a «Odontólogo prueba» (usuario `prueba`,
  `SEED_PASSWORD_PRUEBA`). Los datos de pacientes de prueba también se unificaron a una lista neutra.

## [Cancelación] — El paciente cancela con plazo y el inicio cuenta las novedades · 2026-10-09

Tres arreglos que salieron de usar el bot con pacientes de verdad.

**Uno: la tabla de canales no decía quién era el paciente.** Al vincular un chat salía el usuario de
Telegram y la dirección, pero «Paciente» quedaba en «Sin dato»: la ruta de canales **fijaba
`patientName: null`**. Ahora el servicio de notificaciones **compone** la tabla —como ya hacía con las
citas— y resuelve los nombres en un solo lote contra una ruta interna nueva de pacientes
(`GET /internal/v1/patients/summaries`). De paso arregla lo que ya estaba vinculado: no depende de
guardar nada al vincular.

**Dos: `notification_settings`, el corte de cancelación.** Quien **ya confirmó** su cita no debería
poder soltarla por chat la víspera. La clínica fija cuántos días de antelación hacen falta para
cancelar una cita confirmada (0 = sin corte, valor por defecto); las citas **sin confirmar** se
cancelan siempre, y la secretaría sigue cancelando sin límite desde el mostrador. La configuración la
ven y la editan **solo el admin y el odontólogo**, con el permiso nuevo `scheduling:cancel_policy`.

**Tres: novedades en el inicio.** `GET /api/v1/appointments/activity` clasifica lo que hizo el
paciente —«dio cita y confirmó», «dio cita y canceló», «confirmó y luego se arrepintió»— a partir de
`status_history` y la fecha de confirmación, y lo pinta una tarjeta en `/inicio` que muestra 5 de las
últimas 20.

| Pieza | Qué hace |
| :--- | :--- |
| `channelsInInbox` (`services/notifications`) | Compone los canales vinculados y les pone el nombre del paciente |
| `GET /internal/v1/patients/summaries` | Resúmenes de pacientes por id en lote, para otros servicios |
| `notification_settings` + migración `0006` | El corte configurable (`patient_cancel_cutoff_days`, 0–30) |
| Permiso `scheduling:cancel_policy` | Solo `admin` y odontólogo ven y editan la política |
| Plantilla `cita_cancelacion_fuera_de_plazo` | La respuesta al paciente que ya no puede cancelar por chat |
| `GET/PATCH /api/v1/notifications/settings` y `CancellationPolicyCard` | Leer y guardar el corte |
| `listAppointmentActivity` + `GET /api/v1/appointments/activity` y `HomeActivityCard` | Las novedades de citas del inicio |

Detalle y porqués: [ADR 0057](docs/adr/0057-cancelacion-con-plazo-canales-y-novedades.md).

## [Interfaz] — La dentición temporal a la vista y la jornada, en pestañas · 2026-10-09

Dos mejoras de pantalla que comparten lo mismo: la interfaz enseñaba de golpe lo que se
consulta por partes.

**Uno: el odontograma no dejaba registrar la boca mixta.** El gráfico dibuja las piezas de
leche (51–85) solo cuando la dentición es `mixta`, y la dentición se **deriva de los
hallazgos** ([ADR 0051](docs/adr/0051-denticion-mixta-en-el-odontograma.md)): para que la
boca fuera mixta había que haber marcado ya una pieza temporal, que es justo lo que no se
podía hacer sin verla. La casilla **«Activar dentición temporal»** rompe el círculo —fuerza
la dentición `mixta` en el gráfico— y arranca marcada sola si la boca ya lo es. No se
persiste, y la ve también la secretaría, porque consultar la boca mixta es leer. En el
**papel**, la banda temporal solo se imprime si hay algún hallazgo en piezas de leche, en el
odontograma del navegador **y** en el dossier del expediente (`hasPrimaryFindings`, del
contrato): una banda vacía se leería como una captura a medias.

**Dos: `/programacion` apilaba cinco cuadros en una columna.** Ahora sus secciones van en
**pestañas** —Jornada (cupo + franjas), Citas y Cancelaciones— con la cola de solicitudes
fija a la izquierda, y la barra superior de `/flujo` baja de cuatro pisos a dos (los atajos
entran en el recuadro del paciente). El patrón de pestañas vive en un `PanelTabs` genérico
con el ARIA completo.

De paso, dos arreglos que destapó la prueba de extremo a extremo: la **identidad del
consultorio** se pedía **sin sesión** (su proveedor estaba montado fuera de `AuthProvider`)
y ensuciaba el arranque con un 401 —ahora se pide con sesión—, y **`/secretaria`** repetía
«Secretaría del día» en dos encabezados, que el lector de pantalla anuncia por duplicado.

| Pieza | Qué hace |
| :--- | :--- |
| `hasPrimaryFindings` (`packages/contracts`) | ¿Hay algún hallazgo en una pieza de leche? Lo deciden igual el papel del navegador y el dossier |
| Casilla «Activar dentición temporal» (`OdontogramPanel`) | Fuerza la dentición `mixta` en el gráfico; no se persiste |
| `PanelTabs` (`apps/web/src/components`) | Pestañas accesibles (`tablist`/`tab`, roving tabindex, flechas/Inicio/Fin) |
| Pestañas de `/programacion` | Jornada · Citas · Cancelaciones; la cola, fija a la izquierda |
| Barra de `/flujo` | Dos bloques: día y paciente (con los atajos dentro) |
| `lib/queryKeys.ts` | La clave de la identidad, en un módulo hoja para no crear un ciclo de imports |

## [Identidad] — Dos tipografías en los imprimibles y la identidad del consultorio en la base · 2026-10-08

Dos cambios que van juntos porque se tocó el mismo camino (el membrete de todos los imprimibles).

**Uno: el papel tenía una sola tipografía.** `brand.ts` declaraba `documentSans` y `brandStyles()`
la aplicaba al `body`, así que el nombre del consultorio, «RÉCIPE», los encabezados de tabla y el
texto corrido salían con la misma fuente —y **la del equipo**: Chromium compone los PDF y el
navegador imprime la historia clínica y el odontograma, de modo que el mismo documento podía salir
con dos tipografías según lo que hubiera instalado. Ahora hay **dos pilas**
(`documentTitleSans` y `documentBodySans` → `--brand-font-doc-title` y `--brand-font-doc-body`), la
clase `.brand-title` para los títulos, y las fuentes **auto-hospedadas** en
`assets/clinic/fonts/` (Montserrat, subconjunto `latin`, con su licencia OFL) que el servidor
incrusta en el PDF como `@font-face` con `data:` URI y la SPA carga al arrancar. El papel ya no
depende del equipo ([ADR 0055](docs/adr/0055-dos-tipografias-en-los-imprimibles.md)).

**Dos: los datos del consultorio vivían en el código.** Poner el sistema con otro odontólogo —o
corregir un RIF— exigía editar `clinic.ts`, recompilar y desplegar, y **nada quedaba trazado**.
Ahora la identidad vive en la **base de `identity`** (`clinic_profiles` y `dentist_profiles`), el
**titular** la completa en su **primer acceso** (con un gate bloqueante, igual que la contraseña
temporal: el JWT lleva `needsProfile`, deja sin permisos y el gateway corta todo salvo el
onboarding), y después se edita en **Mi perfil** (lo propio) y en **`/usuarios`** (el
administrador). El **logo** se sube (SVG) al **almacén compartido** y hace también de **marca de
agua**. `clinic.ts` queda como **semilla y respaldo** ([ADR 0056](docs/adr/0056-la-identidad-del-consultorio-vive-en-la-base.md)).

| Pieza | Qué hace |
| :--- | :--- |
| `BRAND.typography.documentTitleSans` · `documentBodySans` | Las dos tipografías de los documentos; `--brand-font-doc-title` / `-body` y la clase `.brand-title` |
| `BRAND.fonts` · `assets/clinic/fonts/` | Las fuentes auto-hospedadas (Montserrat 400/700 + OFL): **el mismo archivo** para el PDF del servidor y para la SPA |
| `brandFontFaceCss()` (`packages/kernel`) | Incrusta los `.woff2` como `@font-face` con `data:` URI: el papel se explica solo |
| `apps/web/src/lib/fuentes.ts` | Declara las fuentes en la SPA (`import.meta.glob`), para la historia clínica y el odontograma |
| **Tablas** `clinic_profiles` y `dentist_profiles` | La identidad del consultorio y el perfil profesional de cada odontólogo (migración `0004_identidad_del_consultorio`) |
| **Asistente del primer acceso** (`/completar-perfil`) | El titular completa el consultorio **y** lo suyo; los demás odontólogos, solo lo suyo |
| `needsProfile` en el JWT y en el gateway | El gate **no** es de la interfaz: sin perfil no hay permisos (espeja `mustChangePassword`) |
| **Rutas públicas** `/api/v1/identity/**` (por el gateway) | `GET /clinic` (identidad efectiva), `POST /onboarding` (primer acceso), `GET/PUT /users/me/dentist-profile`, `PUT /clinic` y `POST /clinic/logo` |
| `GET /internal/v1/identity/letterhead` | La lectura interna del membrete: identidad, **quién firma ya resuelto** y el logo incrustado. Se degrada a `CLINIC` |
| `createLetterheadLookup()` (`packages/kernel`) | Lectura con **caché (~60 s)** y **deduplicación en vuelo**; si `CLINIC_*` está en el entorno, ni se llama |
| **Mi perfil** y el perfil en «Editar usuario» | Cada odontólogo edita lo suyo; el administrador, a cualquiera. **Motivo obligatorio** y queda en auditoría |
| Acciones `dentist_profile_completed` · `dentist_profile_updated` · `clinic_profile_updated` · `clinic_logo_updated` | La identidad **auditada**: antes/después, campos, actor y motivo |
| **Logo** en el almacén compartido | Se sube desde la aplicación (SVG) y persiste igual en desarrollo y en producción |
| `brand.test.ts` | Comprueba las 23 variables de marca y que los `.woff2` declarados **existen** |

**Lo que sigue solo en el código**, a propósito: la **marca** (paleta, las dos tipografías, medidas
del membrete y del velo). Los datos los edita quien los conoce; la marca, quien despliega y la
revisa en el control de versiones.

### Añadido

- **[`docs/IDENTIDAD_Y_DATOS.md`](docs/IDENTIDAD_Y_DATOS.md)** reescrito para el modelo nuevo: las
  tres capas, el primer acceso, Mi perfil, el logo, las fuentes y las vías de producción.
- ADRs [0055](docs/adr/0055-dos-tipografias-en-los-imprimibles.md) y
  [0056](docs/adr/0056-la-identidad-del-consultorio-vive-en-la-base.md).
- `assets/clinic/fonts/` con Montserrat (woff2) y su licencia OFL.

### Cambiado

- `--brand-font-doc` se parte en `--brand-font-doc-title` y `--brand-font-doc-body`.
- La identidad del consultorio pasa de `clinic.ts` a la base de `identity`; `clinic.ts` queda como
  **semilla y respaldo** (mismo `ClinicIdentity`, mismas ayudas).
- `notifications`, `scheduling` y `screens` refrescan su `CLINIC_NAME` / `CLINIC_ADDRESS` /
  `CLINIC_EMAIL` con lo de la base; **`CLINIC_*` del entorno sigue mandando** si está puesto.

### Corregido

- El aviso **«Al membrete le falta información»** del editor del récipe leía el **respaldo del
  código** (`CLINIC`), así que seguía saliendo —RIF, teléfono, MPPS del odontólogo— aunque el
  titular ya hubiera completado la identidad en su primer acceso. Ahora la lista sale de la
  **identidad efectiva de la base** (`clinicIdentityFromView`), la misma que estampa el PDF, y solo
  cae a `CLINIC` mientras no haya perfil guardado.

## [Identidad] — El membrete, el logo y la marca de agua, en todos los imprimibles · 2026-10-08

La identidad del consultorio ya vivía en un solo sitio (`clinic.ts` para los datos, `brand.ts` para
la paleta y las tipografías), pero **no llegaba a todos los papeles**. Al recorrer los siete
imprimibles aparecieron los huecos: el **reporte A4** y los **documentos de cobro** salían sin logo;
la **historia clínica** y el **odontograma** que imprime el navegador no llevaban membrete ninguno;
y sus **colores de énfasis** —títulos, encabezados, líneas y tinta— eran grises, negros y `slate-*`
a mano, ajenos a la marca; y la **marca de agua** estaba declarada en `brand.ts` (con sus variables
en `marca.css`) pero **ningún documento la usaba**. Una decisión escrita y sin cablear.

El criterio es el del repositorio: **una identidad copiada en varios sitios acaba siendo varias
identidades**. Se cierra ahora, con los documentos todavía pocos ([ADR 0054](docs/adr/0054-membrete-unico-en-los-imprimibles.md)).

| Pieza | Qué hace |
| :--- | :--- |
| `brandWatermarkCss()` · `brandWatermarkHtml()` | La marca de agua, **cableada**: el logo centrado y translúcido detrás del contenido, repetido en cada hoja. Puro, en `brand.ts` |
| `readImageDataUri()` (`packages/kernel`) | El lector de imágenes compartido: lee el archivo y devuelve un `data:` URI (o `null` si falta). Un solo sitio para el récipe, el dossier, el reporte y los cobros |
| Logo en el **reporte A4** y en **factura, recibo y nota de crédito** | El membrete que ya tenían, ahora con el logo del consultorio (§9 de la factura con formas libres, reversible) |
| **Membrete** en la historia clínica y el odontograma impresos | Un componente de la SPA (`MembreteDocumento`) que lee `CLINIC` y pinta con los `--brand-*`: los mismos datos y colores que el récipe |
| **Marca de agua** en los imprimibles del navegador | `MarcaDeAgua`, visible **solo al imprimir** (`hidden print:block`): en pantalla el documento se lee limpio |
| Logo en la SPA con Vite | `import.meta.glob('assets/clinic/*', '?url')`: el mismo binario que el servidor incrusta en los PDF, sin duplicarlo ni mantener un `public/` |
| `render*Html` de reporte y cobros | Pasan a **`async`**: leen el archivo del logo al componer el papel |
| **Énfasis de marca en todos los imprimibles** | Títulos, encabezados de tabla, líneas, contornos y tinta pasan de colores sueltos a las variables `--brand-*`: los **cobros** (antes gris y negro), la **historia clínica** (antes `slate-*`) y el **odontograma** (antes tokens del tema y trazos fijos en el SVG). En SVG la marca entra por `style` (los atributos de presentación no resuelven `var()`) |

**Lo que NO sigue la paleta**, a propósito: el rojo `pendiente` y el azul `completado` del
odontograma (es un código clínico, `CLINICAL_STATE_COLORS`), la pantalla de carga de la SPA y el
fondo blanco al imprimir. El **énfasis** de los documentos sí sale de `brand.ts`; re-tematizar la
aplicación **no** obliga a «deshardcodear» nada más.

### Añadido

- **[`docs/IDENTIDAD_Y_DATOS.md`](docs/IDENTIDAD_Y_DATOS.md)**: la guía única de instalación y datos
  personales del consultorio —las tres capas (datos, marca impresa, tema de pantalla), el logo, las
  cuentas del personal, la sobrescritura por entorno y las **tres vías** de producción, con el aviso
  de que `odontocrm actualizar` hace `git` y puede pisar una edición hecha en el servidor—.
- **ADR 0054**: el membrete, el logo y la marca de agua son los mismos en todos los imprimibles.

### Corregido

- El **odontograma impreso** mostraba el nombre del consultorio pero ningún logo ni dirección: ahora
  lleva el membrete completo.
- Los **documentos de cobro** y los **imprimibles del navegador** ignoraban la paleta de la marca: su
  énfasis salía en gris y negro (`billing`) o en `slate-*` (historia clínica).
- El README daba por defecto `assets/clinic/logo.png`; el código usa `assets/clinic/logo.svg`.
- Un comentario corrupto en `OdontogramDocument.tsx` (`ull o vacío`) que debía decir `null` o vacío.

## [Cancelación] — El paciente puede cancelar su cita · 2026-10-08

El aviso ya se podía responder (confirmar), pero no **revocar**. Si el paciente no podía asistir,
el mensaje se quedaba en la bandeja y el mostrador lo atendía a mano. Y una cancelación no decía
**quién** la había pedido: la del paciente y la de la secretaría eran la misma fila.

| Pieza | Qué hace |
| :--- | :--- |
| Botón «Cancelar» en el aviso | El mensaje de la cita ofrece **confirmar o cancelar**: dos botones en el código (no en la plantilla) y el texto que invita a escribir «cancelar» (ADR 0053) |
| Intención `cancelar` | «Cancelar» (o `/cancelar`) cancela la **cita** asignada; sin cita, cae a anular la **solicitud**, como antes. Con `/cancelar #000123` se conserva el comportamiento de siempre |
| `cancelAppointment` | La hermana de `confirmAppointment`: actor de sistema **sin roles**, guardia propia de estado (`programada`/`notificada`/`confirmada`) e **idempotente** |
| `cancelled_at` · `cancelled_channel` | **Cuándo** y **por dónde** se canceló. Un canal de paciente distingue «la canceló el paciente» de «la canceló la secretaría» |
| `POST /internal/v1/appointments/:id/cancel` | El bot cancela por la ruta interna; el schema público sigue sin admitir `channel` (no se puede forjar) |
| `skipNotice` | La cancelación del bot **no** encola un `cita_cancelada` duplicado: el asistente ya responde él mismo. El bloque `notification` se conserva para pacientes, pantallas y reportes |
| Plantillas nuevas | `cita_cancelada_paciente` (la respuesta al paciente) y `cita_no_cancelable` (cuando ya no se puede) |
| Tarjeta «Canceladas por el paciente» | En `/programacion`: rango de fechas, paciente, ticket, la cita original, cuándo canceló y el canal. Solo las del **bot** (ADR 0053) |
| `GET /api/v1/appointments/cancellations` | Lo que sirve la tarjeta: filtra por la fecha de cancelación y solo devuelve las hechas por un canal de paciente |
| KPI del embudo | «Canceladas por el paciente» como **KPI card**, **columna** (y CSV) y **serie** propia. Sale de `mv_funnel.cancelled_by_patient` |

Cancelar **devuelve el ticket a la cola** ([ADR 0028](docs/adr/0028-cancelar-devuelve-el-ticket.md)):
la solicitud vuelve a `en_espera_cita`, así que el hueco no se pierde y al paciente se le puede
reasignar. Con un matiz defensivo: solo si la solicitud **no le queda otra cita en pie**, para no
sacar de la agenda la cita nueva de una reprogramación.

El silencio del aviso se resolvió con una **marca en el evento**, no borrando su bloque `notification`:
ese bloque lo leen también los servicios de pacientes y pantallas (y reportes saca de ahí al
paciente), así que quitarlo habría roto a tres consumidores. El flag `skipNotice` lo entiende solo el
consumidor de notificaciones. La cancelación de la secretaría, que no lleva la marca, manda su
`cita_cancelada` como siempre.

### Corregido

- **El botón «Confirmar» y el botón «Cancelar» daban error y no hacían nada.** El cliente interno
  del bot manda siempre el campo opcional —`note` al confirmar, `reason` al cancelar— con `null`
  cuando el paciente no escribe nada, pero los esquemas del contrato lo declaraban
  `z.string().optional()`, que en Zod 4 solo acepta `undefined`. La agenda respondía **400** y el
  asistente mostraba al paciente el aviso genérico de «servicio no disponible»: el botón parecía
  roto. Ahora los dos campos son `.nullish()` (`null | undefined`), que es como este código
  representa «sin dato» en todas partes.
  - Las pruebas de integración no lo vieron porque el doble del cliente (`fakeClients`) llama a la
    función del servicio directamente y **nunca cruza el contrato Zod**; el fallo vivía justo en el
    borde HTTP de la agenda (`POST /internal/v1/appointments/:id/confirm|cancel`). Se añade una
    prueba de contrato que fija que `null` se acepta.

## [Confirmación] — El aviso de la cita ahora se responde · 2026-10-07

El aviso existía desde la Fase 4, pero era de una sola dirección: el paciente sabía cuándo
venir y el consultorio no sabía si vendría. Peor: `notificada` se rotulaba «CONFIRMADA Y
AVISADA», y lo único que había pasado era que el mensaje salió. Y la «próxima cita» que el
odontólogo escribía al cerrar una sesión —lo más útil del cierre— **no llegaba a la agenda**:
quedaba como texto dentro del documento clínico, sin franja, sin aviso y sin confirmación.

| Pieza | Qué hace |
| :--- | :--- |
| Estado `confirmada` | Nuevo estado en `APPOINTMENT_STATUSES`, entre `notificada` y `en_sala_espera`: `notificada` pasa a ser «se le avisó» y `confirmada`, «respondió que sí» (ADR 0052) |
| Se confirma por el bot | Botón «Confirmar» en el aviso **y** la palabra («confirmo», «asistiré»…): intención y comando nuevos en el catálogo del bot |
| El aviso, en dos mensajes | El texto con el botón y después el `.ics` con un pie corto: el adaptador de Telegram descarta los botones cuando el mensaje lleva documento |
| `confirmed_at` · `confirmed_channel` | Cuándo y **por dónde** confirmó, más la fila en `status_history`: el hecho no se borra cuando la cita avanza |
| `POST /api/v1/appointments/:id/confirm` | La confirmación telefónica de la secretaría: mismo camino, actor con roles y, por tanto, máquina de estados |
| `POST /internal/v1/appointments/:id/confirm` | El bot confirma con un actor **sin roles**: es la única escritura de la agenda que no pide un usuario |
| Sección «Citas próximas» | En `/notificaciones`: rango de fechas, estado, confirmadas sí/no y búsqueda, con el canal (tlg/wa) y el último aviso de cada cita |
| `GET /api/v1/notifications/appointments` | Se compone en el servicio —agenda + canales + avisos— y no en la pantalla: serían tres consultas con tres paginaciones |
| «¿Agendo la próxima cita?» | El cuadro que convierte la nota de la sesión en una **cita real** con su fecha; si el doctor no quiere, la nota se queda como estaba |
| `proximaCitaAppointmentId` | El enlace a esa cita, dentro del borrador de la sesión (cerrar es inmutable) |
| Embudo y tablero | Etapa «confirmadas» en el reporte —columna, serie, CSV y KPI sobre las avisadas— y la cifra en el resumen de `/inicio` |

**Un estado nuevo toca dos sitios de la base, no uno.** El `CHECK` de `chk_appointments_status`
y el **índice único parcial** `uq_appointments_slot`, que es lo que impide citar a dos pacientes
a la misma hora: si el índice no incluyera `confirmada`, una cita confirmada dejaría de bloquear
su franja y el hueco se podría reasignar. La migración lo hace y una prueba de integración lo
comprueba confirmando una cita y volviendo a intentar ocupar la misma hora.

Confirmar **no** es requisito para llegar: `notificada → en_sala_espera` sigue permitido, porque
en un consultorio lo normal es que el paciente aparezca sin haber respondido; y desde
`programada` también se confirma, que es el caso «la llamé yo» de la secretaría. La confirmación
es **idempotente** —el paciente que pulsa dos veces no mueve la fecha ni ensucia el historial— y
el asistente comprueba que la cita sea **suya** antes de confirmarla, porque el identificador
viaja por el chat. Las solicitudes se quedan sin el estado nuevo (`REQUEST_STATUSES`): una
solicitud no tiene fecha, así que no hay nada que confirmar.

De paso, dos vistas materializadas de reportes se rehacen para aprender el estado nuevo, y
`reports/capacity.ts` lo cuenta como franja ocupada.

## [Recuperación] — El respaldo se prueba solo y los expedientes van cifrados · 2026-10-07

Dos huecos que solo se notan el día que se notan. Un respaldo que nunca se ha restaurado es una
carpeta con ficheros dentro, y nadie lo sabe hasta que hace falta de verdad. Y los expedientes
—radiografías, recetas, documentos— estaban en el disco **en claro**: si el equipo se roba o el
disco se extrae, las historias clínicas se van con él.

| Pieza | Qué hace |
| :--- | :--- |
| Cifrado en reposo | `packages/storage`: AES-256-GCM con formato propio y **versionado** (`ODBLOB` + versión + algoritmo + IV(12) + etiqueta(16) + cifrado), clave de `STORAGE_ENCRYPTION_KEY` |
| Lo que se guarda | El `sha256` **del texto en claro**, no del fichero cifrado: así el cifrado no cambia las comprobaciones de integridad ni la detección de duplicados |
| Compatibilidad hacia atrás | Al leer se descifra si el fichero lo está y se devuelve tal cual si no: lo ya guardado se sigue leyendo sin necesidad de la clave |
| Los servicios sirven **contenido** | `file-service` y `attachment-service` devuelven `Buffer` en vez de una ruta: el cifrado no puede depender de que el disco sea legible |
| `npm run recifrar:almacen` | Pasa a cifrado lo que quedó en claro. Idempotente; `--estado` para mirar y `--todos` para re-cifrar **todo** (al cambiar la clave); escribe a un temporal y renombra, y comprueba el `sha256` después |
| `npm run verify:backup` | El simulacro: restaura el último respaldo en bases **temporales** (`odonto_verify_*`), cuenta las tablas de control y las destruye siempre —también cuando algo falla—. Detecta un `.dump` truncado o con un bit cambiado |
| Temporizador semanal | Domingos 04:30. Si el simulacro falla, el aviso de emergencia sale por el bot de administración |
| Verificación de la instalación | Paso nuevo: la clave de cifrado, que no queden ficheros en claro y que **un respaldo se restaure de verdad** |

De paso salió un fallo real de despliegue: al servicio de facturación le faltaba `STORAGE_DIR` en
`aprovisionar.mjs`, así que en una instalación limpia habría intentado escribir los PDF en
`/opt/odontocrm`, que es de solo lectura. La clave de cifrado se genera una sola vez y la
comparten los tres servicios: rotarla dejaría ilegibles los ficheros anteriores, y por eso
`--rotate` no la toca.

Merece la pena tener claro cómo se reparte el almacén, porque no es lo que parece: `STORAGE_DIR`
es una **raíz compartida** —`./storage/patients` de serie, `/var/lib/odontocrm/storage` en el
servidor— y cada servicio escribe en su subcarpeta, así que los archivos de los tres viven bajo
el mismo árbol. Las herramientas leen el entorno **como lo leen los servicios** (primero el
común, después el del servicio) y agrupan por carpeta; si no, con la raíz compartida se miraría
tres veces el mismo sitio y el recuento mentiría.

Comprobado contra PostgreSQL y disco reales: un respaldo de las nueve bases se restauró entero con
sus conteos de control; un `.dump` truncado y otro con un bit invertido se detectaron (código de
salida 1, por `sha256` y por error de `pg_restore`); los 23 ficheros de `storage/clinical` se
cifraron, se leyeron idénticos, resultaron ilegibles sin la clave y volvieron byte a byte tras el
simulacro.

Y con el cifrado **encendido**, de punta a punta: una copia del almacén real (56 ficheros) se cifró
—todos, incluido el que subió el servicio durante la prueba—, se descargó idéntica por el gateway y
no se pudo leer ni sin la clave ni con otra. Eso destapó una consecuencia que no era obvia: el humo
de facturación encuentra el PDF archivado **hasheando el archivo del disco**, y la huella que guarda
la base es la del texto en claro, así que con el cifrado no lo habría encontrado nunca. Ahora
descifra antes de comparar; sin la clave lo dice en vez de dar por perdido un documento que está.

## [Observabilidad] — Un evento perdido ya no se pierde en silencio · 2026-10-07

Tres huecos del mismo tipo: cosas que el sistema sabía y nadie podía ver. El `/ready` de cada
servicio decía «ok» sin decir cuánto se estaba apretando la base; un evento que agotaba sus
reintentos se quedaba en el buzón de `pg-boss` y solo se notaba echando de menos un dato; y el
aviso de un fallo vivía en un registro que nadie lee a las tres de la mañana.

| Pieza | Qué hace |
| :--- | :--- |
| `HealthCheckResult.details` | Los chequeos publican **cifras**: conexiones del pool (libres, en uso, en espera), eventos sin publicar del outbox y su antigüedad |
| `createPoolCheck` · `createOutboxCheck` | Las dos comprobaciones, en `packages/db`, para los nueve servicios |
| `GET /api/v1/system/health/detailed` | El gateway pregunta a los nueve servicios **a la vez** y junta sus informes con su latencia. Solo el administrador |
| Panel en `/inicio` | Servicio a servicio: si responde, cuánto tarda, la versión, las cifras del pool y el outbox |
| Cola de descarte | Un evento que agota sus reintentos se copia a `dead-letter.domain-events` (nombre que **no** empieza por `domain-events.`: el publicador manda una copia a toda cola con ese prefijo) |
| `events.dead_letter_events` | El registro duradero: sobre completo, motivo del fallo, cola de origen y reintentos. Idempotente por id de trabajo |
| El vigilante | Corre en los seis consumidores; `pg-boss` da cada trabajo a **uno**, así que se apunta y se avisa **una vez** |
| `POST /internal/v1/notifications/admin-alert` | Por donde avisa cualquier servicio: solo notificaciones tiene el token del bot |
| Bot de administración | Bot de Telegram **aparte** del de los pacientes: los avisos de infraestructura no son para las familias |
| `--alertas` avisa | El tablero manda el aviso por Telegram cuando hay problemas (el temporizador no se queda en el registro) |

**Un servicio caído no tumba el informe consolidado**: se marca como inalcanzable con su motivo
(`ECONNREFUSED`, timeout), porque lo que se quiere saber es cuál falla. Y un servicio con el
outbox atrasado no es «error», pero sí cuenta aparte: responde y aun así no está haciendo su
trabajo.

En el tablero entran los **eventos perdidos** con su ventana (cuántos en 24 h y cuándo fue el
último) y los trabajos que están en el buzón **sin recoger** —eso último delata que ningún
consumidor los está apuntando—. La regla alerta por ventana y no por total: el registro es
histórico y alertar por él sería alertar para siempre por algo ya arreglado.

Los instaladores piden el bot de administración y **detectan el chat solos** (se le pide al
administrador que le escriba `/start` y se lee su `chat.id` de las actualizaciones), que es lo
que evita pedir un número que nadie sabe de memoria. Sus dos claves son opcionales: sin ellas
los avisos se quedan en el registro y todo lo demás funciona igual.

Comprobado contra PostgreSQL y pg-boss reales: un evento con `retryLimit: 0` cuyo consumidor
revienta acaba apuntado con su motivo y dispara el aviso, y apuntarlo dos veces no duplica la
fila. El `/ready` de screens trae las cifras de verdad, y el panel del gateway responde 403 a
la secretaría.

## [Tiempo real] — Recepción y caja se enteran solas de lo que pasa · 2026-10-07

Las pantallas de sala ya se actualizaban por SSE, pero el **personal** no: cuando el odontólogo
cerraba una sesión, la fila de `/flujo` seguía diciendo lo de antes y el cobro no aparecía en
`/caja` hasta que alguien recargaba la página o cerraba un diálogo. Entra el canal del personal.

| Pieza | Qué hace |
| :--- | :--- |
| `StaffSignal` (contrato) | El aviso: **tema** del evento, hora y agregado. Sin datos de pacientes |
| `broadcast.ts` | El reparto pasa a ser por **canales** (`lobby`, `consultorio`, `staff`); el canal es el nombre del evento |
| `staff-signal.ts` | Traduce el lote de eventos en avisos: **por tema, no por evento**, y en orden de hora |
| `GET /api/v1/screens/staff/stream` | El flujo del personal. Guardia por **rol** (`admin`/`secretario`/`odontologo`), no por `screens:display` |
| `RealtimeSyncProvider` | Abre el canal con sesión y traduce cada aviso en invalidar lo que quedó viejo |
| `lib/sse.ts` | El lector de tramas, uno solo: lo comparten el kiosko y el canal del personal |

La pantalla kiosko y el personal reciben cosas distintas a propósito: la primera el **estado
completo** de la sala (solo lo pinta) y el segundo **avisos** de qué cambió (ya tiene los datos y
solo necesita saber que se quedaron viejos). Cerrar una sesión invalida la historia, el odontograma,
la jornada y la caja; emitir una factura, solo la caja. El mapa de invalidación va por **dominio**
—el tema es `<dominio>.<entidad>.<acción>`—, así que un evento nuevo de un dominio conocido no exige
tocar la interfaz, y un tema desconocido no recarga nada.

Una pantalla kiosko que pida el canal recibe **403**: ya tiene el suyo. Comprobado contra PostgreSQL
real (11 de la suite de pantallas, incluido el aviso llegando al conectar y al cerrar una sesión) y
con la suite completa en verde (870 pruebas).

## [Expediente] — El dossier del paciente, en un solo PDF verificable · 2026-10-07

Hasta ahora, entregar el historial de un paciente era imprimir cada pieza por separado: la
ficha, el odontograma, cada sesión y cada récipe. `GET /api/v1/clinical/patients/:id/dossier`
compone un **PDF A4 foliado** con todo dentro, lo archiva con su huella y lo devuelve.

| Pieza | Qué hace |
| :--- | :--- |
| `dossier-service.ts` | Reúne filiación, alertas, sesiones cerradas, récipes y odontograma; compone, archiva y registra |
| `dossier-document.ts` | La plantilla A4 con el **mismo membrete y la misma marca** que el récipe y el reporte |
| `dossier-odontogram.ts` | El odontograma como **SVG plano**: la geometría sale del contrato, no se duplica |
| `dossier_exports` (migración 0003) | La exportación archivada: correlativo global, código, SHA-256 y hojas |
| `/verify-expediente/:code` | La página **pública** que abre el QR, sin datos clínicos (ADR 0015) |
| `/internal/v1/odontogram/patients/:id/chart` | La boca entera —dentición y hallazgos— para poder dibujarla |

El correlativo es **global** (`EXP-000001`), de la secuencia `dossier_exports_number_seq`: es un
libro de expedientes del consultorio, no una numeración por paciente ni por odontólogo. Exportar
un expediente no es un acto clínico, pero sí de **custodia** —sale del sistema el historial
completo de una persona—, así que cada exportación queda en la auditoría (`dossier_exported`) y se
puede volver a abrir tal cual salió: es el mismo archivo el que se verifica.

El odontograma del papel se dibuja con la geometría compartida (polígonos de caras, reparto de
cuadrantes, volteo y espejo) y las caras van teñidas por estado. Los símbolos de las condiciones de
pieza completa no se dibujan —viven en un componente de la interfaz—: en su lugar la pieza se tiñe y
la tabla de hallazgos que acompaña al dibujo nombra la condición, la cara y el estado pieza a pieza.
Así el papel dice lo mismo que la pantalla aunque lo diga de otra forma.

El renderizador de PDF del servicio acepta ahora A4, márgenes y pie de página, que es lo único que
numera el papel (Chromium no soporta `counter(page)` en los márgenes de `@page`); sin opciones sigue
componiendo el A5 del récipe exactamente como antes.

## [Marca] — La identidad del consultorio, en un solo sitio · 2026-10-07

La paleta y las tipografías de los documentos vivían **incrustadas** en cada plantilla: el récipe
tenía sus `#14504d` y `#4a5560`, y el reporte los suyos, casi iguales pero no del todo. Con la marca
en un solo archivo deja de haber dos verdades, que era el problema de fondo del plan de mejoras
(mientras el récipe y el reporte se editaran por separado, acabarían con colores distintos).

`packages/contracts/src/brand.ts` reúne la paleta, las tipografías (interfaz, reportes y récipes),
las medidas del membrete y las rutas del logo. Los **dos** consumidores no cargan el estilo igual
—la SPA importa un `.css` y las plantillas del servidor incrustan `brandStyles()` en el PDF—, así
que los valores viven en TypeScript y de ahí salen las dos formas:

| Pieza | Qué hace |
| :--- | :--- |
| `BRAND` | Paleta, tipografías y medidas; **sección editable**, como la del consultorio |
| `brandCssVariables()` · `brandRootBlock()` | Las variables `--brand-*`; las usa el generador y los documentos |
| `brandStyles()` | Bloque base de los documentos del servidor (`body` con la fuente y la tinta de la marca) |
| `logoMimeType()` | Tipo MIME del logo por su extensión, **SVG incluido** (antes solo PNG/JPG) |
| `npm run marca:css` | Genera `packages/ui/src/styles/marca.css` desde `brand.ts` (`--check` para comprobar) |
| `packages/ui/src/styles/marca.css` | ARCHIVO GENERADO; lo importa `apps/web/src/index.css` |
| La prueba de paridad | `packages/contracts/src/brand.test.ts` denuncia si el CSS se quedó atrás del código |

El récipe A5, el reporte A4, el papel del navegador (odontograma e historia clínica) y lo que venga
—el dossier de la Fase 5— imprimen con las **mismas** variables. El logo del consultorio pasa a
`assets/clinic/logo.svg` (vectorial, monocromo y con el relleno incrustado: el servidor lo mete en el
PDF como `data:` URI y ahí no hereda color de nadie) y el alto lo fija `--brand-logo-height-mm`.

**Cambiar un color** es editar `brand.ts` y ejecutar `npm run marca:css`: se mueve en pantalla y en
papel a la vez. Comprobado con la suite completa (833 pruebas) y a ojo sobre el récipe de verdad
—membrete con el logo, títulos en el verde de marca y el QR de verificación—.

## [Odontograma] — El paciente que está mudando: dentición mixta · 2026-10-07

El odontograma tenía **una sola dentición por paciente**, fijada con el primer hallazgo (el
servidor la deducía del número FDI y no volvía a tocarla) y dibujaba **una sola arcada** —32 piezas
en permanente, 20 en temporal—. Eso cubría una boca de una dentición, pero **no la dentición mixta**,
que es la normal de un niño de unos 6 a 12 años: los permanentes ya erupcionaron y quedan molares de
leche. Con los datos como estaban, un hallazgo en la dentición «contraria» **se guardaba y salía en la
tabla, pero no se dibujaba** —el diagrama y el informe decían cosas distintas—, y no había ningún
valor que dijera «esta boca tiene las dos». Entra por [ADR 0051](docs/adr/0051-denticion-mixta-en-el-odontograma.md).

| Pieza | Qué hace |
| :--- | :--- |
| `DENTITIONS` | Gana **`'mixta'`**: el odontograma puede declarar que tiene las dos denticiones |
| La dentición | Deja de ser un sello del primer hallazgo y pasa a **derivarse de los hallazgos vigentes**, recalculada en cada escritura: solo permanentes → `permanente`, solo temporales → `temporal`, de las dos → **`mixta`**. El día que erupciona un molar permanente (o que se corrige una captura) la boca cambia de dentición, y el gráfico sigue |
| `primarySuccessor` | La relación de recambio, en el contrato: `51 → 11`, `55 → 15`, `85 → 45` (la pieza permanente que sustituye a la temporal) |
| `archLayout('mixta')` | Dibuja la huella **permanente** y, aparte, las arcadas **primarias** (`upperPrimary`/`lowerPrimary`), cada pieza de leche **en la ranura de su sucesor**. Sin geometría nueva: la banda primaria reutiliza el mismo componente de arcada |
| Los dos renderizadores | Dibujan las bandas primarias cuando las hay (vacías en las denticiones simples), con su pie de arcada, en pantalla y en papel |
| `odontogramSummary` | `teeth` cuenta lo que se dibuja: **52** en mixta (32 + 20), no «una u otra» |
| El seed | Deriva la dentición de los hallazgos que escribe, en vez de por edad: así un mundo sembrado no dice «temporal» con una permanente dentro |

Migración `0001` de `odontogram`: el `CHECK` de `dentitions` admite `'mixta'` (no toca ninguna fila).
Comprobado con la base de verdad (**14/14** de la suite del odontograma, incluido el recálculo
`temporal → mixta → temporal` al borrar la pieza permanente) y a ojo en la vista de impresión: las
cuatro bandas —permanente y temporal de cada arcada— con la etiqueta «Dentición mixta» y cada pieza
de leche bajo su sucesor.

## [Corrección] — El rol del respaldo se quedaba sin permisos (lo cazó el examen) · 2026-10-06

Al reescribir las listas para que se derivaran del repositorio metí la pata en un consumo:
`bases_del_respaldo()` devuelve **una línea con las bases separadas por espacios** (que es el
formato de `DATABASES`), y en `crear-rol-respaldo.sh` la leí con `mapfile -t` → **un solo
elemento** con los diez nombres pegados. Consecuencia: el rol `odonto_backup` no recibía ni un
`GRANT`, y el respaldo fallaba **en las diez bases**:

```
✔ CONNECT y USAGE en todos los esquemas de las bases existentes (1 previstas)
pg_dump: error: FATAL: permiso denegado a la base de datos «odonto_identity»
```

El «1 previstas» era la pista. Ahora se parte con `read -r -a` (10 elementos), el **contrato de
cada lista está escrito en la librería** (una por línea para `servicios_del_repo` y
`puertos_internos`; una sola línea con espacios para `bases_del_respaldo`), el arnés prueba
también el consumo como array y `fedora:check` lo vigila (147 comprobaciones).

Lo bueno de la prueba de desinstalar-y-volver-a-instalar es justo esto: el fallo salió en la PC
de pruebas, con el respaldo delante, y no en la consulta un día que hiciera falta restaurar.

## [Instalador] — Una sola fuente de verdad para los servicios (y el respaldo que no llevaba las facturas) · 2026-10-06

La prueba de desinstalar-y-volver-a-instalar con `billing` destapó **el peor fallo posible en un
respaldo**: el registro decía `bases: 9` y `respaldo completado sin errores`… **sin
`odonto_billing`**. Las facturas no entraban en la copia diaria, y nada lo decía. La causa era
la de siempre: `30-desplegar.sh` escribía `backup.env` con **una cuarta lista de bases escrita a
mano**. Y esa lista ya había fallado antes en otros sitios (el despliegue no esperaba el puerto
de billing, una comprobación **de seguridad** no miraba si su puerto estaba publicado).

Así que en vez de arreglar la cuarta lista, se quitaron todas:

| Antes (a mano) | Ahora |
| :--- | :--- |
| `SERVICIOS=(…)` en `comun.sh`, en `odontocrm` y en el ensayo | `lib/servicios.sh` los **descubre** en el repositorio |
| Mapa `PUERTO_SERVICIO` / `PUERTOS` / `PUERTO_DE` en tres guiones | El puerto lo declara **cada servicio** en `.env.example` (`<X>_PORT`) |
| `DATABASES="odonto_…"` en la plantilla, el respaldo, la restauración y el rol | `bases_del_respaldo()`: una base por servicio + la cola |
| `ROLE_odonto_*` copiados en dos heredocs | Se generan recorriendo los servicios |
| Listas de servicios en `aprovisionar.mjs`, `infra/db/bootstrap.mjs`, `tools/db-reset.mjs`, `tools/dev-check.mjs`, `tools/lib/servicios.mjs` | Todas **derivan** de `services/` |
| Listas de puertos y de bases en `30-desplegar.sh`, `40-verificar.sh`, el ensayo y `install.sh` | Se leen de la librería, calculadas |

**Un servicio nuevo (el día que lo haya) es ahora: crear `services/<x>/` con sus migraciones y
añadirle `<X>_PORT` a `.env.example`.** El instalador, el aprovisionador, las bases, los roles,
las unidades de systemd, el respaldo, la restauración, la comprobación de puertos publicados y
el tablero de estado lo ven solos.

Además, dos cosas que salieron al revisar:

- **`backup.env` se pone al día solo** (`asegurar_bases_en_backup_env`): si a una instalación que
  ya existía le falta la base de un servicio nuevo, la **añade** (con copia
  `backup.env.antes-de-<fecha>`) y lo dice en voz alta. Probado con un arnés
  (`tmp/harness-backup-env.sh`, 10 comprobaciones): añade lo que falta, respeta claves y
  comentarios, no duplica y no revienta si el archivo no está.
- **La ayuda de `odontocrm` ejecutaba su propio texto**: tenía comillas invertidas dentro de un
  heredoc que expande, así que pedir la ayuda imprimía tres «orden no encontrada». Escapadas, y
  `fedora:check` ahora vigila esa clase en todos los heredocs.

`fedora:check` va por **146 comprobaciones** con cuatro candados nuevos, los cuatro probados en
negativo: un servicio sin puerto, una lista de servicios a mano, una lista de bases a mano y un
puerto repetido.

## [Instalador] — Reblindado tras el merge de facturación: los puertos, en un solo sitio · 2026-10-06

Con `billing` el despliegue pasó a **9 servicios** (y 10 unidades con el gateway). Revisar el
merge encontró el hueco clásico del «servicio nuevo a medias»: **cuatro listas de puertos
escritas a mano** se quedaron sin el 4009. Dos de ellas no eran cosméticas:

| Sitio | Qué pasaba | Ahora |
| :--- | :--- | :--- |
| `30-desplegar.sh` (espera de arranque) | Decía «los 9 puertos internos escuchan» **sin esperar el de billing**: un despliegue con billing caído pasaba por bueno | Los puertos se calculan con `#SERVICIOS` desde `PUERTO_SERVICIO` |
| `30-desplegar.sh` y `40-verificar.sh` (nada publicado) | La comprobación —**de seguridad**— no miraba el 4009: un puerto de billing abierto a la red habría pasado como «no publicado» | Recorren `puertos_internos` |
| `ensayo-despliegue.sh` | La misma lista a mano | Usa su mapa `PUERTO_DE`, que ya tenía billing |

Y para que no vuelva: los puertos viven en **`PUERTO_SERVICIO` (`comun.sh`)** con el helper
`puertos_internos`, y `fedora:check` estrena **tres candados** (los tres probados en negativo:
quito `[billing]=4009`, quito billing de `aprovisionar.mjs`, devuelvo una lista a mano… y falla):

1. cada servicio de `SERVICIOS` tiene puerto, y no hay puertos que no sean de ningún servicio;
2. las tres listas de servicios coinciden (`comun.sh` · `aprovisionar.mjs` · `tools/lib/servicios.mjs`);
3. ningún guion del despliegue vuelve a llevar una lista de puertos a mano.

De paso, los textos que contaban a mano («los 9 servicios», «las 8 bases», «las 10 unidades»)
ahora **se calculan** con `${#SERVICIOS[@]}`: al añadir el próximo servicio no habrá que
perseguirlos por todo el código.

## [Facturación] — La caja completa: historial, reimpresión contada y anulación · 2026-10-06

La biblioteca de la caja sabía emitir y cobrar desde la entrega anterior, pero **la pantalla no**: seguía
siendo la cola de borradores de la sesión A. Ahora el mostrador está entero, y con él las dos piezas que
faltaban en el servicio: el **historial** y la **constancia de impresión**.

| Pieza | Qué hace |
| :--- | :--- |
| `GET /billing/invoices` | El **historial** paginado: filtra por estado, por **día del documento** (el de emisión y, mientras es borrador, el de su creación, en el calendario de Caracas) y por nombre o documento del paciente. Cada fila trae el número impreso, el saldo, cuántos cobros tiene, la nota de crédito que la anula y las veces que se ha reimpreso |
| `POST /billing/invoices/:id/printed` · `POST /billing/payments/:id/printed` | La **constancia de impresión** (ADR 0048 y ADR 0036): cuenta la reimpresión y la descarga, guarda `last_printed_at` y lo publica a la auditoría. Emitir **no** cuenta: `printCount = 3` son tres reimpresiones |
| `apps/web/src/pages/CajaPage.tsx` | La pantalla, con **dos vistas**: *Pendientes* (los borradores del cierre de cada sesión: revisar, guardar, **emitir**, **descartar**) e *Historial* (buscar, abrir, **cobrar**, **reimprimir**, **anular con nota de crédito** y **anular un cobro**, que devuelve el saldo). El detalle muestra los totales, la tasa congelada, los cobros con su estado y la nota de crédito |
| `apps/web/src/components/caja/` | Los diálogos del mostrador (`CobroDialog`, `AnularDialog`, `TasaDelDia`) y el detalle del documento, con el **widget de la tasa del día**: sin tasa publicada no se emite ni se cobra, y corregirla exige motivo |
| `lib/caja.ts` | Las reglas puras de la pantalla —qué se puede hacer con cada documento (`puedeCobrarse`, `puedeAnularse`, `puedeDescartarse`, `puedeReimprimirse`), cómo se dicen las reimpresiones y cómo se arma la consulta del historial— con sus pruebas. La aritmética del dinero sigue siendo la del contrato, no una segunda cuenta en la web |

Dos cosas que se arreglaron de paso: el cliente tenía un `invoicePdfUrl` que no podía funcionar —la ruta
del PDF está detrás de la puerta y una URL abierta a pelo va sin token—, así que ahora el documento se
pide **con la sesión** (`apiBinary`) y se abre como objeto local, igual que el récipe; y la caja ya no
dice que emitir y cobrar «llegan en la próxima entrega».

Comprobado con la base de verdad: `npm run verify` en verde (816 pruebas), `npm run test:integration` en
verde (**99 suites, 991 pruebas**, con el historial y la reimpresión probados por dentro y por HTTP),
`npm run audit` en verde y `seed:verify` con el mundo sembrado (la caja abre con tres borradores y su
tasa del día). **Hallazgo, sin tocar**: la suite de reportes falló en una de las corridas por una
carrera de su propia prueba —comprueba un recuento justo después de una espera que puede cumplirse
antes de aplicar el último evento—; la corrida siguiente dio 991/991.

## [Facturación] — El mundo de prueba factura: tasas, aranceles, facturas y cobros · 2026-10-06

El seed del modo test ([ADR 0020](docs/adr/0020-modo-test.md)) ya no se queda en lo clínico: el mundo
que reconstruyen `seed:test` y `seed:verify` incluye la **facturación** de la Fase 11, así que la caja
abre con trabajo de verdad y sin depender de que la cola drene.

| Pieza | Qué hace |
| :--- | :--- |
| `packages/testing/src/test-world/billing.ts` | **Nuevo**: el mundo factura lo que facturaría el servicio. Una factura por sesión cerrada, con sus partidas del arancel y las **mismas funciones del contrato** que usa `billing` (`invoiceTotalsFromItems`, `ivaCentsForItem`, `invoiceVesTotals`, `igtfDecision`…): no hay una segunda aritmética del dinero que pueda discrepar |
| La cola de la caja | Las **tres sesiones más recientes** quedan en borrador; la siguiente, emitida sin cobrar; después una abonada a medias, una **anulada con su nota de crédito** y una pagada **con un cobro anulado** (el que se registró mal y se corrigió). Todo lo anterior, cobrado, con correlativo reservado 900.000+ y `is_test` |
| Tasas y aranceles | Un histórico de tasas **creciente** por día laborable (36,5420 Bs./USD y +0,0185 al día) hasta el día del ancla —que va como `manual`, como si lo hubiera tecleado la secretaría— y los **28 aranceles** del catálogo clínico, que la migración deja a cero esperando a la clínica: sin precio, `billing` marca la partida y **no deja emitir** |
| PDF archivados | La factura, el recibo y la nota de crédito se archivan con el `pdfDePrueba` del modo test, con **sus líneas en el mundo**: `seed:verify` recalcula el `sha256` sin duplicar textos y el documento se descarga de verdad por `GET /billing/invoices/:id/pdf` |
| `seed:test` / `seed:reset` | `PARTES` gana `billing`: siembra tasas, aranceles, facturas, partidas, cobros y notas (y sus PDF); el reset lo borra todo, devuelve los aranceles a cero y deja las tres secuencias de la caja apuntando al último número real |
| `seed:verify` | Seis huellas nuevas (tasas, aranceles, facturas, partidas, cobros y nota de crédito), los PDF por su `sha256` y el **reclamo del cierre de cada sesión** en `billing.processed_events` |

Lo que hace que esto no dependa de cómo se arranque: el seed **reclama el `clinical.session.closed`**
de cada sesión que facturó —y borra antes lo que la cola hubiera facturado por su cuenta—, así que
cuando el consumidor reciba el evento lo verá como duplicado; la segunda red ya estaba en la base
(`uq_invoice_sessions_session`). Con eso, sembrar con la pila parada y sembrar con la pila arriba dan
el mismo resultado.

Dos cosas que conviene saber: el mundo usa la **serie `A`**, la misma que crea el consumidor (el
servicio todavía no marca `is_test` ni cambia de serie en modo test: la serie `T` sigue sin uso), y los
**eventos de facturación** —la tasa de cada día, cada emisión, cada cobro, cada anulación y la nota de
crédito— van al outbox de `billing` para que `/auditoria` tenga también el recorrido del dinero.

## [Red] — El servidor se adapta solo cuando cambia la IP (y el nombre en Android) · 2026-10-06

Probar en un portátil que cambia de red destapó el último hueco de «lo que se queda apuntando
a la red anterior»: al cambiar la IP se adaptaban el firewall, el certificado y `WEB_ORIGIN`,
pero **el DNS del nombre se quedaba con la dirección vieja**. Con la IP anterior en
`listen-address`, `dnsmasq` ni siquiera escucha (`bind-dynamic` espera una dirección que ya
no existe), así que los Android —que **no** resuelven `.local` por mDNS— dejaban de resolver
`odontocrm.local` sin que nadie se enterara. El certificado no tenía nada que ver: por IP
entraban seguros.

| Pieza | Qué hace |
| :--- | :--- |
| `odontocrm red` | Ahora también comprueba el **DNS del nombre**: que `listen-address` y cada `address=` apunten a la IP de ahora, que `dnsmasq` esté activo y que **escuche de verdad** en esa dirección. Si está desalineado, lo cuenta como problema y dice cómo arreglarlo |
| `odontocrm red --arreglar` | Reescribe el DNS con la IP actual (reutilizando `nombre/instalar-dns.sh`: esa configuración sigue teniendo un solo dueño) y comprueba con `dig` que responde |
| `odontocrm-red.timer` + `.service` | **Nuevos**: cada 5 minutos ejecutan `odontocrm red --arreglar --si-cambio`. Guarda la última IP con la que se adaptó todo (`/var/lib/odontocrm/red-ultima-ip`) y, si no cambió, **no toca nada** (ni certificado ni servicios). En la clínica, con IP fija, nunca hace nada; en un portátil que cambia de red, deja firewall, certificado, CORS y DNS al día solo |
| `fedora:check` | Dos candados: **toda unidad de `infra/fedora/systemd/` se instala en el despliegue** (una unidad que nadie copia es un archivo muerto) y el temporizador de la red usa `--si-cambio`. El primero encontró que a la unidad nueva le faltaba el `ExecStart` |

Y una corrección de documentación con la prueba real de la consulta: la tabla de equipos decía
que **Android «suele resolver» `.local`** (probado en un Pixel 7); con un Pixel 7 y un Redmi
Note 8 Pro delante, el resultado es que **no lo resuelve**. `CERTIFICADO_EN_LOS_EQUIPOS.md`
ahora lo dice tal cual y manda al DNS propio, con el detalle que se olvida: el móvil tiene que
usar este servidor como DNS **y con el «DNS privado» desactivado**.

Y otro fallo latente que apareció al validar las unidades con `systemd-analyze verify`:
`odontocrm-backup.service` ponía `Environment=TZ=America/Caracas` en la sección **`[Unit]`**,
donde systemd **lo ignora** («Unknown key» en el journal) — así que el respaldo diario corría
con la zona horaria del sistema y la carpeta del día podía caer en la fecha equivocada, justo
lo que ese comentario decía evitar. Ahora está en `[Service]`, y `fedora:check` comprueba que
ninguna unidad vuelva a poner `Environment=` en `[Unit]`.

### Lo que encontró la primera prueba en la máquina de verdad

Poner esto en la PC de pruebas (que acababa de cambiar de red) encontró seis cosas más, y
todas eran del mismo tipo: **algo que falla y no lo dice**.

| Defecto | Síntoma real | Corrección |
| :--- | :--- | :--- |
| `instalar-dns.sh` arrancaba dnsmasq con `systemctl enable --now` | Un dnsmasq **ya activo no se reinicia** con `--now`: seguía esperando la IP anterior (`bind-dynamic`) y el 53 no escuchaba en la LAN, aunque el guion dijera «dnsmasq activo» y `odontocrm red` creyera que el DNS estaba bien | `enable` + **`restart`**, y se dice que se reinició con esta configuración |
| El mismo guion usaba `$CODE_DIR` sin definirla (y con la ruta mal: `$CODE_DIR/../nginx/…`) | Con `set -u` moría **al final**, después de dejar el DNS configurado, así que `odontocrm red --arreglar` lo contaba como «no pude actualizar el DNS propio» con el trabajo hecho | Se define `CODE_DIR` al principio y el resumen cita la ruta correcta del instalador de nginx |
| Dos sondas de `odontocrm red` sin `|| true` (`ss … \| grep :443`, `firewall-cmd … \| grep`) | Con nginx parado o sin reglas por rango, `grep` devuelve 1 → con `pipefail` el aviso de ERR imprimía «✖ un comando devolvió error» en mitad de un diagnóstico **correcto**, tapando el dato | Guardadas. Y la comprobación de sondas de `fedora:check` ahora también mira **tuberías sueltas**: encontró y se arreglaron cuatro más (incluidas las de `openssl … \| sed` del certificado) |
| `nombre/instalar-dns.sh` llevaba **comillas invertidas dentro de una cadena con comillas dobles** | Bash las **ejecuta**: en mitad de la instalación del DNS salía `.local: orden no encontrada` y el comentario quedaba a medias en el archivo | Quitadas, y `fedora:check` comprueba que ninguna comilla invertida viva dentro de comillas dobles en los guiones del despliegue |
| `odontocrm actualizar` avisaba «avahi sigue anunciando …» **siempre** | Comparaba con `$(hostname).local`, y `hostname` ya es `odontocrm.local` → esperaba `odontocrm.local.local`. Además de ruido, tapaba el caso real (avahi con un nombre viejo) | Se compara con el nombre ya normalizado (mismo criterio en `instalar-base-fedora.sh`), con candado |
| `30-desplegar.sh` migraba sin comprobar la base | Con PostgreSQL parado (lo había parado `odontocrm parar --todo`), lo que se veía era una traza de Node con `ECONNREFUSED 127.0.0.1:5432` y nada que decir qué hacer | Antes de migrar comprueba `pg_isready` y dice: «arráncalo y repite: `sudo odontocrm arrancar`» |

Y una confirmación: el aviso de contraseña temporal del paso 5/9 («se imprime UNA vez») es
fiable — se comprobó contra la base que las cuentas que el seed dice crear son exactamente las
que aparecen con `must_change_password`.

## [Instalador] — Pregunta lo que hace falta y siembra solo el administrador · 2026-10-06

Instalar ya no termina con deberes: el instalador **pregunta** lo que no se puede inventar
y lo deja en su sitio antes de arrancar los servicios.

```bash
sudo bash infra/fedora/instalar/instalar.sh
#  Contraseña del administrador  → se crea UNA cuenta: admin
#  Token del bot de Telegram     → comprobado contra Telegram antes de guardarlo
#  WhatsApp Cloud API (4 datos)  → opcional, con «¿configurar ahora? s/N»
```

Antes había que pelearse con esto **después** del despliegue: el token no llegaba al
servicio (se ponía en `/opt/odontocrm/services/notifications/.env`, que en el servidor no
lo lee nadie: systemd carga `/etc/odontocrm/*.env`) y el seed creaba tres cuentas —`admin`,
`recepcion` y el odontólogo— que la clínica no había pedido.

| Pieza | Qué cambia |
| :--- | :--- |
| `instalar.sh` | Pregunta con `read -s` (nada queda en pantalla ni en registros), valida longitudes, comprueba el token con `getMe` y resume lo que va a configurar. Banderas para desatenderlo (`--clave-admin=`, `--token-telegram=`, `--whatsapp-…`) y `--sin-preguntas`. Sin terminal no pregunta nada |
| `aprovisionar.mjs` | Escribe en `notifications.env` los tokens que le llegan por entorno; lo que no venga se conserva (una segunda instalación no borra el token de nadie) |
| `seed.js` | `--usuarios=<lista>` siembra solo esas cuentas (y en producción solo exige sus claves); `--ocultar-claves=` no imprime las que eligió una persona. Sin bandera se comporta como siempre (dev y pruebas) |
| `30-desplegar.sh` | Siembra solo `admin` (`USUARIOS_SEED`), usa la contraseña que eligió el operador y **el registro del seed ya no queda en `/tmp` a 644** (nacía con la contraseña dentro): va a `/root`, en 0600, y se borra al terminar bien |
| `desinstalar.sh` | **Nuevo**: deja la máquina como si el instalador no hubiera pasado (unidades, código, secretos, bases, roles, proxy, certificado, firewall y SELinux). Exige `--si`; sin él solo enseña lo que borraría. Antes guarda `/etc/odontocrm` y un `pg_dump` de cada base en `/root/odontocrm-antes-de-desinstalar-<fecha>/` |
| `fedora:check` | Tres candados nuevos: las recetas del seed llevan la clave de cada cuenta (respetando `--usuarios=`), **ninguna pieza pregunta nada** (una actualización sin terminal se colgaría) y `instalar.sh` pregunta de verdad y se puede desatender |

Los e2e del repositorio siguen igual: en desarrollo y en las pruebas se siembran las tres
cuentas de siempre (`--con-todas-las-cuentas` en el instalador).

### Lo que encontró la primera prueba real (y quedó cerrado)

Probar el ciclo completo —desinstalar, instalar, entrar— encontró cinco defectos que
habrían dado exactamente la «vorágine de pruebas fallidas» que el ADR 0043 dejó atrás:

| Defecto | Síntoma real | Corrección |
| :--- | :--- | :--- |
| El desinstalador borraba `/opt/odontocrm` aunque fuera **el directorio de la terminal** | El intérprete se quedó sin directorio (`getcwd: no se puede acceder a los directorios padre`) y la instalación siguiente murió en el paso 3/4 con `fatal: esta operación debe ser realizada en un árbol de trabajo` — parecía un fallo del código y no lo era | Se comprueba antes de tocar nada: si la terminal está dentro de una ruta que se borra, **se niega a seguir (código 11)** y dice `cd ~`. Y `comun.sh` sigue desde `/` si el directorio ya no existe, para que ninguna pieza se caiga por eso |
| El volcado de cada base se hacía **troceando la URL a mano** y con `2>/dev/null` | Nueve «no pude volcar … (¿la base ya no está?)» **sin el motivo**, y las bases quedaron sin copia | `pg_dump` recibe **la URL entera** que usa el servicio (la cadena que ya está probada) y, si falla, se enseña el error de `pg_dump` y se guarda en `<base>.error` |
| El `DROP DATABASE`/`DROP ROLE` también ocultaba la salida | «no pude borrar la base … (míralo a mano)» sin decir por qué | Se enseña el motivo. Y si un volcado falló, **esa base no se borra**: la copia es la única red con pacientes dentro |
| **El propio instalador exportaba las claves vacías** (`WHATSAPP_TOKEN=''`) | Las migraciones de notifications murieron con `ConfigError: WHATSAPP_TOKEN: el valor es más corto o menor de lo permitido`. Una variable **vacía no es «ausente»** para los esquemas de los servicios, y `con-entorno` pasa el entorno del proceso tal cual: el instalador envenenaba el entorno de sus hijos | Se exporta **solo lo que tiene valor**. Probado con el código compilado: con las variables vacías exportadas sale el `ConfigError` exacto; sin ellas la configuración carga |
| `instalar-base-fedora.sh` añadía `.local` a un nombre que ya lo traía | El resumen decía «los equipos entran por https://odontocrm.local.local» | Solo se añade si el nombre no trae dominio (mismo criterio que `nombre_fqdn`) |

### Arreglado de paso

- `aprovisionar.mjs` no pasaba `npm run lint` (`no-control-regex` en la comprobación de
  caracteres de control de `sqlTexto`): ahora lleva la misma excepción razonada que
  `packages/contracts` usa en sus dos limpiadores.

## [Corrección] — Sembrar usuarios en el servidor: la receta no decía qué claves hacía falta · 2026-10-06

En la puesta en marcha, el comando que enseñaban el RUNBOOK (§5) y `COMANDOS_PRODUCCION.md`
(§5) —y el que repetía `40-verificar.sh` cuando no había usuarios— moría en producción:

```
Error: En producción define SEED_PASSWORD_PRUEBA (mínimo 10 caracteres) antes de sembrar usuarios.
```

Las tres piezas estaban mal por el mismo motivo: **en producción el seed exige una contraseña
por CADA cuenta** en el entorno (`SEED_PASSWORD_<USUARIO>`, mínimo 10 caracteres) y no acepta
las de desarrollo. Las recetas que se documentaban no las llevaban, y las que llevaban una
sola (`SEED_PASSWORD_ADMIN`) fallaban igual en cuanto la clínica tenía odontólogo propio.

| Defecto | Consecuencia | Corrección |
| :--- | :--- | :--- |
| El seed lanzaba el error con la **primera** clave que faltaba | Con tres cuentas había que repetir el comando tres veces para enterarse de todas | Se anotan las que faltan y se avisa **una sola vez**, con la lista completa y el comando de ejemplo |
| `--print` (el comando para ver quién existe y quién quedó bloqueado) exigía las claves y moría igual | En producción no se podía consultar el estado de las cuentas con la herramienta del propio sistema | `--print` no escribe: funciona sin claves y dice `(la del entorno)` en vez de inventar la de desarrollo |
| Las recetas de RUNBOOK §5, `COMANDOS_PRODUCCION.md` §5 y la tabla de equivalencias no llevaban las claves; la del RUNBOOK llevaba solo la del administrador | El operador sigue la receta y se queda fuera del sistema sin pista de cómo entrar | Las tres llevan las claves de todas las cuentas (una por odontólogo de `CLINIC.dentists`) y avisan de que `--reset` regenera **todas** |
| Nada comprobaba lo anterior | El defecto volvería con el próximo odontólogo | `npm run fedora:check` comprueba que todo comando documentado que siembre usuarios nombre las claves de todas las cuentas |

## [Facturación] — El contrato del módulo y las partidas en el evento de cierre · 2026-10-06

Arranque de la Fase 11 ([`docs/feat_billing.md`](docs/feat_billing.md)), **todavía sin servicio**: lo
que entra son las decisiones registradas, el contrato compartido, los permisos y el cambio de contrato
del evento clínico que el borrador de factura necesita.

### Decisiones registradas (ADR 0044–0048)

El plan numeraba sus cinco ADRs 0043–0047 dando por hecho que 0042 era el último, pero el
[ADR 0043](docs/adr/0043-se-descarta-el-enfoque-de-instalacion-actual.md) —instalación y despliegue— se
escribió antes y ocupó ese número, así que el primero chocaba de frente con él (el propio plan ya citaba
«ADR 0043» para el instalador). Los de facturación entran como **0044–0048**, el plan queda corregido y
`docs/adr/` pasa a **48** entradas; la fila de la Fase 10 del plan maestro, a **42** (lo que existía al
cerrarla).

| ADR | Decisión |
| :--- | :--- |
| [0044](docs/adr/0044-modulo-de-facturacion-desacoplado.md) | Servicio desacoplado, dinero en enteros y borrador idempotente desde la sesión clínica |
| [0045](docs/adr/0045-regimen-tributario-iva-e-igtf.md) | Servicios exentos, bienes al 16 % y el IGTF como dato del medio de pago |
| [0046](docs/adr/0046-tasa-bcv-historica-y-regla-de-imputacion.md) | Tasa BCV histórica, congelada por documento, y regla de imputación explícita |
| [0047](docs/adr/0047-quien-asigna-el-numero-de-la-factura.md) | Quién asigna el número: formas libres con correlativo propio **y** número de control |
| [0048](docs/adr/0048-el-documento-de-cobro-se-archiva.md) | Emitir es congelar; anular no es borrar |

### Contrato compartido

`packages/contracts/src/domain/billing.ts` es la única fuente de los estados, las categorías fiscales,
los medios de pago y la **aritmética del dinero en enteros** (una sola regla de redondeo, half-up, y
productos intermedios en `BigInt`): `rateToMicros` parsea la tasa sin coma flotante, `vesCentimosFromUsd`
y `usdCentsFromVes` convierten en los dos sentidos e `igtfCents` aplica la alícuota. La máquina de
estados es **dato** (`INVOICE_TRANSITIONS`, con las transiciones del saldo marcadas como automáticas) y
la decisión del IGTF vive en un solo sitio (`igtfDecision`): el banco no se cobra dos veces y sin SPE no
se percibe nada. 28 pruebas unitarias.

### Permisos, auditoría y tópicos

Cinco permisos (`billing:read/write/collect/rates/void`) repartidos por rol —la secretaría los tiene
**todos**, porque atiende sola el mostrador y anula con motivo; el odontólogo solo mira lo que se cobró—,
ocho acciones de auditoría con su etiqueta en la interfaz y ocho tópicos `billing.*` (el borrador no
publica evento: el acto de dinero nace al emitir).

### Cambio de contrato: `clinical.session.closed` (aditivo)

> **Aviso para quien consuma el evento** ([ADR 0041](docs/adr/0041-el-evento-lleva-lo-que-el-consumidor-necesita.md)):
> el bloque `session` gana `procedures: [{ code, detail, toothNumber, surfaces }]` **además** de
> `procedureCodes` y `procedureCount`, que no cambian.

El borrador de factura necesita el código, el detalle, la pieza y las caras para describir cada línea
(«Obturación con resina compuesta · pieza 26 (oclusal)»), y el detalle es imprescindible cuando el
procedimiento es `otros`. El mapeo vive en un solo sitio (`sessionProcedureBlocks`, en el contrato) y lo
usan el servicio clínico y el mundo de prueba; hay pruebas en los tres niveles: contrato, **outbox real**
(integración) y eventos sembrados.

### De paso

- **`npm run verify` estaba en rojo en `main`** desde `fd44cd1`: eslint marcaba `no-control-regex` en el
  aprovisionador del instalador. Corregido (comprueba lo mismo con `\p{Cc}`).
- **El auditor de conexiones daba un problema estructural falso** con `/api/v1/meta`: la puerta la sirve
  por sí misma (`app.get` en `server.ts`) y el auditor solo miraba los `add(...)` de `routes.ts`. Ahora
  recoge también las rutas propias de la puerta y `npm run audit` sale 0.

## [Fedora] — El instalador nuevo: una sola fuente de verdad para las credenciales · 2026-10-05

El rediseño que el ADR 0043 dejó pendiente, implementado. **Un comando instala el servidor
entero** y la invariante que faltaba —una sola copia de cada secreto— ahora está protegida por
la estructura, no por la disciplina de quien instala:

```bash
bash infra/fedora/instalar/instalar.sh --comprobar   # sin sudo: ¿está lista la máquina?
sudo bash infra/fedora/instalar/instalar.sh          # instala todo
```

### Las cuatro piezas (cada una se ejecuta y se comprueba sola)

| Pieza | Qué hace |
| :--- | :--- |
| `10-preparar.sh` | Paquetes, PostgreSQL, Node 26, nginx+mkcert, `pg_hba` en `scram-sha-256`, usuario `odontocrm`, directorios con permisos y el nombre por mDNS |
| `20-aprovisionar.sh` | **Genera los secretos UNA vez** en `/etc/odontocrm`, crea los 9 roles y las 9 bases con esas mismas contraseñas y **comprueba cada una conectándose** |
| `30-desplegar.sh` | Código en `/opt` **sin secretos** (se clona: un clon no trae lo ignorado por Git), compilación, claves JWT, migraciones, usuarios iniciales, unidades systemd, certificado TLS, proxy, SELinux y firewall |
| `40-verificar.sh` | El efecto: credencial que conecta, servicio que escucha, HTTPS que sirve la app, CA descargable y puertos correctos |

### Lo que se retira

- **`infra/fedora/instalar-servidor.sh` se elimina**: era el envoltorio del ensayo como
  instalador, con el **traslado de secretos** dentro —justo la causa raíz de los fallos.
- **`odontocrm sincronizar-credenciales` ya no copia nada**: pasa a `odontocrm credenciales` y
  solo comprueba. Si algo no conecta, se arregla **volviendo a aprovisionar** (que converge la
  base a lo que dicen los archivos), nunca copiando de un sitio a otro.
- **`odontocrm actualizar` ya no llama a `install.sh`** (un segundo escritor de
  `/etc/odontocrm`): ahora ejecuta `30-desplegar.sh`, que es idempotente. Las actualizaciones
  **no rotan credenciales**; para eso está `--rotar-credenciales`, a propósito.
- El ensayo `ensayo-despliegue.sh` **se conserva como prueba** (restauración, reinicio, TLS
  desde otro equipo), que es donde tiene valor.

### Defectos que encontró la propia prueba (y quedaron corregidos)

Probar de verdad —y no solo leer el código— encontró seis fallos que habrían aparecido en la
clínica, uno de ellos con el síntoma exacto que se quería evitar:

| Defecto | Cómo se descubrió | Corrección |
| :--- | :--- | :--- |
| `ORIGEN` apuntaba a `infra/` en vez de a la raíz del repositorio | El `--dry-run` anunciaba `git clone …/OdontoCRM/infra` | Tres niveles arriba, no dos; y se comprueba que exista `package.json` |
| `TELEGRAM_BOT_USERNAME=` **vacío** rompía el servicio de notificaciones | Migrando de verdad: `ConfigError` y la migración no corría | Las claves sin valor **se omiten** (no es lo mismo `CLAVE=` que no ponerla) y quedan comentadas |
| Un `null` en una clave gestionada **borraba** el token del bot ya configurado | Prueba de preservación | Si ya había valor, manda el que había |
| `--dry-run` ejecutaba de verdad el instalador de nginx/DNS y `setsebool`/`semanage` | Lectura del flujo con `--dry-run` desde otro directorio | Todo lo que modifica el sistema queda detrás de la guarda de `--dry-run` |
| El aviso de `--dry-run` tapaba la guarda de «ya estamos sobre el código desplegado» | Ejecutándolo desde el propio directorio desplegado | La comprobación va **antes** que el modo de prueba |
| `firewall-cmd` **se colgaba indefinidamente** sin root (polkit pide contraseña y no hay agente) | Barrido de todos los modos de ejecución | Se omite la sección sin root con un aviso, y todas las llamadas llevan `timeout` |

### Lo que encontró la revisión adversarial (y quedó corregido)

Una revisión independiente del instalador encontró **nueve defectos más**, dos de ellos
graves. Todos verificados reproduciéndolos antes de arreglarlos:

| Defecto | Consecuencia | Corrección |
| :--- | :--- | :--- |
| `--admin-url` se pasaba también a la pieza 1, que no lo conoce | La opción documentada **abortaba la instalación en el paso 1/4** | Solo se pasa a las piezas 2 y 3 |
| El clon quedaba con la cabeza **desacoplada** (`git checkout <sha>`) | `odontocrm actualizar` moría siempre con *«'HEAD' no es un nombre válido de rama»*: la instalación acababa bien y **la primera actualización era imposible** | `git checkout -B <rama> <commit>`: la rama queda creada |
| El nombre iba sin `.local` en `WEB_ORIGIN` y `PUBLIC_APP_URL` | El **QR de todos los récipes** apuntaba a un host que no resuelve | Se escribe el nombre completo |
| El nombre no se recordaba entre corridas | Cada `actualizar` reemitía el certificado para `odontocrm.local`: una clínica con otro nombre perdía el suyo | Se persiste en `odontocrm.env` y las piezas lo recuperan |
| El certificado se reemitía **siempre** | Pisaba sin avisar un certificado propio de la clínica | Solo se emite si falta o si no cubre los nombres |
| `crear-rol-respaldo.sh` **truncaba** `.pgpass` y la guarda de reutilización era inalcanzable | Rotaba la credencial de respaldo **y la del superusuario** en cada despliegue | Se conserva el archivo; probado en tres corridas seguidas |
| No se reiniciaban los servicios tras `--rotar-credenciales` | Los 9 procesos seguían con el `DATABASE_URL` viejo (28P01) | `systemctl restart`, no `enable --now` |
| El firewall imprimía «80 y 443 abiertos» sin comprobar nada | Decía haber abierto puertos que seguían cerrados | Se comprueba el código de salida y se inspecciona la zona de la LAN |
| El fallo del seed era solo un aviso | Podía terminar con «listo para la consulta» y **nadie podía entrar** | Se comprueba que existan usuarios, y no se imprime una contraseña que no vale al repetir |

También: `git safe.directory` para que el clon funcione cuando el instalador corre como root
sobre el clon del operador; las claves JWT se verifican **dónde** aterrizan (el generador tiene
una ruta de emergencia que las escribiría dentro de `/opt`, justo lo que el ADR prohíbe); el
registro de `actualizar` pasa a 0600; y los guiones de respaldo respetan `ODONTOCRM_ENV_DIR`.

### El fallo que apareció en la primera instalación real

La primera ejecución de verdad —en la PC de la clínica, con `sudo`— se detuvo en el paso 3/4:

```
fatal: falló al crear link '/opt/odontocrm/.git/objects/pack/…':
       Enlace cruzado entre dispositivos no permitido
✖ no pude clonar el repositorio en /opt/odontocrm
```

**Causa**: `git clone --local` no copia los objetos, los **enlaza**; y enlazar falla con
`EXDEV` cuando el origen y el destino están en submontajes distintos —aquí `/home` y `/opt`
son subvolúmenes btrfs diferentes—, que es el caso normal: el repositorio del operador vive en
su home y el despliegue va a `/opt`.

Lo llamativo es que **ya me había pasado**: al probar el clon en `/tmp` salió el mismo error y
lo workaroundé en la prueba con `--no-hardlinks`, sin arreglarlo en el instalador. La lección
es la de siempre: un fallo que se esquiva en la prueba no está arreglado.

**Corrección** (tres cosas, no una):

1. `--no-hardlinks`: copia los objetos y funciona en los dos casos. Cuesta segundos.
2. Se clona en un directorio **temporal** y se mueve a su sitio al terminar: así una clonación
   que falle no deja `/opt/odontocrm` a medias con un `.git` incompleto que bloqueaba el
   reintento (que es justo lo que quedó en la máquina).
3. Si el destino tiene un `.git` que git no reconoce, es la ruina de un intento anterior: se
   retira y se clona de nuevo —en vez de morir pidiendo que lo muevas a mano—. Si lo que hay
   es contenido que **no** es un clon, no se toca y se explica.

Probado ejecutando el bloque real del guion (extraído del archivo, no una copia) con el destino
en otro montaje: destino inexistente, destino **vacío**, `.git` roto de un intento anterior,
clon que ya funciona y directorio con contenido ajeno. Los cinco caminos se comportan como
deben y no queda ningún temporal.

### La primera instalación real (y lo que se vio en ella)

El despliegue completo funcionó: 9 servicios escuchando y respondiendo `/health` y `/ready`,
TLS emitido, proxy sirviendo la interfaz, firewall con el 80 y el 443, y **el código de
`/opt` sin un solo `.env`**. Tres cosas salieron de ahí:

1. **`odontocrm.local.local`** en el resumen final. `resolver_nombre` devuelve el nombre YA
   completo (`odontocrm.local`), y el resumen le volvía a pegar `.local`. Afectaba también al
   mensaje del DNS propio (`odontocrm.local.home.arpa`). Se corrigió componiendo la dirección
   siempre con `nombre_fqdn`, y se añadió `nombre_corto` para la zona del DNS. **Era una
   dirección de entrada rota impresa justo donde el operador la copia.**
2. **El «código 200» de la CA**: la descarga devolvía 200 pero el cuerpo no era un
   certificado. **No se pudo reproducir** —con nginx en marcha, la descarga es correcta y los
   cinco formatos salen con su tipo MIME bueno—, así que en vez de adivinar la comprobación se
   hizo robusta y **auto-diagnosticable**: archivo temporal único por corrida, un reintento, y
   si vuelve a fallar dice **qué llegó** (código, tipo y primeras líneas) en lugar de dejar un
   callejón sin salida. De paso, los cinco formatos de la CA se comprueban ahora por **tipo**:
   la interfaz responde 200 a cualquier ruta, así que un 200 a secas podía dar por bueno un
   enlace que en realidad devolvía la página de la aplicación.
3. **Los usuarios ya existían** y el mensaje decía «la contraseña de arriba no vale» —cuando
   arriba no había ninguna—: quien instalaba se quedaba **fuera del sistema sin ninguna
   pista**. Ahora se dice cuántos son y se imprime la receta exacta, con los nombres reales,
   para ponerles una contraseña elegida por el operador.

**La verificación final pasó entera** (`40-verificar.sh`, 6/6): las 9 credenciales conectan,
los 9 servicios responden `/health` y `/ready`, la interfaz y la API por HTTPS, la CA en los
cinco formatos con su tipo correcto, el certificado cubriendo nombre e IP, y el firewall con el
80 y el 443 abiertos y la base sin publicar. **«Todo correcto. El servidor está listo para la
consulta.»**

Último detalle corregido: el aviso de SELinux prometía decir *cuál* era la denegación y no
imprimía nada — el patrón esperaba `denied{` y una línea AVC real trae `denied  { read }`, con
espacios. Ahora resume los campos que importan:
`denied { read } comm="nginx" name="ca" tclass=dir`.

### Verificación (lo que se probó de verdad en esta sesión)

- **El aprovisionador, contra el PostgreSQL real de esta máquina**: creó los 9 roles y las 9
  bases, aplicó las contraseñas y **las 9 conectan** por TCP con `scram-sha-256`.
- **Idempotencia**: la segunda corrida conserva los secretos (el archivo no cambia).
- **Prueba negativa**: cambiar a mano la contraseña del rol `odonto_identity` en la base hace
  que la comprobación lo detecte, **nombre el servicio y el archivo**, y salga con código 1 —
  exactamente el fallo que antes costó cinco rondas, ahora localizado por su causa.
- **Preservación**: las claves que añade una persona a mano se conservan; y una clave que el
  instalador escribiría vacía (el token del bot) **no pisa** el valor que ya había.
- `npm run fedora:check`: **123 comprobaciones, 0 fallos** (antes 95), reapuntadas al camino
  nuevo: piezas completas, encadenadas, un solo escritor de credenciales, despliegue sin
  secretos y documentación coherente.
- **La secuencia del despliegue, ejecutada de verdad**: clon de git → `npm ci` → `npm run build`
  (código 0), **las 8 migraciones** aplicadas con el entorno de `/etc/odontocrm`
  (`tools/con-entorno.mjs`) y **la siembra de usuarios** (admin, recepcion y el odontólogo de
  `clinic.ts`) con la contraseña temporal.
- **Todas las piezas, en todos sus modos**, se ejecutan sin abortar por una variable sin
  definir (`set -u`) y sin colgarse, incluido `instalar.sh --dry-run` completo (319 líneas de
  previsualización, 0,2 s, sin sudo).

> **Pendiente de comprobar con `sudo`** (esta sesión no tenía permisos): la ejecución real de
> la instalación completa en la máquina. Las piezas están escritas para poder ejecutarse por
> separado precisamente para eso: si una falla, se retoma desde ahí sin repetir lo anterior.

## [Fedora] — Se descarta el plan de instalación actual · 2026-10-05 (después del tag `fase-10`)

El camino de instalación y despliegue (el ensayo como instalador, el traslado de secretos a
`/etc/odontocrm`, el sincronizador que lo repara y las fases con `--hasta`) **se descarta como
diseño**: los secretos viven en dos sitios y cada fallo era un síntoma de esa única causa.
No se le añaden más parches. **El rediseño y su implementación se harán en otra sesión**, y
mientras tanto lo que hay sigue funcionando y documentado (ver
`docs/PLAN_INSTALACION_LIMPIA.md`).

## [Fedora] — Del «funciona en mi PC» al «funciona en la clínica» · 2026-10-05 (después del tag `fase-10`)

### Lo que se cerró con pruebas en aparatos reales

- **El certificado se instala en Windows, Android (Pixel 7) y Linux**, y `odontocrm.local`
  funciona desde Android. Registrados como verificados P-12 y P-20 (§20.1).
- **Instalación de una PC nueva en un comando**: `sudo bash infra/fedora/instalar-servidor.sh --con-dns`
  (máquina, bases, usuarios, despliegue, TLS, firewall, SELinux, respaldos y el nombre),
  con la contraseña temporal en pantalla y la página del certificado al final.
- **Actualización en un comando**: `sudo odontocrm actualizar` pone al día código, unidades,
  plantillas, **la configuración del proxy y el nombre por mDNS**.
- **Diagnóstico en un comando**: `odontocrm estado · verificar · red · nombre · certificado`.

### Los fallos que aparecieron al probar de verdad (y dónde quedaron)

| Fallo | Causa raíz | Dónde quedó la lección |
| :--- | :--- | :--- |
| Los enlaces nuevos de la CA respondían **301** | La configuración del proxy es otra copia (`nginx/instalar.sh`), no la instalaba `actualizar` | `actualizar` reinstala el proxy; guardia de los cinco enlaces en los dos bloques |
| Los scripts de la CA llevaban **una IP grabada** → *timeout* | Se publicaban con la IP del día de la instalación | `sub_filter` con la dirección de quien descarga; guardia que prohíbe grabar IPs |
| «**Could not resolve host: SERVIDOR**» | `sub_filter_types text/plain` no coincide con `application/x-sh` | `sub_filter_types *`; guardia del comodín; plan B con el nombre |
| avahi anunciaba **el nombre viejo** | `systemctl restart` no siempre reemplaza el proceso | `nombre --arreglar`, `actualizar` lo corrige; se comprueba lo que **anuncia** el proceso |
| El nombre no resolvía y parecía la red | Tres causas distintas con el mismo síntoma | `odontocrm nombre` las separa y da el camino de cada una |

### Y la red de seguridad

**86 comprobaciones** en `npm run fedora:check` (dentro de `verify`): cada fallo de arriba
tiene la suya. Más la tabla de **INSTALL §7-bis**: qué tocar al añadir una variable, un
servicio, una ruta, algo del proxy, una migración o un dato impreso.

## [Fedora] — Auditoría de portabilidad: 20 fallos corregidos y 12 guardias nuevas · 2026-10-05 (después del tag `fase-10`)

### Corregido

Tres auditorías en paralelo (despliegue, bases y respaldos, configuración y documentación)
buscando todo lo que asumiera la PC de pruebas. Lo que habría roto una instalación nueva:

- **Nombres de PostgreSQL**: `postgresql-18.service` y `postgresql-18-setup` no existen en
  Fedora 43/44, y systemd **ignora en silencio** una unidad inexistente en `After=`/`Wants=`
  (los 8 servicios podían arrancar antes que la base y morir en bucle). Las unidades nombran
  las dos convenciones y los mensajes detectan el sabor instalado.
- **El puerto 80 no se abría**: por ahí cada equipo descarga la CA
  (`http://<servidor>/ca.crt`); las comprobaciones daban verde porque se hacían desde
  127.0.0.1, que firewalld no filtra.
- **`install.sh --apply` usaba PM2**: plantillas 0600 que PM2 no puede leer y un ecosistema
  con 3 de los 9 servicios. Ahora el supervisor por defecto es systemd (el validado).
- **El respaldo diario nunca se programaba** (solo el temporizador de alertas): la clínica se
  habría quedado sin respaldos, y el RUNBOOK decía que sí se programaba.
- **El bootstrap por socket con usuario** (lo que recomienda la propia guía) escribía 8
  `DATABASE_URL` rotas y dejaba de ser idempotente.
- **`INTERNAL_SERVICE_SECRET`** traía un valor del repositorio que pasaba el `min(16)` del
  esquema: ahora se genera uno aleatorio. Y `PUBLIC_APP_URL` se copiaba entero de
  `WEB_ORIGIN` (que admite varios orígenes), así que el QR del récipe salía roto.
- **`source` sobre los `.env`**: vaciaba `WEB_ORIGIN` (por el espacio tras la coma) y
  expandía las contraseñas con `$`. Se sustituye por `tools/con-entorno.mjs`.
- **La cola `odonto_events` no se respaldaba** en ningún sitio: tras restaurar, los eventos
  ya marcados como publicados no vuelven. Ahora está en las tres listas.
- **El RUNBOOK enseñaba a restaurar** con banderas que no existen y, sin `--keep-old`,
  borrando la base actual. Reescrito con las banderas reales.
- **Documentos que llevaban al desastre**: `STORAGE_ROOT`/`STORAGE_DRIVER` (ningún servicio
  los lee), la recuperación de la contraseña del administrador (imposible como estaba),
  `git checkout fase-9` (dejaba HEAD desprendido) y la falta de un paso para cambiar los
  **datos del consultorio** (`packages/contracts/src/clinic.ts`, nueva §8.0).

### Añadido

- **12 guardias nuevas** en `npm run fedora:check` (**63 comprobaciones**): temporizadores,
  `source` sobre `.env`, supervisor por defecto, puerto 80, nombres de PostgreSQL, CIDR a
  mano, banderas de los documentos, datos del consultorio, coherencia de la lista de bases,
  marcadores `CAMBIAR_*`, cargador de entorno y honestidad de la cabecera del instalador base.
- **`odontocrm verificar` avisa de los marcadores `CAMBIAR_*`** sin sustituir en
  `/etc/odontocrm` (el fallo más silencioso: el servicio arranca con un valor del repositorio).
- **`tools/con-entorno.mjs`**: carga los `.env` sin interpretarlos como shell.
- **`pg_hba.conf` se cambia de verdad** en el instalador base (conserva `peer` para el socket
  y pone `scram-sha-256` en TCP), comprobándolo con `pg_hba_file_rules`.

### Pendiente (registrado en INSTALL.md §20.2, P-36…P-42)

Plantillas que no se actualizan (P-36), flags de rutas sin propagar (P-37), camino PM2 a
medias (P-38), metadatos de la base al restaurar (P-39), huella de datos entre máquinas
(P-40), extensiones en bases restauradas (P-41) y `env-check` que da verde sin `.env` (P-42).

## [Fedora] — `TELEGRAM_MODE` repuesto si se perdió · 2026-10-04 (después del tag `fase-10`)

### Corregido

- **`/etc/odontocrm/notifications.env` se quedó sin `TELEGRAM_MODE`** y el ensayo avisaba de
  ello en cada corrida. Lo causó el traslado de secretos de una versión anterior del guion:
  borraba las claves gestionadas y reescribía solo las que traía el repositorio, y como el
  `.env` de desarrollo no define `TELEGRAM_MODE` (usa su valor por defecto), la clave
  desapareció del archivo de producción. El servicio funcionaba igual (el esquema tiene
  `auto` por defecto), pero era un aviso fijo en una corrida verde, y los avisos fijos
  tapan los de verdad. Ahora `install.sh` la repone si falta, y es idempotente.

## [Fedora] — Los paquetes de SELinux se llaman como son · 2026-10-04

### Corregido

- **`setools-conftools` no existe en Fedora.** La guía de instalación (§4 y §12) y `install.sh`
  pedían ese paquete, que `dnf` rechaza con «no hay coincidencias». El paquete real es
  **`setools-console`**, y las herramientas que la guía le atribuía vienen de otros sitios:
  `sealert` de **`setroubleshoot-server`**, `audit2why` de **`policycoreutils-python-utils`** y
  `ausearch` de **`audit`** —los tres añadidos a la lista de paquetes base—. Lo destapó la primera
  instalación en el Fedora del banco de pruebas y queda anotado como **P-26** en el registro de la
  Fase 10.
- La tabla de paquetes de §4 ahora dice **qué trae cada uno** y añade el recurso para no volver a
  tropezar: `dnf provides '*/<comando>'` dice a qué paquete pertenece una herramienta antes de darla
  por perdida.

## [Fase 10] — Modo test, observabilidad y endurecimiento · 2026-10-04 · tag `fase-10`

### Añadido

- **Modo test (ADR 0020)**: `TEST_MODE` + `ALLOW_TEST_MODE` en el contrato, con las
  reglas en un solo sitio (`resolveTestMode`). Se activa pidiéndolo **y**
  permitiéndolo, y queda **bloqueado con `NODE_ENV=production`** aunque las dos
  banderas estén en `true`. `GET /api/v1/meta` publica el estado del sistema sin
  sesión, la SPA pinta el **banner rojo «MODO TEST»** en toda la interfaz (acceso y
  pantallas kiosko incluidas) y el servicio de notificaciones pasa a **simulado**
  aunque tenga token: en modo test **ningún mensaje sale a un paciente**.
- **Seed determinista del mundo de prueba**: `npm run seed:test`, `seed:reset` y
  `seed:verify` ([ADR 0042](docs/adr/0042-el-seed-escribe-filas-y-eventos.md)). Un
  mundo puro (`packages/testing/src/test-world`) genera 40 pacientes ficticios
  (cédulas 90.000.000+), 46 solicitudes con ticket, 42 citas (27 atendidas, 4
  inasistencias, cancelada, reprogramada y la jornada de hoy con sala y consultorio),
  22 historias firmadas, 27 sesiones cerradas, 22 récipes y 156 hallazgos — **y los
  593 eventos** que el sistema habría publicado, con fecha histórica. Con eso el
  **read model de reportes se llena por el camino real** (la deuda que dejó anotada la
  Fase 9), la auditoría tiene el recorrido completo y `seed:verify` comprueba por
  huellas que lo sembrado es el mundo. Repetirlo no duplica nada; los consecutivos
  van al rango reservado 900.000+ y las secuencias quedan apuntando al último número
  real.
- **Observabilidad**: `npm run estado`, el tablero que mira los 9 servicios (con
  `/health` y `/ready` y el detalle del chequeo que falla), las 9 bases, la cola por
  cola, el outbox de cada servicio, los envíos atascados y el disco. Con `--alertas`
  no imprime nada y sale 0 cuando todo va bien: eso es lo que vigila
  `odontocrm-alertas.timer` en Fedora cada cinco minutos (el servicio queda en
  `failed` si algo falla). El `/ready` del gateway ahora **pregunta a sus servicios**
  y responde 503 con el nombre del que no contesta. Rotación de logs con
  `infra/fedora/logrotate/odontocrm` (diaria, 30 días, comprimida).
- **Aceptación del flujo completo**: `npm run e2e:clinica` encadena las once pruebas
  del día de la clínica —acceso, bot, agenda, pantallas, pacientes, historia y sesión,
  odontograma, récipes, reportes y auditoría, y las dos de navegador— y da un solo
  veredicto. Con `--sin-bot` la parte del bot se marca como **pendiente** en lugar de
  fallar (para una máquina sin token); sin esa bandera, no tenerlo es un fallo.
- **Runbook de operación** ([`infra/fedora/RUNBOOK.md`](infra/fedora/RUNBOOK.md)) y
  **guía para el consultorio** ([`docs/OPERACION_CLINICA.md`](docs/OPERACION_CLINICA.md)).
- **Despliegue Fedora validado en el banco de pruebas**, con el registro de verificación
  en [`INSTALL.md` §20](infra/fedora/INSTALL.md): los 9 servicios con `systemd` (unidad
  activa **y** sirviendo su puerto), nginx con TLS interno y `firewalld` publicando solo
  443, SELinux en `Enforcing` sin denegaciones, respaldo + **restauración probada fila a
  fila** (4953 → 4953 en las 8 bases) y la **prueba de reinicio** (los 9 vuelven solos).
- **Un solo comando para el servidor** (`/usr/local/bin/odontocrm`): `estado`, `alertas`,
  `respaldar`, `restaurar`, `verificar`, `servicios`, `logs`, `actualizar`, `parar`,
  `arrancar`, `reiniciar`, `compilar`, `recompilar`, `certificado`, `selinux`,
  `con-entorno` y `modo-test`. Cada orden delega en el script ya probado, pone el entorno
  correcto y **avisa si falta `sudo`** en vez de hacer media faena.
- **`docs/COMANDOS_PRODUCCION.md`**: los comandos del sistema en marcha (incluida la
  tabla que traduce los de desarrollo) y **`docs/CERTIFICADO_EN_LOS_EQUIPOS.md`**: cómo
  instalar el certificado interno en Android, iPhone/iPad, Windows, macOS, **Linux
  (Arch, Fedora, Ubuntu)** y televisores.
- **Revisión de seguridad final** ([`docs/REVISION_SEGURIDAD_FASE_10.md`](docs/REVISION_SEGURIDAD_FASE_10.md)):
  secretos (703 archivos sin hallazgos), dependencias (0 vulnerabilidades en
  producción), sesiones, autorización, superficie expuesta y datos clínicos — con lo
  que queda abierto y por qué (HSTS deliberadamente fuera, CSP pendiente de la
  identidad de marca, copia externa del respaldo por decidir).
- **Lectura de las sesiones clínicas desde la ficha del paciente**: la tarjeta
  «Sesiones clínicas» lista las atenciones y cada una se abre en modo lectura (motivo,
  examen, procedimientos con su pieza, diagnóstico, indicaciones, próxima cita, firma).
  Antes se veía que había sesiones, pero no se podía leer ninguna.

### Corregido

- **Buscar en la cola de `/flujo` dejaba la pantalla sin paciente en curso** y, con
  él, sin las acciones de la barra: el filtro se aplicaba a la jornada entera antes de
  resolver qué cita estaba en curso. Ahora el filtro es de la lista y la selección se
  resuelve sobre la jornada completa (lo destapó la aceptación con una jornada
  sembrada de verdad).
- **Los eventos publicados mientras otro servicio arrancaba se perdían.** La lista de
  colas es una foto y el publicador entregaba solo donde ya había cola: con la pila
  recién levantada, 10 altas de paciente y 30 hallazgos se quedaron sin proyectar en
  reportes (y el mismo agujero alcanzaba a la auditoría y a las pantallas). Ahora el
  publicador declara las colas de los consumidores conocidos **antes** de su primer
  envío, y la lista es la de los cinco servicios que de verdad consumen (una prueba la
  compara con el código).
- **El número del récipe viajaba como entero** en los eventos del seed y el
  consumidor de reportes lo descartaba como carga inválida: el reporte de recetas
  quedaba en cero. Ahora viaja formateado (`RX-900001`), como lo publica el servicio.
- **El gateway moría al arrancar** si faltaba `apps/gateway/.env`: `node --watch` no
  tolera un `--env-file-if-exists` inexistente (medido con Node 22 en Fedora). El
  bootstrap lo crea vacío.
- **La impresión en modo oscuro salía con los colores del tema**: las páginas
  imprimibles usan los mismos tokens que la aplicación, así que un equipo en modo oscuro
  imprimía el odontograma con líneas claras sobre blanco y los dibujos casi invisibles.
  Ahora la página imprimible fuerza la paleta clara mientras está montada (y devuelve el
  tema al salir), el papel es blanco pase lo que pase y los PDF del servidor fijan el
  esquema de color explícitamente.
- **En la interfaz ya no se habla de fases**: las tarjetas de módulo llevaban un badge
  «Fase N» y varios textos decían «llega en la Fase 6» cuando esa funcionalidad ya
  existía. Se quitaron del código visible, se reescribieron esos textos y `/recepcion`
  (que caía en «módulo en construcción») redirige a Secretaría.
- **`/secretaría` no mostraba el nombre abreviado** del paciente cuando su segundo
  nombre empieza en minúscula («Alexander de Jesús Peña» → «Alexander D.»): la prueba
  de humo replicaba mal la regla real (`abbreviateName`).

### Lo que destapó la validación real (28 hallazgos)

Los ocho primeros de la lista están en el registro de
[`INSTALL.md` §20.1-bis](infra/fedora/INSTALL.md); el resto salió al desplegar, probar
desde otros equipos y usar el sistema como se usa en un consultorio. Los que más
importan, porque **no se ven leyendo el código**:

- `pg_hba.conf` de Fedora deja `ident` en TCP: **ningún servicio entra por la red**
  aunque la contraseña sea correcta.
- `TELEGRAM_MODE=polling` no existe (el *long polling* es el transporte, no un modo) y
  el servicio no arrancaba con él.
- Faltaba `EVENTS_DATABASE_URL` en el despliegue: cada servicio habría usado **su** base
  para la cola y los eventos no habrían llegado a los demás.
- `STORAGE_ROOT` y `STORAGE_MAX_UPLOAD_MB` no los lee nadie (los reales son
  `STORAGE_DIR` y `MAX_FILE_BYTES`): el almacén quedaba en `/opt`, de solo lectura.
- La exportación de reportes a PDF respondía **503** porque `reporting` no definía
  `PLAYWRIGHT_BROWSERS_PATH`.
- El rol de respaldo no leía nada por crearse `NOINHERIT` (la pertenencia a
  `pg_read_all_data` queda sin efecto), y `pg_read_all_data` no cubre los esquemas
  `drizzle`/`pgboss`.
- El restablecimiento se quedaba **mudo** esperando una contraseña; ahora ninguna
  herramienta del despliegue pregunta y, si falta una credencial, falla diciendo cuál.
- El tablero sin `sudo` inventaba nueve alertas falsas (no podía leer los entornos).
- Buscar en la cola de `/flujo` dejaba la pantalla sin paciente en curso.

## [Fase 9] — Reportes, KPIs y auditoría · 2026-10-04 · tag `fase-9`

### Añadido

- **`services/reporting` (nuevo, puerto 4008, base `odonto_reporting`)**: **read model propio
  alimentado por eventos** ([ADR 0019](docs/adr/0019-reportes-y-kpis.md)) — ningún reporte consulta
  las bases operativas. Proyecta `patients.patient.*`, `scheduling.request.*`, `scheduling.appointment.*`
  (con **todas** las marcas de tiempo del ciclo), `scheduling.capacity.changed`, `clinical.record.*`,
  `clinical.session.*`, `clinical.prescription.*`, `odontogram.finding.*` y `notifications.message.*`
  en `dim_patient`, `dim_day_capacity`, `fact_request`, `fact_appointment`, `fact_clinical_session`,
  `fact_prescription`, `fact_prescription_item` y `fact_tooth_finding`; idempotente por `eventId`
  (`processed_events`) y con el estado de la cita «solo hacia adelante» (un evento tardío no la
  devuelve a `programada`).
- **Cinco vistas materializadas** (`mv_daily_kpis`, `mv_funnel`, `mv_oral_health`, `mv_demographics`,
  `mv_prescriptions`), refrescadas **al cerrar cada lote de eventos** (solo las afectadas) y por un
  **job nocturno** a la hora configurada, con su bitácora en `report_refreshes`
  ([ADR 0040](docs/adr/0040-refresco-del-read-model-de-reportes.md)). `POST /internal/v1/reporting/refresh`
  las rehace a mano y `GET /internal/v1/reporting/status` dice cuánto hay y cuándo se refrescó.
- **Los seis reportes del [ADR 0019](docs/adr/0019-reportes-y-kpis.md)**, todos con los mismos filtros
  (fecha, rango de edad, sexo y estado) y la misma forma de documento (`ReportDocument`: cifras,
  series, tabla y notas): **embudo y tasa de inasistencia** (por día, semana o mes), **ocupación de
  la agenda** con horas pico, **demografía** (pirámide por tramos y sexo), **perfil clínico**
  (diabetes, hipertensión, cardiopatía, alergias, anticoagulados, bifosfonatos y otros), **salud bucal**
  (prevalencia de caries, obturaciones y ausencias por pieza) y **recetas por medicamento**.
  `GET /api/v1/reports/summary` sirve el tablero del día.
- **Exportación CSV y PDF** de cualquier reporte con los mismos filtros: CSV con **BOM UTF-8**,
  separador `;`, CRLF y **coma decimal** (`buildCsv`, en contratos, con pruebas: es lo que hace que
  Excel en español abra los acentos y sume los decimales), y **PDF A4 por Chromium** con el membrete
  de la clínica, para imprimir sin depender del navegador.
- **Módulo `/reportes`**: tablero del día, seis pestañas, filtros combinables, **gráficas con
  Recharts** (`bar`, `stacked-bar`, `line`, `pie` y pirámide por sexo), tabla con el tipo de cada
  columna, avisos del documento, descarga CSV/PDF, **impresión** (el armazón se oculta solo al
  imprimir) y aviso explicativo cuando falta `reports:clinical`.
- **Módulo `/auditoria`**: búsqueda por rango de fechas —**el día completo en Venezuela**, no
  medianoche UTC—, usuario, acción (las 53 del catálogo, todas con etiqueta), tipo y **campo**
  cambiado, lista paginada con el motivo y **diálogo de detalle con el diff antes/después**
  (valor anterior tachado, nuevo en negrita), autor, IP, petición y navegador, más
  `GET /api/v1/audit/events/export.csv` con los mismos filtros (tope de 5.000 eventos, avisado en la
  última fila).
- **Permiso `reports:clinical`** ([ADR 0039](docs/adr/0039-reportes-clinicos-con-permiso-propio.md)):
  los reportes operativos (embudo, ocupación, demografía) siguen con `reports:read` —los tres roles—
  y los clínicos (perfil clínico, salud bucal y recetas) exigen el permiso nuevo, que tienen `admin`
  y `odontologo`. **Los permisos viajan en el token: hay que volver a entrar.**
- **Los eventos llevan lo que el consumidor necesita** ([ADR 0041](docs/adr/0041-el-evento-lleva-lo-que-el-consumidor-necesita.md)):
  `patients.patient.created|updated` publica el bloque `patient` (sexo, estado, fecha de nacimiento),
  `clinical.record.created|updated|signed` publica `profile` (códigos de alerta clínica calculados con
  la misma función que usa la pantalla del consultorio y `sectionKey`) y `clinical.session.created|closed`
  publica `session` (procedimientos en código, sin recortar).
- **`npm run smoke:reporting`** (81 comprobaciones): el recorrido completo por el gateway —alta,
  teléfono editado con motivo, cita, aviso, historia firmada con diabetes y alergia, sesión cerrada,
  récipe emitido y tres hallazgos del odontograma— y después los seis reportes, el CSV, el PDF, los
  permisos de la secretaría y la auditoría del teléfono. **`npm run e2e:reportes`** (37 comprobaciones)
  recorre `/reportes` en Chromium —seis pestañas, gráficas, filtros y descargas— y el diff de
  `/auditoria`, con captura final.
- **`npm run reports:latencia`**: llena el read model con **10.000 citas y 3.000 pacientes** sintéticos
  y cronometra los seis reportes por el gateway. Medido: **3–8 ms por reporte** (el criterio pedía
  menos de 2 s).

### Cambiado

- **El gateway ya tiene a quién preguntar**: `/api/v1/reports/**` apunta al puerto 4008; el servicio
  entra en `npm run dev`, en la pila fija (`stack:fijo`), en PM2 (Windows y Fedora), en
  `db:migrate`, en `db:verify-migrations` y en `npm run audit` (que ya no lo trata como fase futura).
- **`npm run test:integration`** da a la suite de reportes una **base temporal propia** (creada y
  migrada al vuelo, borrada al terminar) y corre con **cuatro workers** en vez de 68 en paralelo: la
  suite de reportes afirma cifras absolutas sobre su read model y las demás esperan a que los
  servicios en marcha auditen sus eventos por el outbox. Antes fallaba una suite distinta en cada
  corrida; ahora son **695 pruebas en verde y reproducibles**.
- La suite de reportes **solo proyecta los eventos que ella misma publica**: el publicador reparte
  cada evento entre todas las colas `domain-events.*`, incluida la de prueba, así que sin ese filtro
  las cifras se mezclaban con las del humo.
- El grupo de atajos de `/flujo` tiene **nombre accesible** («Atajos del día»): había dos botones
  «Buscar paciente» en pantalla (el atajo y el de la pantalla vacía) y la prueba de punta a punta no
  podía distinguirlos.

### Corregido

- **El perfil clínico se perdía si los eventos llegaban desordenados.** El alta del paciente y el
  guardado de su anamnesis los publican **dos servicios distintos**, sin orden garantizado: medido en
  el humo, el alta llegó a procesarse **un segundo después** de la firma de la historia, el `UPDATE`
  del perfil no encontró fila y el reporte de crónicos contaba cero diabéticos y cero alérgicos. Ahora
  el perfil se guarda en una tabla de paso (`patient_profiles`) y se aplica cuando la ficha aparece,
  además del camino normal. Hay una prueba de integración que emite los eventos **al revés** a
  propósito.
- **Una migración escrita a mano podía quedar invisible para el migrador.** El `when` de la migración
  de las vistas materializadas era mayor que el de la migración que `drizzle-kit` generó después, y el
  migrador solo aplica lo que tiene `when` mayor que lo último aplicado: la tabla nueva no se creaba y
  el fallo era silencioso. El `_journal.json` quedó con marcas crecientes.
- **El `snapshot.json` escrito a mano llevaba BOM** y `npm run db:generate:reporting` moría con
  «Unexpected token» al leerlo. Se limpió (los `.json` se escriben sin BOM).

### Notas de despliegue

- **Hay que volver a entrar** tras desplegar: el permiso `reports:clinical` viaja en el token.
- El **seed de demostración no emite eventos** (inserta por SQL y no ensucia la auditoría), así que el
  read model nace vacío y se llena con lo que se hace en la aplicación. El **seed determinista
  completo** —con historias, sesiones, odontogramas y récipes— es el entregable de la Fase 10
  (§12 del plan).
- El **cupo efectivo** de un día (el que sale de las plantillas de franjas) no viaja en ningún evento:
  el tablero usa como suelo las citas asignadas y el detalle por día lo dice en sus notas. Lo suyo es
  publicar el cupo resuelto en los eventos de cita (anotado para la Fase 10).

## [Pantallas] — Reemitir el enlace de una pantalla · 2026-10-04

### Añadido

- **Botón «reemitir el enlace» en `/pantallas`**: del token de dispositivo el servidor guarda solo su
  hash, así que el enlace **no se puede volver a mostrar** —el diálogo lo avisa y hasta ahora la única
  salida era registrar la pantalla otra vez—. Ahora, en la fila de cada pantalla activa hay un botón
  que emite un token nuevo en identity, apunta la pantalla a ese token y **revoca el anterior**: el
  enlace viejo muere en el acto y el nuevo se enseña una vez, con los botones **Copiar enlace** y
  **Abrir la pantalla** de siempre. La sesión que ya estuviera abierta en el televisor caduca sola con
  su JWT de 15 minutos.
  - El `PATCH /api/v1/screens/devices/:id` acepta `tokenId` (`screens:manage`); es el único cambio de
    contrato. Si el segundo paso falla, se revoca el token recién emitido para no dejar uno huérfano
    (mismo patrón que el alta).
  - Casos de uso: se perdió el enlace, o hay que configurar un segundo equipo con la misma pantalla.
- Prueba de integración: tras reemitir, el token viejo recibe **403** al pedir la sala, el nuevo
  responde **200**, y sin `screens:manage` no se puede reemitir.

## [Corrección] — El bot no se queda callado y `db:reset` queda blindado · 2026-10-04

### Añadido

- **Plantilla `.env.example` en cada servicio** (identity, patients, scheduling, notifications,
  clinical, odontogram, screens, reporting): qué claves existen, cuáles son obligatorias, cuáles
  opcionales y su valor por defecto. Convención clara: **sin comentar = debe estar en el `.env`**
  (lo repone `db:bootstrap`, más el token del bot); comentada = opcional. El modelo real sigue
  estando en `services/<svc>/src/config.ts`.
- **`npm run env:check`**: compara cada `.env` con su plantilla y dice qué claves faltan **y qué se
  pierde** con cada una (sin imprimir valores). `npm run dev:check` lo avisa también antes de
  arrancar. Nace de un caso real: un corte de luz dejó los ocho `.env` con el tamaño de antes y el
  contenido a ceros; al rehacerlos, el `TELEGRAM_BOT_TOKEN` —que `db:bootstrap` no conoce— se quedó
  por el camino y **el bot pasó a modo simulado sin que nada lo dijera** hasta que dejó de contestar.

### Cambiado

- **`db:reset` siempre siembra los usuarios**, para que la aplicación quede **lista para usar**
  (admin, recepción y el odontólogo, con contraseña temporal). Se retiró la bandera
  `--sin-sembrar`, que solo servía para dejar el sistema inservible: sin usuarios no entra nadie,
  con ninguna contraseña. Y una bandera desconocida ya no se ignora en silencio: el comando se
  detiene y dice cuáles valen (ese descuido es justo lo que hizo creer que
  `seed:demo -- --sin-sembrar` no sembraba usuarios).
- **El login explica el caso «no hay usuarios»**: si la tabla está vacía (base recién creada, o
  migrada sin seed), responde `401` con `type …/errors/no_users` y el detalle «crea los usuarios
  iniciales con `npm run seed:users`», en vez de «usuario o contraseña incorrectos», que mandaba a
  buscar el problema donde no estaba. `dev:check` también avisa antes de arrancar.

### Corregido

- **El asistente de Telegram ya no deja al paciente sin respuesta cuando falla algo de
  fuera.** Probando el flujo con el bot (2026-10-04) llegó un `ECONNREFUSED 127.0.0.1:4002` a
  mitad del paso del documento —el servicio de pacientes se estaba reiniciando—: el error subía
  al bucle del canal, se registraba en el log y **la persona no recibía nada**, sin saber si
  esperar o volver a escribir. Ahora, si un paso falla por algo de fuera, el paciente recibe el
  aviso `servicio_no_disponible` (plantilla nueva, editable) **y se le repite el paso**; la
  conversación no se mueve, así que reenviar el dato la retoma donde estaba.
- **Reintento corto en las llamadas internas**: las **lecturas** (buscar paciente por documento,
  estado de la solicitud, cita) se repiten hasta tres veces con espera creciente ante un fallo
  pasajero —un servicio reiniciándose, un 5xx—; las **escrituras** (alta de paciente, solicitud,
  cancelación) solo se repiten si la petición **no llegó a salir** (`ECONNREFUSED`), porque
  repetir a ciegas podría crear dos tickets. Un 4xx no se reintenta nunca.

### Añadido

- **`tools/dev-check.mjs` comprueba las 9 bases antes de arrancar**: si falta alguna (un
  `db:reset` a medias, por ejemplo) lo dice con esas palabras y no arranca media pila.
- **Bloqueo de mantenimiento** ([`tools/lib/mantenimiento.mjs`](tools/lib/mantenimiento.mjs)):
  mientras `db:reset` borra y recrea bases, deja `tmp/mantenimiento.lock` con su PID; `dev:check`
  y `stack:dev`/`stack:fijo` se niegan a arrancar mientras esté vivo. Si el proceso que lo creó
  ya no existe, el bloqueo está **caducado** y se limpia solo: no es un candado ciego que se
  quede pegado (misma lección que el [ADR 0037](docs/adr/0037-una-sola-pila-a-la-vez.md)).

### Cambiado

- **`db:reset` más difícil de usar mal**: guarda contra un `PG_ADMIN_URL` que no sea de esta
  máquina (salvo `--remoto`, dicho a propósito), deja el bloqueo mientras trabaja (y lo quita
  siempre, incluso si falla), y con `--sin-sembrar` avisa en grande de que la base queda **sin
  usuarios** y que hace falta `npm run seed:users`.

## [Herramientas] — Empezar de cero: `npm run db:reset` · 2026-10-04

### Añadido

- **`npm run db:reset`** ([`tools/db-reset.mjs`](tools/db-reset.mjs)): **borra absolutamente todo**
  y deja el sistema recién migrado y con los usuarios sembrados. Hacía falta porque los seeds
  `--reset` solo quitan lo ficticio: la historia clínica, las sesiones, los récipes y el odontograma
  **no se pueden borrar** por diseño (son documentos inmutables,
  [ADR 0034](docs/adr/0034-sesion-clinica-evolucion.md),
  [ADR 0036](docs/adr/0036-recipe-emitido-documento-archivado.md)), así que no había forma de dejar
  la base limpia para probar desde cero.
  - Borra las **9 bases** `odonto_*` (los 8 servicios y la cola `pg-boss`) con
    `drop database … with (force)` y el **contenido de `storage/`** (adjuntos de fichas y sesiones,
    y los PDF de los récipes).
  - Después reconstruye solo: `build:node` → `db:bootstrap` → `db:migrate` → `seed:users`.
  - **Solo consola y solo con `--yes`**: sin el flag explica lo que haría y sale con código 1;
    ningún servicio, ruta ni botón la llama. Se niega a correr con la pila en marcha (los servicios
    caerían en bucle contra una base que ya no existe) y con `NODE_ENV=production`.
  - **No toca** los roles de PostgreSQL, los `.env`, las claves del JWT ni la configuración; la lista
    de bases es cerrada (nunca se construye con datos del usuario) y la ruta de `storage/` se
    comprueba antes de borrar. Flags: `--solo-bases` (conserva los archivos) y `--sin-sembrar`.

## [Fase 8] — La página unificada del flujo diario · 2026-10-04

### Añadido

- **`/flujo`** ([ADR 0038](docs/adr/0038-permisos-del-odontologo-en-el-flujo.md)): **el día completo en
  una sola pantalla** para la odontóloga que trabaja sin asistente.
  - **Cola del día** a la izquierda: selector de fecha (anterior, hoy, siguiente y campo de fecha),
    buscador por nombre, documento, teléfono o ticket, los contadores del servidor y una fila por cita
    con su hora, su estado y sus llamados.
  - **Paciente en curso** en el centro, con **el mismo expediente de `/consultorio`**: el área del
    paciente salió a `PatientWorkspace` (historia, sesión —con adjuntos y récipe— y odontograma), así
    que la ruta unificada no puede quedarse corta respecto a las rutas individuales.
  - **Acciones de secretaría en la barra superior**: registrar llegada, llamar (el llamado que sale en
    la pantalla de la sala), pasar a consulta, marcar atendido, marcar inasistencia, **llamar fuera de
    orden** y el historial de la cita. Son los mismos diálogos y la misma máquina de estados que
    `/secretaria`; al pulsar una fila de la cola, todo actúa sobre la cita que el doctor tiene delante.
  - **Atajos**: `F2` buscar paciente, `F4` llamar y `F8` cerrar la sesión clínica (con la pregunta del
    récipe). No disparan con un diálogo abierto ni con `Ctrl`/`Alt`/`Meta`, y cada uno tiene su botón
    porque en la tableta no hay teclado. **`F8` cierra la visita, no la sesión del sistema** (esa sigue
    en el panel inferior).
  - **Modo tableta** comprobado a 820 px: una sola columna (cola arriba, expediente debajo) y botones
    grandes.
- **`npm run e2e:flujo`**: la prueba del día completo en Chromium sobre la pila real, con **24
  comprobaciones**. La doctora entra con su usuario `odontologo`, registra al paciente, le da cita,
  registra la llegada, llama con `F4`, lo pasa a consulta, escribe y cierra la sesión con `F8` y marca
  la cita atendida **sin salir de `/flujo`** (la URL se vigila en cada paso); después comprueba que
  `/secretaria` y `/consultorio` siguen en pie y que la consola y la red quedan limpias.
- **Las piezas puras del flujo, con 15 pruebas**: qué cita abre la pantalla (en consulta, llamada, en
  sala y, si no hay ninguna, la próxima del día), cómo se ordena y filtra la cola, y a qué acción
  traduce cada tecla.

### Cambiado

- **El rol `odontologo` gana `scheduling:write`** y la máquina de estados le abre la **inasistencia**
  ([ADR 0038](docs/adr/0038-permisos-del-odontologo-en-el-flujo.md)): sin eso, las cinco acciones del
  flujo le respondían 403 y la Fase 8 no podía funcionar. Notificar (`scheduling:notify`) y autorizar
  sobrecupo (`scheduling:overbook`) siguen fuera de su alcance, y **cancelar y reprogramar** siguen
  respondiendo 409 porque la máquina de estados no se las autoriza; una prueba de integración lo fija.
  Los permisos viajan en el token: **tras desplegarlo hay que volver a entrar**.
- **`/consultorio` conserva su comportamiento**, pero comparte el expediente con `/flujo` y gana el
  aviso de primera visita también cuando se abre directamente la pestaña de la sesión.

### Corregido

- **La sesión nacía sin la cita que la respalda**: la lista de citas del día que ofrece «la cita que
  respalda la sesión» se pedía una vez, al abrir el paciente, así que para cuando el doctor pulsaba
  «Abrir sesión» ya estaba vieja (el paciente había pasado a consulta). La sesión se abría **sin**
  `appointment_id`, «atendido» pedía un motivo y la visita perdía su enlace con la agenda. Ahora la
  cita se resuelve **al abrir** (releyendo la agenda) y `/flujo` pasa la cita que tiene delante. El
  respaldo tampoco exige estar «en consulta»: vale la cita llamada o la que espera en la sala.
- **Cerrar una sesión ya no pierde lo último escrito**: el cierre guarda lo que quede pendiente antes
  de cerrar (el autoguardado espera 1,2 s desde la última tecla y el cierre es inmutable), con el
  botón o con `F8`.
- En la columna estrecha de `/flujo`, la fila de la cola partía la hora y recortaba el nombre; ahora
  cada cita ocupa dos líneas. Y mientras la jornada se está pidiendo se ve el indicador de carga en
  vez de «no hay citas».

## [Herramientas] — Una sola pila a la vez · 2026-10-04

### Añadido

- **`npm run stack:status` / `stack:dev` / `stack:fijo` / `stack:down`**
  ([ADR 0037](docs/adr/0037-una-sola-pila-a-la-vez.md)): los servicios, la puerta y la
  interfaz ocupan puertos fijos, así que **no puede haber dos pilas vivas** y ahora hay un
  comando que lo dice y otro que cambia de modo. Los puertos son la fuente de verdad (sin
  archivo de candado, que se queda obsoleto cuando un proceso muere de golpe): `stack:status`
  muestra puerto, servicio, proceso, desde cuándo, si tiene recarga y si es de PM2, y
  `stack:down` para la pila entera (PM2 incluido) sin tocar programas ajenos.
- **La guardia del segundo arranque**: `predev` llama a `stack:guard`, que falla con el
  retrato de lo que está corriendo y los comandos para cambiar de modo, en vez de dejar que
  el puerto falle a medias.
- **La interfaz va dentro de la pila `fijo`**: PM2 levanta también Vite (lanzado como
  `node node_modules/vite/bin/vite.js`, porque PM2 en Windows no puede lanzar `npm` sin
  shell: `spawn EINVAL`). Antes, con los servicios en PM2 había que tener una terminal
  aparte sirviendo la web: dos cosas vivas y ninguna lista que las vieran juntas.

### Cambiado

- `tools/dev-check.mjs` y `tools/dev-stop.mjs` comparten ahora **una sola tabla de puertos**
  ([`tools/lib/stack.mjs`](tools/lib/stack.mjs)) con el gestor: antes estaba duplicada en los
  dos, que es como empiezan a discrepar. `dev:stop` informa además del nombre del proceso y
  deja claro que lo que decide si un proceso se paró es el puerto, no el código de salida de
  `taskkill` (que falla también cuando el proceso ya había muerto).

### Corregido

- **Tres pilas peleando por los mismos puertos, en silencio**: `npm run dev` reintentaba en
  bucle, PM2 acumulaba reinicios y ocho procesos sueltos sin recarga servían la aplicación; al
  arreglar el récipe, la pregunta «¿es caché o hay que reiniciar?» no tenía respuesta mirando
  el sistema. Ahora `stack:status` la responde, y «una pila sin recarga» deja de ser un
  accidente invisible: aparece en el estado con su modo («fija, sin recarga»).

## [Fase 7, sesión B] — Adjuntos, récipes A5 y personalización · 2026-10-04

### Añadido

- **Adjuntos de la sesión**: `clinical_session_files` (migración `0002` de `clinical`) con
  radiografía, foto clínica, documento u otro, **pie** y **pieza FDI** opcional. Se suben y se ven
  en la sesión (cuadrícula de miniaturas y **visor con zoom** por botones, rueda y teclado), se
  descargan por endpoint autorizado —nunca por una URL pública— y se quitan **solo mientras la
  sesión es borrador**: en una sesión cerrada son parte del documento. La ficha del paciente tiene su
  propia tarjeta con los adjuntos de todas sus sesiones.
  - La **miniatura la hace el navegador** (CSS): generar miniaturas en el servidor sería una librería
    de imágenes para algo que el navegador ya sabe hacer, y el original tiene que estar accesible
    igual para el visor.
- **Récipes A5 numerados y verificables** ([ADR 0015](docs/adr/0015-recipe-a5-en-pdf.md),
  [ADR 0036](docs/adr/0036-recipe-emitido-documento-archivado.md)): borrador por sesión → **emisión**
  (número `RX-000001` de una secuencia, PDF A5 archivado con su `sha256` y código de verificación) →
  **anulación con motivo** (nunca se borra) → **reimpresión contada y auditada**.
  - **El récipe emitido es un documento cerrado**: guarda una copia de los datos del paciente
    (`patient_snapshot`) y de cada medicamento, así que corregir la ficha o editar el catálogo **no**
    reescribe lo que se entregó; lo que se descarga después es el mismo PDF, byte a byte.
  - **El PDF A5 lo compone Chromium** (Playwright) desde la plantilla del membrete: A5 exacto
    (148 × 210 mm), membrete desde `CLINIC`, logo del consultorio, tabla de medicamentos, indicaciones
    generales, QR de verificación y bloque de firma con MPPS y especialidad. Chromium se levanta una
    vez por proceso y se reutiliza; si falta un dato del membrete, el editor **avisa antes de emitir**.
  - **El QR se comprueba de ida y vuelta**: se rasteriza y se **lee con un decodificador real**
    (`jsqr`), que es lo que garantiza que un teléfono llegue a la página de verificación.
  - **`GET /api/v1/clinical/verify/:code` es pública** (el gateway la deja pasar sin token): la abre
    quien tiene el papel en la mano y confirma que el récipe es auténtico **sin datos clínicos** —ni
    diagnóstico, ni medicamentos, ni cédula, solo el nombre abreviado del paciente y si está vigente o
    anulado—. El código usa un alfabeto sin 0/O ni 1/I/L y se acepta con guion, sin guion y en
    minúsculas. La página `/verificar/<código>` vive fuera del shell, sin sesión.
  - **Catálogo de 25 medicamentos de odontología** sembrado en la migración (nombre, presentaciones,
    vías, dosis/frecuencia/duración habituales e indicaciones) con autocompletado en el editor; lo que
    se elige se copia a la línea del récipe y se puede editar.
  - **`package.json`**: `npm run smoke:prescription` (32 comprobaciones por el gateway, incluida la
    verificación sin token).
  - **`packages/storage`**: el almacén de binarios (`BlobStore` en disco) sale de `patients` a un
    paquete propio que comparten pacientes y clínica; `services/clinical` gana `STORAGE_DIR`,
    `PUBLIC_APP_URL`, `PDF_CHROMIUM_PATH` y `PDF_TIMEOUT_MS`.
- **El consultorio se pone con otro odontólogo editando un solo archivo**
  ([`packages/contracts/src/clinic.ts`](packages/contracts/src/clinic.ts), decisión del 2026-10-04):
  nombre, razón social, dirección, ciudad, teléfonos, correo, RIF, sitio web, logo y **los
  odontólogos que firman** (usuario, nombre, MPPS, especialidad, colegiatura). Vive en
  `@odontocrm/contracts` —el paquete que ya importan los ocho servicios y la interfaz— para no mover
  cableado: no hay rutas nuevas, ni endpoints, ni migración, ni pantalla de ajustes, y el mismo dato
  no se repite en tres `.env`. Lo que quede en `null` **no se imprime**, y
  `letterheadMissingFields()` enumera lo que falta para un membrete completo.
  - Los valores por defecto de agenda, notificaciones y pantallas (`CLINIC_NAME`, `CLINIC_ADDRESS`
    y `CLINIC_EMAIL`) salen de esa sección; las variables del `.env` siguen mandando cuando existen.
  - **Las cuentas de odontólogo las genera `npm run seed:users` desde `CLINIC.dentists`**: añadir un
    odontólogo a la lista (o cambiar el titular) es todo lo que hay que hacer para que exista su
    cuenta con su nombre y su MPPS.
  - [`assets/clinic/`](assets/clinic/README.md) es donde se deja el logo del membrete.
  - 15 pruebas nuevas: la sección completa, los usuarios sin repetir, el odontólogo que firma según
    el usuario y que los tres servicios leen de ahí (no de un literal).

### Corregido

- **El récipe le decía «nacido» a una paciente** (visto en la revisión del impreso: «María … 38 años
  · nacido el 1988-04-12»). Ahora la línea del paciente usa el **sexo** para concordar —«nacida el
  12/04/1988»— y, cuando no consta o es «otro», la forma que sirve para cualquiera: «nació el …»,
  sin suponer. La fecha se imprime como se lee aquí (`12/04/1988`) en vez de en ISO, el sexo entra en
  la copia de los datos del paciente que guarda el récipe emitido, y una prueba del texto lo fija
  para los tres casos.
- **La subida de archivos del paciente nunca funcionó por HTTP** (encontrado al probar los adjuntos
  de la sesión): con `attachFieldsToBody`, `@fastify/multipart` deja **cada campo de texto como un
  objeto** (`{ fieldname, value }`) y la ruta los pasaba tal cual al esquema de Zod, así que
  respondía `400 — se esperaba string, se recibió object`. Ninguna prueba lo veía porque las de
  integración llaman al servicio directamente y la de humo no subía archivos. Ahora los campos pasan
  por `multipartFieldValue()` (`@odontocrm/kernel`) en las dos rutas de subida, y
  `npm run smoke:patients` **sube, lista y descarga** un adjunto para que no vuelva a pasar.
- El encabezado del récipe tomaba el **resumen de la sesión** («Endodoncia multirradicular · pieza
  36») en vez del nombre del paciente; ahora el nombre sale de la ficha del paciente.

## [Fase 7, sesión A] — Sesiones clínicas · 2026-10-04

### Añadido

- **La evolución del paciente ya tiene su documento** ([ADR 0034](docs/adr/0034-sesion-clinica-evolucion.md)):
  `clinical_sessions` (migración `0001` de `clinical`) con el **documento del día** en `jsonb`
  —motivo de la visita, anamnesis breve y cambios, **signos vitales** (TA, FC, temperatura, SpO₂ y
  peso, con rangos validados en el contrato), examen intraoral y periodontal, **procedimientos del
  catálogo** con pieza y caras, materiales e insumos, diagnóstico, indicaciones postoperatorias,
  próxima cita y notas internas—, **numeración por paciente** (`S-000001`, con índice único y
  reserva transaccional) y estados `borrador → cerrada` con `amended_from_id`.
- **`packages/contracts`**: contrato de la sesión con 28 procedimientos y 16 materiales de catálogo
  («otros» inputable, que es lo que permite contarlos en los reportes de la Fase 9), rangos de los
  signos vitales —una tensión al revés o un peso de 900 kg son errores de tecleo, no datos—,
  `clinicalSessionCanClose` y los textos de resumen. Se añade `common/optional.ts` (campos
  opcionales normalizados a `null`, compartidos con la historia clínica) y el mapeo de las alertas
  clínicas al **semáforo de riesgo** de la pantalla del consultorio. 18 pruebas nuevas.
- **`services/clinical`**: sesiones con **autoguardado idempotente** (sin cambios no escribe nada, y
  la comparación es por contenido canónico porque `jsonb` reordena las claves), **cierre** que exige
  contenido mínimo y deja la sesión inmutable, **enmienda** que abre una sesión nueva con el
  contenido copiado y su motivo, y rutas públicas (`/clinical/patients/:id/sessions`,
  `/clinical/sessions/:id`, `/close`, `/amend`, `/clinical/appointments/:id/sessions`) más la ruta
  interna de estado. Eventos y auditoría por outbox con `entityType: 'clinical_session'`.
  7 pruebas de integración nuevas contra PostgreSQL real.
- **«Atendido» con respaldo clínico**: `appointments.clinical_session_id` (migración `0003` de
  `scheduling`) y verificación **contra el servicio clínico** antes de aceptar la sesión que evita el
  motivo: existe, es del mismo paciente y está cerrada. Antes bastaba con mandar un identificador
  inventado para saltarse la regla; sin sesión, el «atendido» sigue exigiendo motivo auditado.
- **Interfaz**: pestaña **Sesión clínica** en `/consultorio` (con la sesión abierta en el rótulo),
  formulario con **autoguardado** («Sin cambios / Sin guardar / Guardando / Guardado a las 10:23»),
  selector de la cita del día al abrir, procedimientos con pieza y **caras** (que se limpian al
  cambiar de pieza), materiales, cierre con nota, corrección de una sesión cerrada y la **evolución
  anterior** a la vista. El odontograma marca cada hallazgo **dentro de la sesión** (`sessionId`) y
  el diálogo de «atendido» de la secretaría detecta la sesión cerrada y ya no pide motivo.
- **La pantalla del consultorio ya muestra los datos críticos del paciente en curso**
  ([ADR 0035](docs/adr/0035-datos-criticos-leidos-no-empujados.md)): alergias, crónicos y
  anticoagulantes con semáforo de riesgo, **leídos** de la historia clínica al construir el estado
  (lo empujado en `room_state` queda como respaldo si el servicio clínico no responde).
- `npm run smoke:clinical`: 30 comprobaciones de punta a punta por el gateway real (abrir,
  autoguardar, no cerrar en blanco, cerrar, no editar lo cerrado, enmendar, ligar el hallazgo del
  odontograma a la sesión, «atendido» con y sin sesión, y permisos de la secretaría).

### Corregido

- **El `CHECK` del canal de la solicitud no conocía `whatsapp`** (migración `0002` de `scheduling`):
  el ADR 0029 añadió el canal a `CHANNELS` en la Fase 4.1, pero el constraint de la base se quedó con
  los cuatro canales anteriores, así que una solicitud de WhatsApp real habría chocado contra él. Se
  realinea con el contrato, que es la única fuente de verdad.
- **La suite de pantallas compartía base con el servicio en desarrollo**: los eventos de la suite de
  agenda los proyectaba el servicio vivo y dejaban a un paciente ajeno «en el consultorio»; la prueba
  lee un único paciente y fallaba por datos de otra suite. Ahora limpia lo que no es de su corrida
  antes de empezar.

### Cambiado

- **El borrador de la sesión no genera auditoría**: el acto clínico queda registrado al **cerrar**
  (created/closed/amended son los únicos eventos del catálogo) y el autoguardado se limita a escribir
  el documento.
- **El autoguardado exige el documento completo** (`.required()` en el contrato): con los `default`
  del esquema, un cliente que mandara solo el campo que tocó borraría en silencio los procedimientos
  que ya estaban (responde `400`).

## [Fase 6, sesión B] — Odontograma FDI · 2026-10-04

### Añadido

- **El informe puede llevar detrás el historial de cambios.** La vista de impresión tiene una
  casilla —«Incluir el historial de cambios (con fechas)»— que añade al documento la evolución del
  odontograma: fecha y hora, pieza, cara (con su nombre clínico), condición, estado, qué pasó
  (registrado, actualizado, superado, eliminado), quién y el motivo cuando lo hay. Va **en orden
  cronológico** —lo primero que pasó, primero—, porque es una historia clínica y no una bandeja de
  entrada, y si el historial llegó al tope (500) el papel lo dice: uno recortado en silencio se lee
  como si no hubiera más. Sin marcar la casilla, el informe sale como antes.
- **`packages/contracts`**: contrato del odontograma — nomenclatura **FDI** de dos dígitos
  (permanentes 11–48 y temporales 51–85, con la dentición **deducida del propio número**, sin que
  el cliente pueda contradecirla), el **dominio geométrico** de §7 del documento (los cinco
  polígonos de una pieza en un lienzo de 100×100, el reparto de cuadrantes 18→28 y 48→38 y qué
  cara hay bajo un punto: `surfaceAtPoint`), la **máquina de teclado** de la carga rápida
  (`quickEntryKey`: número de pieza + tecla de condición, con la minúscula en rojo «pendiente» y la
  mayúscula en azul «completado») y las reglas de la **captura por excepción**. 24 pruebas nuevas.
- **`services/odontogram`** (nuevo, puerto 4006, base `odonto_odontogram`): odontograma **uno por
  paciente** con hallazgos **por excepción** (una fila por pieza/cara/condición: la pieza sana es la
  ausencia de fila), **histórico append-only** `tooth_finding_history` (`registrado`, `actualizado`,
  `eliminado`, `superado`), motivo y actor en cada cambio, constancia de impresión con su actor y
  catálogo de eventos `odontogram.finding.*` con auditoría por outbox
  (`entityType: 'odontogram'`). Ruta interna de resumen para los reportes de la Fase 9.
  4 pruebas de integración contra PostgreSQL real.
- **Interfaz**: pestañas **«Historia clínica» / «Odontograma»** en `/consultorio`, con el
  odontograma **SVG geométrico** interactivo (se pulsa la cara, no un botón: `surfaceAtPoint`
  resuelve qué cara se tocó, con la mandíbula volteada), **carga rápida por teclado** («16» + `c`
  marca caries oclusal pendiente; `C` la marca completada; `a` ausente, `x` extracción indicada…),
  aviso cuando una pieza completa da por superadas sus caras, **deshacer**, **vista de evolución**
  por día y pieza en `/consultorio/:patientId/odontograma/historial` y **vista de impresión A4** en
  `/consultorio/:patientId/odontograma/imprimir`, que la secretaría comparte en solo lectura.

### Cambiado

- **La pieza completa manda sobre las caras** ([ADR 0031](docs/adr/0031-odontograma-pieza-completa-sobre-caras.md),
  **corregido por el [ADR 0032](docs/adr/0032-convivencia-de-tratamientos-con-las-caras.md)**):
  registrar `ausente` **supera** las caras de esa pieza (`resolved_at`) en la misma transacción —no
  las borra: siguen en el histórico— y en sentido contrario la API responde `409` con un mensaje que
  dice qué quitar primero. La invariante está también en la base (`chk_tooth_findings_scope`).
- **Los tratamientos ya no borran las caras** (ADR 0032, corrección de la regla anterior): `corona`,
  `endodoncia`, `implante` y `extraccion_indicada` **conviven** con la caries y la obturación, que es
  la boca normal —una corona sobre un diente obturado, un conducto con su restauración—. Antes había
  que borrar la obturación para poder marcar la corona. Solo se siguen bloqueando las parejas
  imposibles: `ausente` con cualquier otra cosa, e `implante` con `endodoncia`. La regla es
  **declarativa** (`WHOLE_TOOTH_RULES` en el contrato), con dos preguntas distintas: `conditionsConflict`
  (simétrica, para validar un lote) y `recordingConflicts` (direccional, para decidir si se puede
  registrar), y es la misma que aplican la interfaz —que desactiva el botón y explica por qué— y el
  servidor, que no se fía. Sin migración: los `CHECK` no cambian.

### Añadido

- **La fase quirúrgica del implante ya se puede registrar** (ampliación del ADR 0032): `ausente` e
  `implante` **conviven**, así que una pieza sin corona natural y con el implante colocado —o con la
  corona protésica después— deja de ser una contradicción del sistema. `corona` + `implante` sigue
  permitido (fase rehabilitada) y `endodoncia` + `implante` sigue bloqueado, que es lo imposible. El
  paso de una fase a otra es quitar `ausente` y marcar `corona` (dos toques en la hoja). En el dibujo,
  cuando hay implante el aspa de `ausente` no se pinta: el tornillo ya dice que no hay diente natural.
  Probado en el servicio, por el gateway y en el gráfico.
- **Se pueden corregir los hallazgos sin rehacer la ficha.** En la hoja de la pieza, cada hallazgo
  lleva ahora **Marcar completado/pendiente** (el error de dedo más común, a un toque), **Editar**
  —con el campo de **notas** clínicas, que existía en el modelo pero no se podía escribir desde
  ninguna pantalla— y **Quitar**, como antes. La tabla del informe impreso sigue sin acciones: es
  papel.
- **El odontograma se maneja con el dedo.** En una tableta nadie acierta una cara de 12 px, así que
  con puntero grueso (`pointer: coarse`, hook `useCoarsePointer`) el toque sobre una pieza **abre la
  hoja de la pieza** ([`ToothFindingSheet`](apps/web/src/components/odontogram/ToothFindingSheet.tsx)):
  las cinco caras, las condiciones, el estado (rojo/azul) y el borrado, todo con áreas de ≥44 px y
  en el mismo lenguaje que el teclado (la hoja construye el mismo `FindingSelection` y lo convierte
  con `findingsFromSelection`, así que **marcar tres caras deja tres hallazgos en una sola
  transacción**). Con ratón se sigue pulsando la cara exacta, y hay un botón «Marcar con botones»
  para quien no quiera teclado. Además: `touch-action: manipulation` en cada pieza (sin retardo de
  300 ms ni zoom por doble toque), arcadas con ancho mínimo mayor para que cada pieza pase de 44 px
  —se desplazan en horizontal si no caben— y marcadores múltiples en el dibujo (`markerSlots`):
  una pieza con corona y conducto enseña los dos símbolos, encogidos para que no se tapen.

### Corregido

- **Al marcar una corona, el gráfico ya no enseña el empaste de debajo** (revisión clínica del
  ADR 0032): una corona periférica recubre el muñón en sus 360°, así que lo que había antes no se
  inspecciona en boca y pintarlo dentro del círculo se lee como «¿caries dentro de la corona?». La
  corona **supera** las caras: el gráfico se queda con la corona, y la obturación (o la caries) queda
  con su `resolved_at` y su entrada en el histórico con fecha, que es el respaldo médico-legal. La
  **caries recurrente** —la filtración del margen, registrada *después*— sí se ve, porque la
  superación solo mira lo que había al poner la corona. En un lote, las caras se aplican antes que la
  condición que las cubre: el resultado no depende del orden en que la interfaz las mande.
- **Superar las caras no es excluirlas.** El modelo tenía una sola pregunta para las dos cosas, así
  que al hacer que la corona superara las caras, la caries recurrente sobre una corona habría quedado
  bloqueada (409) —justo la excepción clínica—. Ahora son dos reglas distintas
  (`supersedesSurfaces` y `excludesSurfaces`): `ausente` supera **y** excluye; `corona` supera
  y no excluye. Sin migración: son reglas de servicio, no forma de fila.
- **La leyenda no explicaba el color de los tratamientos.** Un mismo símbolo significa dos cosas
  según su color, y en el papel solo salía en rojo: ahora cada tratamiento aparece **en los dos
  colores** con su lectura («Corona: rojo indicado · azul realizado») y las dos reglas escritas
  —rojo es lo que queda por hacer, azul lo ya hecho—. De paso se unificó el criterio: la extracción
  indicada salía **siempre** en rojo aunque estuviera marcada como hecha (era una excepción escondida
  en el código); ahora sigue su estado como todo lo demás.
- **Las celdas de notas vacías del informe se quedaban en blanco.** En un documento que puede acabar
  en manos de una aseguradora, una celda vacía se lee como un olvido de captura: ahora dice **«Sin
  observaciones»** (y también cuando la nota son solo espacios), con su prueba.
- **Las piezas de la derecha del paciente tenían mesial y distal cambiados.** La arcada se dibuja como dos filas con la línea media en el centro, así que en el 16 la cara mesial mira a la **derecha** de la pantalla (hacia el 15, su vecino real); sin espejar, el dibujo llamaba «mesial» a la cara que toca el 17 —el vecino equivocado— y se registraba la caries donde no era. `archLayout` marca ahora cada pieza con `mirrorX` (cuadrantes 1 y 4, y 5 y 8 en la temporal) y la transformación y su inversa viven en el contrato (`toothGroupTransform` / `unscreenPoint`), de modo que el dibujo de pantalla, el del papel y el `hit-test` del clic aplican exactamente lo mismo ([ADR 0033](docs/adr/0033-odontograma-en-posicion-anatomica.md)). La prueba que lo protege es clínica, no geométrica: en el 16 la mesial está a la derecha, en el 26 a la izquierda y en el 46, además, la vestibular abajo.
- **Los dientes anteriores decían «Oclusal» donde va el borde incisal.** Del canino al incisivo central la cara de masticación es el **borde incisal**: `surfaceLabelFor` nombra `Incisal` en las posiciones 1–3 del cuadrante (en la hoja de la pieza, en la barra de carga rápida, en la tabla impresa, en la evolución y en las etiquetas accesibles). El dato guardado sigue siendo `occlusal` —mismo polígono, sin migración—: lo que cambia es el nombre clínico.
- **El gráfico del odontograma dibujaba las 32 piezas en el mismo sitio.** Un literal de plantilla
  mal escrito en [`OdontogramChart`](apps/web/src/components/odontogram/OdontogramChart.tsx)
  (`translate($String(tooth.x)},0)`, sin las llaves de la interpolación) dejaba el `transform` sin
  sustituir: los 16 números de cada arcada se superponían en un amasijo y pulsar una pieza *parecía*
  no cambiar nada, porque siempre se seleccionaba la misma. No lo veía ninguna prueba —tipos, lint,
  compilación, cientos de pruebas y el humo del gateway pasaban— porque **ninguna miraba
  coordenadas**. Ahora hay una prueba de posición
  ([`chart.test.ts`](apps/web/src/components/odontogram/chart.test.ts)): 32 piezas, cada una en su x,
  espaciadas por el paso del contrato, con los números en orden y el resalte en el grupo de la pieza
  activa. Verificado además con una captura real del gráfico.
- **El diagrama va primero.** En `/consultorio` la arcada se pinta **arriba** y la barra de carga
  rápida debajo: el gesto empieza en el dibujo (pulsar una cara o el número de la pieza) y ese clic
  cambia la pieza activa, que es la que la barra tiene cargada.
- **Los números de la arcada inferior salían espejados en la impresión.** El `<text>` del número
  llevaba el volteo compensado de la mandíbula (`scale(1,-1) translate(0,-248)`): el número volvía a
  su sitio pero los dígitos se invertían, así que el 48 se leía «8t». El número está **fuera** del
  grupo volteado, así que no necesita compensación ninguna; ahora una prueba lo vigila (ningún
  `<text>` con `transform`) y otra comprueba que cada hallazgo cae en la casilla de **su** número
  (implante en la 42, corona en la 44).
- **La línea media separa los cuadrantes.** `archLayout` deja un hueco (`MIDLINE_GAP`) entre el 11 y
  el 21, y entre el 41 y el 31: sin él las 16 piezas se leen como una fila continua y hay que contar
  casillas a ojo para saber dónde empieza cada cuadrante.
- **Cada arcada dice hacia dónde mira cada cara.** «Maxilar · vestibular arriba · palatino abajo» y
  «Mandíbula · lingual arriba · vestibular abajo», en pantalla y en el papel: era la duda clásica al
  leer un odontograma (una caries «lingual» en la 36 es el trapecio de arriba, y sin la nota parece
  un error).
- **Los tratamientos se dibujan con halo, no encima de las caras.** El símbolo (corona, implante,
  conducto, extracción indicada, y también el aspa de ausente) se pinta dos veces: primero un trazo
  del color de la superficie y encima la marca. Se ve como una marca sobre la pieza —antes el
  tornillo del implante se confundía con la anatomía— y **no tapa** las caras que conviven con el
  tratamiento (ADR 0032).
- **El número de cada pieza respira.** La línea base estaba a 24 unidades del borde del cuadro y con
  una tipografía de 26–30 el alto de las cifras se comía el hueco: el dibujo se leía como un amasijo
  de cuadros con números pegados. Ahora son 38 unidades y el alto de la arcada crece con ella, en
  **pantalla y en el papel** (la constante es la misma: lo que se ve y lo que se imprime coinciden).
  Dos pruebas lo vigilan: el aire mínimo y que el número entre entero en el lienzo.

- **El publicador del outbox se atascaba cuando una cola desaparecía entre la consulta y el
  envío.** `enqueueDomainEvent` pedía la lista de colas de consumidores, publicaba una copia en cada
  una y, si entre esas dos cosas alguien borraba una cola (en las pruebas, cada suite borra la suya
  al terminar mientras otra sigue publicando), el `insert` de pg-boss violaba la clave foránea
  contra `queue` y **el evento quedaba en reintento con retroceso**: se publicaba 60 s después. Ahora
  el fallo se interpreta como «la foto de colas está caducada»: se vuelve a pedir la lista y se
  reintenta una vez; si el fallo no era ese, se propaga para que el outbox reintente como siempre.
  Dos pruebas nuevas en `packages/db/src/outbox.test.ts` lo cubren.
- **Dos suites de integración daban falsos negativos por lotes de outbox.** `flushOutbox()` hacía
  **un solo** ciclo, y un ciclo reclama como mucho 50 eventos: la suite del odontograma produce más,
  así que dejaba eventos pendientes al azar (el «outbox a cero» fallaba una de cada tres corridas) y
  la de clínica perdía alguna fila de auditoría. Ahora el vaciado se repite hasta que no queda nada
  reclamable, como hace el publicador real. Verificado con **8 corridas seguidas de la suite
  completa** (389 pruebas) en verde.
- **Las suites de integración ensuciaban la cola compartida.** Publicaban a **todas** las colas de
  consumidores y en una corrida de pruebas los servicios no están escuchando, así que cada evento
  dejaba una copia en `created` que pg-boss no borra nunca: una tanda de corridas instrumentadas
  acumuló **17.184** trabajos muertos y la auditoría de conexiones lo denunció (con razón) como
  problema estructural. `createOutboxRunner` acepta ahora `consumerQueue` y las suites publican solo
  en la suya (`prueba-<servicio>`), la que su propio consumidor vacía y borra al terminar. Los
  trabajos acumulados se limpiaron y quedan **0**: verificado con tres corridas seguidas (0 trabajos
  nuevos en `created`).

---

## [Fase 6, sesión A] — Historia clínica · 2026-10-04

### Añadido

- **`packages/contracts`**: contrato de la historia clínica — las **11 secciones** de
  [`docs/formato_historia.md`](docs/formato_historia.md) con su esquema propio, **catálogos
  tipificados con «otros» inputable** (alergias, patológicos, medicamentos, cirugías, familiares,
  hábitos, antecedentes odontológicos y estudios), estados `borrador → firmada`, firma, adendas con
  motivo y consentimiento informado; más las reglas compartidas (contenido mínimo por sección,
  secciones obligatorias para firmar y alertas clínicas derivadas de la anamnesis). 15 pruebas
  nuevas.
- **`services/clinical`** (nuevo, puerto 4005, base `odonto_clinical`): historia **una por
  paciente** y **por secciones** (bloques JSON validados), guardado idempotente de secciones con
  opción de «sin cambios», **consentimiento** con quién acepta y ante quién, **firma** que bloquea
  la edición (exige secciones obligatorias y consentimiento), **adendas** sobre la historia firmada
  y **constancia de impresión**; catálogo de eventos `clinical.record.*` con auditoría por outbox
  (forma genérica, `entityType: medical_record`) y ruta interna de alertas clínicas para el
  consultorio. 4 pruebas de integración contra PostgreSQL real.
- **Interfaz** — **`/consultorio`**: aviso obligatorio de **«Primera visita del paciente, se debe
  llenar su historia clínica»**, selector de paciente, formulario **por pasos con autoguardado** de
  borrador, **alertas clínicas resaltadas** (la alergia a la penicilina en rojo), firma bloqueada
  mientras falten secciones o consentimiento, adendas y **vista de impresión A4** en
  `/consultorio/:id/imprimir` (fuera del shell, con firma de paciente y odontólogo). Desde la ficha
  del paciente se entra a su historia con un clic.
- **`npm run db:generate:clinical`**, `services/clinical` en `db:migrate`, `dev`/`start`,
  `dev:check`, `test:integration` y en la auditoría de conexiones (que ya no lo trata como fase
  futura).

### Cambiado

- **El rol `secretario` gana `clinical:read` (y `odontogram:read`)**: la secretaría **imprime
  todo** —récipes, consentimientos, historia y odontograma—, pero la escritura clínica sigue siendo
  del odontólogo y del admin (decisión 23). Imprimir es leer y cada impresión queda en la auditoría
  con su actor.

---

## [Sin publicar] — Correcciones posteriores a la Fase 5 · 2026-10-03

### Auditoría previa a la Fase 6

- **Informe completo en [`docs/AUDITORIA_PRE_FASE_6.md`](docs/AUDITORIA_PRE_FASE_6.md)**: se
  revisaron las siete conexiones (eventos, HTTP, auditoría, bases, permisos, configuración y
  llamadas entre servicios) con evidencia reproducible. Resultado: ninguna ruta inalcanzable,
  ninguna llamada de la interfaz sin ruta, ninguna ruta interna expuesta (probado con un JWT de
  administrador → 404), outbox a cero en los cinco servicios y las bases de `clinical`,
  `odontogram` y `reporting` ya aprovisionadas.

### Corregido

- **La cola padre `domain-events` acumulaba trabajos que nadie procesaba.** El publicador
  entregaba una copia a todas las colas conocidas, incluida la padre, que ningún servicio
  trabaja: cada evento dejaba un trabajo en `created` que pg-boss no borra nunca (su retención
  solo aplica a los completados), y había llegado a **1.305**. Ahora se publica **solo en colas
  de consumidor** (`domain-events.<servicio>`), la padre queda como último recurso si no hay
  ninguna, la prueba del outbox usa su propia cola y la borra al terminar, y se limpiaron los
  1.305 acumulados. Verificado: tras un humo completo la cola padre recibe **0** trabajos nuevos.

- **Pantalla en negro en `127.0.0.1:5173`.** La causa no era la aplicación: un servidor de Vite
  **de una sesión anterior** seguía ocupando el puerto con el grafo de módulos roto, `npm run dev`
  no podía tomarlo (`strictPort`) y `concurrently -k` mataba el resto, así que el navegador seguía
  mirando el servidor viejo sin ningún mensaje. Se comprobó con Chromium sin interfaz: ese servidor
  dejaba `#root` vacío, mientras que uno recién arrancado y la app compilada montan bien.
- **El botón «Notificar» de la programación no enviaba nada.** Publicaba
  `scheduling.appointment.notified` y **ningún servicio lo consumía**: la cita quedaba como
  `notificada` sin que al paciente le llegara nada (comprobado en la base: 42 eventos publicados y
  cero avisos producidos por ellos). El mensaje que lo advertía en la interfaz hablaba de la
  «Fase 4» y parecía obsoleto; no lo era. Ahora el servicio de notificaciones consume el evento y
  aplica la política acordada: **asegura sin duplicar** — no repite el aviso que ya salió, recupera
  el que quedó en manual pendiente o falló, y solo la casilla «reenviar también los ya notificados»
  (`force`) vuelve a enviar, identificando el reenvío por su evento.
- **El paciente con cita seguía apareciendo «En espera de cita».** El estado lo escribe
  `patients` (su base), y `en_espera_cita` significa «todavía sin cita»: al asignársela, la
  agenda publicaba el evento pero **ningún consumidor de `patients` lo escuchaba**, así que se
  quedaba así para siempre (en la base: 1.503 pacientes en espera, de los cuales 1 con cita
  programada y `.ics` enviado — el del usuario que lo reportó). Ahora `patients` tiene su
  consumidor: al recibir `scheduling.appointment.scheduled` promueve a `activo` (idempotente,
  solo desde `en_espera_cita`, nunca resucita a un `inactivo`) y lo deja auditado como
  `patient_status_changed` con el motivo «se le asignó una cita». Los datos anteriores se
  repararon con `tools/reparar-estados-pacientes.mjs` (informa por defecto, `--apply` escribe).
- **El buscador de la bandeja tardaba 406 ms por letra.** El campo era una entrada controlada
  atada al valor **ya diferido** (350 ms), así que las letras aparecían tarde y el cursor
  saltaba; medido en un navegador real: 406 ms por letra de media. Ahora el campo usa el texto
  de cada tecla y solo la consulta usa el diferido: **35 ms por letra** (15 ms de render, dentro
  de un fotograma).
- **Textos que habían envejecido con el multicanal (Fase 4.1)**: la bandeja, las plantillas, el
  catálogo de canales y el aviso de la programación hablaban solo de Telegram; ahora nombran el
  canal del paciente, y la tarjeta de estado muestra los canales activos con su identidad.

### Añadido

- **Menú de comandos en Telegram**: al pulsar `/` (o el botón junto al campo de texto) el
  paciente ve `/start`, `/nueva`, `/estado`, `/mi_ticket`, `/cancelar` y `/ayuda` con su
  descripción, sin saberse nada de memoria — pensado para quien no es técnico. Se registra con
  `setMyCommands` **desde `BOT_COMMANDS`** (el catálogo del contrato) en cada arranque, así que
  el menú y el asistente no se separan y no hay que tocar BotFather; el botón del menú muestra la
  lista. La respuesta de la ayuda termina con esa misma lista, generada del catálogo, para quien
  no descubra el menú o use WhatsApp (que no tiene comandos). Comprobación:
  `npm run telegram:menu` (y `-- --set` para volver a registrarlo).
- **Pruebas de la proyección del paciente**: la suite de `patients` cubre la promoción a
  `activo`, su idempotencia, que no toca temas ajenos y que **no resucita a un `inactivo`**; el
  humo de agenda crea un paciente nuevo y comprueba que pasa a `activo` al asignársele la cita
  (por el camino real: outbox → cola → proyección).
- **`tools/reparar-estados-pacientes.mjs`**: repara los pacientes que quedaron en
  `en_espera_cita` con cita ya asignada, con la misma función y el mismo rastro que la
  proyección. Informa por defecto; `--apply` escribe.

- **Pruebas del aviso a mano**: la suite de integración de notificaciones cubre los cuatro caminos
  (aviso nuevo, ya enviado, pendiente que se recupera y reenvío explícito), y el humo comprueba que
  pulsar «Notificar» no crea un segundo aviso (**27 comprobaciones**).
- **`npm run dev:check`** (se ejecuta solo antes de `npm run dev`): comprueba los puertos del
  desarrollo y, si están ocupados, dice **quién** los ocupa (proceso y si es de PM2) y cómo
  liberarlos. Evita arrancar a medias.
- **`npm run dev:stop`**: para lo que dejó vivo un `npm run dev` anterior (Vite y servicios sueltos).
  No toca los procesos de PM2, que se paran con `pm2 stop all`, y lo explica.
- **`npm run check:web`**: abre la interfaz con Chromium sin interfaz y verifica que **monta** (el
  contenedor `#root` con contenido) y que la consola no trae errores. Es la comprobación que habría
  cazado la pantalla en negro: ninguna prueba unitaria puede verla.
- **Reserva visible en `index.html` y aviso de arranque en `main.tsx`**: si el paquete no llega a
  ejecutarse o falla al montar, la página muestra «Cargando OdontoCRM…» y, si hay error, el mensaje
  con un botón de recarga, en lugar de quedarse en negro.
- **`docs/COMANDOS.md`**: guía única de comandos (puesta en marcha, calidad, base de datos, semillas,
  arranque, humos, PM2/Fedora, «quiero hacer X» y problemas típicos). El README deja de duplicarla.
- **`npm run audit`**: la auditoría de conexiones quedó como herramienta del proyecto
  (`tools/audit-conexiones.mjs`): cuatro secciones (eventos, HTTP, permisos y configuración, bases y
  cola) con veredicto, para repetirla al cerrar cada fase. Sale con error solo si algo es
  estructural.
- **`.env.example` completo**: sección «Ajustes finos» con las ~30 variables que los servicios leen
  y no estaban documentadas (hosts, pool de conexiones, cookies, anti-flood, reintentos, ritmo de la
  cola, tope de archivo, rutas de las claves del JWT), cada una con su valor por defecto.

### Cambiado

- **`npm run db:verify-migrations` comprueba todos los servicios** desde cero en bases limpias (antes
  solo identity), replicando las extensiones que crea el bootstrap. Al hacerlo destapó que las
  migraciones de `patients` dependen de `pg_trgm` y que la tabla es `patient_files`.

## [Fase 5] — Secretaría y pantallas (lobby y consultorio) · 2026-10-03

### Añadido

- **`packages/contracts`**: contratos de pantallas ([ADR 0030](docs/adr/0030-pantallas-kiosko-y-sse.md)) —
  dispositivos kiosko con sus **ajustes** (voz, volumen, segundos de resalte y de repetición),
  estado de la sala (`LobbyState`, `ConsultationState`), llamados, **datos críticos** con severidad,
  tramas SSE, nombre abreviado para pantalla (`Juan P.`) y edad en UTC. 8 pruebas nuevas.
- **`services/screens`** (nuevo, puerto 4007, base `odonto_screens`): **proyección de la sala** por
  eventos de agenda (`en_sala_espera` → `llamado` → `en_consulta`, y fuera al atenderse, faltar o
  cancelarse), **histórico de llamados** idempotente por evento, dispositivos con latido, **flujo
  SSE** con estado completo, latido y `Last-Event-ID`, y rutas internas para los datos críticos que
  enviará la historia clínica.
- **`services/identity`**: `POST /api/v1/auth/device` cambia el **token de dispositivo** por un JWT
  de rol `pantalla` (solo `screens:display`), deja en auditoría los intentos fallidos y actualiza la
  última señal del dispositivo. `services/patients` expone la ficha interna por id (edad y sexo para
  la pantalla del consultorio).
- **Interfaz**: **`/secretaria`** (jornada hora por hora, buscador, contadores, registrar llegada,
  llamar —con segundo llamado—, pasar a consulta, marcar atendido con motivo y marcar inasistencia,
  y **llamada fuera de orden** con confirmación), **`/pantalla/lobby`** (displaylobby con turno,
  nombre abreviado, sillón, 2.º llamado en rojo y **voz en español**), **`/pantalla/consultorio`**
  (paciente en curso, motivo y **semáforo de riesgo** de los datos críticos) y **`/pantallas`**
  (registrar cada televisor, ajustar su voz y desactivarlo, con el enlace del token una sola vez).

### Cambiado

- La **agenda publica el motivo de la consulta** con el evento de la cita y su publicador del outbox
  late cada **500 ms** (antes 2 s): de ahí depende que un llamado llegue al lobby en menos de un
  segundo (medido: **882 ms** en la prueba de humo).
- El gateway deja pasar `POST /api/v1/auth/device` sin token (la pantalla no tiene usuario ni cookie).
- **El cambio de estado adelanta la publicación**: `outbox.kick()` saca el evento en el acto en vez
  de esperar al temporizador del publicador (medido: el tramo del outbox pasa de 0-500 ms a
  **15-50 ms**). La latencia extremo a extremo del llamado queda en **303, 443 y 304 ms** en tres
  corridas limpias (~0,8 s peor caso), dominada por el sondeo de `pg-boss` (que no admite menos
  de 500 ms).

### Corregido

- **El orden de los eventos del lote**: `pg-boss` no garantiza el orden y aplicar `called` antes que
  `checked_in` dejaba al paciente «esperando» en lugar de «llamado» (y `attended` antes que
  `in_consultation` volvía a ocupar el consultorio). El lote se ordena por `occurredAt` y la
  proyección no retrocede ni resucita a quien ya salió (lápida `left_at`).
- **Una consulta del camino crítico crecía con los datos** (migración `0001` de `screens`): contar
  los llamados de una cita y buscar el último de cada cita eran escaneos secuenciales —36 ms y
  38 ms con 200.000 llamados— y ahora son 0,08 ms y 0,03 ms con `idx_call_events_appointment`.

## [Fase 4.1] — Núcleo conversacional y adaptadores de canal · 2026-10-03

### Añadido

- **`packages/contracts`**: **intenciones** del asistente (`BOT_INTENTS`, `INTENT_PHRASES`,
  `detectIntent`, `normalizePhrase`) — Telegram traduce `/nueva` y WhatsApp «cita» a la misma
  intención—, estado por canal (`ChannelStatus`) y las conversaciones y canales con
  `canal`/`direccionMasked`/`usuario`. 30 pruebas del dominio de canal (6 nuevas de intenciones).
- **`services/notifications`**: **núcleo conversacional** (`src/core/asistente.ts`) que trabaja sobre
  `InboundMessage` y envía por el **adaptador** del canal, con las **opciones numeradas guardadas en
  la conversación** (donde no hay botones, responder «2» vale como pulsar el botón) e
  **idempotencia por `(canal, eventoId)`** (`update_id` o `wamid`).
- **`services/notifications`**: **webhook público** `GET/POST /api/v1/notifications/webhook/:canal`
  para los canales que empujan (WhatsApp Cloud API): verificación con `hub.challenge`, firma
  `x-hub-signature-256` obligatoria sobre el **cuerpo crudo** y entrega al núcleo; un mensaje que
  falle no tumba el lote (se cuenta y se registra).
- **`services/notifications`**: **kit de conformidad** (`canales/conformidad.test.ts`): el mismo
  juego de 24 pruebas contra Telegram, WhatsApp y el simulado.
- **`apps/gateway`**: los webhooks de canal son **prefijos públicos** (`PUBLIC_PREFIXES`): no exigen
  JWT porque la seguridad la da la firma del proveedor.
- **`.env.example`**: variables de WhatsApp Cloud API documentadas.

### Cambiado

- **Migración `0001` de `notifications`**: `chat_id` → **`direccion`** y `telegram_username` →
  `usuario`; `bot_conversations` pasa a clave **`(canal, direccion)`** con `opciones jsonb`;
  `processed_updates` pasa a **`(canal, evento_id)`** con `evento_id text` (admite el `wamid` de
  WhatsApp); se elimina `bot_state` (el `offset` de `getUpdates` vive dentro del adaptador).
- **Migración `0002` de `notifications`**: las plantillas sembradas que seguían con el texto por
  defecto hablan de intenciones («cita», «estado»…) en lugar de solo comandos; las editadas a mano
  se respetan.
- La cola de envíos manda **por el adaptador del canal** de cada aviso y el destino se resuelve por
  `(canal, dirección)`, prefiriendo el canal pedido y, si no está vinculado, el que tenga el paciente.
- El estado del bot en la bandeja lista **todos los canales** con su identidad y capacidades.
- `telegram.ts` pasa a `canales/telegram-api.ts`: es un detalle del adaptador de Telegram.

### Corregido

- El botón pulsado en un canal deja de ser un detalle del núcleo: lo acusa el adaptador.
- El texto de un botón interactivo de WhatsApp se conserva como contexto del mensaje.

## [Fase 4] — Bot de Telegram, avisos y `.ics` · 2026-10-03

### Añadido

- **`packages/contracts`**: dominio de notificaciones — pasos del asistente (`BOT_STEPS`),
  borrador de la conversación, validaciones del guion (nombre con título y sin números, fecha
  `dd/mm/aaaa`, datos enmascarados), **19 plantillas editables** con sus marcadores, estado del bot,
  canales y enlaces de vinculación, y **generador de `.ics` (RFC 5545)** con plegado a 75 octetos,
  escape, `SEQUENCE` y recordatorio 30 min antes. 20 pruebas nuevas (117 en el paquete).
- **`services/notifications`** (nuevo, puerto 4004, base `odonto_notifications`): **bot de Telegram
  con long polling único** (ADR 0008), asistente de **7 pasos** que valida y crea paciente + solicitud
  con ticket, `/start`, `/ayuda`, `/estado`, `/cancelar`, `/mi_ticket`, vinculación por **deep link
  y QR**, idempotencia por `update_id`, anti-flood, conversaciones reanudables, plantillas
  editables, **cola de envíos con reintentos y retroceso exponencial**, «aviso manual pendiente»
  cuando no hay Telegram y `ics_artifacts` con huella SHA-256 — más el **aviso inmediato al
  formalizarse la cita** con fecha, hora, lugar y el `.ics` adjunto.
- **Interfaz**: bandeja **`/notificaciones`** con estado del bot (real/simulado), contadores,
  conversaciones, envíos con filtros y detalle del mensaje, reintento manual, aviso de contacto
  telefónico, plantillas con vista previa y marcadores, y vinculación de pacientes con QR.

### Cambiado

- **Reparto de eventos por servicio**: cada consumidor declara `domain-events.<servicio>` y el
  publicador entrega una copia en **todas** las colas, así que todos los servicios ven todos los
  eventos (antes, con una sola cola, se los repartían).
- El `.ics` se descarga desde `/api/v1/notifications/ics/:appointmentId`.

### Corregido

- Los avisos se daban por fallidos al primer intento (`maxAttempts` en 1) en lugar de reintentar.

## [Fase 3] — Agenda: tickets, cupos y programación de la jornada · 2026-10-03

### Añadido

- **`packages/contracts`**: contratos de agenda — solicitud con ticket, cita, cupo del día, plantilla
  de franjas, vista de la jornada, historial de estados, vista previa del aviso, y utilidades puras
  de hora (`addMinutes`, `minutesBetween`, `formatTime12h`, `expandTemplateSlots`, `weekdayOf`) con
  24 pruebas nuevas (145 en el paquete). Se añade el permiso `scheduling:overbook` (solo `admin`) y
  la **carga genérica de auditoría** que publican los servicios nuevos.
- **`services/scheduling`** (nuevo, puerto 4003, base `odonto_scheduling`): **secuencia atómica de
  tickets** (`nextval`, con salto a `A-000001`), cola «en espera de cita» ordenada por prioridad,
  ticket o antigüedad, **cupo diario editable** (bajarlo avisa y no borra citas), plantillas de
  franjas por día con pausas, asignación por franja u **hora manual**, **sobrecupo solo con permiso
  del admin y motivo**, **índice único parcial** que impide dos citas a la misma hora, reprogramación
  que conserva el ticket y enlaza la cita nueva, cancelación, **inasistencia con tolerancia de 15
  minutos**, `status_history` con actor y hora, y aviso en lote con vista previa y evento para la
  Fase 4.
- **`services/identity`**: el consumidor de eventos admite la carga genérica de auditoría, guarda un
  **resumen legible** por evento (migración `0003`) y consume en **lotes de 50 cada segundo**.
- **Interfaz**: página **Programación** (`/programacion`) con la cola de solicitudes (filtros,
  búsqueda diferida, nueva solicitud con búsqueda de paciente), la jornada del día (selector de
  fecha, cupo con contador `asignados/cupo` y aviso, franjas con arrastrar-y-soltar y teclado, hora
  manual, sobrecupo, contadores de ocupación), la tabla de citas con las acciones de la máquina de
  estados, el historial y el diálogo de **aviso en lote** con la vista previa exacta.

### Cambiado

- **Cancelar una cita devuelve el ticket a la cola** ([ADR 0028](docs/adr/0028-cancelar-devuelve-el-ticket.md)).
- El outbox publica en la cola compartida y el consumidor trabaja por lotes: un pico de 150 eventos
  pasa de tardar minutos a segundos.
- `seed:agenda` siembra solicitudes y citas de ejemplo en el próximo día de consulta real.

### Corregido

- El trabajador de la cola dejaba eventos en estado `created` durante minutos (auditoría con retraso)
  por usar el tamaño de lote y el sondeo por defecto de pg-boss.

## [Fase 2] — Pacientes, registro y auditoría de datos sensibles · 2026-10-03

### Añadido

- **`packages/contracts`**: contratos de paciente — identificación **V/E/P/SC**
  (`normalizeDocNumber`, `parseDocumentText`, `validateDocument`, `formatDocument`,
  `documentKey`), edad y minoría de edad en UTC, teléfono de Venezuela normalizado a `+58`,
  `cleanText` para texto libre, esquemas de alta/edición (**motivo obligatorio**), cambio de
  estado, **borrado lógico**, representante, adjuntos, filtros de búsqueda y la carga de auditoría
  que viaja por el outbox. 22 pruebas nuevas (55 en el paquete).
- **`services/patients`** (nuevo, puerto 4002, base `odonto_patients`): paciente único por
  documento con índice único parcial y **409 con `existingPatientId`** ante duplicados,
  representante obligatorio para menores, historial local de datos de contacto, **adjuntos en
  disco** con almacén abstraído (JPG/PNG/WEBP/PDF, máx. 20 MB, metadatos y SHA-256 en la base),
  búsqueda por nombre (trigramas `pg_trgm`), documento, teléfono, estado, sexo y rango de edad, y
  **endpoint interno idempotente** `upsert-by-cedula` para el bot y otros servicios.
- **`packages/db`**: publicador del outbox por intervalos (`createOutboxRunner`, sin ciclos
  solapados y con parada ordenada) y `toOutboxInsert` para insertar el evento **en la misma
  transacción** del cambio de datos con Drizzle.
- **`services/identity`**: **consumidor de eventos** idempotente (`processed_events`) que
  convierte los cambios de paciente en filas de `audit_events` con `before`, `after`, motivo,
  usuario, IP y agente.
- **Interfaz**: página **Registro** (`/registro`) con selector de tipo de cédula, máscara,
  autocompletado al salir del campo, ficha en solo lectura y botón **Editar** que exige motivo y
  confirma los cambios uno por uno; página **Pacientes** (`/pacientes`) con búsqueda con retardo,
  filtros, paginación y ficha con adjuntos y cambio de estado; y **Eliminar del registro** en la
  ficha (solo `admin`), con motivo obligatorio.

### Decidido con el usuario (2026-10-03)

- El **odontólogo registra y edita** pacientes (`patients:write` y `patients:edit_sensitive`); el
  borrado queda reservado al `admin` (`patients:delete`, [ADR 0027](docs/adr/0027-borrado-logico-de-pacientes.md)).
- El **tema** sigue siendo preferencia del equipo, no del usuario.
- Se mantiene la **cola de eventos compartida** ([ADR 0026](docs/adr/0026-cola-de-eventos-compartida.md)).
- El **bot avisará al formalizarse la cita** (fecha, hora, lugar y `.ics` adjunto), además de los
  recordatorios de 24 h y 2 h (Fase 4).
- El **membrete** sigue genérico hasta la Fase 7.

### Cambiado

- **La cola de eventos es compartida** (`odonto_events`, [ADR 0026](docs/adr/0026-cola-de-eventos-compartida.md)):
  `db:bootstrap` crea la base y reparte `EVENTS_DATABASE_URL` a todos los servicios.
- El gateway **elimina `Expect`** antes de reenviar (PowerShell y `curl` enviaban la cabecera y el
  proxy respondía 500).
- Los campos opcionales del contrato aceptan `null` además de `''`.
- Los errores RFC 7807 admiten **miembros de extensión** (`existingPatientId`).
- `seed:demo` avisa si ya hay datos ficticios en lugar de chocar con el índice único.

### Corregido

- **Edad y minoría de edad** se calculaban mezclando fecha UTC con getters locales: en Venezuela
  (UTC−4) un menor de 18 podía contar como mayor un día antes.

## [Fase 1] — Identidad, roles y shell de UI · 2026-10-02

### Añadido

- **`packages/contracts`**: contratos de sesión y usuarios — `loginSchema`, `AccessTokenClaims`,
  `LoginResponse`, `SessionInfo`, `UserSummary`, creación/edición de usuarios, cambio y
  restablecimiento de contraseña, catálogo de dispositivos kiosko, **auditoría** (`audit_events`,
  filtros de consulta y `diffSensitiveFields`), y utilidades de permisos (`hasPermission`,
  `permissionsForRoles`) con 13 pruebas.
- **`packages/kernel`**: seguridad compartida — contraseñas con **scrypt** (parámetros
  versionados en el propio hash, verificación en tiempo constante y `needsRehash`), claves
  **EdDSA** (generación, carga e importación desde PEM), firma y verificación de **JWT**
  (emisor, audiencia y caducidad), tokens opacos con hash SHA-256, **guardias de permiso**
  asíncronas para Fastify y `parseOrThrow` para validar la entrada con Zod.
- **`services/identity`**: esquema completo (usuarios, roles, tokens de refresco, dispositivos
  kiosko y auditoría) con su migración; **login** con bloqueo tras 5 intentos (15 minutos);
  **refresh rotativo con detección de reuso** (revoca la sesión completa y lo audita) con
  ventana de gracia de 30 s para la carrera entre pestañas; **logout**; `/auth/me` para el panel
  inferior; **cambio de contraseña** propio (cierra las demás sesiones); CRUD de **usuarios**
  con motivo obligatorio y auditoría del cambio; **restablecimiento de contraseña** con
  contraseña temporal generada; **dispositivos kiosko** (el token se muestra una sola vez);
  y **consulta de auditoría** filtrable. Semilla de usuarios (`admin`, `recepcion`, `prueba`)
  y generación de claves con `npm run keys:generate`.
- **`apps/gateway`**: guardia de autenticación — borra las cabeceras `x-user-*` que envíe el
  cliente, deja públicas solo la salud y el ciclo de autenticación, verifica el JWT y publica
  la identidad (usuario, roles, permisos, sesión y contraseña pendiente) al servicio interno.
  Cada servicio pasa a ser dueño de su prefijo público (las rutas ya no se recortan).

### Verificado

- `npm run verify` en verde: **98 pruebas** unitarias y de contrato.
- **Pruebas de integración de autenticación contra PostgreSQL real** (`npm run test:integration`,
  7 pruebas): login y auditoría; credenciales incorrectas sin revelar si el usuario existe;
  bloqueo de 15 minutos tras 5 intentos; rotación del refresco, ventana de gracia y **reuso
  revocando la familia**; cierre de sesión; 403 por permiso y 200 para el administrador; cambio
  de contraseña.
- **Recorrido de extremo a extremo por el gateway real** (18 comprobaciones): salud pública,
  401 sin token, suplantación de cabeceras rechazada, login con cookie `httpOnly` y ruta
  `/api/v1/auth`, bloqueo por contraseña pendiente, `/me`, rotación del refresco, token
  inválido y cierre de sesión.
- Regresión cubierta por prueba: un `preHandler` **síncrono** colgaba las peticiones en Fastify;
  las guardias son asíncronas y hay una prueba que lo vigila.

## [Fase 0] — Fundación del repositorio e infraestructura local · 2026-10-02

### Añadido

- **Monorepo** con npm workspaces: `apps/*`, `services/*`, `packages/*`, `infra/`, `tools/`.
- **`packages/contracts`**: roles y permisos, enums de estados (paciente, cita, historia,
  sesión, récipe, notificación, pantalla), máquina de estados de la cita aprobada,
  formato y parseo del ticket (`#000123` → `A-000001` al desbordar 999.999), paginación y
  errores en formato RFC 7807.
- **`packages/events`**: catálogo de tópicos de dominio y sobre (`envelope`) validado con Zod.
- **`packages/db`**: pool de PostgreSQL, cliente Drizzle, migrador versionado, tabla y
  publicador del **outbox transaccional**, envoltorio de **pg-boss** (cola `domain-events`
  con reintentos y retención).
- **`packages/kernel`**: configuración validada con Zod que **no arranca** si falta una
  variable y **no repite valores** en el error; logger con censura de credenciales; errores
  RFC 7807; `/health` y `/ready` con verificaciones y tiempo límite.
- **`packages/testing`**: generador pseudoaleatorio determinista (mulberry32) y fábricas para
  el modo test (cédulas ficticias en el rango reservado 90.000.000+).
- **`services/identity`** (esqueleto de la Fase 1): configuración propia, esquema `users`,
  migración inicial con `users` y `outbox_events`, y `/ready` que verifica PostgreSQL.
- **`apps/gateway`**: proxy por recurso según el mapa de rutas del plan, CORS restringido al
  origen de la SPA y límite de 600 peticiones por minuto.
- **`infra/db/bootstrap.mjs`**: crea las 8 bases y sus roles con contraseñas aleatorias,
  habilita `pgcrypto` y `pg_trgm`, fija la zona horaria `America/Caracas` y escribe las
  credenciales en el `.env` de cada servicio (sin imprimirlas). Idempotente; `--rotate` y
  `--only` disponibles.
- **`tools/check-secrets.mjs`**: audita lo preparado para commitear (o todo el repositorio con
  `--all`) buscando tokens de Telegram, claves PEM, cadenas de conexión con contraseña,
  claves de AWS y GitHub, y archivos que nunca deben versionarse.
- **`tools/migrate-all.mjs`**: aplica las migraciones de todos los servicios compilados.
- **`tools/verify-migrations.mjs`** (`npm run db:verify-migrations`): crea una base limpia, aplica
  las migraciones con el migrador real, comprueba tablas, migraciones registradas e índices, y
  borra la base temporal. Convierte el criterio «migraciones desde cero» en un comando.
- **`tools/test-integration.mjs`** (`npm run test:integration`): pruebas contra PostgreSQL real
  (outbox transaccional y cola `pg-boss`).
- **Guía de producción en Fedora** ([`infra/fedora/`](infra/fedora/INSTALL.md)): guía paso a paso
  (paquetes `dnf`, PostgreSQL 18, usuario de sistema, permisos, secretos, `systemd` o PM2,
  `firewalld`, SELinux, TLS interno, Tailscale, respaldos y restauración con prueba documentada,
  rollback y 33 puntos de comprobación), `install.sh` idempotente que simula por defecto, las dos
  unidades `systemd`, el `ecosystem.config.cjs` de PM2 y los scripts de respaldo/restauración
  (restauración primero en una base temporal de verificación). Los 38 puntos que solo se pueden
  probar en el servidor real están marcados como `> PENDIENTE FASE 10:`.
- **Documentación**: política de secretos ([`docs/SEGURIDAD_SECRETOS.md`](docs/SEGURIDAD_SECRETOS.md)),
  ADRs, guía de instalación en Windows y borrador de producción en Fedora.
- **Calidad**: TypeScript 5.9 estricto, ESLint 10 con reglas anti SQL-injection, Prettier,
  Vitest, y la puerta única `npm run verify`. **56 pruebas en verde.**

### Decisiones tomadas

- PostgreSQL **18** (el instalado en la máquina) en lugar de 16; Fedora se alinea a la misma
  versión mayor.
- **TypeScript 5.9.3** en lugar de 7.x: `typescript-eslint` 8.71 solo admite `<6.1`.
- Horas en la interfaz en **formato de 12 h** con `a. m.` / `p. m.` (en base de datos, logs y
  `.ics` se guardan en 24 h).
- Contraseñas con **scrypt** de `node:crypto`: sin dependencias nativas ni compilador de C++
  en Windows.

### Corregido

- Enlace roto a `odontograma.md` en `docs/formato_historia.md`, que apuntaba a un archivo
  inexistente.
- Normalización de fin de línea con `.gitattributes` (`eol=lf`) para que Windows y Fedora
  compartan el mismo contenido.
- **Puerto del gateway: 8090 en lugar de 8080.** En esta máquina Windows el 8080 lo ocupa el
  servicio de red del host (`hns`/Hyper-V) y el gateway fallaba con `listen EACCES`. Se unificó
  el nuevo puerto en el código, `.env.example`, README, plan maestro y guía de Fedora.

### Verificado

- `npm run verify` en verde: escáner de secretos, ESLint, Prettier, compilación y **56 pruebas**.
- **Pruebas de integración contra PostgreSQL real** (`npm run test:integration`, 4 pruebas): el
  outbox guarda, reclama y marca como publicado; rechaza un `eventId` duplicado; reprograma el
  reintento cuando la entrega falla; y la cola **pg-boss** declara la cola, recibe el evento y lo
  consume un trabajador.
- `npm run db:bootstrap` crea las **8 bases** con su rol propietario y es **idempotente** (segunda
  ejecución: «ya existía» / «conservada del .env», sin rotar contraseñas).
- `npm run db:migrate` aplica la migración inicial (`users` + `outbox_events`) en PostgreSQL 18.6.
- Arranque con PM2 y comprobación real: `GET :8090/health` (gateway), `GET :8090/api/v1/auth/health`
  y `GET :8090/api/v1/users/health` (proxy hacia identity) y `GET :4001/ready` con
  `database: ok`. Ruta desconocida → 404 en `application/problem+json`.
- `.gitignore`: `node_modules`, `dist/` y todos los `.env` quedan fuera del control de versiones
  (comprobado con `git check-ignore`).
- **Migraciones desde cero en base limpia** (`npm run db:verify-migrations`): base temporal creada
  con el rol del servicio, migración aplicada con `runMigrations`, tablas `users` y `outbox_events`
  presentes, 1 migración registrada, índices del outbox correctos y base temporal eliminada.
- **Guía de Fedora**: `bash -n` en los 3 scripts, `node --check` del ecosistema de PM2, sin CRLF en
  ningún archivo, UTF-8 sin BOM y sin secretos en los ejemplos (`check-secrets --all`).
- **Documentación**: 32 documentos con todos sus enlaces relativos resolviendo y las 25 ADRs
  indexadas sin huérfanas.
