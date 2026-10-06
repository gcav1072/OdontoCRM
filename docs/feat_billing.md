# Módulo de Facturación y Pagos — plan de la Fase 11 (revisión 3: decisiones cerradas)

> **Estado:** propuesta revisada · 2026-10-05 · Gabriel + revisión del agente · **cierre fiscal con el
> contador (2026-10-05, Anexo A)**
> **Alcance:** el décimo servicio `services/billing` (puerto **4009**, base `odonto_billing`) y su
> pantalla `/caja`.
> **Nada de esto está implementado todavía.** Este documento es la fuente de verdad y, como manda
> [`PLAN_MAESTRO_FASES.md`](PLAN_MAESTRO_FASES.md) §14/§17, **cada decisión se registra como ADR antes de
> escribir código**.
> **La revisión 2** añadió la **verificación normativa** (Ley de IVA, Ley de IGTF, Providencia
> SNAT/2011/0071 y Convenio Cambiario N.º 1); **la revisión 3 cierra las tres decisiones que estaban
> abiertas** con el contador (§0.1): política de imputación, IGTF y modo de emisión. Ya no hay bloqueos:
> se puede empezar a programar.
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
| B3 | Dinero | `numeric(14, 2)` para VES | **Enteros en todo el módulo**: `integer` céntimos USD, `bigint` céntimos VES, tasa en **micros** (`bigint`). El repositorio **no tiene una sola columna `numeric`/`decimal`** y Drizzle la devuelve como `string`; el propio ADR 0044 promete aritmética sin punto flotante (§3.4, §4) |
| B4 | Estados | `pgEnum` y valores en inglés | `text` + `CHECK` contra las constantes del contrato (`sqlLiteralList`, como `prescriptions`) y **valores en español** (`borrador`, `emitida`…): la convención de [`enums.ts`](../packages/contracts/src/domain/enums.ts) es «valores en snake_case y en español; identificadores en inglés» |
| B5 | Tasa en el borrador | `exchange_rate_bcv` `notNull` en `invoices` | Contradicción: el ADR 0046 dice «se congela al emitir» y el flujo dice «el borrador nace con la tasa del día». Se separan: tasa **provisional** del borrador y tasa **definitiva** al emitir, con `CHECK` por estado (§5.2) |
| B6 | Imputación del pago en bolívares | «permite conciliar diferencias cambiarias», sin regla | **La decisión más importante del módulo**, hoy indefinida: ¿el paciente paga los Bs impresos en la factura o se recalcula con la tasa del día del pago? Se elige una política configurable, se guardan los dos hechos y se imprime la leyenda (§3.4, §5.3) |
| B7 | Numeración fiscal | `last_invoice_number` en la tabla de perfil | Es una carrera y asume que el número lo da el software. Se usa **secuencia + serie + `unique(serie, número)`** (patrón `prescription_number_seq`) y un modo de numeración explícito, porque en Venezuela el número puede venir de una **máquina fiscal** o de **formas libres** autorizadas (§5.2, ADR 0047) |
| B8 | Notas de crédito | Un comentario (`voided // Anulada por Nota de Crédito`) | Tabla propia, serie `NC-000001`, referencia obligatoria a la factura, motivo, PDF archivado y evento (§5.4) |
| B9 | Anulación de pagos y recibos | No existe | Un pago **no se borra: se anula con motivo** (misma regla que el récipe emitido, ADR [0036](adr/0036-recipe-emitido-documento-archivado.md)) y el saldo se recalcula en la misma transacción (§4, §5.3) |
| B10 | Auditoría | No se menciona | Cada acto de dinero publica `auditPayload` y aparece en `/auditoria`; hay que añadir las acciones a `AUDIT_ACTIONS` y sus etiquetas en `i18n.ts` (§3.5) |
| B11 | Permisos | No se mencionan | Cinco permisos nuevos y su reparto por rol (§3.5) |
| B12 | Datos del emisor | Tabla `clinic_fiscal_profiles` nueva | Duplica los datos del consultorio, que ya viven en [`packages/contracts/src/clinic.ts`](../packages/contracts/src/clinic.ts) y leen los ocho servicios. Se reutilizan, pero **sacándolos del código**: pasan a un bloque `CLINIC_*` del entorno con genéricos `CAMBIAR_*` (§2.4); en la base solo queda lo fiscal mutable (§4, §6) |
| B13 | Alícuotas | `igtf_percentage` en una columna e IVA 16 % cableado en el enum | Tarifas **con vigencia** (`tax_rates`, `igtf_rules`) y **alícuota aplicada copiada en el documento**: cambiar el 16 % o el 3 % mañana no puede reescribir lo ya emitido. Fuera `reduced_8`: **no existe alícuota reducida vigente** (§3.3, §11) |
| B14 | El evento no lleva lo que el consumidor necesita | `session.procedureCodes` a secas | El borrador necesita **código, pieza, caras y detalle** de cada procedimiento (ADR [0041](adr/0041-el-evento-lleva-lo-que-el-consumidor-necesita.md)): se completa el bloque `session` de `clinical.session.closed` de forma **aditiva** y con aviso en el `CHANGELOG` (§5.1) |
| B15 | Factura ↔ sesión | `clinical_session_id` en `invoices` (1:1) | Un tratamiento que se cobra al final cubre **varias sesiones**. Tabla de enlace N:M desde el principio (con unicidad por sesión, que además es la segunda red de idempotencia); la v1 emite una factura por sesión y la unificación queda como camino abierto (§4, §11) |
| M1 | Documento | «Motor PDF» que recompone al imprimir | **Emitir archiva**: PDF generado una vez, `sha256`, `print_count` y `last_printed_at` (ADR 0036). Lo que se reimprime es el mismo archivo (§6) |
| M2 | Máquina de estados | Implícita en los `if` | `INVOICE_TRANSITIONS` **como dato** con roles y motivo, igual que `APPOINTMENT_TRANSITIONS` (§3.1) |
| M3 | Catálogo | Libre | Alineado con los **28 códigos de `SESSION_PROCEDURES`** para que el borrador se genere solo; lo que no tenga precio entra en 0 y **marcado**, para que la caja nunca se bloquee (§5.6) |
| M4 | Libro de ventas e IGTF | No está | Libro de ventas en CSV (base **desglosada por alícuota** y total exento aparte, como pide el Art. 13 num. 10) y el de IGTF **el día que haya algo que declarar**: es lo primero que pide el contador (§9) |
| M5 | Pruebas, seed y humo | No están | Base temporal propia, `npm run smoke:billing`, mundo determinista del ADR [0042](adr/0042-el-seed-escribe-filas-y-eventos.md) y un e2e de caja (§9, §12) |
| M6 | Recibo vs. factura | Mezclados | Dos series y dos documentos: **factura** (fiscal) y **recibo** `REC-000001` (interno, con el IGTF y la tasa del pago) (§6) |
| M7 | Modo test | No se menciona | Numeración y series **reservadas** (`900.000+`, serie `T`) como los récipes y los tickets: la numeración real nunca ve un número de prueba (ADR 0020/0042) (§4) |
| M8 | Tasa del día ausente | «el sistema opera con autonomía» | Falta la regla: **arrastre** de la última tasa publicada con aviso si el hueco supera N días, y confirmación explícita para cobrar con una tasa vieja (§5.5) |
| R1 | IGTF | «3 % sobre efectivo en divisas» | Confirmado el **3 % para los supuestos de divisas** (Art. 24 de la Ley de IGTF), pero el 2 % general quedó en **0 %** (Decreto 4.972, jul-2024) y **quién lo percibe cambia según el medio**: en divisas por el sistema bancario nacional lo debita el **banco** (Art. 4.5, sin importar si la clínica es SPE); el efectivo en divisas y Zelle/USDT lo percibe **la clínica solo si está calificada como Sujeto Pasivo Especial** (Art. 4.6). Se modela **por medio de pago y con quién percibe** (§3.2, §5.3, §10). **Cerrado (§0.1): la clínica no es SPE, así que no percibe IGTF en caja.** |
| R2 | Validez de la factura | Se asume que el PDF impreso **es** la factura | **Un PDF impreso en hoja blanca no es una factura válida** para un contribuyente ordinario: la Providencia SNAT/2011/0071 solo admite **formatos** o **formas libres** de imprenta autorizada (con **número de control preimpreso**) o **máquina fiscal** (Art. 6). Los servicios odontológicos **no** están en la lista del Art. 8, así que la máquina fiscal no es obligatoria; el régimen digital (Providencia SNAT/2024/000102) es **opt-in** salvo venta exclusivamente electrónica. Decide quién asigna el número (ADR 0047, §10) |
| R3 | Leyendas y artículo | «Exento de IVA de conformidad con el Art. 18, num. 4» | El artículo está mal: la exención de servicios odontológicos es el **Art. 19, numeral 6** de la Ley de IVA (el Art. 18.4 es de **ventas** de bienes, prótesis incluidas). Lo que exige la Providencia 0071 es la letra **`(E)`** junto a la descripción o al precio (Art. 13 num. 8) y el **total exento separado** (num. 10); «sin derecho a crédito fiscal» va **en las copias** (num. 13) (§6, §10) |
| R4 | Alícuota adicional por pago en divisas | No se menciona | La Ley de IVA (Art. 27 ¶4 y **Art. 62**) prevé una alícuota **adicional** del 5 %–25 % para operaciones pagadas en divisas, y su parágrafo primero dice que en las operaciones **exentas** solo aplica esa adicional. **Solo rige por Decreto del Ejecutivo y no hay evidencia de que exista**: se deja el gancho en la configuración y en el modelo (0 % por defecto), no en el código (§3.3, §10) |
| R5 | Sujeto Pasivo Especial | `is_special_taxpayer` como dato de la clínica | Es **el pivote de todo el IGTF**: la calificación la **notifica el SENIAT**, no se autodeclara. Hay que confirmarlo por escrito antes de cobrar 3 % en efectivo (y no cobrarlo si no aplica), porque el efectivo en divisas queda fuera del Art. 4.6 para quien no es SPE (§10). **Cerrado (§0.1, Anexo A): contribuyente ordinario, sin notificación de SPE ⇒ el interruptor queda apagado.** |
| R6 | Forma del documento | «Imprime A5 / Carta» | La Providencia 0071 exige **una página por documento, mínimo 8 cm** (Art. 33: si la operación no cabe, se emiten **varios documentos, cada uno con su número**), fechas **DDMMAAAA** (Art. 34), sin enmiendas (Art. 41) y conservando **originales y copias** de lo anulado (Art. 36). Con **formas libres**, una factura larga consume **varias formas**: el diseño no puede asumir «una factura = un papel» (§6) |
| R7 | Crédito fiscal de compras | No se menciona | Como la clínica factura sobre todo **exento**, **no tiene derecho a deducir el IVA de sus compras** (Ley de IVA Art. 33): no se construye ningún libro de crédito fiscal de compras. El IVA de insumos, laboratorio y alquiler es **costo** (§11) |

### 0.1 Cierre fiscal y de alcance con el contador y con Gabriel (2026-10-05) — ya no hay bloqueos

La hoja de confirmación (Anexo A) volvió marcada y después se cerraron las decisiones que quedaban
abiertas. Esto es lo que queda fijado:

