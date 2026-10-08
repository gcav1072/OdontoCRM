-- El aviso de cita ahora invita a **cancelar** además de confirmar (ADR 0053). El texto
-- de fábrica decía «si no puedes, escríbenos por este mismo chat»; ahora que el mensaje
-- lleva el botón «Cancelar» y que la palabra «cancelar» revoca de verdad la cita, se dice
-- cómo hacerlo.
--
-- Como en 0002, 0003 y 0004: se protege con el texto **anterior** exacto, así que una
-- plantilla que el consultorio haya editado a mano **no** se pisa.
UPDATE "message_templates" SET "body" = 'Hola {paciente}: te esperamos el {fecha} a las {hora}
Lugar: {lugar}
Tu ticket es {ticket}. Responde «confirmar» (o pulsa el botón) para avisarnos de que asistirás; si no puedes, aprieta (cancelar) o escribe cancelar para revocarte la cita.', "updated_at" = now()
 WHERE "key" = 'cita_confirmada' AND "body" = 'Hola {paciente}: te esperamos el {fecha} a las {hora}
Lugar: {lugar}
Tu ticket es {ticket}. Responde «confirmar» (o pulsa el botón) para avisarnos de que asistirás; si no puedes, escríbenos por este mismo chat.';
