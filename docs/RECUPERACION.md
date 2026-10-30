# Recuperar el servidor del consultorio

> **Para qué es esto.** El servidor se rompe (un disco que falla) o hay que **mudarlo** a otra
> máquina. En los dos casos, esto es lo que se hace para dejar el consultorio **como estaba**, con
> las citas, las historias, las radiografías y las facturas.
>
> **Quién lo hace.** Alguien con acceso al servidor y a la carpeta del respaldo (un pendrive, o los
> archivos que se bajaron del bot de Telegram). Se hace **desde la terminal del servidor**: la
> aplicación estará caída, así que no hay panel donde pulsar nada.
>
> **Qué no es.** No es el día a día del servidor ([`infra/fedora/RUNBOOK.md`](../infra/fedora/RUNBOOK.md)
> / [`infra/windows/RUNBOOK.md`](../infra/windows/RUNBOOK.md)) ni la instalación
> ([`INSTALL.md`](../infra/fedora/INSTALL.md) / [`infra/windows/INSTALL.md`](../infra/windows/INSTALL.md)).
> Aquí se enlazan, no se copian.

---

## 0. Los tres casos

| Caso | Qué se hace |
| :--- | :--- |
| **Mudar a un servidor nuevo** (otra PC) | Instalar el servidor en la máquina nueva y **recuperar** el respaldo más reciente |
| **Fallo físico** (el disco murió, la PC no arranca) | Recuperar el respaldo en una máquina que pueda levantar el servidor |
| **Recuperar una sola base** (un dato borrado por error) | `odontocrm restaurar` de **esa** base (no hace falta el flujo completo) |

Los tres casos son el mismo trabajo: **reponer lo que guarda el respaldo**. Lo único que cambia es
de dónde sale la máquina que lo ejecuta. Y el respaldo puede venir de **tres** sitios: el
**directorio del día** (pendrive, disco externo), la **copia completa** que se pidió al bot
desde Telegram (`/respaldo`, que se queda en el propio servidor: §3b) o lo que mandó el bot por
chat (`/respaldos`, que trae **solo las bases**: §3).

---

## 1. Qué trae el respaldo (y las tres cosas van juntas)

El respaldo diario guarda **tres cosas**. Si se repone una sola, el resultado queda a medias:

| Contenido | Fedora | Windows | Qué pasa si falta |
| :--- | :--- | :--- | :--- |
| **Las bases** (citas, historias, facturas) | `odonto_<base>.dump` (uno por base) | `odonto_<base>.dump` | Se pierde el trabajo diario |
| **El almacén** (radiografías y PDFs) | `storage_<fecha>.tar.gz` | `storage.zip` | Los documentos que se subieron, perdidos |
| **La configuración** (tokens, claves, `STORAGE_ENCRYPTION_KEY`) | `etc-odontocrm_<fecha>.tar.gz` | `config.zip` | El sistema no «conecta»; y si el almacén está cifrado, queda **ilegible** |

Junto a ellos van `SHA256SUMS` (las huellas de cada archivo) y `manifest.txt` (qué se respaldó y
cuándo), que es lo que permite **comprobar** que el respaldo no viene cortado.

> **Lo que el respaldo no trae**: los **roles** de PostgreSQL (los vuelve a crear el instalador) ni
> un punto en el tiempo. Un respaldo es una **foto** del momento en que se hizo, no un «rebobinar»
> continuo. Es una decisión conocida, no un olvido.

---

## 2. Cómo deben estar los archivos en el medio

El respaldo es **un directorio por día**, y todos los días cuelgan del mismo medio (el pendrive, el
disco externo o la carpeta que lee el bot):

```
/media/pendrive/                 ← el medio de recuperación (su raíz)
├── 2026-10-10/                  ← un respaldo por día
├── 2026-10-11/
└── 2026-10-12/                  ← el más reciente: el que se usa para recuperar
```

Dentro del directorio del día, los archivos van **sueltos** (nada de subcarpetas) y con estos nombres:

```
2026-10-12/
├── odonto_<base>_2026-10-12_033001.dump   ┐
├── odonto_<base>_2026-10-12_033001.dump   │  las bases, una por base (una por servicio,
├── odonto_<base>_2026-10-12_033001.dump   │  más `odonto_events`); en Windows el nombre
├── …                                      │  es `<base>.dump`, sin fecha
├── storage_2026-10-12_033001.tar.gz       ←  radiografías y PDFs    (Windows: storage.zip)
├── etc-odontocrm_2026-10-12_033001.tar.gz ←  configuración y claves (Windows: config.zip)
├── SHA256SUMS                             ←  la huella de cada archivo de arriba
└── manifest.txt                           ←  qué se respaldó y cuándo
```

