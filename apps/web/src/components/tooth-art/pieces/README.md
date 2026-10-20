# Piezas ilustradas de los dientes

64 SVG: 16 piezas × 2 caras × 2 arcadas. Un archivo por pieza y cara, con nombre
`<FDI>.svg`. Los usan el **periodontograma** (silueta completa, con raíz) y el
**odontograma** (solo la corona, como fondo del cuadro de la pieza).

| Carpeta | Uso |
| :--- | :--- |
| `maxilar-vestibular/` | Maxilar, cara vestibular (banda superior del periodontograma) |
| `maxilar-palatino/` | Maxilar, cara palatina (banda inferior; `PeriodontalSide` la llama `lingual`) |
| `mandibula-lingual/` | Mandíbula, cara lingual (banda superior) |
| `mandibula-vestibular/` | Mandíbula, cara vestibular (banda inferior) |

## Convenciones del dibujo

- Lienzo propio de `63 × 156` en todas; el contenido ocupa una caja distinta según la
  pieza (un canino es más largo que un tercer molar).
- La **corona mira siempre a la franja central** del gráfico del periodontograma: en
  `maxilar-vestibular` y `mandibula-lingual` está abajo; en `maxilar-palatino` y
  `mandibula-vestibular`, arriba. El odontograma aprovecha esa diferencia para que las
  dos arcadas queden con las coronas mirándose.
- Solo `path` con `fill` en grises: sin degradados, `id`s, imágenes ni referencias
  externas. Así los archivos se pueden incrustar en línea (no hacen peticiones) y no
  colisionan entre sí.
- **No existen piezas temporales** (51–85). Los dos módulos caen al esquema cuando la
  pieza no tiene dibujo.

## Alineación

- **Periodontograma**: `pieceArt.ts` guarda la **caja vectorial** de cada dibujo
  (`getBBox()` sobre el SVG) y `ToothSilhouette.tsx` la estira hasta la corona, la raíz
  y el ancho anatómicos de `toothSilhouetteSpec`. Una bolsa de 8 mm sombrea dos tercios
  de la raíz dibujada.
- **Odontograma**: es una vista oclusal, así que el dibujo **no** es anatómicamente
  literal. `ToothBackdrop.tsx` encaja la pieza **completa** (corona y raíz), centrada y
  sin deformar, dentro del cuadro de 100 × 100; las cinco caras del esquema siguen
  siendo las que mandan.

Si se sustituye un dibujo por otro, hay que volver a medirlo: con una caja vieja la
pieza del periodontograma queda descuadrada respecto al LAC y a las cotas de 2 mm.