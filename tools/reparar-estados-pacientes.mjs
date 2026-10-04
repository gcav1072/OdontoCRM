#!/usr/bin/env node
/**
 * Reparación puntual: pacientes que **ya tienen cita** pero siguen en
 * `en_espera_cita` porque la proyección del evento no existía cuando se les
 * asignó. Se ven en `/pacientes` como «En espera de cita» con la cita programada.
 *
 *   npm run build:node                                   (usa el dist del servicio)
 *   node tools/reparar-estados-pacientes.mjs             → solo informa (no escribe)
 *   node tools/reparar-estados-pacientes.mjs --apply     → aplica los cambios
 *
 * Usa la **misma función** que la proyección automática
 * (`promotePatientWithAppointment`), así que cada cambio queda con su fila en el
 * outbox y aparece en la auditoría como «status_changed» con el motivo
 * «se le asignó una cita». Nunca toca a un paciente `inactivo`.
 *
 * Es de un solo uso: con la proyección en marcha, esto no debería volver a hacer
 * falta (por eso no entra en `npm run verify`).
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

const patientsUrl = leerEnv('services/patients/.env', 'DATABASE_URL');
const eventsUrl = leerEnv('services/patients/.env', 'EVENTS_DATABASE_URL');
const schedulingUrl = leerEnv('services/scheduling/.env', 'DATABASE_URL');

if (patientsUrl === undefined || schedulingUrl === undefined) {
  console.error(
    'Faltan credenciales: se leen de services/patients/.env y services/scheduling/.env\n' +
      'Ejecuta antes:  npm run db:bootstrap',
  );
  process.exit(1);
}

const dist = resolve(ROOT, 'services/patients/dist');
if (!existsSync(dist)) {
  console.error('Falta services/patients/dist. Ejecuta antes "npm run build:node".');
  process.exit(1);
}

const { createPatientsDatabase } = await import(
  `file://${resolve(dist, 'db/client.js').replace(/\\/g, '/')}`
);
const { loadPatientsConfig } = await import(
  `file://${resolve(dist, 'config.js').replace(/\\/g, '/')}`
);
const { promotePatientWithAppointment } = await import(
  `file://${resolve(dist, 'patients/patient-service.js').replace(/\\/g, '/')}`
);
const { default: pg } = await import('pg');

const agenda = new pg.Client({
  connectionString: schedulingUrl,
  application_name: 'odontocrm-reparacion',
});
const pacientes = createPatientsDatabase(
  loadPatientsConfig({
    DATABASE_URL: patientsUrl,
    ...(eventsUrl === undefined ? {} : { EVENTS_DATABASE_URL: eventsUrl }),
    LOG_LEVEL: 'silent',
  }),
);

/** Citas que cuentan como «tiene cita»: cualquier estado menos cancelada. */
const CON_CITA =
  "('programada', 'notificada', 'en_sala_espera', 'llamado', 'en_consulta', 'atendido', 'no_asistio')";

await agenda.connect();

// El join entre servicios se hace en memoria (cada uno tiene su base).
const citas = await agenda.query(
  `select patient_id, min(appointment_date) as primera_cita, count(1)::int as citas
     from appointments where status in ${CON_CITA} group by patient_id`,
);
const porPaciente = new Map(citas.rows.map((fila) => [fila.patient_id, fila]));

const enEspera = await pacientes.db.execute(
  `select id, doc_type, doc_number, full_name, status, deleted_at
     from patients where status = 'en_espera_cita' and deleted_at is null order by created_at`,
);

const afectados = enEspera.rows.filter((fila) => porPaciente.has(fila.id));

console.log(
  `Pacientes en «en espera de cita»: ${String(enEspera.rows.length)} · con cita ya asignada: ${String(afectados.length)}`,
);
if (afectados.length === 0) {
  console.log('\nNo hay nada que reparar ✔');
} else {
  console.log('\nSe pasarían a «activo»:');
  for (const fila of afectados) {
    const cita = porPaciente.get(fila.id);
    console.log(
      `  ${String(fila.doc_type)}-${String(fila.doc_number).padEnd(10)} ${String(fila.full_name).padEnd(28)} ` +
        `· primera cita ${String(cita?.primera_cita ?? '—').slice(0, 15)} · ${String(cita?.citas ?? 0)} cita(s)`,
    );
  }
}

if (!aplicar) {
  console.log('\n(simulación: no se escribió nada · añade --apply para aplicarlo)');
} else if (afectados.length > 0) {
  let aplicados = 0;
  for (const fila of afectados) {
    const hecho = await promotePatientWithAppointment(
      pacientes.db,
      fila.id,
      'se le asignó una cita',
    );
    if (hecho) aplicados += 1;
  }
  console.log(
    `\nAplicado: ${String(aplicados)} paciente(s) pasados a «activo», con su rastro en el outbox.`,
  );
  if (eventsUrl !== undefined) {
    console.log('El evento patients.patient.updated sale por el outbox y queda en la auditoría.');
  } else {
    console.log(
      'Aviso: falta EVENTS_DATABASE_URL en services/patients/.env; el publicador del outbox no está en marcha aquí,',
      '\nla fila queda pendiente y el servicio la publicará en su próximo ciclo.',
    );
  }
}

await agenda.end();
await pacientes.close();
