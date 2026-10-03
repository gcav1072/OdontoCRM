import { casoSimulado, casoTelegram, casoWhatsApp, runChannelConformance } from './conformidad.js';

/**
 * Kit de conformidad (ADR 0029): el **mismo** juego de pruebas contra los tres
 * adaptadores —Telegram, WhatsApp Cloud API y el simulado—. Un canal nuevo no
 * entra hasta que lo pasa.
 */
runChannelConformance(casoTelegram());
runChannelConformance(casoWhatsApp());
runChannelConformance(casoSimulado());
