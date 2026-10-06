# ADR 0002 — PostgreSQL 18 con una base de datos por servicio

- **Fecha:** 2026-10-02 · **Estado:** aceptada

## Contexto

El requisito es microservicios «de una vez, para no sufrir con monolitos», con base de datos
SQL. Compartir un único esquema entre nueve servicios reproduce los problemas del monolito:
acoplamiento por tablas y migraciones que se bloquean entre equipos.

## Decisión

**PostgreSQL 18** (la versión ya instalada en desarrollo; Fedora se alinea a la misma versión
mayor) con **una base de datos y un rol propietario por servicio** en la misma instancia:
`odonto_identity`, `odonto_patients`, `odonto_scheduling`, `odonto_notifications`,
`odonto_clinical`, `odonto_odontogram`, `odonto_screens`, `odonto_reporting`.

Cada rol solo puede conectarse a su base; las credenciales las genera
`infra/db/bootstrap.mjs` con contraseñas aleatorias de 32 bytes.

## Consecuencias

- ✅ Aislamiento real: ningún servicio puede leer tablas ajenas ni siquiera por error.
- ✅ Una sola instancia que respaldar, actualizar y monitorear (adecuado para una clínica).
- ✅ `pg_dump` por base permite restaurar un servicio sin tocar los demás.
- ⚠️ Las consultas cruzadas exigen API interna o eventos: es el precio (deseado) del
  aislamiento.
- ⚠️ Nueve bases implican nueve migraciones que ejecutar; se resuelve con `npm run db:migrate`.

> **Añadido (2026-10-06, al abrir la Fase 11):** a la lista de arriba le faltan las bases posteriores a
> esta decisión: **`odonto_events`** (la cola compartida de eventos,
> [ADR 0026](0026-cola-de-eventos-compartida.md)) y **`odonto_billing`** (facturación y pagos,
> [ADR 0044](0044-modulo-de-facturacion-desacoplado.md)). La decisión —**una base y un rol propietario por
> servicio, y el rol solo se conecta a la suya**— no cambia; solo la cuenta, que pasa a **diez** bases con
> la cola.
