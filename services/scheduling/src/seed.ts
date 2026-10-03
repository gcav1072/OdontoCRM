import { addMinutes, expandTemplateSlots, weekdayOf } from '@odontocrm/contracts';
import { existsSync, readFileSync } from 'node:fs';
import pg from 'pg';
import { and, eq, sql } from 'drizzle-orm';

import { loadSchedulingConfig } from './config.js';
import { createSchedulingDatabase } from './db/client.js';
import { appointmentRequests, appointments, slotTemplates } from './db/schema.js';
import { toHm } from './mappers.js';
import { todayInClinic } from './shared/context.js';

/**
 * Datos de prueba de la agenda (ADR 0020): solicitudes en la cola y citas del día
 * marcadas con la nota «MODO TEST», para poder probar la pantalla de programación
 * sin tocar datos reales.
 *
 *   npm run seed:agenda -- --requests 12 --appointments 6
 *   npm run seed:agenda -- --reset
 *
 * Los pacientes salen de la base de pacientes **solo en lectura** (es un script de
 * desarrollo, no el servicio): así la cola muestra nombres y cédulas reales de los
 * datos ficticios del rango 90.000.000+.
 */
const args = process.argv.slice(2);
const readNumber = (flag: string, fallback: number): number => {
  const index = args.indexOf(flag);
  const value = index === -1 ? undefined : args[index + 1];
  const parsed = value === undefined ? Number.NaN : Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.trunc(parsed) : fallback;
};

const requests = readNumber('--requests', 12);
const appointmentsToCreate = readNumber('--appointments', 6);
const reset = args.includes('--reset');
const MARK = 'MODO TEST';

const dateIndex = args.indexOf('--date');
const explicitDate = dateIndex === -1 ? undefined : args[dateIndex + 1];

const config = loadSchedulingConfig();
const database = createSchedulingDatabase(config);

const REASONS = [
  'Dolor en la muela del juicio',
  'Limpieza dental',
  'Control de ortodoncia',
  'Se le rompió una calza',
  'Revisión general',
  'Sangrado de encías',
  'Caries en el sector anterior',
  'Consulta por sensibilidad al frío',
] as const;

/** Pacientes ficticios de la base de pacientes, solo para dar nombres a la demo. */
const loadFictitiousPatients = async (): Promise<
  { id: string; fullName: string; document: string; phone: string | null }[]
> => {
  const path = 'services/patients/.env';
  if (!existsSync(path)) return [];
  const match = /^DATABASE_URL=(.*)$/m.exec(readFileSync(path, 'utf8'));
  if (match?.[1] === undefined) return [];

  const client = new pg.Client({ connectionString: match[1].trim() });
  await client.connect();
  try {
    const rows = await client.query(
      `select id, full_name as "fullName", doc_type || '-' || doc_number as document, phone
         from patients
        where is_fictitious = true and deleted_at is null
        order by doc_number
        limit $1`,
      [Math.max(requests, appointmentsToCreate) + 5],
    );
    return rows.rows;
  } finally {
    await client.end();
  }
};

