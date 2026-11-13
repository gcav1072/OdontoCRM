import { botDraftSchema, type BotDraft } from '@odontocrm/contracts';
import { describe, expect, it } from 'vitest';

import {
  abbreviateName,
  botonesDecisionCita,
  coincideVerificacion,
  confirmacionDesdeTexto,
  corregirCampoDesdeTexto,
  estadoAnterior,
  menuRapidoButtons,
  sexoDesdeTexto,
} from './asistente.js';

const borrador = (datos: Record<string, unknown> = {}): BotDraft => botDraftSchema.parse(datos);

/**
 * El paso «Sexo» acepta la letra además del número de la opción.
 *
 * En WhatsApp las opciones viajan numeradas, pero mucha gente responde «M», «f»
 * o «Masculino». Antes eso caía en el estado por defecto y el paciente recibía la
 * bienvenida en mitad del alta; ahora se reconoce sin importar mayúsculas, tildes
 * ni puntuación.
 */
describe('sexo escrito por el paciente', () => {
  it.each([
    ['M', 'M'],
    ['m', 'M'],
    [' Masculino ', 'M'],
    ['HOMBRE', 'M'],
    ['F', 'F'],
    ['f.', 'F'],
    ['Femenino', 'F'],
    ['mujer', 'F'],
    ['O', 'O'],
    ['otro', 'O'],
    ['Otra', 'O'],
  ])('«%s» se reconoce como %s', (texto, esperado) => {
    expect(sexoDesdeTexto(texto)).toBe(esperado);
  });

  it('no confunde un nombre ni una palabra cualquiera con una opción', () => {
    expect(sexoDesdeTexto('María')).toBeNull();
    expect(sexoDesdeTexto('no sé')).toBeNull();
    expect(sexoDesdeTexto('')).toBeNull();
  });
});

/**
 * El resumen final del alta también acepta palabras: escribir «confirmar» no
 * debe confundirse con la intención de confirmar una cita ya agendada.
 */
describe('confirmación final por texto', () => {
  it.each([
    ['confirmar', 'si'],
    ['Confirmo', 'si'],
    ['sí', 'si'],
    ['Sí, todo bien', 'si'],
    ['1', 'si'],
    ['correcto', 'si'],
    ['corregir', 'no'],
    ['Corrijo', 'no'],
    ['no', 'no'],
    ['2', 'no'],
    ['incorrecto', 'no'],
  ])('«%s» se interpreta como %s', (texto, esperado) => {
    expect(confirmacionDesdeTexto(texto)).toBe(esperado);
  });

  it('otras frases no deciden por el paciente', () => {
    expect(confirmacionDesdeTexto('María Pérez')).toBeNull();
    expect(confirmacionDesdeTexto('quiero una cita')).toBeNull();
    expect(confirmacionDesdeTexto('')).toBeNull();
  });
});

/**
 * v1.2 — Verificación ligera de identidad (2.º chat): el nombre se abrevia y la
 * prueba es la fecha de nacimiento o los últimos 4 dígitos del teléfono.
 */
describe('nombre abreviado y verificación de identidad', () => {
  it.each([
    ['María Pérez', 'María P.'],
    ['  maría   pérez garcía ', 'maría P.'],
    ['Ana', 'Ana'],
    ['', ''],
  ])('«%s» se abrevia como «%s»', (nombre, esperado) => {
    expect(abbreviateName(nombre)).toBe(esperado);
  });

  const candidato = { birthDate: '1990-05-15', phone: '+584121234567' };

  it('acierta con la fecha de nacimiento en cualquiera de sus formatos', () => {
    expect(coincideVerificacion('15/05/1990', candidato)).toBe(true);
    expect(coincideVerificacion('15-05-1990', candidato)).toBe(true);
    expect(coincideVerificacion('15.5.90', candidato)).toBe(true);
  });

  it('acierta con los últimos 4 dígitos del teléfono', () => {
    expect(coincideVerificacion('4567', candidato)).toBe(true);
    expect(coincideVerificacion(' 4567 ', candidato)).toBe(true);
  });

  it('falla con una fecha distinta, pocos dígitos o datos ausentes', () => {
    expect(coincideVerificacion('16/05/1990', candidato)).toBe(false);
    expect(coincideVerificacion('456', candidato)).toBe(false);
    expect(coincideVerificacion('9999', candidato)).toBe(false);
    expect(coincideVerificacion('15/05/1990', { birthDate: null, phone: null })).toBe(false);
  });
});

