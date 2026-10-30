import {
  casoSimulado,
  casoTelegram,
  casoWhatsApp,
  casoWhatsAppCloudApi,
  runChannelConformance,
} from './conformidad.js';

/**
 * Kit de conformidad (ADR 0029): el **mismo** juego de pruebas contra todos los
 * adaptadores: Telegram, WhatsApp por Baileys (el proveedor por defecto),
 * WhatsApp Cloud API (la alternativa conservada) y el simulado.
 */
runChannelConformance(casoTelegram());
runChannelConformance(casoWhatsApp());
runChannelConformance(casoWhatsAppCloudApi());
runChannelConformance(casoSimulado());
