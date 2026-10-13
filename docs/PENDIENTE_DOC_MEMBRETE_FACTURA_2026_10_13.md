# Pendiente de documentación — el membrete de la factura encabeza con el nombre del consultorio

> **Qué es este archivo.** El arreglo de la **factura** (y del **recibo** y la **nota de crédito**),
> que ponían la **razón social** de nombre del membrete y dejaban el **nombre del consultorio** de
> renglón menor —y en **blanco** cuando la razón social estaba vacía—, ya está en el **código**, pero
> su **documentación no se tocó a propósito**: en la otra PC hay commits sin subir que editan
> `CHANGELOG.md` y varios docs, y meter aquí esas mismas ediciones provocaría conflictos de rama.
> Este archivo reúne **todo lo que hay que actualizar** cuando se fusionen los dos lados; después se
> puede borrar.
>
> **Regla de oro al aplicarlo:** NO reescribir secciones enteras. Añadir la entrada del CHANGELOG
> **arriba** y tocar los docs con el **mínimo** de líneas, como se indica abajo.

**Qué se arregló (en código, ya hecho):** `invoice-pdf.ts`, `receipt-pdf.ts` y `credit-note-pdf.ts`
componían el membrete con `{ name: clinic.legalName ?? clinic.name, subtitle: … }`, es decir: la
**razón social** de renglón grande y el nombre del consultorio debajo. Si el titular dejaba la razón
social en blanco (`''`, que es lo que guarda el perfil cuando el campo opcional se deja vacío), el
renglón grande salía **vacío** y el papel parecía no llevar el nombre. Ahora los tres salen **igual
que el récipe, el dossier y el membrete de la SPA**: `buildLetterheadView(clinic, …, { subtitle:
clinic.legalName })` → el **nombre del consultorio** encabeza (admite dos líneas) y la **razón
social**, si la hay, va de subtítulo.

---

## 1. `CHANGELOG.md` — entrada nueva (arriba del todo)

Añadir una sección al principio (respetando el estilo Keep a Changelog del archivo), con un texto
equivalente a este:

```markdown
## [Caja] — El membrete de la factura encabeza con el nombre del consultorio · 2026-10-13

La **factura**, el **recibo** y la **nota de crédito** ponían la **razón social** de nombre del
membrete y el **nombre del consultorio** como renglón de detalle. Cuando el titular dejaba la razón
social en blanco —el campo es opcional—, el renglón grande salía **vacío** y el nombre del
consultorio quedaba pequeño: el papel parecía no llevar el nombre del consultorio. Ahora los tres
componen el membrete **igual que el récipe, el dossier y el membrete de la SPA**: el **nombre del
consultorio** encabeza (admite dos líneas) y la **razón social**, si la hay, va de subtítulo. El
bloque sale del helper compartido (`buildLetterheadView`), así que la caja deja de desviarse del
resto de los imprimibles.

| Pieza | Qué hace |
| :--- | :--- |
| `invoice-pdf.ts` | El membrete encabeza con el nombre del consultorio; la razón social va de subtítulo |
| `receipt-pdf.ts` | Lo mismo para el recibo de un cobro |
| `credit-note-pdf.ts` | Lo mismo para la nota de crédito |
| `letterhead.ts` (contracts) | Los comentarios de `LetterheadView.name`/`subtitle` dejan de decir «la factura pone la razón social» |
| `invoice-pdf.test.ts` / `cobros-pdf.test.ts` | Regresión: el nombre del consultorio encabeza aunque la razón social venga vacía |

> **Sin migración.** Es composición del membrete, no datos. Los PDF ya archivados **no** se
> regeneran: la factura emitida sigue diciendo lo que decía (ADR 0048). Las nuevas salen con el
> nombre arriba.
```

---

## 2. `docs/IDENTIDAD_Y_DATOS.md` — §1 «Mapa: qué dato → dónde vive → quién lo edita»

Ajustar la fila de la **razón social** (≈línea 48) para que no se lea como si encabezara la factura,
y precisar en la del **nombre del consultorio** (≈línea 47) que **encabeza** el membrete:

- **Nombre del consultorio** … «… y membrete de **todos** los imprimibles (**encabeza** el bloque;
  admite **dos líneas**)».
- **Razón social** … «Membrete de los seis imprimibles **como subtítulo** bajo el nombre del
  consultorio (la factura, el recibo, la nota de crédito, el récipe y el dossier la llevan; el
  reporte, no)».

No hace falta tocar nada más de esa sección.

---

## 3. `docs/feat_billing.md` — «Encabezado legal» (≈línea 1169)

Donde dice «razón social y nombre comercial, **RIF**, dirección fiscal, teléfonos, logo…», dejar
claro **el orden** del membrete. Texto sugerido (mínimo cambio):

> **Encabezado legal** … : el **nombre del consultorio** encabeza el membrete (admite dos líneas) y
> la **razón social** va debajo como subtítulo, con el **RIF**, la dirección fiscal, los teléfonos,
> el logo y el especialista que firma en el orden que elige el panel. Mientras el perfil esté
> incompleto, la factura sale con el aviso de datos faltantes en vez de un membrete inventado.

---

## 4. ADR 0064 — nota de una línea (opcional)

El [ADR 0064](adr/0064-membrete-configurable-y-aplicado-en-caliente.md) es la fuente del membrete
compartido. En su sección **Consecuencias** conviene una línea: _los seis imprimibles encabezan con
el **nombre del consultorio** y llevan la **razón social** de subtítulo (la caja la invertía y quedaba
sin nombre cuando la razón social estaba vacía)_. No hace falta un ADR nuevo: es un arreglo, no una
decisión.

---

## 5. Seguimiento (NO bloquea este arreglo)

- **Despliegue (gotcha de siempre).** El cambio vive en el `dist` de `services/billing`: en prod hay
  que `sudo odontocrm recompilar` (o `actualizar`) y **volver a emitir**. Los PDF ya archivados **no**
  se regeneran: la factura emitida antes del arreglo **sigue sin** el nombre arriba.
- Valorar si conviene **normalizar la razón social vacía a `null`** al guardar el perfil
  (`clinicProfileSchema.legalName` guarda `''` cuando el campo opcional se deja en blanco; `.default(null)`
  no lo atrapa). Hoy el membrete ya lo tolera (la línea en blanco no se imprime), así que es cosmético.
