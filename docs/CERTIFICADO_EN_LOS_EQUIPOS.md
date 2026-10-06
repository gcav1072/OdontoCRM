# Instalar el certificado en los equipos

> **Para qué es esto.** El servidor del consultorio usa un certificado **interno**
> (firmado por su propia autoridad). Los equipos de la red no lo conocen la primera
> vez, así que el navegador avisa «La conexión no es privada». Se arregla **una sola
> vez por equipo** instalando esa autoridad (la **CA**) en el equipo. Después el
> candado sale normal y nadie vuelve a ver el aviso.
>
> **Quién lo hace.** Cualquier persona puede hacerlo en su propio equipo (tablet,
> móvil, PC). No hace falta ser informático, pero hay que seguir los pasos del sistema
> que corresponda. En iPhone/iPad y en Linux hay un paso que se olvida y hace que
> «no funcione» aunque parezca instalado.

---

## 0. Resumen: qué necesita cada aparato

Se instalan **dos** cosas, y son problemas distintos: **resolver el nombre** y **confiar en
el certificado**. Esto es lo que le toca a cada uno:

| Aparato | Nombre | Certificado | El paso que se olvida |
| :--- | :--- | :--- | :--- |
| **Android** (tablet/móvil) | **NO resuelve `.local`** (comprobado en un Pixel 7 y un Redmi Note 8 Pro: el certificado se instala bien y por IP entra segura, pero el nombre no) → **DNS propio** o IP | `http://<IP>/ca.crt` → Ajustes → Seguridad → Cifrado y credenciales → Instalar un certificado → **Certificado de CA** | Android 7+ **no** confía en las CA de usuario para las *apps* (el navegador sí); y para el nombre: `sudo odontocrm red --arreglar` deja el DNS al día, y el móvil tiene que usar este servidor como DNS **y con «DNS privado» desactivado** |
| **iPhone / iPad** | mDNS ✓ (funciona `.local`) | `http://<IP>/odontocrm.mobileconfig` **abierto con Safari** → Ajustes → Perfil descargado → Instalar | Ajustes → General → Información → **Ajustes de confianza de certificados → activar** |
| **Windows 10/11** | `.local` a veces no resuelve (mDNS irregular) → IP, DNS propio o `hosts` | `http://<IP>/ca.der` (doble clic) o `irm http://<IP>/ca-windows.ps1 \| iex` en PowerShell como administrador | Hay que instalarlo en **Equipo local** → *Entidades de certificación raíz de confianza* |
| **macOS** | mDNS ✓ | `http://<IP>/odontocrm.mobileconfig` → Ajustes → Perfil descargado | En Llaveros, marcar la CA como **«Confiar siempre»** |
| **Linux** (Fedora/Debian/Arch) | mDNS ✓ con `nss-mdns` | `curl -fsSL http://<IP>/ca-linux.sh \| sudo bash` | **Firefox** usa su propio almacén: `security.enterprise_roots.enabled` |
| **Televisor / Android TV** | — | Por USB (ver §8) | Muchos no permiten instalar CA: queda la IP y aceptar el aviso |

> **Con tablets Android en la consulta, el nombre `.local` no basta** (su navegador no lo
> resuelve y no se puede editar el `hosts` sin root): monta el DNS propio con
> `sudo bash infra/fedora/nombre/instalar-dns.sh` (INSTALL §13.2-ter) o usa la IP.

Y el comando que lo cuenta todo desde el servidor, incluidos los enlaces:

```bash
sudo odontocrm certificado      # formato de cada plataforma + comprobación de que se sirven
sudo odontocrm nombre           # cómo entran los equipos: mDNS, DNS propio o IP
```

## 1. Dónde se descarga

En **el propio equipo** que hay que configurar, abrir esta dirección (con `http://`, no
`https://`):

```
http://<IP-del-servidor>/ca.crt
```

Por ejemplo: `http://192.168.1.50/ca.crt`.

- La IP exacta la dice quien administra el servidor, o la imprime el propio servidor con
  `sudo odontocrm certificado`.
- Se descarga un archivo pequeño (`odontocrm-ca.crt`). **No hay que abrirlo**: se
  instala como autoridad de certificación con los pasos de abajo.
- Va por HTTP **a propósito**: hay que poder descargar el certificado **antes** de que
  el navegador confíe en él. Es un certificado **público**, no un secreto.
- También se pueden llevar los archivos en una memoria USB: quien administra los deja
  con `sudo odontocrm certificado --exportar /ruta` (salen `odontocrm-ca.crt` y
  `odontocrm-ca.pem`, el mismo certificado).

