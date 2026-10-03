# ADR 0024 — Secretos fuera del repositorio, con escáner previo al commit

- **Fecha:** 2026-10-02 · **Estado:** aceptada

## Contexto

El sistema custodia el **token del bot de Telegram**, las credenciales de ocho bases de datos, la
clave de firma de los JWT y la contraseña del superusuario de PostgreSQL. Un secreto versionado
en Git es un secreto comprometido: sobrevive en el historial aunque se borre después. También
hay que evitar que un secreto termine en una conversación o en una captura de pantalla.

## Decisión

- **Desarrollo:** los secretos viven en archivos `.env` **ignorados por Git**; el repositorio solo
  contiene `.env.example` con marcadores. Las credenciales de cada servicio las **genera**
  `npm run db:bootstrap` (32 bytes aleatorios) y nunca se imprimen en pantalla.
- **Producción (Fedora):** `/etc/odontocrm/<servicio>.env` con permisos `0600` y propietario
  `root`, cargados por `systemd` mediante `EnvironmentFile=`.
- **Verificación automática:** `tools/check-secrets.mjs` corre en `npm run verify` y busca tokens
  de Telegram, claves PEM, cadenas de conexión con contraseña, claves de AWS y de GitHub, y
  archivos que nunca deben versionarse. Informa archivo y línea, **jamás el valor**.
- **Logs:** lista de campos censurados (`password`, `token`, `authorization`, `cookie`,
  `DATABASE_URL`, …) y los errores de configuración no repiten el valor recibido.
- **Entrega del token:** el interesado lo escribe en el archivo, no en el chat; el agente lo lee
  del entorno y no lo muestra. Procedimiento completo en
  [`../SEGURIDAD_SECRETOS.md`](../SEGURIDAD_SECRETOS.md).

## Consecuencias

- ✅ Un descuido razonable no termina en el historial de Git.
- ✅ La rotación está documentada (BotFather `/revoke`, `ALTER ROLE … PASSWORD`, regenerar claves).
- ⚠️ Los `.env` deben incluirse en el respaldo seguro del servidor (Fase 10) y excluirse de
  cualquier sincronización con la nube.
