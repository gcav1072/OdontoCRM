#!/usr/bin/env node
/**
 * Vinculación y estado de la sesión de WhatsApp por Baileys (ADR 0073) **desde
 * la terminal**, para instalaciones sin navegador o para un diagnóstico rápido.
 *
 *   npm run whatsapp:estado
 *   npm run whatsapp:vincular                 (QR en la terminal)
 *   npm run whatsapp:vincular -- --codigo=0412-1234567
 *   npm run whatsapp:reconectar
 *   npm run whatsapp:cerrar
 *
 * Usa las rutas internas del servicio de notificaciones (no necesita JWT) y
 * nunca imprime las credenciales Signal.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import QRCode from 'qrcode';

const ROOT = process.cwd();
const args = process.argv.slice(2);
const comando = args[0] ?? 'estado';

const leerEnv = (ruta, clave) => {
  const camino = resolve(ROOT, ruta);
  if (!existsSync(camino)) return undefined;
  const match = new RegExp(`^${clave}=(.*)$`, 'm').exec(readFileSync(camino, 'utf8'));
  return match?.[1]?.trim();
};

const url = process.env.NOTIFICATIONS_URL ?? 'http://127.0.0.1:4004';
const secreto =
  process.env.INTERNAL_SERVICE_SECRET ??
  leerEnv('.env', 'INTERNAL_SERVICE_SECRET') ??
  leerEnv('services/notifications/.env', 'INTERNAL_SERVICE_SECRET');

if (secreto === undefined || secreto === '') {
  console.error('Falta INTERNAL_SERVICE_SECRET (en .env o services/notifications/.env).');
  process.exit(1);
}

const llamar = async (ruta, metodo = 'GET', cuerpo) => {
  const response = await fetch(new URL(ruta, url), {
    method: metodo,
    headers: {
      'x-internal-token': secreto,
      ...(cuerpo === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(cuerpo === undefined ? {} : { body: JSON.stringify(cuerpo) }),
    signal: AbortSignal.timeout(20_000),
  });
  const texto = await response.text();
  let json;
  try {
    json = JSON.parse(texto);
  } catch {
    json = texto;
  }
  if (!response.ok) {
    throw new Error(
      `El servicio respondió ${String(response.status)}: ${String(texto).slice(0, 300)}`,
    );
  }
  return json;
};

const dormir = (ms) => new Promise((resolve_) => setTimeout(resolve_, ms));

const pintar = async (vista) => {
  if (vista.estado === 'conectado') {
    console.log(
      `Conectado${vista.numero === null ? '' : ` · ${vista.numero}`}\n${vista.nombre ?? ''}`,
    );
    return;
  }
  if (vista.estado === 'esperando_qr' && typeof vista.qrRaw === 'string') {
    console.log(await QRCode.toString(vista.qrRaw, { type: 'terminal', small: true }));
    console.log('Escanea el QR desde WhatsApp → Dispositivos vinculados.');
    return;
  }
  if (vista.estado === 'esperando_qr' && typeof vista.pairingCode === 'string') {
    console.log(`Código de emparejamiento: ${vista.pairingCode}`);
    return;
  }
  console.log(`Estado: ${vista.estado}${vista.motivo === null ? '' : ` · ${vista.motivo}`}`);
};

const ver = async () => {
  const vista = await llamar('/internal/v1/notifications/whatsapp/session');
  if (comando === 'estado') {
    console.log(
      JSON.stringify(
        {
          estado: vista.estado,
          numero: vista.numero,
          nombre: vista.nombre,
          conectadoDesde: vista.conectadoDesde,
          ultimaDesconexion: vista.ultimaDesconexion,
          motivo: vista.motivo,
        },
        null,
        2,
      ),
    );
    return vista;
  }
  await pintar(vista);
  return vista;
};

try {
  if (comando === 'estado') {
    await ver();
  } else if (comando === 'reconectar') {
    const vista = await llamar('/internal/v1/notifications/whatsapp/session/restart', 'POST', {});
    await pintar(vista);
  } else if (comando === 'cerrar') {
    const vista = await llamar('/internal/v1/notifications/whatsapp/session/logout', 'POST', {});
    console.log(`Sesión cerrada. Estado: ${vista.estado}`);
  } else if (comando === 'vincular' || comando === 'vincular-qr') {
    const codigo = args.find((arg) => arg.startsWith('--codigo='))?.slice('--codigo='.length);
    const input = codigo === undefined ? { metodo: 'qr' } : { metodo: 'codigo', telefono: codigo };
    let vista = await llamar('/internal/v1/notifications/whatsapp/session/pair', 'POST', input);
    await pintar(vista);

    // Espera a que el teléfono termine; imprime el QR nuevo si Baileys lo rota.
    let ultimoQr = vista.qrRaw;
    const limite = Date.now() + 3 * 60_000;
    while (vista.estado !== 'conectado' && Date.now() < limite) {
      await dormir(2_000);
      vista = await llamar('/internal/v1/notifications/whatsapp/session');
      if (vista.qrRaw !== ultimoQr) {
        ultimoQr = vista.qrRaw;
        await pintar(vista);
      }
    }
    if (vista.estado === 'conectado') {
      console.log(`\nWhatsApp vinculado${vista.numero === null ? '' : `: ${vista.numero}`}.`);
    } else {
      console.error(`\nNo se completó la vinculación (estado ${vista.estado}).`);
      process.exitCode = 1;
    }
  } else if (comando === 'ayuda' || comando === '--help' || comando === '-h') {
    console.log(
      'uso: whatsapp [estado|vincular [--codigo=NÚMERO]|reconectar|cerrar]\n' +
        '  npm run whatsapp:estado\n' +
        '  npm run whatsapp:vincular\n' +
        '  npm run whatsapp:vincular -- --codigo=0412-1234567\n' +
        '  npm run whatsapp:reconectar\n' +
        '  npm run whatsapp:cerrar',
    );
  } else {
    console.error(`orden desconocida: ${comando} (prueba «whatsapp --help»)`);
    process.exitCode = 2;
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
