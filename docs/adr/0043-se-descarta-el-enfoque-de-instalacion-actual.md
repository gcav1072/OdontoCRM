# ADR 0043 — Se descarta el enfoque de instalación y despliegue actual; el rediseño parte de **una sola fuente de verdad** para las credenciales

- **Fecha:** 2026-10-05 · **Estado:** aceptada (decisión; el diseño y la implementación van en otra sesión)

## Contexto

La puesta en producción se armó por capas, cada una añadida para resolver el fallo de la
anterior:

1. `infra/db/bootstrap.mjs` crea las bases, los roles y las credenciales, y las escribe en
   `services/<servicio>/.env` (los `.env` de desarrollo, ignorados por git).
2. `infra/fedora/install.sh` genera las **plantillas** de `/etc/odontocrm/<servicio>.env`.
3. `infra/fedora/ensayo-despliegue.sh` —que nació como **ensayo** de la fase 10— pasó a hacer
   de instalador: despliega el código en `/opt/odontocrm`, instala unidades y proxy, y
   **traslada** las credenciales de `services/*.env` a `/etc/odontocrm`, clave por clave.
4. Cuando ese traslado empezó a fallar en silencio, se le añadió un **sincronizador**
   (`odontocrm sincronizar-credenciales`) que copia y comprueba.
5. Y cuando el fallo se volvió difícil de localizar, una **traza** de huellas por paso.

Con eso, las credenciales de cada servicio viven en **dos sitios** (`services/*.env` y
`/etc/odontocrm/*.env`) y **un paso las copia** de uno a otro. Esa es la causa de fondo de la
tarde perdida:

- Un despliegue falló a mitad con `password authentication failed` (28P01) para
  `odonto_identity`, y el mismo síntoma reapareció en cinco intentos.
- Cada paso, mirado por separado, parecía correcto: el bootstrap decía «conservada del .env»,
  la comprobación del seed decía «las 8 credenciales conectan», y las migraciones del paso
  siguiente fallaban igual.
- La comprobación a mano fue concluyente: la URL que veía la migración era **correcta** y la
  contraseña **no** autenticaba; es decir, los dos archivos decían cosas distintas.
- Además, `--hasta=config` **no** significa «parar en config» (solo habilita las fases
  posteriores, TLS y respaldos), lo que costó una ronda entera de diagnóstico equivocado.

El despliegue dejó de ser el andamio y pasó a ser la fuente de los fallos. Y el síntoma se
estaba arreglando en lugar de la causa: cada corrección añadía otra capa al espagueti.

**Fuerzas en juego:**

1. **Corrección**: dos copias de un secreto son una invitación a que se desfase, y el desfase
   es invisible hasta que algo falla lejos de su causa.
2. **Operabilidad**: quien instala en la clínica necesita **un comando** y un resultado
   comprobable, no una cadena de pasos con semántica propia.
3. **Verificabilidad**: cada pieza tiene que poder ejecutarse y comprobarse **sola**
   (hoy el ensayo hace siete cosas y su bandera `--hasta` no ayuda).
4. **Honestidad de la documentación**: lo que la guía promete tiene que ser lo que los guiones
   hacen (ya nos mordió con `pg_hba`, con los enlaces del certificado y con el 80).

## Decisión

1. **Se descarta el enfoque actual de instalación y despliegue** —el ensayo como instalador, el
   traslado de secretos, el sincronizador y las fases con `--hasta`— **como diseño**. No se le
   añaden más parches.
2. El rediseño parte de una invariante: **una sola fuente de verdad para las credenciales**.
   En el servidor se generan una vez y se escriben en `/etc/odontocrm/`; los servicios las leen
   de ahí (systemd, `EnvironmentFile=`) y **nadie las copia después**. El código desplegado en
   `/opt` **no contiene secretos** y se puede borrar y volver a clonar sin perder nada.
3. El camino nuevo se compone de piezas **ejecutables y comprobables por separado**
   (preparar la máquina · aprovisionar bases, roles, credenciales y usuarios · desplegar ·
   verificar), encadenadas por **un comando**, con la comprobación de **efecto** en cada una
   (una credencial se da por buena cuando **conecta**, no cuando se escribió el archivo).
4. El **plan detallado y su implementación se hacen en otra sesión**, empezando de cero. El
   registro de lo que hay que decidir queda en
   [`docs/PLAN_INSTALACION_LIMPIA.md`](../PLAN_INSTALACION_LIMPIA.md).

## Consecuencias

- **Nada se rompe ni se borra ahora.** Lo que existe sigue siendo el camino documentado y
  funcional hasta que haya reemplazo: `npm run db:bootstrap` (converge la base con el `.env`),
  `odontocrm sincronizar-credenciales` (deja `/etc` de acuerdo y lo comprueba) y
  `odontocrm reiniciar && odontocrm verificar`.
- Los `.env` del repositorio **siguen valiendo para desarrollo**; en el servidor dejan de ser
  la fuente de verdad cuando entre el diseño nuevo.
- El **ensayo conserva su valor como prueba** (restauración fila a fila, reinicio de la
  máquina, TLS desde otro equipo); lo que se retira es su papel de instalador y su semántica de
  fases.
- Lo que ya está probado y **no se toca**: el certificado en cinco formatos, el nombre por
  mDNS/DNS, el firewall por zona con el 80 abierto, SELinux sin denegaciones, el respaldo con
  restauración verificada y las comprobaciones de `npm run fedora:check` (95), que se
  reapuntarán al camino nuevo.
- **Coste asumido**: unas horas de rediseño e implementación, con prueba en la PC de pruebas
  antes de tocar la de la clínica. Se acepta a cambio de que instalar deje de ser un
  rompecabezas.

## Alternativas consideradas

- **Seguir parchando el traslado de secretos** (hacerlo más robusto, con reintentos y
  verificaciones): rechazada. Es lo que hicimos durante cinco rondas; el problema no es la
  robustez del copiado, es que **haya** copiado.
- **Que los servicios lean los `.env` del repositorio** en producción (una sola copia):
  rechazada. El código desplegado en `/opt` es de root y desechable; los secretos no pueden
  vivir dentro de él, y §8.6 ya documenta por qué se borran.
- **Guardar las credenciales en una base de datos de configuración** o en un gestor de
  secretos: rechazada para esta escala. Añade dependencia y un punto de fallo más para ocho
  contraseñas que se generan una vez.
