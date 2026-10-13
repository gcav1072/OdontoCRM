# Pendiente de documentación — la verificación pública mostraba «Odontólogo prueba»

> **Qué es este archivo.** El arreglo de la **verificación pública** de documentos —el récipe
> (`/verificar/<código>`) y el expediente (`/verificar-expediente/<código>`) enseñaban el
> **odontólogo del código** («Odontólogo prueba») en vez del que emitió— ya está en el **código**,
> pero su **documentación no se tocó a propósito**: en la otra PC hay commits sin subir que editan
> `CHANGELOG.md` y varios docs, y meter aquí esas mismas ediciones provocaría conflictos de rama.
> Este archivo reúne **todo lo que hay que actualizar** cuando se fusionen los dos lados; después se
> puede borrar.
>
> **Regla de oro al aplicarlo:** NO reescribir secciones enteras. Añadir la entrada del CHANGELOG
> **arriba** y tocar los docs con el **mínimo** de líneas, como se indica abajo.

**Qué se arregló (en código, ya hecho):** al abrir el QR de un documento, la página pública resolvía
quién firmaba con `clinicDentistFor(usuario)` **sin** pasarle la identidad del consultorio, de modo
que caía al respaldo del código (`CLINIC`), que solo tiene al odontólogo **del seed** («Odontólogo
prueba», usuario `prueba`). Por eso un récipe emitido por otro odontólogo salía a nombre de ese
nombre de prueba, y el nombre del consultorio salía **en blanco** (el `CLINIC.name` del código está
vacío). Además, la web pintaba el encabezado con `CLINIC.name` directo (siempre vacío).

Ahora `verifyPrescription` / `verifyDossier` reciben el `letterheadLookup` (la lectura de identity
con caché, ADR 0056) y resuelven el **odontólogo que emitió** (`issuedByUsername`) y el **nombre del
consultorio** contra la identidad **real de la base**; el respaldo del código queda solo para cuando
no hay lector (pruebas unitarias). La web usa el `clinicName` que ya devuelve la verificación.

---

## 1. `CHANGELOG.md` — entrada nueva (arriba del todo)

Añadir una sección al principio (respetando el estilo Keep a Changelog del archivo), con un texto
equivalente a este:

```markdown
## [Clínica] — La verificación pública enseña el consultorio de verdad, no «Odontólogo prueba» · 2026-10-13

Al abrir el **QR de un récipe** (o del expediente) la página pública confirmaba la autenticidad, pero
firmaba **«Odontólogo prueba»** y dejaba el **nombre del consultorio en blanco**: la verificación
resolvía el firmante con `clinicDentistFor(usuario)` **sin** la identidad del consultorio, así que
caía al **respaldo del código** (`CLINIC`) —que solo tiene al odontólogo del **seed**— en vez de leer
la identidad real de la base. La web, además, encabezaba con `CLINIC.name` (vacío) en lugar del
nombre que devuelve la verificación. Arregla las dos páginas públicas: el récipe (`/verificar/<código>`)
y el expediente (`/verificar-expediente/<código>`).

| Pieza | Qué hace |
| :--- | :--- |
| `verifyPrescription` / `verifyDossier` (clinical) | Reciben el `letterheadLookup` y resuelven el odontólogo que **emitió** (`issuedByUsername`) y el nombre del consultorio desde la identidad real (ADR 0056) |
| Rutas `/clinical/verify/:code` y `/clinical/verify-expediente/:code` | Pasan el `letterheadLookup` del servicio en vez del `CLINIC.name` del código |
| `VerifyPrescriptionPage` / `VerifyDossierPage` (web) | El encabezado usa el `clinicName` de la verificación (la página es pública y no puede pedir la identidad sin sesión) |
| `prescription.integration.test.ts` | La verificación devuelve el consultorio y el odontólogo de la identidad leída, no los del código |

> **Sin migración.** Es lectura, no datos. El arreglo vive en el `dist` de `services/clinical` **y** en
> el bundle de la web: en producción hace falta `sudo odontocrm actualizar` (o `recompilar`) para que
> entre; hasta entonces la verificación sigue firmando «Odontólogo prueba».
```

---

## 2. Otros docs principales — el cambio mínimo

- **`docs/IDENTIDAD_Y_DATOS.md` §10 «Verificación» (tabla final)** — añadir una fila:

  | Qué | Cómo |
  | :--- | :--- |
  | La verificación pública enseña el consultorio y el firmante reales | Abrir el QR de un **récipe** emitido por un odontólogo distinto del de prueba: el nombre y el MPPS son los suyos, no «Odontólogo prueba» |

- **`docs/IDENTIDAD_Y_DATOS.md` §12 «Errores comunes»** — añadir una fila a la tabla (junto a «El
  récipe sale con el membrete del **código**…»):

  | Síntoma | Causa | Arreglo |
  | :--- | :--- | :--- |
  | La página de verificación firma «Odontólogo prueba» o sale sin nombre de consultorio | El servicio `clinical` no pudo leer la identidad de `identity` y cayó al respaldo del código **al verificar** (misma causa que el membrete del código en los PDF) | Revisar que `identity` esté arriba y que el despliegue esté al día (`sudo odontocrm actualizar`); el aviso del log es el mismo del membrete («Los imprimibles usan el membrete del CÓDIGO…») |

- **`docs/OPERACION_CLINICA.md` §4 «Los récipes»** — el texto que describe la verificación pública
  («quien tenga el papel puede comprobar en la dirección pública que ese récipe consta y a nombre de
  quién está») **ya es correcto**; **opcional** añadir «con el **nombre del consultorio** y el del
  **odontólogo que lo emitió**» para que quede explícito. No es obligatorio.

- **ADR** — **no** procede uno nuevo: es un arreglo de lectura (usar la identidad real en vez del
  respaldo del código), no una decisión de diseño. La decisión que lo gobierna ya existe:
  [ADR 0056](adr/0056-la-identidad-del-consultorio-vive-en-la-base.md) (la identidad vive en la base)
  y [ADR 0015](adr/0015-recipe-a5-en-pdf.md) (la verificación no expone datos clínicos). Como mucho,
  una línea en las **Consecuencias** del ADR 0056, pero no aporta más que el CHANGELOG.

---

## 3. Seguimiento (NO bloquea este arreglo)

- **Despliegue (gotcha de siempre).** El arreglo toca **dos** artefactos: el `dist` de
  `services/clinical` **y** el bundle de `apps/web`. `sudo odontocrm actualizar` recompila y reinicia
  todo; hasta entonces la página pública sigue firmando «Odontólogo prueba».
- **La caché del membrete.** `letterheadLookup` cachea 5 s en `clinical` (ADR 0064); un cambio de
  identidad puede tardar unos segundos en reflejarse en la verificación. Es inocuo, pero conviene
  saberlo si se prueba justo después de editar «Mi perfil».
- **El odontólogo del seed sigue en `CLINIC`.** Es la lista de relleno que solo usa el seed y el
  respaldo de arranque; el arreglo **no** la toca. Si se quiere ser más estricto, se podría hacer que
  la verificación **no** cayera al código cuando hay lector configurado (devolver `null` en vez de
  «Odontólogo prueba» si identity no responde); se dejó como está para no cambiar el respaldo.