Ese mismo directorio, en el servidor, vive en:

| Fedora | Windows |
| :--- | :--- |
| `/var/backups/odontocrm/2026-10-12/` | `C:\OdontoCRM\backups\2026-10-12\` |

Reglas (si algo no encaja, **sospecha antes de restaurar**):

- **El directorio del día se llama exactamente `AAAA-MM-DD`.** Es lo único que la retención (30 días
  por defecto) reconoce y borra: un `respaldo_final_ok/` no se borra nunca, pero tampoco se espera.
- **Los archivos van sueltos**, en la raíz del día: `SHA256SUMS` los busca ahí, no dentro de carpetas.
- **Los tres bloques viajan juntos** (bases + almacén + configuración). Si falta `storage*` o
  `config*`, ese respaldo es anterior a esa mejora: repón lo que haya y cuenta con lo que falta (§1).
- **`SHA256SUMS` y `manifest.txt` no se editan a mano**: son la prueba de que el respaldo no viene
  cortado. Si un archivo no cuadra con su suma, ese respaldo **no se usa** (§4).
- **Un `*.dump.err` es un volcado que falló** en esa fecha (en un respaldo sano no aparece ninguno).
- **`odonto_events` puede no estar**: es la cola, y hasta que un servicio con outbox arranca por
  primera vez esa base no existe. No es un respaldo roto.
- **Lo que manda el bot es otro origen** —`<base>.dump`, sin fecha, en una carpeta
  `admin-respaldos-…`—, y trae solo las bases: se trata en §3.
- **La copia completa del bot es otro origen más** —carpeta con la marca `AAAA-MM-DD_HHMMSS`,
  `<base>.dump` sin fecha y **los tres bloques**— y vive del lado del servidor, no del medio:
  se trata en §3b.

> Y ojo con lo que **no** es un respaldo: una carpeta `AAAA-MM-DD` a la que le falta
> `SHA256SUMS` o uno de los tres bloques es un respaldo **roto o viejo**, y no se da por bueno.

---

## 3. Si lo que hay es lo que mandó el bot (solo las bases)

El bot de administración (`/respaldos` en Telegram) sirve para **sacar las bases ahora**:
`pg_dump` de cada base, `SHA256SUMS` y un mensaje con el resumen. Sirve igual para recuperar,
pero hay que saber dos cosas antes de empezar:

- **Es solo las bases.** El bot **no** manda el almacén (radiografías y PDFs) ni la configuración:
  con esto se recuperan las citas, las historias y las facturas, y **no** los documentos. Los dos
  bloques que faltan se sacan del respaldo nocturno (§2) o se quedan como están; al terminar hay
  que reponer el `STORAGE_ENCRYPTION_KEY` si el almacén está cifrado (§7).
- **Los archivos llegan sueltos y sin fecha**: `<base>.dump` (no `<base>_<fecha>.dump`), y en una
  carpeta llamada `admin-respaldos-<fecha ISO>`, no `AAAA-MM-DD`. Por eso `verify-backup.mjs` **solo
  los mira si se le pasan con `--from`**: sin eso busca carpetas con fecha y no ve esta.

Telegram corta en 50 MB: lo que no quepa **no se envía** y queda en la carpeta temporal del
servidor —el mensaje del bot dice dónde—. Esa carpeta **no se borra** cuando algo quedó pendiente,
pero la ruta que anuncia el bot hay que saber leerla, porque el servicio tiene su propio `/tmp`:

| | Dónde buscar lo que no llegó por Telegram |
| :--- | :--- |
| **Fedora** | `/tmp/odontocrm/admin-respaldos-*` **dentro** del `/tmp` privado del servicio: `sudo ls -d /tmp/systemd-private-*/tmp/odontocrm/admin-respaldos-*` (el `.service` usa `PrivateTmp=true`) |
| **Windows** | `C:\OdontoCRM\data\tmp\admin-respaldos-*` |

### El camino: los mismos tres pasos, con esa carpeta

```bash
# 1) Reunir los archivos en una carpeta: las descargas de Telegram, o la carpeta temporal del
#    servidor si algo superó los 50 MB. El bot nombra la carpeta con la fecha en ISO, así:
CARPETA=/media/pendrive/admin-respaldos-2026-10-12T03-30-00-123Z

