import { describe, expect, it } from 'vitest';

import {
  SCREEN_SETTINGS_DEFAULT,
  abbreviateName,
  ageAt,
  criticalFlagsInputSchema,
  formatSseFrame,
  screenDeviceInputSchema,
  screenSettingsSchema,
} from './screens.js';

describe('nombres y edades de las pantallas', () => {
  it('abrevia el nombre como lo lee el paciente en la sala', () => {
    expect(abbreviateName('Juan Pérez Gómez')).toBe('Juan P.');
    expect(abbreviateName('  María   Isabel  Rojas ')).toBe('María I.');
    expect(abbreviateName('Ana')).toBe('Ana');
    expect(abbreviateName('')).toBe('');
    // Dos apellidos con partícula no rompen nada.
    expect(abbreviateName('Luis de la Cruz')).toBe('Luis D.');
  });

  it('calcula la edad cumplida en UTC', () => {
    expect(ageAt('1990-05-15', new Date('2026-10-03T12:00:00Z'))).toBe(36);
    expect(ageAt('1990-12-31', new Date('2026-10-03T12:00:00Z'))).toBe(35);
    expect(ageAt('2026-10-03', new Date('2026-10-03T23:00:00Z'))).toBe(0);
    expect(ageAt(null)).toBeNull();
    expect(ageAt('sin fecha')).toBeNull();
    // Una fecha futura no inventa una edad.
    expect(ageAt('2030-01-01', new Date('2026-10-03T12:00:00Z'))).toBeNull();
  });
});

describe('dispositivos de pantalla', () => {
  it('valida el alta y trae ajustes por defecto', () => {
    const input = screenDeviceInputSchema.parse({
      label: 'Lobby de la entrada',
      kind: 'lobby',
      tokenId: globalThis.crypto.randomUUID(),
    });

    expect(input.kind).toBe('lobby');
    expect(SCREEN_SETTINGS_DEFAULT).toMatchObject({
      voz: true,
      volumen: 1,
      resalteSegundos: 20,
      repetirSegundos: 0,
    });
  });

  it('completa los ajustes que falten sin perder los que vienen', () => {
    const settings = screenSettingsSchema.parse({ volumen: 0.4 });

    expect(settings.volumen).toBe(0.4);
    expect(settings.voz).toBe(true);
    expect(settings.resalteSegundos).toBe(20);
  });

  it('rechaza una pantalla sin nombre o con un token que no es uuid', () => {
    expect(
      screenDeviceInputSchema.safeParse({ label: 'ab', kind: 'lobby', tokenId: 'x' }).success,
    ).toBe(false);
  });
});

describe('datos críticos del consultorio', () => {
  it('acepta alergias y crónicos con su severidad', () => {
    const input = criticalFlagsInputSchema.parse({
      appointmentId: globalThis.crypto.randomUUID(),
      flags: [{ tipo: 'alergia', etiqueta: 'Penicilina', severidad: 'alto' }],
    });

    expect(input.flags[0]).toMatchObject({
      tipo: 'alergia',
      etiqueta: 'Penicilina',
      severidad: 'alto',
      detalle: null,
    });
  });

  it('la severidad cae en `info` si no se indica', () => {
    const flag = criticalFlagsInputSchema.parse({
      appointmentId: globalThis.crypto.randomUUID(),
      flags: [{ tipo: 'cronico', etiqueta: 'Hipertensión' }],
    }).flags[0];

    expect(flag?.severidad).toBe('info');
  });
});

describe('tramas SSE', () => {
  it('formatea un evento con su id y sus datos', () => {
    const trama = formatSseFrame({
      id: 'llamado-1',
      evento: 'lobby',
      datos: { waitingCount: 2 },
    });

    expect(trama).toBe('id: llamado-1\nevent: lobby\ndata: {"waitingCount":2}\n\n');
    expect(trama.endsWith('\n\n')).toBe(true);
  });
});
