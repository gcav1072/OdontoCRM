# Módulo de Facturación y Pagos — plan de la Fase 11 (revisión 2)

> **Estado:** propuesta revisada · 2026-10-05 · Gabriel + revisión del agente
> **Alcance:** el décimo servicio `services/billing` (puerto **4009**, base `odonto_billing`) y su
> pantalla `/caja`.
> **Nada de esto está implementado todavía.** Este documento es la fuente de verdad y, como manda
> [`PLAN_MAESTRO_FASES.md`](PLAN_MAESTRO_FASES.md) §14/§17, **cada decisión se registra como ADR antes de
> escribir código**.
> *(Nota del autor: «si se puede mejorar algo con una mejor solución, es válido presentarlo». Esta
> revisión hace exactamente eso: mantiene la arquitectura de la v1 y corrige lo que chocaría con las
> convenciones ya decididas, más los huecos de dominio que habrían dolido en producción.)*

---

## 0. Qué cambió en esta revisión (delta respecto a la v1)

Cada fila es un hallazgo de la revisión. **B** = corregir antes de implementar · **M** = mejora que el
proyecto ya resuelve en otro sitio y conviene copiar · **R** = riesgo o decisión que necesita al contador.

| # | Tema | Lo que decía la v1 | Lo que se propone |
| :-: | :--- | :--- | :--- |
| B1 | Idempotencia del consumidor | No se menciona | `processed_events` + reclamar el `eventId` en la **misma transacción** (ADR [0003](adr/0003-outbox-y-pg-boss.md), [0026](adr/0026-cola-de-eventos-compartida.md)) + índice único por sesión: un reintento no crea dos borradores (§5.1) |
| B2 | Nombre de base, puerto y cola | `odontocrm_billing` | `odonto_billing`, rol `odonto_billing` (ADR [0002](adr/0002-postgresql-una-base-por-servicio.md)), puerto **4009** y entrada en `EVENT_CONSUMERS` de [`packages/db/src/boss.ts`](../packages/db/src/boss.ts) — sin eso los eventos se pierden si la pila arranca desordenada (hallazgo medido en la Fase 10) (§7) |
| B3 | Dinero | `numeric(14, 2)` para VES | **Enteros en todo el módulo**: `integer` céntimos USD, `bigint` céntimos VES, tasa en **micros** (`bigint`). El repositorio **no tiene una sola columna `numeric`/`decimal`** y Drizzle la devuelve como `string`; el propio ADR 0043 promete aritmética sin punto flotante (§3.4, §4) |
| B4 | Estados | `pgEnum` y valores en inglés | `text` + `CHECK` contra las constantes del contrato (`sqlLiteralList`, como `prescriptions`) y **valores en español** (`borrador`, `emitida`…): la convención de [`enums.ts`](../packages/contracts/src/domain/enums.ts) es «valores en snake_case y en español; identificadores en inglés» |
| B5 | Tasa en el borrador | `exchange_rate_bcv` `notNull` en `invoices` | Contradicción: el ADR 0045 dice «se congela al emitir» y el flujo dice «el borrador nace con la tasa del día». Se separan: tasa **provisional** del borrador y tasa **definitiva** al emitir, con `CHECK` por estado (§5.2) |
| B6 | Imputación del pago en bolívares | «permite conciliar diferencias cambiarias», sin regla | **La decisión más importante del módulo**, hoy indefinida: ¿el paciente paga los Bs impresos en la factura o se recalcula con la tasa del día del pago? Se elige una política configurable, se guardan los dos hechos y se imprime la leyenda (§3.4, §5.3) |
| B7 | Numeración fiscal | `last_invoice_number` en la tabla de perfil | Es una carrera y asume que el número lo da el software. Se usa **secuencia + serie + `unique(serie, número)`** (patrón `prescription_number_seq`) y un modo de numeración explícito, porque en Venezuela el número puede venir de una **máquina fiscal** o de **formas libres** autorizadas (§5.2, ADR 0046) |
| B8 | Notas de crédito | Un comentario (`voided // Anulada por Nota de Crédito`) | Tabla propia, serie `NC-000001`, referencia obligatoria a la factura, motivo, PDF archivado y evento (§5.4) |
| B9 | Anulación de pagos y recibos | No existe | Un pago **no se borra: se anula con motivo** (misma regla que el récipe emitido, ADR [0036](adr/0036-recipe-emitido-documento-archivado.md)) y el saldo se recalcula en la misma transacción (§4, §5.3) |
| B10 | Auditoría | No se menciona | Cada acto de dinero publica `auditPayload` y aparece en `/auditoria`; hay que añadir las acciones a `AUDIT_ACTIONS` y sus etiquetas en `i18n.ts` (§3.5) |
| B11 | Permisos | No se mencionan | Cinco permisos nuevos y su reparto por rol (§3.5) |
| B12 | Datos del emisor | Tabla `clinic_fiscal_profiles` nueva | Duplica [`packages/contracts/src/clinic.ts`](../packages/contracts/src/clinic.ts) (nombre, RIF, dirección, teléfonos, logo), que ya leen los ocho servicios y el membrete. Se reutiliza; en la base solo queda lo fiscal mutable (§4, §6) |
| B13 | Alícuotas | `igtf_percentage` en una columna e IVA 16 % cableado en el enum | Tarifas **con vigencia** (`tax_rates`, `igtf_rules`) y **alícuota aplicada copiada en el documento**: cambiar el 16 % o el 3 % mañana no puede reescribir lo ya emitido. Fuera `reduced_8`: **no existe alícuota reducida vigente** (§3.3, §11) |
| B14 | El evento no lleva lo que el consumidor necesita | `session.procedureCodes` a secas | El borrador necesita **código, pieza, caras y detalle** de cada procedimiento (ADR [0041](adr/0041-el-evento-lleva-lo-que-el-consumidor-necesita.md)): se completa el bloque `session` de `clinical.session.closed` de forma **aditiva** y con aviso en el `CHANGELOG` (§5.1) |
| B15 | Factura ↔ sesión | `clinical_session_id` en `invoices` (1:1) | Un tratamiento que se cobra al final cubre **varias sesiones**. Tabla de enlace N:M desde el principio, con unicidad por sesión (§4) |
| M1 | Documento | «Motor PDF» que recompone al imprimir | **Emitir archiva**: PDF generado una vez, `sha256`, `print_count` y `last_printed_at` (ADR 0036). Lo que se reimprime es el mismo archivo (§6) |
| M2 | Máquina de estados | Implícita en los `if` | `INVOICE_TRANSITIONS` **como dato** con roles y motivo, igual que `APPOINTMENT_TRANSITIONS` (§3.1) |
| M3 | Catálogo | Libre | Alineado con los **28 códigos de `SESSION_PROCEDURES`** para que el borrador se genere solo; lo que no tenga precio entra en 0 y **marcado**, para que la caja nunca se bloquee (§5.6) |
| M4 | Libro de ventas | No está | CSV por período con bases exenta/gravada, IVA e IGTF percibido: es lo primero que pide el contador cada mes (§9) |
| M5 | Pruebas, seed y humo | No están | Base temporal propia, `npm run smoke:billing`, mundo determinista del ADR [0042](adr/0042-el-seed-escribe-filas-y-eventos.md) y un e2e de caja (§9, §12) |
| M6 | Recibo vs. factura | Mezclados | Dos series y dos documentos: **factura** (fiscal) y **recibo** `REC-000001` (interno, con el IGTF y la tasa del pago) (§6) |
| M7 | Modo test | No se menciona | Numeración y series **reservadas** (`900.000+`, serie `T`) como los récipes y los tickets: la numeración real nunca ve un número de prueba (ADR 0020/0042) (§4) |
| M8 | Tasa del día ausente | «el sistema opera con autonomía» | Falta la regla: **arrastre** de la última tasa publicada con aviso si el hueco supera N días, y confirmación explícita para cobrar con una tasa vieja (§5.5) |
| R1 | IGTF | «3 % sobre efectivo en divisas» | Confirmar con el contador **qué medios** caen en el supuesto de divisas (¿`zelle`? ¿transferencia del exterior?) y modelarlo **por medio de pago** para que sea configuración y no una migración (§3.2, §10) |
| R2 | Validez de la factura | Se asume que el PDF impreso **es** la factura | Es la pregunta que puede cambiar el diseño: **máquina fiscal**, **formas libres** autorizadas o facturación digital. Decide quién asigna el número (ADR 0046, §10) |
| R3 | Leyendas | «Exento de IVA de conformidad con el Art. 18, num. 4» | El artículo está mal: la exención de servicios odontológicos es el **Art. 19, numeral 6** de la Ley de IVA. Lo que exige la Providencia SNAT/2011/0071 es la letra **`(E)`** junto a la partida; «sin derecho a crédito fiscal» va en las **copias** (§6, §10) |

---

## 1. Registro de decisiones (ADR)

**Convención del proyecto (y no se rompe aquí):** una ADR por decisión, en su archivo
`docs/adr/NNNN-slug.md`, enlazada desde el índice [`docs/adr/README.md`](adr/README.md). Hoy el
directorio termina en **0042**, así que estas cinco entran como 0043–0047 y **la v1 de este documento
deja de ser el sitio donde viven** (aquí quedan como resumen operativo hasta que se creen los archivos).

> Tarea de orden: el plan maestro dice «45 ADRs» en la fila de la Fase 10 y en `docs/adr/` hay **42**
> (0042 es el último). Al crear los nuevos hay que dejar la cuenta cuadrada.

### ADR 0043 — Módulo de facturación desacoplado y gestión de pagos

* **Estado:** propuesto
* **Contexto:** el cierre de una sesión clínica (`services/clinical`) genera una obligación de cobro.
  Meter contabilidad o pasarelas dentro del servicio clínico acoplaría el expediente a reglas fiscales
  mutables y pondría el cobro en el camino crítico del odontólogo.