# 2) Comprobar (restaura cada volcado en una base temporal y cuenta filas: no toca nada):
node tools/verify-backup.mjs --from "$CARPETA" --estado

# 3) Restaurar (los mismos comandos de §6, con esa carpeta como origen):
sudo odontocrm restaurar --from "$CARPETA" --all --keep-old --yes          # Fedora
odontocrm restaurar --from E:\admin-respaldos-2026-10-12T03-30-00-123Z --all --keep-old --yes  # Windows
```

Una sola base, sin tocar las demás: `--db odonto_patients` (nombre completo; el corto —`patients`—
solo lo admite `verify-backup.mjs`, no el restaurador).

El restaurador reconoce los dos nombres de archivo —el de la noche (`<base>_<fecha>.dump`) y el del
bot (`<base>.dump`)— y, si en la carpeta están los dos, **prefiere el de la noche**. Los volcados del
bot vienen con `--no-owner`: se restauran con el rol de cada servicio, como cualquier otro.

> **Custodia.** Estos dumps van **en claro** y contienen datos clínicos, y ahora hay copias **en el
> chat de Telegram y en el teléfono**. Al terminar, bórralas de ahí: el servidor y el pendrive
> (protegido) son los sitios donde estos archivos deben estar.

---

## 3b. Si lo que hay es la copia completa del servidor (`/respaldo`)

El bot de administración tiene **otro** comando, aparte de `/respaldos`: `/respaldo` (o
`npm run respaldo:manual`, que es la misma pieza sin pasar por Telegram). Deja una copia
**completa** —bases + almacén + configuración— en el propio servidor y contesta con la carpeta,
tamaño de cada bloque y las dos órdenes para comprobarla y reponerla. **No manda nada por chat:**
lo que viaja mal son justo los dos bloques que hacen falta para recuperar de verdad.

| | Dónde queda |
| :--- | :--- |
| **Fedora** | `/var/lib/odontocrm/respaldo-manual/<AAAA-MM-DD_HHMMSS>/` |
| **Windows** | `C:\OdontoCRM\data\respaldo-manual\<AAAA-MM-DD_HHMMSS>\` |

Y por dentro es la forma del respaldo nocturno, con la fecha en la **carpeta** en vez de en los
nombres:

```
2026-10-12_033001/
├── odonto_<base>.dump          ←  una por servicio, más `odonto_events`
├── storage.zip                 ←  radiografías y PDFs      (Fedora: storage_<marca>.tar.gz)
├── config.zip                  ←  configuración y SECRETOS (Fedora: etc-odontocrm_<marca>.tar.gz)
├── SHA256SUMS                  ←  la huella de cada archivo de arriba
└── manifest.txt                ←  qué se respaldó y cuándo (`origen=manual`)
```

**Se comprueba y se repone igual** que el directorio del día: es exactamente el mismo formato, así
que valen los comandos de §4, §5 y §6 cambiando la ruta.

```bash
# Comprobar (restaura cada volcado en una base temporal y cuenta filas: no toca nada)
node tools/verify-backup.mjs --from /var/lib/odontocrm/respaldo-manual/2026-10-12_033001

# Reponer (para los servicios → restaura las bases → repone el almacén → arranca)
sudo odontocrm recuperar --from /var/lib/odontocrm/respaldo-manual/2026-10-12_033001 --yes
```

Tres cosas que conviene saber antes de tirar de esta carpeta:

- **La configuración lleva secretos**, así que la carpeta se custodia como el respaldo del pendrive
  (Fedora la crea `0700 root:root`): no se copia a un sitio compartido sin pensar. En cambio **sí**
  trae el `STORAGE_ENCRYPTION_KEY`, que es lo que hace legible un almacén cifrado (§7).
- **Se podan solas**: se conservan las **5** últimas copias (`ODONTOCRM_BACKUP_MANUAL_KEEP`),
  porque cada una lleva el almacén entero dentro. Si el disco se llena, se baja ese número.
- **Si un bloque falló, el mensaje del bot lo dice** (y la carpeta se queda igual, sin él): una
  copia a la que le falta un bloque no sirve para una recuperación completa, y hay que enterarse
  el día que se pide y no el día del desastre. Si el fallo fue el volcado de una base, `fallos=0`
  del `manifest.txt` no cuadra y hay que tomarla como parcial.

---

## 4. Antes de tocar nada: comprobar el respaldo

Un respaldo que nunca se ha restaurado es una carpeta con archivos. **Primero se comprueba** (y de
paso se ve qué contiene y cuándo se hizo):

```bash
# Fedora:              node tools/verify-backup.mjs --from /media/pendrive/2026-10-12 --estado
# Windows (PowerShell): node tools\verify-backup.mjs --from E:\2026-10-12 --estado
```

`--from` acepta el directorio **tal cual**, aunque sea un pendrive. Comprueba el SHA-256 de **todo**
el respaldo (las bases y los archivos), no solo de un volcado. Si algo no cuadra, **se para aquí**:
mejor saberlo antes de borrar nada.

Lo que hay que ver en la carpeta es lo que describe el esquema de §2: las bases, `storage*`,
la configuración (`etc-odontocrm_*` en Fedora, `config.zip` en Windows), `SHA256SUMS` y
`manifest.txt`, todos sueltos dentro del directorio del día.

> **Trampa real.** Un respaldo hecho **antes** de que el almacén entrara en la copia diaria **no
> trae `storage*`**. Es la diferencia entre recuperar «todo» y recuperar «solo las bases»: míralo
> con `ls` antes de dar el desastre por resuelto.

---

## 5. La recuperación, en un comando

```bash
# 1) En una máquina nueva, primero se instala (crea las bases vacías, los roles y los servicios):
#    Fedora:   sudo bash infra/fedora/instalar/instalar.sh
#    Windows:  powershell -ExecutionPolicy Bypass -File infra\windows\instalar\instalar.ps1

