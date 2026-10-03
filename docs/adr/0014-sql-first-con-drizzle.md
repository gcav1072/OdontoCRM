# ADR 0014 — Acceso a datos SQL-first con Drizzle ORM

- **Fecha:** 2026-10-02 · **Estado:** aceptada

## Contexto

Se pidió SQL como base de datos y **protección explícita contra inyección SQL**. Al mismo
tiempo, nueve servicios necesitan migraciones versionadas, tipos de TypeScript coherentes con
las tablas y consultas legibles para quien conozca SQL.

## Decisión

**Drizzle ORM** con **migraciones versionadas por servicio** (drizzle-kit):

- Las consultas se escriben como constructores tipados o como SQL con **parámetros** (`$1`,
  `$2`); nunca concatenando texto.
- Cada servicio guarda sus migraciones en `services/<nombre>/migrations/` y se aplican con
  `npm run db:migrate`.
- Las tablas se declaran en `snake_case` explícito y el esquema es la fuente de verdad de los
  tipos de fila.
- Una **regla de ESLint** prohíbe plantillas interpoladas dentro de `query()`/`execute()` y el
  uso de `sql.raw()`; el outbox usa la misma disciplina con parámetros.

## Consecuencias

- ✅ SQL visible y controlable, con seguridad por parámetros y tipos generados.
- ✅ Migraciones reproducibles y revisables en cada commit (`npm run db:generate:<servicio>`).
- ⚠️ Hay que recordar generar la migración al cambiar un esquema: se documenta en cada fase y
  `npm run verify` no puede detectarlo por sí solo.
- ⚠️ Drizzle-kit resuelve las rutas del esquema desde el directorio de trabajo: los comandos de
  generación se ejecutan desde la raíz del repositorio.
