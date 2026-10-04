# Fedora — arrancar OdontoCRM para desarrollar y probar

> **Para qué es esta guía.** Deja el repositorio andando en la **PC Fedora de pruebas**: el banco de
> ensayo donde se implementa y se valida la Fase 10 antes de tocar la máquina de la clínica.
>
> **Para la instalación de producción** (la tercera PC, la del consultorio) la guía es
> [`INSTALL.md`](INSTALL.md): usuario de sistema, `systemd`, `firewalld`, SELinux, TLS interno,
> Tailscale y respaldos. Aquí se **ensaya** todo eso; allí se instala de verdad.

---

## 0. Qué se valida en cada máquina

| | PC Fedora de pruebas (esta guía) | PC de la clínica ([`INSTALL.md`](INSTALL.md)) |
| :--- | :--- | :--- |
| Desarrollo y pruebas (`npm run dev`, `verify`, smokes, e2e) | ✅ aquí | — |
| `systemd`, `firewalld`, SELinux, TLS interno | ✅ se ensayan aquí | ✅ se instalan de verdad |
| Respaldo `pg_dump` y **restauración probada** | ✅ se ensayan | ✅ respaldo diario programado |
| Tablet de la LAN entrando por HTTPS | ⚠️ solo si la tablet está en la misma red | ✅ criterio de aceptación de la Fase 10 |
| Tailscale y acceso remoto | opcional | cuando haga falta |
| Datos | ficticios (modo test) | **reales**: nunca se siembra ni se resetea |

> Nada de lo que se haga aquí debe tocar la PC de la clínica: cada máquina tiene sus propias bases,
> sus propias claves EdDSA y sus propios secretos. Lo único que viaja entre las dos es el **código**
> (git) y el **runbook** que salga de aquí.

---

## 1. Paquetes

Sigue [`INSTALL.md`](INSTALL.md) §4 (paquetes base), §5 (Node.js 26, `npm` y PM2) y §6 (PostgreSQL 18).
Del §4 interesan además las **dependencias de Chromium**, porque el récipe A5, el PDF de los reportes
y las pruebas de punta a punta las necesitan.

```bash
node --version        # v26.x
npm --version
psql --version        # psql (PostgreSQL) 18.x
npx playwright --version
```

---

## 2. Traer el código (una sola vez)

```bash
git clone https://github.com/gcav1072/OdontoCRM.git odontocrm
cd odontocrm
git tag --list 'fase-*' | tail -3        # fase-7, fase-8, fase-9

# La Fase 10 se trabaja en su propia rama (plan §14: una rama por fase).
git switch fase/10-modo-test-y-fedora    # si aún no existiera: git switch -c fase/10-modo-test-y-fedora origin/main

npm ci
```

Para partir del cierre verificado de la fase anterior: `git switch --detach fase-9`.

---

## 3. Configurar y sembrar

```bash
cp .env.example .env
# Edita PG_ADMIN_URL con la contraseña del superusuario `postgres` de PostgreSQL 18
# (si lleva @ : / ? # hay que codificarla en porcentaje).
npm run env:check        # ¿a algún .env le falta una clave de su plantilla?

npm run db:bootstrap     # 8 bases + 8 roles + la cola de eventos compartida (idempotente)
npm run keys:generate    # claves EdDSA del JWT (una vez por instalación; .keys/ está ignorado)
npm run db:migrate       # migraciones de los 9 servicios
npm run seed:users       # admin, recepcion y egomez con contraseña temporal
npm run seed:demo        # 200 pacientes ficticios (cédulas 90.000.000+)
npm run seed:agenda -- --reset

npx playwright install chromium
npm run verify           # check-secrets + lint + formato + tipos + build + 580 pruebas
```

Si algo se tuerce, `npm run db:reset -- --yes` borra las 9 bases y `storage/` y lo deja migrado y
sembrado (solo desde consola, y fuera de la máquina de la clínica).

---

## 4. La pila

Una sola pila a la vez ([ADR 0037](../../docs/adr/0037-una-sola-pila-a-la-vez.md)): los puertos son la
fuente de verdad.

```bash
npm run stack:status     # ¿qué corre y desde cuándo?
npm run stack:dev        # 9 servicios + gateway + interfaz, con recarga (equivalente a `npm run dev`)
npm run stack:fijo       # compila y arranca con PM2 (sin recarga)
npm run stack:down       # parar todo y liberar los puertos
```

- Interfaz: <http://127.0.0.1:5173> · Puerta: <http://127.0.0.1:8090/health>
- Logs de PM2: `pm2 logs odontocrm-reporting` (o el servicio que sea).

---

## 5. Pruebas

