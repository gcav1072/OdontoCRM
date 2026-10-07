# ADR 0050 — Windows es un segundo destino de producción soportado (y cómo se instala)

- **Fecha:** 2026-10-06 · **Estado:** aceptada · **Implementación:** `infra/windows/instalar/`
- **Relacionada con:** [0001](0001-infraestructura-nativa.md) (infraestructura nativa), [0037](0037-una-sola-pila-a-la-vez.md) (una sola pila), [0043](0043-se-descarta-el-enfoque-de-instalacion-actual.md) (una sola fuente de credenciales)

## Contexto

El [ADR 0001](0001-infraestructura-nativa.md) fijó **Windows para desarrollo y pruebas** y
**Fedora para producción**. Al elegir consultorios piloto apareció el problema práctico: **la
inmensa mayoría de los equipos de recepción y administración de esas clínicas son Windows 10
u 11**, no Linux. Pedir a la clínica un equipo con Fedora —o convencerla de migrar el que ya
tiene— era, en la práctica, el obstáculo más caro de todo el despliegue: no el software, sino
el sistema operativo del aparato que ya está en el mostrador.

En paralelo, el instalador de Fedora quedó maduro tras varias rondas dolorosas
([ADR 0043](0043-se-descarta-el-enfoque-de-instalacion-actual.md)): cuatro piezas idempotentes
y comprobables, una sola fuente de credenciales, verificación **por efecto** (una credencial
vale cuando conecta) y esperas con *healthcheck*. Esa experiencia es la que hace viable —
ahora y no antes— portarlo a Windows sin repetir los mismos errores.

## Decisión

1. **Windows pasa a ser un destino de producción soportado**, además de Fedora. Una clínica
   puede desplegar el servidor en un Windows 10/11 del consultorio. No se abandona Fedora: son
   **dos destinos**, con el mismo código y el mismo contrato.
2. **El instalador vive en `infra/windows/instalar/` y es el espejo del de Fedora**: el mismo
   comando único (`instalar.ps1`), las mismas cuatro piezas (`10-preparar`, `20-aprovisionar`,
   `30-desplegar`, `40-verificar`), las mismas banderas (`--dry-run`, `--comprobar`,
   `--solo=`, `--sin-preguntas`) y la misma disciplina de idempotencia.
3. **Se comparte todo lo que se pueda**: el aprovisionador de credenciales es el MISMO
   (`infra/fedora/instalar/aprovisionar.mjs`, hecho portable), igual que `tools/con-entorno.mjs`
   y la lista de servicios (`tools/servicios.mjs`). Solo se reescribe lo que es del sistema
   operativo.
4. **El mapa de componentes** (lo que sustituye a cada pieza de Fedora):

   | Función | En Fedora | En Windows |
   | :--- | :--- | :--- |
   | Supervisión de procesos | `systemd` (`odontocrm@.service`) | **PM2 como servicio de Windows** (`pm2-installer`, corre como `LocalService`) |
   | Proxy inverso / TLS | nginx | **Caddy** (binario único, servicio propio) |
   | Certificados | `mkcert` (CA en `/etc/pki`) | **el mismo `mkcert`** + `certutil` al almacén de Windows |
   | Base de datos | PostgreSQL 18 (`postgresql.service`) | PostgreSQL 18 (servicio `postgresql-x64-18`) |
   | Tareas periódicas | `systemd` timers | **Programador de tareas** (SYSTEM) |
   | Firewall | `firewalld` | **Windows Defender Firewall** (`New-NetFirewallRule`) |
   | Permisos | `chown`/`chmod` | **ACL con `icacls`**, por **SID** (no por nombre) |
   | Secretos | `/etc/odontocrm` (0600 root:root) | `C:\ProgramData\OdontoCRM\env` (ACL: Administradores + `LocalService`) |
   | Código | `/opt/odontocrm` (solo lectura) | `C:\OdontoCRM` (solo lectura para el servicio) |
   | Comando del servidor | `odontocrm` (bash) | `odontocrm.ps1` (+ `odontocrm.cmd`) |

5. **Una sola cuenta de servicio: `NT AUTHORITY\LocalService`**, y **no se crea un usuario
   `odontocrm`.** Fue una decisión consciente por sencillez: la alternativa (un usuario local
   dedicado para calcar a Fedora) obligaba a gestionar su contraseña, el derecho «iniciar
   sesión como servicio» y a un envoltorio de servicio hecho a mano, porque `pm2-installer`
   solo instala PM2 como `LocalService`. PM2 y Caddy **comparten principal**.
