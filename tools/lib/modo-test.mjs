#!/usr/bin/env node
/**
 * Piezas compartidas por `seed:test`, `seed:reset` y `seed:verify`.
 *
 * El modo test (ADR 0020) tiene tres comandos que miran **el mismo mundo**: uno lo
 * escribe, otro lo borra y otro comprueba que lo escrito es lo que el mundo dice.
 * Todo lo que comparten —leer los `.env`, conectarse a las bases, escribir los
 * eventos en el outbox, calcular huellas— vive aquí para que los tres no puedan
 * discrepar.
 */
import { isAbsolute, resolve } from 'node:path';

import { resolveTestMode } from '@odontocrm/contracts';
import { toOutboxInsert } from '@odontocrm/db';
import { createDiskBlobStore } from '@odontocrm/storage';
import { fingerprint } from '@odontocrm/testing';

import { entornoRaiz, leerEnv, ROOT, rutaEnvDe, SERVICIOS } from './servicios.mjs';

// Las herramientas del modo test importan estas piezas de aquí desde la Fase 10;
// ahora viven en `servicios.mjs` (las comparte el tablero de estado) y se
// reexportan para no tocar a quien ya las usaba.
export { entornoRaiz, leerEnv, ROOT, SERVICIOS };

/**
 * ¿Está permitido el modo test en esta instalación? Usa **la misma función** que
 * los servicios (`resolveTestMode` del contrato), así que no hay forma de que la
 * herramienta y la aplicación opinen distinto.
 */
export const estadoDelModoTest = (entorno = entornoRaiz()) => {
  const nodeEnv = entorno.NODE_ENV ?? process.env.NODE_ENV ?? 'development';
  const testMode = (entorno.TEST_MODE ?? process.env.TEST_MODE ?? 'false') === 'true';
  const allow = (entorno.ALLOW_TEST_MODE ?? process.env.ALLOW_TEST_MODE ?? 'false') === 'true';
  return resolveTestMode({ nodeEnv, testMode, allowTestMode: allow });
};

/** Corte de seguridad: sin modo test no se siembra, no se borra y no se verifica. */
export const exigirModoTest = (accion) => {
  const estado = estadoDelModoTest();
  if (estado.enabled) return estado;

  console.error(
    `\n✖ No se puede ${accion}: el modo test no está activo (${estado.state}).\n` +
      `  ${estado.message}\n\n` +
      '  Para sembrar datos ficticios, en el `.env` de la raíz:\n' +
      '      TEST_MODE=true\n' +
      '      ALLOW_TEST_MODE=true\n' +
      '  En la instalación de la clínica esto queda en false y el comando se niega a correr.\n',
  );
  process.exit(1);
};

/** Conexiones a las bases del mundo: solo se abre la que se va a usar. */
export const conexionDe = (servicio, pg) => {
  const definicion = SERVICIOS.find((item) => item.name === servicio);
  if (definicion === undefined) throw new Error(`Servicio desconocido: ${servicio}`);

  const archivo = rutaEnvDe(definicion);
  const entorno = leerEnv(archivo);
  if (!entorno.DATABASE_URL) {
    throw new Error(
      `Falta DATABASE_URL en ${archivo}. Ejecuta "npm run db:bootstrap" y "npm run db:migrate" primero.`,
    );
  }
  const client = new pg.Client({ connectionString: entorno.DATABASE_URL });
  return { client, database: definicion.database, env: entorno };
};

/**
 * Escribe los eventos del mundo en el outbox del servicio que los produce. Se
 * hace con `toOutboxInsert` (el mismo ayudante que usan los servicios) para que
 * el sobre guardado sea idéntico al de la aplicación; `on conflict (event_id) do
 * nothing` hace que repetir el seed no duplique nada.
 */