| Pregunta | Respuesta | Efecto en el plan |
| :--- | :--- | :--- |
| Régimen fiscal | **Contribuyente ordinario** (no Sujeto Pasivo Especial) | `is_special_taxpayer = false`: la clínica **no percibe IGTF** |
| Formato de facturación | **Formas libres** de imprenta autorizada | Modo por defecto `formas_libres`: **dos números** (correlativo propio + control preimpreso) |
| Pago en bolívares | **Tasa del día en que el paciente paga** (Conv. Cambiario N.º 1) | `imputation_policy = 'tasa_del_pago'` — la que el plan ya recomendaba |
| IGTF en caja | **No se percibe** | El IGTF queda **dormido pero modelado y probado**: si algún día notifican a la clínica como SPE, se enciende con un interruptor |
| **Anticipos** (abono antes de emitir) | **No**: primero se emite la factura y luego se cobra | Se queda fuera de la v1 (§11); los abonos parciales sobre una factura emitida sí entran |
| **Bienes al 16 %** (cepillos, geles) | **Sí, hay que poder facturarlos** | El catálogo nace con bienes de ejemplo y el camino gravado (base desglosada + IVA) queda **activo** |
| **Emisión a crédito** | **No**: emitir y cobrar son el mismo acto | `emitida` sin cobro no es el flujo normal; la factura puede quedar con saldo (pago parcial) pero se emite en el mostrador |
| **Prótesis e implantes** | **Dentro del servicio exento** | Todas las partidas odontológicas nacen `exento` con la letra `(E)` |
| **Libro de compras** | **Solo el de ventas** | El de compras lo lleva el contador: no se registran facturas de proveedores |
| **Cambio de contrato en `clinical`** | **Aprobado**: `session.procedures[]` aditivo | El borrador se arma solo desde la sesión (ADR 0041), con aviso en el `CHANGELOG` |
| **Tasa BCV** | Captura **automática** con respaldo manual | Worker diario + ingreso a mano si falla; el arrastre se confirma en pantalla |
| **Quién anula** | **Administrador y secretaría**, con motivo | `billing:void` para los dos; el odontólogo solo lectura |
| **Nombre de la interfaz** | **«Caja» en `/caja`** | Es el nombre que usa el personal para el mostrador |
| **Datos del consultorio** | **Por entorno**, con genéricos `CAMBIAR_*` | Perfil `CLINIC_*` en el `.env` común y en `/etc/odontocrm/odontocrm.env` (§2.4) |

Lo que cambia de verdad en las secciones siguientes:

1. **El IGTF no se cobra en esta instalación**; y además **nunca** en pagos bancarizados en divisas, donde
   el agente de percepción es el **banco** (Art. 4.5): cobrarlo sería cobrar dos veces. Con
   `is_special_taxpayer = false` la pantalla **bloquea** añadir IGTF y muestra «Clínica no calificada como
   Sujeto Pasivo Especial (IGTF no percibido)» (§5.3, ADR 0045).
2. **La factura lleva la leyenda de doble tasa** (emisión + pago) con el **texto exacto** que fijó el
   contador, porque los Bs se liquidan a la tasa de la fecha del pago (§6).
3. **El modo de emisión es `formas_libres`**: el software genera su **correlativo interno**
   (`invoice_number_seq`) y el **número de control** va aparte, el que viene preimpreso. La plantilla se
   calibra para **no pisar** el membrete ni el control de la imprenta (§5.2, §6, ADR 0047).
4. **Los datos del consultorio dejan de ser código**: pasan a un bloque `CLINIC_*` del entorno, con
   genéricos `CAMBIAR_*` siguiendo el formato, `.env.example` y el archivo **común** de producción
   (§2.4). Es un cambio que beneficia también al récipe y a los reportes.
5. Los caminos de **máquina fiscal** y de **régimen digital** quedan modelados y sin usar: si cambia el
   criterio, es configuración y alta de un lote, no una migración.

> **Un matiz que conviene dejar escrito** (por si alguien lo relee dentro de un año): la Providencia
> **SNAT/2026/00084** (Gaceta 43.435, 12-ago-2026) eliminó el **registro y homologación de proveedores de
> sistemas informáticos de facturación** (derogó la SNAT/2024/000121) —eso es lo que habilita que el
> software propio de la clínica imprima las facturas—, pero **no** tocó la exigencia de soporte del
> **Art. 6 de la Providencia SNAT/2011/0071**: se sigue facturando **sobre formas libres autorizadas**,
> con su número de control preimpreso. «Sin homologación de proveedor» **no** significa «cualquier PDF en
> hoja blanca vale».

---

## 1. Registro de decisiones (ADR)

**Convención del proyecto (y no se rompe aquí):** una ADR por decisión, en su archivo
`docs/adr/NNNN-slug.md`, enlazada desde el índice [`docs/adr/README.md`](adr/README.md). **El número
0043 ya está ocupado**: lo tomó el [ADR 0043](adr/0043-se-descarta-el-enfoque-de-instalacion-actual.md)
—instalación y despliegue, 2026-10-05—, que se escribió **después** de la v1 de este documento. Así que
el directorio termina en **0043** y estas cinco entran como **0044–0048**.

**Ya están escritas** (2026-10-06): las cinco viven en `docs/adr/` y están enlazadas desde el índice. Lo
que sigue en esta sección es el **resumen operativo** del plan, no la decisión registrada:

| # | Archivo |
| :-: | :--- |
| 0044 | [`adr/0044-modulo-de-facturacion-desacoplado.md`](adr/0044-modulo-de-facturacion-desacoplado.md) |
| 0045 | [`adr/0045-regimen-tributario-iva-e-igtf.md`](adr/0045-regimen-tributario-iva-e-igtf.md) |
| 0046 | [`adr/0046-tasa-bcv-historica-y-regla-de-imputacion.md`](adr/0046-tasa-bcv-historica-y-regla-de-imputacion.md) |
| 0047 | [`adr/0047-quien-asigna-el-numero-de-la-factura.md`](adr/0047-quien-asigna-el-numero-de-la-factura.md) |
| 0048 | [`adr/0048-el-documento-de-cobro-se-archiva.md`](adr/0048-el-documento-de-cobro-se-archiva.md) |

> **Corrección de numeración (2026-10-06):** la v1 las numeraba 0043–0047 dando por hecho que 0042 era el
> último. El ADR del instalador se adelantó y el primero de estos cinco chocaba de frente con él (el
> propio §7.5, punto 17, ya citaba «ADR 0043» refiriéndose al instalador: el documento se contradecía
> consigo mismo). **Los números buenos son 0044–0048.**

> Cuenta cuadrada (2026-10-06): en `docs/adr/` hay **48** entradas; el `README.md` ya dice 48 y la fila de
> la Fase 10 del plan maestro dice **42**, que es lo que existía al cerrarla (el 0043 llegó después).

### ADR 0044 — Módulo de facturación desacoplado y gestión de pagos

* **Estado:** aceptada (2026-10-05) · registrada en
  [`adr/0044-modulo-de-facturacion-desacoplado.md`](adr/0044-modulo-de-facturacion-desacoplado.md)
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
     ahí solo se anula con motivo (ADR 0048).
* **Consecuencias:**
  * ✅ La atención clínica sigue aunque la caja esté parada o sin tasa.
  * ✅ La contabilidad se puede auditar sin leer una sola tabla clínica.
  * ⚠️ Los datos del paciente se copian al documento (instantánea) y se sincronizan por evento y por la
    ruta interna de pacientes; hay reconciliación periódica de saldos.

### ADR 0045 — Régimen tributario: IVA exento, IVA general e IGTF percibido

* **Estado:** aceptada (2026-10-05, cierre con el contador) · registrada en
  [`adr/0045-regimen-tributario-iva-e-igtf.md`](adr/0045-regimen-tributario-iva-e-igtf.md) · la clínica es
  **contribuyente ordinario y no está calificada como Sujeto Pasivo Especial**: **no percibe IGTF**, pero
  el modelo lo soporta encendido por si el SENIAT la notifica algún día.
* **Contexto:**
  * Los **servicios odontológicos y médico-asistenciales están exentos de IVA** (Ley de IVA, **Art. 19,
    numeral 6**; *no* el Art. 18.4, que habla de ventas de bienes —prótesis incluidas—, y que conviene
    preguntar al contador si la clínica lo usa para prótesis).
  * La **venta accesoria de bienes** (cepillos, geles, insumos) está **gravada** a la alícuota general
    **16 %** (Art. 27 fija la banda 8 %–16,5 % y el Art. 63 la fija en 16 % hasta que el Ejecutivo diga
    otra cosa; **la alícuota reducida del 8 % no está vigente**).
  * El **IGTF** grava el **medio de pago**: Ley de IGTF (Gaceta Oficial Extraordinaria 6.687, 25-feb-2022).
    El **Art. 24** fija **3 %** para los supuestos de divisas y **2 %** para los generales, pero el
    **Decreto 4.972 (Gaceta 6.821 Ext., jul-2024) bajó el general a 0 %**: hoy el IGTF que le importa a la
    clínica es el **3 % de las operaciones en divisas**. Y **no es solo efectivo** (Art. 3 nums. 6 y 8):
    * **Divisas a través del sistema bancario nacional** (tarjeta o transferencia en divisas) → **Art. 4.5**,
      aplica a cualquiera y **lo debita el banco**.
    * **Divisas sin mediación de instituciones financieras** (efectivo USD, **Zelle**, PayPal, USDT) →
      **Art. 4.6**, y ahí **la clínica solo percibe si está calificada como Sujeto Pasivo Especial (SPE)**,
      condición que **notifica el SENIAT**. La interpretación de la Gerencia de Servicios Jurídicos del
      SENIAT (abr-2022) sostiene que Zelle y compañía **sí** causan IGTF.
    * El **período del IGTF es de un día** (Art. 15) y **no es deducible de ISLR** (Art. 18): es dinero de
      terceros que se recauda y se entera.
  * Requisito de forma: la Providencia **SNAT/2011/0071, Art. 13 num. 8** pide la letra **`(E)`** junto a
    la partida exenta/exonerada/no sujeta y el **num. 10** el **total exento separado** de la base
    gravada; el «**sin derecho a crédito fiscal**» de las **copias** es el Art. 13 num. 13.
  * Y una que conviene no olvidar: como la clínica factura sobre todo **exento**, **no puede deducir el
    IVA de sus compras** (Ley de IVA Art. 33): el IVA de insumos y alquiler es costo, no crédito fiscal.
* **Decisión:**
  1. Cada ítem del catálogo lleva `tax_category` (`exento`, `general`) y el documento **copia la alícuota
     aplicada**: los porcentajes viven en `tax_rates` con fecha de vigencia, no en una columna editable.
  2. Los servicios odontológicos son `exento` por defecto; los bienes, `general` (16 %).
  3. El IGTF **no forma parte de la factura**: se calcula en el **cobro**, se copia la alícuota aplicada y
     **quién lo percibe** (`clinica` | `banco`), y se imprime en el **recibo**, con su propia línea. Si lo
     debita el banco, la clínica **no lo cobra dos veces**: solo lo registra para conciliar.
  4. Qué medios causan IGTF y quién lo percibe es **configuración por medio de pago** (`igtf_rules`), no un
     `if`. **Configuración de esta clínica (cerrada el 2026-10-05): `is_special_taxpayer = false`, ningún
     medio con percepción de la clínica** —todos `no_aplica` o `banco`—, así que el recibo **no cobra
     IGTF**; tarjeta y transferencia en divisas quedan marcadas como «lo debita el banco» solo para
     conciliar el extracto.
  5. La **calificación de SPE** es un dato de configuración con su fecha y su constancia (hoy: sin
     constancia ⇒ `false`). Mientras esté en `false`, la interfaz **bloquea** añadir IGTF a un cobro y
     muestra la etiqueta informativa «Clínica no calificada como Sujeto Pasivo Especial (IGTF no
     percibido)»; con `true`, el 3 % se calcula solo sobre la partida del recibo. Es el error más caro en
     los dos sentidos: cobrar un tributo que no corresponde, o no cobrarlo cuando sí.
  6. La **alícuota adicional por pago en divisas** (Art. 27 ¶4 y **Art. 62**, 5 %–25 %) queda como
     **gancho de configuración en 0 %** mientras no exista el Decreto que la active: si aparece, el
     parágrafo primero dice que en las operaciones exentas **solo aplica esa adicional** (R4).
  7. El **reporte de IGTF percibido por día** es parte del alcance (M4): sin él, la clínica no puede
     enterarlo.
