# Licencias (clave pública)

Aquí vive **solo la clave pública** con la que la app verifica las licencias
offline ([ADR 0075](../../docs/adr/0075-licenciamiento-offline-y-modo-consulta.md)).

- `licencia-publica.pem` — la genera el proveedor una vez con
  `npm run licencia -- claves --publicar` y se versiona en el repo. **No es
  secreta.** (El comando la deja también en el directorio de configuración del
  proveedor; con `--publicar` la copia aquí.)
- La clave privada **nunca** va al repositorio ni a un servidor de consultorio:
  se guarda fuera del repo (`~/.config/odontocrm/licencias/licencia-privada.pem`
  en Linux, `%APPDATA%\odontocrm\licencias\` en Windows) con permisos de solo
  el usuario, y se respalda aparte.

Si el archivo no existe, la instalación funciona (prueba de 30 días y modo
consulta), pero **no se puede activar** una licencia: la API lo dice con un
error claro y la solución es generar el par y publicar la pública.
