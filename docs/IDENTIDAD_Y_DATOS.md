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
| **Datos del consultorio** | Nombre, dirección, teléfonos, RIF, correo, sitio web, logo y **los odontólogos que firman** (MPPS, especialidad) | `packages/contracts/src/clinic.ts` | Editar + `npm run build` (y `seed:users` si cambió un odontólogo) |
| **Marca de los documentos** | Paleta, tipografías y medidas del membrete de los **imprimibles** (récipe, dossier, reporte, factura, historia clínica, odontograma) | `packages/contracts/src/brand.ts` → genera `packages/ui/src/styles/marca.css` | Editar + `npm run marca:css` + `npm run build` |
| **Tema de la pantalla** | Los colores del **cromo de la aplicación** (fondos, botones, estados, tema claro/oscuro) | `packages/ui/src/styles/tokens.css` | Editar y compilar la web |

- La **marca** (capa 2) es la identidad **impresa**: siempre va sobre papel blanco, por eso no
  tiene variante oscura. El **tema** (capa 3) es el de la aplicación en pantalla, con su modo
  claro y oscuro. Comparten unos pocos nombres (tinta, tipografía base) a propósito.
- Los **datos** (capa 1) alimentan a las otras dos: el membrete del papel y el encabezado de las
  pantallas muestran el nombre y el logo que estén en `clinic.ts`.
- Lo que esté en `null` **no se imprime**. El récipe y los demás documentos nunca inventan un
  RIF ni un MPPS: si falta, sale el hueco (y `letterheadMissingFields()` enumera lo que falta).

---

## 1. Mapa: qué dato → dónde vive → dónde se nota

| Dato | Archivo (sección editable) | Dónde se ve |
| :--- | :--- | :--- |
| Nombre del consultorio | `clinic.ts` → `name` | Bot, `.ics`, pantallas de sala, y el membrete de **todos** los imprimibles |
| Razón social | `clinic.ts` → `legalName` | Membrete de la factura, el recibo, la nota de crédito, el récipe y el dossier |
| Dirección y ciudad | `clinic.ts` → `address`, `city` | Membrete de los imprimibles |
| Teléfonos y correo | `clinic.ts` → `phones`, `email` | Membrete del récipe y las pantallas |
| RIF | `clinic.ts` → `rif` | Membrete de los imprimibles y el párrafo del `.ics` |
| Sitio web | `clinic.ts` → `website` | Membrete del récipe |
| **Odontólogos** (usuario, nombre, **MPPS**, especialidad, colegiatura, correo) | `clinic.ts` → `dentists[]` | Quién **firma** el récipe, el dossier y la historia; y **las cuentas** de `seed:users` |
| Ruta del logo | `clinic.ts` → `logoPath` (**y** `brand.ts` → `logoPath`) | Logo del membrete en pantalla y en papel |
| Paleta y tipografías | `brand.ts` → `palette`, `typography` | Colores y fuentes de los documentos impresos |
| Medidas del membrete y la marca de agua | `brand.ts` → `letterhead` | Alto del logo, ancho y opacidad de la marca de agua |
| Ruta de la marca de agua | `brand.ts` → `watermarkPath` | El velo del logo detrás de cada hoja de los imprimibles |
| Colores de la aplicación | `tokens.css` | Todo el cromo de la interfaz (claro y oscuro) |

> **El logo aparece en dos sitios por una razón.** `clinic.ts` dice **qué archivo** es el logo
> (para el membrete) y `brand.ts` tiene su propia ruta y la de la **marca de agua** (para el
> papel). En la práctica apuntan al **mismo** archivo, `assets/clinic/logo.svg`. Cambiar de logo
> es **reemplazar el archivo**: no hay que tocar código.

---

## 2. Los datos del consultorio — `packages/contracts/src/clinic.ts`

Es **el único archivo que hay que editar para poner el sistema con otro odontólogo**. Tiene una
sección marcada `▼▼▼ EDITA AQUÍ ▼▼▼`. Los campos:

