import { z } from 'zod';

/**
 * **Mensajes de validación en español** para los esquemas compartidos.
 *
 * Zod trae su propio juego de mensajes y, si nadie lo configura, salen **en inglés**
 * («Too small: expected string to have >=1 characters»); con el catálogo español de
 * Zod salen en español pero con la jerga del esquema delante («Demasiado grande: se
 * esperaba que número fuera <=60»). Aquí se instalan los del catálogo español y se
 * reescriben los que se pueden decir mejor —«no puede ser mayor que 60»— usando el
 * **límite** que el propio issue trae (`minimum`/`maximum`).
 *
 * Regla que hay que respetar: **un mensaje escrito por el esquema manda**. Zod solo
 * consulta este mapa cuando el esquema no trajo el suyo, así que los textos a medida
 * (`'Usa un color en formato #rrggbb'`, `'El correo no es válido'`…) no se tocan.
 *
 * Hace falta configurarlo **en cada proceso** porque la configuración de Zod es global
 * al módulo: los servicios lo hacen al cargar `@odontocrm/kernel` y la SPA al arrancar
 * (`main.tsx`). Sin esto, el servidor devolvía los motivos en inglés en el detalle por
 * campo del RFC 7807.
 */

/** Lo que Zod le pasa al mapa de errores (solo lo que se usa aquí). */
interface IssueDeZod {
  code?: string;
  origin?: string;
  minimum?: number;
  maximum?: number;
  inclusive?: boolean;
  expected?: string;
  format?: string;
}

/** Cómo se llama en español cada tipo que un esquema puede esperar. */
const TIPOS: Readonly<Record<string, string>> = {
  string: 'texto',
  number: 'número',
  int: 'número entero',
  boolean: 'booleano',
  bigint: 'número entero',
  array: 'lista',
  object: 'objeto',
  date: 'fecha',
  null: 'nulo',
  undefined: 'valor',
  file: 'archivo',
  symbol: 'valor',
};

/** Los formatos con nombre propio (`z.url()`, `z.email()`…) y cómo se dicen. */
const FORMATOS: Readonly<Record<string, string>> = {
  url: 'no es una URL completa',
  email: 'no es un correo válido',
  uuid: 'no es un identificador válido',
  datetime: 'no es una fecha y hora válidas',
  date: 'no es una fecha válida',
  time: 'no es una hora válida',
  regex: 'no tiene el formato esperado',
  e164: 'no es un teléfono válido',
  jwt: 'no es un token válido',
};

/** «1 carácter» / «2 caracteres»: el plural no se forma añadiendo una letra al singular. */
const concordar = (cantidad: number, singular: string, plural: string): string =>
  cantidad === 1 ? singular : plural;

/**
 * El texto de un issue **diciendo el límite**, o `undefined` para dejar el del catálogo
 * español (los casos que no tienen una forma mejor: uniones, claves sin fecha, etc.).
 */
const mensajeDeIssue = (issue: unknown): string | undefined => {
  const { code, origin, minimum, maximum, inclusive, expected, format } = (issue ??
    {}) as IssueDeZod;

  switch (code) {
    case 'too_small': {
      const limite = minimum ?? 0;
      if (origin === 'string') {
        return `no puede tener menos de ${limite} ${concordar(limite, 'carácter', 'caracteres')}`;
      }
      if (origin === 'array') {
        return `no puede tener menos de ${limite} ${concordar(limite, 'elemento', 'elementos')}`;
      }
      if (origin === 'number' || origin === 'bigint' || origin === 'date') {
        return `no puede ser ${inclusive === false ? 'menor o igual' : 'menor'} que ${limite}`;
      }
      return undefined;
    }
    case 'too_big': {
      const limite = maximum ?? 0;
      if (origin === 'string') {
        return `no puede tener más de ${limite} ${concordar(limite, 'carácter', 'caracteres')}`;
      }
      if (origin === 'array') {
        return `no puede tener más de ${limite} ${concordar(limite, 'elemento', 'elementos')}`;
      }
      if (origin === 'number' || origin === 'bigint' || origin === 'date') {
        return `no puede ser ${inclusive === false ? 'mayor o igual' : 'mayor'} que ${limite}`;
      }
      return undefined;
    }
    case 'invalid_type': {
      const tipo = expected === undefined ? 'un valor válido' : (TIPOS[expected] ?? expected);
      return `falta o no es ${tipo}`;
    }
    case 'invalid_format':
      return FORMATOS[format ?? ''];
    case 'invalid_value':
      return 'no es una de las opciones admitidas';
    case 'unrecognized_keys':
      return 'lleva campos que no se admiten';
    default:
      return undefined;
  }
};

/** El catálogo español de Zod, que es el que responde cuando no hay nada mejor que decir. */
const catalogoEspanol = z.locales.es();

/**
 * Instala los mensajes de validación en español en **este proceso**. Es idempotente:
 * llamarlo dos veces no cambia nada. Un mensaje escrito por el esquema sigue mandando.
 */
export const mensajesDeValidacionEnEspanol = (): void => {
  z.config({
    localeError: (issue) => mensajeDeIssue(issue) ?? catalogoEspanol.localeError(issue),
  });
};