* **Consecuencias:**
  * ✅ Cambiar una alícuota es un `insert` con vigencia, no una migración ni un `update` que reescriba la
    historia.
  * ✅ El desglose exento/gravado sale en el documento y en el libro de ventas.
  * ⚠️ El IGTF percibido es **dinero de terceros** (se recauda del paciente y se entera, con período
    **diario** para lo bancario): debe cuadrar caja contra recaudación, y eso es una comprobación de la
    interfaz.
  * ⚠️ La respuesta sobre **SPE** es la que más cambia el comportamiento real del módulo: hasta tenerla,
    el medio sujeto se configura pero la interfaz lo marca como **«pendiente de confirmar»**.

### ADR 0046 — Tasa BCV: histórica, congelada por documento y con regla de imputación

* **Estado:** aceptada (2026-10-05, cierre con el contador): se liquida a la **tasa del día del pago**
  (`tasa_del_pago`), con la leyenda de doble tasa impresa en la factura · registrada en
  [`adr/0046-tasa-bcv-historica-y-regla-de-imputacion.md`](adr/0046-tasa-bcv-historica-y-regla-de-imputacion.md).
* **Contexto:** los valores se expresan en moneda de cuenta (USD) y se pagan en moneda de curso legal
  (VES). Es **legal y está expresamente previsto**: el **Convenio Cambiario N° 1** (Gaceta 6.405 Ext.,
  7-sep-2018, que desarrolla el Art. 128 de la Ley del BCV) dice en su **Art. 8.a** que, cuando la
  obligación se pacta en moneda extranjera **como moneda de cuenta**, «el pago podrá efectuarse en dicha
  moneda **o en bolívares, al tipo de cambio vigente para la fecha del pago**». Por el lado del IVA, el
  **Art. 25** de la Ley de IVA manda usar el tipo de cambio **del día del hecho imponible**, y el
  **Art. 13 num. 14** de la Providencia 0071 exige que la factura muestre **ambas cantidades y el tipo de
  cambio aplicable**. Facturas y abonos caen en fechas distintas (cuotas, tratamientos largos), así que
  consultar la tasa «al vuelo» produce incongruencias y depende de la red.
* **Decisión:**
  1. `exchange_rates`: tabla **histórica y de solo agregado** (una fila por fecha y fuente, con
     `supersedes_id` si hay corrección). La tasa se guarda en **micros** (entero) y se identifica su
     origen: `bcv_oficial`, `manual`, `arrastre`.
  2. Al **emitir**, la factura congela la tasa del **día del hecho imponible** (Art. 25) y sus totales en
     ambas monedas —que es la obligación de forma del Art. 13 num. 14—.
  3. Al **cobrar**, el pago congela **su** tasa, el monto **entregado** por el paciente y su moneda.
  4. **Regla de imputación (la decisión que faltaba, B6):** una sola política por instalación, guardada
     en la configuración y registrada en cada pago:
     * `tasa_del_pago` (**recomendada, y es la que describe el Convenio Cambiario Art. 8.a**): el paciente
       paga en Bs **al valor de hoy**; los Bs impresos en la factura son referenciales («a la tasa del
       DD/MM/AAAA») y las diferencias cambiarias quedan del lado del paciente.
     * `tasa_de_la_factura`: el paciente paga **exactamente** los Bs impresos; la clínica asume la
       diferencia cambiaria.
     En los dos casos se guardan los dos hechos (entregado y tasa), así que se puede recalcular y
     reportar el diferencial sin haber tomado la decisión de nuevo.
  5. **Sin red, la caja no se detiene:** el BCV **publica solo en días hábiles** (fines de semana y
     feriados conservan la última tasa) y **no tiene API oficial**: solo una página web con formato
     humano. Si no hay tasa para la fecha se usa la última publicada (`arrastre`) y la pantalla avisa; con
     un hueco mayor al umbral configurado, cobrar exige confirmar. La captura automática es **best-effort**
     y siempre queda el ingreso manual auditado.
  6. Todo se calcula en **`America/Caracas`**: el «día» de la tasa y de la operación no es UTC.
* **Consecuencias:** reimpresión y auditoría muestran exactamente lo que decía el papel; el módulo
  funciona sin internet; y la política cambiaria es una decisión explícita y visible, no un efecto
  colateral del redondeo. La factura cumple el doble requisito de mostrar las dos monedas y la tasa.

### ADR 0047 — Quién asigna el número de la factura (formas libres, máquina fiscal o régimen digital)

* **Estado:** aceptada (2026-10-05, cierre con el contador): se factura en **formas libres** de imprenta
  autorizada, con el software propio imprimiendo los datos sobre la forma. Máquina fiscal y régimen
  digital quedan modelados y sin usar · registrada en
  [`adr/0047-quien-asigna-el-numero-de-la-factura.md`](adr/0047-quien-asigna-el-numero-de-la-factura.md).
* **Contexto:** la factura de un contribuyente ordinario solo puede emitirse por **tres caminos**
  (Providencia SNAT/2011/0071, **Art. 6**): **formatos** o **formas libres** de una imprenta autorizada
  —con el **número de control preimpreso** y, en las formas libres, la razón social y RIF de la imprenta,
  la providencia que la autoriza y el **rango asignado «desde el N°… hasta el N°…»** (Arts. 7, 30, 31)— o
  **máquina fiscal**. **Está prohibido llenar a mano una forma libre** y, por tanto, **un PDF impreso en
  hoja blanca no es una factura válida**.
  Los servicios odontológicos **no** están en la lista de actividades del **Art. 8**, así que la máquina
  fiscal **no es obligatoria** para la clínica (ojo: si crecen las ventas de cosméticos o de artículos
  ortopédicos/farmacéuticos del catálogo, esas letras sí están en la lista). El **régimen de facturación
  digital** (Providencia SNAT/2024/000102) es **opt-in**, obligatorio solo para quien opera
  **exclusivamente** por medios electrónicos. Y la providencia que obligaba a **registrar y homologar a
  los proveedores de sistemas informáticos de facturación** (SNAT/2024/000121) fue **derogada** por la
  **SNAT/2026/00084** (Gaceta 43.435, 12-ago-2026): por eso el software propio de la clínica puede emitir
  los datos sobre las formas libres **sin homologación de proveedor** —lo que no desaparece es la
  exigencia de soporte del Art. 6—. Así que el camino de esta clínica es **formas libres** —y ahí el
  número de control **no lo da el software**.
  Requisitos que condicionan el papel: **una página por documento, mínimo 8 cm**; si la operación no
  cabe, se emiten **varios documentos, cada uno con su número** (Art. 33); fechas en **DDMMAAAA**
  (Art. 34); **sin enmiendas ni tachaduras** (Art. 41); los **originales y copias de lo anulado se
  conservan** (Art. 36) y las formas sin usar **solo se destruyen con autorización del SENIAT** (Art. 40).
* **Decisión (marco que sirve para los tres casos):**
  1. `invoice_series` declara el modo: `software` (nosotros numeramos), `formas_libres` (consumimos un
     **rango de control** autorizado y registramos el lote con los datos de la imprenta) o
     `maquina_fiscal` (el número lo da la máquina y se registra/valida al vuelo).
  2. **Dos números distintos, y no se confunden**: el **número consecutivo y único** de la factura
     (Art. 13 num. 2), que sale de una **secuencia** nuestra (atómica) —el correlativo interno del
     software, `A-000123`—, y el **número de control** preimpreso (num. 3), que **viene de la forma** y se
     teclea o se escanea al dar de alta el lote. La emisión es el único punto donde se consumen los dos;
     `unique(series, number)` + `CHECK` de emitida (patrón exacto de `prescriptions`).
  3. **En formas libres**, un fallo al generar el PDF **no deja un hueco mudo**: la forma se registra
     como anulada con motivo (`forma dañada`) ocupando su control, y el documento **se conserva**
     (Art. 36). Lo mismo para el rango agotado o un lote dado de baja.
  4. La **plantilla se calibra sobre la forma física** (muestra de la imprenta): márgenes `@page` medidos
     para que el texto caiga **solo en las áreas en blanco**, sin pisar el membrete ni el **número de
     control** de la imprenta. La calibración se prueba imprimiendo sobre una forma real antes de dar la
     fase por cerrada.
  5. La **factura larga se parte**: si las partidas no caben en una página, se emiten **varios documentos
     con su propio número**, no un papel de dos caras.
  6. El **recibo** interno (`REC-`) y la **nota de crédito** (`NC-`) son series nuestras en cualquier
     modo —la nota de crédito, además, **obligatoria por ley** cuando la operación queda sin efecto total
     o parcialmente (Art. 22)—.
  7. **Contingencia** (Art. 10): si el sistema está caído, se emite en **formatos autorizados** con el
     número precedido de la palabra «serie» y se carga después: el procedimiento se documenta en la
     pantalla de caja, no se improvisa.
* **Consecuencias:** ✅ el módulo sirve para los tres escenarios sin migración y la numeración sigue
  siendo auditable. ⚠️ Si el contador confirma formas libres, hay una **carga operativa real** (comprar
  las formas, alimentarlas en la impresora, dar de alta el lote y vigilar el rango) y la interfaz tiene
  que **avisar cuando quedan pocas**: quedarse sin formas es quedarse sin poder facturar. ⚠️ Si confirma
  máquina fiscal, la pantalla de caja gana un paso manual y el PDF del sistema pasa a ser el
  **comprobante interno**, no la factura.

### ADR 0048 — El documento de cobro se archiva (y se anula, nunca se borra)

* **Estado:** aceptada (2026-10-05) · registrada en
  [`adr/0048-el-documento-de-cobro-se-archiva.md`](adr/0048-el-documento-de-cobro-se-archiva.md)
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

### 2.4 Datos del consultorio y configuración por entorno (`CLINIC_*`)

**El problema que resuelve:** hoy los datos del consultorio (nombre, razón social, RIF, dirección,
teléfonos, logo y los odontólogos que firman) viven en
[`packages/contracts/src/clinic.ts`](../packages/contracts/src/clinic.ts) —una constante de código que hay
que **editar y recompilar** en cada instalación— y el RIF nace vacío. La factura los necesita, y dentro
del repositorio no pueden estar: van al **entorno**, como el resto de los datos de cada instalación
(ADR [0024](adr/0024-secretos-fuera-del-repositorio.md)).

**Cómo queda:**

1. `clinic.ts` conserva el **tipo** (`ClinicIdentity`, `ClinicDentist`), los **genéricos de ejemplo** y los
   ayudantes que ya existen —`clinicFullAddress`, `clinicContactLine`, `clinicLeadDentist`,
   `clinicDentistFor`, `letterheadMissingFields`, **todos con el perfil como parámetro opcional**—, así
   que esto **no es un refactor**: es pasar el perfil resuelto en vez de confiar en el valor por defecto.
2. `packages/kernel` gana `clinicEnvSchema` + `resolveClinicProfile(env)`: lee el bloque `CLINIC_*` y
   **pisa** los genéricos. Precedencia: entorno > genérico.