# 2) Y se recupera el respaldo (para los servicios → restaurar las bases → reponer el almacén → arrancar):
sudo odontocrm recuperar --from /media/pendrive/2026-10-12 --yes      # Fedora
odontocrm recuperar --from E:\2026-10-12 --yes                        # Windows
```

`recuperar` hace, en orden:

1. **Para** los servicios. *PostgreSQL se queda arriba*: la restauración necesita conectarse.
2. **Restaura las bases**, cada una con la verificación previa del restaurador (ensaya en una base
   temporal y, solo si entra, sustituye la buena) y conservando la anterior como
   `<base>__antes_de_restaurar_<fecha>`.
3. **Repone el almacén** (radiografías y PDFs), **reconcilia `STORAGE_ENCRYPTION_KEY`** copiando la
   del respaldo a los `.env` (solo esa línea; es la excepción al «no se toca la configuración») y
   **comprueba que un documento se descifra** de verdad.
4. **Arranca** y comprueba que los servicios responden.

Es prudente a propósito:

- **sin `--yes`** dice exactamente qué haría y **no toca nada**;
- **`--dry-run`** ni siquiera pregunta;
- **no repone la configuración** salvo `--con-config` (ver §7);
- cualquier paso que falle **detiene el proceso** y dice qué pasó.

---

## 6. El paso a paso (si prefieres verlo, o si `recuperar` falló en algo)

```bash
# 1) Comprueba el respaldo (ver §4)
node tools/verify-backup.mjs --from /media/pendrive/2026-10-12 --estado

# 2) Para la pila (PostgreSQL se queda arriba)
sudo odontocrm parar

# 3) Las bases: ensaya en base temporal y conserva la anterior.
#    Con `--all` repone ADEMÁS el almacén, reconcilia su clave y reinicia los servicios;
#    con `--db <una>` o `--list` sigue tocando solo las bases.
sudo odontocrm restaurar --from /media/pendrive/2026-10-12 --all --keep-old --yes

# 4) El almacén (radiografías y PDFs) → /var/lib/odontocrm/storage
#    Si el almacén está cifrado, la clave del respaldo tiene que quedar puesta (el paso 3 la
#    reconcilia solo; a mano es copiar el STORAGE_ENCRYPTION_KEY, ver §7).
sudo tar -xzf /media/pendrive/2026-10-12/storage_<fecha>.tar.gz -C /var/lib/odontocrm/storage

