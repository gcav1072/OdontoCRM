# ADR 0005 — Autenticación JWT corta, refresh rotativo y tokens de dispositivo

- **Fecha:** 2026-10-02 · **Estado:** aceptada

## Contexto

Hay usuarios humanos (admin, secretario, odontólogo) y **pantallas kiosko** (sala de espera y
consultorio) que no tienen sesión de persona. Un sistema de salud maneja datos sensibles: la
sesión debe caducar, poder revocarse y no dejar credenciales en el navegador.

## Decisión

- **Acceso:** JWT firmado con **EdDSA** de 15 minutos, verificado por firma en cada servicio
  (sin consultar a identity en cada petición).
- **Refresco:** token opaco de 30 días en cookie **`httpOnly`, `SameSite=Lax`, `Secure`**,
  rotativo y con detección de reuso (si se reutiliza uno viejo, se revoca toda la familia).
- **Autorización:** RBAC por permisos (`users:manage`, `scheduling:write`, `clinical:write`…)
  y roles `admin`, `secretario`, `odontologo` y `pantalla`.
- **Pantallas:** token de dispositivo revocable desde el panel, con rol de solo lectura.
- **Interno:** los servicios se llaman entre sí con un service JWT de 60 s y ámbito cerrado.

## Consecuencias

- ✅ Revocación inmediata del refresco y del dispositivo; el acceso caduca solo.
- ✅ Los servicios validan sin acoplarse a identity, y el gateway es el único borde expuesto.
- ⚠️ Exige TLS interno para que la cookie `Secure` funcione (se configura en la Fase 10).
- ⚠️ La rotación obliga a manejar bien la carrera de varias pestañas (se resuelve con una
  ventana de gracia corta y pruebas específicas en la Fase 1).