```ts
export const CLINIC: ClinicIdentity = {
  name: 'Consultorio - Od. Erika Gómez',   // el que se imprime y se dice por el bot
  legalName: null,                          // razón social, si el récipe la lleva aparte
  address: 'Av. Luis del Valle García, …',  // una línea
  city: null,                               // se añade a la dirección si quieres
  phones: [],                               // como deben leerse en el papel
  email: 'citas@odontocrm.local',
  rif: null,                                // «J-12345678-9», con o sin guiones
  website: null,
  logoPath: 'assets/clinic/logo.svg',       // ruta relativa a la raíz del repositorio
  dentists: [
    {
      username: 'egomez',                   // usuario con el que entra al sistema
      fullName: 'Od. Erika Gómez',          // como sale impreso
      mpps: null,                           // OBLIGATORIO en el récipe
      specialty: null,                      // «Odontología general», «Endodoncia»…
      licenseNumber: null,                  // colegiatura o cédula profesional, si se usa
      email: null,
    },
  ],
};
```

**Lo que exige un membrete completo.** `letterheadMissingFields()` devuelve la lista de lo que
falta, en orden de importancia: nombre, dirección, RIF, teléfono, logo, y del **titular**
(el primer odontólogo) el MPPS y la especialidad. El editor del récipe **avisa antes de emitir**
con esa misma lista, así que se ve en el momento, no cuando el papel ya está impreso.

**Varios odontólogos.** Añadir uno más a `dentists[]` basta: `npm run seed:users` le crea su
cuenta. El **primero** de la lista es el titular, y es quien firma por defecto cuando un usuario
que no está en la lista (una secretaria, un administrador) emite un documento.

---

## 3. La marca de los documentos — `packages/contracts/src/brand.ts`

Reúne la paleta, las tipografías y las medidas del membrete. Tiene su propia sección editable
(`▼▼▼ EDITA AQUÍ ▼▼▼`). Cambiar un color aquí lo mueve **en pantalla y en papel a la vez**, porque
la interfaz y las plantillas del servidor leen del **mismo** sitio.

```ts
export const BRAND: Brand = {
  palette: {
    primary: '#14504d',      // títulos y encabezados
    primaryInk: '#ffffff',   // texto sobre `primary`
    accent: '#1f6f6b',       // reglas finas del membrete
    ink: '#17202a',          // texto de cuerpo
    // … inkStrong, inkMuted, inkSubtle, line, lineSoft, tableHeadBg, good, warn, bad
  },
  typography: {
    uiSans: "…",             // la interfaz en pantalla
    uiMono: "…",
    documentSans: "'Segoe UI', …",  // los documentos del servidor
    documentTitlePt: 13,     // título (pt); cuerpo 9; menudo 7,5
    documentBodyPt: 9,
    documentSmallPt: 7.5,
  },
  letterhead: {
    logoHeightMm: 18,        // alto del logo en el membrete
    watermarkWidthMm: 90,    // ancho de la marca de agua
    watermarkOpacity: 0.1,   // opacidad del velo (0–1)
  },
  logoPath: 'assets/clinic/logo.svg',
  watermarkPath: 'assets/clinic/logo.svg',
};
```

**La marca de agua** es el logo del consultorio, centrado y translúcido, detrás del contenido de
**todos** los imprimibles. Se repite en cada hoja. Si el archivo no está, el documento sale sin
velo (no rompe nada). Para quitarla de un documento concreto, se deja de llamar a
`brandWatermarkHtml(...)` en su plantilla.

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
  regenera el CSS. Olvidarse de `marca:css` no pasa desapercibido: `npm run verify` lo corta.
- **Cambiar un color no toca la base de datos ni los documentos ya emitidos.** Los récipes,
  facturas y reportes **archivados** conservan el PDF con el que se emitieron
  ([ADR 0036](adr/0036-recipe-emitido-documento-archivado.md),
  [ADR 0048](adr/0048-el-documento-de-cobro-se-archiva.md)): la marca nueva sale en lo que se
  componga **de ahora en adelante**.

---

## 4. El logo — `assets/clinic/logo.svg`

Se deja en [`assets/clinic/`](../assets/clinic/README.md). Vale un **SVG** (recomendado) o un
**PNG/JPG**. Requisitos del SVG, explicados en
[`assets/clinic/README.md`](../assets/clinic/README.md):

