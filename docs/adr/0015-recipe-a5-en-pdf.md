# ADR 0015 — Récipe A5 en PDF del servidor con membrete y QR

- **Fecha:** 2026-10-02 · **Estado:** aceptada (**forma superada por [ADR 0061](0061-recipe-en-dos-mitades-y-especialista-en-el-membrete.md)**)

> **Nota (ADR 0061).** El **fondo** de esta decisión sigue vigente: el récipe es un PDF que compone
> el servidor con Chromium, numerado, con QR y verificable sin exponer datos clínicos. Lo que cambió
> es la **forma**: ya no es un A5 de una cara, sino una **hoja carta apaisada partida en dos mitades**
> (copia de la farmacia y copia del paciente), y los datos del especialista pasan del pie al
> **membrete**.

## Contexto

Al cerrar una sesión debe aparecer el diálogo «¿desea guardar el récipe?» y, al aceptar,
imprimirse en **A5 con membrete**. Un récipe es un documento clínico-legal: debe quedar
archivado, numerado y poder verificarse después.

## Decisión

- El PDF se genera **en el servidor** (Playwright/Chromium sobre HTML con `@page { size: A5 }`)
  desde la plantilla del membrete.
- **Membrete configurable** (`clinic_settings` + perfil del odontólogo: nombre, **MPPS**,
  especialidad, teléfonos, dirección y logo). Nace genérico y se completa cuando el consultorio
  entregue sus datos.
- **Numeración** `RX-000001` con secuencia, y **QR de verificación** que apunta a
  `/verificar/<código>`, una página mínima que confirma autenticidad **sin exponer datos
  clínicos**.
- El PDF se guarda como archivo del paciente; **toda reimpresión queda auditada** (`print_count`,
  `last_printed_at`) y una receta emitida nunca se borra: se anula con motivo.
- Alternativa de repliegue si Chromium diera problemas en Fedora: `pdfmake` sin navegador.

## Consecuencias

- ✅ Documento con acabado profesional, copia auditable y verificable.
- ✅ El odontólogo puede imprimir en A5 desde cualquier navegador del consultorio.
- ⚠️ Playwright añade ~150 MB de navegador y sus dependencias del sistema en Fedora (se
  instalan y validan en la Fase 7 y en la Fase 10).
