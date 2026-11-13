import { LICENSE_KIND_DAYS, encodeLicenseRequest } from '@odontocrm/contracts';
import {
  generateKeyPairPem,
  importPrivateKeyPem,
  importPublicKeyPem,
  verifyLicenseToken,
} from '@odontocrm/kernel';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  NOMBRE_BOT_ENV,
  NOMBRE_EMITIDAS,
  NOMBRE_PRIVADA,
  NOMBRE_PUBLICA,
  NOMBRE_REGISTRO,
  credencialesBot,
  parsearEnv,
  rutasDeLicencias,
} from './licencia-config.mjs';
import {
  calcularVencimiento,
  construirClaims,
  diasDelTipo,
  emitirLicencia,
  extraerSolicitudDeTexto,
  formatearEmision,
  formatearVerificacion,
  nombreArchivoLicencia,
} from './licencia-emision.mjs';
import {
  diasRestantes,
  elegirId,
  formatearDetalleLicencia,
  formatearPendientes,
  leerRegistro,
  parsearRegistro,
  pendientes,
  serializarEntrada,
  siguienteId,
  textoVencimiento,
  ultimaPorInstalacion,
} from './licencia-registro.mjs';
import { crearBotLicencias, dividirMensaje, limpiarSecreto } from './telegram-licencias.mjs';

/**
 * Pruebas del **emisor de licencias** (CLI y bot del proveedor). Todo corre con
 * directorios temporales y pares de claves efímeros: el registro real, la clave
 * privada real y el asset del repo no se tocan jamás.
 */

const UUID_A = '6f6f2f7e-3a3a-4c4c-9b9b-1234567890ab';
const UUID_B = 'a1a1a1a1-b2b2-4c3c-9d4d-1234567890ef';
const UUID_C = 'c3c3c3c3-d4d4-4e5e-8f6f-1234567890ab';
const PUNTO = new Date('2026-11-11T12:00:00.000Z');

const temporales = [];

/** Rutas de trabajo en un directorio temporal (nunca las del usuario real). */
const crearRutas = () => {
  const base = mkdtempSync(join(tmpdir(), 'odontocrm-licencias-'));
  temporales.push(base);
  const configDir = join(base, 'config');
  const dataDir = join(base, 'datos');
  return {
    base,
    configDir,
    dataDir,
    privada: join(configDir, NOMBRE_PRIVADA),
    publica: join(configDir, NOMBRE_PUBLICA),
    botEnv: join(configDir, NOMBRE_BOT_ENV),
    registro: join(dataDir, NOMBRE_REGISTRO),
    emitidas: join(dataDir, NOMBRE_EMITIDAS),
    publicaDelRepo: join(base, 'repo', 'assets', 'licencias', NOMBRE_PUBLICA),
  };
};

/** Entrada de registro mínima y válida; se completa con lo que cambie cada prueba. */
const entrada = (cambios = {}) => ({
  lic: 'LIC-2026-0001',
  tipo: 'mensual',
  instalacion: UUID_A,
  cliente: { nombre: 'Consultorio Sonrisa', rif: 'J-12345678-9' },
  emitidaEn: '2026-11-01T12:00:00.000Z',
  venceEn: '2026-12-01T12:00:00.000Z',
  modulos: ['*'],
  emitidaPor: 'cli',
  renovacion: false,
  anterior: null,
  archivo: 'LIC-2026-0001.lic',
  registradaEn: '2026-11-01T12:00:00.000Z',
  ...cambios,
});

/** Entrada de registro de una vitalicia (sin vencimiento). */
const entradaVitalicia = (cambios = {}) =>
  entrada({
    lic: 'LIC-2026-0009',
    tipo: 'vitalicia',
    venceEn: null,
    ...cambios,
  });

const parDeClaves = async () => {
  const { privatePem, publicPem } = await generateKeyPairPem();
  return {
    clavePrivada: await importPrivateKeyPem(privatePem),
    clavePublica: await importPublicKeyPem(publicPem),
  };
};

afterEach(() => {
  for (const directorio of temporales) rmSync(directorio, { recursive: true, force: true });
  temporales.length = 0;
});

/* ── Rutas y credenciales fuera del repo ──────────────────────────────────── */