export const sembrarEventos = async (client, eventos) => {
  let insertados = 0;
  for (const evento of eventos) {
    const fila = toOutboxInsert({
      eventId: evento.id,
      eventType: evento.topic,
      version: 1,
      occurredAt: evento.occurredAt,
      aggregateId: evento.aggregateId,
      producer: evento.producer,
      actorId: null,
      correlationId: null,
      payload: evento.payload,
    });

    const resultado = await client.query(
      `insert into outbox_events (envelope, event_id, event_type, aggregate_id, producer, occurred_at, next_attempt_at)
       values ($1, $2, $3, $4, $5, $6, now())
       on conflict (event_id) do nothing`,
      [
        JSON.stringify(fila.envelope),
        fila.eventId,
        fila.eventType,
        fila.aggregateId,
        fila.producer,
        fila.occurredAt,
      ],
    );
    insertados += resultado.rowCount ?? 0;
  }
  return insertados;
};

/** Borra del outbox los eventos del mundo que todavía no salieron. */
export const borrarEventos = async (client, eventIds) => {
  if (eventIds.length === 0) return 0;
  const resultado = await client.query(
    'delete from outbox_events where event_id = any($1::uuid[])',
    [eventIds],
  );
  return resultado.rowCount ?? 0;
};

/**
 * Deja la secuencia de consecutivos apuntando al último número **real** (por
 * debajo del rango reservado). Así los datos ficticios no empujan los tickets ni
 * los récipes de la clínica a un rango absurdo, y volver a sembrar no cambia el
 * siguiente número que verá la secretaría.
 */
export const ajustarSecuencia = async (client, secuencia, tabla, columna) => {
  const reservado = 900_000;
  await client.query(
    `select setval($1::regclass,
       greatest(coalesce(max(${columna}) filter (where ${columna} < $2), 0), 1),
       coalesce(max(${columna}) filter (where ${columna} < $2), 0) is not null)
       from ${tabla}`,
    [secuencia, reservado],
  );
};

/**
 * PDF mínimo pero **válido** (una página A5 con el aviso de modo test). El seed no
 * compone el récipe A5 —eso lo hace Chromium en la aplicación—, pero archiva uno
 * para que el récipe emitido cumpla sus invariantes (`pdf_path`, `pdf_sha256`) y
 * se pueda abrir y descargar. Determinista: los mismos bytes dan el mismo sha256.
 */
export const pdfDePrueba = (lineas) => {
  const texto = lineas
    .map(
      (linea, index) =>
        `BT /F1 ${index === 0 ? 16 : 11} Tf 40 ${String(520 - index * 24)} Td (${escaparPdf(linea)}) Tj ET`,
    )
    .join('\n');

  const objetos = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 420 595] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${String(Buffer.byteLength(texto))} >>\nstream\n${texto}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];

  let pdf = '%PDF-1.4\n';
  const offsets = [];
  objetos.forEach((objeto, index) => {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${String(index + 1)} 0 obj\n${objeto}\nendobj\n`;
  });

  const inicioXref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${String(objetos.length + 1)}\n0000000000 65535 f \n`;
  for (const offset of offsets) {
    pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  }
  pdf +=
    `trailer\n<< /Size ${String(objetos.length + 1)} /Root 1 0 R >>\n` +
    `startxref\n${String(inicioXref)}\n%%EOF\n`;

  return Buffer.from(pdf, 'latin1');
};

const escaparPdf = (texto) =>
  texto
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/([\\()])/g, '\\$1');

/** Almacén de binarios del servicio clínico (`STORAGE_DIR` de su `.env`). */
export const almacenClinico = (env) => {
  const dir = env.STORAGE_DIR ?? './storage/clinical';
  return createDiskBlobStore({ rootDir: isAbsolute(dir) ? dir : resolve(ROOT, dir) });
};

export { fingerprint };

/** Salida uniforme de las tres herramientas. */
export const titulo = (texto) =>
  console.log(`\n── ${texto} ${'─'.repeat(Math.max(0, 62 - texto.length))}`);
export const ok = (texto) => console.log(`  ✔ ${texto}`);
export const aviso = (texto) => console.log(`  ! ${texto}`);
export const dato = (texto) => console.log(`    ${texto}`);
export const error = (texto) => console.error(`  ✖ ${texto}`);
