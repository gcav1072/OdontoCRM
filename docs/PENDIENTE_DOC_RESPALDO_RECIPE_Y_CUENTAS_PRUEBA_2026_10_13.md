# Pendiente de documentación — respaldos: reimpresión de récipes y cuentas de prueba

> **Qué es este archivo.** Dos arreglos que **ya están en el código** pero cuya **documentación
> no se tocó a propósito**: en la otra PC hay commits sin subir que editan `CHANGELOG.md` y
> varios docs, y meter aquí esas mismas ediciones provocaría conflictos de rama. Este archivo
> reúne **todo lo que hay que actualizar** cuando se fusionen los dos lados; después se puede
> borrar.
>
> **Regla de oro al aplicarlo:** NO reescribir secciones enteras. Añadir la entrada del
> CHANGELOG **arriba** y tocar los docs con el **mínimo** de líneas, como se indica abajo.

---

## Qué se arregló (contexto para quien documente)

1. **Los récipes no se podían reimprimir tras un respaldo/restauración.** Reimprimir un récipe
   **no** recompone el PDF: vuelve a leer el archivo **archivado** en el almacén compartido
   (`/var/lib/odontocrm/storage/clinical/…`), cifrado con `STORAGE_ENCRYPTION_KEY`. Pero
   `odontocrm restaurar` solo restauraba **las bases** —nunca el almacén ni la configuración— y,
   al reinstalar, el aprovisionador generaba **otra** clave: los documentos quedaban ausentes o
   ilegibles. Ahora `restaurar` (con `--all`) y `recuperar` **repueblan el almacén y reconcilian
   la clave** (se copia la del respaldo a los `.env`, sin tocar el resto) y **comprueban que un
   archivo de muestra se descifra de verdad**.
2. **Se sembraban dos cuentas de prueba** («Recepción prueba» y «Odontólogo prueba») en el
   servidor. `30-desplegar.sh` usaba como **defecto** el juego completo de desarrollo
   (`admin`, `recepcion` y los odontólogos de `clinic.ts`) cuando `USUARIOS_SEED` estaba vacío; y
   `odontocrm actualizar` llama a esa pieza **sin** definir la variable → sembraba las cuentas de
   prueba. Ahora el defecto es **solo `admin`**; el juego completo se pide con `USUARIOS_SEED=all`
   (o `--con-todas-las-cuentas`). Se añade `odontocrm purgar-prueba` para quitar las ya sembradas.

### Archivos de código nuevos/cambiados (para no documentar algo que no existe)

- NUEVOS: `infra/fedora/backup/lib-almacen.sh`, `tools/verificar-almacen.mjs`,
  `tools/purgar-cuentas-prueba.mjs`.
- CAMBIADOS: `infra/fedora/odontocrm` (subcomando `purgar-prueba`; `restaurar`/`recuperar`
  completos), `infra/windows/odontocrm.ps1` (espejo), `infra/fedora/instalar/aprovisionar.mjs`
  (`--clave-almacen`), `infra/fedora/instalar/30-desplegar.sh` + `instalar.sh`,
  `infra/windows/instalar/30-desplegar.ps1` + `instalar.ps1`, `tools/verify-backup.mjs`.
  **Sin migración SQL.**

---

## 1. `CHANGELOG.md` — entrada nueva (arriba del todo)

Añadir una sección al principio (respetando el estilo Keep a Changelog), con un texto
equivalente a este:

```markdown
## [Respaldo] — Reimprimir récipes tras restaurar, y no sembrar cuentas de prueba · 2026-10-13

Dos fallos del flujo de respaldo, los dos en la restauración:

**Los récipes no se podían reimprimir después de restaurar.** Reimprimir un récipe no recompone
el PDF: vuelve a leer el archivo archivado en el almacén (cifrado con `STORAGE_ENCRYPTION_KEY`).
`odontocrm restaurar` solo restauraba las bases —no el almacén—, y al reinstalar se generaba otra
clave, así que los documentos quedaban ausentes o ilegibles. Ahora `restaurar` (con `--all`) y
`recuperar` **repueblan el almacén**, **reconcilian la clave** (copian la del respaldo a los `.env`
sin tocar el resto) y **comprueban de verdad** que un archivo de muestra se descifra
(`tools/verificar-almacen.mjs`). El simulacro de restauración (`verify-backup`) revisa también el
almacén, no solo las bases.

**Se sembraban dos cuentas de prueba en el servidor.** `30-desplegar.sh` usaba por defecto el juego
completo de desarrollo («Recepción prueba» y «Odontólogo prueba») cuando `USUARIOS_SEED` estaba
vacío, y `odontocrm actualizar` no la definía. Ahora el defecto es **solo `admin`**; el juego
completo se pide con `USUARIOS_SEED=all` (`--con-todas-las-cuentas` en el instalador). Para las
cuentas ya sembradas hay `sudo odontocrm purgar-prueba` (por defecto las **desactiva**; `--borrar`
las elimina).

| Pieza | Qué hace |
| :--- | :--- |
| `infra/fedora/backup/lib-almacen.sh` (nuevo) | Repone el almacén, reconcilia la clave y verifica que se lee |
| `tools/verificar-almacen.mjs` (nuevo) | Cuenta archivos (en claro/cifrados) y descifra una muestra; sale 1 si no se lee |
| `tools/purgar-cuentas-prueba.mjs` (nuevo) | Quita `recepcion` y los odontólogos de `clinic.ts` de identity |
| `aprovisionar.mjs` | + `--clave-almacen` (reemplaza SOLO esa línea en los `.env`; no toca el resto) |
| `odontocrm restaurar`/`recuperar` | Reponen el almacén y su clave; `restaurar --all` también reinicia |
| `odontocrm purgar-prueba` | Nuevo subcomando (Fedora y Windows) |
| `30-desplegar.sh` | Siembra solo `admin`; el juego completo es opt-in (`USUARIOS_SEED=all`) |
```

---

## 2. `docs/RECUPERACION.md`

Tocar con el mínimo de líneas:

- **§5 («La recuperación, en un comando»)**: en la lista de los pasos de `recuperar`, el paso 3
  («Repone el almacén») debe decir que además **reconcilia `STORAGE_ENCRYPTION_KEY`** y
  **comprueba que se descifra**. Añadir que la clave se copia del respaldo a los `.env` aunque no
  se use `--con-config` (es la excepción al «no se toca la configuración»).
- **§6 («El paso a paso»)**: en el paso 4 (extraer el almacén), añadir que, si el almacén está
  cifrado, hay que dejar la clave del respaldo (ya lo hace `recuperar` solo).
- **§7 («La configuración y el `STORAGE_ENCRYPTION_KEY`»)**: decir que `recuperar` **ya repone la
  clave automáticamente** (solo esa línea, sin tocar el resto del `.env`) y **verifica** que un
  documento se descifra; el aviso deja de ser «cópiala tú a mano».
- **§6, tras `odontocrm restaurar`**: añadir que `restaurar --from DIR --all --yes` **también**
  repone el almacén, reconcilia la clave y reinicia (antes era solo bases); con `--db <una>` o
  `--list` sigue tocando solo las bases.
- **§8 («Después de recuperar»)**, punto 2: añadir `sudo odontocrm purgar-prueba` a las
  comprobaciones si el respaldo venía de una máquina que tuvo las cuentas de prueba.

---

## 3. `infra/fedora/RUNBOOK.md` y `infra/windows/RUNBOOK.md`

- En la sección de **restaurar/recuperar**, añadir una nota: `restaurar … --all` repone también el
  almacén y su clave y reinicia; para el flujo completo está `recuperar`.
- Añadir a la lista de comandos el nuevo **`odontocrm purgar-prueba [--si]`** (quita las cuentas de
  prueba `recepcion`/`prueba`; por defecto las desactiva, con `--borrar` las elimina).
- Donde el RUNBOOK de Fedora recomienda el seed manual (`§5`, la receta
  `con-entorno identity -- node services/identity/dist/seed.js`), aclarar que **sin `--usuarios=`
  el seed siembra el juego completo** y que en el servidor se llama **con `--usuarios=admin`**
  (`30-desplegar.sh` ya lo hace así por defecto).

---

## 4. `docs/COMANDOS_PRODUCCION.md`

Añadir el subcomando nuevo a la tabla de `odontocrm`:

| Comando | Para qué |
| :--- | :--- |
| `sudo odontocrm purgar-prueba [--si] [--desactivar\|--borrar]` | Quita las cuentas de PRUEBA que el seed creaba (`recepcion` y el odontólogo de `clinic.ts`). Sin `--si` solo enseña qué haría; por defecto las desactiva. |

Y en la fila de `restaurar`, anotar que con `--all` repone **también** el almacén y su clave.

---

## 5. `infra/fedora/INSTALL.md` (§16.4 / §13.4) y `docs/SEGURIDAD_SECRETOS.md`

- `INSTALL.md` **§16.4** (y §13.4 del extracto manual): donde dice que la restauración **no**
  ejecuta migraciones ni extrae `storage`/config a mano, añadir que `odontocrm recuperar` y
  `odontocrm restaurar --all` **sí** reponen el almacén y **reconcilian la clave** solos, y que por
  eso ya no hay que copiar `STORAGE_ENCRYPTION_KEY` a mano.
