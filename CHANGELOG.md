# Changelog

Todos los cambios relevantes de OdontoCRM. El formato sigue
[Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/) y el proyecto usa
fases: cada fase termina con sus commits atómicos y su etiqueta `fase-N`.

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
  y **consulta de auditoría** filtrable. Semilla de usuarios (`admin`, `recepcion`, `egomez`)
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
