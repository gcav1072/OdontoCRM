# Instalación e identidad del consultorio

> **Qué es este documento.** Cómo se pone OdontoCRM en marcha —en una máquina de desarrollo y
> en el servidor de la clínica— y, sobre todo, **cómo se introducen los datos personales del
> consultorio**: el nombre, los odontólogos con su MPPS, el RIF, el logo, los colores y las
> fuentes. Al terminar, el sistema y sus papeles dicen el nombre de **tu** consultorio, no el de
> otro.
>
> **Qué no es.** No es el manual del día a día (`docs/OPERACION_CLINICA.md`), ni la instalación
> del servidor paso a paso (`infra/fedora/INSTALL.md`, `infra/windows/INSTALL.md`), ni la lista
> de comandos (`docs/COMANDOS.md`). Aquí se enlazan, no se copian.

---

## 0. Las tres capas (y por qué se confunden)

«La identidad del consultorio» son en realidad **tres cosas distintas** que viven en sitios
distintos. Confundirlas es el origen de la mitad de las sorpresas:

| Capa | Qué es | Dónde vive | Se cambia con |
| :--- | :--- | :--- | :--- |
| **Datos del consultorio** | Nombre, razón social, dirección, teléfonos, RIF, correo, sitio web, **logo** y **los odontólogos que firman** (MPPS, especialidad, colegiatura) | `services/identity` (base de datos) — `packages/contracts/src/clinic.ts` es **semilla y respaldo** | Desde la aplicación (§2): el **titular** en su primer acceso, luego en **Mi perfil** y en `/usuarios` |
| **Marca de los documentos** | Paleta, **dos tipografías** (títulos y cuerpo) y medidas del membrete de los **imprimibles** (récipe, dossier, reporte, factura, historia clínica, odontograma) | `packages/contracts/src/brand.ts` → genera `packages/ui/src/styles/marca.css` | Editar + `npm run marca:css` + `npm run build` (**solo-código**) |
| **Tema de la pantalla** | Los colores del **cromo de la aplicación** (fondos, botones, estados, tema claro/oscuro) | `packages/ui/src/styles/tokens.css` | Editar y compilar la web |

- Los **datos** (capa 1) se editan **desde la aplicación** desde el ADR 0056. El código solo
  guarda la **semilla y el respaldo**: si no hay perfil en la base —una instalación recién
  migrada, la base caída—, el membrete sale con lo de `clinic.ts` y nada se rompe.
- La **marca** (capa 2) es la identidad **impresa**: siempre va sobre papel blanco, por eso no
  tiene variante oscura. Se edita **solo en el código** (los colores, las dos tipografías y las
  medidas del velo) y se mueve en pantalla y papel a la vez.
- El **tema** (capa 3) es el de la aplicación en pantalla, con su modo claro y oscuro.
- Lo que esté en `null` **no se imprime**. El récipe y los demás documentos nunca inventan un
  RIF ni un MPPS: si falta, sale el hueco (y `letterheadMissingFields()` enumera lo que falta).

---

## 1. Mapa: qué dato → dónde vive → quién lo edita

