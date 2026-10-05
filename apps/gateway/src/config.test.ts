import { describe, expect, it } from 'vitest';

import { origenesPermitidos } from './config.js';

/**
 * En la clínica se entra por el nombre **o** por la IP de la LAN, y el navegador
 * manda el origen que se tecleó. Con un único valor permitido, entrar por el otro
 * dejaba la pantalla en blanco con un error de CORS (y el operador no tenía forma de
 * saber por qué). `WEB_ORIGIN` acepta una lista separada por comas.
 */
describe('orígenes permitidos para la SPA', () => {
  it('un solo origen se devuelve tal cual', () => {
    expect(origenesPermitidos('http://127.0.0.1:5173')).toEqual(['http://127.0.0.1:5173']);
  });

  it('admite el nombre y la IP, que es como entra la clínica', () => {
    expect(origenesPermitidos('https://odontocrm.local, https://192.168.1.50')).toEqual([
      'https://odontocrm.local',
      'https://192.168.1.50',
    ]);
  });

  it('ignora espacios y comas de más', () => {
    expect(origenesPermitidos(' https://a.local ,, https://192.168.1.50 , ')).toEqual([
      'https://a.local',
      'https://192.168.1.50',
    ]);
  });

  it('un valor vacío no produce orígenes (el esquema ya exige uno)', () => {
    expect(origenesPermitidos('')).toEqual([]);
  });
});