describe('rutas del emisor', () => {
  it('en Linux usa XDG y el home del usuario', () => {
    const rutas = rutasDeLicencias({ plataforma: 'linux', entorno: {}, home: '/home/proveedor' });

    expect(rutas.configDir).toBe('/home/proveedor/.config/odontocrm/licencias');
    expect(rutas.dataDir).toBe('/home/proveedor/.local/share/odontocrm/licencias');
    expect(rutas.privada).toBe(join(rutas.configDir, NOMBRE_PRIVADA));
    expect(rutas.publica).toBe(join(rutas.configDir, NOMBRE_PUBLICA));
    expect(rutas.botEnv).toBe(join(rutas.configDir, NOMBRE_BOT_ENV));
    expect(rutas.registro).toBe(join(rutas.dataDir, NOMBRE_REGISTRO));
    expect(rutas.emitidas).toBe(join(rutas.dataDir, NOMBRE_EMITIDAS));
    expect(rutas.publicaDelRepo.endsWith(join('assets', 'licencias', NOMBRE_PUBLICA))).toBe(true);
  });

  it('en Windows usa APPDATA y LOCALAPPDATA', () => {
    const rutas = rutasDeLicencias({
      plataforma: 'win32',
      entorno: {
        APPDATA: 'C:\\Users\\proveedor\\AppData\\Roaming',
        LOCALAPPDATA: 'C:\\Users\\proveedor\\AppData\\Local',
      },
      home: 'C:\\Users\\proveedor',
    });

    expect(rutas.configDir.startsWith('C:\\Users\\proveedor\\AppData\\Roaming')).toBe(true);
    expect(rutas.dataDir.startsWith('C:\\Users\\proveedor\\AppData\\Local')).toBe(true);
    expect(rutas.privada.includes('odontocrm')).toBe(true);
    expect(rutas.registro.includes('odontocrm')).toBe(true);
  });

  it('los overrides manda sobre las rutas por defecto (pruebas y hosts dedicados)', () => {
    const rutas = rutasDeLicencias({
      plataforma: 'linux',
      entorno: {
        ODONTOCRM_LICENCIAS_CONFIG_DIR: '/var/lib/licencias/config',
        ODONTOCRM_LICENCIAS_DATA_DIR: '/var/lib/licencias/datos',
        ODONTOCRM_LICENCIAS_PUBLICA_DESTINO: '/tmp/publica.pem',
      },
      home: '/home/proveedor',
    });

    expect(rutas.configDir).toBe('/var/lib/licencias/config');
    expect(rutas.dataDir).toBe('/var/lib/licencias/datos');
    expect(rutas.publicaDelRepo).toBe('/tmp/publica.pem');
  });
});

describe('credenciales del bot del proveedor', () => {
  it('lee licencia-bot.env sin imprimir sus valores', () => {
    const rutas = crearRutas();
    mkdirSync(rutas.configDir, { recursive: true });
    writeFileSync(
      rutas.botEnv,
      '# token del BotFather\nLICENCIA_BOT_TOKEN=123456:ABC-DEF\nLICENCIA_BOT_CHAT_ID=987654321\n',
    );

    expect(credencialesBot(rutas, {})).toEqual({
      token: '123456:ABC-DEF',
      chatId: '987654321',
      apiBase: 'https://api.telegram.org',
    });
  });

  it('las variables de entorno mandan sobre el archivo y la plantilla es «sin configurar»', () => {
    const rutas = crearRutas();
    mkdirSync(rutas.configDir, { recursive: true });
    writeFileSync(
      rutas.botEnv,
      'LICENCIA_BOT_TOKEN=CAMBIAR_TOKEN\nLICENCIA_BOT_CHAT_ID=CAMBIAR_CHAT\n',
    );

    expect(credencialesBot(rutas, {})).toBeNull();
    expect(credencialesBot(rutas, {})).toBeNull();
    expect(credencialesBot(rutas, {})).toBeNull();

    writeFileSync(rutas.botEnv, 'LICENCIA_BOT_TOKEN=del-archivo\nLICENCIA_BOT_CHAT_ID=1\n');
    expect(credencialesBot(rutas, { LICENCIA_BOT_TOKEN: 'del-entorno' })).toEqual({
      token: 'del-entorno',
      chatId: '1',
      apiBase: 'https://api.telegram.org',
    });
  });

  it('parsearEnv ignora comentarios y quita comillas', () => {
    expect(parsearEnv('# comentario\nA=1\nB="dos"\n\nC = tres \nlinea-rota\n')).toEqual({
      A: '1',
      B: 'dos',
      C: 'tres',
    });
  });
});