3. Los genéricos llevan el marcador **`CAMBIAR_*`** que el proyecto ya usa para «falta reemplazar»:
   `infra/fedora/install.sh` los escribe en las plantillas, `sudo odontocrm verificar` **avisa** de
   cualquiera sin sustituir y `letterheadMissingFields()` los enumera. El sistema **no se cae** por datos
   incompletos: imprime lo que hay y avisa —igual que hace hoy el diálogo del récipe—, porque la clínica
   tiene que poder cobrar el primer día aunque el logo llegue después.
4. **El navegador no lee `.env`**: el bloque público del perfil se publica en `GET /api/v1/meta` —que ya
   es público, ya lo consume la interfaz para el banner de modo test y no lleva datos de pacientes— y la
   web lo toma de ahí; mientras no llegue, muestra el estado de carga en vez de un membrete inventado.
5. **Producción**: `CLINIC_*` va en el archivo **común** `/etc/odontocrm/odontocrm.env` (el mismo para
   todos), porque lo necesitan los seis servicios que imprimen o firman: `clinical` (récipe A5),
   `reporting` (PDF A4), `billing` (factura y recibo), `screens`, `scheduling` y `notifications`.
6. **Genérico vs. operativo**: al entorno va lo que **describe** a la clínica (identidad y datos fiscales
   del emisor). Lo **operativo con historia** —el lote de formas libres, la tasa del día, los aranceles—
   vive en la base, porque se consume en orden, se audita y cambia con el tiempo. La configuración fiscal
   (SPE, política de imputación, alícuota adicional) nace del entorno como **valor inicial** y después
   manda la base, editable por el `admin` y auditada.

**El bloque del entorno** (genéricos que van al `.env.example` y a la plantilla de Fedora):

```dotenv
# ── Datos del consultorio (los imprimen la factura, el récipe y los reportes) ──
CLINIC_NAME="Consultorio Odontológico CAMBIAR_NOMBRE"
CLINIC_LEGAL_NAME="CAMBIAR_RAZON_SOCIAL, C.A."
CLINIC_RIF="J-CAMBIAR_RIF"
CLINIC_ADDRESS="CAMBIAR_DIRECCION_FISCAL"
CLINIC_CITY="CAMBIAR_CIUDAD"
CLINIC_PHONE_1="+58 000-0000000"
CLINIC_PHONE_2=""
CLINIC_EMAIL=""
CLINIC_WEBSITE=""
CLINIC_LOGO_PATH="assets/clinic/logo.png"
# Odontólogos que firman (el primero es el titular).
CLINIC_DENTISTS_JSON='[{"username":"odontologo","fullName":"Od. CAMBIAR_NOMBRE","mpps":"CAMBIAR_MPPS","specialty":"Odontología general","licenseNumber":null,"email":null}]'
```

**Lo que hay que tocar** (es un cambio **compartido**, no de facturación): `packages/contracts/src/clinic.ts`
· `packages/kernel` (esquema y resolución) · los seis servicios que imprimen o firman · `SystemMeta` en
contratos y `apps/gateway/src/meta.ts` · la web (el hook del meta y `VerifyPrescriptionPage`) ·
`.env.example` de la raíz · `infra/fedora/install.sh` (archivo común) y `infra/fedora/INSTALL.md` §8.0,
que hoy enseña a editar el archivo de código · `tools/plantillas-fedora.mjs` y
`tools/audit-conexiones.mjs`, que exigen que toda variable declarada esté en las plantillas y en el
`.env.example`.

> **Por qué se hace ahora y no después:** el récipe A5 y los reportes ya sufren este problema (hay que
> editar código y recompilar para poner el RIF), y la factura lo hereda. Se arregla **una vez**, en un
> commit propio, con su prueba de impresión; y a partir de ahí la instalación de una clínica nueva no
> toca el repositorio.

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
/** `percibe`: quién entera el IGTF. `banco` = ya lo debitó el banco, la clínica solo lo registra. */
export const PAYMENT_METHODS = [
  { code: 'cash_usd',            label: 'Efectivo en divisas (USD)',      currency: 'USD', percibe: 'clinica_si_spe' },
  { code: 'cash_ves',            label: 'Efectivo en bolívares',          currency: 'VES', percibe: 'no_aplica'     },
  { code: 'pago_movil',          label: 'Pago móvil',                     currency: 'VES', percibe: 'no_aplica'     },
  { code: 'transfer_ves',        label: 'Transferencia nacional (Bs)',    currency: 'VES', percibe: 'no_aplica'     },
  { code: 'pos_debit',           label: 'Punto de venta (débito, Bs)',    currency: 'VES', percibe: 'no_aplica'     },
  { code: 'pos_credit',          label: 'Punto de venta (crédito, Bs)',   currency: 'VES', percibe: 'no_aplica'     },
  { code: 'card_usd',            label: 'Tarjeta en divisas',             currency: 'USD', percibe: 'banco'         },
  { code: 'transfer_usd_local',  label: 'Transferencia en divisas (banco nacional)', currency: 'USD', percibe: 'banco' },
  { code: 'zelle',               label: 'Zelle',                          currency: 'USD', percibe: 'clinica_si_spe' },
  { code: 'crypto_usdt',         label: 'USDT / cripto',                  currency: 'USD', percibe: 'clinica_si_spe' },
  { code: 'international_wire',  label: 'Transferencia del exterior',     currency: 'USD', percibe: null             },
  { code: 'other',               label: 'Otro medio',                     currency: 'VES', percibe: null             },
] as const;
```

`percibe: null` = **lo decide el contador**; el valor efectivo vive en `igtf_rules` con vigencia y la
pantalla avisa cuando un medio no está configurado. Lo que **no** se hace es cobrar dos veces: si el banco
ya debitó el 3 % (tarjeta o transferencia en divisas, Art. 4.5), la clínica **no** lo suma al cobro.
**Configuración de esta clínica (cerrada el 2026-10-05):** `is_special_taxpayer = false` ⇒ **ningún medio
se percibe en caja**; los de divisas bancarizada quedan en `banco` solo para conciliar el extracto.

### 3.3 Categorías fiscales y alícuotas

```ts
export const TAX_CATEGORIES = ['exento', 'general'] as const;      // se elimina `reduced_8`
export const CATALOG_KINDS = ['servicio', 'bien'] as const;
export const RATE_SOURCES = ['bcv_oficial', 'manual', 'arrastre'] as const;
export const IMPUTATION_POLICIES = ['tasa_del_pago', 'tasa_de_la_factura'] as const;
export const NUMBERING_MODES = ['software', 'formas_libres', 'maquina_fiscal'] as const;
export const CURRENCIES = ['USD', 'VES'] as const;
export const IGTF_PERCEIVERS = ['clinica', 'banco', 'no_aplica'] as const;
```

* `tax_category`: `exento` (servicios odontológicos, **Art. 19.6 Ley de IVA**) y `general` (bienes).
  **Se elimina `reduced_8`**: el 8 % del Art. 27 es el **piso de la banda**, no una alícuota vigente; el
  Art. 63 fija la general en **16 %**.
* `tax_rates(code, basis_points, effective_from)`: 1600 = 16 %. Los ítems cobrados copian
  `tax_rate_basis_points`; una factura emitida no cambia porque cambie la ley.
* `igtf_rules(method, basis_points, perceived_by, effective_from)`: 300 = 3 % en los supuestos de divisas
  (Art. 24, tras el Decreto 4.972 que dejó el general en **0 %**), con `perceived_by` = `banco` para los
  bancarios y `clinica` para efectivo/Zelle **si la clínica es SPE**.
* **Gancho del Art. 62** (`foreign_currency_iva_basis_points`, 0 por defecto): la alícuota adicional del
  5 %–25 % para pagos en divisas **solo rige por Decreto**; su parágrafo primero la aplica **incluso a las
  operaciones exentas**. Si algún día aparece, es configuración —y la factura que se emita después nace
  con ella—, no un despliegue de emergencia.
* **`tax_category = exento` en la partida ⇒ alícuota 0 % y la letra `(E)`** en el papel: el desglose por
  alícuota y el **total exento** se imprimen siempre (Art. 13 num. 10).

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
| `billing:void` — anular facturas y emitir notas de crédito | ✅ | ✅ (**con motivo**) | — |

*(Decisión del 2026-10-05: la secretaría **también** anula, porque atiende sola el mostrador; queda
auditado con actor y motivo, y el odontólogo solo mira. Si algún día la odontóloga trabaja sola y cobra,
se le añade `billing:collect`: es una línea en `ROLE_PERMISSIONS`, como pasó con `scheduling:write` en el
ADR [0038](adr/0038-permisos-del-odontologo-en-el-flujo.md).)*

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
/* ── 1. Tasas BCV: histórico, de solo agregado (ADR 0046) ───────────────────── */
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
    /**
     * Contribuyente Especial (SPE): **lo notifica el SENIAT**, no se autodeclara.
     * Habilita la percepción del IGTF de divisas sin mediación bancaria (Art. 4.6).
     * Sin esta constancia, la interfaz marca el cobro como «pendiente de confirmar».
     */
    isSpecialTaxpayer: boolean('is_special_taxpayer').notNull().default(false),
    speNotifiedAt: date('spe_notified_at'),
    speReference: text('spe_reference'),                 // oficio / providencia de calificación
    /** Política de imputación de pagos en Bs (B6): la decide la clínica, no el redondeo. */
    imputationPolicy: text('imputation_policy').notNull().default('tasa_del_pago'),
    /** Días de arrastre tolerados antes de exigir confirmación al cobrar. */
    rateGraceDays: integer('rate_grace_days').notNull().default(5),
    /**
     * Alícuota ADICIONAL por pago en moneda extranjera (Ley de IVA Art. 27 ¶4 y
     * Art. 62, 5 %–25 %). Solo rige por Decreto del Ejecutivo y no hay evidencia
     * de que exista: queda como gancho, en 0, y no en el código (R4).
     */
    foreignCurrencyIvaBasisPoints: integer('foreign_currency_iva_basis_points').notNull().default(0),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    updatedByUserId: uuid('updated_by_user_id'),
  },
  (table) => [
    check('chk_billing_settings_single_row', sql`${table.id} = 1`),
    check('chk_billing_settings_imputation',
      sql`${table.imputationPolicy} in (${sqlLiteralList(IMPUTATION_POLICIES)})`),
    check('chk_billing_settings_extra_iva', sql`${table.foreignCurrencyIvaBasisPoints}
      between 0 and 10000`),
  ],
);

/* ── 3. Series y numeración (ADR 0047) ──────────────────────────────────────── */
export const invoiceSeries = pgTable('invoice_series', {
  id: uuid('id').primaryKey().defaultRandom(),
  series: text('series').notNull().unique(),          // 'A', 'T' (modo test)
  numberingMode: text('numbering_mode').notNull(),    // 'software' | 'formas_libres' | 'maquina_fiscal'
  prefix: text('prefix').notNull().default(''),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/** Lote de formas libres autorizadas: el número de control viene preimpreso (ADR 0047). */
export const fiscalForms = pgTable('fiscal_forms', {
  id: uuid('id').primaryKey().defaultRandom(),
  seriesId: uuid('series_id').notNull().references(() => invoiceSeries.id),
  /** Rango de números de control asignado por la imprenta: «desde el N° … hasta el N° …». */
  controlFrom: text('control_from').notNull(),
  controlTo: text('control_to').notNull(),
  nextControl: text('next_control').notNull(),
  /** Datos que la factura tiene que imprimir (Art. 13 nums. 15 y 16). */
  printerName: text('printer_name').notNull(),
  printerRif: text('printer_rif').notNull(),
  authorizationRef: text('authorization_ref').notNull(),   // providencia que autoriza la imprenta
  authorizationDate: date('authorization_date').notNull(),
  printDate: date('print_date').notNull(),
  receivedAt: timestamp('received_at', { withTimezone: true }),
  /** Formas estropeadas o dadas de baja: se CONSERVAN (Art. 36) y no se destruyen sin autorización (Art. 40). */
  spoiledCount: integer('spoiled_count').notNull().default(0),
  exhaustedAt: timestamp('exhausted_at', { withTimezone: true }),
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

    // Instantánea del paciente (ADR 0048): el papel no cambia si la ficha cambia.
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

    // PDF archivado (ADR 0048).
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

    /** IGTF percibido: alícuota copiada, quién lo entera y montos en las dos monedas. */
    appliesIgtf: boolean('applies_igtf').notNull().default(false),
    igtfBasisPoints: integer('igtf_basis_points').notNull().default(0),
    /** `clinica` = lo percibe y lo entera la clínica; `banco` = ya lo debitó el banco. */
    igtfPerceivedBy: text('igtf_perceived_by'),
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
      (${table.appliesIgtf} = false and ${table.igtfAmountCentsUsd} = 0 and ${table.igtfPerceivedBy} is null)
      or (${table.appliesIgtf} = true and ${table.igtfAmountCentsUsd} >= 0
          and ${table.igtfPerceivedBy} in (${sqlLiteralList(IGTF_PERCEIVERS)}))`),
    check('chk_payments_void_reason', sql`${table.voidedAt} is null or ${table.voidReason} is not null`),
  ],
);

