import { createBrandLookup, createLetterheadLookup } from '@odontocrm/kernel';
import { createDiskBlobStore, type BlobStore } from '@odontocrm/storage';
import { eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { loadClinicalConfig } from './config.js';
import { createClinicalDatabase } from './db/client.js';
import { clinicalSessions, medicalRecords, prescriptions } from './db/schema.js';
import type { PdfRenderer } from './prescriptions/pdf-renderer.js';
import { createClinicalServer } from './server.js';

/**
 * Las **rutas internas de récipes** (Fase D): el servicio de notificaciones pide por
 * aquí los metadatos y el PDF para mandarlos por WhatsApp o Telegram, sin pasar por
 * el gateway.
 *
 * Lo que se comprueba es lo que protege al paciente y al documento:
 *  1. sin `x-internal-token` (o con uno equivocado) no hay respuesta: 403;
 *  2. los metadatos dicen de quién es, qué número lleva y cómo se llama el archivo,
 *     también para un borrador (donde todavía no hay número ni PDF);
 *  3. solo se comparte lo **emitido**: el borrador y el récipe anulado responden 409
 *     —el anulado conserva su PDF archivado y sin la comprobación se enviaría—;
 *  4. lo que no existe responde 404.
 *
 * **Es hermética**: paciente, historia, sesiones y récipes sintéticos propios, y un
 * almacén temporal; al terminar se borra todo lo suyo.
 */
const clinicalUrl = process.env['TEST_CLINICAL_DATABASE_URL'];
const ready = clinicalUrl !== undefined;
const describeWithDatabase = ready ? describe : describe.skip;

const MARKER = `pruebas-internas-clinica-${String(Date.now()).slice(-7)}`;
/** Secreto del servidor de pruebas: la cabecera tiene que coincidir con este. */
const INTERNAL = 'secreto-interno-de-prueba-1234';
const PDF_EMITIDO = Buffer.from('%PDF-1.4 recipe archivado de prueba');
const PDF_ANULADO = Buffer.from('%PDF-1.4 recipe anulado de prueba');

const codigoAleatorio = (): string =>
  globalThis.crypto.randomUUID().replace(/-/g, '').slice(0, 10).toUpperCase();

describeWithDatabase('rutas internas de récipes', () => {
  let handle: Awaited<ReturnType<typeof createClinicalDatabase>>;
  let app: FastifyInstance;
  let blobStore: BlobStore;
  let storageDir = '';

  const patientId = globalThis.crypto.randomUUID();
  const fechaEmision = new Date('2026-03-10T14:30:00.000Z');

  let idEmitida = '';
  let idBorrador = '';
  let idAnulada = '';
  let numeroEmitida = 0;
  let numeroAnulada = 0;

  /** El siguiente número del récipe: la secuencia es la única que no repite. */
  const siguienteNumero = async (): Promise<number> => {
    const resultado = await handle.db.execute(
      sql`select nextval('prescription_number_seq') as numero`,
    );
    const fila = (resultado.rows[0] ?? {}) as { numero?: string | number };
    const numero = Number(fila.numero);
    if (!Number.isSafeInteger(numero) || numero <= 0) {
      throw new Error('la secuencia del número de récipe no devolvió un número');
    }
    return numero;
  };

  /** Petición a una ruta interna con el token bueno. */
  const interna = (url: string) =>
    app.inject({ method: 'GET', url, headers: { 'x-internal-token': INTERNAL } });

  beforeAll(async () => {
    if (!ready) throw new Error('falta TEST_CLINICAL_DATABASE_URL');

    const config = loadClinicalConfig({
      DATABASE_URL: clinicalUrl,
      LOG_LEVEL: 'silent',
      INTERNAL_SERVICE_SECRET: INTERNAL,
    });
    handle = createClinicalDatabase(config);

    storageDir = await mkdtemp(join(tmpdir(), 'odontocrm-internas-clinica-'));
    blobStore = createDiskBlobStore({ rootDir: storageDir });
    // Las rutas de estas pruebas no componen documentos: basta un doble.
    const pdfRenderer: PdfRenderer = {
      render: () => Promise.resolve(Buffer.from('%PDF-1.4')),
      close: () => Promise.resolve(),
      isRunning: () => false,
    };

    app = await createClinicalServer({
      config,
      database: handle,
      patientLookup: () => Promise.resolve(null),
      odontogramLookup: () => Promise.resolve({ dentition: null, findings: {}, prostheses: [] }),
      letterheadLookup: createLetterheadLookup(config),
      brandLookup: createBrandLookup(config),
      blobStore,
      pdfRenderer,
    });
    await app.ready();

    // Historia y dos sesiones: el borrador va en una sesión sin récipes emitidos.
    const [historia] = await handle.db
      .insert(medicalRecords)
      .values({ patientId })
      .returning({ id: medicalRecords.id });
    const recordId = historia?.id ?? '';

    const [sesionEmitidos] = await handle.db
      .insert(clinicalSessions)
      .values({ recordId, patientId, sessionNumber: 1, content: {} })
      .returning({ id: clinicalSessions.id });
    const [sesionBorrador] = await handle.db
      .insert(clinicalSessions)
      .values({ recordId, patientId, sessionNumber: 2, content: {} })
      .returning({ id: clinicalSessions.id });
    const sessionEmitidos = sesionEmitidos?.id ?? '';
    const sessionBorrador = sesionBorrador?.id ?? '';

    // 1. El récipe emitido: número, código, PDF archivado y fecha de emisión.
    const archivoEmitido = await blobStore.save({
      key: `clinical/pruebas/${patientId}/rx-emitida.pdf`,
      data: PDF_EMITIDO,
    });
    numeroEmitida = await siguienteNumero();
    const [emitida] = await handle.db
      .insert(prescriptions)
      .values({
        prescriptionNumber: numeroEmitida,
        sessionId: sessionEmitidos,
        patientId,
        status: 'emitida',
        patientSnapshot: { fullName: 'María Pérez Gómez' },
        issuedAt: fechaEmision,
        issuedByUsername: MARKER,
        verifyCode: codigoAleatorio(),
        pdfPath: archivoEmitido.path,
        pdfSha256: archivoEmitido.sha256,
        generatedAt: fechaEmision,
      })
      .returning({ id: prescriptions.id });
    idEmitida = emitida?.id ?? '';

    // 2. Un borrador: sin número, sin PDF y sin fecha de emisión.
    const [borrador] = await handle.db
      .insert(prescriptions)
      .values({
        sessionId: sessionBorrador,
        patientId,
        status: 'borrador',
        createdByUsername: MARKER,
      })
      .returning({ id: prescriptions.id });
    idBorrador = borrador?.id ?? '';

    // 3. Un récipe anulado: conserva su número y su PDF archivado (es lo que tiene que
    //    negarse a compartir la ruta interna).
    const archivoAnulado = await blobStore.save({
      key: `clinical/pruebas/${patientId}/rx-anulada.pdf`,
      data: PDF_ANULADO,
    });
    numeroAnulada = await siguienteNumero();
    const [anulada] = await handle.db
      .insert(prescriptions)
      .values({
        prescriptionNumber: numeroAnulada,
        sessionId: sessionEmitidos,
        patientId,
        status: 'anulada',
        patientSnapshot: { fullName: 'María Pérez Gómez' },
        issuedAt: fechaEmision,
        issuedByUsername: MARKER,
        verifyCode: codigoAleatorio(),
        pdfPath: archivoAnulado.path,
        pdfSha256: archivoAnulado.sha256,
        generatedAt: fechaEmision,
        annulledAt: new Date(),
        annulledByUsername: MARKER,
        annulReason: 'El paciente ya estaba medicado',
      })
      .returning({ id: prescriptions.id });
    idAnulada = anulada?.id ?? '';
  });

  afterAll(async () => {
    if (!ready) return;
    await handle.db.delete(prescriptions).where(eq(prescriptions.patientId, patientId));
    await handle.db.execute(sql`delete from clinical_sessions where patient_id = ${patientId}`);
    await handle.db.execute(sql`delete from medical_records where patient_id = ${patientId}`);
    await app.close();
    await handle.close();
    await rm(storageDir, { recursive: true, force: true });
  });

  it('sin el token compartido, las rutas internas no responden (403)', async () => {
    for (const ruta of ['meta', 'pdf']) {
      const url = `/internal/v1/clinical/prescriptions/${idEmitida}/${ruta}`;

      const sinToken = await app.inject({ method: 'GET', url });
      expect(sinToken.statusCode).toBe(403);

      const tokenAjeno = await app.inject({
        method: 'GET',
        url,
        headers: { 'x-internal-token': 'secreto-equivocado-1234567890' },
      });
      expect(tokenAjeno.statusCode).toBe(403);
    }
  });

  it('los metadatos de un récipe emitido traen número, archivo y fecha', async () => {
    expect(idEmitida).not.toBe('');
    const respuesta = await interna(`/internal/v1/clinical/prescriptions/${idEmitida}/meta`);

    expect(respuesta.statusCode).toBe(200);
    expect(respuesta.json()).toEqual({
      id: idEmitida,
      patientId,
      status: 'emitida',
      number: `RX-${String(numeroEmitida).padStart(6, '0')}`,
      filename: `RX-${String(numeroEmitida).padStart(6, '0')}.pdf`,
      issuedAt: fechaEmision.toISOString(),
    });
  });

  it('el borrador informa su estado sin número (y tampoco inventa archivo)', async () => {
    const respuesta = await interna(`/internal/v1/clinical/prescriptions/${idBorrador}/meta`);

    expect(respuesta.statusCode).toBe(200);
    expect(respuesta.json()).toEqual({
      id: idBorrador,
      patientId,
      status: 'borrador',
      number: null,
      // El mismo nombre que devolvería la descarga: no hay otro.
      filename: 'RX-000000.pdf',
      issuedAt: null,
    });

    const anulada = await interna(`/internal/v1/clinical/prescriptions/${idAnulada}/meta`);
    expect(anulada.statusCode).toBe(200);
    expect(anulada.json()).toMatchObject({
      id: idAnulada,
      status: 'anulada',
      number: `RX-${String(numeroAnulada).padStart(6, '0')}`,
    });
  });

  it('el PDF de un récipe emitido sale como adjunto, byte a byte', async () => {
    const respuesta = await interna(`/internal/v1/clinical/prescriptions/${idEmitida}/pdf`);

    expect(respuesta.statusCode).toBe(200);
    expect(String(respuesta.headers['content-type'])).toContain('application/pdf');
    expect(respuesta.headers['content-disposition']).toBe(
      `attachment; filename="RX-${String(numeroEmitida).padStart(6, '0')}.pdf"`,
    );
    // Lo archivado es lo que se manda: no se recompone el documento.
    expect(respuesta.rawPayload.equals(PDF_EMITIDO)).toBe(true);
  });

  it('un borrador o un récipe anulado no se comparten (409)', async () => {
    const borrador = await interna(`/internal/v1/clinical/prescriptions/${idBorrador}/pdf`);
    expect(borrador.statusCode).toBe(409);
    expect(borrador.json()).toMatchObject({ status: 409, prescriptionStatus: 'borrador' });

    // El anulado SÍ tiene PDF archivado; sin la comprobación de estado saldría igual.
    const anulada = await interna(`/internal/v1/clinical/prescriptions/${idAnulada}/pdf`);
    expect(anulada.statusCode).toBe(409);
    expect(anulada.json()).toMatchObject({ status: 409, prescriptionStatus: 'anulada' });
  });

  it('un récipe que no existe responde 404', async () => {
    const fantasma = globalThis.crypto.randomUUID();
    for (const ruta of ['meta', 'pdf']) {
      const respuesta = await interna(`/internal/v1/clinical/prescriptions/${fantasma}/${ruta}`);
      expect(respuesta.statusCode).toBe(404);
    }

    const idInvalido = await interna('/internal/v1/clinical/prescriptions/no-es-uuid/meta');
    expect(idInvalido.statusCode).toBe(400);
  });
});
