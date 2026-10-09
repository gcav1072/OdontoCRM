# ADR 0058 — Sin datos personales en el código: la identidad del consultorio se sirve solo desde el registro

- **Fecha:** 2026-10-09 · **Estado:** aceptada · **Implementada:** sesión de limpieza de datos personales (2026-10-09)
- **Relacionada:** [ADR 0056](0056-la-identidad-del-consultorio-vive-en-la-base.md) — la identidad vive en la base
  (este ADR la refuerza quitando el respaldo con datos); [ADR 0035](0035-datos-criticos-leidos-no-empujados.md) —
  los datos se **leen**; [ADR 0008](0008-bot-unico-long-polling.md) — el bot único; [ADR 0020](0020-modo-test.md)
  — el modo test y los datos ficticios; [ADR 0042](0042-el-seed-escribe-filas-y-eventos.md) — el seed.

## Contexto

El [ADR 0056](0056-la-identidad-del-consultorio-vive-en-la-base.md) movió la identidad del consultorio
a la base (`clinic_profiles`) y dejó `packages/contracts/src/clinic.ts` como **«semilla y respaldo»**.
Pero ese respaldo **contenía los datos reales** de un consultorio concreto —nombre, dirección y el
odontólogo que firma— y se mantenían `CLINIC_NAME`, `CLINIC_ADDRESS` y `CLINIC_EMAIL` como override por
entorno. Eso dejaba dos problemas:

1. **Datos personales en el repositorio** (nombre, dirección y teléfono/correo de una clínica real),
   repartidos además por `.env.example`, seeds, pruebas, guiones de instalación y documentación.
2. **Un respaldo que imprime identidad ajena.** Si la base no tenía consultorio configurado (una
   instalación recién migrada), los documentos y avisos salían con los datos de **otra** clínica —o los
   del override del entorno— en vez de esperar a que el titular los completara.

Además, las cuentas que se sembraban llevaban nombres de personas (recepción y odontóloga), lo que
hacía que una instalación nueva arrancara con personal que la clínica no había pedido.

## Decisión

1. **Nada de datos personales en el código.** `clinic.ts` queda **neutro**: `name` y `address` vacíos,
   `rif`/`email` en `null`, y conserva solo el tipo `ClinicIdentity`, las ayudas de lectura y **una
   cuenta de prueba** en `dentists[]` para el seed. No se imprime si no está configurado.
2. **Una sola fuente: el registro del titular** (`clinic_profiles`, que completa el primer `odontologo`
   en su primer acceso, ADR 0056). Se **eliminan** los overrides `CLINIC_NAME`, `CLINIC_ADDRESS` y
   `CLINIC_EMAIL` del entorno: la identidad se sirve **solo** desde ahí.
3. **El recurso del código es neutro y explícito.** `clinicContactReady(clinic)` dice si hay nombre y
   dirección con los que componer un documento o un aviso.
4. **Quien necesita el consultorio lo lee del registro, no de un respaldo; si falta, difiere.** El
   generador de `.ics` no compone el archivo (`ClinicNotConfiguredError`) y la cola de avisos deja el
   aviso **en `queued`**, con el motivo «consultorio sin configurar» y **sin gastar intentos**,
   reintentando cada pocos minutos hasta que el titular configure el consultorio.
5. **El texto se re-renderiza al enviar.** El `lugar` y el nombre del consultorio se resuelven en el
   momento del envío, no al encolar: un aviso encolado antes del onboarding sale correcto después, y un
   cambio de dirección se refleja sin reencolar.
6. **Cuentas seed genéricas.** El servidor sigue creando **solo `admin`**. En desarrollo, `recepcion`
   pasa a «Recepción prueba» y el odontólogo a «Odontólogo prueba» (usuario `prueba`,
   `SEED_PASSWORD_PRUEBA`). Los datos de pacientes de prueba también se unificaron a una lista neutra.
7. **Documentación y `CHANGELOG` anonimizados:** se corrigen las menciones al nombre, la dirección, el
   bot (`@usuario` y nombre visible) y las variables `SEED_PASSWORD_*`, incluidos los registros
   históricos.

## Consecuencias

- **A favor:** el repositorio queda limpio de datos personales; una instalación nueva no arranca con
  personal ajeno; y ningún servicio puede estampar el membrete de **otra** clínica: o sale el del
  registro, o el documento/aviso **espera**.
- **A favor:** desaparece una precedencia confusa (`entorno > base > código`); hay una sola fuente.
- **En contra:** configurar el consultorio es un paso obligatorio del onboarding; hasta que el titular
  lo complete, **no salen** los avisos de cita (ni el `.ics`). Es intencional: un aviso con un lugar
  vacío o ajeno es peor que un aviso que espera.
- **En contra:** las instalaciones existentes que dependían de `CLINIC_*` por entorno dejan de tener esa
  vía; el dato se corrige desde la aplicación (que ya era la fuente principal desde el ADR 0056).
- Los documentos **ya emitidos** siguen intactos: cambiar la identidad no reescribe lo archivado
  ([ADR 0036](0036-recipe-emitido-documento-archivado.md), [ADR 0048](0048-el-documento-de-cobro-se-archiva.md)).
