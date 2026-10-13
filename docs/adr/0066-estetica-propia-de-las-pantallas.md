# ADR 0066 — Estética propia de las pantallas kiosko

- **Fecha:** 2026-10-13
- **Estado:** aceptado
- **Fuente de verdad en código:** `packages/contracts/src/domain/screens.ts`, `services/screens/src/routes/screen-routes.ts`, `apps/web/src/lib/kiosko.ts`, `apps/web/src/styles/pantalla.css`

## Contexto

Las pantallas de la sala y del consultorio eran de **tema oscuro fijo** y heredaban el cromo de la
aplicación: el mismo fondo, el mismo acento y la misma tipografía. En la práctica son **otra cosa**
—una TV colgada en la pared, que la ve el paciente— y el consultorio pidió poder vestirlas por su
cuenta: modo claro u oscuro, su color y, si se quiere, el **logo del consultorio** de marca de agua,
**sin** que eso dependa de cómo esté configurada la interfaz de recepción.

Había además un problema de forma: la pantalla del **lobby** enseñaba el nombre del consultorio
tomándolo de `CLINIC_NAME` (un valor de entorno), que en la instalación real está **vacío** (la
identidad del consultorio vive en la base, ADR 0056/0058). El nombre salía en blanco.

## Decisión

1. El **aspecto vive en los ajustes de cada pantalla** (`screen_devices.settings`, JSONB;
   **sin migración**): `tema` (`claro`/`oscuro`), `acento` (los mismos presets de la interfaz) y
   `logoMarcaAgua` (booleano). Se editan en `/pantallas` → **Ajustes**.
2. El acento **reutiliza los presets de la app** (`UI_ACCENTS`) pero se aplica a variables CSS
   **propias** (`--kiosk-*`), **aisladas** de la clase `dark` del `<html>`: cambiar el tema de la
   aplicación **no** mueve la pantalla.
3. La **marca del consultorio** (nombre + logo) se sirve por su **propia ruta kiosko**
   (`GET /api/v1/screens/clinic`) y **no** dentro del estado de la sala (SSE): la sala cambia cada
   pocos segundos y la identidad casi nunca, así que meter el logo (una `data:` URI) en el estado lo
   reenviaría en cada trama. La ruta reusa el lector de identity con caché.
4. La **marca de agua** del logo usa **enmascarado alfa por modo** (silueta clara sobre oscuro, tinta
   sobre claro), así funciona con cualquier logo.
5. El **lobby** se reordena: arriba y centrado el **nombre del consultorio** y, debajo, la **hora** y
   cuánta gente hay **en sala**; en las esquinas, lo discreto (la etiqueta de la pantalla y el
   indicador de conexión).

## Alternativas consideradas

- **Meter tema y acento en la configuración global** (ADR 0060): descartado — cada pantalla debe poder
  ser distinta, y el panel global es para lo que vale para todo el sistema.
- **Añadir la marca al `LobbyState`/`ConsultationState`**: descartado — ensancha el estado que viaja
  por SSE en cada trama y obliga a tocar todas las firmas.
- **Enviar el nombre por `CLINIC_NAME`**: descartado — es el valor vacío que causaba el fallo, y la
  identidad ya vive en la base.

## Consecuencias

- El nombre y el logo de la pantalla se leen de **identity** con la caché que ya existía
  (`createLetterheadLookup`); si identity no responde, se degrada al respaldo **neutro** del código
  (sin datos personales), como el resto de los lectores de identidad.
- La pantalla **no** sigue el tema de la aplicación: es una decisión, no un olvido.
- El indicador de conexión de la pantalla del **consultorio** sigue en su cabecera (se dejó fuera del
  refactor para hacer el cambio mínimo).
