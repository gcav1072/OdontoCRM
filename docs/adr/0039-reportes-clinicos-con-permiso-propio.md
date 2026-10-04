# ADR 0039 — Los reportes clínicos exigen un permiso propio (`reports:clinical`)

- **Fecha:** 2026-10-04 · **Estado:** aceptada (fase 9)

## Contexto

El §5.4 del plan reparte los reportes por rol desde la Fase 1: **la secretaría ve
los operativos** (embudo, ocupación, demografía) y **el odontólogo los clínicos**
(perfil clínico agregado, salud bucal, recetas por medicamento). El catálogo de
permisos, sin embargo, tenía **un solo** permiso de reportes —`reports:read`— y lo
tenían los tres roles operativos, así que no había forma de cumplir ese reparto.

La tentación era reutilizar `clinical:read`, que la secretaría tiene desde la
decisión 23 (2026-10-04) para **imprimir** récipes, consentimientos, historia y
odontograma. Pero eso son documentos **de un paciente**, uno a uno y con el
paciente delante; los reportes clínicos son **agregados de toda la consulta**
(«cuántos diabéticos», «qué medicamentos se recetan»), que es justo el tipo de
dato que no hace falta para atender el mostrador.

## Decisión

Se añade el permiso **`reports:clinical`** (`packages/contracts/src/domain/enums.ts`)
y cada reporte declara el suyo en `REPORT_PERMISSIONS`:

| Reporte | Permiso | Quién lo tiene |
| :--- | :--- | :--- |
| Embudo e inasistencia · Ocupación · Demografía | `reports:read` | admin, secretario, odontólogo |
| Perfil clínico · Salud bucal · Recetas | `reports:clinical` | admin, odontólogo |

El servicio `reporting` lo aplica **por reporte** (`reportPermissionFor(key)`), no
por prefijo de ruta: `GET /api/v1/reports/funnel` responde 200 a la secretaría y
`GET /api/v1/reports/clinical-profile` responde **403** con el mismo token. La
interfaz oculta las pestañas clínicas a quien no las tiene y lo explica, en vez de
ofrecer un botón que devuelve 403.

## Consecuencias

- ✅ Se cumple el reparto del §5.4 sin abrir datos clínicos agregados al mostrador.
- ✅ El odontólogo conserva **todo** el catálogo (`reports:read` + `reports:clinical`),
  que es como trabaja hoy en `/reportes`: ve el día y la clínica en la misma pantalla.
- ⚠️ **Los permisos viajan en el token** ([ADR 0005](0005-autenticacion-y-roles.md)):
  tras desplegar esto hay que **volver a entrar** para que el permiso nuevo llegue
  al JWT. Es el mismo aviso que dejó la [ADR 0038](0038-permisos-del-odontologo-en-el-flujo.md).
- ⚠️ La exportación hereda el permiso del reporte: no hay forma de sacar por CSV
  un reporte clínico sin `reports:clinical`.