# 5) La configuración, SOLO si la necesitas (ver §7)
sudo tar -xzf /media/pendrive/2026-10-12/etc-odontocrm_<fecha>.tar.gz -C /etc
sudo chmod 0600 /etc/odontocrm/*.env /etc/odontocrm/.pgpass

# 6) Arranca y verifica
sudo odontocrm arrancar
```

En Windows, los dos extractos son `Expand-Archive` (el paso 4 a `C:\OdontoCRM\data\storage` y el 5
a `C:\ProgramData\OdontoCRM\env`, porque el `config.zip` trae el **contenido** de la carpeta `env`).
Después de reponer la configuración hay que **volver a proteger los `.env`** (pierden el control de
acceso al copiarse).

---

## 7. La configuración y el `STORAGE_ENCRYPTION_KEY`

`recuperar` **no repone `/etc/odontocrm`** (ni `…\ProgramData\OdontoCRM\env`) por defecto, y es a
propósito: los `.env` del respaldo son de la máquina **anterior**. Traen sus contraseñas y sus
rutas; si se copian sobre una instalación nueva, **pisarían** las que acaba de crear el instalador y
los servicios dejarían de conectar. Por eso, en la máquina nueva, la configuración buena es la que
genera el instalador.

**La excepción es el almacén cifrado.** Si el consultorio guarda radiografías con cifrado en reposo
(`STORAGE_ENCRYPTION_KEY`), esa clave tiene que ser **la misma** con la que se cifraron los archivos;
si no, el almacén restaurado queda **ilegible**. Eso ya **no hay que hacerlo a mano**: `recuperar`
y `odontocrm restaurar --all` **reconcilian la clave solos** —copian **solo** esa línea del respaldo a
`patients.env`, `clinical.env`, `billing.env` y **`notifications.env`** (la sesión Signal de WhatsApp
también va cifrada con ella), sin tocar el resto del archivo— y **comprueban en el acto** que un
documento se descifra. Si se prefiere hacerlo a mano (o imponer otra clave sin reponer nada más), el
aprovisionador tiene `--clave-almacen=<base64url>`, que reemplaza únicamente esa línea y deja una
copia `.antes-de-<sello>` junto al `.env`. La alternativa de reponer la configuración entera es
`--con-config`, **y después revisar las rutas y las contraseñas** de cada `.env`.

**Sesión de WhatsApp.** La sesión Signal viaja en `odonto_notifications` y se restaura con las
bases. Si el respaldo es antiguo y las claves Signal quedaron desfasadas, WhatsApp no conecta: entra
en **Configuración → Canales**, pulsa **Cerrar sesión** y vuelve a vincular con el QR (un minuto).
No hay que tocar el respaldo ni la clave del almacén.

---

## 8. Después de recuperar

1. **Si el respaldo es de un esquema anterior**, hay que **aplicar las migraciones** antes de dar
   por bueno el sistema: `odontocrm actualizar` (Fedora y Windows) compila, migra y reinicia.
2. **Comprobar**: `odontocrm verificar` (servicios, HTTPS, la CA) y `odontocrm estado` (bases, cola,
   outbox y alertas).
3. **Si el respaldo venía de una máquina que tuvo las cuentas de prueba** («Recepción prueba»,
   «Odontólogo prueba»), retirarlas: `sudo odontocrm purgar-prueba` (sin `--si` enseña qué haría; las
   **desactiva**, y con `--borrar` las elimina).
4. **Entrar** a la aplicación y mirar lo que importa: la agenda del día, un paciente con radiografías
   y una factura. Es la única prueba que cuenta.
5. Si todo está bien, borrar las bases `__antes_de_restaurar_*` y `__verif` que quedaron de la
   restauración (`psql -c '\l'` las lista).

---

## 9. Qué cubre y qué no

| Cubre | No cubre |
| :--- | :--- |
| Las 9 bases, el almacén y la configuración del respaldo | Los **roles** de PostgreSQL (los crea el instalador) |
| Restaurar una base suelta sin tocar las demás | «Rebobinar» a un minuto concreto (**no hay PITR**) |
| Comprobar la integridad del respaldo antes de usarlo | El **cifrado** de los propios respaldos (van en claro: **custódialos**) |

> Los respaldos contienen **datos clínicos** —y la configuración, **secretos**—: el pendrive o el
> medio donde se guarden tiene que ir **protegido**.

---

## 10. Dónde está cada cosa

| Documento | Para qué |
| :--- | :--- |
| [`infra/fedora/RUNBOOK.md`](../infra/fedora/RUNBOOK.md) | El día a día del servidor Fedora (respaldos, restaurar, actualizar) |
| [`infra/windows/RUNBOOK.md`](../infra/windows/RUNBOOK.md) | Lo mismo, en Windows |
| [`infra/fedora/INSTALL.md`](../infra/fedora/INSTALL.md) §15–16 | Cómo se respalda y cómo se prueba la restauración |
| [`docs/COMANDOS_PRODUCCION.md`](./COMANDOS_PRODUCCION.md) | Los comandos del servidor en producción (`sudo odontocrm …`) |
| [`docs/SEGURIDAD_SECRETOS.md`](./SEGURIDAD_SECRETOS.md) | Dónde vive cada secreto y cómo se custodia |