| Dato | Dónde vive | Quién lo edita | Dónde se nota |
| :--- | :--- | :--- | :--- |
| Nombre del consultorio | Perfil del consultorio (base) · respaldo `clinic.ts` → `name` | **Titular** (Mi perfil) · admin | Bot, `.ics`, pantallas de sala, membrete de **todos** los imprimibles |
| Razón social | Perfil del consultorio · `clinic.ts` → `legalName` | Titular · admin | Membrete de la factura, el recibo, la nota de crédito, el récipe y el dossier |
| Dirección y ciudad | Perfil del consultorio · `clinic.ts` → `address`, `city` | Titular · admin | Membrete de los imprimibles |
| Teléfonos y correo | Perfil del consultorio · `clinic.ts` → `phones`, `email` | Titular · admin | Membrete del récipe y las pantallas |
| RIF | Perfil del consultorio · `clinic.ts` → `rif` | Titular · admin | Membrete de los imprimibles y el párrafo del `.ics` |
| Sitio web | Perfil del consultorio · `clinic.ts` → `website` | Titular · admin | Membrete del récipe |
| **Odontólogos** (MPPS, especialidad, colegiatura, correo) | Perfil profesional (base) · respaldo `clinic.ts` → `dentists[]` | **Cada odontólogo** (Mi perfil) · admin (`/usuarios`) | Quién **firma** el récipe, el dossier y la historia |
| **Logo** (y marca de agua) | **Almacén** (`STORAGE_DIR`) · respaldo `assets/clinic/logo.svg` | **Titular** (Mi perfil) · admin | Membrete y velo en pantalla y papel |
| Paleta, **tipografías**, medidas del membrete y del velo | `brand.ts` → `palette`, `typography`, `fonts`, `letterhead` | **Solo código** | Colores, fuentes y medidas de los documentos impresos |
| Archivos de fuente (`.woff2`) | `assets/clinic/fonts/` (`BRAND.fonts`) | **Solo código** | La tipografía de los títulos y del cuerpo en papel y pantalla |
| Colores de la aplicación | `tokens.css` | Solo código | Todo el cromo de la interfaz (claro y oscuro) |

> **El logo aparece en dos sitios por una razón.** El perfil del consultorio dice **qué archivo**
> es el logo (el subido en el almacén) y `brand.ts` conserva la ruta del **respaldo** del
> repositorio (`assets/clinic/logo.svg`). El **mismo** logo hace de membrete y de **marca de
> agua**; lo que la marca fija son sus medidas (`--brand-watermark-width-mm`,
> `--brand-watermark-opacity`).

---

## 2. Los datos del consultorio — la aplicación (ADR 0056)

Se editan **desde la aplicación**, no desde el código.

### 2.1 El primer acceso (obligatorio)

Cuando se crea un usuario con rol `odontologo`, su **primer inicio de sesión** lo lleva a
`/completar-perfil`:

- **El titular** (el primer odontólogo creado, por antigüedad) completa **los datos del
  consultorio y los suyos**.
- **Los demás odontólogos** completan **solo los suyos**.

Hasta que lo hagan, el sistema **no los deja entrar a ningún módulo**: el servidor pone
`needsProfile` en el token (igual que `mustChangePassword`), el JWT **no lleva permisos** y el
gateway corta todo lo que no sea autenticación o identidad. No es una regla de la interfaz que
se pueda esquivar llamando a la API: es el mismo blindaje de la contraseña temporal.

Los campos que se piden:

| Del odontólogo | Del consultorio (solo el titular) |
| :--- | :--- |
| **MPPS** (obligatorio: sale en el récipe) | Nombre |
| **Especialidad** (obligatoria) | Dirección |
| Colegiatura o cédula profesional | RIF |
| Correo de contacto | Ciudad, teléfono y correo |
| | **Logo** (un **SVG**) |

### 2.2 Después: dos sitios, la misma regla

- **Mi perfil** (`/mi-perfil`, menú lateral): cada cuenta edita **lo suyo**; el titular edita
  además los datos del consultorio y vuelve a subir el logo.
- **`/usuarios`** (permiso `users:manage`): el **administrador** edita el perfil profesional de
  cualquier odontólogo desde «Editar usuario» (útil si alguien nunca entra).

En **ambos** sitios el **motivo es obligatorio** y el cambio queda en la **auditoría**
(`/auditoria`): acción, campos que cambiaron, el antes y el después, quién y cuándo. El **alta**
del primer acceso no pide motivo: es un alta, no un cambio.

### 2.3 `clinic.ts` sigue existiendo: es la semilla y el respaldo

`packages/contracts/src/clinic.ts` conserva el tipo `ClinicIdentity`, las ayudas de lectura
(`clinicFullAddress`, `clinicContactLine`, `clinicLeadDentist`, `clinicDentistFor`,
`letterheadMissingFields`) y **valores de ejemplo** que se usan cuando **no hay perfil guardado**:

- una instalación recién migrada (nadie ha completado el asistente todavía);
- una base inaccesible en el momento de componer un documento;
- las pruebas.

