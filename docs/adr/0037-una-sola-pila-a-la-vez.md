# ADR 0037 — Una sola pila a la vez, y los puertos mandan

- **Fecha:** 2026-10-04 · **Estado:** aceptada · **Implementada:** `tools/stack.mjs` (2026-10-04)

## Contexto

Los ocho servicios, la puerta y la interfaz escuchan en **puertos fijos** (4001-4007, 8090,
5173). Eso deja tres formas de arrancarlos y ninguna sabe de las otras:

- `npm run dev`: `tsc -b --watch` y cada servicio con `node --watch` (recarga automática).
- `npm run start:<servicio>`: procesos sueltos desde `dist/`, sin recarga.
- PM2 (`infra/windows/ecosystem.config.cjs`): sin recarga, con registros, reintentos y
  supervivencia a la terminal.

El 2026-10-04 se juntaron las tres y el resultado fue confuso: `npm run dev` no podía tomar
los puertos y **reintentaba en bucle**, PM2 mostraba sus ocho aplicaciones como *detenidas*
(24-38 reinicios cada una, porque también chocaban) mientras **ocho procesos sueltos** sin
recarga servían la aplicación; el `predev` avisaba de «puertos ocupados» sin decir de qué
pila eran, y al arreglar el récipe la pregunta natural fue «¿esto es caché o hay que
reiniciar el servidor?» sin forma de responderla mirando el sistema.

Lo que ya existía (`dev-check.mjs`, `dev-stop.mjs`) solo cubría el caso de `npm run dev`:
los otros dos modos podían aparecer sin que nadie los viera.

## Decisión

**Una sola pila a la vez, y los puertos son la fuente de verdad.**

1. **La tabla de puertos es única** (`tools/lib/stack.mjs`) y la comparten el preflight, el
   parador y el gestor. Antes estaba duplicada en dos herramientas, que es como empiezan a
   discrepar.
2. **No hay archivo de candado.** Un candado se queda obsoleto en cuanto un proceso muere de
   golpe (y entonces bloquea el arranque legítimo). Si un puerto está tomado, hay una pila;
   el candado es el sistema operativo.
3. **`npm run stack:status` responde «¿qué está corriendo?»**: puerto, servicio, proceso,
   desde cuándo, si tiene recarga y si es de PM2. Es el primer comando cuando algo «no
   cambia» en la aplicación.
4. **Cambiar de modo es un comando**: `stack:dev` (todo con recarga, en primer plano) y
   `stack:fijo` (todo con PM2, sobrevive a la terminal). Los dos **paran antes** lo que
   hubiera: no se puede terminar con dos pilas por descuido.
5. **La guardia bloquea el segundo arranque**: `predev` llama a `stack:guard`, que falla con
   el retrato de lo que está corriendo y los comandos para cambiar de modo, en vez de dejar
   que el puerto falle a medias.
6. **La interfaz forma parte de la pila** en los dos modos. En `fijo`, Vite corre dentro de
   PM2 (lanzado como `node node_modules/vite/bin/vite.js`, porque PM2 en Windows no puede
   lanzar `npm` sin shell: `spawn EINVAL`). Si la web dependiera de una terminal aparte,
   volveríamos a tener dos cosas vivas.
7. **`stack:down` no toca lo ajeno**: antes de matar un proceso comprueba que su línea de
   comandos sea de la pila (o que sea de PM2). Un programa ajeno en un puerto de la lista se
   avisa y se deja en paz. Y lo que decide si un proceso se paró es **el puerto**, no el
   código de salida de `taskkill` (que falla también cuando el proceso ya había muerto).

## Consecuencias

- **A favor:** se acabó el «¿quién está sirviendo la aplicación?»; el cambio de modo es
  explícito y reversible; las herramientas comparten una sola lista de puertos; y queda claro
  que un cambio en `dist/` **no** llega a la aplicación si la pila es la fija (hay que
  `stack:fijo` o `pm2 restart`), que es exactamente el malentendido que originó esta decisión.
- **En contra / a vigilar:** `stack:fijo` compila antes de arrancar (unos segundos) y borra
  las aplicaciones de PM2 para que el arranque sea determinista, así que se pierde el
  histórico de PM2 en cada cambio de modo. PM2 sigue siendo **opcional**: sin PM2 instalado,
  `stack:dev` funciona igual y `stack:fijo` avisa y se detiene.
- En Fedora (Fase 10) el modo de producción es `systemd` sirviendo la SPA compilada por el
  reverse proxy: `stack:fijo` es una herramienta **de desarrollo**, no el arranque de la
  clínica. Lo que sí se hereda es la regla: un solo dueño de los puertos.
