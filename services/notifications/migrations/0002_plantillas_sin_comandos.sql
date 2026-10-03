UPDATE "message_templates" SET "body" = '¡Hola! Soy el asistente de {clinica}. Puedo tomar tu solicitud de cita y darte tu ticket.
Escríbeme «cita» para pedir una cita, «estado» para saber cómo va la tuya o «ayuda» para ver todo lo que puedo hacer.', "updated_at" = now()
 WHERE "key" = 'bienvenida' AND "body" = '¡Hola! Soy el asistente de {clinica}. Puedo tomar tu solicitud de cita y darte tu ticket.
Escríbeme /nueva para pedir una cita, /estado para saber cómo va la tuya o /ayuda para ver todo lo que puedo hacer.';
--> statement-breakpoint
UPDATE "message_templates" SET "body" = 'Esto es lo que puedo hacer:
«cita» — pedir una cita
«estado» — consultar tu solicitud
«cancelar» — anular tu solicitud
«mi ticket» — recordarte tu ticket

Por Telegram también funcionan /nueva, /estado, /cancelar y /mi_ticket.', "updated_at" = now()
 WHERE "key" = 'ayuda' AND "body" = 'Esto es lo que puedo hacer:
/nueva — pedir una cita
/estado — consultar tu solicitud
/cancelar — anular tu solicitud
/mi_ticket — recordarte tu ticket

También puedes escribirme «cita» para empezar.';
--> statement-breakpoint
UPDATE "message_templates" SET "body" = 'Paso 2 de 7 · ¿Cuál es tu documento?
Elige el tipo (V, E, P o SC) y escríbeme el número, por ejemplo V-12345678.', "updated_at" = now()
 WHERE "key" = 'pedir_documento' AND "body" = 'Paso 2 de 7 · ¿Cuál es tu documento?
Elige el tipo con los botones y escribe el número (por ejemplo V-12345678).';
--> statement-breakpoint
UPDATE "message_templates" SET "body" = 'Ya tienes una solicitud en curso con el ticket {ticket}.
Escríbeme «estado» para ver cómo va. Si quieres anularla, escribe «cancelar».', "updated_at" = now()
 WHERE "key" = 'solicitud_en_curso' AND "body" = 'Ya tienes una solicitud en curso con el ticket {ticket}.
Escríbeme /estado para ver cómo va. Si quieres anularla, escribe /cancelar.';
--> statement-breakpoint
UPDATE "message_templates" SET "body" = 'No encuentro ninguna solicitud tuya con ese ticket.
Revisa el número o escríbeme «cita» para pedir una cita.', "updated_at" = now()
 WHERE "key" = 'sin_solicitud' AND "body" = 'No encuentro ninguna solicitud tuya con ese ticket.
Revisa el número o escríbeme /nueva para pedir una cita.';
--> statement-breakpoint
UPDATE "message_templates" SET "body" = 'Hola {paciente}: tu cita del {fecha} a las {hora} quedó cancelada.
Si quieres otra fecha, escríbeme «cita» y te ayudo.', "updated_at" = now()
 WHERE "key" = 'cita_cancelada' AND "body" = 'Hola {paciente}: tu cita del {fecha} a las {hora} quedó cancelada.
Si quieres otra fecha, escríbeme /nueva y te ayudo.';
