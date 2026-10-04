# ADR 0041 — Un evento de dominio lleva lo que su consumidor necesita

- **Fecha:** 2026-10-04 · **Estado:** aceptada (fase 9)

## Contexto

El read model de reportes se alimenta **solo de eventos**: el §2.1 del plan prohíbe
que un servicio lea las tablas de otro. Al empezar la Fase 9 se inventarió lo que
viajaba en cada evento y aparecieron tres huecos que ninguna proyección podía
rellenar sin salir a preguntar por REST:

1. `patients.patient.created|updated` publicaban los campos **sensibles** que
   cambian (`fullName`, `docNumber`, `birthDate`, teléfonos, dirección…), pero **no
   el sexo** —y la demografía se filtra y se pinta por sexo—. El estado sí viajaba,
   pero solo en los eventos de cambio de estado.
2. La anamnesis (diabetes, hipertensión, alergias, anticoagulantes) viajaba
   **dentro de `after`** del guardado de la sección `anamnesis`, sin decir de qué
   sección era, y **el autoguardado publica un evento por ráfaga de tecleo**: el
   consumidor habría tenido que adivinar la sección por las claves del objeto y
   acumular estado frágil.
3. `clinical.session.closed` recortaba los procedimientos a **diez** y los aplanaba
   a texto, suficiente para auditar y **no** para agregar por tipo de tratamiento.

Ya había precedente de resolver esto por la vía del evento: en la Fase 5 la agenda
**añadió el motivo de consulta** al evento de la cita para que la pantalla del
consultorio no leyera la base de otro servicio, y en la Fase 7 el récipe publicó un
bloque `prescription` «que es lo que contará la Fase 9».

## Decisión

**El evento lleva el bloque limpio que su consumidor necesita**, con nombre propio,
al lado de la carga de auditoría (que no se toca):

- `patients.patient.created|updated` → `patient: { patientId, document, fullName,
  sex, birthDate, status, isFictitious }`.
- `clinical.record.created|updated|signed` → `profile: { patientId, recordId,
  recordStatus, alertCodes[] }`, calculado con la **misma** función que usa la
  pantalla del consultorio (`clinicalAlerts`, [ADR 0035](0035-datos-criticos-leidos-no-empujados.md)),
  y `sectionKey` para saber qué sección se guardó.
- `clinical.session.created|closed` → `session: { sessionId, patientId,
  appointmentId, sessionNumber, status, openedAt, closedAt, procedureCodes[],
  procedureCount }`.

Reglas que acompañan a la decisión:

- El bloque es **aditivo y opcional**: quien no lo conozca lo ignora (los esquemas
  de auditoría no son estrictos) y ningún consumidor existente cambia.
- Los códigos de alerta clínica son los del contrato (`CLINICAL_ALERT_LABELS`), no
  una lista nueva: **una sola definición de «qué es un crónico»**.
- Si un evento no trae el bloque (p. ej. una adenda, que no cambia la anamnesis),
  la proyección **conserva lo último que sabía** en vez de vaciarlo.

## Consecuencias

- ✅ El read model se construye sin una sola llamada a otro servicio y sin leer
  bases ajenas.
- ✅ El perfil clínico agregado se puede recalcular con la regla del contrato, así
  que la interfaz, la pantalla del consultorio y los reportes coinciden.
- ⚠️ Los eventos llevan más carga (unos cientos de bytes). Se acepta: el outbox es
  una tabla y la cola ya transporta la carga de auditoría entera.
- ⚠️ Regla para lo que venga: **un consumidor nuevo no obliga a leer la base ajena;
  obliga a completar el evento** —y ese cambio es un commit de contrato, con su
  aviso en el `CHANGELOG`, no un parche dentro del consumidor.
