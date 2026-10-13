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
de dónde sale la máquina que lo ejecuta.

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

## 2. Antes de tocar nada: comprobar el respaldo

Un respaldo que nunca se ha restaurado es una carpeta con archivos. **Primero se comprueba** (y de
paso se ve qué contiene y cuándo se hizo):

```bash
# Fedora:              node tools/verify-backup.mjs --from /media/pendrive/2026-10-12 --estado
# Windows (PowerShell): node tools\verify-backup.mjs --from E:\2026-10-12 --estado
```

`--from` acepta el directorio **tal cual**, aunque sea un pendrive. Comprueba el SHA-256 de **todo**
el respaldo (las bases y los archivos), no solo de un volcado. Si algo no cuadra, **se para aquí**:
mejor saberlo antes de borrar nada.

Lo que hay que ver en la carpeta:

```
2026-10-12/
  odonto_identity.dump  odonto_patients.dump  odonto_scheduling.dump  …   (una por base)
  storage_2026-10-12_033001.tar.gz   (o storage.zip)      ← las radiografías y los PDFs
  etc-odontocrm_2026-10-12_033001.tar.gz  (o config.zip)  ← la configuración y los secretos
  SHA256SUMS
  manifest.txt
```

> **Trampa real.** Un respaldo hecho **antes** de que el almacén entrara en la copia diaria **no
> trae `storage*`**. Es la diferencia entre recuperar «todo» y recuperar «solo las bases»: míralo
> con `ls` antes de dar el desastre por resuelto.

---

## 3. La recuperación, en un comando

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
3. **Repone el almacén** (radiografías y PDFs).
4. **Arranca** y comprueba que los servicios responden.

Es prudente a propósito:

- **sin `--yes`** dice exactamente qué haría y **no toca nada**;
- **`--dry-run`** ni siquiera pregunta;
- **no repone la configuración** salvo `--con-config` (ver §5);
- cualquier paso que falle **detiene el proceso** y dice qué pasó.

---

## 4. El paso a paso (si prefieres verlo, o si `recuperar` falló en algo)

```bash
# 1) Comprueba el respaldo (ver §2)
node tools/verify-backup.mjs --from /media/pendrive/2026-10-12 --estado

# 2) Para la pila (PostgreSQL se queda arriba)
sudo odontocrm parar

# 3) Las bases: ensaya en base temporal y conserva la anterior
sudo odontocrm restaurar --from /media/pendrive/2026-10-12 --all --keep-old --yes

# 4) El almacén (radiografías y PDFs) → /var/lib/odontocrm/storage
sudo tar -xzf /media/pendrive/2026-10-12/storage_<fecha>.tar.gz -C /var/lib/odontocrm/storage

# 5) La configuración, SOLO si la necesitas (ver §5)
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

## 5. La configuración y el `STORAGE_ENCRYPTION_KEY`

`recuperar` **no repone `/etc/odontocrm`** (ni `…\ProgramData\OdontoCRM\env`) por defecto, y es a
propósito: los `.env` del respaldo son de la máquina **anterior**. Traen sus contraseñas y sus
rutas; si se copian sobre una instalación nueva, **pisarían** las que acaba de crear el instalador y
los servicios dejarían de conectar. Por eso, en la máquina nueva, la configuración buena es la que
genera el instalador.

**La excepción es el almacén cifrado.** Si el consultorio guarda radiografías con cifrado en reposo
(`STORAGE_ENCRYPTION_KEY`), esa clave tiene que ser **la misma** con la que se cifraron los archivos;
si no, el almacén restaurado queda **ilegible**. Opciones:

- copiar **solo** `STORAGE_ENCRYPTION_KEY` del respaldo a `patients.env` **y** a `clinical.env` y
  `billing.env` (las tres guardan archivos y comparten la clave), o
- `--con-config` para reponer la configuración entera, **y después revisar las rutas y las
  contraseñas** de cada `.env`.

`recuperar` avisa de esto al terminar, con la ruta exacta donde hay que copiarla.

---

## 6. Después de recuperar

1. **Si el respaldo es de un esquema anterior**, hay que **aplicar las migraciones** antes de dar
   por bueno el sistema: `odontocrm actualizar` (Fedora y Windows) compila, migra y reinicia.
2. **Comprobar**: `odontocrm verificar` (servicios, HTTPS, la CA) y `odontocrm estado` (bases, cola,
   outbox y alertas).
3. **Entrar** a la aplicación y mirar lo que importa: la agenda del día, un paciente con radiografías
   y una factura. Es la única prueba que cuenta.
4. Si todo está bien, borrar las bases `__antes_de_restaurar_*` y `__verif` que quedaron de la
   restauración (`psql -c '\l'` las lista).

---

## 7. Qué cubre y qué no

| Cubre | No cubre |
| :--- | :--- |
| Las 9 bases, el almacén y la configuración del respaldo | Los **roles** de PostgreSQL (los crea el instalador) |
| Restaurar una base suelta sin tocar las demás | «Rebobinar» a un minuto concreto (**no hay PITR**) |
| Comprobar la integridad del respaldo antes de usarlo | El **cifrado** de los propios respaldos (van en claro: **custódialos**) |

> Los respaldos contienen **datos clínicos** —y la configuración, **secretos**—: el pendrive o el
> medio donde se guarden tiene que ir **protegido**.

---

## 8. Dónde está cada cosa

| Documento | Para qué |
| :--- | :--- |
| [`infra/fedora/RUNBOOK.md`](../infra/fedora/RUNBOOK.md) | El día a día del servidor Fedora (respaldos, restaurar, actualizar) |
| [`infra/windows/RUNBOOK.md`](../infra/windows/RUNBOOK.md) | Lo mismo, en Windows |
| [`infra/fedora/INSTALL.md`](../infra/fedora/INSTALL.md) §15–16 | Cómo se respalda y cómo se prueba la restauración |
| [`docs/COMANDOS_PRODUCCION.md`](./COMANDOS_PRODUCCION.md) | Los comandos del servidor en producción (`sudo odontocrm …`) |
| [`docs/SEGURIDAD_SECRETOS.md`](./SEGURIDAD_SECRETOS.md) | Dónde vive cada secreto y cómo se custodia |