**La aplicación, una vez instalado el certificado:**

| Dirección | Cuándo usarla |
| :--- | :--- |
| `https://odontocrm.local` | El nombre del servidor. Necesita una línea en el archivo *hosts* de cada equipo (o DNS en la red) |
| `https://<IP-del-servidor>` | La IP. Funciona en cualquier equipo **sin tocar nada**, porque el certificado incluye la IP |

---

## 2. Android (tablet o móvil)

1. Descargar `http://<IP>/ca.crt` (el aviso de «no es segura» es esperado).
2. **Ajustes** → **Seguridad** → **Cifrado y credenciales** → **Instalar un
   certificado** → **Certificado de CA** → elegir el archivo descargado.
   (En algunas versiones el camino es **Ajustes** → **Seguridad** → **Cifrado y
   credenciales** → **Instalar desde almacenamiento**.)
3. Android avisa de que «la red podría supervisarse» y pide confirmar: es tu propio
   servidor, se acepta. Puede pedir el PIN o patrón de la pantalla.
4. Cerrar **todas** las pestañas del navegador y volver a abrir la dirección del
   consultorio.

**Comprobar:** el candado aparece normal y ya no sale el aviso rojo.
**Ojo:** los equipos con **Android 11 o superior** siguen mostrando el aviso dentro de
algunas aplicaciones (no en el navegador): es una limitación de Android con las CA
instaladas por el usuario, no un fallo del servidor.

---

## 3. iPhone / iPad

1. Con **Safari** (con Chrome no se ofrece el perfil), abrir
   `http://<IP>/odontocrm.mobileconfig` y aceptar **Permitir**. Es la vía de un toque: el
   perfil lleva la CA dentro. (Alternativa: `http://<IP>/ca.crt`, que queda en
   **Archivos** → **Descargas**.)
2. **Ajustes** → **General** → **VPN y gestión de dispositivos** → aparece el perfil
   descargado → **Instalar** (pide el código del dispositivo).
3. **Ajustes** → **General** → **Información** → **Ajustes de confianza de
   certificados** → **activar el interruptor** del certificado.

> ⚠️ **El paso 3 no se puede saltar.** Sin él el certificado está instalado pero iOS
> **no confía** en él, y el aviso sigue saliendo. Es el error más común con iPhone.

**Comprobar:** abrir `https://<IP-del-servidor>` y ver el candado.

---

## 4. Windows

1. Descargar el archivo y hacer **doble clic** → **Instalar certificado**.
2. **Ubicación del almacén**: **Equipo local** (pide permisos de administrador) →
   **Siguiente**.
3. **Colocar todos los certificados en el siguiente almacén** → **Examinar** →
   **Entidades de certificación raíz de confianza** → **Aceptar** → **Siguiente** →
   **Finalizar**.
4. Windows avisa de que va a instalar un certificado de una entidad no verificada: es
   el del consultorio, se acepta.
5. Cerrar el navegador **por completo** (todas las ventanas) y volver a abrirlo.

**Si se usa Chrome o Edge, ya está** (usan el almacén de Windows). **Firefox** tiene el
suyo propio: ver §7.

**Comprobar:** `https://<IP-del-servidor>` con candado.

---

## 5. macOS

1. Abrir el archivo `odontocrm-ca.crt` descargado → se añade al Llavero **Sistema**
   (si pregunta, elegir «Sistema» y no «Inicio de sesión»).
2. Abrir **Acceso a Llaveros** → **Sistema** → doble clic en el certificado →
   desplegar **Confiar** → en **Al usar este certificado** elegir **Confiar siempre**.
3. Cerrar y volver a abrir el navegador.

**Comprobar:** `https://<IP-del-servidor>` con candado. Safari y Chrome usan el Llavero
del sistema; **Firefox** es aparte (§7).

---

## 6. Linux (Arch, Fedora, Ubuntu/Debian…)

Cada distribución guarda las CA de confianza en un sitio distinto, pero la idea es la
misma: **copiar el archivo a la carpeta de anclas y regenerar el almacén**. Después,
los navegadores que usan el almacén del sistema (Chrome/Chromium, y Firefox si se
activa, ver §7) dejan de avisar.

### Arch Linux