/* ── 9. Notas de crédito: OBLIGATORIAS cuando la operación queda sin efecto (Art. 22) ── */
export const creditNotes = pgTable(
  'credit_notes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    creditNoteNumber: integer('credit_note_number').notNull(),   // NC-000001
    invoiceId: uuid('invoice_id').notNull().references(() => invoices.id, { onDelete: 'restrict' }),
    /**
     * Referencia obligatoria a la factura que soportó la operación (Art. 23):
     * fecha, número y monto, copiados (la factura puede anularse después).
     */
    invoiceNumber: integer('invoice_number').notNull(),
    invoiceIssuedAt: timestamp('invoice_issued_at', { withTimezone: true }).notNull(),
    invoiceTotalCentsUsd: integer('invoice_total_cents_usd').notNull(),
    /** `total` = anula la factura entera; `parcial` = ajuste de partidas (Art. 22: ambas son obligatorias). */
    kind: text('kind').notNull().default('total'),
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
    check('chk_credit_notes_kind', sql`${table.kind} in ('total', 'parcial')`),
    check('chk_credit_notes_reference', sql`${table.invoiceNumber} > 0 and ${table.invoiceTotalCentsUsd} > 0`),
  ],
);

/** Partidas de una nota de crédito parcial: qué se ajusta y por cuánto. */
export const creditNoteItems = pgTable('credit_note_items', {
  id: uuid('id').primaryKey().defaultRandom(),
  creditNoteId: uuid('credit_note_id').notNull().references(() => creditNotes.id, { onDelete: 'cascade' }),
  invoiceItemId: uuid('invoice_item_id').references(() => invoiceItems.id, { onDelete: 'set null' }),
  description: text('description').notNull(),
  totalCentsUsd: integer('total_cents_usd').notNull(),
});

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
        │                                   │ 7. Cobra: medio, entregado y    │
        │                                   │    tasa del pago (IGTF: no)     │
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

1. Se toma el **correlativo interno** de la secuencia (`nextval`, atómico) **antes** de renderizar; dos
   emisiones simultáneas nunca comparten número (la segunda recibe **409** porque el `update` solo avanza
   desde `borrador`, patrón exacto de `issuePrescription`). El **número de control** se toma del lote de
   formas libres que esté activo y se guarda en la misma fila: son **dos números**, y el papel lleva los
   dos.
2. Se calculan los totales en VES con la **tasa del día de emisión** (Art. 25) y se congelan.
3. Se genera el PDF **fuera** de la transacción (Chromium tarda) y se archiva con su `sha256`; si la
   transacción falla, el archivo se borra. La plantilla está **calibrada sobre la forma física**: el texto
   cae en las áreas en blanco y no pisa el membrete ni el control de la imprenta.
4. Si falla el render: en `formas_libres` (el modo de esta clínica) la forma se registra como **anulada
   por daño** ocupando su control y **se conserva** (ADR 0047); en modo `software` el hueco se acepta
   (ADR 0036).
5. Publica `billing.invoice.issued` con la carga de auditoría y el bloque `invoice`.
6. Al dar de alta un lote, la pantalla pide **rango desde/hasta, imprenta, RIF, providencia y fecha**, y
   avisa cuando quedan pocas formas: **quedarse sin formas es quedarse sin poder facturar**.

### 5.3 Cobro

```text
entregado (Bs)  ──►  usdCents imputados = round(entregado × 1e6 / tasa_del_pago)
                     IGTF: 0 en esta clínica (no es SPE y no percibe).
                     Si algún día la notificaran como SPE:
                        · percibe el BANCO (tarjeta/transferencia en divisas) → se registra, no se suma
                        · percibe la CLÍNICA (efectivo USD, Zelle, USDT)
                             = round(usdCents × puntos_básicos / 10 000)
                     efectivo que se lleva la caja = imputado + IGTF que perciba la clínica
```

* **Esta instalación no cobra IGTF** (contribuyente ordinario, no SPE, decisión del 2026-10-05). La
  pantalla lo deja explícito en vez de esconderlo: al abrir el cobro muestra «Clínica no calificada como
  Sujeto Pasivo Especial (IGTF no percibido)» y **no permite** añadir la línea a mano —un `if` en la
  interfaz no, un dato de configuración sí—.
* **Nunca se cobra en pagos bancarizados en divisas**: ahí el agente de percepción es el **banco**
  (Art. 4.5), así que sumarlo sería cobrar dos veces. Esos medios quedan marcados para **conciliar el
  extracto**, no para cobrar.
* El IGTF, cuando aplique en el futuro, **no reduce la deuda**: el paciente abona su saldo y paga el
  tributo aparte. Va en el **recibo**, con su línea y **quién lo entera**, y es dinero de terceros con
  **período diario** (Art. 15) y no deducible de ISLR (Art. 18).
* **Se guardan siempre los tres hechos** (`tendered_amount`, `exchange_rate_micros` y
  `fx_difference_cents_usd`), así que el diferencial cambiario se puede recalcular y reportar sin volver a
  tomar la decisión; y si el contador algún día pide `tasa_de_la_factura`, es un `update` de una fila en
  `billing_settings`.
* El **saldo se recalcula en la misma transacción** desde los pagos vigentes (no anulados) y se guarda en
  `balance_cents_usd` con el `CHECK` de coherencia. Una prueba de integración recalcula el saldo desde
  cero y lo compara con el guardado: si alguien introduce un camino que no lo actualiza, se ve.
* **Un pago no se borra**: se anula con motivo (`billing:void`), se conserva su PDF y el saldo vuelve.
* **Alcance explícito de la v1**: un cobro se imputa a **una** factura emitida (con abonos parciales,
  que es como se cobran las cuotas de un tratamiento). El **anticipo** antes de emitir queda fuera (§11).

### 5.4 Anulación y nota de crédito

Una factura emitida **no se borra ni se edita**: se anula con una **nota de crédito**, que la ley hace
**obligatoria** cuando la operación queda sin efecto —total **o parcialmente**— o genera un ajuste
(Providencia 0071, **Art. 22**). La nota:

* tiene **numeración propia** (`NC-000001`, consecutiva y única) y su PDF archivado;
* **referencia la factura original** con **fecha, número y monto**, copiados en la propia fila
  (Art. 23): la factura puede anularse después y la referencia tiene que seguir siendo legible;
* lleva el motivo, el actor y su evento (`billing.credit_note.issued`);
* **total** (anula la factura, que pasa a `anulada`) o **parcial** (ajusta partidas concretas, con sus
  líneas): el modelo soporta las dos desde el principio porque la ley no distingue, aunque **la interfaz
  de la v1 solo ofrezca la total**, que es el caso real de la clínica.

`admin` **y secretaría** (`billing:void`), siempre con motivo. El original y la copia de la factura anulada
**se conservan** (Art. 36): nada se destruye.

### 5.5 Tasas BCV

* **Captura**: `bcv-fetcher` intenta una vez al día después de la publicación (el BCV publica **solo en
  días hábiles** y **no tiene API oficial**: es una página web con formato humano, así que el
  analizador normaliza el formato venezolano y guarda la respuesta cruda); si falla, no pasa nada: la
  secretaría ingresa la tasa a mano al abrir (`billing:rates`), con auditoría. **La caja nunca llama a
  internet.**
* **Vigente para una fecha**: la última fila no superada con `rate_date <= fecha`. Fines de semana y
  feriados **arrastran** la última publicada; si el hueco supera `rateGraceDays`, la pantalla avisa y
  **exige confirmar** para cobrar (M8).
* **Corrección**: una fila nueva con `supersedes_id` y motivo. La anterior queda como historia; los
  documentos ya emitidos no se tocan.
* **Zona horaria**: `America/Caracas` tanto para `rate_date` como para «el día» de la caja y el hecho
  imponible (Art. 25 de la Ley de IVA).

### 5.6 Catálogo y precios

* Los códigos de **servicio** son los 28 de `SESSION_PROCEDURES` (`consulta_evaluacion`,
  `obturacion_resina`…): así el borrador se arma solo desde la sesión y los reportes cruzan por código.
* Los **bienes** (cepillos, geles, blanqueadores) llevan códigos propios y `tax_category = general`
  (**decisión cerrada del 2026-10-05: sí se facturan**). La migración siembra unos pocos de ejemplo —con
  sus precios genéricos— para que el camino del 16 % no quede sin probar en producción, y la factura
  puede salir **mixta**: partidas `(E)` exentas y partidas `(G)` gravadas, con las bases desglosadas.
* Cambiar un precio **no** reescribe nada: las partidas emitidas son instantáneas y el cambio queda
  auditado con su valor anterior y nuevo. *(Si más adelante llegan los presupuestos, ahí sí hará falta un
  histórico de precios con vigencia; hoy sería una tabla que nadie consulta.)*

---

## 6. Documento fiscal impreso

**Dos documentos, dos series** (M6), sobre **formas libres** de imprenta autorizada (ADR 0047, cerrado):

| Documento | Serie | Qué lleva | Cuándo se imprime |
| :--- | :--- | :--- | :--- |
| **Factura** | correlativo propio (`A-000123`) **+ el número de control de la forma** | Partidas con `(E)`/`(G)`, bases por alícuota, total exento, IVA, totales en Bs y USD, tasa aplicada, leyenda de doble tasa, datos de la imprenta y rango asignado | Al emitir, **sobre la forma preimpresa** |
| **Recibo de cobro** | `REC-000001` | Medio de pago, monto entregado, tasa del pago, **IGTF percibido y quién lo entera** (hoy: «no percibido»), saldo después del abono | En cada cobro |
| **Nota de crédito** | `NC-000001` | Motivo, referencia (fecha, número y monto de la factura), monto y tasa | Al anular |

**Datos obligatorios de la factura** (Providencia SNAT/2011/0071, Art. 13; el módulo los imprime todos o
el documento no vale):

