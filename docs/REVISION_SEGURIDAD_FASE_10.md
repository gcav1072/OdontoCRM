# Revisión de seguridad — Fase 10

> **Qué es.** La revisión de seguridad final que pide el plan antes de usar el sistema
> con datos reales de pacientes. No es una auditoría externa: es una **verificación
> hecha sobre la instalación que corre en el banco de pruebas**, con el comando que
> reproduce cada comprobación. Donde algo queda abierto, se dice y se explica por qué.
>
> **Fecha:** 2026-10-04 · **Ámbito:** el despliegue Fedora de `infra/fedora/INSTALL.md`
> (9 servicios, PostgreSQL del sistema, nginx con TLS interno). **No** incluye pruebas
> de penetración desde fuera de la red del consultorio.

## 1. Secretos

| Comprobación | Comando | Resultado |
| :--- | :--- | :--- |
| Ningún secreto en el repositorio | `npm run check-secrets -- --all` | ✅ **703 archivos revisados, sin secretos** |
| Ningún `.env` ni clave versionada | `git ls-files \| grep -E '\.env$\|\.key$\|\.pem$'` | ✅ vacío |
| Secretos solo en `/etc/odontocrm` | `find /opt/odontocrm -name '.env' -not -path '*/node_modules/*'` | ✅ vacío; los 9 archivos están en `/etc/odontocrm` con `0600 root:root` |
| Credenciales de respaldo | `stat -c '%a' /etc/odontocrm/.pgpass` | ✅ `600`, y con el rol administrador solo para restaurar |
| Los logs no imprimen credenciales | revisión de `services/*/src` (grep de `log` + `token`/`secret`/`password`) | ✅ no se registran; `odontocrm certificado` y `crear-rol-respaldo.sh` tampoco las imprimen |
| Un marcador de plantilla no pasa por credencial | ADR de la Fase 10 | ✅ `CAMBIAR_*` se trata como ausente (el servicio lo dice en vez de fingir que está configurado) |

## 2. Dependencias

| Comprobación | Comando | Resultado |
| :--- | :--- | :--- |
| Vulnerabilidades en producción | `npm audit --omit=dev` | ✅ **0** |
| Vulnerabilidades en desarrollo | `npm audit` | ⚠️ **4 moderadas**, todas de la cadena `drizzle-kit → @esbuild-kit/* → esbuild` (herramienta de generación de migraciones, no entra en el despliegue). El arreglo que ofrece npm es un salto mayor de `drizzle-kit`; **decisión: no forzarlo** en el cierre y revisarlo al actualizar el generador |
| Instalación reproducible | `npm ci` con `package-lock.json` versionado | ✅ |

## 3. Autenticación y sesiones

| Comprobación | Dónde | Resultado |
| :--- | :--- | :--- |
| Contraseñas con `scrypt` N=2¹⁵ | `packages/kernel/src/auth/password.ts` | ✅ (ADR 0023) |
| Bloqueo por intentos | `MAX_FAILED_ATTEMPTS = 5`, `LOCK_MINUTES = 15` | ✅ verificado en la aplicación (una cuenta llegó a bloquearse durante las pruebas) |
| Refresco con rotación y detección de reuso | ADR 0023 | ✅ |
| Cookies `Secure` + `SameSite=Lax` en producción | plantilla de `/etc/odontocrm/identity.env` | ✅ `COOKIE_SECURE=true`, `COOKIE_SAMESITE=Lax` (por eso el acceso va por HTTPS) |
| Firma `EdDSA` con claves fuera del código | `/etc/odontocrm/keys/` (`0640 root:odontocrm`) | ✅ y entran en el respaldo de configuración |

## 4. Autorización y superficie expuesta

