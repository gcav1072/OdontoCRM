# Pendiente de documentación — la leyenda del odontograma impreso sale sin color

> **Qué es este archivo.** El arreglo de la **leyenda del odontograma impreso** —los cuadritos de
> color (rojo `pendiente`, azul `completado` y el blanco de «sano») y los puntos de estado de las
> tablas salían **en blanco** en el papel, aunque en pantalla y en la vista previa se vieran bien— ya
> está en el **código**, pero su **documentación no se tocó a propósito**: en la otra PC hay commits
> sin subir que editan `CHANGELOG.md` y varios docs, y meter aquí esas mismas ediciones provocaría
> conflictos de rama. Este archivo reúne **todo lo que hay que actualizar** cuando se fusionen los dos
> lados; después se puede borrar.
>
> **Regla de oro al aplicarlo:** NO reescribir secciones enteras. Añadir la entrada del CHANGELOG
> **arriba** y tocar los docs con el **mínimo** de líneas, como se indica abajo.

**Qué se arregló (en código, ya hecho):** los códigos de color clínicos del documento imprimible se
pintaban con `background-color` (los cuadritos de la leyenda eran `<span>` con `style={{ backgroundColor }}`
y los puntos de estado de las tablas, igual). **Al imprimir, el navegador descarta los fondos CSS**
salvo que el usuario active «gráficos de fondo» en el diálogo de impresión: por eso en pantalla (y en
la vista previa) se veían, pero en el papel salían **en blanco**. No era un fallo del color —el `#ef4444`
y el `#3b82f6` estaban ahí—, sino de **cómo** se pintaban: el resto del dibujo (los dientes, los
símbolos de cada tratamiento y la doble línea de la prótesis) ya iba en **SVG**, y por eso sí imprimía.

El arreglo dibuja también esos cuadritos y puntos como **SVG** (`fill`): el dibujo vectorial **se imprime
siempre**, no depende de ninguna casilla del diálogo. Los **colores clínicos** (`CLINICAL_STATE_COLORS`,
rojo `pendiente` / azul `completado`) no cambian; solo cambia cómo se pintan.

---

## 1. `CHANGELOG.md` — entrada nueva (arriba del todo)

Añadir una sección al principio (respetando el estilo Keep a Changelog del archivo), con un texto
equivalente a este:

```markdown
## [Odontograma] — La leyenda del odontograma impreso sale en color (y no en blanco) · 2026-10-13

Al imprimir el odontograma, los **cuadritos de la leyenda** (rojo `pendiente`, azul `completado` y el
blanco de «sano») salían **en blanco** en el papel, aunque en pantalla y en la vista previa se vieran
bien. Lo mismo, en los **puntos de estado** de las tablas del informe (hallazgos, prótesis e historial).
No era un problema del color: esos códigos se pintaban con `background-color`, y **al imprimir el
navegador descarta los fondos CSS** salvo que el usuario active «gráficos de fondo» en el diálogo de
impresión. El resto del dibujo —dientes, símbolos, doble línea— ya iba en SVG, y por eso sí salía.

El arreglo dibuja esos cuadritos y puntos también como **SVG** (`fill`): el dibujo vectorial se imprime
siempre y no depende de ninguna casilla del diálogo. Los colores **clínicos** (rojo `pendiente`,
azul `completado`, `CLINICAL_STATE_COLORS`) no cambian: solo cambia cómo se pintan.

| Pieza | Qué hace |
| :--- | :--- |
| `Swatch` (`OdontogramStaticChart`) | Los tres cuadritos de la leyenda, en SVG en vez de `<span>` con fondo |
| `StateDot` (`OdontogramDocument`) | El punto de color del estado (hallazgos, prótesis e historial), en SVG |
| `document.test.ts` | Regresión: el papel **nunca** pinta un color clínico como `background-color`; los colores van en `fill`/`stroke` |

> **Sin migración.** Solo cambia el frontend: entra con `npm run build` (o `sudo odontocrm actualizar`
> en producción).
```

---

## 2. `docs/IDENTIDAD_Y_DATOS.md` §11 — tabla «Lo que **no** cambia con la paleta»

Añadir una fila (o ampliar la del rojo/azul) para dejar escrito **cómo** se pintan esos colores:

| Color | Dónde | Por qué se queda |
| :--- | :--- | :--- |
| … (fila existente del rojo/azul clínico) … | `CLINICAL_STATE_COLORS` | … y se dibujan en **SVG** (`fill`/`stroke`), **no** con `background-color`: al imprimir el navegador descarta los fondos CSS y el color saldría en blanco |

---

## 3. `docs/IDENTIDAD_Y_DATOS.md` §12 «Errores comunes» — fila nueva

Añadir una fila al final de la tabla (estilo «Corregido: …»):

| Síntoma | Causa | Arreglo |
| :--- | :--- | :--- |
| Los cuadritos de la leyenda o los puntos de estado del odontograma salen **sin color** en papel (en pantalla sí se ven) | Los códigos clínicos se pintaban con `background-color` y el navegador descarta los fondos al imprimir | **Corregido**: van en SVG (`fill`). Si vuelve a pasar, es que un color clínico se está pintando como fondo CSS |

---

## 4. `docs/OPERACION_CLINICA.md` §6-bis «Imprimir el odontograma y la historia» (opcional)

Un renglón corto, si se quiere dejar explícito para soporte:

> Los cuadritos de color de la leyenda y los puntos de estado salen **en color** en el papel aunque la
> impresora esté configurada para **no** imprimir fondos: van dibujados (SVG), no son fondos.

---

## 5. ADR — **no** procede uno nuevo

Es un arreglo de **cómo se pinta** (dibujo vectorial en vez de fondo CSS), no una decisión de diseño.
Las decisiones que lo gobiernan ya existen:
[ADR 0054](adr/0054-membrete-unico-en-los-imprimibles.md) (membrete, logo y marca de agua únicos) y
[ADR 0060](adr/0060-configuracion-de-la-aplicacion.md) §los colores clínicos no dependen de la paleta.

---

## 6. Seguimiento (NO bloquea este arreglo)

- La leyenda del **gráfico interactivo** (`OdontogramChart`) también usa `background-color` en los
  cuadritos, pero **no se imprime** (es pantalla): se dejó como estaba para no tocar la vista.
- Si algún día se quiere blindar el documento entero, una regla `print-color-adjust: exact` en el
  `@media print` forzaría **todos** los fondos —incluido el `bg-canvas` de la página, que saldría
  gris—: por eso se prefirió el SVG, que es lo que ya usaba el resto del dibujo.

---

## 7. Archivos tocados (para el commit atómico)

- `apps/web/src/components/odontogram/OdontogramStaticChart.tsx` — `Swatch` (cuadritos de la leyenda).
- `apps/web/src/components/odontogram/OdontogramDocument.tsx` — `StateDot` (puntos de estado).
- `apps/web/src/components/odontogram/document.test.ts` — regresión del color en el papel.
