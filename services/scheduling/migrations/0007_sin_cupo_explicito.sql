-- El cupo deja de ser un número que se fija a mano por fecha y consultorio: sale del
-- **horario de atención**. La plantilla semanal (`slot_templates`) produce N franjas y
-- ese N es el cupo; una cita larga gasta tantas franjas como cruza, así que el cupo
-- nunca queda «pintado» por encima de lo que de verdad cabe.
--
-- Se elimina `day_capacities` porque su dato no se puede conservar con sentido: un
-- cupo explícito de 20 sobre una jornada de 14 franjas dejaba de representar nada. El
-- horario se edita desde /programacion («Configurar la jornada»).
DROP TABLE "day_capacities" CASCADE;