1. La denominación «**Factura**».
2. **Numeración consecutiva y única** (nuestra secuencia).
3. **Número de control preimpreso** (el de la forma) y 4. el **rango asignado** «desde el N°… hasta el N°…».
5. Nombre o razón social, **domicilio fiscal** y **RIF** del emisor.
6. **Fecha de emisión en 8 dígitos** (`DDMMAAAA`) y 7. nombre y **RIF** (o cédula/pasaporte) del cliente.
8. Descripción, cantidad y monto, con la letra **`(E)`** en lo exento.
10. **Base gravada desglosada por alícuota con su porcentaje y el total exento aparte**.
11. **IVA desglosado por alícuota** y 12. **total general**.
13. «**Sin derecho a crédito fiscal**» **en las copias**.
14. **Si la contraprestación se expresó en moneda extranjera: las dos cantidades y el tipo de cambio
    aplicable** (por eso la factura lleva la tasa congelada).
15/16. Razón social y RIF de la **imprenta** autorizada, la providencia que la autoriza y la fecha de
    elaboración de la forma.

**Encabezado legal** (los datos salen del **perfil del consultorio resuelto por entorno**, §2.4, no de una
tabla duplicada —B12— ni de una constante de código): razón social y nombre comercial, **RIF**, dirección
fiscal, teléfonos, logo, y la condición `Contribuyente Especial` **solo si algún día aplica**. Mientras el
perfil esté incompleto, la factura sale con el aviso de datos faltantes en vez de un membrete inventado.

**Leyendas** (con la corrección R3):

* La letra **`(E)`** junto a la partida exenta y **`(G)`** junto a la gravada (Art. 13 num. 8).
* **En la copia**, «**Sin derecho a crédito fiscal**» (Art. 13 num. 13) y la mención de la exención:
  «Servicios exentos de IVA — Art. 19, numeral 6 de la Ley de IVA».
* **Leyenda de doble tasa** (texto fijado por el contador, va en la factura tal cual):
  > «Montos en VES calculados a la tasa oficial BCV de la fecha de emisión (Art. 25 Ley IVA, Prov. 0071
  > Art. 13 num. 14). Si el pago se efectúa en fecha posterior, la obligación en bolívares se liquidará a
  > la tasa oficial BCV vigente a la fecha del pago (Convenio Cambiario N.º 1, Art. 8.a)».
* Y el dato concreto: `Tasa oficial BCV aplicada: 36,5420 Bs./USD del DD/MM/AAAA`, más la **tasa del
  pago** en el recibo.
* Bloque **IGTF** separado: hoy imprime «**IGTF: no percibido por la clínica**» (contribuyente ordinario,
  no SPE); si algún día se enciende, va con su alícuota y quién lo entera, y siempre con la aclaratoria de
  que **no forma parte del monto de la factura**.

**Restricciones de forma que condicionan la plantilla** (no son cosmética):

* **Un documento = una página, mínimo 8 cm** (Art. 33). Si las partidas no caben, se emiten **varios
  documentos, cada uno con su número** —y con formas libres, cada uno consume **una forma**—.
* Fechas en **`DDMMAAAA`** (Art. 34) y **sin enmiendas ni tachaduras** (Art. 41): el PDF archivado es la
  única versión.
* Las copias llevan su leyenda y **originales y copias de lo anulado se conservan** (Art. 36).
* **Contingencia** (Art. 10): si el sistema está caído se emite en formatos autorizados con el número
  precedido de «serie»; el procedimiento queda escrito en la pantalla de caja.
* **La plantilla no dibuja lo que ya viene impreso**: el membrete, el RIF del emisor y los datos de la
  imprenta **están en la forma**; el sistema solo imprime el contenido variable (número, control, fecha,
  cliente, partidas, totales y leyendas) en las áreas en blanco. Se calibra con una **forma de muestra**
  y se comprueba imprimiendo de verdad antes de cerrar la fase.

**Archivado e impresión** (M1): el PDF se compone una vez con Chromium (`@page { size: A4 }`, como los
reportes) y se guarda en `storage/billing` con su `sha256`; toda descarga o impresión incrementa
`print_count`, actualiza `last_printed_at` y deja evento. Lo que se reimprime es **el mismo archivo**.
*(Con formas libres, la plantilla además tiene que **calzar sobre la forma preimpresa**: márgenes
medidos, nada que se solape con el número de control ni con los datos de la imprenta.)*

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

    **Y los DOS del instalador nuevo** (`infra/fedora/instalar/`, ADR 0043 — este plan se escribió
    antes de que existiera, así que no los tenía):

    - `infra/fedora/instalar/comun.sh` → la lista `SERVICIOS`, de la que leen las cuatro piezas
      (preparar no, pero sí desplegar, aprovisionar y verificar).
    - `infra/fedora/instalar/aprovisionar.mjs` → el array `SERVICIOS` con `puerto` y `base`, del que
      salen el rol, la base y la credencial de `/etc/odontocrm`.

    Si falta el segundo, el aprovisionamiento **no crea la base ni el rol de `billing`**, y el fallo
    aparece más tarde como un `password authentication failed` a mitad del despliegue —justo el
    síntoma que el rediseño vino a eliminar, y el que costó cinco rondas—. Si falta el primero, la
    pieza 4 verifica 8 servicios y **da el conjunto por bueno sin mirar el noveno**.
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

21. `docs/adr/0044…0048` + la tabla del índice `docs/adr/README.md`. Hay que **anotar el ADR 0004**
    («Nueve microservicios») y actualizar la lista de bases del ADR 0002. Y cuadrar la cuenta de ADRs:
    el plan maestro (fila de la Fase 10) y el `README.md` dicen **45** y en `docs/adr/` hay **43** —al
    cerrar la Fase 10 había **42**, que es lo que debe decir esa fila, porque el 0043 llegó después—.
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
de puertos) y `infra/windows/ecosystem.config.cjs`. **No hay CI** (`.github/` no existe): la única puerta
automática es `npm run verify` —`check-secrets`, `fedora:check`, `lint`, `format:check`, `typecheck`,
`build` y `test`—, que **no** ejecuta el auditor de conexiones: hay que correr `npm run audit` a mano
(corrección del 2026-10-06; el auditor salió en verde ese día tras arreglar un falso positivo con
`/api/v1/meta`, que la puerta sirve por sí misma y el auditor no veía).

### 7.9 Tarea 0 — el perfil del consultorio por entorno

Es un cambio **compartido** (§2.4) y tiene su propia lista, porque no lo cubre ninguna guardia del
servicio de facturación:

1. `packages/contracts/src/clinic.ts`: tipo, genéricos `CAMBIAR_*` y los ayudantes con el perfil como
   parámetro (ya lo aceptan).
2. `packages/kernel`: `clinicEnvSchema` + `resolveClinicProfile(env)` y su prueba.
3. Los **seis** consumidores que imprimen o firman: `clinical` (récipe A5), `reporting` (PDF A4),
   `billing` (factura y recibo), `screens`, `scheduling` y `notifications` (membrete de plantillas).
4. `SystemMeta` (contratos) y `apps/gateway/src/meta.ts`: bloque `clinic` en el `GET /api/v1/meta` público
   (es lo que lee el navegador, que no puede leer `.env`).
5. La web: el hook del meta, `VerifyPrescriptionPage` y el aviso de membrete incompleto.
6. `.env.example` de la raíz (bloque `CLINIC_*`) y `infra/fedora/install.sh` → `/etc/odontocrm/odontocrm.env`
   (el archivo **común**).
7. `tools/plantillas-fedora.mjs` y `tools/audit-conexiones.mjs`: las variables nuevas tienen que estar en
   las plantillas y en el `.env.example`, o `npm run verify` se pone rojo.
8. `infra/fedora/INSTALL.md` §8.0, que hoy enseña a editar el archivo de código.

---

## 8. Pantalla `/caja`

Una sola pantalla, pensada para el mostrador (y para la tableta, como `/flujo`):

* **Pendientes de caja** — la cola del día: pacientes con sesión cerrada y borrador sin emitir, con el
  total y el aviso de partidas sin precio.
* **Borrador** — revisar, corregir cantidades, añadir un bien (cepillo, gel), quitar una línea.
* **Emitir** — un botón, con la tasa que se va a congelar y el **número de control que se va a consumir**
  a la vista; después, documento archivado.
* **Cobrar** — medio de pago, monto entregado, **tasa del día aplicada** y saldo resultante antes de
  confirmar; botón para imprimir factura y recibo. El IGTF aparece como **«no percibido»** con la etiqueta
  «Clínica no calificada como Sujeto Pasivo Especial (IGTF no percibido)» y **sin campo editable** (con la
  bandera encendida el día que corresponda, el 3 % se calcula solo).
* **Tasa del día** — el widget de la jornada: valor vigente, origen (`BCV` / manual / arrastre), botón
  para fijarla o corregirla (con motivo), y el aviso cuando el hueco de días supera el umbral.
* **Formas libres** — el lote activo: control siguiente, cuántas quedan y aviso cuando el rango se está
  agotando (con el alta del lote a mano: rango, imprenta, RIF, providencia y fecha).
* **Historial** — facturas del día/semana con estado, saldo, reimpresión (contada y auditada), anulación
  (`admin` o secretaría, con motivo) y descarga del PDF archivado.
* **Libros** — libro de ventas (con la base **desglosada por alícuota y el total exento aparte**, que es
  lo que pide el Art. 13 num. 10) en CSV, y el de IGTF cuando algún día haya algo que declarar. **No** se
  genera libro de compras (decisión cerrada: lo lleva el contador). Si más adelante hay ventas en línea,
  el libro tiene que poder **separarlas** de las presenciales (Providencia SNAT/2024/000102, Art. 6).
* **Catálogo y configuración** — aranceles con su categoría fiscal, y los interruptores de la clínica
  (SPE, política de imputación, alícuota adicional, modo de numeración): solo `admin`.
* **Modo test** — el banner de ADR 0020 ya existe; la caja muestra además que la numeración es la de
  prueba (`T-900001`).

---

## 9. Pruebas y criterios de aceptación

**Unitarias** (contrato, sin base):

1. Aritmética: `vesCentimosFromUsd` y `usdCentsFromVes` son inversas dentro del céntimo; el redondeo es
   half-up y se aplica una sola vez; los productos grandes no pierden precisión (casos de 10⁹ y 10¹²).
2. `igtfCents`: 3 % de 100,00 USD = 3,00 USD; 0 cuando no aplica; **0 para los medios cuyo IGTF ya debitó
   el banco** (no se suma dos veces) y **0 en la configuración de esta clínica, que no es SPE**; con
   `is_special_taxpayer = true` (caso de prueba, para que el camino no quede muerto) vuelve a calcular el
   3 %.
3. La alícuota **adicional del Art. 62 está en 0** por defecto y, si se configura, se aplica **también a
   las líneas exentas** (parágrafo primero) y se copia en el documento.
4. Las transiciones de `INVOICE_TRANSITIONS` cubren todos los estados y ninguna deja un estado sin salida.

**Integración** (base temporal propia, como `reporting`):

5. `clinical.session.closed` **dos veces** (mismo `eventId`) ⇒ **una** factura y las mismas partidas.
6. Dos sesiones cerradas del mismo paciente ⇒ dos borradores, y `emitir` de ambos asigna **números
   distintos**; dos emisiones simultáneas de la misma factura ⇒ una 409 y un solo número.
7. Emitir congela la tasa: cambiar la tasa del día después **no** altera la factura emitida.
8. Cobro normal (la configuración real): **IGTF 0 en todos los medios**, el recibo dice «no percibido» y
   **el saldo baja exactamente lo imputado**. Con la bandera `is_special_taxpayer` encendida en la prueba,
   `cash_usd` calcula el 3 % en el recibo sin tocar el saldo, `card_usd` sigue en 0 (lo debita el banco) y
   **la API rechaza** un cobro con IGTF si la clínica no está calificada.
