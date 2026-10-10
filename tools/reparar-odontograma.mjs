#!/usr/bin/env node
/**
 * Diagnóstico y reparación del odontograma (spec anexo ADR 0032).
 *
 * La migración `0002` ya repara la base de una vez al añadir el CHECK de estado, pero
 * este tool queda como **red de seguridad**: sirve para auditar la boca sin escribir
 * nada (simulación) y para volver a sanear los datos si alguna escritura directa en la
 * base —fuera del servicio— dejó una convivencia imposible.
 *
 *   npm run build:node                                (usa el dist del servicio)
 *   node tools/reparar-odontograma.mjs                → solo informa (no escribe)
 *   node tools/reparar-odontograma.mjs --apply        → aplica los cambios
 *
 * Qué busca:
 *  1. **Estados imposibles**: `caries` o `extraccion_indicada` que no estén `pendiente`
 *     y `ausente` que no esté `completado` (la migración ya los clampeó).
 *  2. **Parejas imposibles vivas**: `extraccion_indicada` + `implante` en la misma
 *     pieza (el bug de la pieza 13).
 *  3. **Caras vivas sobre implante o pieza ausente**: el titanio y la ausencia no tienen
 *     caras naturales.
 *
 * Cada cambio queda con su fila en `tooth_finding_history` («saneado por reglas
 * clínicas»), igual que la migración, para que la historia siga siendo defendible.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = process.cwd();
const aplicar = process.argv.includes('--apply');

const leerEnv = (ruta, clave) => {
  const camino = resolve(ROOT, ruta);
  if (!existsSync(camino)) return undefined;
  return new RegExp(`^${clave}=(.*)$`, 'm').exec(readFileSync(camino, 'utf8'))?.[1]?.trim();
};

const odontogramUrl = leerEnv('services/odontogram/.env', 'DATABASE_URL');
if (odontogramUrl === undefined) {
  console.error(
    'Falta DATABASE_URL: se lee de services/odontogram/.env\n' +
      'Ejecuta antes:  npm run db:bootstrap',
  );
  process.exit(1);
}

const { default: pg } = await import('pg');

const client = new pg.Client({
  connectionString: odontogramUrl,
  application_name: 'odontocrm-reparacion-odontograma',
});
await client.connect();

/* ── Detección ─────────────────────────────────────────────────────────────── */

const VIOLACIONES = [
  {
    titulo: 'Estados imposibles (condición que no admite ese estado)',
    sql: `select patient_id, tooth_number, condition, state
            from tooth_findings
           where (condition in ('caries', 'extraccion_indicada') and state <> 'pendiente')
              or (condition = 'ausente' and state <> 'completado')
           order by patient_id, tooth_number`,
    fila: (f) => `  pieza ${f.tooth_number} · ${f.condition} (${f.state})`,
  },
  {
    titulo: 'Parejas imposibles vivas (extracción indicada + implante)',
    sql: `select f.patient_id, f.tooth_number
            from tooth_findings f
           where f.condition = 'extraccion_indicada'
             and f.resolved_at is null
             and exists (
               select 1 from tooth_findings i
                where i.odontogram_id = f.odontogram_id
                  and i.tooth_number = f.tooth_number
                  and i.condition = 'implante'
                  and i.resolved_at is null)
           order by f.patient_id, f.tooth_number`,
    fila: (f) => `  pieza ${f.tooth_number}`,
  },
  {
    titulo: 'Caras vivas sobre implante o pieza ausente',
    sql: `select f.patient_id, f.tooth_number, f.surface, f.condition
            from tooth_findings f
           where f.surface is not null
             and f.resolved_at is null
             and exists (
               select 1 from tooth_findings w
                where w.odontogram_id = f.odontogram_id
                  and w.tooth_number = f.tooth_number
                  and w.resolved_at is null
                  and w.condition in ('implante', 'ausente'))
           order by f.patient_id, f.tooth_number, f.surface`,
    fila: (f) => `  pieza ${f.tooth_number} · cara ${f.surface} (${f.condition})`,
  },
];

let total = 0;
for (const { titulo, sql, fila } of VIOLACIONES) {
  const { rows } = await client.query(sql);
  total += rows.length;
  console.log(`\n${titulo}: ${String(rows.length)}`);
  for (const row of rows.slice(0, 50)) console.log(fila(row));
  if (rows.length > 50) console.log(`  … y ${String(rows.length - 50)} más`);
}

console.log(`\nTotal de anomalías: ${String(total)}` + (total === 0 ? ' ✔' : ''));

if (!aplicar) {
  console.log('\n(simulación: no se escribió nada · añade --apply para aplicarlo)');
  await client.end();
  process.exit(0);
}

if (total === 0) {
  console.log('\nNo hay nada que reparar.');
  await client.end();
  process.exit(0);
}

/* ── Reparación (mismas sentencias que la migración 0002) ──────────────────── */

