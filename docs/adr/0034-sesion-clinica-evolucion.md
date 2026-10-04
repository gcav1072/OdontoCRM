# ADR 0034 — La sesión clínica es el documento de la evolución

- **Fecha:** 2026-10-04 · **Estado:** aceptada · **Implementada:** fase 7, sesión A (2026-10-04)

## Contexto

La historia clínica se llena una vez y **se firma** ([ADR 0016](0016-firma-y-consentimiento.md));
a partir de ahí es inmutable y solo admite adendas. Pero el paciente sigue viniendo:
§11 de [`../formato_historia.md`](../formato_historia.md) pide registrar **sesión por
sesión** qué se hizo, con qué materiales, con qué indicaciones y cuándo es la próxima
cita. El plan (§4.5) ya lo nombra `clinical_sessions` con estado `borrador → cerrada`
y sus campos (`vitals`, `procedures`, `materials`, `diagnosis`, `post_op_instructions`,
`next_appointment_note`, `closure_note`, `amended_from_id`).

Cuatro cosas obligan a decidir *cómo* se guarda:

1. **Se escribe con el paciente sentado.** El formulario se autoguarda mientras el
   doctor teclea; si cada pausa dejara una entrada de auditoría, el registro legal se
   llenaría de ruido y el dato clínico quedaría enterrado.
2. **Tiene que contar en los reportes.** «Cuántas endodoncias se hicieron» exige que el
   procedimiento sea un **código**, no un texto libre.
3. **El «atendido» necesita respaldo** ([ADR 0017](0017-marcar-atendido.md) dejó el
   gancho `clinicalSessionId`, pero nadie lo comprobaba): marcar una cita como atendida
   sin motivo solo tiene sentido si existe la sesión cerrada de esa visita.
4. **El odontograma ya sabe de sesiones**: `tooth_findings.recorded_in_session_id` y
   `tooth_finding_history.session_id` existen desde la fase 6B y la evolución se agrupa
   por visita.

## Decisión

- **La sesión es un documento validado, no una tabla por campo.** `clinical_sessions`
  guarda `content jsonb` con el esquema del contrato (motivo, anamnesis, signos
  vitales, examen, procedimientos, materiales, diagnóstico, indicaciones, próxima cita
  y notas internas). Se autoguarda **entero** en cada guardado, y los procedimientos y
  materiales van **contra catálogo** (`SESSION_PROCEDURES`, `SESSION_MATERIALS`) con
  «otros» inputable, que es lo que permite segmentarlos después.
- **Numeración por paciente** (`S-000001` se calcula al mostrar, no se guarda
  formateada) con índice único `(patient_id, session_number)`; el número se reserva
  dentro de la transacción y dos aperturas simultáneas no pueden repetirlo.
- **El borrador se autoguarda sin evento ni auditoría.** El catálogo de eventos solo
  tiene `clinical.session.created/closed/amended`: el acto clínico **nace al cerrar**,
  que es cuando la sesión queda con su resumen, sus procedimientos y su actor en la
  auditoría de identity. Sin cambios no se escribe nada (comparando el documento por
  contenido canónico: `jsonb` reordena las claves).
- **Lo cerrado es inmutable.** Cerrar exige un mínimo (motivo, o un procedimiento, o
  diagnóstico); después, cualquier edición responde `409`. La corrección abre una
  **sesión enmendada** (`amended_from_id`, con motivo obligatorio) que copia el
  contenido en un borrador nuevo: la original se conserva tal como quedó.
- **Firmar la historia no cierra la evolución.** Una sesión se abre aunque
  `medical_records.status` sea `firmada`: lo firmado es el documento de la historia, no
  la vida del paciente. Si el paciente no tiene historia, abrir la sesión la abre.
- **El autoguardado exige el documento completo** (`.required()` en el contrato): con
  los `default` del esquema, un cliente que mandara solo el campo que tocó **borraría**
  en silencio los procedimientos que ya estaban.
- **El «atendido» se comprueba contra el servicio clínico.** `POST /appointments/:id/attend`
  con `clinicalSessionId` verifica por la red interna que la sesión exista, sea del
  mismo paciente y esté **cerrada** —antes bastaba con mandar un identificador
  inventado para saltarse el motivo— y guarda `appointments.clinical_session_id`. Sin
  sesión, sigue exigiendo motivo auditado.
- **Cada hallazgo del odontograma queda en su sesión**: la interfaz manda
  `sessionId` en los hallazgos que se registran con la sesión abierta.

## Consecuencias

- **A favor:** el formulario es el mismo documento que se audita y que cuenta en los
  reportes; la sesión cerrada es un respaldo verificable del «atendido»; el ruido de
  auditoría es cero mientras se escribe y completo cuando se cierra; cambiar un
  catálogo no toca la base.
- **A favor (para la fase 7B):** el récipe A5 cuelga de la sesión, así que el diálogo
  «¿Desea guardar el récipe?» al cerrar tiene dónde apoyarse.
- **En contra / a vigilar:** el documento vive en `jsonb`, así que **no hay consultas
  por campo** dentro de la sesión (los reportes de la Fase 9 leerán el evento y los
  códigos, no el JSON); el esquema del contrato es la única puerta de entrada, y
  cambiarlo obliga a pensar en las sesiones ya guardadas. La lectura del contenido que
  ya está en la base **no se revalida** (se guardó validado, como el resto del
  servicio): si algún día se endurece un rango, las sesiones antiguas no se rompen.
- La enmienda crea una sesión nueva con **número nuevo**, no una marca sobre la
  anterior: quien lea la evolución ve las dos y el motivo de la corrección.
