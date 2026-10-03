# ADR 0016 — Firma y consentimiento: aceptación registrada y papel

- **Fecha:** 2026-10-02 · **Estado:** aceptada (firma en pantalla queda como mejora futura)

## Contexto

El formato de historia clínica venezolano exige **consentimiento informado firmado** antes de
cualquier procedimiento invasivo, y la evolución clínica debe identificar al odontólogo. Un
consultorio pequeño trabaja con papelería y todavía no tiene firma digital certificada.

## Decisión

- El sistema registra el **consentimiento como aceptado** (tipo, fecha y hora, quién lo
  registró, quién lo aceptó) y **genera el documento imprimible** en A4 para firmarlo en papel;
  el ejemplar firmado puede adjuntarse como imagen o PDF a la historia del paciente.
- La historia clínica y la sesión quedan **atribuidas al usuario odontólogo** autenticado, con
  fecha, hora y registro en auditoría; la firma manuscrita se estampa en el papel.
- La **firma dibujada en pantalla (canvas)** y el estampado de una firma escaneada del perfil
  del doctor quedan como mejora posterior, sin cambiar el modelo de datos.

## Consecuencias

- ✅ Cumple lo legal con la papelería que el consultorio ya usa.
- ✅ No se bloquea el flujo clínico por hardware que aún no existe.
- ⚠️ El respaldo legal descansa en el papel firmado: los documentos deben imprimirse y
  archivarse (queda dicho en el procedimiento de la Fase 6).