```bash
# 1) Descargar el certificado (o copiarlo desde una memoria USB)
curl -O http://192.168.1.50/ca.crt          # ajusta la IP

# 2) Instalarlo en el almacén del sistema (p11-kit; viene con ca-certificates-utils)
sudo trust anchor --store ca.crt

# Alternativa equivalente (más clásica):
sudo cp ca.crt /etc/ca-certificates/trust-source/anchors/odontocrm-ca.crt
sudo update-ca-trust

# 3) Comprobar sin -k: tiene que responder sin quejarse del certificado
curl -sI https://192.168.1.50/ | head -1
```

### Fedora / Red Hat

```bash
sudo cp ca.crt /etc/pki/ca-trust/source/anchors/odontocrm-ca.crt
sudo update-ca-trust
curl -sI https://192.168.1.50/ | head -1
```

### Ubuntu / Debian

```bash
sudo cp ca.crt /usr/local/share/ca-certificates/odontocrm-ca.crt
sudo update-ca-certificates
curl -sI https://192.168.1.50/ | head -1
```

### Comprobar que el certificado se validó de verdad

```bash
# Sin -k: si el candado está bien, responde 200; si no, error de certificado
curl -sI https://192.168.1.50/ | head -1

# Ver la cadena completa (sirve para cualquier distribución)
openssl s_client -connect 192.168.1.50:443 -servername odontocrm.local </dev/null 2>/dev/null |
  openssl x509 -noout -subject -issuer -dates
```

> **En Arch, si usas Chromium/Chrome**, puede que siga avisando hasta que reinicies el
> navegador **por completo** (`pkill chromium`) o, si tu perfil usa el almacén propio de
> NSS, lo añadas ahí (ver §7).

---

## 7. Firefox (en cualquier sistema)

Firefox tiene su **propio** almacén de certificados. Dos formas:

- **La fácil** (usar el almacén del sistema, recomendado): abrir `about:config`,
  aceptar el aviso, buscar `security.enterprise_roots.enabled` y ponerlo en **true**.
  Reiniciar Firefox. A partir de ahí confía en las CA que ya instalaste en el sistema.
- **A mano**: **Ajustes** → **Privacidad y seguridad** → **Certificados** → **Ver
  certificados** → pestaña **Autoridades** → **Importar** → elegir `odontocrm-ca.crt` →
  marcar **Confiar en esta CA para identificar sitios web**.

En **Chrome/Chromium en Linux** que usen el almacén propio de NSS (perfil antiguo):

```bash
# Requiere el paquete `nss` (en Arch: sudo pacman -S nss)
certutil -d sql:$HOME/.pki/nssdb -A -t "C,," -n odontocrm -i ca.crt
```

---

## 8. Televisor (Smart TV, Android TV, Apple TV)

Muchos televisores **no permiten** instalar una CA. Salidas honestas, en orden de
preferencia:

1. **Android TV / Google TV**: suele permitirlo en **Ajustes** → **Seguridad y
   restricciones** → **Credenciales** → **Instalar certificado** → **CA**.
2. **Poner un mini-PC o una tablet** a la pantalla (una Raspberry Pi, un mini-PC
   barato o una tablet vieja): entra por el navegador como cualquier equipo y además
   permite el audio de los llamados.
3. **Dominio real con certificado de Let's Encrypt** (por DNS-01): lo configura quien
   administra el servidor; entonces **cualquier** equipo entra sin instalar nada.

Lo que **no** se hace nunca es desactivar la validación del servidor «para que
funcione»: eso quita la protección justo donde circulan los datos clínicos, y en una red
compartida cualquiera podría hacerse pasar por el servidor.

---

## 9. Si no se quiere instalar nada

Se puede aceptar el aviso en cada equipo (**Avanzado** → **Continuar a …**). La
aplicación funciona igual, pero:

- el candado queda tachado y el navegador avisa **cada vez**;
- sin validar el certificado, cualquiera en la misma red podría suplantar al servidor.

Para el consultorio, instalar la CA es lo correcto; aceptar el aviso es aceptable solo
como prueba puntual.

---

## 9-bis. El servidor cambió de red (otro wifi, otro router)

Cuando el servidor se conecta a **otra red**, su IP cambia y hay **tres cosas** que se
quedan apuntando a la red anterior. El síntoma típico: desde el servidor entra
perfecto, pero desde otro equipo «no carga» o «la contraseña no vale».

```bash
sudo odontocrm red
```

Ese comando dice la **IP actual**, las direcciones para entrar (`https://odontocrm.local`
y `https://<IP>`) y comprueba las tres cosas:

