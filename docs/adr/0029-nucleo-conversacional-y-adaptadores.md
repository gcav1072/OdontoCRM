# ADR 0029 — Núcleo conversacional y adaptadores de canal

- **Fecha:** 2026-10-03 · **Estado:** aceptada (decisión del usuario) · **Implementada:** fase 4.1 (2026-10-03)

## Contexto

La Fase 4 dejó el bot funcionando, pero el guion del asistente, la cola de envíos y
los adaptadores de entrada/salida vivían mezclados con Telegram: el núcleo hablaba
de `chat_id`, de `/comandos` y de `getUpdates`. El usuario quiere **añadir WhatsApp
más adelante** (Cloud API oficial, con túnel de Cloudflare) sin reescribir el
asistente ni duplicar la lógica de tiques, avisos y `.ics`.

## Decisión

Separar **núcleo** y **canales**:

```
        ┌───────────────────────────────────────────────┐
        │  Núcleo conversacional (core/)                 │
        │  · 7 pasos del asistente + Zod                 │
        │  · intenciones (no «/comandos»)                │
        │  · altas en patients/scheduling                │
        │  · cola de envíos, plantillas, .ics            │
        └───────────────────────┬───────────────────────┘
                                │  ChannelAdapter
             ┌──────────────────┴───────────────────┐
             ▼                                      ▼
   ┌───────────────────────┐            ┌────────────────────────┐
   │ TelegramAdapter       │            │ WhatsAppAdapter        │
   │ long polling (pull)   │            │ webhook (push)         │
   │ sendMessage/          │            │ Cloud API: texto,      │
   │ sendDocument (.ics)   │            │ interactivo, documento │
   └───────────────────────┘            └────────────────────────┘
```

**La interfaz** (`packages/contracts/src/domain/channel.ts`):

- `ChannelCapabilities`: `botones`, `documentos`, `comandos`, `plantillasAprobadas`.
- `InboundMessage`: ya normalizado — `canal`, `direccion`, `texto`, `accion`
  (botón pulsado), `eventoId` (idempotencia: `update_id` o `wamid`), `recibidoEn`.
- `OutboundMessage`: `direccion`, `texto`, `botones[]`, `documento`.
- `ChannelAdapter`: `iniciar(entregar)` (el adaptador **empuja** los mensajes al
  núcleo: Telegram sondea por dentro, WhatsApp los recibe por webhook),
  `detener()`, `enviar(saliente)` y, solo los canales con webhook, `webhook()`.

Reglas que se derivan:

1. **El núcleo habla de intenciones, no de comandos.** Telegram traduce `/nueva` a
   la intención `nueva`; WhatsApp traduce «cita», «quiero una cita» o el botón
   equivalente a la misma intención.
2. **Adaptación por capacidades.** Si un canal no tiene botones, el núcleo manda
   las opciones **numeradas** («1) Venezolano · 2) Extranjero…») y acepta el
   número o el texto: los mismos 7 pasos funcionan en cualquier canal.
3. **La identidad es `(canal, dirección)`**, no un `chat_id` de Telegram. Un mismo
   paciente puede hablar por Telegram y por WhatsApp sin pisarse las
   conversaciones.
4. **La idempotencia es por `eventoId`** (`update_id` numérico o `wamid` de texto).
5. **Fuera de la ventana de 24 h**, WhatsApp solo admite **plantillas aprobadas**:
   el adaptador las usará para los avisos de cita cuando el canal lo exija
   (`plantillasAprobadas: true`), y dentro de la ventana manda el texto normal.

## Consecuencias

- ✅ Añadir WhatsApp (o SMS, o correo) es escribir un adaptador y registrarlo: el
  asistente, la cola, las plantillas y el `.ics` no se tocan.
- ✅ El mismo juego de pruebas (kit de conformidad) corre contra todos los
  adaptadores: si uno no lo pasa, no entra.
- ✅ Sin dependencias nuevas en el núcleo: el adaptador de Telegram sigue siendo
  `fetch` puro (no hace falta grammY/Telegraf para sondeo y tres llamadas).
- ⚠️ **Baileys queda descartado**: es un cliente no oficial de WhatsApp Web y
  arriesga el bloqueo del número. Se usa Cloud API oficial.
- ⚠️ WhatsApp exige HTTPS público (túnel de Cloudflare) + `verify_token` y
  `app_secret` para validar el webhook; el adaptador los lee del `.env` y
  **rechaza** cualquier petición sin firma válida.
- ⚠️ Los avisos fuera de la ventana de 24 h dependen de plantillas aprobadas en
  Meta: es una limitación del canal, no del sistema, y queda documentada en el
  adaptador.
