import { mensajesDeValidacionEnEspanol } from '@odontocrm/contracts';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { ValidationError } from './errors.js';
import { parseOrThrow, parseQuery } from './validation.js';

describe('errores de validación', () => {
  it('el mensaje nombra los campos que fallaron, además de en `errors`', () => {
    const schema = z.object({ titulo: z.string().min(1), logo: z.number().max(60) });
    const fallo = ((): unknown => {
      try {
        parseOrThrow(schema, { titulo: '', logo: 99 });
        return null;
      } catch (error) {
        return error;
      }
    })();

    expect(fallo).toBeInstanceOf(ValidationError);
    const error = fallo as ValidationError;
    // El `detail` es lo único que pinta un cliente que no lee `errors[]`.
    expect(error.message).toBe(
      'Los datos enviados no son válidos — titulo (no puede tener menos de 1 carácter) · ' +
        'logo (no puede ser mayor que 60)',
    );
    expect(error.errors).toEqual([
      { path: 'titulo', message: 'no puede tener menos de 1 carácter', code: 'too_small' },
      { path: 'logo', message: 'no puede ser mayor que 60', code: 'too_big' },
    ]);
  });

  it('el nombre del campo va sin dos puntos para no parecer una credencial', () => {
    // `sanitizeMessage` censura «password: …»; con `campo (motivo)` no lo confunde.
    const schema = z.object({ password: z.string().min(8) });
    const fallo = ((): ValidationError => {
      try {
        parseOrThrow(schema, { password: 'corta' });
        throw new Error('no falló');
      } catch (error) {
        return error as ValidationError;
      }
    })();

    expect(fallo.message).toContain('password (no puede tener menos de 8 caracteres)');
    expect(fallo.message).not.toContain('password=');
  });

  it('resume los campos de más en vez de alargar el mensaje sin fin', () => {
    const schema = z.object({
      a: z.string().min(1),
      b: z.string().min(1),
      c: z.string().min(1),
      d: z.string().min(1),
      e: z.string().min(1),
    });
    const fallo = ((): ValidationError => {
      try {
        parseOrThrow(schema, {});
        throw new Error('no falló');
      } catch (error) {
        return error as ValidationError;
      }
    })();

    expect(fallo.message).toContain('· y 2 más');
    expect(fallo.errors).toHaveLength(5);
  });

  it('sin campos detectados, el mensaje se queda como venía', () => {
    expect(new ValidationError().message).toBe('Los datos enviados no son válidos');
    expect(new ValidationError('Rango inválido', []).message).toBe('Rango inválido');
  });

  it('los filtros de la consulta también nombran su campo', () => {
    const schema = z.object({ desde: z.string().min(1) });
    const fallo = ((): ValidationError => {
      try {
        parseQuery(schema, { desde: '' });
        throw new Error('no falló');
      } catch (error) {
        return error as ValidationError;
      }
    })();

    expect(fallo.message).toBe(
      'Los filtros de la consulta no son válidos — desde (no puede tener menos de 1 carácter)',
    );
  });

  it('el cuerpo que no es un objeto se señala como «(cuerpo)»', () => {
    const fallo = ((): ValidationError => {
      try {
        parseOrThrow(z.object({ a: z.string() }), 'texto');
        throw new Error('no falló');
      } catch (error) {
        return error as ValidationError;
      }
    })();

    expect(fallo.message).toContain('(cuerpo)');
  });
});

describe('mensajes de Zod en español en los servicios', () => {
  it('el módulo los instala al cargarse (sin configurar nada más)', () => {
    // `parseOrThrow` vive en este módulo, así que importarlo ya deja Zod en español:
    // antes el detalle por campo del RFC 7807 salía en inglés.
    const resultado = z.object({ color: z.string().regex(/^#[0-9a-f]{6}$/) }).safeParse({
      color: 'rojo',
    });
    expect(resultado.success).toBe(false);
    if (!resultado.success) {
      expect(resultado.error.issues[0]?.message).not.toMatch(/Invalid|expected/i);
    }
    // Y el helper exportado es idempotente.
    expect(() => {
      mensajesDeValidacionEnEspanol();
    }).not.toThrow();
  });
});
