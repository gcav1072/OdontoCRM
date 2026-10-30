# 0072 — WhatsApp por Baileys (cliente no oficial) en lugar de Cloud API

- **Fecha:** 2026-10-29 · **Estado:** propuesta (implementación en curso)

## Contexto

La integración de WhatsApp existente usa **Cloud API** de Meta: exige HTTPS
público (túnel de Cloudflare), una cuenta de Meta Business verificada,
plantillas aprobadas fuera de la ventana de 24 h y un webhook firmado. El
consultorio vive en una red local (ADR 0001, 0008 y 0021), el volumen de
mensajes es bajo y el coste operativo de esa infraestructura no se justifica.

El volumen bajo también permite asumir el riesgo de un cliente no oficial:
**Baileys** abre un socket saliente como WhatsApp Web y no necesita webhook ni
ruta pública. La decisión de usarlo la tomó el usuario, aceptando el riesgo de
bloqueo del número y de los cambios del protocolo.

## Decisión

1. El id de canal sigue siendo **`whatsapp`**; el proveedor es un detalle del
   adaptador (ADR 0029). No hay migraciones de `CHECK` ni cambios en
   `patient_channels`, la cola, los reportes o la agenda.
2. Baileys es el **proveedor por defecto**. Cloud API **se conserva** como
   alternativa configurable (`whatsappProvider = cloud_api`), con su webhook y
   sus cuatro credenciales. Una instalación nueva nace en Baileys y apagada.
3. Se usa el paquete `@whiskeysockets/baileys` con **versión exacta**
   (`7.0.0-rc14`, sin `^`). La actualización es manual y con prueba de humo.
4. La sesión Signal se guarda **cifrada en PostgreSQL** (`whatsapp_auth`), no
   en `useMultiFileAuthState`; ver el ADR 0073.
5. El canal se enciende con un **interruptor** (`whatsappEnabled`) y queda
   `sin_vincular` hasta que un admin escanea el QR (o pide un código de
   emparejamiento). Sin sesión no escribe a nadie.
6. **Sin botones**: `capacidades.botones = false`. El núcleo ya numera las
   opciones y los avisos invitan a escribir «confirmar»/«cancelar».
7. **Solo opt-in**: se escribe a quien escribió antes al número o se vinculó con
   un código. Nunca se escribe en frío al teléfono de la ficha.
8. **Ritmo y tope**: cola serial, espera aleatoria configurable (2–4 s por
   defecto), «escribiendo…» proporcional al texto y 150 mensajes al día por
   defecto. Si no hay conexión o se agota el tope, el aviso se **difiere sin
   gastar intentos**. Si el número del consultorio cambia, los pacientes
   vinculados al anterior se marcan para **volver a vincular** (no se les escribe
   en frío).
9. El número es **dedicado al bot** (D12). WhatsApp pasa a ser el canal
   preferido de los avisos, antes que Telegram (D16).
10. No se sincroniza historial (`syncFullHistory: false`): solo se guarda la
    conversación del asistente, como hasta ahora.

## Consecuencias

- **Bueno:** desaparece el túnel y la cuenta de Meta Business para el flujo
  normal; una ruta pública menos cuando se usa Baileys; instalación más simple;
  el `.ics` sale como documento directo y Cloud API queda disponible si algún
  día se necesita.
- **Riesgo aceptado:** WhatsApp puede bloquear un número que usa un cliente no
  oficial. Se mitiga con opt-in, ritmo, número dedicado y el plan B manual
  (ADR 0008). Telegram sigue intacto.
- La sesión depende de que el teléfono del consultorio esté encendido y con
  conexión; WhatsApp desvincula dispositivos tras varios días sin conexión.
- El protocolo puede cambiar y romper Baileys. Por eso la versión está fijada,
  se consulta `fetchLatestBaileysVersion()` al conectar y el administrador
  recibe una alerta cuando la sesión no está `conectado`.
- **Enmienda el ADR 0029:** donde decía «Baileys queda descartado» y donde
  exigía plantillas de WhatsApp para Cloud API, ahora hay dos proveedores. La
  regla 5 (plantillas aprobadas) sigue aplicando **solo** a Cloud API.
- **Enmienda el ADR 0060:** las credenciales de WhatsApp dejan de ser la única
  configuración del canal; el panel guarda el interruptor, el proveedor, el
  ritmo y la sesión vive en `notifications`.
- **Enmienda el ADR 0020:** en modo test el socket de WhatsApp **no se abre**,
  aunque el interruptor esté encendido.
- El ADR 0073 documenta la sesión cifrada y su operación; el ADR 0074, la
  vinculación por `wa.me` y las intenciones con argumento.
