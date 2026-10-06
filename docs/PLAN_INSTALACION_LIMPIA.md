# Instalación en otra PC: se descarta el plan actual

> **Decisión (2026-10-05).** El camino de instalación y despliegue que tenemos —el guion
> `ensayo-despliegue.sh` haciendo de instalador, el **traslado de secretos** de
> `services/*.env` a `/etc/odontocrm`, el `sincronizar-credenciales` que lo repara y las fases
> encadenadas con `--hasta`— **se descarta como diseño**. No se le añaden más parches.
>
> **El plan nuevo y su implementación se harán en otra sesión**, empezando de cero y con la
> cabeza fresca.

## Por qué se descarta

- **Los secretos viven en dos sitios** (los `.env` del repositorio y `/etc/odontocrm`) y un
  paso los copia de uno a otro. Todos los fallos de hoy —el «password authentication failed» a
  mitad del despliegue, el servicio en bucle, la credencial que no coincide— son **síntomas de
  esa única causa**.
- **Cada arreglo añadía una capa**: un traslado, un verificador que además repara, un
  sincronizador, una traza. El despliegue se volvió la fuente de los fallos, no la aplicación.
- **Las piezas no se pueden ejecutar ni comprobar por separado**: `--hasta=config` no significa
  «parar en config» (solo habilita las fases posteriores), y eso costó una ronda entera de
  confusión.

## Estado: implementado

El plan que este documento dejaba abierto **ya está hecho**: el instalador nuevo está en
`infra/fedora/instalar/` y hay una sola fuente de verdad para las credenciales
(`/etc/odontocrm`). Un servidor se levanta con:

```bash
sudo bash infra/fedora/instalar/instalar.sh
```

Son cuatro piezas que se pueden ejecutar y comprobar por separado
(`10-preparar.sh` · `20-aprovisionar.sh` · `30-desplegar.sh` · `40-verificar.sh`).
El detalle está en `infra/fedora/INSTALL.md` §3-bis y la decisión, en el
[ADR 0043](adr/0043-se-descarta-el-enfoque-de-instalacion-actual.md).

Las cuatro decisiones que este documento listaba como pendientes, resueltas:

1. **Una sola fuente de verdad**: `/etc/odontocrm`. Los `.env` del repositorio siguen siendo
   solo para desarrollo; en el servidor no existe una segunda copia que pueda desfasarse.
2. **`aprovisionar` es un comando propio** (`20-aprovisionar.sh`), separado del despliegue, y
   comprueba cada credencial con una conexión real.
3. **Del ensayo se conserva la prueba** (restauración, reinicio, TLS desde otro equipo) y se
   retira su papel de instalador.
4. **Se prueba en esta PC** antes de tocar la de la clínica: cada pieza admite `--dry-run`, y
   `instalar.sh --comprobar` dice si la máquina está lista sin tocar nada.

## Lo que hay que decidir en la próxima sesión

1. **Una sola fuente de verdad** para las credenciales (candidata: `/etc/odontocrm` como único
   sitio; los `.env` del repositorio, solo para desarrollo).
2. Si `aprovisionar` (bases + roles + credenciales + usuarios + comprobación por conexión real)
   es **un comando propio** o parte del instalador.
3. Qué se conserva del ensayo —la prueba de restauración, el reinicio, el TLS desde otro
   equipo— y qué se tira.
4. Cómo se **prueba en esta PC** antes de tocar la de la clínica.

Los detalles técnicos que ya conocemos (comandos, rutas, unidades, certificados, firewall,
SELinux y las 95 comprobaciones de `npm run fedora:check`) siguen en
[`infra/fedora/INSTALL.md`](../infra/fedora/INSTALL.md) y en el
[RUNBOOK](../infra/fedora/RUNBOOK.md), y no se tocan al rediseñar.