| Qué | Por qué falla | Cómo se arregla |
| :--- | :--- | :--- |
| **`firewalld`** | La regla de 443 se puso para la red anterior (`192.168.9.0/24`), así que la nueva no entra | El mismo comando dice la red actual y el comando exacto |
| **El certificado** | Se emitió con la IP anterior: el navegador avisa de que no es válido para esa dirección | Reemitirlo (un minuto) |
| **`WEB_ORIGIN`** (CORS) | Solo admite el nombre y la IP anterior. Es el CORS del gateway: con la SPA y la API en el mismo origen (nginx) **no bloquea nada**; importa si sirves la interfaz desde otro sitio | Añadir la IP nueva a la lista |

Los tres se arreglan de una vez:

```bash
sudo bash /opt/odontocrm/infra/fedora/ensayo-despliegue.sh --hasta=tls --lan-cidr=192.168.1.0/24
```

> **Lo mejor: que el nombre funcione solo.** Con `odontocrm.local` publicado por **mDNS**
> (el instalador base lo hace con `--nombre-mdns=odontocrm`), los equipos lo resuelven sin
> tocar nada… **si la red deja pasar la multidifusión y el equipo sabe mDNS**. Dos avisos
> que importan en una consulta:
>
> - En Android **no funciona** `.local` (probado en un Pixel 7 y un Redmi Note 8 Pro, con el
>   certificado ya instalado: la IP entra segura, el nombre no): su resolutor no hace mDNS y
>   Chrome consulta a su propio DNS. El camino es el **DNS propio**:
>   `sudo bash infra/fedora/nombre/instalar-dns.sh` (o `sudo odontocrm red --arreglar`, que
>   lo deja con la IP de ahora) y decirle al router —o a cada móvil— que use esa IP como DNS,
>   con el **«DNS privado» desactivado**. Funciona en todos los aparatos, Android incluidos.
> - Las wifi de invitados y las redes con aislamiento de clientes **filtran la
>   multidifusión**: ahí el nombre no resuelve aunque el servidor esté perfecto. Se
>   comprueba con `sudo odontocrm nombre`.
>
> Con el nombre funcionando, entra siempre por él: no cambia cuando cambia la red; la IP, sí.
> Y si no hay manera, **la IP siempre funciona** (el certificado la incluye).
>
> Y si algún equipo no resuelve mDNS (algunos Android antiguos), ahí sí toca la línea en
> su `hosts` apuntando a la IP del momento — o mejor, reserva la IP en el router para que
> no cambie nunca.
>
> **El arreglo completo de una red nueva:** `sudo odontocrm red --arreglar` (firewall por
> zona, certificado con la IP de ahora y `WEB_ORIGIN`; la CA no cambia, así que los
> equipos no tocan nada).

---

## 10. Problemas típicos

| Síntoma | Causa | Solución |
| :--- | :--- | :--- |
| La página `http://<IP>/ca.crt` dice **«no encontrada»** | La configuración instalada del proxy es anterior a que existiera esa página | `sudo odontocrm actualizar` y `sudo bash /opt/odontocrm/infra/fedora/nginx/instalar.sh` |
| Dice **403 Forbidden** en texto plano | La configuración apunta a `/etc/odontocrm`, que nginx no puede leer | Igual que el anterior: el instalador publica la CA en `/var/www/odontocrm/ca/` |
| Instalé el certificado y **sigue avisando** (iPhone/iPad) | Falta activar la confianza | §3, paso 3 |
| Instalé el certificado y **sigue avisando** (Firefox) | Firefox usa su propio almacén | §7 |
| Instalé el certificado y **sigue avisando** (Linux) | Navegador abierto de antes, o perfil NSS propio | Reiniciar el navegador por completo; §6 y §7 |
| Funciona en el PC pero no en la tablet | La tablet está en **otra red** (invitados, 5 GHz distinto, datos móviles) | Comprobar que está en la misma red del consultorio |
| El certificado «caducó» | El certificado del servidor se emitió con validez de 3 años | Quien administra lo reemite (INSTALL §13.2) y **no** hay que reinstalar la CA |

---

## Ver también

- [`../infra/fedora/INSTALL.md`](../infra/fedora/INSTALL.md) §13.3-bis — cómo se emite el
  certificado y cómo se sirve la CA (la parte del servidor).
- [`OPERACION_CLINICA.md`](OPERACION_CLINICA.md) §1 — la guía del día a día en el consultorio.
- [`COMANDOS_PRODUCCION.md`](COMANDOS_PRODUCCION.md) §6 — `sudo odontocrm certificado`.
