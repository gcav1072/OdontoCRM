# ADR 0023 — Contraseñas de usuario con scrypt de `node:crypto`

- **Fecha:** 2026-10-02 · **Estado:** aceptada

## Contexto

Las contraseñas de los usuarios del CRM deben guardarse con un algoritmo de derivación lento y
con sal. Las opciones habituales (`argon2`, `bcrypt`) son módulos nativos: en Windows exigen
compilador de C++ o binarios precompilados que fallan al cambiar de versión de Node, y además
complican el despliegue en Fedora.

## Decisión

Usar **`scrypt` de `node:crypto`** con parámetros explícitos (N=2^15, r=8, p=1, sal aleatoria de
16 bytes por usuario), formato de almacenamiento con los parámetros embebidos
(`scrypt$N$r$p$sal$hash`) para poder migrar de algoritmo sin invalidar contraseñas, y
verificación en tiempo constante (`timingSafeEqual`).

Reglas asociadas: mínimo 10 caracteres, bloqueo de 15 minutos tras 5 intentos fallidos,
`must_change_password` obligatorio para el administrador inicial y auditoría de cada cambio.

## Consecuencias

- ✅ Cero dependencias nativas: el mismo código funciona en Windows y Fedora sin compiladores.
- ✅ Los parámetros quedan versionados en el propio hash, así que subirlos después es posible.
- ⚠️ scrypt es más lento que argon2 en hardware moderno; con los parámetros elegidos es del
  orden de decenas de milisegundos, aceptable para un consultorio.