9. Abono parcial ⇒ `parcial` y saldo correcto; el que completa ⇒ `pagada` con saldo 0; anular un pago ⇒
   el saldo vuelve y el estado retrocede.
10. La suma de las partidas cuadra con los totales y los `CHECK` rechazan una fila incoherente (se prueba
    el rechazo, no solo el camino feliz).
11. Una factura emitida **no se puede** `update` ni `delete`: la API responde 409 y la base lo impide.
12. Anular exige nota de crédito con número propio, motivo y la **referencia copiada** (fecha, número y
    monto de la factura); sin motivo, 400. La nota de crédito **parcial** cuadra con sus líneas.
13. Sin tasa para la fecha ⇒ arrastre con aviso; con hueco mayor al umbral ⇒ 409 hasta confirmar.
14. **Factura mixta** (servicios exentos + un bien): el total cuadra, el IVA sale solo de la partida
    gravada, la base exenta y la gravada van desglosadas y el libro de ventas las separa. Es la prueba que
    mantiene vivo el camino del 16 %.
15. Formas libres: el rango se consume **en orden**, una forma dañada queda registrada y
    conservada, y el lote avisa cuando queda poco. Una factura que no cabe en una página se parte en
    **varios documentos con su número propio**.

**Humo y e2e**:

16. `npm run smoke:billing` (modelo `smoke:prescription`): tasa del día → borrador → emitir → cobrar con
    la tasa del pago → factura pagada → reimpresión contada → anular con nota de crédito. Con el IGTF
    apagado (la configuración real) y con la bandera encendida, para que el camino no quede muerto.
17. `npm run e2e:caja` (si el flujo lo pide): cerrar una sesión en `/flujo`, cobrar en `/caja` e imprimir
    el PDF, con las comprobaciones de siempre (URL vigilada, PDF descargado y abrible).
18. `seed:test` siembra tasas, catálogo (servicios y bienes), facturas y pagos en la numeración de prueba,
    y `seed:verify` cuadra sus huellas.

**Criterios de aceptación de la fase** (al estilo del plan maestro): `npm run verify` en verde; la
migración desde cero crea todas las tablas; cerrar una sesión no tarda más que antes (la factura es
asíncrona); un cobro completo en caja se resuelve en **menos de 30 segundos** con la impresión incluida;
`npm run estado` muestra el décimo servicio y su base; y el respaldo incluye `odonto_billing`.

---

## 10. Decisiones: cerradas y residuales

**Cerradas el 2026-10-05** — con el contador (hoja de confirmación en el Anexo A) y después con Gabriel.
El detalle y el efecto de cada una están en §0.1:

| Decisión | Resultado | Dónde vive |
| :--- | :--- | :--- |
| Régimen fiscal | Contribuyente **ordinario**, **no** SPE | `billing_settings.is_special_taxpayer = false` |
| Formato de facturación | **Formas libres** de imprenta autorizada | `invoice_series.numbering_mode = 'formas_libres'` + alta del lote |
| Pago en Bs de tratamientos cotizados en USD | **Tasa BCV del día exacto del pago** | `billing_settings.imputation_policy = 'tasa_del_pago'` |
| IGTF en caja | **No se percibe** (y nunca en pagos bancarizados) | `igtf_rules` sin percepción de la clínica; la UI bloquea añadirlo |
| Art. 62 (5 %–25 % por divisas) | Sin Decreto que lo active | `foreign_currency_iva_basis_points = 0` |
| Anulación | **Nota de crédito** numerada que referencia la factura | `credit_notes` + `NC-000001` |
| Quién anula | **admin y secretaría**, con motivo | `billing:void` en `ROLE_PERMISSIONS` |
| IVA de compras | **No deducible** (Art. 33) y **sin libro de compras** | Nada que construir (§11) |
| RIF del paciente | **Opcional** (consumidor final salvo que lo pidan) | `patient_tax_id` nullable |
| Anticipos | **Primero la factura, después el cobro** | Fuera de alcance con camino documentado (§11) |
| Bienes al 16 % | **Sí se facturan**, con catálogo de ejemplo | `treatment_catalog.kind = 'bien'` + `tax_category = 'general'` |
| Emisión a crédito | **No**: emitir y cobrar son el mismo acto | Flujo de `/caja`; el pago parcial sigue permitido |
| Prótesis e implantes | Dentro del **servicio exento** | `tax_category = 'exento'` en el catálogo |
| Cambio en `clinical.session.closed` | **Aprobado** (`procedures[]` aditivo) | Commit de contrato + `CHANGELOG` |
| Tasa BCV | Captura **automática** con respaldo manual | Worker diario + ingreso manual auditado |
| Nombre de la interfaz | **«Caja» en `/caja`** | `MODULES` de `lib/nav.ts` |
| Datos del consultorio | **Por entorno** con genéricos `CAMBIAR_*` | Bloque `CLINIC_*` (§2.4) |

**Residuales** (ninguno bloquea programar; los dos primeros hay que resolverlos antes de **facturar**):

1. **El lote de formas libres**: rango de números de control **desde/hasta**, razón social y RIF de la
   imprenta, número y fecha de la providencia que la autoriza, y fecha de elaboración. Y **una forma de
   muestra** para **calibrar la plantilla** antes de imprimir de verdad. Mientras no haya formas, en
   producción solo se puede emitir el comprobante interno.
2. **Los datos reales del consultorio**: los valores que sustituyen a los genéricos `CAMBIAR_*`
   (razón social, RIF, dirección fiscal, teléfonos, logo y el odontólogo que firma). El sistema arranca y
   avisa; no se cae.
3. **Prótesis o ítems que se quieran como venta de bien**: hoy van exentos; si alguno se quiere gravado, se
   marca en el catálogo con `tax_category = 'general'`. Decisión por ítem, no de arquitectura.
4. **Vigilancia**: si el SENIAT notifica a la clínica como **SPE**, se enciende el interruptor del IGTF; si
   aparece un **Decreto del Art. 62**, se pone la alícuota adicional en configuración. Ninguna de las dos
   exige tocar código.

### Fuentes de esta revisión (verificadas el 2026-10-05)

* Ley de IVA (texto refundido, **Gaceta Oficial N.º 6.507 Ext., 29-ene-2020**): **Art. 19 num. 6**
  (exención de servicios médico-asistenciales y odontológicos), **Art. 18 num. 4** (ventas, prótesis),
  **Art. 25** (tipo de cambio del día del hecho imponible), **Art. 27 y 63** (banda y 16 %), **Art. 62**
  (alícuota adicional por divisas), **Art. 33** (sin derecho a deducción), **Art. 69**.
* Ley de IGTF (**Gaceta Oficial N.º 6.687 Ext., 25-feb-2022**): **Art. 3** (hechos imponibles),
  **Art. 4 nums. 5 y 6** (quién es contribuyente), **Art. 15** (período diario), **Art. 18** (no
  deducible), **Art. 24** (3 % divisas / 2 % general). **Decreto 4.972 (Gaceta 6.821 Ext., jul-2024)**:
  general al 0 %.
* Providencia **SNAT/2011/0071** (Gaceta 39.795, 8-nov-2011): **Art. 6** (solo formatos, formas libres o
  máquina fiscal), **Arts. 7 y 31** (datos y rango preimpresos), **Art. 8** (quién está obligado a
  máquina fiscal), **Art. 13** (datos obligatorios, `(E)`, total exento, tipo de cambio),
  **Arts. 22–24** (notas de crédito y débito obligatorias, con referencia a la factura),
  **Art. 33** (una página, 8 cm), **Art. 34** (DDMMAAAA), **Art. 36** (conservar lo anulado),
  **Art. 40** (destrucción solo con autorización), **Art. 41** (sin enmiendas).
* Providencia **SNAT/2024/000102** (Gaceta 43.032, 19-dic-2024): régimen de facturación digital, **opt-in**
  (Art. 3) y obligatorio solo para venta exclusivamente electrónica (Art. 4). La providencia
  **SNAT/2024/000121** (registro de proveedores de sistemas) fue **derogada** por la
  **SNAT/2026/00084** (Gaceta 43.435, 12-ago-2026).
* **Convenio Cambiario N.º 1** (Gaceta 6.405 Ext., 7-sep-2018), **Art. 8.a** (moneda de cuenta y pago en
  Bs a la tasa de la fecha del pago) y **Art. 9** (tipo de cambio de referencia del BCV).
* **BCV**: `bcv.org.ve` publica el «Tipo de Cambio de Referencia SMC» **solo en días hábiles** y **sin API
  oficial**; cualquier «API del BCV» de terceros es un raspado de esa página.

> ⚠️ **Confianza de las fuentes**: la exención del Art. 19.6, la letra `(E)`, el 16 %, el 3 % de IGTF por
> divisas y la obligatoriedad de las notas de crédito están **verificados con alta confianza**. Quedan en
> **media** (porque las fuentes primarias eran PDF que no se pudieron leer de forma directa): el **0 %**
> general del Decreto 4.972, los **criterios de calificación de SPE** y la práctica de percepción del
> IGTF sin mediación bancaria. Y hay **dos premisas de la v1 que resultaron falsas** y quedan corregidas:
> el artículo de la exención (no es el 18.4) y la idea de que un PDF en hoja blanca es una factura.

---

## 11. Fuera de alcance (con la puerta abierta)

* **Presupuestos y planes de tratamiento** como documentos: el plan clínico ya guarda un `presupuesto`
  por partida (`clinical.ts`) y el odontograma distingue fases (implante quirúrgico / carga de corona).
  Cuando lleguen, la factura se genera **desde el presupuesto aceptado**, y ahí hará falta el histórico
  de precios con vigencia. Hoy: no.
* **Anticipos** (dinero antes de que exista la factura): **decisión cerrada del 2026-10-05 — siempre se
  emite la factura primero** y el cobro se imputa a una factura emitida (con abonos parciales, que es como
  se cobran las cuotas). El camino de ampliación queda documentado por si algún día hace falta: una tabla
  de aplicaciones (recibo ↔ factura), que el modelo ya insinúa (`invoice_sessions` separa documentos de
  hechos).
* **Unificar varios borradores en una sola factura** (la «cuenta del tratamiento» que se cobra al final):
  la tabla de enlace N:M ya lo permite; la v1 emite una factura por sesión, que es el flujo del
  mostrador.
* **Notas de débito** (la de crédito **sí** entra: es obligatoria para anular o ajustar) y la interfaz de
  la nota de crédito **parcial** (el modelo la soporta; la v1 solo anula la factura completa).
* **Inventario y stock** de los bienes que se venden: se cobran, no se controlan existencias. Tampoco se
  construye un **libro de crédito fiscal de compras**: como la clínica factura sobre todo exento, el IVA
  de sus compras **no se deduce** (Ley de IVA Art. 33) y es costo, no crédito (R7).
* **Seguros, convenios y cuentas por cobrar con mora.**
* **Facturación digital / electrónica** (SENIAT): se modela el modo de numeración para que quepa, pero no
  se implementa mientras sea **opt-in** para una clínica que atiende en persona (Providencia
  SNAT/2024/000102, Arts. 3–5). Si algún día se vende **solo** en línea, deja de ser opcional.
* **Multi-sucursal y multi-moneda distinta del par USD/VES.**

---

## 12. Ejecución por sesiones

