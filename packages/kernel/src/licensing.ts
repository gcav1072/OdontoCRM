import {
  LICENSE_AUDIENCE,
  LICENSE_ISSUER,
  licenseClaimsSchema,
  type LicenseClaims,
} from '@odontocrm/contracts';
import { SignJWT, jwtVerify } from 'jose';

import { ALGORITHM, type PrivateKey, type PublicKey } from './auth/keys.js';

/**
 * Firma y verificación de **licencias offline** ([ADR 0075](../../../docs/adr/0075-licenciamiento-offline-y-modo-consulta.md)).
 *
 * Es el mismo `jose` y la misma curva (EdDSA/Ed25519) con la que se firman los
 * JWT de sesión, pero con **otro par de claves**:
 *
 *   · la privada vive solo en la máquina del proveedor (fuera del repo) y
 *   · la pública viaja con la app (`assets/licencias/licencia-publica.pem`).
 *
 * El formato y las reglas están en `@odontocrm/contracts` (`licenseClaimsSchema`
 * y `resolveLicensing`); aquí solo está la criptografía. **No se usa `exp`**: la
 * firma sigue siendo válida aunque la licencia haya vencido, y así la app puede
 * distinguir «firma mala» de «licencia vencida» (el vencimiento es un claim
 * normal, `venceEn`).
 */

/**
 * Firma una licencia. Solo se usa en el CLI y el bot del proveedor y en las
 * pruebas; la app del consultorio nunca tiene la clave privada.
 */
export const signLicenseToken = async (
  claims: LicenseClaims,
  options: { privateKey: PrivateKey },
): Promise<string> =>
  new SignJWT({ ...claims })
    .setProtectedHeader({ alg: ALGORITHM, typ: 'JWT' })
    .setIssuer(LICENSE_ISSUER)
    .setAudience(LICENSE_AUDIENCE)
    .sign(options.privateKey);

/**
 * Verifica la firma, el emisor, la audiencia y la forma de los claims. Devuelve
 * `null` si el token no sirve, sin filtrar el motivo (el mensaje de la API lo
 * decide la capa de arriba). No mira `venceEn`: de eso decide `resolveLicensing`.
 */
export const verifyLicenseToken = async (
  token: string,
  publicKey: PublicKey,
): Promise<LicenseClaims | null> => {
  try {
    const { payload } = await jwtVerify(token, publicKey, {
      issuer: LICENSE_ISSUER,
      audience: LICENSE_AUDIENCE,
    });
    const parsed = licenseClaimsSchema.safeParse(payload);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
};