| Comando | Necesita | Qué comprueba |
| :--- | :--- | :--- |
| `npm test` | nada | Unitarias y de contrato (580) |
| `npm run test:integration` | PostgreSQL + `build` | 695 pruebas contra bases reales (20 s; a la suite de reportes le crea una base temporal propia) |
| `npm run db:verify-migrations` | `build` + `PG_ADMIN_URL` | Migraciones de los 8 servicios desde cero en bases limpias |
| `npm run audit` | pila arriba | Eventos, rutas ↔ gateway ↔ web, permisos y colas conectados como deben |
| `npm run smoke:<módulo>` | pila + datos sembrados | `auth`, `patients`, `agenda`, `notifications`, `screens`, `odontogram`, `clinical`, `prescription`, `reporting` |
| `npm run e2e:flujo` | pila + Chromium | El día completo en `/flujo` |
| `npm run e2e:reportes` | pila + Chromium | `/reportes` y `/auditoria` (deja captura en `tmp/`) |
| `npm run reports:latencia` | pila | Los seis reportes con 10.000 citas (< 2 s cada uno) |
| `npm run telegram:menu` | token del bot | El menú de comandos registrado en Telegram |

> Las pruebas de humo y los e2e **cambian contraseñas sembradas**: al terminar, `npm run seed:users --
> --reset`. El token del bot vive solo en `services/notifications/.env` (nunca en el repo ni en un chat).

---

## 6. Diferencias con Windows que ya nos mordieron

1. **El gateway escucha en 8090**, no en 8080 (en Windows el 8080 lo ocupa Hyper-V).
2. Sobre **HTTP hay que dejar `COOKIE_SECURE=false`**; el `.env.example` ya lo trae así. En producción,
   con TLS, se pone `true`.
3. **`TZ=America/Caracas`** en todos los `.env`: la edad, el día de la jornada y los reportes dependen
   de eso (la edad se calcula en UTC a propósito, ver hallazgo de la Fase 2).
4. **Chromium**: los servicios `clinical` y `reporting` lanzan el navegador con `--no-sandbox` y
   reutilizan **un navegador por proceso**; si falta, el PDF responde 503 y el humo lo dice.
5. **Fin de línea**: `.gitattributes` fija `eol=lf`. Si algo se editó en Windows, `git diff --check`.
6. **Los `.ps1` de `infra/windows/` no aplican** aquí: su equivalente es `npm run stack:*`.
7. **SELinux**: para el modo desarrollo no molesta (todo escucha en loopback y nada lo sirve desde
   `httpd`). Solo aparece al ensayar el reverse proxy: ver §12 de `INSTALL.md`
   (`setsebool -P httpd_can_network_connect on`).

---

## 7. Ensayo de la parte de sistema (sin tocar la clínica)

Todo esto se puede probar **en esta misma PC** antes de la instalación oficial, siguiendo
[`INSTALL.md`](INSTALL.md) sección por sección:

| Sección | Qué se ensaya | Cómo se comprueba |
| :--- | :--- | :--- |
| §7 | Usuario de sistema y layout de directorios | `ls -l /opt/odontocrm /etc/odontocrm` |
| §8 | Secretos en `/etc/odontocrm/*.env` con `0600` y `root` | `ls -l /etc/odontocrm` |
| §9 | Despliegue del código y compilación | `npm ci && npm run build` |
| §10 | `systemd` (las units de `infra/fedora/systemd/`) | `systemctl reboot` y luego los 9 servicios en `systemctl status` |
| §11 | `firewalld`: **solo** el puerto del proxy | `sudo firewall-cmd --list-all` |
| §12 | SELinux | `sudo setsebool -P httpd_can_network_connect on` + `ausearch -m avc -ts recent` |
| §13 | TLS interno con `mkcert` + Caddy y la cookie `Secure` | Candado en el navegador + `curl -kI https://…` |
| §15–16 | Respaldo `pg_dump` y **restauración en base limpia** | `odontocrm-backup.sh` → `odontocrm-restore.sh` y contar filas |
| §17 | Lista de comprobación final | Una por una |
| §20 | **Registro de verificación de la Fase 10** | Se rellena con la evidencia de esta PC y se repite en la de la clínica |

La instalación oficial en la tercera PC se hace **repitiendo este mismo recorrido con
`INSTALL.md` como única guía**: si algo hay que explicar por fuera, la guía se corrige aquí.

---

## 8. Qué traer de vuelta

- Salida de `npm run verify`, `npm run test:integration`, `npm run db:verify-migrations` y `npm run audit`.
- Evidencia de `systemd` tras reiniciar, `firewall-cmd --list-all`, SELinux (`getenforce` + `ausearch`)
  y TLS (curl + captura).
- La prueba de restauración: base limpia, `\dt`, y el conteo de una tabla con datos (`patients`, `audit_events`).
- El **§20 de `INSTALL.md`** rellenado, que es el registro de la Fase 10.
