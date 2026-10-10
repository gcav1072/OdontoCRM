# Decisiones de arquitectura (ADR) — OdontoCRM

Una ADR por decisión relevante, en el formato *Contexto · Decisión · Consecuencias*.
Las decisiones 0001–0021 provienen de la sesión de planificación del **2026-10-02**
(§1 de [`../PLAN_MAESTRO_FASES.md`](../PLAN_MAESTRO_FASES.md)); las 0022–0025 se
tomaron durante la Fase 0, la 0029 en la Fase 4.1, la 0030 en la Fase 5, las 0031–0033
en la Fase 6, las 0034–0036 en la Fase 7, la 0038 en la Fase 8, las 0039–0041 en la
Fase 9, la 0042 en la Fase 10, la 0043 en la sesión de despliegue y las **0044–0048** al
abrir la Fase 11 (facturación y pagos); la **0049** se toma dentro de esa misma fase, al decidir el modo
de facturación por defecto y la regla de tasa, y quedan documentadas por la misma razón. La
**0050** se toma al portar el instalador a Windows, la **0051** al cubrir la dentición mixta
del odontograma, la **0052** al permitir que el paciente confirme su cita (y que la «próxima
cita» de la sesión clínica se cree de verdad en la agenda) y la **0053** al permitir que el
paciente **cancela** su cita desde el bot. La **0054** se toma al unificar el membrete, el logo
y la marca de agua de todos los imprimibles (y cablear la marca de agua, que estaba declarada
en `brand.ts` y sin usar).

> **Numeración de la Fase 11:** el plan de facturación
> ([`../feat_billing.md`](../feat_billing.md)) numeraba sus cinco ADRs **0043–0047** porque daba por hecho
> que 0042 era el último. El [ADR 0043](0043-se-descarta-el-enfoque-de-instalacion-actual.md) —instalación
> y despliegue— se escribió antes y ocupó ese número, así que el módulo de facturación entra como
> **0044–0048**. El plan de la fase ya está corregido.