* **Decisión:**
  1. Servicio autónomo `services/billing` con su base `odonto_billing` (ADR 0002), puerto 4009, y
     consumidor de la cola compartida de eventos.
  2. Reacciona a `clinical.session.closed` creando un **borrador de factura** —nunca bloquea la salida
     del consultorio— y **es idempotente** por `eventId` y por sesión (B1).
  3. El dinero se modela **solo con enteros**: céntimos de USD (`integer`), céntimos de VES (`bigint`) y
     tasa en micros (`bigint`). Una sola regla de redondeo, en un solo sitio.
  4. Emitir un documento (factura, recibo, nota de crédito) lo **archiva**: número, PDF y `sha256`. Desde
     ahí solo se anula con motivo (ADR 0047).
* **Consecuencias:**
  * ✅ La atención clínica sigue aunque la caja esté parada o sin tasa.
  * ✅ La contabilidad se puede auditar sin leer una sola tabla clínica.
  * ⚠️ Los datos del paciente se copian al documento (instantánea) y se sincronizan por evento y por la
    ruta interna de pacientes; hay reconciliación periódica de saldos.

### ADR 0044 — Régimen tributario: IVA exento, IVA general e IGTF percibido

* **Estado:** propuesto · **necesita confirmación del contador** (R1, R3)
* **Contexto:**
  * Los **servicios odontológicos y médico-asistenciales están exentos de IVA** (Ley de IVA, **Art. 19,
    numeral 6**; *no* el Art. 18.4, que habla de ventas de bienes —prótesis incluidas—, y que conviene
    preguntar al contador si la clínica lo usa para prótesis).
  * La **venta accesoria de bienes** (cepillos, geles, insumos) está **gravada** a la alícuota general
    **16 %** (Art. 27 fija la banda 8 %–16,5 % y el Art. 63 la fija en 16 % hasta que el Ejecutivo diga
    otra cosa; **la alícuota reducida del 8 % no está vigente**).
  * El **IGTF** grava el **medio de pago**: Ley de IGTF (Gaceta Oficial Extraordinaria 6.687, 25-feb-2022)
    **Art. 24** fija **3 %** para los supuestos de divisas y **2 %** para los generales. Lo percibe y lo
    entera el sujeto pasivo especial (la clínica, si lo es).
  * Requisito de forma: la Providencia **SNAT/2011/0071, Art. 13 num. 8** pide la letra **`(E)`** junto a
    la partida exenta/exonerada/no sujeta; el «**sin derecho a crédito fiscal**» de las **copias** es el
    Art. 13 num. 13.
* **Decisión:**
  1. Cada ítem del catálogo lleva `tax_category` (`exento`, `general`) y el documento **copia la alícuota
     aplicada**: los porcentajes viven en `tax_rates` con fecha de vigencia, no en una columna editable.
  2. Los servicios odontológicos son `exento` por defecto; los bienes, `general`.
  3. El IGTF **no forma parte de la factura**: se calcula y se imputa en el **cobro** (el pago), se copia
     la alícuota aplicada en el pago y se imprime en el **recibo**, con su propia línea.
  4. Qué medios están sujetos es **configuración por medio de pago** (`igtf_rules`), no un `if` en el
     código: hoy `cash_usd` y lo que confirme el contador.
  5. El **reporte de IGTF percibido por período** es parte del alcance (M4): sin él, la clínica no puede
     enterarlo.
* **Consecuencias:**
  * ✅ Cambiar una alícuota es un `insert` con vigencia, no una migración ni un `update` que reescriba la
    historia.
  * ✅ El desglose exento/gravado sale en el documento y en el libro de ventas.
  * ⚠️ El IGTF percibido es **dinero de terceros** (se recauda del paciente y se entera): debe cuadrar
    caja contra recaudación, y eso es una comprobación de la interfaz.

### ADR 0045 — Tasa BCV: histórica, congelada por documento y con regla de imputación

* **Estado:** propuesto (la regla de imputación necesita al contador; el resto no)
* **Contexto:** los valores se expresan en moneda de cuenta (USD) y se pagan en moneda de curso legal
  (VES) a la tasa oficial del BCV. Facturas y abonos caen en fechas distintas (cuotas, tratamientos
  largos), así que consultar la tasa «al vuelo» produce incongruencias y depende de la red.
* **Decisión:**
  1. `exchange_rates`: tabla **histórica y de solo agregado** (una fila por fecha y fuente, con
     `supersedes_id` si hay corrección). La tasa se guarda en **micros** (entero) y se identifica su
     origen: `bcv_oficial`, `manual`, `arrastre`.
  2. Al **emitir**, la factura congela su tasa y sus totales en ambas monedas.
  3. Al **cobrar**, el pago congela **su** tasa, el monto **entregado** por el paciente y su moneda.
  4. **Regla de imputación (la decisión que faltaba, B6):** una sola política por instalación, guardada
     en la configuración y registrada en cada pago:
     * `tasa_del_pago` (**recomendada**): el paciente paga en Bs **al valor de hoy**; los Bs impresos en
       la factura son referenciales («a la tasa del DD/MM/AAAA») y las diferencias cambiarias quedan del
       lado del paciente.
     * `tasa_de_la_factura`: el paciente paga **exactamente** los Bs impresos; la clínica asume la
       diferencia cambiaria.
     En los dos casos se guardan los dos hechos (entregado y tasa), así que se puede recalcular y
     reportar el diferencial sin haber tomado la decisión de nuevo.
  5. **Sin red, la caja no se detiene:** si no hay tasa para la fecha se usa la última publicada
     (`arrastre`) y la pantalla avisa; con un hueco mayor al umbral configurado, cobrar exige confirmar.
  6. Todo se calcula en **`America/Caracas`**: el «día» de la tasa y de la operación no es UTC.
* **Consecuencias:** reimpresión y auditoría muestran exactamente lo que decía el papel; el módulo
  funciona sin internet; y la política cambiaria es una decisión explícita y visible, no un efecto
  colateral del redondeo.

### ADR 0046 — Quién asigna el número de la factura (software, formas libres o máquina fiscal)

* **Estado:** **propuesto y abierto** — se cierra con el contador (R2). Es el único que puede forzar un
  rediseño, por eso va antes del código.
* **Contexto:** en Venezuela la facturación de un contribuyente ordinario se emite por **máquina fiscal**
  o en **formas libres** autorizadas por el SENIAT (con número de control preimpreso por una imprenta
  autorizada), según el caso. Un PDF impreso en láser **no** es, por sí solo, una factura válida. El
  número correlativo puede entonces **no ser nuestro**, y la numeración de las formas libres **no admite
  huecos**: una forma dañada hay que justificarla.
* **Decisión (marco que sirve para los tres casos):**
  1. `invoice_series` declara el modo: `software` (nosotros numeramos), `formas_libres` (consumimos un
     rango autorizado y registramos el lote) o `maquina_fiscal` (el número lo da la máquina y se
     registra/valida al vuelo).
  2. El número se toma de una **secuencia** (atómica) y la emisión es el único punto donde se asigna:
     `unique(series, number)` + `CHECK` de emitida (patrón exacto de `prescriptions`).
  3. **En formas libres**, un fallo al generar el PDF **no deja un hueco mudo**: la forma se registra
     como anulada con motivo (`forma dañada`) ocupando su correlativo.
  4. El **recibo** interno (`REC-`) y la **nota de crédito** (`NC-`) son series nuestras en cualquier
     modo.
* **Consecuencias:** ✅ el módulo sirve para los tres escenarios sin migración y la numeración sigue
  siendo auditable. ⚠️ Si el contador confirma máquina fiscal, la pantalla de caja gana un paso manual
  (teclear el número que imprimió la máquina) y el PDF del sistema pasa a ser el **comprobante interno**,
  no la factura.

### ADR 0047 — El documento de cobro se archiva (y se anula, nunca se borra)

* **Estado:** propuesto
* **Contexto:** es el ADR [0036](adr/0036-recipe-emitido-documento-archivado.md) aplicado al dinero, y
  las preguntas son las mismas: el paciente corrige su nombre después de emitir, se cambia un precio del
  catálogo, hay un error en un cobro ya entregado.
* **Decisión:** emitir = congelar. La factura, el recibo y la nota de crédito guardan **la instantánea
  del paciente** (nombre, documento, dirección fiscal), **la instantánea de cada partida** (código,
  descripción, precio, alícuota), la **tasa** y sus totales; el PDF se genera **una vez** y se archiva
  con su `sha256`. Toda impresión o descarga cuenta (`print_count`, `last_printed_at`) y deja evento. Un
  documento emitido **nunca se borra ni se edita**: se anula con motivo y actor, y en el caso de la
  factura se emite su nota de crédito.
* **Consecuencias:** el papel del paciente y la base dicen lo mismo dentro de diez años; el catálogo se
  puede mantener sin miedo; y un error de cobro se corrige con un rastro, no con un `update`.

---

## 2. Arquitectura del servicio

### 2.1 Identidad del servicio

| Dato | Valor | De dónde sale |
| :--- | :--- | :--- |
| Directorio | `services/billing` | convención (ADR [0004](adr/0004-nueve-microservicios.md)) |
| Base de datos / rol | `odonto_billing` / `odonto_billing` | ADR 0002 + `infra/db/bootstrap.mjs` |
| Puerto interno | **4009** (4001–4008 ocupados) | `services/*/src/config.ts` |
| Almacén | `./storage/billing` | `packages/storage` (ADR 0036) |
| Cola | consumidor de `domain-events` | ADR 0026 + `EVENT_CONSUMERS` |
| Prefijo público | `/api/v1/billing` | `apps/gateway/src/routes.ts` |

### 2.2 Árbol de componentes (corregido)

