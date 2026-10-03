import { describe, expect, it } from 'vitest';

import {
  generateTemporaryPassword,
  hashPassword,
  needsRehash,
  SCRYPT_PARAMS,
  verifyPassword,
} from './password.js';

describe('contraseñas con scrypt', () => {
  it('genera un hash con sus parámetros y verifica la contraseña correcta', async () => {
    const hash = await hashPassword('consultorio-2026');

    expect(hash.startsWith('scrypt$')).toBe(true);
    expect(hash.split('$')).toHaveLength(6);
    await expect(verifyPassword('consultorio-2026', hash)).resolves.toBe(true);
  });

  it('rechaza la contraseña incorrecta, el hash corrupto y el vacío', async () => {
    const hash = await hashPassword('consultorio-2026');

    await expect(verifyPassword('otra-clave', hash)).resolves.toBe(false);
    await expect(verifyPassword('consultorio-2026', 'no-es-un-hash')).resolves.toBe(false);
    await expect(verifyPassword('consultorio-2026', '')).resolves.toBe(false);
    await expect(verifyPassword('', hash)).resolves.toBe(false);
  });

  it('usa una sal distinta en cada hash (misma contraseña, hashes distintos)', async () => {
    const [first, second] = await Promise.all([
      hashPassword('consultorio-2026'),
      hashPassword('consultorio-2026'),
    ]);

    expect(first).not.toBe(second);
    await expect(verifyPassword('consultorio-2026', first)).resolves.toBe(true);
    await expect(verifyPassword('consultorio-2026', second)).resolves.toBe(true);
  });

  it('normaliza unicode: la misma contraseña con otra forma compone igual', async () => {
    const composed = 'contraseña-2026';
    const decomposed = composed.normalize('NFD');
    const hash = await hashPassword(composed);

    await expect(verifyPassword(decomposed, hash)).resolves.toBe(true);
  });

  it('detecta cuándo hace falta re-hashear', async () => {
    const hash = await hashPassword('consultorio-2026');
    expect(needsRehash(hash)).toBe(false);
    expect(needsRehash(`scrypt$1024$8$1$c2FsdA$aGFzaA`)).toBe(true);
    expect(needsRehash('basura')).toBe(true);
  });

  it('respeta los parámetros acordados en el ADR', () => {
    expect(SCRYPT_PARAMS.N).toBe(2 ** 15);
    expect(SCRYPT_PARAMS.r).toBe(8);
    expect(SCRYPT_PARAMS.p).toBe(1);
  });

  it('genera contraseñas temporales sin caracteres ambiguos', () => {
    const password = generateTemporaryPassword();
    expect(password).toHaveLength(14);
    expect(password).toMatch(/^[a-zA-Z2-9]+$/);
    expect(password).not.toMatch(/[0O1lI]/);
    expect(generateTemporaryPassword()).not.toBe(password);
  });
});