Es decir: **la aplicación manda**; el código solo evita que falte el papel. No hace falta
editarlo para poner el sistema con otro odontólogo.

**Lo que exige un membrete completo.** `letterheadMissingFields()` devuelve la lista de lo que
falta, en orden de importancia: nombre, dirección, RIF, teléfono, logo, y del **titular** el MPPS
y la especialidad. El editor del récipe **avisa antes de emitir** con esa misma lista.

**Varios odontólogos.** Añadir uno es crear su cuenta en `/usuarios` (o sembrarla, §6): en su
primer acceso completa lo suyo. El **titular** es quien llena el consultorio y quien firma por
defecto cuando un usuario que no está en la lista (una secretaria, un administrador) emite un
documento.

---

## 3. La marca de los documentos — `packages/contracts/src/brand.ts` (solo-código)

Reúne la paleta, **las dos tipografías** y las medidas del membrete. Tiene su propia sección
editable (`▼▼▼ EDITA AQUÍ ▼▼▼`). Cambiar un color aquí lo mueve **en pantalla y en papel a la
vez**, porque la interfaz y las plantillas del servidor leen del **mismo** sitio.

```ts
export const BRAND: Brand = {
  palette: { /* primary, primaryInk, accent, ink, inkStrong, … */ },
  typography: {
    uiSans: '…',                    // la interfaz en pantalla
    uiMono: '…',
    documentTitleSans: "'Montserrat', …",  // TÍTULOS (nombre, «RÉCIPE», encabezados)
    documentBodySans: "'Montserrat', …",   // CUERPO (párrafos, tablas, notas)
    documentTitlePt: 13,            // tamaños en pt; cuerpo 9; menudo 7,5
    documentBodyPt: 9,
    documentSmallPt: 7.5,
  },
  fonts: {                          // las fuentes que el papel y la pantalla incrustan
    family: 'Montserrat',
    files: [
      { path: 'assets/clinic/fonts/montserrat-latin-400-normal.woff2', weight: 400, style: 'normal' },
      { path: 'assets/clinic/fonts/montserrat-latin-700-normal.woff2', weight: 700, style: 'normal' },
    ],
  },
  letterhead: { logoHeightMm: 18, watermarkWidthMm: 90, watermarkOpacity: 0.1 },
  logoPath: 'assets/clinic/logo.svg',       // respaldo si no hay logo subido
  watermarkPath: 'assets/clinic/logo.svg',  // respaldo del velo
};
```

**Las dos tipografías** (ADR 0055). `--brand-font-doc-title` la aplican los títulos (la clase
`.brand-title` y las cabeceras de cada plantilla) y `--brand-font-doc-body` el `body`. En
`assets/clinic/fonts/` viven los `.woff2` **auto-hospedados** (subconjunto `latin`, que cubre el
español) con su licencia OFL.

- El **servidor** los incrusta en el PDF como `@font-face` con `data:` URI: el documento
  archivado no depende de las fuentes del equipo.
- La **SPA** los carga al arrancar (`apps/web/src/lib/fuentes.ts`, con `import.meta.glob`), así
  que la historia clínica y el odontograma que imprime el navegador salen con la misma familia.
- Cambiar de familia: dejar los `.woff2` en esa carpeta, ajustar `BRAND.fonts.files` y los dos
  primeros nombres de las pilas.

**La marca de agua** es el **logo efectivo** (el subido, o el del repositorio), centrado y
translúcido, detrás del contenido de **todos** los imprimibles. Se repite en cada hoja. **Su
ancho y su opacidad son de la marca** (`brand.ts`): el titular cambia el logo, no el velo.

### Regenerar el CSS de la web (`npm run marca:css`)

La SPA **no** puede importar TypeScript como hoja de estilo, así que la marca se copia a un
`.css` **generado**: `packages/ui/src/styles/marca.css`. Ese archivo **no se edita a mano**.
Después de tocar `brand.ts`:

```bash
npm run build:node    # compila los contratos (de donde `marca:css` lee la marca)
npm run marca:css     # reescribe packages/ui/src/styles/marca.css
npm run build         # recompila todo (los servicios y la web)
```

