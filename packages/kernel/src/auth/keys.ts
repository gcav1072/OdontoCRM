import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { exportPKCS8, exportSPKI, generateKeyPair, importPKCS8, importSPKI } from 'jose';

/**
 * Tipos de clave derivados de las propias funciones de `jose` (v6 ya no exporta
 * `KeyLike`): así no dependemos de un nombre que cambia entre versiones.
 */
export type PrivateKey = Awaited<ReturnType<typeof importPKCS8>>;
export type PublicKey = Awaited<ReturnType<typeof importSPKI>>;

/**
 * Par de claves EdDSA (Ed25519) para firmar los JWT de acceso. La privada vive
 * fuera del repositorio (`services/identity/.keys/`, ignorado por Git) y en
 * producción en `/etc/odontocrm/keys/` con permisos 0600.
 */
export const ALGORITHM = 'EdDSA';

export interface KeyPairPem {
  privatePem: string;
  publicPem: string;
}

/** Genera un par nuevo (usado por `npm run keys:generate`). */
export const generateKeyPairPem = async (): Promise<KeyPairPem> => {
  const { privateKey, publicKey } = await generateKeyPair(ALGORITHM, {
    crv: 'Ed25519',
    extractable: true,
  });

  return {
    privatePem: await exportPKCS8(privateKey),
    publicPem: await exportSPKI(publicKey),
  };
};

/** Importa una clave desde su PEM (lo usan las pruebas y los servicios). */
export const importPrivateKeyPem = async (pem: string): Promise<PrivateKey> =>
  importPKCS8(pem, ALGORITHM);

export const importPublicKeyPem = async (pem: string): Promise<PublicKey> =>
  importSPKI(pem, ALGORITHM);

export const loadPrivateKey = async (path: string): Promise<PrivateKey> =>
  importPrivateKeyPem(readFileSync(path, 'utf8'));

export const loadPublicKey = async (path: string): Promise<PublicKey> =>
  importPublicKeyPem(readFileSync(path, 'utf8'));

/**
 * Token opaco de alta entropía (refresco, dispositivo kiosko, código de
 * vinculación). Solo se guarda su hash: si alguien lee la base, no puede usarlo.
 */
export const generateOpaqueToken = (bytes = 32): string => randomBytes(bytes).toString('base64url');

export const hashOpaqueToken = (token: string): string =>
  createHash('sha256').update(token).digest('hex');
