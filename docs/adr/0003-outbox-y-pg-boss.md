# ADR 0003 — Outbox transaccional + pg-boss sobre PostgreSQL

- **Fecha:** 2026-10-02 · **Estado:** aceptada

## Contexto

Los servicios deben reaccionar a hechos de otros servicios (una cita programada dispara una
notificación, un hallazgo del odontograma alimenta reportes y auditoría). Publicar dentro de
la transacción de datos y, además, sin perder eventos ni duplicarlos, es el problema clásico
de la mensajería en microservicios. Añadir RabbitMQ o Kafka significa otro servicio que
instalar, respaldar y monitorear en un consultorio.

## Decisión

**Patrón outbox transaccional** con **pg-boss** como cola, ambos sobre el mismo PostgreSQL del
servicio:

1. El servicio escribe el cambio y el evento (`outbox_events`) en **la misma transacción**;
2. un publicador reclama pendientes con `FOR UPDATE SKIP LOCKED` y los envía a la cola
   `domain-events` de pg-boss;
3. los consumidores son **idempotentes** y deduplican por `eventId`;
4. los fallos se reintentan con retroceso exponencial (1 min → 6 h) y quedan visibles en la
   tabla del outbox.

## Consecuencias

- ✅ Cero infraestructura extra: sin broker, sin Redis, sin MinIO.
- ✅ Un evento nunca se pierde ni se publica a medias, y es auditable en SQL.
- ✅ La interfaz de publicación está aislada (`packages/db`), así que migrar a RabbitMQ más
  adelante no toca la lógica de dominio.
- ⚠️ La cola compite por recursos con la base operativa; a esta escala es irrelevante.
- ⚠️ Los consumidores **deben** ser idempotentes: es una regla del proyecto, no una opción.