- `npm run marca:css -- --check` **no escribe**: falla si el CSS quedó desfasado. Es lo que corre
  la puerta de calidad.
- La prueba `packages/contracts/src/brand.test.ts` **denuncia** si alguien cambia `brand.ts` y no
  regenera el CSS, o si un archivo de fuente declarado no existe. Olvidarse de `marca:css` no
  pasa desapercibido: `npm run verify` lo corta.
- **Cambiar la marca no toca la base ni los documentos ya emitidos.** Los récipes, facturas y
  reportes **archivados** conservan el PDF con el que se emitieron
  ([ADR 0036](adr/0036-recipe-emitido-documento-archivado.md),
  [ADR 0048](adr/0048-el-documento-de-cobro-se-archiva.md)): la marca nueva sale en lo que se
  componga **de ahora en adelante**.

---

## 4. El logo — la aplicación (y `assets/clinic/logo.svg` de respaldo)

**El logo del consultorio se sube desde la aplicación** (Mi perfil, solo el titular; o `/usuarios`,
el admin): un **SVG**. Se guarda en el **almacén compartido** (`STORAGE_DIR`: `./storage/patients`
en desarrollo, `/var/lib/odontocrm/storage` en el servidor), de modo que **persiste igual en
desarrollo y en producción**, y se sirve:

- incrustado como `data:` URI en los PDF del servidor (el papel no depende de rutas);
- por la interfaz, que lo pinta en el membrete en pantalla y como marca de agua al imprimir.

**El respaldo** sigue siendo [`assets/clinic/logo.svg`](../assets/clinic/README.md): se usa
mientras no se haya subido ninguno. Las **mismas** condiciones del archivo valen para el que se
sube —el logo del membrete va sobre papel blanco— y están explicadas en
[`assets/clinic/README.md`](../assets/clinic/README.md):

- **monocromo** y con el relleno **incrustado** (`fill="#14504d"`, el verde-teal de la marca);
- **fondo transparente** y **solo `viewBox`** (sin `width`/`height`): el alto lo fija la marca;
- **texto convertido a trazados**.

| Quiero… | Qué hago | ¿Recompilo? |
| :--- | :--- | :--- |
| **Cambiar el logo** (lo normal) | Subir el SVG en **Mi perfil** (titular) o en `/usuarios` (admin) | **No** |
| **Quitar el logo** | Dejar el respaldo de `clinic.ts` con `logoPath: null` (el subido se puede sustituir) | No para el servidor; sí para la web |
| **Cambiar el respaldo del repositorio** | Reemplazar `assets/clinic/logo.svg` (mismo nombre) | No para los PDF; sí recompilar la web (Vite copia el binario) |

---

## 5. El tema de la pantalla — `packages/ui/src/styles/tokens.css`

Es el **cromo** de la aplicación: fondos, superficies, bordes, texto, botones, estados y el tema
claro/oscuro, declarados dentro de `@theme`. El tema oscuro solo reasigna nombres bajo la clase
`.dark`.

- **No es lo mismo que la marca.** El tema es de pantalla y tiene modo oscuro; la marca es
  impresa y siempre va sobre papel blanco.
- **Cambiar el color principal de la aplicación** se hace aquí (`--color-primary` y sus
  compañeros, en claro y en oscuro). Es un cambio de **interfaz**: no afecta a ningún PDF.
- Los **colores clínicos** del odontograma (rojo `pendiente`, azul `completado`) **no** salen de
  aquí: son un código del dominio (`CLINICAL_STATE_COLORS`) y no se tocan con la paleta.

---

## 6. Las cuentas del personal — `npm run seed:users`

En **desarrollo** se siembran `admin`, `recepcion` y **una cuenta por odontólogo** de
`CLINIC.dentists` (la semilla del código: usuario, clave y nombre; **ni MPPS ni especialidad**,
esos los completa cada uno en su primer acceso). Es **idempotente**.

```bash
npm run seed:users                 # siembra todas las cuentas (desarrollo)
npm run seed:users -- --print      # recuerda las claves y si siguen valiendo; no escribe nada
npm run seed:users -- --reset      # las devuelve a la temporal (limpia bloqueos e intentos)
```

