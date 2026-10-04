-- El menú de comandos lo añade el asistente al responder la ayuda (sale del
-- catálogo del contrato), así que el texto de fábrica ya no lo repite.
UPDATE "message_templates" SET "body" = 'Esto es lo que puedo hacer:
«cita» — pedir una cita
«estado» — consultar tu solicitud
«cancelar» — anular tu solicitud
«mi ticket» — recordarte tu ticket

Escríbeme cualquiera de esas palabras y te guío paso a paso.', "updated_at" = now()
 WHERE "key" = 'ayuda' AND "body" = 'Esto es lo que puedo hacer:
«cita» — pedir una cita
«estado» — consultar tu solicitud
«cancelar» — anular tu solicitud
«mi ticket» — recordarte tu ticket

Por Telegram también funcionan /nueva, /estado, /cancelar y /mi_ticket.';