- `SEGURIDAD_SECRETOS.md`: en la tabla de secretos, junto a `STORAGE_ENCRYPTION_KEY`, añadir que
  **debe ser la misma del respaldo** (la reconciliación al recuperar lo hace sola) y que el
  aprovisionador admite `--clave-almacen=<base64url>` para imponerla sin tocar el resto del `.env`.

---

## 6. ADR — decisión nueva (`docs/adr/0067-restaurar-repone-el-almacen.md`)

> Si el refactor del lobby (su pendiente propio) ya ocupó el `0066`, este es el `0067`; si no,
> ajústese al primer número libre.

- **Contexto.** Reimprimir un récipe lee el PDF **archivado** (no lo recompone, ADR 0036). Ese
  archivo vive cifrado en el almacén compartido. Restaurar solo las bases dejaba las filas
  apuntando a documentos ausentes o a archivos cifrados con una clave distinta (la instalación
  nueva genera otra): el sistema parecía sano y ningún documento se abría. Y el defecto de
  `30-desplegar.sh` sembraba cuentas de prueba en producción.
- **Decisión.**
  - `odontocrm restaurar --all` y `odontocrm recuperar` **repueblan el almacén** además de las
    bases, y **reconcilian `STORAGE_ENCRYPTION_KEY`** copiando la del respaldo a los `.env`
    (operación quirúrgica: solo esa línea, vía `aprovisionar.mjs --clave-almacen`).
  - Tras reponer, se **verifica en el acto** (`tools/verificar-almacen.mjs`): un archivo de muestra
    tiene que descifrarse, no basta con que los archivos estén.
  - El restaurar de **una** base (`--db`) o el listado (`--list`) **no** tocan el almacén ni los
    servicios: siguen siendo solo-bases.
  - El **defecto** del despliegue pasa a `admin`; el juego de desarrollo (`UI` de pruebas) es
    **opt-in** con `USUARIOS_SEED=all`.
  - Se añade `odontocrm purgar-prueba` para retirar cuentas de prueba ya sembradas (desactivar por
    defecto; borrar con `--borrar`).
- **Alternativas consideradas.** (a) Reescribir los `.env` enteros con el aprovisionador: descartado
  —recalcularía `WEB_ORIGIN`/nombre con los valores por defecto y rompería el CORS—; de ahí la
  operación quirúrgica. (b) Re-componer el PDF al reimprimir: descartado por el ADR 0036 (el
  documento se archiva). (c) Seguir dejando la clave a mano: descartado —es justo lo que se
  olvidaba y dejaba el historial ilegible—.
- **Consecuencias.** Un `restaurar --all` ahora **para y arranca servicios** (gestiona el ciclo,
  como `recuperar`). El simulacro de restauración también comprueba el almacén, así que un respaldo
  con la clave equivocada se detecta **antes** de necesitarlo.

---

## 7. Seguimiento (NO bloquea)

- `docs/PENDIENTE_DOC_REFACTOR_LOBBY_2026_10_13.md` (el del lobby) y este archivo se aplican en el
  **mismo** merge; el CHANGELOG lleva las **dos** entradas nuevas arriba.
- Valorar mover el `compgen … | head -1` de los `.env` a la librería si aparece un tercer sitio.

---

## 8. Contrato (por si se documenta aparte)

- `aprovisionar.mjs`: nueva opción `--clave-almacen=<base64url>`. Reescribe **solo** la línea
  `STORAGE_ENCRYPTION_KEY=` en `patients.env`, `clinical.env`, `billing.env` e `identity.env`
  (si existen), dejando una copia `.antes-de-<sello>` junto a cada uno. Valida que la clave
  decodifique a 32 bytes.
- `30-desplegar.sh` / `30-desplegar.ps1` / `instalar.sh` / `instalar.ps1`: `USUARIOS_SEED` vacío o
  ausente = **`admin`**; valor literal **`all`** = `admin` + `recepcion` + los odontólogos de
  `CLINIC.dentists`.
- `tools/verificar-almacen.mjs`: `--estado` (solo cuenta) · `--todos` (descifra todo) · sin banderas
  (muestra). Sale 1 si algún cifrado no se descifra.
- `tools/purgar-cuentas-prueba.mjs`: `--si` (hace) · `--desactivar` (por defecto) · `--borrar` ·
  `--forzar` · `--dry-run`. Se niega a tocar una cuenta cuyo `full_name` no sea el de la cuenta
  sembrada.