describe('transporte del bot del proveedor', () => {
  it('sin credenciales no hay transporte (y no es un fallo)', () => {
    const rutas = crearRutas();
    expect(crearBotLicencias({ rutas, entorno: {} })).toBeNull();
  });

  it('con credenciales construye el transporte y una huella sin exponer el token', () => {
    const rutas = crearRutas();
    mkdirSync(rutas.configDir, { recursive: true });
    writeFileSync(rutas.botEnv, 'LICENCIA_BOT_TOKEN=123:ABC\nLICENCIA_BOT_CHAT_ID=42\n');

    const bot = crearBotLicencias({ rutas, entorno: {} });
    expect(bot.chatId).toBe('42');
    expect(bot.firma).toHaveLength(16);
    expect(bot.firma).not.toContain('123:ABC');
    expect(limpiarSecreto('falló con 123:ABC en la URL', '123:ABC')).not.toContain('123:ABC');
  });

  it('trocea los mensajes largos sin perder contenido', () => {
    const largo = Array.from({ length: 500 }, (_, indice) => `línea ${String(indice)}`).join('\n');
    const trozos = dividirMensaje(largo);

    expect(trozos.length).toBeGreaterThan(1);
    for (const trozo of trozos) expect(trozo.length).toBeLessThanOrEqual(4000);
    expect(trozos.join('')).toBe(largo);
    expect(dividirMensaje('')).toEqual(['']);
  });
});

/* ── Registro, identificadores y vencimientos ─────────────────────────────── */

describe('registro JSONL', () => {
  it('anota ids legibles siguiendo el máximo del año', () => {
    expect(siguienteId([], PUNTO)).toBe('LIC-2026-0001');
    expect(
      elegirId([entrada({ lic: 'LIC-2026-0007' }), entrada({ lic: 'LIC-2026-0002' })], PUNTO),
    ).toBe('LIC-2026-0008');
    expect(
      siguienteId([entrada({ lic: 'LIC-2026-0007' })], new Date('2027-01-02T12:00:00.000Z')),
    ).toBe('LIC-2027-0001');
  });

  it('ignora líneas corruptas sin perder las buenas', () => {
    const texto = [
      serializarEntrada(entrada()),
      'esto no es JSON',
      JSON.stringify({ lic: 'mal-formado' }),
      '',
      serializarEntrada(entrada({ lic: 'LIC-2026-0002' })),
    ].join('\n');

    const { entradas, invalidas } = parsearRegistro(texto);
    expect(entradas).toHaveLength(2);
    expect(invalidas).toEqual([2, 3]);
  });

  it('una vitalicia es válida sin vencimiento y con vencimiento es ilegible', () => {
    const texto = [
      serializarEntrada(entradaVitalicia()),
      serializarEntrada(entrada({ lic: 'LIC-2026-0010', venceEn: null })),
    ].join('\n');

    const { entradas, invalidas } = parsearRegistro(texto);
    expect(entradas).toHaveLength(1);
    expect(entradas[0].tipo).toBe('vitalicia');
    expect(entradas[0].venceEn).toBeNull();
    expect(invalidas).toEqual([2]);
  });

  it('una vitalicia manda como última licencia de la instalación', () => {
    const elegida = ultimaPorInstalacion(
      [entrada({ venceEn: '2099-01-01T00:00:00.000Z' }), entradaVitalicia()],
      UUID_A,
    );
    expect(elegida?.tipo).toBe('vitalicia');
  });

  it('una temporal emitida DESPUÉS reemplaza a la vitalicia como última', () => {
    const reemplazo = entrada({
      lic: 'LIC-2026-0010',
      emitidaEn: '2026-11-20T12:00:00.000Z',
      venceEn: '2026-12-20T12:00:00.000Z',
    });
    const elegida = ultimaPorInstalacion([entradaVitalicia(), reemplazo], UUID_A);
    expect(elegida?.lic).toBe('LIC-2026-0010');

    // Y con ella vuelve a haber algo que renovar.
    const filas = pendientes([entradaVitalicia(), reemplazo], { ahora: PUNTO, dias: 60 });
    expect(filas.map((fila) => fila.lic)).toEqual(['LIC-2026-0010']);
  });

  it('la última licencia de una instalación es la de vencimiento mayor', () => {
    const entradas = [
      entrada({ lic: 'LIC-2026-0001', venceEn: '2026-12-01T12:00:00.000Z' }),
      entrada({ lic: 'LIC-2026-0002', venceEn: '2027-03-01T12:00:00.000Z' }),
      entrada({ lic: 'LIC-2026-0003', instalacion: UUID_B }),
    ];

    expect(ultimaPorInstalacion(entradas, UUID_A)?.lic).toBe('LIC-2026-0002');
    expect(ultimaPorInstalacion(entradas, UUID_C)).toBeNull();
  });
});

