import { describe, expect, it } from 'vitest';

import {
  ADMIN_BOT_COMMANDS,
  BOT_COMMANDS,
  BOT_COMMAND_LIMITS,
  BOT_INTENTS,
  adminBotCommandsAsText,
  botCommandsAsText,
  detectIntent,
  numberedOptions,
  resolveNumberedOption,
  toAdminMenuCommands,
  toMenuCommands,
  type OutboundButton,
} from './channel.js';

/** Opciones de un paso, como las manda el asistente. */
const buttons: OutboundButton[] = [
  { etiqueta: 'Venezolano', accion: 'doc:V' },
  { etiqueta: 'Extranjero', accion: 'doc:E' },
  { etiqueta: 'Pasaporte', accion: 'doc:P' },
];

describe('opciones numeradas (canales sin botones)', () => {
  it('numera las opciones y devuelve la acción de cada número', () => {
    const { texto, acciones } = numberedOptions(buttons);

    expect(texto).toBe('1) Venezolano\n2) Extranjero\n3) Pasaporte');
    expect(acciones.get('1')).toBe('doc:V');
    expect(acciones.get('3')).toBe('doc:P');
  });

  it('traduce lo que responde el paciente', () => {
    const { acciones } = numberedOptions(buttons);

    // Solo el número, el número con paréntesis o el número con el texto detrás.
    expect(resolveNumberedOption('2', acciones)).toBe('doc:E');
    expect(resolveNumberedOption(' 2) Extranjero', acciones)).toBe('doc:E');
    expect(resolveNumberedOption('doc:E', acciones)).toBeNull();
    expect(resolveNumberedOption('9', acciones)).toBeNull();
  });
});

describe('intenciones del asistente', () => {
  const conComandos = { comandos: true };
  const sinComandos = { comandos: false };

  it('traduce los comandos de Telegram a intenciones', () => {
    expect(detectIntent('/nueva', conComandos)).toMatchObject({
      intencion: 'nueva',
      comando: true,
    });
    expect(detectIntent('/estado #000123', conComandos)).toMatchObject({
      intencion: 'estado',
      argumento: '#000123',
      comando: true,
    });
    // El sufijo `@bot` de los grupos no cambia la intención.
    expect(detectIntent('/mi_ticket@odegcrmbot', conComandos).intencion).toBe('mi_ticket');
    expect(detectIntent('/start CODIGO12', conComandos)).toMatchObject({
      intencion: 'start',
      argumento: 'CODIGO12',
    });
  });

  it('en canales sin comandos, un `/algo` no es una intención', () => {
    expect(detectIntent('/nueva', sinComandos)).toEqual({
      intencion: null,
      argumento: '',
      comando: true,
    });
  });

  it('reconoce las frases naturales de WhatsApp', () => {
    expect(detectIntent('quiero una cita', sinComandos).intencion).toBe('nueva');
    expect(detectIntent('  Cita  ', sinComandos).intencion).toBe('nueva');
    expect(detectIntent('¿Cómo va mi cita?', sinComandos).intencion).toBe('estado');
    expect(detectIntent('CANCELAR', sinComandos).intencion).toBe('cancelar');
    expect(detectIntent('Menú', sinComandos).intencion).toBe('ayuda');
  });

  it('no inventa intenciones donde no las hay', () => {
    expect(detectIntent('María Pérez', sinComandos).intencion).toBeNull();
    expect(detectIntent('0412-1234567', sinComandos).intencion).toBeNull();
    expect(detectIntent('no quiero cancelar nada todavía', sinComandos).intencion).toBeNull();
    expect(detectIntent('/desconocido', conComandos)).toMatchObject({
      intencion: null,
      comando: true,
    });
    expect(detectIntent('', conComandos)).toEqual({
      intencion: null,
      argumento: '',
      comando: false,
    });
  });
});

