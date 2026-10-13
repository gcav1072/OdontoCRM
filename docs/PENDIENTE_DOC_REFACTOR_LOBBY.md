# Pendiente de documentación — refactor de la pantalla de lobby

> **Qué es este archivo.** El refactor de la **pantalla de lobby** (estética propia de las
> pantallas kiosko, cabecera centrada, marca del consultorio y logo de marca de agua) ya
> está en el **código**, pero su **documentación no se tocó a propósito**: en la otra PC
> hay commits sin subir que editan `CHANGELOG.md` y varios docs, y meter aquí esas mismas
> ediciones provocaría conflictos de rama. Este archivo reúne **todo lo que hay que
> actualizar** cuando se fusionen los dos lados; después se puede borrar.
>
> **Regla de oro al aplicarlo:** NO reescribir secciones enteras. Añadir la entrada del
> CHANGELOG **arriba** y tocar los docs con el **mínimo** de líneas, como se indica abajo.

---

## 1. `CHANGELOG.md` — entrada nueva (arriba del todo)

Añadir una sección al principio (respetando el estilo Keep a Changelog del archivo), con un
texto equivalente a este:

```markdown
## [Pantallas] — Estética propia del lobby: tema, acento y logo de marca de agua · 2026-10-13

Las pantallas de la sala y del consultorio dejan de estar ancladas a la estética de la
aplicación: cada pantalla se configura en `/pantallas` con su **modo** (claro u oscuro), su
**color de acento** (los mismos diez presets de la interfaz) y la opción de mostrar el **logo
del consultorio como marca de agua** (silueta con alfa distinto según el modo). El **lobby**
se reordena: arriba y centrado el **nombre del consultorio** (el que completa el titular en su
primer login) y, debajo, la **hora** y cuánta gente hay **en sala**; abajo, en las esquinas, lo
discreto —a la izquierda «Sala de espera – ‹pantalla›» y a la derecha el indicador de conexión
(icono + última actualización, en verde o ámbar)—. Se añaden animaciones de entrada y de
resalte. **Sin migración**: el aspecto se guarda en el JSONB de ajustes de cada pantalla.

| Pieza | Qué hace |
| :--- | :--- |
| `screenSettingsSchema` (contratos) | + `tema` (`claro`/`oscuro`), `acento` (10 presets) y `logoMarcaAgua` (booleano) |
| `GET /api/v1/screens/clinic` (nuevo) | La marca del consultorio (nombre + logo) para la pantalla; reusa el lector de identity con caché |
| `useKioskTheme` (web) | Traduce los ajustes a variables CSS `--kiosk-*`; **no** sigue la clase `dark` de la app |
| `pantalla.css` (nuevo) | Estética kiosko: fondo con halo del acento, marca de agua y animaciones |
| `ScreenLobbyPage` | Cabecera centrada (nombre + hora + en sala), pie en las esquinas |
| `ScreenSettingsDialog` | Modo, acento y marca de agua por pantalla |
```

---

## 2. `docs/OPERACION_CLINICA.md` — §7 «Las pantallas de la sala y del consultorio»

Añadir al final de la sección (sin reescribir lo que ya hay):

- Que **cada pantalla tiene su propio aspecto** (modo claro/oscuro, color de acento y, si se
  quiere, el **logo del consultorio como marca de agua**), y que **no cambia** cuando cambia el
  tema de la aplicación de recepción. Se configura en `/pantallas` → **Ajustes** de la pantalla.
- Que la **sala de espera** muestra arriba y centrado el **nombre del consultorio**, y debajo la
  **hora** y las personas **en sala**.
- Aclarar (nota actual de esta sección) que el nombre/logo que salen en la pantalla los toma el
  sistema del **perfil del consultorio** (el que se completa en el primer acceso del titular).

---

## 3. `docs/IDENTIDAD_Y_DATOS.md`

- La tabla del final (≈línea 486) dice que `CLINIC_NAME` del `.env` «solo lo leen bot, `.ics` y
  pantallas». Ahora el **nombre y el logo** de la pantalla salen de la lectura interna de la
  identidad (ruta nueva `GET /api/v1/screens/clinic`), no de `CLINIC_NAME`. Revisar esa fila para
  que no confunda.

---

## 4. ADR — decisión nueva (sugerido: `docs/adr/0066-estetica-propia-de-las-pantallas.md`)

Registrar la decisión con, al menos:

- **Contexto:** las pantallas kiosko eran de tema oscuro fijo; se pidió que su estética (modo,
  acento y logo) se configurara **por pantalla** y **no** siguiera a la app.
- **Decisión:**
  - El aspecto vive en los **ajustes de cada pantalla** (`screen_devices.settings`, JSONB;
    **sin migración**), no en la configuración global de la app (ADR 0060).
  - El acento **reutiliza los presets de la app** (`UI_ACCENTS`) pero se aplica a variables CSS
    propias (`--kiosk-*`), aisladas de la clase `dark` del `<html>`.
  - La **marca del consultorio** (nombre + logo) se sirve por su **propia ruta kiosko**
    (`/api/v1/screens/clinic`) y no dentro del estado de la sala (SSE), porque la sala cambia
    cada pocos segundos y la identidad casi nunca: así el logo (una `data:` URI) no viaja en
    cada trama.
  - La marca de agua del logo usa **enmascarado alfa por modo** (silueta blanca sobre oscuro,
    tinta sobre claro) para funcionar con cualquier logo.
- **Alternativas consideradas:** meter tema/acento en la configuración global (descartado: la
  pantalla debe poder ser distinta); añadir la marca al `LobbyState`/`ConsultationState`
  (descartado: ensancha el estado que se reenvía por SSE y obliga a tocar todas las firmas).
- **Consecuencias:** el nombre/logo del consultorio se leen de identity con la caché que ya
  existía (`createLetterheadLookup`); si identity no responde, se degrada al respaldo neutro
  del código.

---

## 5. `docs/PLAN_MAESTRO_FASES.md`

- La descripción del **Displaylobby** (≈línea 452) menciona «fondo oscuro»/«animación». Ajustar
  a: la pantalla tiene **modo claro/oscuro configurable**, acento propio y **logo de marca de
  agua**, cabecera centrada con el nombre del consultorio, hora y contador de la sala.
- La tabla de cobertura de la Fase 5 (≈línea 323) no cambia.

---

## 6. Seguimiento (NO bloquea este refactor)

- El **indicador de conexión** de la pantalla del **consultorio** sigue en su cabecera. Si se
  quiere, se puede mover también a la esquina para que las dos pantallas queden iguales (se dejó
  fuera por hacer el cambio mínimo).
- Valorar si conviene un ajuste para **desactivar las animaciones** por pantalla (hoy van
  siempre, respetando `prefers-reduced-motion` del sistema).

---

## 7. Contrato (por si se documenta aparte)

- `packages/contracts/src/domain/screens.ts`:
  - `SCREEN_THEMES = ['claro', 'oscuro']`; `screenSettingsSchema` gana `tema`, `acento` (enum de
    `UI_ACCENT_IDS`) y `logoMarcaAgua` (por defecto: `oscuro`, `teal`, `false`).
  - Nuevo `screenClinicSchema` / `ScreenClinic`: `{ name: string | null; logoDataUri: string | null }`.
- Servicio `screens`: `ScreensServices.clinicLookup` (lectura de identity con caché) y la ruta
  kiosko `GET /api/v1/screens/clinic` (permiso `screens:display`, exige pantalla registrada y activa).
- **Sin migración SQL**: `settings` es JSONB y los valores por defecto los pone Zod al leer.