describe('vencimientos y pendientes', () => {
  it('cuenta los días que faltan (y los negativos si venció)', () => {
    expect(diasRestantes('2026-11-21T12:00:00.000Z', PUNTO)).toBe(10);
    expect(diasRestantes('2026-11-01T12:00:00.000Z', PUNTO)).toBeLessThan(0);
  });

  it('lista una sola vez por instalación y avisa de las vencidas', () => {
    const entradas = [
      // La vieja de A no debe salir: manda la renovación.
      entrada({ lic: 'LIC-2026-0001', venceEn: '2026-11-20T12:00:00.000Z' }),
      entrada({ lic: 'LIC-2026-0004', venceEn: '2027-06-01T12:00:00.000Z' }),
      entrada({ lic: 'LIC-2026-0005', instalacion: UUID_B, venceEn: '2026-12-01T12:00:00.000Z' }),
      entrada({ lic: 'LIC-2026-0006', instalacion: UUID_C, venceEn: '2026-11-05T12:00:00.000Z' }),
    ];

    const filas = pendientes(entradas, { ahora: PUNTO, dias: 30 });
    expect(filas.map((fila) => fila.lic)).toEqual(['LIC-2026-0006', 'LIC-2026-0005']);
    expect(filas[0].lic).toBe('LIC-2026-0006');
    expect(filas[0].diasRestantes).toBeLessThan(0);

    const texto = formatearPendientes(filas, { ahora: PUNTO, dias: 30 });
    expect(texto).toContain('LIC-2026-0006');
    expect(texto).toContain('VENCIDA');

    const vacio = formatearPendientes([], { ahora: PUNTO, dias: 30 });
    expect(vacio).toContain('No hay licencias');
  });

  it('una vitalicia no tiene días ni sale en pendientes; su texto lo dice', () => {
    expect(diasRestantes(null, PUNTO)).toBeNull();
    expect(textoVencimiento(null, PUNTO)).toContain('sin vencimiento');
    expect(pendientes([entradaVitalicia()], { ahora: PUNTO, dias: 3650 })).toEqual([]);

    const ficha = formatearDetalleLicencia(entradaVitalicia(), PUNTO);
    expect(ficha).toContain('Vitalicia (sin vencimiento)');
    expect(ficha).toContain('sin vencimiento');
    expect(ficha).not.toContain('VENCIDA');
  });

  it('la ficha de una renovación nombra la licencia anterior', () => {
    const ficha = formatearDetalleLicencia(
      entrada({
        renovacion: true,
        anterior: { lic: 'LIC-2026-0001', venceEn: '2026-12-01T12:00:00.000Z' },
        venceEn: '2027-01-30T12:00:00.000Z',
      }),
      PUNTO,
    );

    expect(ficha).toContain('Licencia LIC-2026-0001');
    expect(ficha).toContain('Renovación de LIC-2026-0001');
    expect(ficha).toContain('Consultorio Sonrisa');
  });
});

/* ── Emisión y renovación ─────────────────────────────────────────────────── */

