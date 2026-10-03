# ADR 0004 — Nueve microservicios por contexto delimitado

- **Fecha:** 2026-10-02 · **Estado:** aceptada

## Contexto

El sistema cubre recepción, agenda, consultorio, pantallas, reportes, usuarios y auditoría. Un
monolito modular sería más barato de operar, pero el interesado pidió explícitamente
microservicios desde el inicio para no migrar después.

## Decisión

**Nueve servicios**, cada uno dueño de un contexto delimitado y de su base de datos:

| Servicio | Responsabilidad |
| :--- | :--- |
| `apps/gateway` | Punto único de entrada: proxy por recurso, CORS, límites, verificación de tokens |
| `services/identity` | Usuarios, roles, autenticación y auditoría |
| `services/patients` | Paciente único (cédula V/E/P/SC), contacto, archivos |
| `services/scheduling` | Tickets, cola de espera, cupos, franjas, citas y sus estados |
| `services/notifications` | Bot de Telegram, plantillas, cola de envíos y `.ics` |
| `services/clinical` | Historia clínica, sesiones, récipes y PDF A5 |
| `services/odontogram` | Odontograma FDI con captura por excepción e histórico |
| `services/screens` | Estado de las pantallas de sala y consultorio (SSE) |
| `services/reporting` | Read model, KPIs y exportaciones |

## Consecuencias

- ✅ Cada contexto evoluciona y se despliega por separado; los fallos se aíslan.
- ✅ Los límites son claros: qué tabla pertenece a quién y quién puede escribirla.
- ⚠️ Nueve procesos y ocho bases: más operación, mitigada con un comando de arranque, PM2,
  `/health`, `/ready` y el bootstrap automatizado.
- ⚠️ Camino de repliegue acordado: si resulta pesado, se fusionan `odontogram`+`clinical` y
  `screens`+`reporting` sin cambiar los contratos públicos.
