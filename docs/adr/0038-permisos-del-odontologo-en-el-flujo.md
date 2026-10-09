# ADR 0038 — Permisos del odontólogo en el flujo del día

- **Fecha:** 2026-10-04 · **Estado:** aceptada · **Implementada:** Fase 8 (`/flujo`, 2026-10-04)

## Contexto

La Fase 8 construye `/flujo`: **el día completo en una sola pantalla** para la odontóloga que
trabaja sin asistente. La cola del día a la izquierda, el expediente del paciente en el centro y,
en la barra superior, las acciones de secretaría: registrar la llegada, llamar (el llamado que
sale en la pantalla de la sala), pasar a consulta, marcar atendido y marcar inasistencia.

Al probarlo apareció el muro: **ninguna de esas cinco acciones funcionaba** para un usuario con
el rol `odontologo`.

- El rol no tenía `scheduling:write` (decisión de la Fase 1, «el odontólogo no toca la agenda»),
  y las cinco rutas del flujo lo exigen. El servidor respondía 403.
- La **máquina de estados** (§5.1, aprobada el 2026-10-02) sí autorizaba al odontólogo en cuatro
  de las cinco: llegada, llamado, segundo llamado y paso a consulta. La inasistencia era la única
  reservada a la secretaría.
- La tabla de permisos por acción del plan (§5.4) ya decía «Llamar / pasar a consulta / no
  asistió: **odontólogo ✅**», así que el contrato y el RBAC llevaban desde la Fase 1 en
  desacuerdo.

La pregunta real no era «¿puede el odontólogo tocar la agenda?» sino «**qué** parte de la agenda
es del día del consultorio y qué parte es del mostrador».

## Decisión

**El odontólogo escribe el flujo del día; el mostrador conserva lo que decide la jornada.**

1. El rol `odontologo` gana **`scheduling:write`** (`packages/contracts/src/domain/enums.ts`).
   Es un solo permiso, sin inventar uno nuevo: la alternativa (un `scheduling:flow` para las cinco
   transiciones) obligaba a tocar las rutas de scheduling y a mantener dos permisos que hacen casi
   lo mismo.
2. La **máquina de estados** abre la inasistencia al odontólogo en sus cuatro orígenes
   (`programada`, `notificada`, `en_sala_espera` y `llamado`), que era lo único que la Fase 8
   pedía y no estaba. Sigue siendo la máquina la que decide **qué transición** puede hacer cada
   rol, no el permiso: el permiso abre la puerta de la API, la máquina dice por dónde se pasa.
3. **Sigue fuera de su alcance**, y se comprueba en la prueba de integración:
   - `scheduling:notify` (avisar al paciente en lote) y `scheduling:overbook` (autorizar
     sobrecupo): permisos que no tiene.
   - **Cancelar y reprogramar**: la máquina de estados no le autoriza esas transiciones y la API
     responde 409 con lo que sí puede hacer desde ese estado.
4. **La escritura clínica no se mueve**: `clinical:write` y `odontogram:write` siguen siendo del
   odontólogo y del admin, y la secretaría sigue con `clinical:read` / `odontogram:read`
   (decisión 23, ADR 0035).

## Consecuencias

- **A favor:** `/flujo` funciona para quien trabaja solo, que es el objetivo de la fase; la
  doctora registra al paciente, le da la cita, la notifica otro si hace falta, y lleva el día
  entero sin cambiar de usuario. El RBAC queda alineado con la máquina de estados y con §5.4, que
  ya lo decía.
- **En contra / a vigilar:**
  - El odontólogo puede ahora **asignar citas y cambiar cupos y plantillas** por la API (esas
    rutas solo piden `scheduling:write`; asignar no tiene además comprobación de rol). Era parte
    de lo aceptado al decidirlo, y la interfaz no le ofrece esas pantallas de escritura, pero
    conviene saberlo: §5.4 se actualizó para decirlo.
  - **Los permisos viajan dentro del token de acceso** (`services/identity`, `security/session.ts`).
    Tras este cambio, una sesión abierta antes de desplegarlo sigue con los permisos viejos: hay
    que **volver a entrar** (o reiniciar el servicio de identidad y dejar que caduque el token,
    15 min). Está dicho en el runbook de la fase 10.
  - La prueba de la Fase 1 que aseguraba lo contrario (`odontologo escribe lo clínico y no toca la
    agenda`) se reescribió: ahora fija **qué** escribe y qué no.
- **Cómo se comprueba:** `npm run e2e:flujo` con el usuario `prueba` (rol `odontologo`): entra,
  registra el paciente, crea la solicitud y la cita, amplía el cupo del día si está lleno, y hace
  el flujo completo. La suite de integración de scheduling añade el caso «el odontólogo solo lleva
  el flujo del día completo» con las tres transiciones que le siguen respondiendo 409.
