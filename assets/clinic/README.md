# Logo del consultorio

Deja aquí el logo que sale en el membrete del récipe A5, el reporte A4, el dossier
del expediente y las facturas: `assets/clinic/logo.svg`.

- **SVG monocromo** con el relleno *incrustado* (`fill="#14504d"`, el verde-teal de
  la marca). No uses `currentColor` ni variables CSS: el servidor mete el logo en el
  PDF como `data:` URI dentro de un `<img>`, y ahí no hereda nada del documento.
- **Fondo transparente** y **solo `viewBox`** (sin `width`/`height`): el alto lo fija
  el CSS (`--brand-logo-height-mm`, 18 mm por defecto).
- **Texto convertido a trazados**, para que se vea igual en cualquier equipo.
- El mismo archivo hace de **marca de agua** en los imprimibles: se imprime a un
  solo color y con la opacidad muy baja (`--brand-watermark-opacity`).
- Si el archivo no está, el membrete sale **sin logo** (y `letterheadMissingFields`
  avisa de que falta): no hay que tocar código ni configuración.

También sirve un PNG o un JPG (`logo.png` / `logo.jpg`) si prefieres mapa de bits;
en ese caso conviene que tenga al menos 400 px de ancho y fondo transparente.

La ruta, la paleta y las tipografías se cambian en
[`packages/contracts/src/brand.ts`](../../packages/contracts/src/brand.ts); lo
demás del membrete —nombre, RIF, teléfonos y odontólogos con su MPPS— en
[`packages/contracts/src/clinic.ts`](../../packages/contracts/src/clinic.ts).

El paso a paso (desarrollo y producción) está en
[`docs/IDENTIDAD_Y_DATOS.md`](../../docs/IDENTIDAD_Y_DATOS.md).