describe('menú de comandos (Telegram)', () => {
  const conComandos = { comandos: true };

  it('cada comando del menú lo entiende el asistente', () => {
    for (const comando of BOT_COMMANDS) {
      // Es la comprobación que evita el fallo tonto: menú y asistente no se
      // separan, porque el menú sale del mismo catálogo que las intenciones.
      expect(detectIntent(`/${comando.comando}`, conComandos).intencion).toBe(comando.intencion);
      // El sufijo `@bot` de los grupos tampoco lo rompe.
      expect(detectIntent(`/${comando.comando}@odegcrmbot`, conComandos).intencion).toBe(
        comando.intencion,
      );
    }
  });

  it('los comandos con argumento lo aceptan y los demás no lo necesitan', () => {
    const estado = BOT_COMMANDS.find((comando) => comando.comando === 'estado');
    expect(estado?.admiteArgumento).toBe(true);
    expect(detectIntent('/estado #000123', conComandos)).toMatchObject({
      intencion: 'estado',
      argumento: '#000123',
    });
    expect(
      BOT_COMMANDS.find((comando) => comando.comando === 'nueva')?.admiteArgumento,
    ).toBeFalsy();
  });

  it('cubre todas las intenciones y respeta los límites del canal', () => {
    const intenciones = new Set(BOT_COMMANDS.map((comando) => comando.intencion));
    for (const intencion of BOT_INTENTS) {
      expect(intenciones.has(intencion)).toBe(true);
    }

    expect(BOT_COMMANDS.length).toBeLessThanOrEqual(BOT_COMMAND_LIMITS.maxComandos);
    for (const comando of BOT_COMMANDS) {
      // Telegram rechaza el menú entero si un comando no cumple el formato.
      expect(comando.comando).toMatch(/^[a-z0-9_]{1,32}$/);
      expect(comando.comando.length).toBeLessThanOrEqual(BOT_COMMAND_LIMITS.maxLargoComando);
      expect(comando.descripcion.length).toBeGreaterThanOrEqual(
        BOT_COMMAND_LIMITS.minLargoDescripcion,
      );
      expect(comando.descripcion.length).toBeLessThanOrEqual(
        BOT_COMMAND_LIMITS.maxLargoDescripcion,
      );
    }

    // Sin nombres ni descripciones repetidas: el menú se confunde si se repiten.
    expect(new Set(BOT_COMMANDS.map((comando) => comando.comando)).size).toBe(BOT_COMMANDS.length);
    expect(new Set(BOT_COMMANDS.map((comando) => comando.descripcion)).size).toBe(
      BOT_COMMANDS.length,
    );
  });

  it('el menú viaja con la forma que pide la API y la ayuda con la que lee la gente', () => {
    expect(toMenuCommands()[0]).toEqual({
      command: BOT_COMMANDS[0]?.comando,
      description: BOT_COMMANDS[0]?.descripcion,
    });

    const texto = botCommandsAsText();
    for (const comando of BOT_COMMANDS) {
      expect(texto).toContain(`/${comando.comando} — ${comando.descripcion}`);
    }
    expect(texto.split('\n')).toHaveLength(BOT_COMMANDS.length);
  });
});

describe('menú de comandos (bot de administración)', () => {
  it('respeta el formato y los límites de Telegram', () => {
    expect(ADMIN_BOT_COMMANDS.length).toBeLessThanOrEqual(BOT_COMMAND_LIMITS.maxComandos);
    for (const comando of ADMIN_BOT_COMMANDS) {
      // Telegram rechaza el menú entero si un comando no cumple el formato.
      expect(comando.comando).toMatch(/^[a-z0-9_]{1,32}$/);
      expect(comando.comando.length).toBeLessThanOrEqual(BOT_COMMAND_LIMITS.maxLargoComando);
      expect(comando.descripcion.length).toBeGreaterThanOrEqual(
        BOT_COMMAND_LIMITS.minLargoDescripcion,
      );
      expect(comando.descripcion.length).toBeLessThanOrEqual(
        BOT_COMMAND_LIMITS.maxLargoDescripcion,
      );
    }
    expect(new Set(ADMIN_BOT_COMMANDS.map((comando) => comando.comando)).size).toBe(
      ADMIN_BOT_COMMANDS.length,
    );
    expect(new Set(ADMIN_BOT_COMMANDS.map((comando) => comando.descripcion)).size).toBe(
      ADMIN_BOT_COMMANDS.length,
    );
  });

  it('viaja con la forma de la API y con la ayuda en texto', () => {
    expect(toAdminMenuCommands()[0]).toEqual({
      command: ADMIN_BOT_COMMANDS[0]?.comando,
      description: ADMIN_BOT_COMMANDS[0]?.descripcion,
    });

    const texto = adminBotCommandsAsText();
    for (const comando of ADMIN_BOT_COMMANDS) {
      expect(texto).toContain(`/${comando.comando} — ${comando.descripcion}`);
    }
    expect(texto.split('\n')).toHaveLength(ADMIN_BOT_COMMANDS.length);
  });

  it('es un catálogo aparte del de los pacientes', () => {
    // Son bots distintos (tokens distintos), así que reutilizar `/estado` no molesta.
    expect(ADMIN_BOT_COMMANDS).not.toEqual(BOT_COMMANDS);
    expect(ADMIN_BOT_COMMANDS.map((comando) => comando.comando)).toContain('respaldos');
  });

  /**
   * Los dos respaldos se parecen en el nombre (`/respaldos` y `/respaldo`) y hacen cosas
   * distintas: el primero manda los volcados por chat y el segundo deja la copia completa en el
   * servidor. La descripción es lo único que los distingue en el menú, así que tiene que decirlo.
   */
  it('el respaldo completo se distingue del que viaja por chat', () => {
    const respaldo = ADMIN_BOT_COMMANDS.find((comando) => comando.comando === 'respaldo');
    expect(respaldo?.descripcion).toMatch(/servidor|completo/i);
    expect(respaldo?.admiteArgumento).toBeFalsy();
  });
});
