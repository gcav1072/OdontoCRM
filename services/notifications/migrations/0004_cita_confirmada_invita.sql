-- El aviso de cita ahora **pide confirmación** (ADR 0052). El texto de fábrica decía
-- «tu cita quedó confirmada», que era lo que se leía cuando `notificada` significaba
-- «avisada y confirmada»; con el estado `confirmada` esa frase es falsa. Se reescribe
-- para que invite a responder «confirmar» (o a pulsar el botón que lleva el mensaje).
--
-- Como en 0002 y 0003: se protege con el texto **anterior** exacto, así que una
-- plantilla que el consultorio haya editado a mano **no** se pisa.
UPDATE "message_templates" SET "body" = 'Hola {paciente}: te esperamos el {fecha} a las {hora}
Lugar: {lugar}
Tu ticket es {ticket}. Responde «confirmar» (o pulsa el botón) para avisarnos de que asistirás; si no puedes, escríbenos por este mismo chat.', "updated_at" = now()
 WHERE "key" = 'cita_confirmada' AND "body" = 'Hola {paciente}: tu cita quedó confirmada para el {fecha} a las {hora}
Lugar: {lugar}
Tu ticket es {ticket}. Si no puedes asistir, avísanos por este mismo chat.';
