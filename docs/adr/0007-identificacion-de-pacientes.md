# ADR 0007 — Identificación de pacientes: V, E, P y menores con marcador `SC-`

- **Fecha:** 2026-10-02 · **Estado:** aceptada

## Contexto

En Venezuela la cédula de identidad se escribe con prefijo `V` (venezolano) o `E` (extranjero)
y entre 6 y 8 dígitos. Un consultorio atiende también a **extranjeros sin cédula** y a
**menores que aún no la tienen**, y en ambos casos la historia clínica es obligatoria.

## Decisión

- Tipos admitidos: **`V`, `E`, `P` (pasaporte) y `SC`** (menor sin cédula, con código temporal).
- Normalización única a `TIPO-NÚMERO` (sin puntos ni espacios); unicidad por `(tipo, número)`.
- Datos obligatorios de entrada: `V`/`E` con 6–8 dígitos, `P` con 5–15 alfanuméricos,
  `SC` con 4–8 dígitos internos.
- Para menores se registra **representante** (nombre, cédula, parentesco, teléfono).
- Cuando el menor obtiene su cédula, el registro se **promueve** (conserva el mismo `id` y la
  historia clínica); el cambio queda en auditoría.

## Consecuencias

- ✅ Ningún paciente queda sin historia clínica por no tener documento.
- ✅ Buscar `v 12.345.678` o `V-12345678` devuelve el mismo paciente.
- ⚠️ Hay que vigilar duplicados al promover `SC-` a `V-` (se resuelve con la búsqueda de
  similitud por nombre y fecha de nacimiento en la Fase 2).