```text
services/billing/
├── drizzle.config.ts
├── migrations/
├── package.json
├── tsconfig.json
└── src/
    ├── config.ts                      # BILLING_PORT, DATABASE_URL, EVENTS_DATABASE_URL, PATIENTS_URL,
    │                                  # STORAGE_DIR, INTERNAL_SERVICE_SECRET, BCV_*, IGTF/arrastre
    ├── index.ts                       # arranque: db + boss + consumidor + servidor
    ├── server.ts                      # Fastify, /health, /ready, rutas
    ├── services.ts                    # composición: qué depende de qué (patrón de clinical/reporting)
    ├── consumer.ts                    # domain-events → borradores (idempotente por eventId)
    ├── db/
    │   ├── client.ts
    │   ├── migrate.ts
    │   ├── schema.ts                  # tablas, secuencias, CHECK e índices
    │   └── views.ts                   # vistas de saldo/libro de ventas (si hacen falta)
    ├── rates/
    │   ├── rate-service.ts            # historial, tasa vigente, arrastre, correcciones
    │   └── bcv-fetcher.ts             # captura automática (best-effort, nunca bloquea la caja)
    ├── billing/
    │   ├── invoice-service.ts         # draft -> emitida -> parcial/pagada -> anulada
    │   ├── payment-service.ts         # cobro, IGTF, imputación, anulación y saldo
    │   ├── credit-note-service.ts     # NC-000001, motivo y PDF
    │   ├── catalog-service.ts         # aranceles, categoría fiscal y vigencia de precios
    │   └── books-service.ts           # libro de ventas e IGTF percibido (CSV)
    ├── documents/
    │   ├── invoice-pdf.ts             # factura A4 con membrete, (E)/(G) y leyendas
    │   └── receipt-pdf.ts             # recibo de cobro con tasa, IGTF y desglose
    ├── routes/
    │   ├── billing-routes.ts          # /api/v1/billing/** (gateway)
    │   ├── rate-routes.ts             # tasa del día, historial y corrección
    │   └── internal-routes.ts         # inter-servicio (x-internal-token)
    ├── shared/
    │   ├── context.ts                 # ActorContext (actor, ip, requestId)
    │   ├── events.ts                  # publish() al outbox + auditPayload()
    │   └── patient-client.ts          # ficha del paciente por la red interna (degrada limpio)
    └── *.integration.test.ts          # caja, emisión, IGTF, idempotencia, numeración
```

### 2.3 Convenciones que hereda (y que la v1 no mencionaba)

* **Contrato compartido**: `packages/contracts/src/domain/billing.ts` es la única fuente de los estados,
  categorías, medios de pago y de la aritmética del dinero; la base, la API y la interfaz usan lo mismo
  (es lo que hace `clinical-session.ts`).
* **Outbox**: `publish()` con `toOutboxInsert` + `createDomainEvent` dentro de la misma transacción que
  el cambio de datos (`packages/db`).
* **Consumidor**: `registerDomainEventHandler` + tabla `processed_events` propia.
* **SQL-first**: constructores tipados o SQL con parámetros; nada de plantillas interpoladas (regla de
  ESLint, ADR [0014](adr/0014-sql-first-con-drizzle.md)).
* **Configuración**: `baseEnvSchema` + `loadConfig` de `@odontocrm/kernel`, con `SERVICE_VERSION`.
* **Modo test**: `resolveTestMode` y numeración reservada (ADR [0020](adr/0020-modo-test.md)).

---

## 3. Contrato compartido: `packages/contracts/src/domain/billing.ts`

### 3.1 Estados y transiciones (la máquina, como dato)

```ts
export const INVOICE_STATUSES = ['borrador', 'emitida', 'parcial', 'pagada', 'anulada'] as const;

export interface InvoiceTransition {
  from: InvoiceStatus;
  to: InvoiceStatus;
  /** Roles autorizados además de `admin`, que puede todo (patrón de state-machine.ts). */
  roles: readonly Role[];
  label: string;
  requiresReason?: boolean;
}
```

| Desde | Hasta | Quién | Qué significa |
| :--- | :--- | :--- | :--- |
| `borrador` | `emitida` | secretario | Toma número y tasa, archiva el PDF: nace el documento |
| `borrador` | `anulada` | secretario | Se descarta el borrador (no consumió número fiscal) |
| `emitida` | `parcial` | — (automático) | Un cobro dejó saldo mayor que cero |
| `emitida`/`parcial` | `pagada` | — (automático) | Saldo cero |
| `emitida`/`parcial`/`pagada` | `anulada` | admin | Solo con **nota de crédito** y motivo |
| `parcial` | `emitida` | — (automático) | Se anuló un pago y el saldo volvió al total |

Reglas duras: **una factura solo se cobra si está `emitida` o `parcial`**; un borrador nunca recibe
dinero; «anulada» no vuelve; y toda transición con dinero exige actor y queda auditada.

### 3.2 Medios de pago (dato, no `if`)

```ts
export const PAYMENT_METHODS = [
  { code: 'cash_usd',           label: 'Efectivo en divisas (USD)', currency: 'USD', sujetoIgtf: true  },
  { code: 'cash_ves',           label: 'Efectivo en bolívares',     currency: 'VES', sujetoIgtf: false },
  { code: 'pago_movil',         label: 'Pago móvil',                currency: 'VES', sujetoIgtf: false },
  { code: 'pos_debit',          label: 'Punto de venta (débito)',   currency: 'VES', sujetoIgtf: false },
  { code: 'pos_credit',         label: 'Punto de venta (crédito)',  currency: 'VES', sujetoIgtf: false },
  { code: 'transfer_ves',       label: 'Transferencia nacional',    currency: 'VES', sujetoIgtf: false },
  { code: 'zelle',              label: 'Zelle',                     currency: 'USD', sujetoIgtf: null  },
  { code: 'international_wire', label: 'Transferencia del exterior', currency: 'USD', sujetoIgtf: null },
] as const;
```

`sujetoIgtf: null` = **lo decide el contador** (R1); el valor efectivo vive en `igtf_rules` con vigencia y
la pantalla avisa cuando un medio no está configurado. Así, si mañana Zelle entra en el supuesto, es un
`insert`, no un despliegue.

### 3.3 Categorías fiscales y alícuotas

```ts
export const TAX_CATEGORIES = ['exento', 'general'] as const;      // se elimina `reduced_8`
export const CATALOG_KINDS = ['servicio', 'bien'] as const;
export const RATE_SOURCES = ['bcv_oficial', 'manual', 'arrastre'] as const;
export const IMPUTATION_POLICIES = ['tasa_del_pago', 'tasa_de_la_factura'] as const;
export const NUMBERING_MODES = ['software', 'formas_libres', 'maquina_fiscal'] as const;
export const CURRENCIES = ['USD', 'VES'] as const;
```

* `tax_category`: `exento` (servicios odontológicos, **Art. 19.6 Ley de IVA**) y `general` (bienes).
  **Se elimina `reduced_8`**: no hay alícuota reducida vigente.
* `tax_rates(code, basis_points, effective_from)`: 1600 = 16 %. Los ítems cobrados copian
  `tax_rate_basis_points`; una factura emitida no cambia porque cambie la ley.
* `igtf_rules(method, basis_points, effective_from)`: 300 = 3 % para divisas y 200 = 2 % para los
  supuestos generales (Art. 24 de la Ley de IGTF).

### 3.4 Aritmética del dinero (una sola regla, en un solo sitio)

```ts
/** Todo en enteros. La tasa va en micros: 36,5420 Bs./USD = 36_542_000. */
export const rateToMicros = (rate: string): number => ...;   // parseo exacto, sin Number(rate)

/** Bs. céntimos a partir de céntimos de USD. Se redondea UNA vez, half-up. */
export const vesCentimosFromUsd = (centsUsd: number, rateMicros: number): number =>
  Number(divideHalfUp(BigInt(centsUsd) * BigInt(rateMicros), 1_000_000n));

/** Céntimos de USD imputados a partir de lo entregado en Bs. */
export const usdCentsFromVes = (vesCentimos: number, rateMicros: number): number =>
  Number(divideHalfUp(BigInt(vesCentimos) * 1_000_000n, BigInt(rateMicros)));

/** IGTF: alícuota en puntos básicos (300 = 3,00 %). */
export const igtfCents = (centsUsd: number, basisPoints: number): number =>
  Number(divideHalfUp(BigInt(centsUsd) * BigInt(basisPoints), 10_000n));
```

Reglas que acompañan (y que se prueban): el redondeo es **half-up sobre enteros no negativos**, se
aplica **una sola vez por conversión**, los totales de la factura se calculan **sumando las partidas**
(nunca al revés) y **todo producto intermedio va en `BigInt`** para no perder precisión antes de volver a
`number` (con guarda de rango seguro).

### 3.5 Permisos, auditoría y eventos

**Permisos nuevos** en `enums.ts` y su reparto:

| Permiso | admin | secretario | odontólogo |
| :--- | :-: | :-: | :-: |
| `billing:read` — ver caja, facturas y libros | ✅ | ✅ | ✅ (mira lo que se cobró) |
| `billing:write` — borradores, catálogo y precios | ✅ | ✅ | — |
| `billing:collect` — registrar y anular cobros | ✅ | ✅ | — |
| `billing:rates` — tasa del día y configuración fiscal | ✅ | ✅ | — |
| `billing:void` — anular facturas y emitir notas de crédito | ✅ | — | — |

*(Si algún día la odontóloga trabaja sola y cobra, se le añade `billing:collect`: es una línea en
`ROLE_PERMISSIONS`, como pasó con `scheduling:write` en el ADR [0038](adr/0038-permisos-del-odontologo-en-el-flujo.md).)*

**Acciones de auditoría** (a `AUDIT_ACTIONS` + etiqueta en `apps/web/src/lib/i18n.ts`):
`invoice_issued`, `invoice_voided`, `credit_note_issued`, `payment_received`, `payment_voided`,
`exchange_rate_set`, `catalog_item_changed`, `billing_settings_changed`.

**Tópicos** (a `EVENT_TOPICS` + `SERVICE_NAMES` en `packages/events/src/topics.ts`):

