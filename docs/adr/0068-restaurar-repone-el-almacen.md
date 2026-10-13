# ADR 0068 — Restaurar repone el almacén y reconcilia su clave

- **Fecha:** 2026-10-13
- **Estado:** aceptado
- **Anexo a:** [ADR 0048 — El documento de cobro se archiva: emitir es congelar](0048-el-documento-de-cobro-se-archiva.md) · [ADR 0056 — La identidad del consultorio vive en la base](0056-la-identidad-del-consultorio-vive-en-la-base.md)
- **Fuente de verdad en código:** `infra/fedora/backup/lib-almacen.sh`, `tools/verificar-almacen.mjs`, `tools/purgar-cuentas-prueba.mjs`, `infra/fedora/odontocrm`, `infra/windows/odontocrm.ps1`, `infra/fedora/instalar/aprovisionar.mjs`

## Contexto

Reimprimir un récipe **no recompone** el PDF: vuelve a leer el archivo **archivado** en el almacén
compartido (ADR 0036/0048). Ese archivo vive cifrado con `STORAGE_ENCRYPTION_KEY`, y bastaban dos
cosas para perderlo: `odontocrm restaurar` solo restauraba **las bases** —nunca el almacén ni la
clave— y, al reinstalar en una máquina nueva, el aprovisionador generaba **otra** clave. Resultado:
las filas apuntaban a documentos **ausentes** o a archivos cifrados con una clave distinta (el
sistema parecía sano y ningún documento se abría). Es exactamente el hueco que ya se había cerrado en
el respaldo nocturno, pero **no** en la restauración.

Por otra parte, `30-desplegar.sh` usaba como **defecto** el juego completo de desarrollo
(`admin`, `recepcion` y los odontólogos de `clinic.ts`) cuando `USUARIOS_SEED` estaba vacío; y como
`odontocrm actualizar` llama a esa pieza **sin** definir la variable, **sembraba cuentas de prueba en
producción**.

## Decisión

1. `odontocrm restaurar --all` y `odontocrm recuperar` **repueblan el almacén** además de las bases, y
   **reconcilian `STORAGE_ENCRYPTION_KEY`** copiando la del respaldo a los `.env` mediante una
   operación **quirúrgica** (`aprovisionar.mjs --clave-almacen`: reemplaza **solo** esa línea, sin
   recalcular el resto).
2. Tras reponer, se **verifica en el acto** (`tools/verificar-almacen.mjs`): un archivo de muestra
   tiene que **descifrarse**; no basta con que los archivos estén.
3. El restaurar de **una** base (`--db`) y el listado (`--list`) **no** tocan el almacén ni los
   servicios: siguen siendo solo-bases.
4. El **defecto** del despliegue pasa a `admin`; el juego de desarrollo es **opt-in** con
   `USUARIOS_SEED=all` (`--con-todas-las-cuentas` en el instalador).
5. Se añade `odontocrm purgar-prueba` para retirar cuentas de prueba ya sembradas (las **desactiva**
   por defecto; `--borrar` las elimina) y `tools/purgar-cuentas-prueba.mjs` lo implementa.
6. El **simulacro** de restauración (`verify-backup`) revisa también el almacén, no solo las bases.

## Alternativas consideradas

- **Reescribir los `.env` enteros con el aprovisionador**: descartado — recalcularía `WEB_ORIGIN` y el
  nombre con los valores por defecto y rompería el CORS; de ahí la operación quirúrgica.
- **Recomponer el PDF al reimprimir**: descartado por el ADR 0048 (el documento se archiva).
- **Seguir dejando la clave a mano**: descartado — es justo lo que se olvidaba y dejaba el historial
  ilegible.

## Consecuencias

- Un `restaurar --all` ahora **para y arranca** servicios (gestiona el ciclo, como `recuperar`).
- Un respaldo con la clave equivocada se detecta **antes** de necesitarlo: el simulacro comprueba el
  almacén.
- La instalación limpia siembra **solo `admin`**: menos superficie y ninguna cuenta con contraseña
  conocida en producción.
