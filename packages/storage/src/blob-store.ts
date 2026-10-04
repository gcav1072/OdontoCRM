import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';

/**
 * Almacén de binarios **compartido por los servicios** (adjuntos del paciente,
 * radiografías de la sesión y el PDF del récipe). Hoy escribe en disco; la interfaz
 * está pensada para que mañana se cambie por S3/MinIO sin tocar a quien la usa.
 *
 * Las rutas son **relativas al almacén** y las construye el propio almacén a partir
 * de identificadores validados: nunca se acepta una ruta del cliente.
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
  read: (path: string) => Promise<Buffer>;
  exists: (path: string) => Promise<boolean>;
  remove: (path: string) => Promise<void>;
  /** Ruta absoluta en disco (solo la usa el almacén de disco, p. ej. para enviar el archivo). */
  absolutePath: (path: string) => string;
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
}

export const createDiskBlobStore = (options: DiskBlobStoreOptions): BlobStore => {
  const root = resolve(options.rootDir);

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

    save: async ({ key, data }) => {
      const absolute = absolutePath(key);
      await mkdir(dirname(absolute), { recursive: true });
      await writeFile(absolute, data);
      return {
        path: key,
        sha256: createHash('sha256').update(data).digest('hex'),
        size: data.byteLength,
      };
    },

    read: async (path) => readFile(absolutePath(path)),

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
