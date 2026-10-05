# ADR 0042 — El seed del modo test escribe las filas **y los eventos**, con identificadores derivados de la semilla

- **Fecha:** 2026-10-04 · **Estado:** aceptada (fase 10)

## Contexto

La Fase 9 cerró con una deuda anotada (hallazgo 24): `seed:demo` y `seed:agenda`
insertan por SQL **sin eventos** —a propósito, para no llenar la auditoría de ruido—
y el read model de reportes nace vacío. El plan pide para la Fase 10 un **seed
determinista completo** (pacientes, solicitudes, citas atendidas, historias,
sesiones cerradas, odontogramas y récipes) y que se pueda **probar que se
reconstruye desde cero**.

Al diseñarlo aparecieron cuatro fuerzas que tiraban en direcciones distintas:

1. **Los servicios no son deterministas.** `openRecord`, `signRecord`,
   `closeSession` o `issuePrescription` estampan `new Date()` y el récipe se lleva
   un `verify_code` aleatorio. Llamarlos no da dos veces el mismo mundo.
2. **Ningún publicador acepta una fecha histórica.** `publish()` y
   `createDomainEvent()` usan siempre el instante actual, y las citas atendidas
   tienen que caer en las semanas anteriores para que los reportes tengan historia.
   El sobre sí acepta `occurredAt`: la limitación está en los ayudantes.
3. **Los datos cruzan servicios por UUID.** `clinical`, `odontogram` y `scheduling`
   no pueden consultar la base de pacientes (ADR 0019 prohíbe las consultas
   cruzadas), así que cada uno tiene que **calcular el mismo identificador**.
4. **Borrar «solo lo ficticio» tiene que ser exacto.** Ocho bases, más la cola y la
   auditoría: un `delete` por rango de cédulas no alcanza si además hay que dejar el
   read model y los `processed_events` en condiciones de volver a proyectar.

## Decisión

1. **Un mundo puro y determinista** ([`packages/testing/src/test-world`](../../packages/testing/src/test-world)):
   `buildTestWorld({ anchor })` deriva cada identificador de la semilla
   (`TEST_MODE_SEED`) y del día ancla (`deterministicUuid('patient', '90000012')`).
   Cada herramienta vuelve a calcular el mismo mundo y encuentra los mismos UUID: no
   se pasan datos entre servicios.
2. **El seed escribe las filas directamente**, respetando los `CHECK`, los índices
   únicos y las invariantes que la base no vigila; el contenido clínico se valida
   con **los esquemas del contrato** (`clinicalSectionSchemaFor`,
   `clinicalSessionContentSchema`) y las alertas se calculan con la **misma función
   que usa la pantalla** (`clinicalAlerts`), no con una copia.
3. **Los eventos también los escribe el seed**, en el `outbox_events` del servicio
   que los produce, con el payload que ese servicio publica y con `occurredAt`
   histórico. A partir de ahí manda el sistema real: el publicador los entrega y los
   consumidores proyectan (reportes, auditoría, pantallas, notificaciones). Los
   `eventId` son fijos: volver a sembrar no duplica cifras.
4. **Rangos reservados para lo ficticio**: cédulas 90.000.000+, tickets y récipes
   900.000+. Al terminar, la secuencia de cada consecutivo queda apuntando al último
   número **real**, así que la clínica nunca ve un ticket de prueba.
5. **El reset borra por identificadores del mundo** (no por rangos ni por notas) y
   además limpia la proyección —`processed_events` incluidos— y la auditoría del
   actor `seed-test`, de modo que volver a sembrar vuelve a proyectar.
6. **Guardas**: hace falta `TEST_MODE=true` **y** `ALLOW_TEST_MODE=true`, y con
   `NODE_ENV=production` los tres comandos se niegan a correr.

## Consecuencias

- ✅ El read model de reportes se llena con datos **verificables** y el sistema
  demuestra el camino completo (evento → proyección → reporte) sin que nadie cargue
  datos a mano.
- ✅ `seed:verify` compara **huellas**: mundo en memoria contra bases. Si alguien
  cambia el reparto de pacientes, una hora o el contenido de una historia, se ve.
- ✅ Repetir el seed es inocuo: filas por `id`, eventos por `event_id`.
- ⚠️ **Duplica invariantes** de los servicios (numeración de sesión por paciente,
  reglas de la pieza completa del odontograma, `chk_prescriptions_issued`…). Se
  mitiga con los esquemas del contrato, las pruebas del mundo y las huellas de
  `seed:verify`; aun así, un cambio de regla en un servicio puede exigir tocar el
  seed, y eso es deliberado: el seed **no** puede pasar por donde la aplicación
  pasaría sin dejar de ser determinista.
- ⚠️ La auditoría se llena con el recorrido del seed (`actorUsername: 'seed-test'`),
  que es ruido si alguien mira `/auditoria` en una instalación de pruebas; a cambio,
  el módulo de auditoría tiene datos sobre los que trabajar. `seed:reset` los borra.
- ⚠️ Los PDF de los récipes son un **placeholder válido** (una página con el aviso de
  modo test), no el A5 que compone Chromium: el seed no arranca un navegador. Los
  récipes sembrados cumplen `pdf_path`/`pdf_sha256` y se pueden abrir; para ver el A5
  de verdad se emite uno desde la aplicación.