const REPARACION = [
  // 1) Extracción indicada cumplida → pieza ausente.
  `insert into tooth_findings (
     odontogram_id, patient_id, tooth_number, surface, condition, state,
     notes, recorded_by, recorded_by_username, recorded_in_session_id, recorded_at, updated_at)
   select f.odontogram_id, f.patient_id, f.tooth_number, null, 'ausente', 'completado',
          f.notes, f.recorded_by, f.recorded_by_username, f.recorded_in_session_id, now(), now()
     from tooth_findings f
    where f.condition = 'extraccion_indicada' and f.state = 'completado' and f.resolved_at is null
   on conflict (odontogram_id, tooth_number, surface, condition) do nothing`,
  `insert into tooth_finding_history (
     odontogram_id, finding_id, patient_id, tooth_number, surface, condition, state, event, reason, notes, occurred_at)
   select f.odontogram_id, f.id, f.patient_id, f.tooth_number, f.surface, f.condition, f.state, 'resuelto',
          'saneado por reglas clínicas: la extracción cumplida deja la pieza ausente', f.notes, now()
     from tooth_findings f
    where f.condition = 'extraccion_indicada' and f.state = 'completado' and f.resolved_at is null`,
  `update tooth_findings set resolved_at = now(), updated_at = now()
    where condition = 'extraccion_indicada' and state = 'completado' and resolved_at is null`,
  // 2) Caries tratada → restauración completada en la misma cara.
  `insert into tooth_findings (
     odontogram_id, patient_id, tooth_number, surface, condition, state,
     notes, recorded_by, recorded_by_username, recorded_in_session_id, recorded_at, updated_at)
   select f.odontogram_id, f.patient_id, f.tooth_number, f.surface, 'restauracion', 'completado',
          f.notes, f.recorded_by, f.recorded_by_username, f.recorded_in_session_id, now(), now()
     from tooth_findings f
    where f.condition = 'caries' and f.state = 'completado' and f.resolved_at is null
   on conflict (odontogram_id, tooth_number, surface, condition) do nothing`,
  `insert into tooth_finding_history (
     odontogram_id, finding_id, patient_id, tooth_number, surface, condition, state, event, reason, notes, occurred_at)
   select f.odontogram_id, f.id, f.patient_id, f.tooth_number, f.surface, f.condition, f.state, 'resuelto',
          'saneado por reglas clínicas: la caries tratada pasa a restauración', f.notes, now()
     from tooth_findings f
    where f.condition = 'caries' and f.state = 'completado' and f.resolved_at is null`,
  `update tooth_findings set resolved_at = now(), updated_at = now()
    where condition = 'caries' and state = 'completado' and resolved_at is null`,
  // 3) Un implante no convive con una extracción indicada.
  `insert into tooth_finding_history (
     odontogram_id, finding_id, patient_id, tooth_number, surface, condition, state, event, reason, notes, occurred_at)
   select f.odontogram_id, f.id, f.patient_id, f.tooth_number, f.surface, f.condition, f.state, 'resuelto',
          'saneado por reglas clínicas: un implante no convive con una extracción indicada', f.notes, now()
     from tooth_findings f
    where f.condition = 'extraccion_indicada' and f.resolved_at is null
      and exists (select 1 from tooth_findings i
                   where i.odontogram_id = f.odontogram_id and i.tooth_number = f.tooth_number
                     and i.condition = 'implante' and i.resolved_at is null)`,
  `update tooth_findings f set resolved_at = now(), updated_at = now()
    where f.condition = 'extraccion_indicada' and f.resolved_at is null
      and exists (select 1 from tooth_findings i
                   where i.odontogram_id = f.odontogram_id and i.tooth_number = f.tooth_number
                     and i.condition = 'implante' and i.resolved_at is null)`,
  // 4) El implante y la pieza ausente excluyen las caras.
  `insert into tooth_finding_history (
     odontogram_id, finding_id, patient_id, tooth_number, surface, condition, state, event, reason, notes, occurred_at)
   select f.odontogram_id, f.id, f.patient_id, f.tooth_number, f.surface, f.condition, f.state, 'superado',
          'saneado por reglas clínicas: la pieza no conserva caras naturales', f.notes, now()
     from tooth_findings f
    where f.surface is not null and f.resolved_at is null
      and exists (select 1 from tooth_findings w
                   where w.odontogram_id = f.odontogram_id and w.tooth_number = f.tooth_number
                     and w.resolved_at is null and w.condition in ('implante', 'ausente'))`,
  `update tooth_findings f set resolved_at = now(), updated_at = now()
    where f.surface is not null and f.resolved_at is null
      and exists (select 1 from tooth_findings w
                   where w.odontogram_id = f.odontogram_id and w.tooth_number = f.tooth_number
                     and w.resolved_at is null and w.condition in ('implante', 'ausente'))`,
  // 5) Clamp de estados imposibles que queden.
  `update tooth_findings set state = 'pendiente', updated_at = now() where condition = 'caries' and state <> 'pendiente'`,
  `update tooth_findings set state = 'pendiente', updated_at = now() where condition = 'extraccion_indicada' and state <> 'pendiente'`,
  `update tooth_findings set state = 'completado', updated_at = now() where condition = 'ausente' and state <> 'completado'`,
];

await client.query('begin');
try {
  for (const sentencia of REPARACION) await client.query(sentencia);
  await client.query('commit');
} catch (fallo) {
  await client.query('rollback');
  console.error('\nLa reparación falló y se deshizo:', fallo.message);
  await client.end();
  process.exit(1);
}

console.log(
  `\nAplicado: ${String(total)} anomalía(s) saneadas, con su rastro en tooth_finding_history.`,
);
await client.end();
