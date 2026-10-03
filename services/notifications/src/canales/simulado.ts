import type {
  ChannelAdapter,
  ChannelCapabilities,
  InboundMessage,
  OutboundMessage,
  SendResult,
} from '@odontocrm/contracts';

/** Mensaje registrado por el adaptador simulado (para pruebas y modo sin token). */
export interface SentMessage {
  direccion: string;
  texto: string;
  at: string;
  documento?: { nombre: string; size: number; mime: string };
  botones?: string[];
}

export interface SimulatedAdapter extends ChannelAdapter {
  /** Envíos registrados, en orden. */
  readonly sent: SentMessage[];
  /** Entrega un mensaje como si lo hubiera mandado el paciente. */
  deliver: (
    entrante: Omit<InboundMessage, 'canal' | 'recibidoEn'> & { canal?: 'telegram' | 'whatsapp' },
  ) => Promise<void>;
}

/**
 * Adaptador simulado (ADR 0029): se comporta como un canal real —acepta mensajes
 * entrantes y registra los salientes— pero no habla con nadie. Es lo que permite
 * probar todo el flujo sin token y contra cualquier canal.
 */
export const createSimulatedAdapter = (
  canal: 'telegram' | 'whatsapp' = 'telegram',
  capacidades?: Partial<ChannelCapabilities>,
): SimulatedAdapter => {
  const sent: SentMessage[] = [];
  let entregar: ((entrante: InboundMessage) => Promise<void>) | null = null;

  return {
    id: canal,
    capacidades: {
      botones: true,
      documentos: true,
      comandos: canal === 'telegram',
      plantillasAprobadas: canal === 'whatsapp',
      ...capacidades,
    },
    sent,

    iniciar: async (handler) => {
      entregar = handler;
    },
    detener: async () => undefined,

    enviar: async (saliente: OutboundMessage): Promise<SendResult> => {
      sent.push({
        direccion: saliente.direccion,
        texto: saliente.texto,
        at: new Date().toISOString(),
        ...(saliente.documento === undefined
          ? {}
          : {
              documento: {
                nombre: saliente.documento.nombre,
                size: saliente.documento.contenido.byteLength,
                mime: saliente.documento.mime,
              },
            }),
        ...(saliente.botones === undefined
          ? {}
          : { botones: saliente.botones.map((b) => b.etiqueta) }),
      });
      return { idMensaje: `simulado-${String(sent.length)}` };
    },

    deliver: async (entrante) => {
      if (entregar === null) throw new Error('El adaptador simulado no está iniciado');
      await entregar({
        canal: entrante.canal ?? canal,
        direccion: entrante.direccion,
        usuario: entrante.usuario ?? null,
        texto: entrante.texto ?? null,
        accion: entrante.accion ?? null,
        eventoId: entrante.eventoId,
        recibidoEn: new Date().toISOString(),
      });
    },

    identidad: async () => ({ nombre: 'Canal simulado', usuario: null, conectado: false }),
  };
};
