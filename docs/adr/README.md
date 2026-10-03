# Decisiones de arquitectura (ADR) — OdontoCRM

Una ADR por decisión relevante, en el formato *Contexto · Decisión · Consecuencias*.
Las decisiones 0001–0021 provienen de la sesión de planificación del **2026-10-02**
(§1 de [`../PLAN_MAESTRO_FASES.md`](../PLAN_MAESTRO_FASES.md)); las 0022–0025 se
tomaron durante la Fase 0 y quedan documentadas por la misma razón.

| # | Decisión | Estado |
| :-: | :--- | :--- |
| [0001](0001-infraestructura-nativa.md) | Desarrollo nativo sin Docker; producción en Fedora | aceptada |
| [0002](0002-postgresql-una-base-por-servicio.md) | PostgreSQL 18 con una base de datos por servicio | aceptada |
| [0003](0003-outbox-y-pg-boss.md) | Outbox transaccional + pg-boss sobre PostgreSQL (sin broker externo) | aceptada |
| [0004](0004-nueve-microservicios.md) | Nueve microservicios por contexto delimitado | aceptada |
| [0005](0005-autenticacion-y-roles.md) | JWT corto + refresh rotativo + RBAC y tokens de dispositivo | aceptada |
| [0006](0006-un-odontologo-un-sillon.md) | Un odontólogo y un sillón, con el modelo preparado para más | aceptada |
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
