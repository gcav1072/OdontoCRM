import { LICENSE_AUDIENCE, LICENSE_ISSUER, type LicenseClaims } from '@odontocrm/contracts';
import { SignJWT } from 'jose';
import { describe, expect, it } from 'vitest';

import { generateKeyPairPem, importPrivateKeyPem, importPublicKeyPem } from './auth/keys.js';
import { signLicenseToken, verifyLicenseToken } from './licensing.js';

const claims = (): LicenseClaims => ({
  v: 1,
  lic: 'LIC-2026-0001',
  tipo: 'anual',
  instalacion: '6f6f2f7e-3a3a-4c4c-9b9b-1234567890ab',
  cliente: { nombre: 'Consultorio Sonrisa', rif: 'J-12345678-9' },
  emitidaEn: '2026-11-01T12:00:00.000Z',
  venceEn: '2027-11-01T12:00:00.000Z',
  modulos: ['*'],
});

const par = async () => {
  const { privatePem, publicPem } = await generateKeyPairPem();
  return {
    privateKey: await importPrivateKeyPem(privatePem),
    publicKey: await importPublicKeyPem(publicPem),
  };
};

describe('licencia firmada (EdDSA)', () => {
  it('una licencia firmada por el proveedor se verifica con su clave pública', async () => {
    const { privateKey, publicKey } = await par();
    const token = await signLicenseToken(claims(), { privateKey });

    expect(await verifyLicenseToken(token, publicKey)).toEqual(claims());
  });

  it('no se puede alterar el contenido sin romper la firma', async () => {
    const { privateKey, publicKey } = await par();
    const token = await signLicenseToken(claims(), { privateKey });
    const [cabecera, cuerpo, firma] = token.split('.');
    const alterado = JSON.parse(Buffer.from(cuerpo ?? '', 'base64url').toString('utf8')) as Record<
      string,
      unknown
    >;
    alterado['venceEn'] = '2099-01-01T00:00:00.000Z';
    const nuevoCuerpo = Buffer.from(JSON.stringify(alterado)).toString('base64url');

    expect(await verifyLicenseToken(`${cabecera}.${nuevoCuerpo}.${firma}`, publicKey)).toBeNull();
  });

  it('rechaza una licencia firmada con otra clave', async () => {
    const proveedor = await par();
    const otro = await par();
    const token = await signLicenseToken(claims(), { privateKey: otro.privateKey });

    expect(await verifyLicenseToken(token, proveedor.publicKey)).toBeNull();
  });

  it('rechaza un token con emisor o audiencia ajenos (p. ej. un token de sesión)', async () => {
    const { privateKey, publicKey } = await par();
    const ajeno = await new SignJWT({ ...claims() })
      .setProtectedHeader({ alg: 'EdDSA', typ: 'JWT' })
      .setIssuer('otro-sistema')
      .setAudience('otra-audiencia')
      .sign(privateKey);

    expect(await verifyLicenseToken(ajeno, publicKey)).toBeNull();
    expect(await verifyLicenseToken('no-es-un-token', publicKey)).toBeNull();
  });

  it('una licencia vencida sigue verificando: el vencimiento lo decide resolveLicensing', async () => {
    const { privateKey, publicKey } = await par();
    const vencida: LicenseClaims = { ...claims(), venceEn: '2020-01-01T00:00:00.000Z' };
    const token = await signLicenseToken(vencida, { privateKey });

    expect(await verifyLicenseToken(token, publicKey)).toEqual(vencida);
    expect(LICENSE_ISSUER).toBe('odontocrm-licencias');
    expect(LICENSE_AUDIENCE).toBe('odontocrm-instalacion');
  });
});
