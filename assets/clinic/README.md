# Logo del consultorio

Deja aquí el logo que sale en el membrete del récipe A5 (y en lo que venga):
`assets/clinic/logo.png`.

- **PNG con fondo transparente** es lo que mejor se ve; también sirve un JPG.
- Se imprime a unos 22 mm de alto, así que conviene que la imagen tenga al menos
  400 px de ancho.
- Si el archivo no está, el membrete sale **sin logo** (y `letterheadMissingFields`
  avisa de que falta): no hay que tocar código ni configuración.

La ruta se cambia en la sección editable del consultorio
([`packages/contracts/src/clinic.ts`](../../packages/contracts/src/clinic.ts)),
que es también donde van el nombre, el RIF, los teléfonos y los odontólogos con su
MPPS.