| Tópico | Cuándo | Bloque limpio para el consumidor (ADR 0041) |
| :--- | :--- | :--- |
| `billing.invoice.issued` | al emitir | `invoice: { invoiceId, number, patientId, totalCentsUsd, totalVes, rateMicros, status }` |
| `billing.invoice.voided` | al anular | `invoice: { …, creditNoteNumber, reason }` |
| `billing.invoice.paid` | saldo cero | `invoice: { … }` |
| `billing.payment.received` | cada cobro | `payment: { paymentId, invoiceId, method, amountCentsUsd, igtfCentsUsd, rateMicros }` |
| `billing.payment.voided` | anulación de cobro | `payment: { …, reason }` |
| `billing.credit_note.issued` | nota de crédito | `creditNote: { creditNoteId, number, invoiceId, totalCentsUsd, reason }` |
| `billing.rate.set` | tasa del día (alta o corrección) | `rate: { rateDate, rateMicros, source }` |
| `billing.catalog.item_changed` | alta/cambio/baja de arancel | `item: { code, priceCentsUsd, taxCategory, isActive }` |

**El borrador no publica evento**: es un acto interno que se puede descartar (misma disciplina que el
autoguardado clínico: el acto nace al cerrar). Todos los eventos llevan además la carga de auditoría.

---

## 4. Esquema de base de datos (`services/billing/src/db/schema.ts`)

Notas de convención: `snake_case` explícito, **`text` + `CHECK` con las constantes del contrato**,
enteros para el dinero, `timestamp with time zone` para instantes y `date` para el día de la tasa.
Se copia el helper `sqlLiteralList` de `clinical`. Las tablas e índices se declaran en inglés; los
**valores** en español.