**Tarea 0 — el perfil del consultorio por entorno** (compartida, va antes o en paralelo a la Sesión A):
bloque `CLINIC_*` con genéricos `CAMBIAR_*` (§2.4), `clinicEnvSchema` + `resolveClinicProfile` en
`packages/kernel`, los seis servicios que imprimen pasando el perfil resuelto, el bloque público en
`GET /api/v1/meta`, `.env.example`, el archivo común de Fedora y los guardianes de plantillas. **Va en su
propio commit** (toca `clinical`, `reporting` y la web) y su aceptación es: **el récipe, el reporte y la
factura salen con los datos del `.env`** y con el aviso de faltantes cuando el perfil está incompleto.
*(Se adelanta aquí porque la factura no puede imprimir un RIF que hoy vive en un archivo de código.)*

**Sesión A — cimientos y borradores** (sin dinero todavía): ADRs 0044–0048 escritos y enlazados;
contrato `billing.ts` con aritmética y transiciones probadas; permisos, acciones de auditoría y tópicos;
`clinical.session.closed` con `procedures[]`; esqueleto del servicio, migración, `EVENT_CONSUMERS`,
bootstrap, gateway y `/caja` con la lista de pendientes y el borrador. **Aceptación**: cerrar una sesión
crea el borrador correcto (una sola vez) y se ve en `/caja`.

**Sesión B — el dinero**: tasas (historial, arrastre, corrección, widget), emisión con **los dos números**
(correlativo de la secuencia + control del lote de formas libres) y PDF archivado, cobros con la **tasa del
pago** y saldo, recibos, **factura mixta** (servicios exentos + bienes al 16 %), anulación de pagos, el
**IGTF dormido** (config en cero, camino probado con la bandera encendida), `smoke:billing`. **Aceptación**:
el criterio de los 30 segundos del §9, la factura cobrada en dos monedas y el PDF **impreso sobre una forma
libre real** sin pisar el membrete (o, si las formas aún no llegaron, la calibración queda como pendiente
declarado y la fase **no** se cierra).

**Sesión C — cierre**: notas de crédito (con la parcial soportada en el modelo), libro de ventas en CSV
con el desglose por alícuota, **alta del lote de formas libres** (rango, imprenta, providencia y aviso de
agotamiento), catálogo y configuración fiscal, seed determinista con la configuración cerrada,
`seed:verify`, pruebas de aceptación de la fase, despliegue en Fedora (`bootstrap --only billing`,
systemd, respaldos, `estado`) y documentación (plan maestro, README, COMANDOS, CHANGELOG).

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

> **Actualización (2026-10-06, al empezar a implementar):** el árbol estaba **limpio** en `d695a55`
> (rama `main`), `docs/adr/` tiene **43** entradas y **el 0043 es el del instalador** (§1): los cinco
> ADRs de este documento son **0044–0048**. El trabajo en curso de `infra/fedora/nginx` ya está
> commiteado, así que no hay nada que separar. El módulo de facturación sigue sin una línea de código.

**Qué hacer al llegar a Windows, en este orden:**

1. `git pull` y `npm ci`; comprobar `npm run verify` en verde **antes** de tocar nada. **Ya no hay
   bloqueos fiscales**: todas las decisiones están cerradas (§0.1) y el Anexo A queda como constancia.
2. **Tarea 0**: el perfil del consultorio por entorno (§2.4) — `CLINIC_*` con genéricos `CAMBIAR_*`,
   `resolveClinicProfile` en `packages/kernel`, el bloque público en `/api/v1/meta`, el `.env.example` y
   el archivo común de Fedora. Va en **su propio commit** porque toca `clinical`, `reporting` y la web.
3. Escribir los ADRs 0044–0048 en `docs/adr/` (+ índice, + anotar el 0004 y el 0002) y el contrato
   `billing.ts` con sus pruebas **antes** del servicio (regla del proyecto). *(El **0043 no está libre**:
   lo ocupa el ADR del instalador.)*
4. Crear el esqueleto de `services/billing` copiando el de `reporting` (consumidor + `processed_events`)
   y el de `clinical` (outbox que publica + documentos archivados). Añadir `billing` a los `workspaces`
   del `package.json`, al `tsconfig.json` raíz y a `infra/db/bootstrap.mjs`; `npm install` y
   `npm run build:node`.
5. `npm run db:bootstrap -- --only billing` para crear base, rol y `.env` (es idempotente).
6. `npm run db:generate:billing` → revisar la migración **a mano** (lección de la Fase 9: una migración
   escrita a mano puede quedar invisible para el migrador) → `npm run db:migrate` →
   `npm run db:verify-migrations -- --only billing`.
7. Sembrar la **configuración cerrada**: `is_special_taxpayer = false`, `imputation_policy =
   'tasa_del_pago'`, serie `A` en modo `formas_libres`, catálogo con los 28 servicios exentos y un par de
   bienes al 16 %. Es parte de la migración o del seed, no un paso manual olvidable.
8. Implementar en el orden de §12, con `npm run dev` y `npm run smoke:billing` en cada paso.
9. Antes de dar una sesión por cerrada: `npm run verify` (incluye `fedora:check` y el auditor de
   conexiones) y repasar el §7.8 (las guardias que **no** existen: respaldos de `restore`/`crear-rol`,
   `tools/lib/stack.mjs` y `infra/windows/ecosystem.config.cjs`).

**Advertencias para no romper la Fedora de pruebas:**

* **No** correr `npm run db:reset`, `seed:reset` ni `seed:test` en Fedora por probar el módulo: borran y
  reescriben las bases (y `db-reset` toca las nueve). Para validar aquí, `--only billing`.
* El `.env` real no está en el repositorio: en Windows hay que regenerar los secretos de desarrollo
  (`npm run keys:generate` si tocan las claves), el bootstrap del punto 5 para la base nueva y **el bloque
  `CLINIC_*`** con los datos reales del consultorio (o quedará el genérico `CAMBIAR_*` y la factura saldrá
  con el aviso de datos faltantes).
* Cambiar `packages/contracts` (permisos, acciones de auditoría, tópicos) **obliga a recompilar todos los
  servicios**: en Fedora eso es `sudo odontocrm recompilar` y reiniciar, no un `npm run dev`.
* El commit del evento `clinical.session.closed` es un **cambio de contrato**: va en su propio commit,
  con aviso en el `CHANGELOG`, y sin él el borrador sale sin partidas.
* **`billing` imprime PDF con Chromium**: en Fedora necesita el mismo `PLAYWRIGHT_BROWSERS_PATH` que
  `clinical` y `reporting` (`install.sh` ya lo hace para esos dos; hay que sumar el tercero).
* **La plantilla de la factura no se puede validar en pantalla**: hasta tener las **formas libres** y una
  impresora, la calibración del `@page` es una hipótesis. El código puede ir cerrado; la fase no.

**Pendientes del proyecto que NO son de este módulo** (no mezclarlos): los P-36…P-42 de la auditoría de
portabilidad, registrados en `infra/fedora/INSTALL.md` §20.2, y el trabajo en curso de `infra/fedora/nginx`.

**Lo que sigue pendiente del lado de la clínica** (no bloquea programar, sí bloquea facturar de verdad):
el **lote de formas libres** con su rango de control y una **forma de muestra** para calibrar la
plantilla, y los **datos reales del consultorio** que sustituyen a los genéricos `CAMBIAR_*` (§10,
residuales 1 y 2).

---

## Anexo A — Hoja de confirmación operativa devuelta por el contador (2026-10-05)

Se conserva **literal** como constancia de la decisión (es lo que respalda la configuración del sistema
ante una revisión posterior):

```text
ESTIMADO CONTADOR, PARA CONFIGURAR EL SISTEMA DE FACTURACIÓN DE LA CLÍNICA:

1. RÉGIMEN FISCAL:
   [ ] Sujeto Pasivo Especial (Contribuyente Especial) -> N° Notificación: _________
   [X] Contribuyente Ordinario (Persona Jurídica o Natural)

2. FORMATO DE FACTURACIÓN ACTUAL:
   [X] Formas Libres de imprenta autorizada: Nota extra: podemos implementar facturación en el soft:
       El SENIAT eliminó la obligación de utilizar y homologar sistemas informáticos de facturación
       mediante la Providencia Administrativa SNAT/2026/00084, publicada en la Gaceta Oficial
       N.º 43.435 el 12 de agosto de 2026.
   [ ] Máquina Fiscal (Marca/Modelo: ______________)
   [ ] Talonario manual de contingencia

3. PAGOS EN BOLÍVARES DE TRATAMIENTOS COTIZADOS EN DÓLARES:
   [X] Se cobra al cambio BCV del día exacto en que el paciente viene a pagar (Conv. Cambiario N° 1)
   [ ] Se congelan los bolívares que decía la factura emitida originalmente

4. IGTF EN DIVISAS:
   [ ] La clínica percibe el 3% en caja para pagos en efectivo USD / Zelle (Aplica si es Especial)
   [X] No percibimos IGTF en caja
```

**Traducción a configuración del sistema** (lo que el arranque del servicio tiene que dejar sembrado):
`is_special_taxpayer = false` · `imputation_policy = 'tasa_del_pago'` · `foreign_currency_iva_basis_points
= 0` · serie `A` con `numbering_mode = 'formas_libres'` · `igtf_rules` sin percepción de la clínica
(`banco` o `no_aplica` en todos los medios) · `patient_tax_id` opcional.

---

## Anexo B — Cierre de las decisiones que quedaban abiertas (2026-10-05)

Segunda ronda de confirmación, ya sin el contador delante. Se conserva como constancia porque **fija
alcance**: varias de estas respuestas recortan cosas que el plan tenía modeladas y otras activan caminos
que habrían quedado dormidos.

| # | Pregunta | Respuesta de Gabriel | Qué se hace |
| :-: | :--- | :--- | :--- |
| 1 | ¿Anticipos antes de emitir la factura? | **No: siempre se emite factura primero** | Queda fuera de la v1; el cobro se imputa a una factura emitida |
| 2 | ¿Se venden bienes gravados al 16 %? | **Sí, hay que poder facturarlos** | Catálogo con bienes de ejemplo y factura mixta `(E)`/`(G)` probada |
| 3 | ¿La factura puede quedar a crédito? | **No: emitir y cobrar son el mismo acto** | El flujo de `/caja` es emitir → cobrar; el saldo parcial sigue permitido |
| 4 | Prótesis e implantes | **Dentro del servicio exento** | Todas las partidas odontológicas nacen `exento` |
| 5 | Libro de compras | **Solo el de ventas** | No se registran facturas de proveedores |
| 6 | ¿Se toca `clinical.session.closed`? | **Sí, aditivo** con `procedures[]` | Commit de contrato + aviso en el `CHANGELOG` |
| 7 | Captura de la tasa BCV | **Automática con confirmación si falla** | Worker diario + ingreso manual auditado + arrastre confirmado |
| 8 | ¿Quién anula una factura? | **También la secretaría, con motivo** | `billing:void` para admin y secretaría; el odontólogo solo lectura |
| 9 | Nombre y ruta de la interfaz | **«Caja» en `/caja`** | `ModuleId` `caja` en `lib/nav.ts` |
| 10 | Datos del consultorio y del lote de formas | **Genéricos siguiendo el formato, en un `.env` con su `.env.example`** | Bloque `CLINIC_*` con `CAMBIAR_*` (§2.4); el lote de formas, operativo, va en la base |

**Configuración que deja sembrada el arranque** (además de la del Anexo A): catálogo con los 28 servicios
exentos + bienes de ejemplo al 16 % · libro de compras **no** implementado · `CLINIC_*` con genéricos
`CAMBIAR_*` en el `.env` común · `billing:void` extendido a la secretaría.