- **En producción el servidor crea solo `admin`.** El resto del personal se da de alta desde
  `/usuarios` (permiso `users:manage`), que es donde tiene sentido decidir roles.
- La contraseña nace **temporal**: el primer acceso obliga a cambiarla; **después** se pide el
  perfil profesional (el gate de §2.1). Hasta entonces, ningún módulo responde.
- **Cambiar de odontólogo** es dar de alta su cuenta y dejar que complete su perfil. Quitar uno
  **no borra** su cuenta (para eso, desactívala en `/usuarios`).

---

## 7. Sobrescritura por entorno (sin tocar la aplicación)

Tres variables siguen existiendo, pero **cambian de papel**: ahora son el **ajuste puntual** que
**gana** sobre lo guardado (precedencia **entorno > base de datos > `CLINIC`**):

```bash
CLINIC_NAME=Consultorio - Od. Erika Gómez
CLINIC_ADDRESS=Av. Luis del Valle García, C.E. Nueva Esparta, Planta Baja, Local 1-2
CLINIC_EMAIL=citas@odontocrm.local
```

Están en [`.env.example`](../.env.example) y en el `.env` de cada servicio.

> **Ojo con su alcance.** Estas tres variables **solo** las leen `notifications`, `scheduling` y
> `screens` —los que componen el texto del bot, el `.ics` y el encabezado de las pantallas—, que
> refrescan sus valores con lo de la base al arrancar (y cada pocos minutos) salvo que la variable
> esté puesta. **No** afectan al récipe, el dossier, el reporte, la factura ni a la interfaz: esos
> leen la identidad de la base. Los **odontólogos y su MPPS** y el **logo** no se pueden cambiar
> por entorno: se editan en la aplicación (§2).

`IDENTITY_URL` (por defecto `http://127.0.0.1:4001`) es la lectura interna del membrete para los
servicios que componen documentos y para los avisos; en loopback ya funciona sin configurar nada.

---

## 8. Pila de desarrollo — paso a paso

