# ADR 0044 — El módulo de facturación es un servicio desacoplado, y el borrador nace de la sesión clínica

- **Fecha:** 2026-10-05 · **Estado:** aceptada (fase 11; decisiones cerradas el 2026-10-05)
- **Plan de la fase:** [`docs/feat_billing.md`](../feat_billing.md) · **Numeración:** este ADR iba a ser
  el «0043» en la v1 de ese documento; el [ADR 0043](0043-se-descarta-el-enfoque-de-instalacion-actual.md)
  (instalación y despliegue) se adelantó el mismo día, así que el módulo de facturación entra como
  **0044–0048**.

## Contexto

El cierre de una sesión clínica (`services/clinical`) genera una obligación de cobro: alguien tiene que
cobrarle a ese paciente. La tentación es meterlo donde ya está el paciente, pero eso acopla el expediente
a reglas fiscales mutables (alícuotas, IGTF, tipos de cambio, formatos de imprenta) y pone el cobro en el
camino crítico del odontólogo: si la caja falla, la doctora no puede cerrar la consulta.

Cuatro fuerzas tiran en direcciones distintas:

1. **El mostrador no puede esperar.** Cerrar una sesión clínica es un acto asistencial; facturarlo no
   puede ser una condición para que ocurra.
2. **La caja no puede tumbar la atención.** El sistema tiene que seguir atendiendo sin tasa del día, sin
   impresora y sin red.
3. **La contabilidad se audita sola.** Un auditor tiene que poder reconstruir qué se cobró sin leer una
   sola tabla clínica, y sin que un `update` posterior reescriba lo ya emitido.
4. **El dinero no admite punto flotante.** El repositorio **no tiene una sola columna `numeric`/`decimal`**
   y Drizzle las devuelve como `string`; una sola regla de redondeo, en un solo sitio, o los céntimos
   dejan de cuadrar.

## Decisión

1. **Servicio autónomo `services/billing`**: base `odonto_billing` y rol `odonto_billing`
   ([ADR 0002](0002-postgresql-una-base-por-servicio.md)), puerto **4009**, almacén propio
   (`./storage/billing`) y **consumidor de la cola compartida** de eventos
   ([ADR 0026](0026-cola-de-eventos-compartida.md)).
2. **Reacciona a `clinical.session.closed` creando un borrador de factura** —nunca bloquea la salida del
   consultorio— y es **idempotente por `eventId`** (reclamado en `processed_events` **dentro de la misma
   transacción** que crea el borrador) **y por sesión** (`unique` en `invoice_sessions.clinical_session_id`,
   la segunda red de idempotencia). El borrador **no publica evento**: es un acto interno que se puede
   descartar, igual que el autoguardado clínico.
3. **El dinero se modela solo con enteros**: céntimos de USD (`integer`), céntimos de VES (`bigint`) y
   tasa en **micros** (`bigint`, `36,5420 Bs./USD = 36_542_000`). Una sola regla de redondeo (half-up
   sobre enteros no negativos), aplicada **una sola vez** por conversión, y todos los productos
   intermedios en `BigInt`.
4. **Emitir un documento lo archiva**: la factura, el recibo y la nota de crédito toman número, congelan
   la tasa y sus totales, generan **un** PDF y lo guardan con su `sha256`. Desde ahí solo se anulan con
   motivo ([ADR 0048](0048-el-documento-de-cobro-se-archiva.md)).
5. **La factura y la sesión se enlazan N:M** (`invoice_sessions`): un tratamiento que se cobra al final
   cubre **varias** sesiones. La v1 emite una factura por sesión, que es el flujo del mostrador; la
   unificación queda como camino abierto, no como migración.

## Consecuencias

- ✅ La atención clínica sigue aunque la caja esté parada, sin tasa o sin impresora: el borrador se crea
  cuando la cola lo entrega, y la secretaría lo ve en `/caja` cuando puede atenderlo.
- ✅ La contabilidad se audita sin leer tablas clínicas: números, tasas, alícuotas e instantáneas viven
  enteros en `odonto_billing`.
- ✅ El número de factura sale de una **secuencia atómica** (`invoice_number_seq`), no de un contador en
  una tabla: dos emisiones simultáneas nunca comparten número (patrón `prescription_number_seq`).
- ✅ Los estados son **dato, no `if`**: `INVOICE_TRANSITIONS` declara desde dónde se va a dónde, con qué
  rol y si exige motivo, igual que `APPOINTMENT_TRANSITIONS`
  ([ADR 0012](0012-maquina-de-estados.md)).
- ⚠️ Los datos del paciente se **copian** al documento (instantánea) y se sincronizan por evento y por la
  ruta interna de pacientes: hay reconciliación periódica de saldos.
- ⚠️ Es un servicio más que desplegar (9 → 10): su base, su rol, su unidad, su entrada en las listas de
  respaldo y su consumidor en `EVENT_CONSUMERS`. La lista de puntos de contacto está en el §7 del plan de
  la fase, y varios de ellos **fallan solos** si se olvidan.

## Alternativas consideradas

- **Cobrar dentro de `services/clinical`**: rechazada. Acopla el expediente a reglas fiscales mutables
  (que cambian por decreto) y pone la caja en el camino crítico del acto clínico.
- **La facturación como módulo de `reporting`**: rechazada. `reporting` es un read model de solo lectura
  alimentado por eventos; el dinero es escritura transaccional con invariantes propias.
- **`numeric(14,2)` para los importes en bolívares**: rechazada. Drizzle lo devuelve como `string`, obliga
  a decidir el redondeo en cada consulta y el repositorio no tiene ninguna columna de ese tipo.
- **Una tabla de perfil fiscal con los datos del consultorio**: rechazada. Duplicaría datos que ya viven
  en el contrato y que leen los ocho servicios; pasan a un bloque `CLINIC_*` del entorno (§2.4 del plan).