| Comprobación | Comando | Resultado |
| :--- | :--- | :--- |
| Permisos por rol en el contrato | `packages/contracts/src/domain/rbac.ts` | ✅ 12 módulos y permisos comprobados en el gateway y en cada pantalla |
| Rutas internas protegidas | `x-internal-token` | ✅ 13 rutas lo exigen |
| El gateway **no** publica `/internal` | revisión de `apps/gateway/src/proxy.ts` | ✅ no lo proxya |
| Límite de peticiones | `apps/gateway/src/server.ts` (`max: 600` por minuto) | ✅ |
| SQL sin interpolación | regla de ESLint `no-restricted-syntax` | ✅ prohibida en el lint (Drizzle o consultas parametrizadas) |
| Servicios y base **solo en loopback** | `ss -lntp` | ✅ 5432 y 4001-4008 en `127.0.0.1` |
| Firewall: solo el proxy | `firewall-cmd --list-all` | ✅ 443 (y 80 para el redirect) a la LAN; ningún puerto interno publicado |
| SELinux en `Enforcing` sin denegaciones | `sudo odontocrm selinux` | ✅ |
| TLS | `openssl s_client` | ✅ TLS 1.2/1.3 con el certificado interno (nombre **e** IP) |
| Cabeceras de seguridad | `infra/fedora/nginx/odontocrm.conf` | ✅ `X-Content-Type-Options: nosniff`, `X-Frame-Options: SAMEORIGIN`, `Referrer-Policy: same-origin` en todas las respuestas (incluidas las de la API, porque las añade el proxy) |
| **HSTS** | — | ⚠️ **no se activa a propósito**: con un certificado interno, si el navegador lo recuerda y el certificado se reemite o cambia de CA, deja de poder entrarse **sin forma de saltarlo** desde ese equipo. Se decide no ponerlo y se documenta |
| **CSP** | — | ⚠️ pendiente: conviene fijarla cuando la identidad de marca cierre los orígenes de fuentes e imágenes, para no romper la interfaz a ciegas |

## 5. Datos clínicos

| Aspecto | Cómo está | Resultado |
| :--- | :--- | :--- |
| La historia y la sesión cerrada son inmutables | ADR 0034 y ADR 0036 | ✅ corregir = adenda/sesión enmendada, con motivo |
| Todo acto clínico queda auditado con actor y motivo | `audit_events` + outbox | ✅ verificado en las suites y en la aceptación |
| Adjuntos solo por endpoint autorizado | almacén propio + `storage` fuera del código | ✅ nada se sirve por ruta del sistema de archivos |
| Modo test no puede activarse en producción | `resolveTestMode` + `NODE_ENV=production` | ✅ con pruebas |
| Datos ficticios identificables | cédulas 90.000.000+ y banner MODO TEST | ✅ (ADR 0020 y 0042) |
| Copia de seguridad con secretos | `odontocrm respaldar --include-config` | ⚠️ el archivo **contiene** `/etc/odontocrm`: el medio externo debe ir cifrado o en un lugar protegido (P-14, sin decidir todavía) |

## 6. Lo que queda abierto (y por qué)

| Pendiente | Riesgo | Cuándo |
| :--- | :--- | :--- |
| **Copia externa del respaldo + cifrado** (P-14) | Si falla el disco, el respaldo se va con él: es el riesgo más alto de la lista | Antes de cargar datos reales |
| Confiar el certificado en cada dispositivo (P-12) | Aviso del navegador hasta que se instala la CA en cada equipo | Al montar la consulta (§13.3-bis) |
| Comprobar el acceso desde otro equipo de la LAN (P-20) | No verificado desde un equipo distinto al servidor | Prueba de la doctora con la tableta |
| Intermitencia de las suites de integración (P-34) | Ruido en el desarrollo, no afecta a la clínica | Endurecer las esperas |
| PM2 como supervisor alternativo | No ensayado (se validó `systemd`) | Solo si se elige PM2 |
| Tailscale para acceso remoto | Opcional; hoy no hay acceso desde fuera de la red | Si la clínica lo pide |
| Prueba de penetración externa | Fuera del alcance: el perímetro es el router del consultorio | Si se expone a internet |
| Cifrado del disco del servidor | El banco de pruebas no lo tiene; en la clínica hay que decidirlo antes de datos reales | En el montaje |

## 7. Cómo repetir esta revisión

```bash
cd /opt/odontocrm
sudo odontocrm verificar          # 9 servicios: unidad, puerto y /health + /ready
sudo odontocrm selinux            # denegaciones de SELinux, con su arreglo
sudo odontocrm alertas            # cola, outbox, envíos y disco
sudo odontocrm certificado        # certificado, CA y su descarga
sudo systemctl list-timers odontocrm-* # respaldos y alertas programadas

# En el repositorio (desarrollo):
npm run check-secrets -- --all    # secretos
npm run fedora:check              # plantillas del despliegue vs el código
npm run verify                    # lint, tipos, construcción y 717 pruebas
```

> Esta revisión se hizo sobre el commit del tag `fase-10`. Cualquier cambio de alcance
> (nuevo servicio, nuevo permiso, nuevo canal) obliga a repetir al menos las secciones
> 1, 4 y 5.
