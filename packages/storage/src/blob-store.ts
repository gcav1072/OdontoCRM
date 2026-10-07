import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';

import { decryptBlob, encryptBlob, looksEncrypted, sha256OfPlain } from './crypto.js';

/**
 * Almacén de binarios **compartido por los servicios** (adjuntos del paciente,
 * radiografías de la sesión y el PDF del récipe). Hoy escribe en disco; la interfaz
 * está pensada para que mañana se cambie por S3/MinIO sin tocar a quien la usa.
 *
 * Las rutas son **relativas al almacén** y las construye el propio almacén a partir de
 * identificadores validados: nunca se acepta una ruta del cliente.
 *
 * **Cifrado en reposo** (mejora 4.B del plan post-Fase 11): si se le pasa `encryptionKey`,
 * lo que escribe va cifrado con AES-256-GCM y lo que ya estaba en claro se sigue leyendo.
 * La clave es una decisión de la instalación (la genera el aprovisionador): sin ella el
 * almacén funciona como siempre, que es lo que hace el desarrollo.
 *
 * Vivía dentro del servicio de pacientes; se movió aquí cuando la historia clínica
 * necesitó el mismo almacén para los adjuntos de la sesión (una copia por servicio
 * habría sido dos maneras de escribir lo mismo).
 */
export interface BlobStore {
  /** Guarda el contenido y devuelve la ruta relativa, su huella y su tamaño. */
  save: (input: {
    key: string;
    data: Buffer;
  }) => Promise<{ path: string; sha256: string; size: number }>;
  /** Devuelve el contenido **en claro**, venga cifrado o no. */
  read: (path: string) => Promise<Buffer>;
  exists: (path: string) => Promise<boolean>;
  remove: (path: string) => Promise<void>;
  /**
   * Ruta absoluta en disco.
   *
   * ⚠️ Con el almacén **cifrado** el archivo en disco no es el contenido: quien necesite el
   * binario tiene que usar `read`. Se mantiene —y no se retira— porque hay cosas que sí
   * quieren la ruta: el re-cifrado (`tools/recifrar-almacen.mjs`) y el respaldo del
   * directorio entero.
   */
  absolutePath: (path: string) => string;
  /** `true` si esta instancia cifra lo que escribe. */
  encrypted: () => boolean;
}

const EXTENSION_BY_MIME: Readonly<Record<string, string>> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'application/pdf': 'pdf',
};

/** Extensión segura para la clave: solo letras y números, máximo 5 caracteres. */
export const safeExtension = (originalName: string, mime: string): string => {
  const fromName = /\.(?<extension>[A-Za-z0-9]{1,5})$/.exec(originalName)?.groups?.['extension'];
  const candidate = (fromName ?? EXTENSION_BY_MIME[mime] ?? 'bin').toLowerCase();
  return /^[a-z0-9]{1,5}$/.test(candidate) ? candidate : 'bin';
};

/**
 * Clave de almacenamiento: `<prefijo>/<dueño>/<archivo>.<ext>`.
 *
 * El prefijo separa los mundos dentro del mismo almacén (`patients` para la ficha
 * del paciente, `clinical` para las sesiones y los récipes) y el dueño es el
 * paciente o la sesión a la que pertenece el binario.
 */
export const buildStorageKey = (
  prefix: string,
  ownerId: string,
  fileId: string,
  extension: string,
): string => [prefix, ownerId, `${fileId}.${extension}`].join('/');

export interface DiskBlobStoreOptions {
  rootDir: string;
  /**
   * Clave de 32 bytes para cifrar lo que se escriba (`parseEncryptionKey`). Sin ella el
   * almacén escribe en claro, como siempre: es lo que hace el desarrollo.
   */
  encryptionKey?: Buffer | undefined;
}

export const createDiskBlobStore = (options: DiskBlobStoreOptions): BlobStore => {
  const root = resolve(options.rootDir);
  const key = options.encryptionKey;

  const absolutePath = (path: string): string => {
    const absolute = resolve(join(root, path));
    // Defensa en profundidad: nada puede salirse de la carpeta del almacén.
    if (absolute !== root && !absolute.startsWith(`${root}${sep}`)) {
      throw new Error('Ruta de almacenamiento fuera de la carpeta permitida');
    }
    return absolute;
  };

  return {
    absolutePath,

    encrypted: () => key !== undefined,

    save: async ({ key: path, data }) => {
      const absolute = absolutePath(path);
      await mkdir(dirname(absolute), { recursive: true });
      // Lo que se guarda en disco puede ir cifrado; lo que se **devuelve** (la huella) es
      // siempre del contenido en claro: si el sha256 cambiara al activar el cifrado, las
      // huellas guardadas en la base dejarían de cuadrar y las comprobaciones de integridad
      // darían falsos positivos.
      await writeFile(absolute, key === undefined ? data : encryptBlob(data, key));
      return {
        path,
        sha256: sha256OfPlain(data),
        size: data.byteLength,
      };
    },

    /**
     * Devuelve el contenido **en claro**, venga cifrado o no.
     *
     * Es lo que hace que activar el cifrado no rompa nada: los archivos que ya estaban se
     * leen tal cual (no llevan cabecera) y los nuevos se descifran. El día que se quiera
     * dejar de aceptar claro, `tools/recifrar-almacen.mjs` los pasa todos.
     */
    read: async (path) => {
      const data = await readFile(absolutePath(path));
      if (!looksEncrypted(data)) return data;

      if (key === undefined) {
        throw new Error(
          'El archivo está cifrado y esta instancia no tiene STORAGE_ENCRYPTION_KEY: ' +
            'pon la clave (la misma de cuando se escribió) y vuelve a intentarlo',
        );
      }
      return decryptBlob(data, key);
    },

    exists: async (path) => {
      try {
        const info = await stat(absolutePath(path));
        return info.isFile();
      } catch {
        return false;
      }
    },

    remove: async (path) => {
      await rm(absolutePath(path), { force: true });
    },
  };
};