6. **Consecuencia asumida de lo anterior:** la separación «proxy / aplicación» es **por
   carpeta** (ACL suaves) y no una frontera dura de permisos como en Fedora. Se documenta como
   tal; si algún día se quiere aislar de verdad, se pasa a un servicio por proceso con WinSW
   y un usuario dedicado.
7. **Sin mDNS ni DNS propio**: Windows no trae `avahi` y no se instala Bonjour. Los equipos
   entran **por IP** (el certificado la incluye). El nombre queda para el certificado y para
   `WEB_ORIGIN`, no como vía de acceso.
8. **La misma CA que en Fedora**: `mkcert` en las dos plataformas, de modo que un equipo que
   ya confía en un servidor OdontoCRM valide igual el otro.
9. **Los binarios de terceros no se versionan**: `mkcert.exe` y `caddy.exe` se descargan en
   `10-preparar.ps1` verificando su SHA-256. El modo «pendrive sin internet» queda como mejora
   futura, no como requisito.

## Consecuencias

- ✅ **Se puede desplegar en el aparato que la clínica ya tiene.** Ese era el objetivo: el
  obstáculo dejó de ser el sistema operativo.
- ✅ El código, las migraciones y los esquemas de configuración son **los mismos**; solo la
  orquestación es distinta. Un cambio en un servicio no obliga a tocar dos instaladores.
- ✅ La disciplina que costó cara en Fedora se hereda entera: idempotencia estricta, una sola
  fuente de credenciales, verificación por efecto y esperas activas.
- ⚠️ **Hay dos instaladores que mantener.** El riesgo se acota compartiendo el aprovisionador y
  la lista de servicios, y con documentación cruzada.
- ⚠️ **`LocalService` compartido** entre PM2 y Caddy: no hay aislamiento duro entre el proxy y
  los servicios. Aceptado a cambio de la sencillez del despliegue.
- ⚠️ **PM2 en Windows es menos capaz que `systemd`** (sin `Restart=always` por unidad, sin
  `ProtectSystem=`, sin journald). Se compensa con `autorestart`, límites de memoria y
  `pm2-logrotate`.
- ⚠️ **`pm2-installer` es un proyecto de terceros** que no se actualiza desde 2021 y no soporta
  `nvm-for-windows`; se fija su versión y se documenta que Node se instala «estándar».
- ⚠️ Windows se entra **por IP**: no hay nombre bonito que resolver sin tocar cada equipo.
- ⚠️ La preparación de la máquina (instalar Node, PostgreSQL y los binarios) sigue siendo un
  paso **manual/consciente** en lo que respecta a PostgreSQL: el usuario `postgres` y su
  contraseña los pone quien instala, y el aprovisionador los necesita (`--admin-url`).

## Alternativas consideradas

- **Seguir solo con Fedora.** Rechazada: convertía el sistema operativo del mostrador en el
  bloqueo del despliegue en la mayoría de las clínicas piloto.
- **Un usuario local `odontocrm` con WinSW, calcando Fedora.** Rechazada **por el usuario**, a
  cambio de sencillez: `pm2-installer` no permite elegir la cuenta, así que exigía mantener un
  envoltorio de servicio hecho a mano. Queda como camino abierto (opción A del plan) si algún
  día se quiere el aislamiento duro.
- **NSSM con un servicio por cada proceso.** Rechazada: once servicios que registrar y
  mantener, frente a uno solo con PM2.
- **nginx para Windows** (para reutilizar el `odontocrm.conf` probado). Rechazada: nginx en
  Windows no usa `epoll` y deja procesos residuales al reiniciar; Caddy es un binario único que
  corre nativo y maneja el SSE de forma trivial.
- **Caddy con su propia CA interna (`caddy trust`).** Rechazada: cambiaría la historia de la CA
  en los equipos ya desplegados. Se mantiene `mkcert` para que la CA sea la misma en Fedora y
  en Windows.
- **WSL o Docker en Windows.** Rechazada: añade una capa de virtualización que es justo lo que
  el [ADR 0001](0001-infraestructura-nativa.md) quiso evitar, y complica el acceso a la red
  local desde los demás aparatos.
- **mDNS (Bonjour) para el `.local`.** Rechazada: una dependencia extra y un servicio más para
  ganar un nombre; la IP ya va en el certificado y funciona en todos los aparatos.
