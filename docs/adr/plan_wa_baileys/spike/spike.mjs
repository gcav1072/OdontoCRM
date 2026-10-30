#!/usr/bin/env node
/**
 * Spike desechable de la Fase 0 (ADR 0072): **no entra en el build**.
 *
 * Comprueba con un número de prueba que Baileys vincula por QR, recibe texto,
 * envía texto y un `.ics`, reconecta tras una caída y detecta `loggedOut`.
 * No usa el código del producto ni la base: guarda la sesión en `./auth` para
 * que el spike se pueda repetir sin volver a escanear.
 *
 *   cd docs/adr/plan_wa_baileys/spike
 *   npm install @whiskeysockets/baileys@7.0.0-rc14 qrcode
 *   node spike.mjs
 *
 * Variables:
 *   SPIKE_TO=584141234567   número de prueba al que enviar (opcional)
 *   SPIKE_AUTH=./auth       carpeta de la sesión del spike
 *
 * ⚠️ Usa un número **de prueba**, nunca el de producción.
 */
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import QRCode from 'qrcode';
import makeWASocket, {
  DisconnectReason,
  fetchLatestBaileysVersion,
  useMultiFileAuthState,
} from '@whiskeysockets/baileys';

const authDir = resolve(process.env.SPIKE_AUTH ?? './auth');
mkdirSync(authDir, { recursive: true });
const { state, saveCreds } = await useMultiFileAuthState(authDir);
const { version } = await fetchLatestBaileysVersion();
const destino = process.env.SPIKE_TO;
let enviado = false;

const sock = makeWASocket({
  auth: state,
  version,
  printQRInTerminal: false,
  markOnlineOnConnect: false,
  syncFullHistory: false,
  shouldSyncHistoryMessage: () => false,
});
sock.ev.on('creds.update', saveCreds);

sock.ev.on('connection.update', async (update) => {
  if (update.qr !== undefined) {
    console.log(await QRCode.toString(update.qr, { type: 'terminal', small: true }));
    console.log('Escanea este QR desde el teléfono de prueba.');
  }
  if (update.connection === 'open' && destino !== undefined && !enviado) {
    enviado = true;
    const jid = destino.includes('@') ? destino : `${destino}@s.whatsapp.net`;
    await sock.sendMessage(jid, { text: 'Spike OdontoCRM: texto recibido.' });
    await sock.sendMessage(jid, {
      document: Buffer.from(
        'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//OdontoCRM//Spike//ES\r\n' +
          'BEGIN:VEVENT\r\nUID:spike-odontocrm\r\nDTSTAMP:20261029T120000Z\r\n' +
          'DTSTART:20261030T140000Z\r\nDTEND:20261030T143000Z\r\n' +
          'SUMMARY:Cita de prueba OdontoCRM\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n',
        'utf8',
      ),
      mimetype: 'text/calendar',
      fileName: 'cita-spike.ics',
      caption: 'Spike OdontoCRM: calendario adjunto.',
    });
    console.log('Enviados texto y .ics de prueba.');
  }
  if (update.connection === 'close') {
    const codigo = update.lastDisconnect?.error?.output?.statusCode;
    console.log(`Conexión cerrada (${String(codigo ?? 'sin código')}).`);
    if (codigo === DisconnectReason.loggedOut) {
      console.log('loggedOut detectado: borra la carpeta de auth y vuelve a vincular.');
      process.exit(0);
    }
  }
});

sock.ev.on('messages.upsert', ({ type, messages }) => {
  if (type !== 'notify') return;
  for (const mensaje of messages) {
    if (mensaje.key.fromMe === true) continue;
    console.log('Entrante:', mensaje.key.remoteJid, mensaje.message);
  }
});

process.on('SIGINT', async () => {
  await sock.end(undefined);
  process.exit(0);
});
