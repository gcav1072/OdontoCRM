import { describe, expect, it } from 'vitest';

import { resumir } from './pm2-resumen.mjs';

/**
 * El resumen que los guiones de instalación de Windows leen de `pm2 jlist`.
 *
 * El caso gordo está aquí para que no vuelva: el JSON real de PM2 trae el `env` completo de
 * cada proceso, con claves que solo difieren en mayúsculas (`username`/`USERNAME`). A Node no
 * le importa, pero era lo que tumbaba al `ConvertFrom-Json` de PowerShell 5.1 y dejaba la
 * verificación diciendo «no está en PM2» con todo en marcha (2026-10-15).
 */

const JLIST = `[
  {"pid":9372,"name":"odontocrm-gateway","pm2_env":{"status":"online","env":{"USERNAME":"Admin","username":"Admin","PATH":"C:\\\\Windows","marcas":"a[b]{c}"}},"pm_id":0},
  {"pid":9400,"name":"odontocrm-identity","pm2_env":{"status":"stopping","env":{"USERNAME":"Admin","username":"Admin"}},"pm_id":1}
]`;

describe('el resumen de pm2 jlist', () => {
  it('deja nombre y estado de cada proceso', () => {
    expect(resumir(JLIST)).toEqual([
      { nombre: 'odontocrm-gateway', estado: 'online' },
      { nombre: 'odontocrm-identity', estado: 'stopping' },
    ]);
  });

  it('tolera los avisos que el CLI escribe alrededor del JSON', () => {
    const conAvisos = `[PM2] Spawning PM2 daemon...\n${JLIST}\n[PM2] Saving current process list...\n`;
    expect(resumir(conAvisos)).toHaveLength(2);
    expect(resumir(conAvisos)[0]).toEqual({ nombre: 'odontocrm-gateway', estado: 'online' });
  });

  it('marca como desconocido un proceso sin estado', () => {
    const sinEstado = `[{"name":"odontocrm-gateway","pm2_env":{}}]`;
    expect(resumir(sinEstado)).toEqual([{ nombre: 'odontocrm-gateway', estado: 'desconocido' }]);
  });

  it('falla claro si en la entrada no hay ninguna lista', () => {
    expect(() => resumir('PM2 daemon not running')).toThrow(/no veo la lista/);
  });
});
