# ADR 0027 — Borrado lógico de pacientes, solo para el administrador

- **Fecha:** 2026-10-03 · **Estado:** aceptada (decisión del usuario)

## Contexto

En el mostrador puede quedar un paciente registrado por error: un dedo torcido al teclear la
cédula, un duplicado, un nombre mal escrito. Hasta ahora solo se podía **inactivar**
(`inactivo`), lo que deja el registro en la base y sigue ocupando el documento: si el error fue
en la cédula, esa cédula queda «tomada» por un paciente que hay que corregir a mano.

Borrar de verdad choca con la naturaleza del sistema: hay historias clínicas, récipes, adjuntos y
auditoría que deben sobrevivir a cualquier error administrativo (y, en el futuro, la historia
clínica es un documento con valor legal).

## Decisión

Un **borrado lógico** (`patients.deleted_at`), reservado al rol `admin` mediante el permiso
`patients:delete`, que exige **motivo** (mínimo 3 caracteres) y deja rastro en la auditoría:

- `POST /api/v1/patients/:id/delete` con `{ reason }` (es `POST` y no `DELETE` porque lleva cuerpo).
- El paciente y sus adjuntos quedan marcados (`deleted_at`) y **desaparecen de listas, búsquedas y
  fichas**; el documento vuelve a quedar libre, así que se puede registrar de nuevo.
- No se destruye nada: el binario de los adjuntos sigue en el almacén, el historial local de
  contactos conserva la marca del borrado y la auditoría guarda `patient_deleted` con `before`,
  `after`, motivo, usuario e IP.
- El endpoint es **idempotente por naturaleza**: un segundo intento responde 404 porque el
  paciente ya no existe para el sistema.

## Consecuencias

- ✅ Un error de tecleo se arregla sin tocar la base ni pedir ayuda técnica, y sin perder rastro.
- ✅ El documento se libera: desaparece el caso «cédula ocupada por un registro equivocado».
- ✅ La auditoría distingue borrar (`patient_deleted`) de inactivar (`patient_status_changed`).
- ⚠️ Los datos siguen en disco y en la base: si alguna vez hace falta borrar de verdad (una
  petición legal del paciente), será un procedimiento aparte y documentado, no un botón.
- ⚠️ La interfaz no ofrece «restaurar»: recuperar un paciente borrado hoy exige una consulta
  manual en la base. Si en la práctica hace falta, se añadirá con su propia auditoría.