- **monocromo** y con el relleno **incrustado** (`fill="#14504d"`, el verde-teal de la marca);
- **fondo transparente** y **solo `viewBox`** (sin `width`/`height`): el alto lo fija la marca;
- **texto convertido a trazados** (que se vea igual en cualquier equipo).

**Dos formas de cambiar el logo, y no son lo mismo:**

| Quiero… | Qué hago | ¿Recompilo? |
| :--- | :--- | :--- |
| **Cambiar la imagen** | Reemplazar `assets/clinic/logo.svg` por el archivo nuevo (mismo nombre) | **No** para los PDF del servidor (leen el archivo al componer); sí recompilar la web para que Vite copie el nuevo binario |
| **Cambiar la ruta o el formato** | Editar `logoPath` en `clinic.ts` **y** en `brand.ts` (y `watermarkPath`) | **Sí** (`npm run build`; y `marca:css` si tocaste `brand.ts`) |
| **Quitar el logo** | Dejar `logoPath: null` en `clinic.ts` | Sí |

El servidor incrusta el logo en el PDF como `data:` URI (el papel no depende de rutas al
abrirse) y la SPA lo resuelve con Vite (`import.meta.glob` sobre `assets/clinic/*`). En los dos
casos es **el mismo archivo**.

---

## 5. El tema de la pantalla — `packages/ui/src/styles/tokens.css`

Es el **cromo** de la aplicación: fondos, superficies, bordes, texto, botones, estados y el tema
claro/oscuro, declarados dentro de `@theme` (Tailwind genera las utilidades y las variables CSS a
la vez). El tema oscuro solo reasigna nombres bajo la clase `.dark`.

- **No es lo mismo que la marca.** El tema es de pantalla y tiene modo oscuro; la marca es
  impresa y siempre va sobre papel blanco.
- **Cambiar el color principal de la aplicación** se hace aquí (`--color-primary` y sus
  compañeros, en claro y en oscuro). Es un cambio de **interfaz**: no afecta a ningún PDF.
- Los **colores clínicos** del odontograma (rojo `pendiente`, azul `completado`) **no** salen de
  aquí: son un código del dominio (`CLINICAL_STATE_COLORS`) y no se tocan con la paleta.

---

## 6. Las cuentas del personal — `npm run seed:users`

Las cuentas nacen de la sección del consultorio: **una por odontólogo** de `CLINIC.dentists`,
más `admin` y `recepcion` en desarrollo. Es **idempotente**: correrlo de nuevo no duplica nada.

```bash
npm run seed:users                 # siembra todas las cuentas (desarrollo)
npm run seed:users -- --print      # recuerda las claves y si siguen valiendo; no escribe nada
npm run seed:users -- --reset      # las devuelve a la temporal (limpia bloqueos e intentos)
```

- **En producción el servidor crea solo `admin`.** El resto del personal se da de alta desde
  `/usuarios` (permiso `users:manage`), que es donde tiene sentido decidir roles. Si además
  quieres sembrar un odontólogo, mira §9.
- La contraseña nace **temporal**: el primer acceso obliga a cambiarla. Hasta entonces, ningún
  módulo responde (es una regla del servidor, no de la interfaz).
- **Cambiar de odontólogo** es editar `dentists[]` y volver a sembrar: se crea la cuenta nueva.
  Quitar uno de la lista **no borra** su cuenta (para eso, desactívala en `/usuarios`).

---

## 7. Sobrescritura por entorno (sin recompilar)

Tres variables sustituyen los valores por defecto **sin tocar el código**:

```bash
CLINIC_NAME=Consultorio - Od. Erika Gómez
CLINIC_ADDRESS=Av. Luis del Valle García, C.E. Nueva Esparta, Planta Baja, Local 1-2
CLINIC_EMAIL=citas@odontocrm.local
```

Están en [`.env.example`](../.env.example) y en el `.env` de cada servicio.