describe('cálculo del vencimiento', () => {
  it('un mensual desde ahora dura 30 días y un anual 365', () => {
    expect(calcularVencimiento({ tipo: 'mensual', ahora: PUNTO })).toBe('2026-12-11T12:00:00.000Z');
    expect(calcularVencimiento({ tipo: 'anual', ahora: PUNTO })).toBe('2027-11-11T12:00:00.000Z');
    expect(diasDelTipo('trimestral')).toBe(LICENSE_KIND_DAYS.trimestral);
  });

  it('renovar antes de tiempo suma sobre el vencimiento vigente (no pierde días)', () => {
    expect(
      calcularVencimiento({
        tipo: 'mensual',
        ahora: PUNTO,
        vencimientoAnterior: '2026-12-01T12:00:00.000Z',
      }),
    ).toBe('2026-12-31T12:00:00.000Z');
  });

  it('si la anterior ya venció, empieza ahora; y --desde manda cuando es posterior', () => {
    expect(
      calcularVencimiento({
        tipo: 'mensual',
        ahora: PUNTO,
        vencimientoAnterior: '2026-01-01T12:00:00.000Z',
      }),
    ).toBe('2026-12-11T12:00:00.000Z');

    expect(
      calcularVencimiento({ tipo: 'mensual', ahora: PUNTO, desde: '2027-01-01T00:00:00.000Z' }),
    ).toBe('2027-01-31T00:00:00.000Z');
  });

  it('una vitalicia no calcula vencimiento y reemplazarla con un tipo con días empieza ahora', () => {
    expect(calcularVencimiento({ tipo: 'vitalicia', ahora: PUNTO })).toBeNull();
    expect(diasDelTipo('vitalicia')).toBeNull();
    expect(
      calcularVencimiento({
        tipo: 'mensual',
        ahora: PUNTO,
        vencimientoAnterior: null,
      }),
    ).toBe('2026-12-11T12:00:00.000Z');
  });

  it('rechaza tipos y fechas inválidas', () => {
    expect(() => calcularVencimiento({ tipo: 'semanal', ahora: PUNTO })).toThrow(/no válido/u);
    expect(() => calcularVencimiento({ tipo: 'mensual', ahora: 'no-es-fecha' })).toThrow(
      /fecha no válida/u,
    );
  });
});

describe('construcción de claims', () => {
  it('valida el cliente y el UUID, y normaliza lo opcional', () => {
    expect(() =>
      construirClaims({
        lic: 'LIC-2026-0001',
        tipo: 'mensual',
        instalacion: UUID_A,
        cliente: '',
        ahora: PUNTO,
        venceEn: '2026-12-11T12:00:00.000Z',
      }),
    ).toThrow(/no son válidos/u);

    expect(() =>
      construirClaims({
        lic: 'LIC-2026-0001',
        tipo: 'mensual',
        instalacion: 'no-es-uuid',
        cliente: 'Clínica',
        ahora: PUNTO,
        venceEn: '2026-12-11T12:00:00.000Z',
      }),
    ).toThrow(/no son válidos/u);

    const claims = construirClaims({
      lic: 'LIC-2026-0001',
      tipo: 'trimestral',
      instalacion: UUID_A,
      cliente: '  Clínica Sonrisa  ',
      rif: '  J-12345678-9 ',
      notas: '  pago móvil  ',
      ahora: PUNTO,
      venceEn: '2027-03-11T12:00:00.000Z',
    });
    expect(claims.cliente).toEqual({ nombre: 'Clínica Sonrisa', rif: 'J-12345678-9' });
    expect(claims.modulos).toEqual(['*']);
    expect(claims.notas).toBe('pago móvil');
  });
});