| # | Decisión | Estado |
| :-: | :--- | :--- |
| [0001](0001-infraestructura-nativa.md) | Desarrollo nativo sin Docker; producción en Fedora | aceptada |
| [0002](0002-postgresql-una-base-por-servicio.md) | PostgreSQL 18 con una base de datos por servicio | aceptada |
| [0003](0003-outbox-y-pg-boss.md) | Outbox transaccional + pg-boss sobre PostgreSQL (sin broker externo) | aceptada |
| [0004](0004-nueve-microservicios.md) | Nueve microservicios por contexto delimitado | aceptada |
| [0005](0005-autenticacion-y-roles.md) | JWT corto + refresh rotativo + RBAC y tokens de dispositivo | aceptada |
| [0006](0006-un-odontologo-un-sillon.md) | Un odontólogo y un sillón, con el modelo preparado para más | **superada por [0059](0059-el-sillon-es-el-recurso-de-la-agenda.md)** |
| [0007](0007-identificacion-de-pacientes.md) | Identificación V, E, P y menores con marcador `SC-` | aceptada |
| [0008](0008-bot-unico-long-polling.md) | Un solo bot de Telegram con long polling, deep link y plan B manual | aceptada |
| [0009](0009-cupo-y-franjas.md) | Cupo diario editable, plantillas de franjas y hora manual | aceptada |
| [0010](0010-notificacion-en-lote.md) | Notificación en lote con vista previa y reenvío individual | aceptada |
| [0011](0011-ticket-consecutivo.md) | Ticket con secuencia global y prefijo alfabético al desbordar | aceptada |
| [0012](0012-maquina-de-estados.md) | Máquina de estados de cita, historia clínica y sesión | aceptada |
| [0013](0013-stack-del-frontend.md) | Vite + React + Tailwind + shadcn/ui + TanStack + Zod | aceptada |
| [0014](0014-sql-first-con-drizzle.md) | Acceso a datos SQL-first con Drizzle ORM y migraciones versionadas | aceptada |
| [0015](0015-recipe-a5-en-pdf.md) | Récipe A5 en PDF del servidor con membrete y QR de verificación | aceptada |
| [0016](0016-firma-y-consentimiento.md) | Aceptación registrada + impresión para firma en papel | aceptada |
| [0017](0017-marcar-atendido.md) | «Atendido» con advertencia y motivo auditado | aceptada |
| [0018](0018-alcance-del-bot-en-fase-4.md) | El bot solicita, entrega ticket y consulta estado (sin RSVP todavía) | aceptada |
| [0019](0019-reportes-y-kpis.md) | Reportes y KPIs seleccionados | aceptada |
| [0020](0020-modo-test.md) | Modo test con seed determinista y cédulas ficticias 90.000.000+ | aceptada |
| [0021](0021-acceso-remoto-por-vpn.md) | Acceso remoto por VPN mesh; el sistema nunca se expone a internet | aceptada |
| [0022](0022-typescript-5-9.md) | TypeScript 5.9 en lugar de 7.x por compatibilidad de herramientas | aceptada |
| [0023](0023-contrasenas-con-scrypt.md) | Contraseñas con scrypt de `node:crypto` (sin dependencias nativas) | aceptada |
| [0024](0024-secretos-fuera-del-repositorio.md) | Secretos fuera del repositorio, con escáner previo al commit | aceptada |
| [0025](0025-horas-en-12-horas.md) | Horas en formato de 12 h en la interfaz, 24 h en datos y `.ics` | aceptada |
| [0026](0026-cola-de-eventos-compartida.md) | Cola de eventos compartida en la base `odonto_events` | aceptada (corrige el ADR 0003) |
| [0027](0027-borrado-logico-de-pacientes.md) | Borrado lógico de pacientes, solo para el administrador | aceptada |
| [0028](0028-cancelar-devuelve-el-ticket.md) | Cancelar una cita devuelve el ticket a la cola | aceptada |
| [0029](0029-nucleo-conversacional-y-adaptadores.md) | Núcleo conversacional y adaptadores de canal (Telegram, WhatsApp) | aceptada (fase 4.1) |
| [0030](0030-pantallas-kiosko-y-sse.md) | Pantallas kiosko con token de dispositivo y SSE | aceptada (fase 5) |
| [0031](0031-odontograma-pieza-completa-sobre-caras.md) | La pieza completa manda sobre las caras del odontograma | **corregida por la 0032** |
| [0032](0032-convivencia-de-tratamientos-con-las-caras.md) | Los tratamientos conviven con las caras; solo `ausente` las supera | aceptada (fase 6B) |
| [0033](0033-odontograma-en-posicion-anatomica.md) | El odontograma se dibuja en posición anatómica (espejo por cuadrante y borde incisal) | aceptada (fase 6B) |
| [0034](0034-sesion-clinica-evolucion.md) | La sesión clínica es el documento de la evolución (borrador autoguardado, cierre inmutable, enmienda) | aceptada (fase 7A) |
| [0035](0035-datos-criticos-leidos-no-empujados.md) | Los datos críticos del consultorio se leen de la historia clínica, no se empujan | aceptada (fase 7A) |
| [0036](0036-recipe-emitido-documento-archivado.md) | El récipe emitido es un documento archivado (copia del paciente, del medicamento y del PDF) | aceptada (fase 7B) |
| [0037](0037-una-sola-pila-a-la-vez.md) | Una sola pila a la vez, y los puertos mandan (`stack:status/dev/fijo/down`) | aceptada (herramientas) |
| [0038](0038-permisos-del-odontologo-en-el-flujo.md) | El odontólogo escribe el flujo del día (`scheduling:write`); el mostrador conserva la jornada | aceptada (fase 8) |
| [0039](0039-reportes-clinicos-con-permiso-propio.md) | Los reportes clínicos exigen un permiso propio (`reports:clinical`) | aceptada (fase 9) |
| [0040](0040-refresco-del-read-model-de-reportes.md) | El read model de reportes se refresca al cerrar el lote y de noche | aceptada (fase 9) |
| [0041](0041-el-evento-lleva-lo-que-el-consumidor-necesita.md) | Un evento de dominio lleva lo que su consumidor necesita (bloques `patient`, `profile` y `session`) | aceptada (fase 9) |
| [0042](0042-el-seed-escribe-filas-y-eventos.md) | El seed del modo test escribe las filas y los eventos, con identificadores derivados de la semilla | aceptada (fase 10) |
| [0043](0043-se-descarta-el-enfoque-de-instalacion-actual.md) | Se descarta el enfoque de instalación y despliegue actual; el rediseño parte de una sola fuente de verdad para las credenciales | aceptada (despliegue) |
| [0044](0044-modulo-de-facturacion-desacoplado.md) | El módulo de facturación es un servicio desacoplado, y el borrador nace de la sesión clínica | aceptada (fase 11) |
| [0045](0045-regimen-tributario-iva-e-igtf.md) | Régimen tributario: servicios exentos, bienes al 16 % y el IGTF como dato del medio de pago | aceptada (fase 11) |
| [0046](0046-tasa-bcv-historica-y-regla-de-imputacion.md) | La tasa BCV es histórica, se congela por documento y tiene una regla de imputación explícita | aceptada (fase 11) |
| [0047](0047-quien-asigna-el-numero-de-la-factura.md) | Quién asigna el número de la factura: formas libres, máquina fiscal o régimen digital | aceptada (fase 11) |
| [0048](0048-el-documento-de-cobro-se-archiva.md) | El documento de cobro se archiva: emitir es congelar, y anular no es borrar | aceptada (fase 11) |
| [0049](0049-facturar-en-modo-software-y-una-sola-tasa.md) | Facturar en modo `software` por defecto, y una sola regla de tasa | aceptada |
| [0050](0050-windows-segundo-destino-de-produccion.md) | Windows es un segundo destino de producción soportado (y cómo se instala) | aceptada |
| [0051](0051-denticion-mixta-en-el-odontograma.md) | El odontograma admite dentición mixta (el paciente que está mudando) | aceptada |
| [0052](0052-confirmacion-de-citas-por-el-paciente.md) | El paciente confirma su cita: estado `confirmada`, botón en el aviso y la próxima cita de la sesión se crea en la agenda | aceptada |
| [0053](0053-cancelacion-de-citas-por-el-paciente.md) | El paciente cancela su cita: botón y palabra «cancelar», atribución con `cancelled_at`/`cancelled_channel` y el KPI del embudo | aceptada |
| [0054](0054-membrete-unico-en-los-imprimibles.md) | El membrete, el logo y la marca de agua son los mismos en todos los imprimibles (y la marca de agua, antes declarada y sin usar, se cablea) | aceptada |
| [0055](0055-dos-tipografias-en-los-imprimibles.md) | Los imprimibles tienen dos tipografías (títulos y cuerpo), auto-hospedadas e incrustadas: el papel no depende del equipo | aceptada |
| [0056](0056-la-identidad-del-consultorio-vive-en-la-base.md) | La identidad del consultorio vive en la base de datos: el titular la completa en su primer acceso, queda auditada y `clinic.ts` pasa a semilla y respaldo | aceptada |
| [0057](0057-cancelacion-con-plazo-canales-y-novedades.md) | La cancelación del paciente tiene plazo (configurable), la bandeja de canales dice el nombre y `/inicio` cuenta las novedades | aceptada |
| [0058](0058-sin-datos-personales-en-el-codigo.md) | Sin datos personales en el código: la identidad se sirve solo desde el registro del titular (se elimina el respaldo con datos y los overrides `CLINIC_*`) | aceptada |
| [0059](0059-el-sillon-es-el-recurso-de-la-agenda.md) | El **sillón** es el recurso que ocupa la franja (varios consultorios en paralelo); el odontólogo es un atributo opcional y la pantalla de consultorio es una TV compartida con un tile por sillón | aceptada |
