-- v1.2.2 — «posponer» vs «cancelar la cita definitivamente» (ADR 0077).
--
-- La única semántica que existía (cita cancelada + el ticket vuelve a la lista de
-- espera) pasa a llamarse **posponer**, y se añade la **cancelación definitiva** (la
-- solicitud no vuelve a la cola). El texto de las plantillas ya sembradas tiene que
-- decir cuál es cuál: `ensureDefaultTemplates` **solo inserta las que faltan**, no pisa
-- texto, así que sin esta migración el paciente seguiría leyendo «vuelves a la lista
-- de espera» al cancelar definitivamente.
--
-- Las claves nuevas (`cita_pospuesta_paciente`, `cita_posponer_o_cancelar`,
-- `confirmar_anular_solicitud`, `solicitud_anulada_paciente`) las siembra
-- `ensureDefaultTemplates` al arrancar.
--
-- Como en 0002-0008: cada UPDATE se protege con el texto **anterior** exacto, así que
-- una plantilla que el consultorio haya editado a mano **no** se pisa. Las sentencias
-- de un texto que no esté en la base son un no-op (instalación nueva: la fila todavía
-- no existe porque las plantillas se siembran al arrancar).

-- Ayuda: explica «posponer» y «cancelar» y su diferencia.
UPDATE "message_templates" SET "body" = E'Esto es lo que puedo hacer:\n«cita» — pedir una cita\n«estado» — consultar tu solicitud\n«confirmar» — confirmar tu cita\n«posponer» — pasar tu cita a otro día y volver a la lista de espera\n«cancelar» — posponer tu cita o cancelarla definitivamente\n«mi ticket» — recordarte tu ticket\n\nEscríbeme cualquiera de esas palabras y te guío paso a paso.', "updated_at" = now()
 WHERE "key" = 'ayuda' AND "body" = E'Esto es lo que puedo hacer:\n«cita» — pedir una cita\n«estado» — consultar tu solicitud\n«cancelar» — anular tu solicitud\n«mi ticket» — recordarte tu ticket\n\nEscríbeme cualquiera de esas palabras y te guío paso a paso.';--> statement-breakpoint

-- Aviso de cita: nombra las dos formas de no poder ir (posponer / cancelar definitiva).
UPDATE "message_templates" SET "body" = E'Hola {paciente}: te esperamos el {fecha} a las {hora}\nLugar: {lugar}\nTu ticket es {ticket}. Responde «confirmar» (o pulsa el botón) para avisarnos de que asistirás; si no puedes, pospónla para otro día o cancélala definitivamente.', "updated_at" = now()
 WHERE "key" = 'cita_confirmada' AND "body" = E'Hola {paciente}: te esperamos el {fecha} a las {hora}\nLugar: {lugar}\nTu ticket es {ticket}. Responde «confirmar» (o pulsa el botón) para avisarnos de que asistirás; si no puedes, aprieta (cancelar) o escribe cancelar para revocarte la cita.';--> statement-breakpoint

-- Recordatorio automático: las tres acciones (confirmar / posponer / cancelar).
UPDATE "message_templates" SET "body" = E'Hola {paciente}: te recordamos tu cita en {clinica} para el {fecha} a las {hora} (falta {dias}).\nLugar: {lugar}\nTicket: {ticket}\n\nPuedes confirmar tu asistencia, posponer la cita para otro día o cancelarla definitivamente.', "updated_at" = now()
 WHERE "key" = 'cita_recordatorio' AND "body" = E'Hola {paciente}: te recordamos tu cita en {clinica} para el {fecha} a las {hora} (falta {dias}).\nLugar: {lugar}\nTicket: {ticket}\n\nPor favor confirma tu asistencia o avísanos si no podrás asistir.';--> statement-breakpoint

-- Corte de la clínica (ADR 0057): frena las **dos** acciones, no solo cancelar.
UPDATE "message_templates" SET "body" = E'{paciente}: como ya nos confirmaste que vendrías, tu cita del {fecha} ya no se puede posponer ni cancelar por aquí (lapso menor a {dias} día(s)).\nLlama al consultorio, por favor, y lo vemos juntos.', "updated_at" = now()
 WHERE "key" = 'cita_cancelacion_fuera_de_plazo' AND "body" = E'{paciente}: como ya nos confirmaste que vendrías, tu cita del {fecha} ya no se puede cancelar por aquí (no es posible cancelar citas por aquí con un lapso menor a {dias} día (s)).\nLlama al consultorio, por favor, y lo vemos juntos.';--> statement-breakpoint

-- Una cita que no se puede cambiar por el bot ya no habla solo de «cancelar».
UPDATE "message_templates" SET "body" = E'No puedo cambiar esa cita por aquí: {estado}.\nSi necesitas gestionarla, habla con el consultorio.', "updated_at" = now()
 WHERE "key" = 'cita_no_cancelable' AND "body" = E'No puedo cancelar esa cita por aquí: {estado}.\nSi necesitas cambiarla, habla con el consultorio.';--> statement-breakpoint

-- Aviso de cancelación de la **secretaría** (la del bot no encola): el ticket vuelve
-- a la cola, que es lo que de verdad pasa con la cancelación por defecto.
UPDATE "message_templates" SET "body" = E'Hola {paciente}: tu cita del {fecha} a las {hora} quedó cancelada y tu solicitud vuelve a la lista de espera.\nTe avisaremos cuando te asignemos una fecha nueva.', "updated_at" = now()
 WHERE "key" = 'cita_cancelada' AND "body" = E'Hola {paciente}: tu cita del {fecha} a las {hora} quedó cancelada.\nSi quieres otra fecha, escríbeme «cita» y te ayudo.';--> statement-breakpoint

-- Respuesta del bot al paciente: esta pasa a ser la de la **cancelación definitiva**
-- (la de posponer es la clave nueva `cita_pospuesta_paciente`).
UPDATE "message_templates" SET "body" = E'Entendido, {paciente}: tu cita del {fecha} a las {hora} quedó cancelada definitivamente y tu solicitud ya no está en la lista de espera.\nSi más adelante necesitas otra cita, escríbeme «cita» y te ayudo.', "updated_at" = now()
 WHERE "key" = 'cita_cancelada_paciente' AND "body" = E'Entendido, {paciente}: tu cita del {fecha} a las {hora} quedó cancelada y vuelves a la lista de espera.\nTe avisaremos por aquí cuando te asignemos una fecha nueva.';
