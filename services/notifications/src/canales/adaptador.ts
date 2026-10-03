import {
  numberedOptions,
  type ChannelAdapter,
  type ChannelCapabilities,
  type OutboundButton,
  type OutboundMessage,
  type SendResult,
} from '@odontocrm/contracts';

export type { ChannelAdapter, ChannelCapabilities, OutboundMessage };

/**
 * Envía un mensaje adaptándose a lo que el canal sabe hacer (ADR 0029).
 *
 * Si el canal no tiene botones, las opciones se numeran dentro del texto y sus
 * acciones se devuelven para que el núcleo las recuerde: el paciente responde «2»
 * y el asistente entiende lo mismo que si hubiera pulsado un botón.
 */
export const sendAdapted = async (
  adapter: ChannelAdapter,
  saliente: OutboundMessage,
): Promise<{ resultado: SendResult; opciones: ReadonlyMap<string, string> }> => {
  const botones = saliente.botones ?? [];
  if (botones.length === 0 || adapter.capacidades.botones) {
    return { resultado: await adapter.enviar(saliente), opciones: new Map() };
  }

  const numeradas = numberedOptions(botones);
  return {
    resultado: await adapter.enviar({
      ...saliente,
      texto: `${saliente.texto}\n\n${numeradas.texto}`,
      botones: undefined,
    }),
    opciones: numeradas.acciones,
  };
};

/** Registro de adaptadores activos (Telegram, WhatsApp…). */
export const createAdapterRegistry = (adapters: readonly ChannelAdapter[]) => {
  const byId = new Map(adapters.map((adapter) => [adapter.id, adapter]));

  return {
    all: adapters,
    get: (id: string): ChannelAdapter | null => byId.get(id as ChannelAdapter['id']) ?? null,
    /** Arranca todos los adaptadores entregando al mismo núcleo. */
    start: async (entregar: Parameters<ChannelAdapter['iniciar']>[0]): Promise<void> => {
      for (const adapter of adapters) await adapter.iniciar(entregar);
    },
    stop: async (): Promise<void> => {
      for (const adapter of adapters) await adapter.detener();
    },
  };
};

export type AdapterRegistry = ReturnType<typeof createAdapterRegistry>;

/** Botones de un paso, con sus acciones (el núcleo decide el resto). */
export const buttons = (pairs: readonly [string, string][]): OutboundButton[] =>
  pairs.map(([etiqueta, accion]) => ({ etiqueta, accion }));