```ts
/* ── 1. Tasas BCV: histórico, de solo agregado (ADR 0045) ───────────────────── */
export const exchangeRates = pgTable(
  'exchange_rates',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Día al que aplica la tasa, en America/Caracas. */
    rateDate: date('rate_date').notNull(),
    /** 36,5420 Bs./USD = 36_542_000 micros: entero, sin punto flotante. */
    rateMicros: bigint('rate_micros', { mode: 'number' }).notNull(),
    source: text('source').notNull(), // 'bcv_oficial' | 'manual' | 'arrastre'
    /** Corrección posterior: la fila anterior se marca, no se edita. */
    supersedesId: uuid('supersedes_id'),
    supersededById: uuid('superseded_by_id'),
    /** Respuesta cruda del BCV (o motivo y nota del ingreso manual). */
    rawPayload: jsonb('raw_payload'),
    note: text('note'),
    setByUserId: uuid('set_by_user_id'),
    setByUsername: text('set_by_username'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    /** Una sola tasa vigente por día (las superseded quedan como historia). */
    uniqueIndex('uq_exchange_rates_day')
      .on(table.rateDate)
      .where(sql`${table.supersededById} is null`),
    index('idx_exchange_rates_date').on(table.rateDate),
    check('chk_exchange_rates_positive', sql`${table.rateMicros} > 0`),
    check('chk_exchange_rates_source', sql`${table.source} in (${sqlLiteralList(RATE_SOURCES)})`),
  ],
);

/* ── 2. Configuración fiscal (una sola fila) ────────────────────────────────── */
export const billingSettings = pgTable(
  'billing_settings',
  {
    id: integer('id').primaryKey().default(1),
    /** Contribuyente Especial: habilita la percepción de IGTF (ADR 0044). */
    isSpecialTaxpayer: boolean('is_special_taxpayer').notNull().default(false),
    /** Política de imputación de pagos en Bs (B6): la decide la clínica, no el redondeo. */
    imputationPolicy: text('imputation_policy').notNull().default('tasa_del_pago'),
    /** Días de arrastre tolerados antes de exigir confirmación al cobrar. */
    rateGraceDays: integer('rate_grace_days').notNull().default(5),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    updatedByUserId: uuid('updated_by_user_id'),
  },
  (table) => [
    check('chk_billing_settings_single_row', sql`${table.id} = 1`),
    check('chk_billing_settings_imputation',
      sql`${table.imputationPolicy} in (${sqlLiteralList(IMPUTATION_POLICIES)})`),
  ],
);

/* ── 3. Series y numeración (ADR 0046) ──────────────────────────────────────── */
export const invoiceSeries = pgTable('invoice_series', {
  id: uuid('id').primaryKey().defaultRandom(),
  series: text('series').notNull().unique(),          // 'A', 'T' (modo test)
  numberingMode: text('numbering_mode').notNull(),    // 'software' | 'formas_libres' | 'maquina_fiscal'
  prefix: text('prefix').notNull().default(''),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/** Lote de formas libres autorizadas: rango de números de control preimpresos. */
export const fiscalForms = pgTable('fiscal_forms', {
  id: uuid('id').primaryKey().defaultRandom(),
  seriesId: uuid('series_id').notNull().references(() => invoiceSeries.id),
  controlFrom: text('control_from').notNull(),
  controlTo: text('control_to').notNull(),
  authorizationRef: text('authorization_ref'),   // providencia / autorización de la imprenta
  printerName: text('printer_name'),
  receivedAt: timestamp('received_at', { withTimezone: true }),
  spoiledCount: integer('spoiled_count').notNull().default(0),
});

/** Secuencias atómicas: el número se toma aquí y nunca se comparte (patrón RX). */
export const invoiceNumberSequence = pgSequence('invoice_number_seq', { startWith: 1 });
export const receiptNumberSequence = pgSequence('receipt_number_seq', { startWith: 1 });
export const creditNoteNumberSequence = pgSequence('credit_note_number_seq', { startWith: 1 });

/* ── 4. Aranceles ──────────────────────────────────────────────────────────── */
export const treatmentCatalog = pgTable(
  'treatment_catalog',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Mismo código que SESSION_PROCEDURES para los servicios (B14/M3). */
    code: text('code').notNull().unique(),
    name: text('name').notNull(),
    kind: text('kind').notNull().default('servicio'),   // 'servicio' | 'bien'
    priceCentsUsd: integer('price_cents_usd').notNull(),
    taxCategory: text('tax_category').notNull().default('exento'),
    isActive: boolean('is_active').notNull().default(true),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    updatedByUserId: uuid('updated_by_user_id'),
  },
  (table) => [
    check('chk_catalog_price', sql`${table.priceCentsUsd} >= 0`),
    check('chk_catalog_tax', sql`${table.taxCategory} in (${sqlLiteralList(TAX_CATEGORIES)})`),
    check('chk_catalog_kind', sql`${table.kind} in (${sqlLiteralList(CATALOG_KINDS)})`),
  ],
);

/* ── 5. Facturas (documento fiscal: se emite y se archiva) ─────────────────── */
export const invoices = pgTable(
  'invoices',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    series: text('series').notNull().default('A'),
    invoiceNumber: integer('invoice_number'),          // asignado al emitir
    controlNumber: text('control_number'),             // formas libres / máquina fiscal
    fiscalFormId: uuid('fiscal_form_id').references(() => fiscalForms.id),
    status: text('status').notNull().default('borrador'),

    // Instantánea del paciente (ADR 0047): el papel no cambia si la ficha cambia.
    patientId: uuid('patient_id').notNull(),
    patientName: text('patient_name').notNull(),
    patientDocType: text('patient_doc_type').notNull(),
    patientDocNumber: text('patient_doc_number').notNull(),
    patientTaxId: text('patient_tax_id'),              // RIF, si factura con crédito fiscal
    patientFiscalAddress: text('patient_fiscal_address'),

    // Tasa: provisional mientras es borrador, definitiva al emitir (B5).
    rateAtDraftMicros: bigint('rate_at_draft_micros', { mode: 'number' }),
    exchangeRateMicros: bigint('exchange_rate_micros', { mode: 'number' }),

    // Totales USD en céntimos (enteros: suma exacta de las partidas).
    exemptAmountCentsUsd: integer('exempt_amount_cents_usd').notNull().default(0),
    taxableAmountCentsUsd: integer('taxable_amount_cents_usd').notNull().default(0),
    ivaAmountCentsUsd: integer('iva_amount_cents_usd').notNull().default(0),
    totalCentsUsd: integer('total_cents_usd').notNull(),
    balanceCentsUsd: integer('balance_cents_usd').notNull(),
    // Totales VES en céntimos (B3), calculados con la tasa congelada.
    exemptAmountVesCentimos: bigint('exempt_amount_ves_centimos', { mode: 'number' }).notNull(),
    taxableAmountVesCentimos: bigint('taxable_amount_ves_centimos', { mode: 'number' }).notNull(),
    ivaAmountVesCentimos: bigint('iva_amount_ves_centimos', { mode: 'number' }).notNull(),
    totalVesCentimos: bigint('total_ves_centimos', { mode: 'number' }).notNull(),

    // PDF archivado (ADR 0047).
    pdfPath: text('pdf_path'),
    pdfSha256: text('pdf_sha256'),
    generatedAt: timestamp('generated_at', { withTimezone: true }),
    printCount: integer('print_count').notNull().default(0),
    lastPrintedAt: timestamp('last_printed_at', { withTimezone: true }),

    // Anulación con nota de crédito (B8).
    voidedAt: timestamp('voided_at', { withTimezone: true }),
    voidReason: text('void_reason'),
    voidedByUserId: uuid('voided_by_user_id'),
    voidedByUsername: text('voided_by_username'),

    /** Modo test: la numeración real nunca ve un número de prueba (M7). */
    isTest: boolean('is_test').notNull().default(false),
    createdByUserId: uuid('created_by_user_id').notNull(),
    createdByUsername: text('created_by_username').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    issuedAt: timestamp('issued_at', { withTimezone: true }),
    issuedByUserId: uuid('issued_by_user_id'),
  },
  (table) => [
    uniqueIndex('uq_invoices_number').on(table.series, table.invoiceNumber),
    index('idx_invoices_status_created').on(table.status, table.createdAt),
    index('idx_invoices_patient').on(table.patientId, table.createdAt),
    check('chk_invoices_status', sql`${table.status} in (${sqlLiteralList(INVOICE_STATUSES)})`),
    /** Emitida = número, tasa, totales y PDF: sin eso no es un documento. */
    check('chk_invoices_issued', sql`${table.status} = 'borrador' or (
      ${table.invoiceNumber} is not null and ${table.exchangeRateMicros} is not null
      and ${table.issuedAt} is not null and ${table.pdfPath} is not null)`),
    /** Las partidas cuadran con el total (la suma manda, no el redondeo). */
    check('chk_invoices_totals', sql`${table.exemptAmountCentsUsd}
      + ${table.taxableAmountCentsUsd} + ${table.ivaAmountCentsUsd} = ${table.totalCentsUsd}`),
    /** El saldo y el estado no pueden contradecirse (una sola verdad). */
    check('chk_invoices_balance', sql`${table.balanceCentsUsd} between 0 and ${table.totalCentsUsd}`),
    check('chk_invoices_status_balance', sql`
      (${table.status} = 'emitida' and ${table.balanceCentsUsd} = ${table.totalCentsUsd})
      or (${table.status} = 'parcial' and ${table.balanceCentsUsd} > 0
          and ${table.balanceCentsUsd} < ${table.totalCentsUsd})
      or (${table.status} = 'pagada' and ${table.balanceCentsUsd} = 0)
      or ${table.status} in ('borrador', 'anulada')`),
    check('chk_invoices_void_reason', sql`${table.status} <> 'anulada' or ${table.voidReason} is not null`),
  ],
);

/* ── 6. Partidas: copia del arancel, no una referencia viva ────────────────── */
export const invoiceItems = pgTable(
  'invoice_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    invoiceId: uuid('invoice_id').notNull().references(() => invoices.id, { onDelete: 'restrict' }),
    catalogId: uuid('catalog_id').references(() => treatmentCatalog.id, { onDelete: 'set null' }),
    code: text('code').notNull(),
    description: text('description').notNull(),
    toothNumber: integer('tooth_number'),
    surfaces: jsonb('surfaces').$type<string[]>(),
    quantity: integer('quantity').notNull().default(1),
    unitPriceCentsUsd: integer('unit_price_cents_usd').notNull(),
    totalPriceCentsUsd: integer('total_price_cents_usd').notNull(),
    taxCategory: text('tax_category').notNull(),
    /** Alícuota aplicada, copiada: la ley cambia, el papel no (B13). */
    taxRateBasisPoints: integer('tax_rate_basis_points').notNull().default(0),
    ivaAmountCentsUsd: integer('iva_amount_cents_usd').notNull().default(0),
    /** Falta el precio en el catálogo: la caja no se bloquea, se avisa (M3). */
    needsPricing: boolean('needs_pricing').notNull().default(false),
  },
  (table) => [
    index('idx_invoice_items_invoice').on(table.invoiceId),
    check('chk_invoice_items_quantity', sql`${table.quantity} > 0`),
    check('chk_invoice_items_total', sql`${table.totalPriceCentsUsd}
      = ${table.unitPriceCentsUsd} * ${table.quantity}`),
    check('chk_invoice_items_tax', sql`${table.taxCategory} in (${sqlLiteralList(TAX_CATEGORIES)})`),
  ],
);

/* ── 7. Qué sesiones cubre la factura (N:M, B15) ───────────────────────────── */
export const invoiceSessions = pgTable(
  'invoice_sessions',
  {
    invoiceId: uuid('invoice_id').notNull().references(() => invoices.id, { onDelete: 'cascade' }),
    clinicalSessionId: uuid('clinical_session_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    /** Una sesión se cobra una sola vez: es también la segunda red de idempotencia. */
    uniqueIndex('uq_invoice_sessions_session').on(table.clinicalSessionId),
    uniqueIndex('uq_invoice_sessions_pair').on(table.invoiceId, table.clinicalSessionId),
  ],
);

/* ── 8. Cobros: el dinero que entra, con su tasa y su IGTF ─────────────────── */
export const payments = pgTable(
  'payments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    invoiceId: uuid('invoice_id').notNull().references(() => invoices.id, { onDelete: 'restrict' }),
    receiptNumber: integer('receipt_number').notNull(),      // REC-000001
    method: text('method').notNull(),
    reference: text('reference'),

    /** Lo que el paciente entregó, en la moneda del medio de pago. */
    tenderedAmount: bigint('tendered_amount', { mode: 'number' }).notNull(),
    tenderedCurrency: text('tendered_currency').notNull(),    // 'USD' | 'VES'
    /** Lo imputado a la deuda, en céntimos de USD (B6). */
    amountCentsUsd: integer('amount_cents_usd').notNull(),

    /** Tasa congelada de ESTE pago y la política con la que se imputó. */
    exchangeRateMicros: bigint('exchange_rate_micros', { mode: 'number' }).notNull(),
    imputationPolicy: text('imputation_policy').notNull(),
    /** Diferencial cambiario respecto de la tasa de la factura (informativo). */
    fxDifferenceCentsUsd: integer('fx_difference_cents_usd').notNull().default(0),

    /** IGTF percibido: alícuota copiada, montos en las dos monedas. */
    appliesIgtf: boolean('applies_igtf').notNull().default(false),
    igtfBasisPoints: integer('igtf_basis_points').notNull().default(0),
    igtfAmountCentsUsd: integer('igtf_amount_cents_usd').notNull().default(0),
    igtfAmountVesCentimos: bigint('igtf_amount_ves_centimos', { mode: 'number' }).notNull().default(0),

    pdfPath: text('pdf_path'),
    pdfSha256: text('pdf_sha256'),
    printCount: integer('print_count').notNull().default(0),
    lastPrintedAt: timestamp('last_printed_at', { withTimezone: true }),

    receivedByUserId: uuid('received_by_user_id').notNull(),
    receivedByUsername: text('received_by_username').notNull(),
    /** Modo test: el recibo también usa la numeración reservada (M7). */
    isTest: boolean('is_test').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),

    voidedAt: timestamp('voided_at', { withTimezone: true }),
    voidReason: text('void_reason'),
    voidedByUserId: uuid('voided_by_user_id'),
  },
  (table) => [
    uniqueIndex('uq_payments_receipt').on(table.receiptNumber),
    index('idx_payments_invoice').on(table.invoiceId, table.createdAt),
    index('idx_payments_igtf').on(table.appliesIgtf, table.createdAt),
    check('chk_payments_amount', sql`${table.amountCentsUsd} > 0`),
    check('chk_payments_igtf_consistency', sql`
      (${table.appliesIgtf} = false and ${table.igtfAmountCentsUsd} = 0)
      or (${table.appliesIgtf} = true and ${table.igtfAmountCentsUsd} >= 0)`),
    check('chk_payments_void_reason', sql`${table.voidedAt} is null or ${table.voidReason} is not null`),
  ],
);

/* ── 9. Notas de crédito (B8) ─────────────────────────────────────────────── */
export const creditNotes = pgTable(
  'credit_notes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    creditNoteNumber: integer('credit_note_number').notNull(),   // NC-000001
    invoiceId: uuid('invoice_id').notNull().references(() => invoices.id, { onDelete: 'restrict' }),
    reason: text('reason').notNull(),
    totalCentsUsd: integer('total_cents_usd').notNull(),
    exchangeRateMicros: bigint('exchange_rate_micros', { mode: 'number' }).notNull(),
    totalVesCentimos: bigint('total_ves_centimos', { mode: 'number' }).notNull(),
    pdfPath: text('pdf_path'),
    pdfSha256: text('pdf_sha256'),
    isTest: boolean('is_test').notNull().default(false),
    issuedByUserId: uuid('issued_by_user_id').notNull(),
    issuedByUsername: text('issued_by_username').notNull(),
    issuedAt: timestamp('issued_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('uq_credit_notes_number').on(table.creditNoteNumber),
    index('idx_credit_notes_invoice').on(table.invoiceId),
    check('chk_credit_notes_total', sql`${table.totalCentsUsd} > 0`),
  ],
);

/* ── 10. Idempotencia del consumidor (B1) ─────────────────────────────────── */
export const processedEvents = pgTable('processed_events', {
  eventId: text('event_id').primaryKey(),
  topic: text('topic').notNull(),
  processedAt: timestamp('processed_at', { withTimezone: true }).notNull().defaultNow(),
});
```

**Invariantes que la base vigila** (y que por tanto no pueden «olvidarse» en el código): una sesión se
cobra una vez; una factura emitida tiene número, tasa, totales y PDF; los totales cuadran con las
partidas; el estado y el saldo no se contradicen; un documento anulado tiene motivo; el IGTF solo existe
si `applies_igtf`.

---

## 5. Lógica de dominio

### 5.1 Del cierre de la sesión al borrador (idempotente)

```text
[ services/clinical ]              [ services/billing ]                    [ apps/web (/caja) ]
        │                                   │                                     │
        │ 1. clinical.session.closed        │                                     │
        │    (session.procedures[]:         │                                     │
        │     code, toothNumber, caras)     │                                     │
        ├──────────────────────────────────►│                                     │
        │                                   │ 2. ¿eventId ya en processed_events? │
        │                                   │    → no hacer nada (reintento)      │
        │                                   │ 3. Crear borrador + partidas desde  │
        │                                   │    el catálogo; sin precio → 0 y    │
        │                                   │    needs_pricing = true             │
        │                                   │ 4. Aviso «pendiente de caja»        │
        │                                   ├────────────────────────────────────►│
        │                                   │                                     │ 5. Secretaría revisa,
        │                                   │                                     │    ajusta y pulsa «Emitir»
        │                                   │ 6. Emite: número + tasa congelada   │
        │                                   │◄────────────────────────────────────┤
        │                                   │    (PDF generado ANTES de la tx)    │
        │                                   │ 7. Cobra: medio, entregado, tasa    │
        │                                   │    del pago e IGTF si aplica        │
        │                                   │◄────────────────────────────────────┤
        │                                   │ 8. Recibo REC-xxxxxx archivado      │
        │                                   ├────────────────────────────────────►│ 9. Imprime A4
```

