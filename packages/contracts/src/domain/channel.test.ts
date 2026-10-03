import { describe, expect, it } from 'vitest';

import {
  detectIntent,
  numberedOptions,
  resolveNumberedOption,
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