const main = async (): Promise<void> => {
  if (reset) {
    const removedAppointments = await database.db
      .delete(appointments)
      .where(sql`${appointments.notes} like ${`${MARK}%`}`)
      .returning({ id: appointments.id });
    const removedRequests = await database.db
      .delete(appointmentRequests)
      .where(sql`${appointmentRequests.notes} like ${`${MARK}%`}`)
      .returning({ id: appointmentRequests.id });
    // eslint-disable-next-line no-console -- script de línea de comandos
    console.log(
      `Datos de prueba eliminados: ${String(removedRequests.length)} solicitudes y ${String(removedAppointments.length)} citas.`,
    );
    return;
  }

  const patients = await loadFictitiousPatients();
  if (patients.length === 0) {
    // eslint-disable-next-line no-console -- script de línea de comandos
    console.log('No hay pacientes ficticios. Ejecuta antes:  npm run seed:demo -- --count 200');
    return;
  }

  const today = todayInClinic();
  const now = new Date();

  /** Primer día con consulta a partir de `from` (hoy puede ser sábado o domingo). */
  const findWorkingDay = async (from: string): Promise<string> => {
    const start = new Date(`${from}T00:00:00Z`);
    for (let offset = 0; offset < 14; offset += 1) {
      const date = new Date(start.getTime() + offset * 86_400_000).toISOString().slice(0, 10);
      const templates = await database.db
        .select({ id: slotTemplates.id })
        .from(slotTemplates)
        .where(and(eq(slotTemplates.weekday, weekdayOf(date)), eq(slotTemplates.isActive, true)))
        .limit(1);
      if (templates.length > 0) return date;
    }
    return from;
  };

  const workDay = explicitDate ?? (await findWorkingDay(today));

  // 1) Solicitudes en la cola «en espera de cita».
  const requestRows = Array.from({ length: requests }, (_, index) => {
    const patient = patients[index % patients.length];
    if (patient === undefined) throw new Error('sin pacientes');
    return {
      channel: (['telegram', 'telefono', 'presencial', 'registro'] as const)[index % 4],
      patientId: patient.id,
      patientName: patient.fullName,
      patientDocument: patient.document,
      patientPhone: patient.phone,
      reason: REASONS[index % REASONS.length] ?? 'Consulta',
      status: 'en_espera_cita',
      priority: index % 5 === 0 ? 1 : 0,
      requestedAt: new Date(now.getTime() - index * 36 * 60 * 60 * 1000),
      notes: `${MARK}: solicitud de ejemplo`,
      createdBy: null,
    };
  });

  const insertedRequests = await database.db
    .insert(appointmentRequests)
    .values(requestRows)
    .returning();
  // eslint-disable-next-line no-console -- script de línea de comandos
  console.log(`Solicitudes creadas: ${String(insertedRequests.length)}`);

  // 2) Citas del día repartidas por las franjas de la plantilla.
  if (appointmentsToCreate > 0) {
    const templates = await database.db
      .select()
      .from(slotTemplates)
      .where(and(eq(slotTemplates.weekday, weekdayOf(workDay)), eq(slotTemplates.isActive, true)));
    const slots = templates
      .flatMap((template) =>
        expandTemplateSlots({
          startTime: toHm(template.startTime),
          endTime: toHm(template.endTime),
          slotMinutes: template.slotMinutes,
          breaks: template.breaks,
        }),
      )
      .sort((left, right) => left.startTime.localeCompare(right.startTime));

    if (slots.length === 0) {
      // eslint-disable-next-line no-console -- script de línea de comandos
      console.log(`El ${workDay} no es día de consulta según la plantilla: no se crean citas.`);
      return;
    }

    const statuses = [
      'programada',
      'notificada',
      'en_sala_espera',
      'atendido',
      'programada',
    ] as const;
    const appointmentRows = Array.from(
      { length: Math.min(appointmentsToCreate, slots.length) },
      (_, index) => {
        const slot = slots[index];
        const patient = patients[(index + requests) % patients.length];
        if (slot === undefined || patient === undefined) throw new Error('sin franjas o pacientes');
        const status = statuses[index % statuses.length] ?? 'programada';
        const request = insertedRequests[index];

        return {
          requestId: request?.id ?? null,
          patientId: patient.id,
          patientName: patient.fullName,
          patientDocument: patient.document,
          patientPhone: patient.phone,
          appointmentDate: workDay,
          startTime: `${slot.startTime}:00`,
          endTime: `${slot.endTime}:00`,
          durationMinutes: 30,
          slotKind: 'franja' as const,
          status,
          callCount: status === 'en_sala_espera' ? 1 : 0,
          notes: `${MARK}: cita de ejemplo`,
          createdBy: null,
        };
      },
    );

    await database.db.insert(appointments).values(appointmentRows);
    await database.db
      .update(appointmentRequests)
      .set({ status: 'programada' })
      .where(
        sql`${appointmentRequests.id} in (${sql.join(
          appointmentRows
            .map((row) => row.requestId)
            .filter((id): id is string => id !== null)
            .map((id) => sql`${id}`),
          sql`, `,
        )})`,
      );

    // eslint-disable-next-line no-console -- script de línea de comandos
    console.log(`Citas creadas para el ${workDay}: ${String(appointmentRows.length)}`);
  }

  // eslint-disable-next-line no-console -- script de línea de comandos
  console.log(
    `\nPara borrarlos:  npm run seed:agenda -- --reset\n` +
      `Hoy (hora del consultorio): ${today} · franjas de ${String(addMinutes('08:00', 0))} en adelante.`,
  );
};

main()
  .catch((error: unknown) => {
    // eslint-disable-next-line no-console -- script de línea de comandos
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(async () => {
    await database.close();
  });