describe('emisión completa (firma → verificación)', () => {
  it('guarda el .lic, anota el registro y se verifica con la clave pública', async () => {
    const rutas = crearRutas();
    const { clavePrivada, clavePublica } = await parDeClaves();

    const resultado = await emitirLicencia({
      tipo: 'mensual',
      instalacion: UUID_A,
      cliente: 'Consultorio Sonrisa',
      rif: 'J-12345678-9',
      emitidaPor: 'cli',
      entradas: [],
      clavePrivada,
      rutas,
      ahora: PUNTO,
    });

    expect(resultado.claims.lic).toBe('LIC-2026-0001');
    expect(resultado.claims.venceEn).toBe('2026-12-11T12:00:00.000Z');
    expect(resultado.renovacion).toBe(false);
    expect(existsSync(resultado.archivo)).toBe(true);
    expect(readFileSync(resultado.archivo, 'utf8')).toBe(resultado.token);
    expect(await verifyLicenseToken(resultado.token, clavePublica)).toEqual(resultado.claims);

    const registro = leerRegistro(rutas.registro);
    expect(registro.invalidas).toEqual([]);
    expect(registro.entradas).toHaveLength(1);
    expect(registro.entradas[0].renovacion).toBe(false);
    expect(registro.entradas[0].archivo).toBe('LIC-2026-0001.lic');

    expect(formatearEmision(resultado)).toContain('Licencia emitida: LIC-2026-0001');
    expect(formatearVerificacion(resultado.claims, PUNTO)).toContain('vigente');
    expect(nombreArchivoLicencia(resultado.claims)).toBe(
      'licencia-LIC-2026-0001-consultorio-sonrisa.lic',
    );
  });

  it('renovar suma días sobre la anterior y deja rastro de la renovación', async () => {
    const rutas = crearRutas();
    const { clavePrivada, clavePublica } = await parDeClaves();

    await emitirLicencia({
      tipo: 'mensual',
      instalacion: UUID_A,
      cliente: 'Consultorio Sonrisa',
      emitidaPor: 'cli',
      entradas: [],
      clavePrivada,
      rutas,
      ahora: PUNTO,
    });

    const renovada = await emitirLicencia({
      tipo: 'anual',
      instalacion: UUID_A,
      cliente: 'Consultorio Sonrisa',
      emitidaPor: 'bot',
      entradas: leerRegistro(rutas.registro).entradas,
      clavePrivada,
      rutas,
      ahora: new Date('2026-11-20T12:00:00.000Z'),
    });

    expect(renovada.claims.lic).toBe('LIC-2026-0002');
    expect(renovada.claims.venceEn).toBe('2027-12-11T12:00:00.000Z');
    expect(renovada.renovacion).toBe(true);
    expect(renovada.entrada.anterior).toEqual({
      lic: 'LIC-2026-0001',
      venceEn: '2026-12-11T12:00:00.000Z',
    });
    expect(await verifyLicenseToken(renovada.token, clavePublica)).not.toBeNull();

    const registro = leerRegistro(rutas.registro);
    expect(registro.entradas).toHaveLength(2);
    expect(registro.entradas[1].emitidaPor).toBe('bot');
    expect(formatearEmision(renovada)).toContain('Renovación de LIC-2026-0001');
  });

  it('emite una vitalicia sin vencimiento, la firma y la deja en el registro', async () => {
    const rutas = crearRutas();
    const { clavePrivada, clavePublica } = await parDeClaves();

    const resultado = await emitirLicencia({
      tipo: 'vitalicia',
      instalacion: UUID_C,
      cliente: 'Consultorio Vitalicio',
      entradas: [],
      clavePrivada,
      rutas,
      ahora: PUNTO,
    });

    expect(resultado.claims.tipo).toBe('vitalicia');
    expect(resultado.claims.venceEn).toBeNull();
    expect(resultado.renovacion).toBe(false);
    expect(await verifyLicenseToken(resultado.token, clavePublica)).toEqual(resultado.claims);

    const registro = leerRegistro(rutas.registro);
    expect(registro.invalidas).toEqual([]);
    expect(registro.entradas[0].venceEn).toBeNull();

    const resumen = formatearEmision(resultado);
    expect(resumen).toContain('Vitalicia (sin vencimiento)');
    expect(resumen).toContain('Sin vencimiento');
    expect(formatearVerificacion(resultado.claims, PUNTO)).toContain('sin vencimiento');
  });

  it('una licencia emitida para otra instalación no sirve en esta (queda a la vista del verificador)', async () => {
    const rutas = crearRutas();
    const { clavePrivada, clavePublica } = await parDeClaves();

    const resultado = await emitirLicencia({
      tipo: 'mensual',
      instalacion: UUID_B,
      cliente: 'Otro consultorio',
      entradas: [],
      clavePrivada,
      rutas,
      ahora: PUNTO,
    });

    // La firma es válida; la atadura a la instalación la comprueba identity al
    // activar (`license_activation_rejected`), no el verificador criptográfico.
    const claims = await verifyLicenseToken(resultado.token, clavePublica);
    expect(claims?.instalacion).toBe(UUID_B);
    expect(claims?.instalacion).not.toBe(UUID_A);
  });
});

/* ── Solicitudes, formatos y variantes ────────────────────────────────────── */

describe('código de solicitud reenviado', () => {
  it('extrae y decodifica el ODO-REQ1. de un mensaje reenviado', () => {
    const solicitud = {
      v: 1,
      instalacion: UUID_A,
      cliente: { nombre: 'Clínica Sonrisa', rif: 'J-12345678-9' },
      tipoSolicitado: 'trimestral',
      generadaEn: '2026-11-11T12:00:00.000Z',
    };
    const codigo = encodeLicenseRequest(solicitud);
    const reenviado = `Reenvío del consultorio:\n${codigo}\nGracias.`;

    expect(extraerSolicitudDeTexto(reenviado)).toEqual(solicitud);
    expect(extraerSolicitudDeTexto('mensaje sin código')).toBeNull();
    expect(extraerSolicitudDeTexto('ODO-REQ1.esto-no-es-base64!')).toBeNull();
  });
});
