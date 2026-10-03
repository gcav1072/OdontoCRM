# ADR 0021 — Acceso remoto por VPN mesh; el sistema nunca se expone a internet

- **Fecha:** 2026-10-02 · **Estado:** aceptada

## Contexto

El sistema arranca en la red local del consultorio, pero más adelante se quiere usar desde
fuera. Publicar el servidor en internet implica certificados, hardening, intentos de acceso
constantes y datos clínicos expuestos a un riesgo que un consultorio no puede gestionar.

## Decisión

El acceso remoto se hará por **VPN mesh (Tailscale o WireGuard)**: los dispositivos autorizados
entran como si estuvieran en la red local y **el servidor sigue sin abrir puertos a internet**.
El diseño actual ya lo contempla:

- toda la configuración es por **variables de entorno** y sin IPs fijas en el código;
- los servicios escuchan en `127.0.0.1` y **solo el gateway** se publica a la red;
- TLS interno (certificado propio) para que las cookies `Secure` funcionen dentro de la VPN;
- `firewalld` abre únicamente el puerto del reverse proxy ([`infra/fedora`](../../infra/fedora/INSTALL.md)).

Como el bot de Telegram usa **long polling** ([ADR 0008](0008-bot-unico-long-polling.md)),
tampoco necesita exponer nada a internet.

## Consecuencias

- ✅ Superficie de ataque mínima: no hay servicio publicado a internet que escanear.
- ✅ Sin coste de certificados públicos ni de mantenimiento de un dominio.
- ⚠️ Cada dispositivo remoto (teléfono, portátil del doctor) debe tener el cliente VPN instalado
  y autorizado.
- ⚠️ Si algún día se quiere acceso por navegador sin VPN, la alternativa evaluada es Cloudflare
  Tunnel, que se decide como cambio de esta ADR.
