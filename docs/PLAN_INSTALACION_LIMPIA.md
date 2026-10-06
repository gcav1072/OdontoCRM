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

## Qué queda mientras tanto

Nada se rompe ni se borra: **lo que hay sigue funcionando y sigue siendo el camino documentado**
hasta que exista el nuevo. Para dejar un servidor operativo hoy:

```bash
cd /home/gabox/devp/OdontoCRM && npm run db:bootstrap          # converge base y archivos
sudo odontocrm sincronizar-credenciales --desde=$PWD           # deja /etc de acuerdo y lo comprueba
sudo odontocrm reiniciar && sudo odontocrm verificar           # arranca y comprueba los 9
```

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
