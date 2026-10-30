import { describe, expect, it } from 'vitest';

import { confirmacionDesdeTexto, sexoDesdeTexto } from './asistente.js';

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
