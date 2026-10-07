import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

/**
 * **Cifrado en reposo** de los binarios del consultorio.
 *
 * Los archivos del almacén son radiografías, fotos clínicas, PDF de récipes y de facturas:
 * datos de salud y documentos fiscales que se quedan en el disco de una máquina que puede
 * ser robada, o cuyo disco puede acabar en manos de otro. El cifrado no protege de un
 * administrador con la clave, pero sí de lo que de verdad pasa: el equipo se pierde, el
 * disco se cambia, el respaldo se copia a un sitio que no toca.
 *
 * **Formato versionado y retrocompatible.** Cada archivo cifrado empieza por una cabecera
 * que dice que lo está:
 *
 * ```
 * ODBLOB  1  A  <iv 12 B> <authTag 16 B> <cifrado…>
 * └magic┘ │  └algoritmo
 *         └versión
 * ```
 *
 * Al leer, el almacén mira esos bytes: si están, descifra; si no, devuelve el contenido tal
 * cual. Así una instalación que enciende el cifrado **sigue sirviendo las radiografías que
 * ya tenía** (y el operador las migra cuando quiera con `npm run recifrar:almacen`), en vez
 * de dejar el historial clínico ilegible el día del despliegue.
 *
 * Los primeros bytes de un archivo **no** cifrado no pueden coincidir en la práctica: un
 * PNG empieza por `\x89PNG`, un JPEG por `\xFF\xD8\xFF`, un PDF por `%PDF`, un SVG por `<`…
 * y además la cabecera ocupa 36 bytes, así que un archivo más corto tampoco se confunde.
 * Aun así, `looksEncrypted` exige el magic **completo** y `read` falla con un mensaje claro
 * en vez de devolver basura.
 */

/** Marca que abre todo archivo cifrado (`OD` de OdontoCRM + `BLOB`). */
export const BLOB_MAGIC = Buffer.from('ODBLOB', 'ascii');

/** Versión del formato. Si mañana cambia la cabecera, esta es la que la distingue. */
export const BLOB_VERSION = 1;

/** Identificador del algoritmo. Hoy solo hay uno, pero cabe un segundo sin romper nada. */
export const BLOB_ALGORITHM = 1;

/** `aes-256-gcm` exige la clave y el nonce de estos tamaños. */
export const BLOB_KEY_BYTES = 32;
export const BLOB_IV_BYTES = 12;
export const BLOB_TAG_BYTES = 16;

/** Lo que ocupa la cabecera antes del contenido cifrado. */
export const BLOB_HEADER_BYTES = BLOB_MAGIC.length + 1 + 1 + BLOB_IV_BYTES + BLOB_TAG_BYTES;

/** Cifra un binario con AES-256-GCM y le pone delante la cabecera. */
export const encryptBlob = (data: Buffer, key: Buffer): Buffer => {
  const iv = randomBytes(BLOB_IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(data), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return Buffer.concat([
    BLOB_MAGIC,
    Buffer.from([BLOB_VERSION, BLOB_ALGORITHM]),
    iv,
    authTag,
    ciphertext,
  ]);
};

/**
 * Descifra un binario. Lanza si la cabecera no está, si la versión es desconocida o si la
 * autenticación falla (**el archivo se tocó**: GCM lo detecta, y eso es media razón para
 * usarlo).
 */
export const decryptBlob = (data: Buffer, key: Buffer): Buffer => {
  if (data.byteLength < BLOB_HEADER_BYTES) {
    throw new Error('El archivo cifrado está truncado: no cabe ni su cabecera');
  }
  if (!data.subarray(0, BLOB_MAGIC.length).equals(BLOB_MAGIC)) {
    throw new Error('El archivo no tiene la cabecera del almacén cifrado');
  }

  const version = data[BLOB_MAGIC.length];
  const algorithm = data[BLOB_MAGIC.length + 1];
  if (version !== BLOB_VERSION) {
    throw new Error(`Versión de cifrado desconocida (${String(version)}): actualiza OdontoCRM`);
  }
  if (algorithm !== BLOB_ALGORITHM) {
    throw new Error(`Algoritmo de cifrado desconocido (${String(algorithm)})`);
  }

  let corte = BLOB_MAGIC.length + 2;
  const iv = data.subarray(corte, corte + BLOB_IV_BYTES);
  corte += BLOB_IV_BYTES;
  const authTag = data.subarray(corte, corte + BLOB_TAG_BYTES);
  corte += BLOB_TAG_BYTES;

  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(data.subarray(corte)), decipher.final()]);
};

/** `true` si el archivo empieza por la cabecera del almacén cifrado. */
export const looksEncrypted = (data: Buffer): boolean =>
  data.byteLength >= BLOB_HEADER_BYTES &&
  data.subarray(0, BLOB_MAGIC.length).equals(BLOB_MAGIC);

/**
 * Lee la clave de cifrado del entorno: base64url (lo que genera el aprovisionador) o base64
 * normal, con o sin relleno. `undefined` es «esta instalación no cifra» (desarrollo, o una
 * clínica que todavía no lo activó), y eso **no** es un error.
 *
 * Un valor que no decodifique a 32 bytes **sí** lo es: seguir adelante con una clave mal
 * puesta escribiría archivos ilegibles.
 */
export const parseEncryptionKey = (value: string | undefined): Buffer | undefined => {
  if (value === undefined || value.trim() === '') return undefined;

  const limpio = value.trim();
  const key = Buffer.from(limpio, 'base64url');
  // `Buffer.from(..., 'base64url')` ignora lo que no reconoce, así que se comprueba que la
  // vuelta sea estable: una clave con un carácter cambiado decodificaría a menos bytes y
  // «funcionaría» hasta que hubiera que descifrar.
  const normalizada = key.toString('base64url').replace(/=+$/, '');
  if (key.byteLength !== BLOB_KEY_BYTES || normalizada !== limpio.replace(/=+$/, '')) {
    throw new Error(
      `STORAGE_ENCRYPTION_KEY no es una clave de ${String(BLOB_KEY_BYTES)} bytes en base64url ` +
        '(la genera el aprovisionador). Un valor mal puesto dejaría el almacén ilegible.',
    );
  }
  return key;
};

/** Huella del contenido en claro: es la que se guarda en la base y no cambia al cifrar. */
export const sha256OfPlain = (data: Buffer): string =>
  createHash('sha256').update(data).digest('hex');
