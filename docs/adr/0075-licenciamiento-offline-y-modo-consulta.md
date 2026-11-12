# 0075 — Licenciamiento offline y modo consulta

- **Fecha:** 2026-11-11 · **Estado:** propuesta (implementación en curso)

## Contexto

El producto se instala **en el servidor del consultorio**: red local, sin exponer
nada a internet, con acceso `root` para quien administra la máquina. Se vende a
clínicas que no siempre tienen internet estable, así que cualquier control de
licencia tiene que funcionar **de forma offline**. Hasta ahora no existía ningún
mecanismo: ni periodo de prueba, ni forma de emitir o renovar una licencia.

Los datos clínicos y fiscales son del consultorio y de sus pacientes. Un control
comercial no puede dejar a la clínica sin acceso a sus historias, récipes o
facturas: **lo único que se puede restringir es escribir**, nunca leer, imprimir,
exportar ni verificar documentos.

## Decisión

1. **La licencia es un JWT EdDSA firmado por el proveedor** (mismo `jose` y
   misma curva que los JWT de sesión, con **otro par de claves**). El formato y
   los claims viven en `@odontocrm/contracts` (`licenseClaimsSchema`) y la
   verificación criptográfica en `@odontocrm/kernel` (`verifyLicenseToken`). No
   se usa `exp`: el vencimiento es un claim normal (`venceEn`) para que la app
   distinga «firma inválida» de «licencia vencida».
2. **La clave privada no sale de la máquina del proveedor.** La pública viaja
   con la app en `assets/licencias/licencia-publica.pem` (se versiona; no es
   secreta). La privada, el registro de emisiones y los `.lic` viven fuera del
   repo (`~/.config/odontocrm/licencias/`, `~/.local/share/odontocrm/licencias/`
   o `%APPDATA%`/`%LOCALAPPDATA%` en Windows) y se respaldan aparte. Un
   repositorio aparte no aporta seguridad: el consultorio ya tiene el código de
   la app en `/opt/odontocrm`, y sin la clave privada no se puede firmar nada.
3. **Una instalación es un consultorio.** `identity` guarda una fila singleton
   `installation` con `installation_id` (UUID), fecha de instalación, licencia
   verificada y `last_seen_at`. La licencia lleva el `instalacion` y activarla en
   otra instalación se rechaza. Un respaldo restaurado conserva la licencia.
4. **Estados comerciales:** prueba de **30 días desde la instalación**
   (automática, con el producto completo), licencias **mensual (30 días)**,
   **trimestral (90)** y **anual (365)** —con avisos a 7/3/1 días y modo consulta
   al vencer, sin gracia— y, desde el [ADR 0076](0076-licencias-vitalicias.md),
   también licencias **vitalicias** sin vencimiento.
5. **Revocar = no renovar.** En offline no existe revocación remota; el
   vencimiento es el mecanismo. Renovar antes de tiempo **suma** los días al
   vencimiento vigente (`max(ahora, vencimiento) + días`), para no perder días.
6. **Modo consulta = menos permisos, no otro guardia.** Al emitir el token, si
   el estado es de solo lectura se filtran los permisos de escritura
   (`readOnlyPermissions`): los 9 servicios ya comprueban permisos, así que no
   se toca ninguno. Se conserva `licensing:manage` para que el admin pueda
   activar. Leer, imprimir, exportar y los enlaces de verificación siguen
   funcionando.
7. **Aviso en el borde y en las herramientas.** `identity` publica
   `GET /api/v1/licensing/public` (sin sesión, para el banner del login) y las
   rutas de estado/activación; el gateway lo expone. El botón de la SPA vive en
   `/licencia` (solo admin) y el banner en toda la app. El **bot de
   administración del consultorio** muestra el estado en `/estado`, atiende
   `/licencia` y **activa reenviando el archivo `.lic`** (activar solo verifica
   una firma). El tablero `npm run estado` muestra la licencia; no se añade a
   las alertas de 5 minutos para no repetir el aviso.
8. **El proveedor emite desde su máquina**, con un CLI (`npm run licencia`) y un
   **bot de Telegram propio** (otro bot, otro token, la clave solo de su lado):
   reenvía la solicitud `ODO-REQ1.…` que genera el consultorio, responde el tipo
   y recibe el `.lic` para reenviarlo. El bot de administración del consultorio
   **no puede emitir ni revocar**: ni la clave ni la operación viven ahí.
9. **Contra el reloj atrasado**, `last_seen_at` es un marcador que solo avanza:
   si el reloj retrocede más de 24 h, la instalación pasa a modo consulta y lo
   avisa.
10. **El software de licencias vive en este mismo repo**, en `tools/licencia*`,
    `tools/lib/licencia-*` e `infra/licencias/`, con los secretos y datos fuera.
    El formato compartido entre emisor y verificador es un contrato de
    `packages/contracts`, y hay una prueba de ida y vuelta (firmar→verificar) en
    el mismo CI; separar el emisor en otro repositorio obligaría a versionar el
    formato dos veces y no escondería nada al cliente.

## Consecuencias

- El periodo de prueba no exige ningún trámite: nace en la migración que crea la
  fila `installation`. Una instalación que ya estaba en uso recibe su licencia
  del proveedor al desplegar esta versión.
- Se acepta que **reinstalar de cero reinicia la prueba** y que quien tiene
  `root` sobre el servidor puede parchear la app: la licencia disuade al cliente
  honesto y ordena la renovación, no es DRM. Atar la licencia al
  `installation_id` evita reutilizar un `.lic` filtrado en otra instalación.
- Un token de sesión ya emitido conserva la escritura hasta 15 minutos después
  del vencimiento; se considera aceptable (el siguiente refresco lo degrada).
- No se crea un servicio nuevo: `identity` es la dueña del estado y el gateway
  gana dos líneas (ruta y ruta pública). El instalador, las unidades de systemd,
  el temporizador de alertas y los otros servicios no cambian.
- Sin la clave pública en el asset, la app funciona en prueba y modo consulta,
  pero la activación responde con un error claro que dice cómo generar el par.
- Si algún día hace falta revocación inmediata o telemetría, se añade validación
  en línea reutilizando **el mismo formato de licencia**; hoy no se necesita.
