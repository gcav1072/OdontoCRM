import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createDiskBlobStore } from './blob-store.js';
import { BLOB_MAGIC, decryptBlob, encryptBlob, looksEncrypted, parseEncryptionKey } from './crypto.js';

/**
 * Cifrado en reposo del almacén (mejora 4.B del plan post-Fase 11).
 *
 * Lo que hay que fijar, en orden de importancia para la clínica:
 *
 *  1. **lo que ya estaba en claro se sigue leyendo** — activar el cifrado no puede dejar el
 *     historial clínico ilegible el día del despliegue—;
 *  2. un archivo nuevo **no** se puede leer sin la clave (para eso está);
 *  3. si alguien toca un byte, la lectura **falla** en vez de devolver basura (GCM lo
 *     detecta, y esa es media razón para usar GCM);
 *  4. la huella (`sha256`) es la del contenido en claro y **no cambia** al cifrar.
 */

const CLAVE = Buffer.alloc(32, 7); // clave fija de la prueba: 32 bytes
const OTRA_CLAVE = Buffer.alloc(32, 9);

let raiz = '';

beforeEach(async () => {
  raiz = await mkdtemp(join(tmpdir(), 'odontocrm-alma-'));
});

afterEach(async () => {
  await rm(raiz, { recursive: true, force: true });
});

const contenido = Buffer.from('%PDF-1.7 radiografía de prueba con datos clínicos', 'utf8');

describe('el almacén cifrado', () => {
  it('cifra lo que escribe y lo devuelve idéntico al leerlo', async () => {
    const store = createDiskBlobStore({ rootDir: raiz, encryptionKey: CLAVE });
    const guardado = await store.save({ key: 'clinical/paciente/estudio.pdf', data: contenido });

    // En disco NO está el contenido…
    const enDisco = await readFile(store.absolutePath(guardado.path));
    expect(enDisco.subarray(0, BLOB_MAGIC.length).equals(BLOB_MAGIC)).toBe(true);
    expect(enDisco.includes(contenido)).toBe(false);

    // …y por la interfaz sale tal cual.
    await expect(store.read(guardado.path)).resolves.toEqual(contenido);
    expect(store.encrypted()).toBe(true);
  });

  it('la huella es la del contenido en claro (cifrar no cambia el sha256)', async () => {
    const claro = createDiskBlobStore({ rootDir: join(raiz, 'claro') });
    const cifrado = createDiskBlobStore({ rootDir: join(raiz, 'cifrado'), encryptionKey: CLAVE });

    const a = await claro.save({ key: 'patients/p/x.png', data: contenido });
    const b = await cifrado.save({ key: 'patients/p/x.png', data: contenido });

    expect(b.sha256).toBe(a.sha256);
    expect(b.size).toBe(contenido.byteLength);
  });

  it('lee sin problema un archivo que estaba en claro antes de activar el cifrado', async () => {
    // Como si la clínica llevara meses guardando radiografías y hoy activara el cifrado.
    const sinCifrar = createDiskBlobStore({ rootDir: raiz });
    const guardado = await sinCifrar.save({ key: 'patients/p/viejo.png', data: contenido });

    const yaCifrado = createDiskBlobStore({ rootDir: raiz, encryptionKey: CLAVE });
    await expect(yaCifrado.read(guardado.path)).resolves.toEqual(contenido);
  });

  it('sin la clave, un archivo cifrado no se puede leer y lo dice claro', async () => {
    const conClave = createDiskBlobStore({ rootDir: raiz, encryptionKey: CLAVE });
    const guardado = await conClave.save({ key: 'patients/p/secreto.png', data: contenido });

    const sinClave = createDiskBlobStore({ rootDir: raiz });
    await expect(sinClave.read(guardado.path)).rejects.toThrow(/STORAGE_ENCRYPTION_KEY/);
  });

  it('con OTRA clave no se lee (y no devuelve basura)', async () => {
    const conClave = createDiskBlobStore({ rootDir: raiz, encryptionKey: CLAVE });
    const guardado = await conClave.save({ key: 'patients/p/x.png', data: contenido });

    const conOtra = createDiskBlobStore({ rootDir: raiz, encryptionKey: OTRA_CLAVE });
    await expect(conOtra.read(guardado.path)).rejects.toThrow();
  });

  it('si alguien toca un byte del archivo, la lectura falla', async () => {
    const store = createDiskBlobStore({ rootDir: raiz, encryptionKey: CLAVE });
    const guardado = await store.save({ key: 'clinical/p/x.pdf', data: contenido });

    const ruta = store.absolutePath(guardado.path);
    const enDisco = await readFile(ruta);
    // Un solo bit cambiado en el contenido cifrado: GCM lo detecta.
    enDisco[enDisco.byteLength - 1] = (enDisco[enDisco.byteLength - 1] ?? 0) ^ 0x01;
    await writeFile(ruta, enDisco);

    await expect(store.read(guardado.path)).rejects.toThrow();
  });

  it('un archivo corto (más pequeño que la cabecera) se lee como claro, sin confundirse', async () => {
    const store = createDiskBlobStore({ rootDir: raiz, encryptionKey: CLAVE });
    // Un archivo de verdad no cifrado y muy pequeño: no puede tener la cabecera.
    const guardado = await store.save({ key: 'patients/p/corto.txt', data: Buffer.from('hola') });
    await expect(store.read(guardado.path)).resolves.toEqual(Buffer.from('hola'));
  });

  it('cada escritura usa un IV distinto (el mismo contenido no da el mismo archivo)', async () => {
    const store = createDiskBlobStore({ rootDir: raiz, encryptionKey: CLAVE });
    const a = await store.save({ key: 'a/1.png', data: contenido });
    const b = await store.save({ key: 'b/1.png', data: contenido });

    const enDiscoA = await readFile(store.absolutePath(a.path));
    const enDiscoB = await readFile(store.absolutePath(b.path));
    expect(enDiscoA.equals(enDiscoB)).toBe(false);
    expect(a.sha256).toBe(b.sha256);
  });
});

