# ADR 0026 — Cola de eventos compartida (`odonto_events`)

- **Fecha:** 2026-10-02 · **Estado:** aceptada (corrige un supuesto del [ADR 0003](0003-outbox-y-pg-boss.md))

## Contexto

El ADR 0003 decidió *outbox transaccional + pg-boss* y el plan §2.3 decía que «un publicador
entrega el evento a pg-boss **en su propia BD**». Al implementar la Fase 2 (el servicio de
pacientes publica y identity consume para la auditoría) apareció el problema: **pg-boss guarda
sus tablas en una única base de datos**, así que una cola creada en `odonto_patients` es
invisible desde `odonto_identity`. Con una cola por servicio, ningún servicio podría consumir
los eventos de otro y la mensajería asíncrona no cruzaría fronteras.

## Decisión

Una base de datos dedicada, **`odonto_events`**, es la **cola compartida** (el «broker»):

- `npm run db:bootstrap` crea la base y su rol, e inyecta `EVENTS_DATABASE_URL` en el `.env` de
  **todos** los servicios.
- Cada servicio conserva su propia tabla `outbox_events` (garantía transaccional: el evento se
  guarda en la misma transacción que el cambio de datos) y su publicador la entrega a la cola
  compartida.
- Los consumidores (`registerDomainEventHandler`) escuchan la cola compartida y son
  **idempotentes**: marcan cada `eventId` procesado en su tabla `processed_events` antes de
  aplicar efectos.
- `EVENTS_DATABASE_URL` es infraestructura, no datos de ningún servicio: la credencial es
  compartida a propósito y no da acceso a la información clínica.

## Consecuencias

- ✅ La mensajería cruza servicios sin acoplar bases ni exponer HTTP interno para eventos.
- ✅ Se conserva la garantía del outbox: nada se publica a medias y los reintentos son visibles
  en la tabla del servicio que originó el cambio.
- ✅ Migrar a RabbitMQ más adelante no toca la lógica de dominio (la interfaz está en
  `packages/db`); solo cambia el transporte.
- ⚠️ Una base más que respaldar y una credencial compartida: se documenta en
  [`infra/fedora/INSTALL.md`](../../infra/fedora/INSTALL.md) y en los respaldos de la Fase 10.
- ⚠️ Regla que no se puede olvidar: **todo consumidor debe ser idempotente** y registrar el
  `eventId` procesado (lo verifica una prueba de integración).