/**
 * v1.2 — Menú de corrección: un paciente ya registrado solo puede cambiar el
 * motivo o empezar de nuevo; un alta a medias puede corregir cualquier campo.
 */
describe('menú de corrección', () => {
  it.each([
    ['teléfono', 'telefono'],
    ['cedula', 'documento'],
    ['documento', 'documento'],
    ['fecha de nacimiento', 'nacimiento'],
    ['sexo', 'sexo'],
    ['motivo', 'motivo'],
    ['corregir todo', 'todo'],
    ['reiniciar', 'todo'],
    ['volver', 'volver'],
    ['atrás', 'volver'],
  ] as const)('para un paciente nuevo, «%s» → %s', (texto, esperado) => {
    expect(corregirCampoDesdeTexto(texto, false)).toBe(esperado);
  });

  it('un paciente existente solo puede corregir el motivo o empezar de cero', () => {
    expect(corregirCampoDesdeTexto('motivo', true)).toBe('motivo');
    expect(corregirCampoDesdeTexto('todo', true)).toBe('todo');
    // «Cambiar de cédula» es «corregir todo» con la ficha soltada.
    expect(corregirCampoDesdeTexto('cédula', true)).toBe('todo');
    expect(corregirCampoDesdeTexto('volver', true)).toBe('volver');
    expect(corregirCampoDesdeTexto('nombre', true)).toBeNull();
    expect(corregirCampoDesdeTexto('teléfono', true)).toBeNull();
  });

  it('no confunde un texto cualquiera con una corrección', () => {
    expect(corregirCampoDesdeTexto('María Pérez', false)).toBeNull();
    expect(corregirCampoDesdeTexto('', false)).toBeNull();
  });
});

/** v1.2 — «volver» retrocede un paso en el orden nuevo, conservando el borrador. */
describe('paso anterior del flujo', () => {
  it.each([
    ['documento', 'documento'],
    ['nombre', 'documento'],
    ['telefono', 'nombre'],
    ['nacimiento', 'telefono'],
    ['representante', 'nacimiento'],
    ['motivo', 'sexo'],
  ] as const)('desde «%s» vuelve a «%s»', (estado, esperado) => {
    expect(estadoAnterior(estado, borrador())).toBe(esperado);
  });

  it('el sexo vuelve al representante si lo hay y, si no, al nacimiento', () => {
    expect(estadoAnterior('sexo', borrador({ guardianName: 'Laura' }))).toBe('representante');
    expect(estadoAnterior('sexo', borrador())).toBe('nacimiento');
  });

  it('en el inicio no hay paso anterior', () => {
    expect(estadoAnterior('inicio', borrador())).toBeNull();
  });
});

/** v1.2 — Menú rápido de bienvenida y ayuda. */
describe('menú rápido', () => {
  it('un chat sin vincular ofrece 4 acciones y no «Cambiar de paciente»', () => {
    const botones = menuRapidoButtons(false);
    expect(botones.map((boton) => boton.accion)).toEqual([
      'menu:nueva',
      'menu:estado',
      'menu:confirmar',
      'menu:cancelar',
    ]);
    // v1.2.2: una sola entrada para las dos acciones (ADR 0077).
    expect(botones[3]?.etiqueta).toBe('Posponer o cancelar mi cita');
  });

  it('un chat vinculado añade «Cambiar de paciente»', () => {
    const botones = menuRapidoButtons(true);
    expect(botones.at(-1)).toEqual({ etiqueta: 'Cambiar de paciente', accion: 'menu:desvincular' });
  });

  it('la pregunta posponer/cancelar usa las acciones nuevas y cabe en los límites', () => {
    const citaId = '00000000-0000-4000-8000-000000000000';
    const botones = botonesDecisionCita(citaId);
    expect(botones.map((boton) => boton.accion)).toEqual([
      `posponer_cita:${citaId}`,
      `cancelar_definitiva:${citaId}`,
    ]);
    for (const boton of botones) {
      // Cloud API no acepta títulos de más de 20 caracteres; Telegram `callback_data`
      // de más de 64 bytes (el de la definitiva mide 56).
      expect(boton.etiqueta.length).toBeLessThanOrEqual(20);
      expect(Buffer.byteLength(boton.accion, 'utf8')).toBeLessThanOrEqual(64);
    }
  });
});