Tres detalles que hacen que esto no se rompa en producción:

1. **Idempotencia doble**: `processed_events` por `eventId` **dentro de la transacción** y
   `uq_invoice_sessions_session` en la base. Un reintento de la cola, un evento duplicado o un reproceso
   manual no crean dos facturas.
2. **El borrador nace con datos del evento** (paciente y documento viajan en el bloque `patient` del
   ADR 0041) y **nunca bloquea**: si un procedimiento no está en el catálogo, entra con precio 0 y
   marcado; la caja lo resuelve en 10 segundos.
3. **Cambio de contrato en `clinical`**: el bloque `session` pasa a llevar
   `procedures: [{ code, detail, toothNumber, surfaces }]` además de `procedureCodes` (aditivo; los
   consumidores actuales no son estrictos). Es un **commit de contrato con aviso en el `CHANGELOG`**,
   como manda el ADR 0041, y hay que actualizar el mundo de prueba (`packages/testing`).

### 5.2 Emisión

1. Se toma el número de la secuencia (`nextval`, atómico) **antes** de renderizar; dos emisiones
   simultáneas nunca comparten número (la segunda recibe **409** porque el `update` solo avanza desde
   `borrador`, patrón exacto de `issuePrescription`).
2. Se calculan los totales en VES con la **tasa del día de emisión** y se congelan.
3. Se genera el PDF **fuera** de la transacción (Chromium tarda) y se archiva con su `sha256`; si la
   transacción falla, el archivo se borra.
4. Si falla el render: en modo `software` el hueco se acepta (ADR 0036); en modo `formas_libres` la forma
   se registra como **anulada por daño** ocupando su número (ADR 0046).
5. Publica `billing.invoice.issued` con la carga de auditoría y el bloque `invoice`.

### 5.3 Cobro

```text
entregado (Bs)  ──►  usdCents imputados = round(entregado × 1e6 / tasa_del_pago)
                     IGTF (si el medio está sujeto y la clínica es contribuyente especial)
                        = round(usdCents × puntos_básicos / 10 000)
                     efectivo que se lleva la caja = imputado + IGTF
```

* El **IGTF no reduce la deuda**: el paciente abona su saldo y paga el tributo aparte (grava el medio de
  pago). Va en el **recibo**, con su línea y su etiqueta.
* El **saldo se recalcula en la misma transacción** desde los pagos vigentes (no anulados) y se guarda en
  `balance_cents_usd` con el `CHECK` de coherencia. Una prueba de integración recalcula el saldo desde
  cero y lo compara con el guardado: si alguien introduce un camino que no lo actualiza, se ve.
* **Un pago no se borra**: se anula con motivo (`billing:void`), se conserva su PDF y el saldo vuelve.
* **Alcance explícito de la v1**: un cobro se imputa a **una** factura emitida (con abonos parciales,
  que es como se cobran las cuotas de un tratamiento). El **anticipo** antes de emitir queda fuera (§11).

### 5.4 Anulación y nota de crédito

Anular una factura emitida **no** la borra ni la edita: emite una **nota de crédito** con su número
propio, su motivo, su PDF archivado y su PDF de referencia a la factura; la factura pasa a `anulada` y
el evento `billing.invoice.voided` lleva el número de la NC. Solo `admin`, siempre con motivo.
*(Nota de crédito parcial y nota de débito quedan fuera de la v1: se anula la factura completa, que es el
caso real de esta clínica.)*

### 5.5 Tasas BCV

* **Captura**: `bcv-fetcher` intenta una vez al día después de la publicación y guarda la respuesta
  cruda; si falla, no pasa nada: la secretaría ingresa la tasa a mano al abrir (`billing:rates`), con
  auditoría. **La caja nunca llama a internet.**
* **Vigente para una fecha**: la última fila no superada con `rate_date <= fecha`. Si el hueco supera
  `rateGraceDays`, la pantalla avisa y **exige confirmar** para cobrar (M8).
* **Corrección**: una fila nueva con `supersedes_id` y motivo. La anterior queda como historia; los
  documentos ya emitidos no se tocan.
* **Zona horaria**: `America/Caracas` tanto para `rate_date` como para «el día» de la caja.

### 5.6 Catálogo y precios

* Los códigos de **servicio** son los 28 de `SESSION_PROCEDURES` (`consulta_evaluacion`,
  `obturacion_resina`…): así el borrador se arma solo desde la sesión y los reportes cruzan por código.
* Los **bienes** (cepillos, geles) llevan códigos propios y `tax_category = general`.
* Cambiar un precio **no** reescribe nada: las partidas emitidas son instantáneas y el cambio queda
  auditado con su valor anterior y nuevo. *(Si más adelante llegan los presupuestos, ahí sí hará falta un
  histórico de precios con vigencia; hoy sería una tabla que nadie consulta.)*

---

## 6. Documento fiscal impreso

**Dos documentos, dos series** (M6):

| Documento | Serie | Qué lleva | Cuándo se imprime |
| :--- | :--- | :--- | :--- |
| **Factura** | la de la instalación (`A-000001`, o el número de la máquina/forma) | Partidas con `(E)`/`(G)`, bases, IVA, totales en Bs y USD, leyendas, tasa aplicada | Al emitir (A4) |
| **Recibo de cobro** | `REC-000001` | Medio de pago, monto entregado, tasa del pago, **IGTF percibido**, saldo después del abono | En cada cobro (A4 o A5) |
| **Nota de crédito** | `NC-000001` | Motivo, referencia a la factura, monto y tasa | Al anular |

**Encabezado legal** (los datos salen de `packages/contracts/src/clinic.ts`, no de una tabla duplicada —
B12): razón social y nombre comercial, **RIF**, dirección fiscal, teléfonos, logo, y la condición
`Contribuyente Especial` cuando corresponde.

**Leyendas** (con la corrección R3):

* La letra **`(E)`** junto a la partida exenta y **`(G)`** junto a la gravada (Providencia
  SNAT/2011/0071, Art. 13 num. 8).
* **En la copia**, «**Sin derecho a crédito fiscal**» (Art. 13 num. 13) y la mención de la exención:
  «Servicios exentos de IVA — Art. 19, numeral 6 de la Ley de IVA».
* `Tasa oficial BCV aplicada: 36,5420 Bs./USD del DD/MM/AAAA`, y en el recibo la **tasa del pago**.
* Bloque **IGTF percibido** separado, con la aclaratoria de que **no forma parte del monto de la
  factura**.
* Si la política es `tasa_del_pago`: «Los montos en Bs. de esta factura son referenciales a la tasa del
  día de emisión; el pago se calcula a la tasa oficial vigente al momento de cobrar».

**Archivado e impresión** (M1): el PDF se compone una vez con Chromium (`@page { size: A4 }`, como los
reportes) y se guarda en `storage/billing` con su `sha256`; toda descarga o impresión incrementa
`print_count`, actualiza `last_printed_at` y deja evento. Lo que se reimprime es **el mismo archivo**.

---

## 7. Integración: el checklist del décimo servicio

Añadir un servicio **no** es solo crear la carpeta: son ~180 puntos de contacto en 12 zonas, y varios
tienen **guardias que fallan solas** (lo bueno) o que no existen (lo peligroso). Este es el mapa ya
verificado contra el repositorio; el inventario existente en `infra/fedora/INSTALL.md` §«Un servicio
nuevo» **se queda corto** (dice que las listas de respaldo son dos y no menciona gateway, eventos,
`.env.example`, `tools/` ni el `tsconfig`), así que hay que ampliarlo al terminar.

### 7.1 Contratos y eventos

1. `packages/contracts/src/domain/billing.ts` (nuevo) + export en `packages/contracts/src/index.ts` + su
   `billing.test.ts` (aritmética del dinero y transiciones).
2. `packages/contracts/src/domain/enums.ts`: los 5 permisos en `PERMISSIONS`, su reparto en
   `ROLE_PERMISSIONS` y las acciones de `AUDIT_ACTIONS`. El guardián real es
   `requirePermission` (`packages/kernel/src/auth/identity.ts`); el gateway solo firma y publica
   `x-user-permissions`, **no comprueba permisos**.
3. `packages/events/src/topics.ts`: los tópicos `billing.*` y `billing` en `SERVICE_NAMES`.
   *(El sobre no valida el productor contra esa lista: no hay puerta de ejecución, es disciplina.)*
4. **`packages/db/src/boss.ts`: `billing` en `EVENT_CONSUMERS`** — y su comentario «son cinco» pasa a
   seis. Es bloqueante de verdad: `packages/db/src/boss.test.ts` escanea los `index.ts` de los servicios
   buscando `registerDomainEventHandler` y **falla en cuanto `billing` consuma**. Sin la entrada, los
   eventos que lleguen mientras la pila arranca se pierden en silencio (el fallo que se midió en la
   Fase 10).
5. `clinical.session.closed`: bloque `session.procedures[]` (commit de contrato + `CHANGELOG` +
   `packages/testing`).

### 7.2 El servicio

6. `services/billing/**` completo (§2.2). El esqueleto se copia de `services/reporting` (16 piezas:
   `package.json`, `tsconfig.json`, `drizzle.config.ts` —rutas relativas a la raíz—, `src/config.ts`,
   `db/{schema,client,migrate}.ts`, `consumer.ts`, `routes/*`, `services.ts`, `server.ts`, `index.ts`,
   `migrations/`, pruebas), **con una excepción importante**: `reporting` no publica eventos, y
   facturación sí; el `shared/events.ts` con el outbox se copia de `services/clinical`.
7. Añadir `"services/billing"` a los `workspaces` del `package.json` raíz y
   `{ "path": "services/billing" }` a las `references` del `tsconfig.json` raíz.
