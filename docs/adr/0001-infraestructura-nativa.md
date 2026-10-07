# ADR 0001 — Desarrollo nativo sin Docker; producción en Fedora

- **Fecha:** 2026-10-02 · **Estado:** aceptada · **Ampliada por la [0050](0050-windows-segundo-destino-de-produccion.md)**
  (Windows pasa a ser un segundo destino de producción, no solo de desarrollo)

## Contexto

La máquina de desarrollo es Windows 11 con Node 26, Git y PostgreSQL 18, sin Docker ni WSL
instalados. El destino final es un servidor de la clínica que será **Fedora Linux**. Se busca
empezar a trabajar ya, sin sumar capas de virtualización ni mantenimiento extra.

## Decisión

Desarrollo y pruebas **nativos en Windows**; producción **nativa en Fedora**, con
documentación y scripts de instalación en `infra/windows/` e `infra/fedora/`. La
configuración depende exclusivamente de variables de entorno y rutas resueltas con
`node:path`, de modo que el mismo código corre en ambos sistemas.

## Consecuencias

- ✅ Se arranca sin instalar Docker; menos consumo de recursos y menos piezas que explicar.
- ✅ Windows y Fedora comparten el mismo código y las mismas migraciones.
- ⚠️ Hay que vigilar las diferencias entre sistemas (rutas, permisos, fin de línea — cubierto
  con `.gitattributes`) y probar en Fedora en la Fase 10.
- ⚠️ Si más adelante se quiere Docker, la arquitectura ya es portable (un contenedor por
  servicio y una base por servicio).
- ➕ **Ampliación (2026-10-06).** "Producción en Fedora" pasa a "producción en Fedora **o
  Windows**": el [ADR 0050](0050-windows-segundo-destino-de-produccion.md) añade Windows como
  segundo destino soportado, porque los equipos de las clínicas piloto son Windows. El código
  y las migraciones siguen siendo los mismos; lo que cambia por sistema es la orquestación
  (PM2 y Caddy en Windows, `systemd` y nginx en Fedora).