La puesta en marcha completa está en el [README](../README.md#puesta-en-marcha-desarrollo). Aquí
va **solo** lo de la identidad:

```powershell
# 1) Arrancar y sembrar las cuentas
npm run build
npm run seed:users
npm run stack:dev          # (o stack:fijo)

# 2) Entrar con el odontólogo: /completar-perfil pide sus datos y, si es el titular, los del consultorio
#    (o entrar como admin y editarlos en /usuarios)

# 3) Solo si cambias la MARCA (colores, tipografías, medidas): sigue siendo código
code packages/contracts/src/brand.ts
npm run build:node && npm run marca:css && npm run build
```

Comprobación rápida:

```powershell
npm run seed:users -- --print        # ¿aparecen los odontólogos?
curl http://127.0.0.1:8090/health    # el gateway responde
```

> **Ya no hace falta recompilar para cambiar los datos del consultorio.** Se editan en la
> aplicación. Recompilar es solo para la **marca** (§3), que vive en el código.

---

## 9. Pila de producción — paso a paso

### 9.0 Poner los datos del consultorio

**Se hace en la aplicación**, no en el servidor:

1. Entrar como **administrador** (la cuenta que crea la instalación).
2. Dar de alta al **odontólogo titular** en `/usuarios` con el rol `odontologo` (su usuario y su
   clave temporal).
3. Ese odontólogo entra: cambia la contraseña y completa el asistente (**titular**: consultorio +
   logo + sus datos). El resto del personal completa lo suyo al entrar.

No hay que tocar el repositorio, ni recompilar, ni reiniciar.

> Si prefieres sembrar la cuenta del titular desde la línea de comandos (el servidor en producción
> exige la clave por variable y no admite las de desarrollo):
>
> ```bash
> sudo SEED_PASSWORD_EGOMEZ='una-clave-de-10-o-mas' \
>   odontocrm con-entorno identity -- node services/identity/dist/seed.js --reset --usuarios=egomez
> ```

### 9.1 Cambiar la **marca** (colores, tipografías, medidas): sigue siendo código

En la máquina de trabajo, sobre la copia del repositorio desde la que se despliega:

```bash
$EDITOR packages/contracts/src/brand.ts     # paleta, tipografías, medidas del velo
npm run build:node && npm run marca:css
npm run build
git commit -am "marca: nueva paleta del consultorio"
git push origin <rama-de-despliegue>
```

Y en el **servidor** (`/opt/odontocrm` en Fedora, `C:\OdontoCRM` en Windows):

```bash
sudo odontocrm actualizar        # trae el código, compila, migra y reinicia
```

> ¿Por qué la marca sigue en el código? Porque la ven **pantalla y papel a la vez** y conviene
> que quede en el control de versiones, revisada y con vuelta atrás. La **identidad** (los datos)
> no: esa cambia por motivos de consultorio y la edita quien los conoce.

### 9.2 Ajuste puntual por entorno (sin compilar)

Solo el **nombre, la dirección y el correo**, y solo para el bot, el `.ics` y las pantallas (§7).
Se añaden al entorno del servicio, no al del sistema:

```bash
# Fedora: /etc/odontocrm/odontocrm.env  (común a todos los servicios)
CLINIC_NAME=Consultorio - Od. Fulano de Tal
CLINIC_ADDRESS=Calle Real, Local 3, Puerto La Cruz

sudo systemctl restart 'odontocrm@*' odontocrm-gateway    # que lo lean
```

```powershell
# Windows: C:\ProgramData\OdontoCRM\env\odontocrm.env
# y reiniciar los servicios
odontocrm reiniciar
```

### 9.3 Los papeles que ya salieron

Cambiar la identidad **no reescribe** los récipes, facturas, reportes ni expedientes **ya
emitidos**: cada uno se archivó con el PDF y los datos con los que se compuso
([ADR 0036](adr/0036-recipe-emitido-documento-archivado.md),
[ADR 0048](adr/0048-el-documento-de-cobro-se-archiva.md)). La identidad nueva sale en todo lo que
se componga **a partir de ahora**. Es lo correcto: un documento entregado no se reimprime solo
porque el consultorio cambió de nombre.

---

## 10. Verificación

| Qué | Cómo |
| :--- | :--- |
| El odontólogo completó su perfil | `/mi-perfil` lo muestra; si falta, el sistema no deja entrar a los módulos |
| Al membrete no le falta nada | El aviso del editor del récipe antes de emitir (`letterheadMissingFields()`) |
| Cada cambio de identidad queda trazado | `/auditoria`: acción, antes/después, actor y motivo |
| El logo se subió y persiste | Mi perfil (titular) o `/usuarios`; se ve en el membrete y como marca de agua |
| El CSS de la marca está al día | `npm run marca:css -- --check` |
| La marca y las fuentes no se desfasaron | `npm test` (corre `brand.test.ts`, que también comprueba que los `.woff2` existen) |
| Todo el repositorio sigue sano | `npm run verify` (secretos + lint + formato + tipos + build + pruebas) |
| El membrete sale en el papel | Emitir un **récipe**: logo, nombre, RIF, teléfonos y el MPPS del firmante, con las dos tipografías |

---

## 11. Los colores de **énfasis** salen de la marca; el rojo y el azul clínicos, no

Los documentos imprimibles pintan sus **colores de énfasis** —títulos, encabezados de tabla,
líneas, contornos y tinta— con las variables de la **marca** (`--brand-*`), así que cambiar
`brand.ts` los mueve en **todos** los imprimibles a la vez: el récipe y el dossier (clinical), el
reporte (reporting), la factura/recibo/nota (billing), y la historia clínica y el odontograma que
imprime el navegador.

Lo que **no** cambia con la paleta, y no es un olvido:

| Color | Dónde | Por qué se queda |
| :--- | :--- | :--- |
| Rojo `pendiente` y azul `completado` | `CLINICAL_STATE_COLORS` (odontograma, servidor y navegador) | Es un **código clínico**: el odontólogo lee «por hacer» y «hecho», no decoración |
| Pantalla de carga/error | `apps/web/src/main.tsx` y el arranque de `index.html` | Se pintan **antes** de que exista la hoja de estilos; no pueden leer variables |
| Fondo blanco al imprimir | `apps/web/src/index.css` (`@media print`) | El papel es blanco aunque la pantalla esté en modo oscuro |
| Cifras de respaldo de las gráficas de reportes | `ReportChart.tsx` (`RESPALDO`) | Solo se usan si el DOM no está disponible; en la aplicación leen las variables CSS |
| Paleta oscura del **cromo** de la app | `tokens.css` (tema claro/oscuro) | Es la capa del **tema** de pantalla, no la de la marca impresa |

Conclusión: **no hace falta «deshardcodear» nada** para re-tematizar. El **énfasis** de los
documentos sale de `brand.ts` y el cromo de la pantalla de `tokens.css`; los pocos valores fijos
que quedan son un código de dominio (el rojo/azul clínico) o de arranque (la pantalla de carga),
no duplicados de la paleta.

---

## 12. Errores comunes

| Síntoma | Causa | Arreglo |
| :--- | :--- | :--- |
| «Completa tu perfil profesional antes de usar el sistema» | El odontólogo no pasó por el asistente | Entrar: el sistema lleva a `/completar-perfil`; o el admin lo rellena en `/usuarios` |
| El odontólogo no puede entrar a ningún módulo | Es lo esperado: `needsProfile` blinda el sistema igual que la contraseña temporal | Completar el perfil (§2.1) |
| El membrete sale con los datos viejos tras editarlos | La caché del membrete (60 s) o la del navegador | Esperar un minuto y recargar; en los PDF sale en la siguiente emisión |
| El récipe sale con el membrete del **código** y no el de la aplicación | No hay perfil guardado (nadie completó el asistente), o identity no respondió | Completar el perfil; revisar que `identity` esté arriba |
| El récipe sale sin MPPS o sin especialidad | El titular no completó su perfil profesional | Completarlo en Mi perfil (`letterheadMissingFields` lo enumera) |
| El logo subido no aparece | Se subió antes de guardar los datos del consultorio, o no es un SVG | Volver a subirlo desde Mi perfil (solo SVG) |
| El membrete de la **pantalla** cambió de color pero el **papel** no (o al revés) | Tocaste `tokens.css` y no `brand.ts` (o al revés) | Son dos capas distintas: cambia la que corresponda (§0) |
| El color o la tipografía nuevos se ven en unos documentos y en otros no | Cambiaste `brand.ts` y **no** regeneraste `marca.css` (o no recompilaste la web) | `npm run build:node && npm run marca:css && npm run build` |
| `npm test` falla en `brand.test.ts` | Cambiaste `brand.ts` sin regenerar el CSS, o falta un `.woff2` declarado | `npm run marca:css` / poner el archivo |
| Los títulos salen con la fuente del sistema | Falta el `.woff2` en `assets/clinic/fonts/` o no recompilaste la web | Reponer el archivo y recompilar la web |
| `CLINIC_NAME` del `.env` «no hace nada» en el récipe | Solo lo leen bot, `.ics` y pantallas | Para el récipe y la interfaz, edítalo en la aplicación (§2) |

---

## Documentación relacionada

- [Instalación del servidor · Fedora](../infra/fedora/INSTALL.md) · [Windows](../infra/windows/INSTALL.md)
- [Ilustración y operación diaria del consultorio](OPERACION_CLINICA.md)
- [Comandos de desarrollo](COMANDOS.md) · [Comandos de producción](COMANDOS_PRODUCCION.md)
- [Logo del consultorio](../assets/clinic/README.md)
- [El membrete, el logo y la marca de agua son los mismos en todos los imprimibles](adr/0054-membrete-unico-en-los-imprimibles.md)
- [Los imprimibles tienen dos tipografías: títulos y cuerpo](adr/0055-dos-tipografias-en-los-imprimibles.md)
- [La identidad del consultorio vive en la base de datos](adr/0056-la-identidad-del-consultorio-vive-en-la-base.md)