describe('la cabecera del formato', () => {
  it('se reconoce a sí misma', () => {
    expect(looksEncrypted(encryptBlob(contenido, CLAVE))).toBe(true);
  });

  it('no confunde un PNG, un JPEG, un PDF ni un SVG', () => {
    const cabeceras = [
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), // PNG
      Buffer.from([0xff, 0xd8, 0xff, 0xe0]), // JPEG
      Buffer.from('%PDF-1.7'), // PDF
      Buffer.from('<svg xmlns='), // SVG
    ];
    for (const cabecera of cabeceras) {
      const archivo = Buffer.concat([cabecera, Buffer.alloc(64, 1)]);
      expect(looksEncrypted(archivo)).toBe(false);
    }
  });

  it('una versión desconocida avisa de que hay que actualizar', () => {
    const cifrado = encryptBlob(contenido, CLAVE);
    cifrado[BLOB_MAGIC.length] = 99; // versión inventada
    expect(() => decryptBlob(cifrado, CLAVE)).toThrow(/Versión de cifrado desconocida/);
  });

  it('detecta el archivo truncado en vez de reventar por dentro', () => {
    expect(() => decryptBlob(Buffer.from('ODBLOB\x01'), CLAVE)).toThrow(/truncado/);
  });
});

describe('la clave de cifrado del entorno', () => {
  it('acepta base64url y base64, con o sin relleno', () => {
    const clave = Buffer.alloc(32, 3);
    expect(parseEncryptionKey(clave.toString('base64url'))).toEqual(clave);
    expect(parseEncryptionKey(clave.toString('base64'))).toEqual(clave);
    expect(parseEncryptionKey(`${clave.toString('base64')}==`)).toEqual(clave);
  });

  it('sin valor es «esta instalación no cifra», no un error', () => {
    expect(parseEncryptionKey(undefined)).toBeUndefined();
    expect(parseEncryptionKey('')).toBeUndefined();
    expect(parseEncryptionKey('   ')).toBeUndefined();
  });

  it('rechaza una clave del tamaño equivocado', () => {
    expect(() => parseEncryptionKey(Buffer.alloc(16, 1).toString('base64url'))).toThrow(/32 bytes/);
  });

  it('rechaza una clave con caracteres cambiados (decodificaría a menos bytes)', () => {
    const buena = Buffer.alloc(32, 5).toString('base64url');
    const rota = `${buena.slice(0, -1)}!`;
    expect(() => parseEncryptionKey(rota)).toThrow();
  });
});
