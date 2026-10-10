# ADR 0060 — La configuración de la aplicación vive en la base y se edita desde un panel solo del admin

- **Fecha:** 2026-10-09 · **Estado:** aceptada
- **Relacionada:** [ADR 0054](0054-membrete-unico-en-los-imprimibles.md) (membrete único),
  [ADR 0055](0055-dos-tipografias-en-los-imprimibles.md) (dos tipografías),
  [ADR 0056](0056-la-identidad-del-consultorio-vive-en-la-base.md) (identidad en la base),
  [ADR 0058](0058-sin-datos-personales-en-el-codigo.md) (sin datos personales en el código),
  [ADR 0059](0059-el-sillon-es-el-recurso-de-la-agenda.md) (el sillón es el recurso),
  [ADR 0043](0043-se-descarta-el-enfoque-de-instalacion-actual.md) (una sola fuente de credenciales)

## Contexto

La puesta en marcha de un consultorio dejaba al descubierto varios ajustes que **solo se podían
cambiar editando el código o el `.env` del servidor** y recompilando o reiniciando:

- la **marca de los imprimibles** (paleta, tipografías, medidas y fuentes) vive en
  `packages/contracts/src/brand.ts` —solo-código— y se materializa en el CSS generado
  (`npm run marca:css`); cambiar un color exige `build:node + marca:css + build`, y las fuentes
  `.woff2` no se pueden subir desde la aplicación ([ADR 0054](0054-membrete-unico-en-los-imprimibles.md),
  [ADR 0055](0055-dos-tipografias-en-los-imprimibles.md));
- el **acento de la interfaz** está en `packages/ui/src/styles/tokens.css` (solo-código);
- los **textos de las pantallas** salen de `apps/web/src/lib/i18n.ts` (solo-código);
- los **tokens de Telegram y las credenciales de WhatsApp** viven en el `.env` de notificaciones,
  que solo escribe `aprovisionar.mjs` ([ADR 0043](0043-se-descarta-el-enfoque-de-instalacion-actual.md));
- la lista de **sillones** existe en la base ([ADR 0059](0059-el-sillon-es-el-recurso-de-la-agenda.md))
  pero no tenía interfaz de administración.

Con la identidad del consultorio ya viviendo en la base y editándose desde la aplicación
([ADR 0056](0056-la-identidad-del-consultorio-vive-en-la-base.md)), lo coherente es que **todo lo
configurable del consultorio** siga el mismo camino: se edita desde un panel, se guarda en la base y
se aplica sin recompilar ni reiniciar.

## Decisión

**La configuración de la aplicación vive en el servicio de identidad y se edita desde un panel
`/configuracion` que solo ve el `admin`.** Nace el permiso `settings:manage` (solo `admin`).

### 1. Dónde vive

Tres tablas **singleton** (`id = 1`) en la base de identidad, **vacías de arranque a propósito**:
mientras no haya fila, la configuración sale del respaldo del código (`BRAND`, `tokens.css`,
`i18n.ts`, el `.env`) y `fromDatabase` es `false`. Así una instalación recién migrada sigue con la
identidad de fábrica sin sembrar nada.

- **`brand_settings`** — paleta (13 colores en hex), tipografías y tamaños, medidas del membrete y
  las fuentes (referencias al almacén). El **logo** no está aquí: sigue en `clinic_profiles`
  ([ADR 0056](0056-la-identidad-del-consultorio-vive-en-la-base.md)).
- **`app_settings`** — el acento de la interfaz (uno de **diez presets** del espectro) y los **textos
  del kiosko** (un conjunto curado, no todo el diccionario).
- **`channel_settings`** — los datos no secretos de los canales y los **secretos cifrados**
  (`AES-256-GCM` con la clave del almacén, [mejora 4.B](../mejoras_resiliencia_postfase11.md)).

### 2. Cómo se aplica (en caliente)

La marca y el acento se sirven por **`GET /api/v1/settings`** (cualquier sesión) y la SPA los inyecta
en un `<style>` al arrancar: `--brand-*` (el MISMO CSS que el papel) y `--color-*` (el acento).

Los servicios de documentos (clinical, reporting, billing) **no** importan `BRAND`: leen la marca
efectiva por la ruta interna **`/internal/v1/identity/brand`** con el mismo patrón de caché y respaldo
que el membrete (`createBrandLookup`, [ADR 0056](0056-la-identidad-del-consultorio-vive-en-la-base.md)).
Si identity no responde, **se degrada a `BRAND`**: un fallo nunca deja un imprimible sin marca.

Las `@font-face` viajan ya resueltas (cada `.woff2` como `data:` URI) para que el PDF del servidor y lo
que imprime el navegador usen **los mismos archivos**.

Las **credenciales de canal** las lee notificaciones por su ruta interna
(`/internal/v1/identity/channels`) y **reconstruye sus adaptadores** cuando cambian, sin reiniciar: la
base manda y el `.env` queda de respaldo (si el panel borra un valor, se vuelve al archivo).

### 3. Qué NO entra

- **Los colores clínicos del odontograma** (rojo `pendiente` / azul `completado`): son un código del
  dominio, no una preferencia de marca.
- **La política de cancelación del paciente**: su tabla y su motor se quedan en notificaciones (la usa
  el bot); el panel la edita por su API. Con este ADR el permiso `scheduling:cancel_policy` deja de
  tenerlo el **odontólogo** —pasa a ser un ajuste de clínica del `admin`—; el titular lo conserva por
  su rol `admin`.

## Consecuencias

- **Cambiar la marca ya no exige recompilar.** `brand.ts` sigue siendo la **fuente del respaldo** y la
  paleta del odontograma; `marca.css` sigue generándose para la impronta previa a la sesión. Los
  documentos **ya emitidos** no se reescriben ([ADR 0036](0036-recipe-emitido-documento-archivado.md),
  [ADR 0048](0048-el-documento-de-cobro-se-archiva.md)): la marca nueva sale en lo que se componga
  **a partir de ahora**.
- **Los secretos de canal rompen parcialmente el [ADR 0043](0043-se-descarta-el-enfoque-de-instalacion-actual.md)**:
  siguen sin estar en el código, pero ahora viven **cifrados en la base** además de poder estar en el
  `.env`. La vista pública **nunca** los devuelve (solo `configured` y una pista); las credenciales en
  claro solo circulan por la red interna.
- **El panel es solo del `admin`** (`settings:manage`), coherente con «solo admin» para los ajustes que
  afectan a toda la clínica. La API lo vuelve a comprobar aunque la interfaz no pinte el módulo.
- **Todo cambio queda auditado** (`brand_updated`, `app_settings_updated`, `channel_settings_updated`);
  los valores secretos **no** se registran, solo qué campos se tocaron.
- La paleta de los imprimibles se edita **en hex libre** (el aviso de contraste es informativo, no
  bloquea): el papel se imprime sobre blanco y la identidad la decide el consultorio.
