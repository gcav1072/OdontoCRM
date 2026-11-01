import { describe, expect, it } from 'vitest';

import {
  clasificarDesactualizadas,
  esVersionExacta,
  evaluarCompatibilidadBoom,
  resumirCambiosLock,
} from './deps.mjs';

describe('clasificación y reglas de actualización de dependencias (tools/deps.mjs)', () => {
  it('distingue versiones exactas de rangos semver', () => {
    expect(esVersionExacta('7.0.0-rc14')).toBe(true);
    expect(esVersionExacta('9.1.4')).toBe(true);
    expect(esVersionExacta('^5.12.5')).toBe(false);
    expect(esVersionExacta('~1.5.4')).toBe(false);
    expect(esVersionExacta('*')).toBe(false);
  });

  it('separa seguras, mayores y Baileys aunque un paquete figure en varios workspaces', () => {
    const outdated = {
      fastify: [
        { current: '5.12.5', wanted: '5.12.7', latest: '5.12.7', dependent: 'billing' },
        { current: '5.12.5', wanted: '5.12.7', latest: '5.12.7', dependent: 'gateway' },
      ],
      '@fastify/multipart': [
        { current: '9.4.0', wanted: '9.4.0', latest: '10.1.6', dependent: 'clinical' },
        { current: '9.4.0', wanted: '9.4.0', latest: '10.1.6', dependent: 'patients' },
      ],
      '@hookform/resolvers': {
        current: '5.9.1',
        wanted: '5.9.2',
        latest: '7.0.1',
        dependent: 'web',
      },
      '@whiskeysockets/baileys': {
        current: '7.0.0-rc14',
        wanted: '7.0.0-rc14',
        latest: '7.0.0-rc15',
        dependent: 'notifications',
      },
    };

    const res = clasificarDesactualizadas(outdated, {
      baileysDeclarado: '7.0.0-rc14',
      baileysLatest: '7.0.0-rc15',
      boomDeclarado: '9.1.4',
    });

    expect(res.baileys).toMatchObject({
      actual: '7.0.0-rc14',
      latest: '7.0.0-rc15',
      exacto: true,
      alDia: false,
      boom: '9.1.4',
    });

    expect(res.seguras.map((x) => x.paquete)).toEqual(['@hookform/resolvers', 'fastify']);
    expect(res.seguras[1]?.dependientes).toEqual(['billing', 'gateway']);

    expect(res.mayores.map((x) => x.paquete)).toEqual([
      '@fastify/multipart',
      '@hookform/resolvers',
    ]);
  });

  it('comprueba la compatibilidad de @hapi/boom requerida por Baileys', () => {
    expect(evaluarCompatibilidadBoom('^9.1.3', '9.1.4')).toEqual({
      compatible: true,
      sugerida: null,
    });
    expect(evaluarCompatibilidadBoom('^10.0.1', '9.1.4')).toEqual({
      compatible: false,
      sugerida: '10.0.1',
    });
    expect(evaluarCompatibilidadBoom('^9.2.0', '9.1.4')).toEqual({
      compatible: false,
      sugerida: '9.2.0',
    });
  });

  it('resume los cambios de primer nivel entre dos package-lock.json', () => {
    const antes = {
      packages: {
        'node_modules/fastify': { version: '5.12.5' },
        'node_modules/zod': { version: '4.6.5' },
        'node_modules/avvio': { version: '9.1.0' },
        'node_modules/@whiskeysockets/baileys/node_modules/pino': { version: '9.6.0' },
      },
    };
    const despues = {
      packages: {
        'node_modules/fastify': { version: '5.12.7' },
        'node_modules/zod': { version: '4.6.5' },
        'node_modules/avvio': { version: '9.1.2' },
        'node_modules/@whiskeysockets/baileys/node_modules/pino': { version: '9.7.0' },
      },
    };

    const cambios = resumirCambiosLock(antes, despues, new Set(['fastify', 'zod']));
    expect(cambios).toEqual([
      { paquete: 'avvio', antes: '9.1.0', despues: '9.1.2', directo: false },
      { paquete: 'fastify', antes: '5.12.5', despues: '5.12.7', directo: true },
    ]);
  });
});