8. `infra/db/bootstrap.mjs`: `billing` en `SERVICES` (`odonto_billing`, rol `odonto_billing`,
   `services/billing/.env`). La base es `odonto_billing`, **no** `odontocrm_billing`: todos los
   analizadores del repositorio filtran por `odonto_%`.
9. `services/billing/.env.example` (modelo: `services/reporting/.env.example`) y `.env.example` de la
   raíz: `BILLING_PORT=4009`, `BILLING_URL`, `BILLING_HOST`. El auditor de conexiones exige que **toda**
   variable declarada en un `config.ts` esté también en el `.env.example`.

### 7.3 Herramientas y arranque

10. `package.json` raíz: `dev:billing`, `start:billing`, `smoke:billing`, `db:generate:billing` y el
    proceso nuevo en el `concurrently` de `dev`.
11. **`tools/lib/servicios.mjs`**: `SERVICIOS` (base y `.env`) y `PROCESOS` (puerto 4009, unidad
    `odontocrm@billing`) son **la lista canónica** de la que leen `estado`, `stack`, `modo-test` y el
    mantenimiento; de ahí salen los rótulos «9 servicios / 9 bases» del tablero.
12. `tools/migrate-all.mjs` (script y `.env`), `tools/verify-migrations.mjs` (**y la lista exacta de
    tablas esperadas de la migración**), `tools/db-reset.mjs` (`BASES`), `tools/dev-check.mjs`
    (`BASES`), `tools/lib/entorno.mjs` (env-check), `tools/lib/stack.mjs` (**la única tabla de puertos**
    que comparten `dev:check`, `dev:stop` y `stack:*`), `tools/lib/modo-test.mjs`, `tools/seed-test.mjs`
    (`PARTES`) y `tools/seed-verify.mjs` si el seed lo cubre.
13. `tools/test-integration.mjs`: `TEST_BILLING_DATABASE_URL` en su mapa `extraEnv` y —si la suite afirma
    cifras absolutas (correlativos, saldos)— una **base temporal propia** clonando
    `prepararBaseDeReportes()` (`odonto_billing_prueba`). *(`vitest.config.ts` descubre las suites por
    glob: un servicio nuevo no lo toca.)*

### 7.4 Gateway y web

14. `apps/gateway/src/config.ts` (`BILLING_URL`), `upstreams.ts` (lista del `/ready` agregado),
    `routes.ts` (`add('/api/v1/billing', …)`), y sus pruebas: `upstreams.test.ts` afirma
    **`toHaveLength(8)`** y `proxy.test.ts` **`toHaveLength(14)`**.
15. `apps/web/src/lib/nav.ts` (`ModuleId` `caja`, `MODULES`, `NAV_SECTIONS`); `App.tsx` (ruta bajo
    `RequirePermission` **y `'caja'` en la lista de exclusión de `modulosFuturos`**, o se duplica el
    placeholder); `lib/i18n.ts` (claves del módulo, secciones de menú, etiquetas de las acciones de
    auditoría y **`PERMISSION_LABELS: Record<Permission, string>`: sin la etiqueta nueva el `typecheck`
    no compila**); `lib/endpoints.ts` (el objeto `billingApi`) y `lib/api.ts`; `pages/CajaPage.tsx` con
    sus pruebas puras. El auditor exige que toda llamada de la web cuelgue de un prefijo del gateway.

### 7.5 Despliegue (Fedora y Windows)

16. `infra/fedora/install.sh`: la lista `SERVICES` (`"billing:4009:odonto_billing"`), el heredoc
    `DATABASES`, las líneas `ROLE_odonto_*`, la lista impresa de unidades y los comentarios de conteo;
    además el `case` por servicio si necesita claves extra —**`billing` imprime PDF con Chromium, así
    que necesita el mismo `PLAYWRIGHT_BROWSERS_PATH` que `clinical` y `reporting`**.
17. `infra/fedora/odontocrm` (`SERVICIOS` y `PUERTOS`) y `infra/fedora/ensayo-despliegue.sh`
    (`SERVICIOS`, `PUERTO_DE`, el bucle de puertos, el bucle de bases y la exigencia del `.env`).
    *(La unidad `systemd` es una plantilla: `odontocrm@billing.service` funciona sin archivo nuevo.)*
18. **Las listas de respaldo son CUATRO**, no dos ni tres:
    `backup/odontocrm-backup.sh`, `backup/odontocrm-restore.sh`, `backup/crear-rol-respaldo.sh` y el
    heredoc de `install.sh`. La guardia de `tools/plantillas-fedora.mjs` solo cruza la primera y la
    cuarta, así que **las otras dos se desincronizan en silencio** (y `INSTALL.md` §respaldos ya está
    obsoleto: su lista ni siquiera incluye `odonto_events`).
19. `infra/windows/ecosystem.config.cjs` y `infra/windows/start-services.ps1` (PM2 y la comprobación de
    `/ready`): es la ruta que se usa en la PC de desarrollo, y **no tiene ninguna guardia**.
20. `tools/plantillas-fedora.mjs`: `CON_BASE`, `CRITICAS`, los `default(...)` vigilados y la guardia que
    exige que `SERVICIOS` de `odontocrm` **y** de `ensayo-despliegue.sh` contengan todo servicio con
    `src/config.ts` versionado — se pone roja en cuanto se hace `git add services/billing/src/config.ts`.

### 7.6 Documentación

21. `docs/adr/0043…0047` + la tabla del índice `docs/adr/README.md`. Hay que **anotar el ADR 0004**
    («Nueve microservicios») y actualizar la lista de bases del ADR 0002. Y cuadrar la cuenta de ADRs
    del plan maestro (dice 45 y hay 42).
22. `docs/PLAN_MAESTRO_FASES.md`: §2.2 (tabla de servicios), §4 (modelo de datos), §6 (rutas), §7
    (catálogo de eventos), §13 (Fase 11), §16 (riesgos) y §17 — **además de la línea que hoy dice que
    facturación no está en el plan**.
23. `README.md` (tabla de puertos), `docs/COMANDOS.md`, `docs/COMANDOS_PRODUCCION.md`,
    `infra/fedora/{INSTALL,RUNBOOK,DESARROLLO}.md` y una sección nueva al principio del `CHANGELOG.md`.

### 7.7 Pruebas propias

24. `services/billing/src/*.integration.test.ts` sobre la base temporal (§7.3 punto 13).
25. `tools/smoke-billing.mjs` (modelo `tools/smoke-reporting.mjs`: `SMOKE_GATEWAY_URL`, credenciales por
    entorno, secciones numeradas, resumen y salida 1) **y su script en el `package.json`**.
26. Un paso nuevo en el array `PASOS` de `tools/e2e-clinica.mjs` si el recorrido completo debe terminar
    cobrando; el mundo de prueba (`packages/testing`, `seed:test`, `seed:verify`) con tasas, catálogo,
    facturas y cobros en la numeración reservada.

### 7.8 Guardias que fallan solas (y las que no)

| Guardia | Qué la dispara |
| :--- | :--- |
| `packages/db/src/boss.test.ts` | consumir eventos sin estar en `EVENT_CONSUMERS` |
| `tools/plantillas-fedora.mjs` (SERVICIOS) | `git add services/billing/src/config.ts` sin estar en `odontocrm` + `ensayo-despliegue.sh` |
| `tools/plantillas-fedora.mjs` (DATABASES) | `install.sh` y `odontocrm-backup.sh` con listas distintas |
| `apps/gateway/src/{upstreams,proxy}.test.ts` | los conteos exactos `8` y `14` |
| `apps/web/src/lib/i18n.ts` | `PERMISSION_LABELS` sin la etiqueta del permiso nuevo (error de compilación) |
| `tools/audit-conexiones.mjs` | permiso declarado que ninguna ruta exige; ruta pública fuera del gateway; llamada de la web sin prefijo; variable de `config.ts` ausente del `.env.example` |

**Y las que no existen** (riesgo silencioso, hay que tocarlas a mano y revisarlas en el diff):
`odontocrm-restore.sh` y `crear-rol-respaldo.sh` (sus listas de bases), `tools/lib/stack.mjs` (la tabla
de puertos) y `infra/windows/ecosystem.config.cjs`. **No hay CI** (`.github/` no existe): la única
puerta es `npm run verify`, que incluye `fedora:check` y el auditor de conexiones.

---

## 8. Pantalla `/caja`

Una sola pantalla, pensada para el mostrador (y para la tableta, como `/flujo`):

* **Pendientes de caja** — la cola del día: pacientes con sesión cerrada y borrador sin emitir, con el
  total y el aviso de partidas sin precio.
* **Borrador** — revisar, corregir cantidades, añadir un bien (cepillo, gel), quitar una línea.
* **Emitir** — un botón, con la tasa que se va a congelar a la vista; después, documento archivado.
* **Cobrar** — medio de pago, monto entregado, **vista previa del IGTF** y del saldo resultante antes de
  confirmar; botón para imprimir factura y recibo.
* **Tasa del día** — el widget de la jornada: valor vigente, origen (`BCV` / manual / arrastre), botón
  para fijarla o corregirla (con motivo), y el aviso cuando el hueco de días supera el umbral.
* **Historial** — facturas del día/semana con estado, saldo, reimpresión (contada y auditada), anulación
  (solo `admin`, con motivo) y descarga del PDF archivado.
* **Libros** — libro de ventas e IGTF percibido por período, en CSV.
* **Catálogo y configuración** — aranceles con su categoría fiscal, y los interruptores de la clínica
  (contribuyente especial, política de imputación, modo de numeración): solo `admin`.
* **Modo test** — el banner de ADR 0020 ya existe; la caja muestra además que la numeración es la de
  prueba (`T-900001`).

---

## 9. Pruebas y criterios de aceptación

**Unitarias** (contrato, sin base):

1. Aritmética: `vesCentimosFromUsd` y `usdCentsFromVes` son inversas dentro del céntimo; el redondeo es
   half-up y se aplica una sola vez; los productos grandes no pierden precisión (casos de 10⁹ y 10¹²).