> **Ojo con su alcance.** Estas tres variables **solo** las leen `notifications`, `scheduling` y
> `screens` —los que componen el texto del bot, el `.ics` y el encabezado de las pantallas—.
> **No** afectan al récipe, el dossier, el reporte, la factura ni a la interfaz: esos leen
> `CLINIC` directamente. Es decir, sirven para un ajuste puntual del aviso, **no** para
> renombrar el consultorio en todo el sistema. Los **odontólogos y su MPPS** y el **logo** ni
> siquiera se pueden cambiar por entorno: están en el código (§2 y §4).

---

## 8. Pila de desarrollo — paso a paso

La puesta en marcha completa del entorno de desarrollo está en el
[README](../README.md#puesta-en-marcha-desarrollo). Aquí va **solo** la parte de los datos:

```powershell
# 1) Editar los datos del consultorio
code packages/contracts/src/clinic.ts

# 2) Si además cambian los colores, fuentes o medidas (marca impresa):
code packages/contracts/src/brand.ts
npm run build:node      # compila los contratos (de donde `marca:css` lee la marca)
npm run marca:css       # reescribe packages/ui/src/styles/marca.css

# 3) Recompilar (los servicios y la web leen el paquete compilado)
npm run build

# 4) Si añadiste o cambiaste un odontólogo, siembra sus cuentas
npm run seed:users

# 5) Reiniciar la pila si ya estaba corriendo
npm run stack:status       # ¿qué hay corriendo?
npm run stack:dev          # (o stack:fijo) vuelve a levantar con lo nuevo
```

Comprobación rápida de que se aplicó:

```powershell
npm run seed:users -- --print        # ¿aparecen los odontólogos nuevos?
curl http://127.0.0.1:8090/health    # el gateway responde
```

> **En desarrollo, `npm run build` es obligatorio.** Un servicio corre desde `dist/`, así que
> editar `clinic.ts` y no compilar deja el membrete viejo hasta que se recompile y reinicie.

---

## 9. Pila de producción — paso a paso

> **La vía canónica es editar en el repositorio y desplegar.** Los datos del consultorio cambian
> una vez cada varios años: se editan en tu copia del proyecto, se compilan y se despliegan. Las
> otras dos vías son atajos con letra pequeña.

### 9.0 La vía canónica (A): editar en el repositorio y desplegar

En la máquina de trabajo, sobre la copia del repositorio **desde la que se despliega el servidor**
(la rama que `odontocrm actualizar` trae):

```bash
# 1) Editar los datos (y la marca, si cambian colores/fuentes)
$EDITOR packages/contracts/src/clinic.ts
#    y/o:  $EDITOR packages/contracts/src/brand.ts

# 2) Compilar en local y dejar los artefactos listos
npm run build:node && npm run marca:css    # solo si tocaste brand.ts
npm run build

# 3) Publicar el cambio para que el servidor lo traiga
git commit -am "compra: identidad del consultorio XYZ"
git push origin <rama-de-despliegue>
```

Y en el **servidor** (`/opt/odontocrm` en Fedora, `C:\OdontoCRM` en Windows):

```bash
sudo odontocrm actualizar        # trae el código, compila, migra y reinicia
```

Si **añadiste o cambiaste un odontólogo**, siembra su cuenta (el servidor en producción exige la
clave por variable y no admite las de desarrollo):

```bash
sudo SEED_PASSWORD_EGOMEZ='una-clave-de-10-o-mas' \
  odontocrm con-entorno identity -- node services/identity/dist/seed.js --reset --usuarios=egomez
```

> ¿Por qué la canónica? Porque deja la identidad **en el control de versiones**: se revisa, se
> prueba y se puede volver atrás. Y porque `odontocrm actualizar` hace `git` sobre el directorio
> del código: una edición hecha a mano **en el servidor** se pierde en el siguiente `actualizar`
> (por eso existe la vía B).

### 9.1 Vía B: editar en el servidor (escape, sin `actualizar`)

Para un retoque urgente, sin pasar por el repositorio. En el servidor:

```bash
cd /opt/odontocrm                     # o C:\OdontoCRM en Windows
sudo nano packages/contracts/src/clinic.ts
#    Si tocaste brand.ts, además:
sudo odontocrm compilar               # compila los contratos (de donde marca:css lee)
sudo node tools/generar-marca.mjs     # regenera packages/ui/src/styles/marca.css
sudo odontocrm recompilar             # recompila (ya con la marca nueva) y reinicia
```

**Reglas de esta vía:**

- **No uses `sudo odontocrm actualizar` después**: haría `git` sobre `/opt/odontocrm` y **pisaría**
  tu edición. Mientras dependas de ella, actualiza con cuidado (revisa `git status` antes).
- Es un parche **temporal**: en cuanto puedas, llévalo a la vía A para que sobreviva a la próxima
  actualización.

### 9.2 Vía C: sobrescribir por entorno (sin compilar)

Solo el **nombre, la dirección y el correo**, y solo para el bot, el `.ics` y las pantallas
(§7). Se añaden al entorno del servicio, no al del sistema:

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

**No** sirve para los odontólogos, el MPPS, el logo, el RIF ni la paleta: eso es la vía A.

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
| Al membrete no le falta nada | `letterheadMissingFields()` o el aviso del editor del récipe antes de emitir |
| El CSS de la marca está al día | `npm run marca:css -- --check` |
| La marca no se quedó desfasada del código | `npm test` (corre `brand.test.ts`) |
| Todo el repositorio sigue sano | `npm run verify` (secretos + lint + formato + tipos + build + pruebas) |
| El membrete sale en el papel | Emitir un **récipe** y mirarlo: logo, nombre, RIF, teléfonos y el MPPS del firmante |
| La interfaz usa el color nuevo | Abrir cualquier pantalla y comprobar el color principal |

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

Conclusión: **no hace falta «deshardcodear» nada** para re-tematizar la aplicación. El color de la
interfaz sale de `tokens.css` y el de los documentos de `brand.ts`; los pocos valores fijos que
quedan son decisiones de dominio o de arranque, no duplicados de la paleta.

---

## 12. Errores comunes

| Síntoma | Causa | Arreglo |
| :--- | :--- | :--- |
| El membrete de la **pantalla** cambió de color pero el **papel** no (o al revés) | Tocaste `tokens.css` y no `brand.ts` (o al revés) | Son dos capas distintas: cambia la que corresponda (§0) |
| El color nuevo se ve en unos documentos y en otros no | Cambiaste `brand.ts` y **no** regeneraste `marca.css` | `npm run build:node && npm run marca:css && npm run build` |
| `npm test` falla en `brand.test.ts` («el CSS versionado coincide con brand.ts») | Cambiaste `brand.ts` y no regeneraste el CSS | `npm run marca:css` |
| El membrete sigue con los datos viejos tras editar `clinic.ts` | No recompilaste (o no reiniciaste) | `npm run build` y reiniciar la pila (§8) |
| El récipe sale sin MPPS o sin especialidad | El titular de `dentists[]` los tiene en `null` | Rellenarlos en `clinic.ts` y recompilar (`letterheadMissingFields` los enumera) |
| La cuenta de un odontólogo nuevo no existe | `seed:users` no se volvió a correr | `npm run seed:users` (dev) o el comando de §9 (prod) |
| `CLINIC_NAME` del `.env` «no hace nada» en el récipe | Solo lo leen bot, `.ics` y pantallas | Para el récipe y la interfaz, edita `clinic.ts` (§7) |
| Tras `odontocrm actualizar` desaparece un cambio hecho a mano en el servidor | `actualizar` hizo `git` sobre el código | Usa la vía A (§9.0); la B es un parche temporal |

---

## Documentación relacionada

- [Instalación del servidor · Fedora](../infra/fedora/INSTALL.md) · [Windows](../infra/windows/INSTALL.md)
- [Datos del consultorio en el instalador de Fedora](../infra/fedora/INSTALL.md) (§8.0)
- [Ilustración y operación diaria del consultorio](OPERACION_CLINICA.md)
- [Comandos de desarrollo](COMANDOS.md) · [Comandos de producción](COMANDOS_PRODUCCION.md)
- [Logo del consultorio](../assets/clinic/README.md)
- [El membrete, el logo y la marca de agua son los mismos en todos los imprimibles](adr/0054-membrete-unico-en-los-imprimibles.md)
