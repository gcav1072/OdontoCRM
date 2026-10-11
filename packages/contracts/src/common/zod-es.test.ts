import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { mensajesDeValidacionEnEspanol } from './zod-es.js';

mensajesDeValidacionEnEspanol();

/** Los mensajes que produce un esquema al fallar (en orden). */
const mensajes = (schema: z.ZodType, valor: unknown): string[] => {
  const resultado = schema.safeParse(valor);
  if (resultado.success) return [];
  return resultado.error.issues.map((issue) => issue.message);
};

describe('mensajes de validación en español', () => {
  it('dice el límite cuando el valor se pasa por arriba o por abajo', () => {
    const schema = z.object({
      titulo: z.string().min(1),
      logo: z.number().max(60),
      opacidad: z.number().min(0),
    });
    const fallos = mensajes(schema, { titulo: '', logo: 99, opacidad: -1 });
    expect(fallos).toEqual([
      'no puede tener menos de 1 carácter',
      'no puede ser mayor que 60',
      'no puede ser menor que 0',
    ]);
  });

  it('no dice «<=1 caracteres»: concuerda el singular', () => {
    expect(mensajes(z.string().max(1), 'ab')).toEqual(['no puede tener más de 1 carácter']);
    expect(mensajes(z.string().max(2), 'abc')).toEqual(['no puede tener más de 2 caracteres']);
  });

  it('nombra el tipo que faltaba y los formatos con nombre propio', () => {
    expect(mensajes(z.string(), null)).toEqual(['falta o no es texto']);
    expect(mensajes(z.number().int(), 1.5)).toEqual(['falta o no es número entero']);
    expect(mensajes(z.url(), 'no-es-url')).toEqual(['no es una URL completa']);
    expect(mensajes(z.email(), 'no-es-correo')).toEqual(['no es un correo válido']);
    expect(mensajes(z.uuid(), 'x')).toEqual(['no es un identificador válido']);
  });

  it('el mensaje escrito en el esquema manda sobre el del catálogo', () => {
    // Los textos a medida del repositorio (colores, correo del paciente) no se tocan:
    // Zod solo consulta este mapa cuando el esquema no trajo el suyo.
    expect(mensajes(z.string().min(1, 'mensaje propio'), '')).toEqual(['mensaje propio']);
    expect(mensajes(z.email('El correo no es válido'), 'x')).toEqual(['El correo no es válido']);
    expect(
      mensajes(
        z.string().refine((valor) => valor === '' || valor.startsWith('http'), {
          message: 'Debe ser una URL completa',
        }),
        'x',
      ),
    ).toEqual(['Debe ser una URL completa']);
    expect(mensajes(z.enum(['a', 'b'], { message: 'opción propia' }), 'z')).toEqual([
      'opción propia',
    ]);
  });

  it('los casos sin mejor forma salen igualmente en español', () => {
    const fallos = mensajes(z.union([z.null(), z.literal(''), z.email()]), 'x');
    expect(fallos).toHaveLength(1);
    expect(fallos[0]).not.toMatch(/invalid|expected|Invalid/i);
  });
});