2. `igtfCents`: 3 % de 100,00 USD = 3,00 USD; 0 cuando no aplica.
3. Las transiciones de `INVOICE_TRANSITIONS` cubren todos los estados y ninguna deja un estado sin salida.

**Integración** (base temporal propia, como `reporting`):

4. `clinical.session.closed` **dos veces** (mismo `eventId`) ⇒ **una** factura y las mismas partidas.
5. Dos sesiones cerradas del mismo paciente ⇒ dos borradores, y `emitir` de ambos asigna **números
   distintos**; dos emisiones simultáneas de la misma factura ⇒ una 409 y un solo número.
6. Emitir congela la tasa: cambiar la tasa del día después **no** altera la factura emitida.
7. Cobro con `cash_usd` de un contribuyente especial ⇒ IGTF 3 % en el recibo y **saldo igual al
   imputado**; cobro con `cash_ves` ⇒ IGTF 0.
8. Abono parcial ⇒ `parcial` y saldo correcto; el que completa ⇒ `pagada` con saldo 0; anular un pago ⇒
   el saldo vuelve y el estado retrocede.
9. La suma de las partidas cuadra con los totales y los `CHECK` rechazan una fila incoherente (se prueba
   el rechazo, no solo el camino feliz).
10. Una factura emitida **no se puede** `update` ni `delete`: la API responde 409 y la base lo impide.
11. Anular exige nota de crédito con número propio y motivo; sin motivo, 400.
12. Sin tasa para la fecha ⇒ arrastre con aviso; con hueco mayor al umbral ⇒ 409 hasta confirmar.
13. Formas libres (si aplica): el correlativo se consume en orden y una forma dañada queda registrada.

**Humo y e2e**:

14. `npm run smoke:billing` (modelo `smoke:prescription`): tasa del día → borrador → emitir → cobrar en
    USD con IGTF → cobrar el resto en Bs → factura pagada → reimpresión contada → anular con NC.
15. `npm run e2e:caja` (si el flujo lo pide): cerrar una sesión en `/flujo`, cobrar en `/caja` e imprimir
    el PDF, con las comprobaciones de siempre (URL vigilada, PDF descargado y abrible).
16. `seed:test` siembra tasas, catálogo, facturas y pagos en la numeración de prueba, y `seed:verify`
    cuadra sus huellas.

**Criterios de aceptación de la fase** (al estilo del plan maestro): `npm run verify` en verde; la
migración desde cero crea todas las tablas; cerrar una sesión no tarda más que antes (la factura es
asíncrona); un cobro completo en caja se resuelve en **menos de 30 segundos** con la impresión incluida;
`npm run estado` muestra el décimo servicio y su base; y el respaldo incluye `odonto_billing`.

---

## 10. Preguntas para el contador (bloquean la numeración, no el resto)

Estas cuatro decisiones cambian el diseño de la numeración y de las leyendas. **Se pueden implementar
§2–§5 sin ellas** (borradores, tasas, cobros, saldos), pero la emisión no debería congelarse hasta
tener la respuesta:

1. **¿Cómo factura hoy la clínica?** ¿Máquina fiscal, formas libres autorizadas o nada todavía? Si es
   máquina fiscal: ¿el número y el número de control los da la máquina? ¿La ponemos a mano en el sistema?
2. **¿La clínica es Sujeto Pasivo Especial (contribuyente especial)?** ¿Y el IGTF lo percibe ella o lo
   debita el banco? ¿Qué medios usa la clínica que caen en el supuesto de divisas (efectivo, Zelle,
   transferencia del exterior)? ¿Con qué periodicidad se entera el IGTF?
3. **¿Las prótesis dentales** se están facturando como venta de bien (Art. 18.4) o dentro del servicio
   exento (Art. 19.6)? Decide la categoría fiscal de esos ítems del catálogo.
4. **¿Los precios se expresan en USD y se pagan en Bs a la tasa del día del pago** (política
   `tasa_del_pago`) **o el paciente paga los Bs impresos** (`tasa_de_la_factura`)? ¿Cómo se ha hecho
   hasta ahora con los tratamientos en cuotas?

Y una de forma: ¿el RIF del paciente hace falta en cada factura o se emite «consumidor final» salvo que
lo pidan? (La v1 lo deja **opcional** por eso.)

---

## 11. Fuera de alcance (con la puerta abierta)

* **Presupuestos y planes de tratamiento** como documentos: el plan clínico ya guarda un `presupuesto`
  por partida (`clinical.ts`) y el odontograma distingue fases (implante quirúrgico / carga de corona).
  Cuando lleguen, la factura se genera **desde el presupuesto aceptado**, y ahí hará falta el histórico
  de precios con vigencia. Hoy: no.
* **Anticipos** (dinero antes de que exista la factura): en la v1 el cobro se imputa a una factura
  emitida. El camino de ampliación es una tabla de aplicaciones (recibo ↔ factura), y está previsto en
  el modelo (`invoice_sessions` ya separa documentos de hechos).
* **Notas de débito y notas de crédito parciales**.
* **Inventario y stock** de los bienes que se venden: se cobran, no se controlan existencias.
* **Seguros, convenios y cuentas por cobrar con mora.**
* **Facturación digital / electrónica** (SENIAT): se modela el modo de numeración para que quepa, pero
  no se implementa hasta que sea obligatorio para la clínica.
* **Multi-sucursal y multi-moneda distinta del par USD/VES.**

---

## 12. Ejecución por sesiones

**Sesión A — cimientos y borradores** (sin dinero todavía): ADRs 0043–0047 escritos y enlazados;
contrato `billing.ts` con aritmética y transiciones probadas; permisos, acciones de auditoría y tópicos;
`clinical.session.closed` con `procedures[]`; esqueleto del servicio, migración, `EVENT_CONSUMERS`,
bootstrap, gateway y `/caja` con la lista de pendientes y el borrador. **Aceptación**: cerrar una sesión
crea el borrador correcto (una sola vez) y se ve en `/caja`.

**Sesión B — el dinero**: tasas (historial, arrastre, corrección, widget), emisión con número y PDF
archivado, cobros con IGTF y saldo, recibos, anulación de pagos, `smoke:billing`. **Aceptación**: el
criterio de los 30 segundos del §9 y la factura cobrada en dos monedas.

**Sesión C — cierre**: notas de crédito, libros (ventas e IGTF) en CSV, catálogo y configuración,
seed determinista, `seed:verify`, pruebas de aceptación de la fase, despliegue en Fedora
(`bootstrap --only billing`, systemd, respaldos, `estado`) y documentación (plan maestro, README,
COMANDOS, CHANGELOG).

Cada sesión termina con `npm run verify` en verde y su commit atómico (convención §14 del plan maestro).

---

## 13. Nota de continuidad — memoria de la sesión (Windows ⇄ Fedora)

> **Para el Gabriel que retome esto en la PC de Windows.** La Fedora es el banco de pruebas con la pila
> compilada y datos de prueba reales: el diseño y la implementación van en Windows, y en Fedora solo se
> **valida** al final (con la base nueva `odonto_billing`, que no toca nada de lo existente).

**Estado del repositorio al escribir esto (2026-10-05):** rama `main`, HEAD `2bb4e62`, Fase 10 cerrada
(tag `fase-10`), 8 servicios + gateway + web en verde, **42 ADRs** en `docs/adr/` (0042 es el último),
`npm run verify` y `npm run fedora:check` como puertas de calidad. **El módulo de facturación no tiene
una línea de código**: este documento es todo lo que hay. *(Ojo: en el momento de escribir esto había
trabajo en curso en `infra/fedora/nginx` y `tools/plantillas-fedora.mjs` — certificados y plantillas—
ajeno a este módulo: no mezclar esos cambios con los de facturación.)*

**Qué hacer al llegar a Windows, en este orden:**

1. `git pull` y `npm ci`; comprobar `npm run verify` en verde **antes** de tocar nada.
2. Escribir los ADRs 0043–0047 en `docs/adr/` (+ índice) y el contrato `billing.ts` con sus pruebas
   **antes** del servicio (regla del proyecto).
3. Crear el esqueleto de `services/billing` copiando el de `reporting` (consumidor + `processed_events`)
   y el de `clinical` (contrato + documentos archivados). Añadir `billing` a `infra/db/bootstrap.mjs`.
4. `npm run db:bootstrap -- --only billing` para crear base, rol y `.env` (es idempotente).
5. `npm run db:generate:billing` → revisar la migración **a mano** (lección de la Fase 9: una migración
   escrita a mano puede quedar invisible para el migrador) → `npm run db:migrate`.
6. Implementar en el orden de §12, con `npm run dev` y `npm run smoke:billing` en cada paso.

**Advertencias para no romper la Fedora de pruebas:**

* **No** correr `npm run db:reset`, `seed:reset` ni `seed:test` en Fedora por probar el módulo: borran y
  reescriben las bases (y `db-reset` toca las nueve). Para validar aquí, `--only billing`.
* El `.env` real no está en el repositorio: en Windows hay que regenerar los secretos de desarrollo
  (`npm run keys:generate` si tocan las claves) y el bootstrap del punto 4 para la base nueva.
* Cambiar `packages/contracts` (permisos, acciones de auditoría, tópicos) **obliga a recompilar todos los
  servicios**: en Fedora eso es `sudo odontocrm recompilar` y reiniciar, no un `npm run dev`.
* El commit del evento `clinical.session.closed` es un **cambio de contrato**: va en su propio commit,
  con aviso en el `CHANGELOG`, y sin él el borrador sale sin partidas.

**Pendientes del proyecto que NO son de este módulo** (no mezclarlos): los P-36…P-42 de la auditoría de
portabilidad, registrados en `infra/fedora/INSTALL.md` §20.2.

**La primera decisión al retomar:** mandar al contador las cuatro preguntas del §10. Nada más
bloquea el diseño; con eso, la Sesión A puede empezar el mismo día.
