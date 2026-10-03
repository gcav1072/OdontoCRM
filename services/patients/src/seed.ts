import { ageFromBirthDate, formatDocument, type DocType, type Sex } from '@odontocrm/contracts';
import { createRng } from '@odontocrm/testing';
import { and, eq, isNull, sql } from 'drizzle-orm';

import { loadPatientsConfig } from './config.js';
import { createPatientsDatabase } from './db/client.js';
import { patients } from './db/schema.js';

/**
 * Datos de prueba del servicio de pacientes (ADR 0020): **deterministas** y
 * marcados como ficticios.
 *
 *   npm run seed:demo -w @odontocrm/patients -- --count 5000
 *   npm run seed:demo -w @odontocrm/patients -- --reset
 *
 * Usa cédulas del rango reservado 90.000.000+ y `is_fictitious = true`, así que
 * `--reset` borra solo lo ficticio y nunca toca datos reales.
 */
const args = process.argv.slice(2);
const readNumber = (flag: string, fallback: number): number => {
  const index = args.indexOf(flag);
  const value = index === -1 ? undefined : args[index + 1];
  const parsed = value === undefined ? Number.NaN : Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : fallback;
};

const count = readNumber('--count', 200);
const reset = args.includes('--reset');
const SEED = 'odontocrm-pacientes-2026';

const NAMES = [
  'María Pérez',
  'José Rodríguez',
  "O'Brien Fernández",
  'Carmen Gómez',
  'Luis Hernández',
  'Erika Blanco',
  'Rafael Marcano',
  'Yulimar Salazar',
  'Andrés Rondón',
  'Gabriela Ferrer',
  'Jesús Aponte',
  'Daniela Guerra',
  'Manuel Narváez',
  'Rosa Delgado',
  'Pedro Márquez',
  'Andreína Suárez',
  'Wilmer Colmenares',
  'Ana Isabel Peña',
  'Carlos Eduardo Lárez',
  'Sofía Alejandra Ruiz',
  'Miguel Ángel Torres',
  'Valentina Rojas',
  'Jean Carlos Boada',
  'Marisela Quintero',
] as const;

const OCCUPATIONS = [
  'Estudiante',
  'Comerciante',
  'Docente',
  'Obrero',
  'Ingeniera',
  'Pensionado',
  'Contadora',
  'Ama de casa',
  null,
] as const;

const ADDRESSES = [
  'Av. Luis del Valle García, C.E. Nueva Esparta, Planta Baja, Local 1-2',
  'Calle Sucre, casa 12, Porlamar',
  'Sector Los Robles, vereda 3',
  'Urb. Jorge Coll, calle 5 con avenida 2',
  null,
] as const;

const config = loadPatientsConfig();
const database = createPatientsDatabase(config);

const iso = (date: Date): string => date.toISOString().slice(0, 10);

const main = async (): Promise<void> => {
  if (reset) {
    const removed = await database.db
      .delete(patients)
      .where(eq(patients.isFictitious, true))
      .returning({ id: patients.id });
    // eslint-disable-next-line no-console -- script de línea de comandos
    console.log(`Datos de prueba eliminados: ${String(removed.length)} pacientes ficticios.`);
    return;
  }

  const rng = createRng(SEED);
  const now = new Date();

  // Segunda ejecución sin --reset: avisar en lugar de chocar con el índice único.
  const existing = await database.db
    .select({ value: sql<number>`count(1)::int` })
    .from(patients)
    .where(eq(patients.isFictitious, true));
  const alreadyThere = existing[0]?.value ?? 0;

  if (alreadyThere > 0) {
    // eslint-disable-next-line no-console -- script de línea de comandos
    console.log(
      `Ya hay ${String(alreadyThere)} pacientes ficticios en la base.\n` +
        'Si quieres regenerarlos:  npm run seed:demo -- --reset  y luego  npm run seed:demo -- --count 5000',
    );
    return;
  }

  const rows: (typeof patients.$inferInsert)[] = [];

  for (let index = 0; index < count; index += 1) {
    // Edad repartida en los tramos que importan para los reportes.
    const age = rng.weighted([
      { value: rng.int(1, 12), weight: 2 },
      { value: rng.int(13, 17), weight: 2 },
      { value: rng.int(18, 40), weight: 5 },
      { value: rng.int(41, 65), weight: 4 },
      { value: rng.int(66, 88), weight: 2 },
    ]);

    const birthDate = new Date(
      Date.UTC(now.getUTCFullYear() - age, rng.int(0, 11), rng.int(1, 28)),
    );

    const isMinor = ageFromBirthDate(birthDate, now) < 18;
    const docType: DocType = 'V';
    // Rango reservado para datos ficticios: 90.000.000+
    const docNumber = String(90_000_000 + index);

    rows.push({
      docType,
      docNumber,
      fullName: `${rng.pick(NAMES)} ${String(index).padStart(4, '0')}`,
      birthDate: iso(birthDate),
      sex: rng.pick(['M', 'F', 'F'] as const) as Sex,
      phone: `+5841${String(rng.int(2, 6))}${String(rng.int(1_000_000, 9_999_999))}`,
      phoneAlt: rng.bool(0.3) ? `+5821${String(rng.int(2_000_000, 9_999_999))}` : null,
      email: rng.bool(0.35) ? `paciente${String(index)}@ejemplo.com` : null,
      address: rng.pick(ADDRESSES),
      occupation: rng.pick(OCCUPATIONS),
      notes: isMinor ? 'Paciente pediátrico de prueba' : null,
      status: rng.weighted([
        { value: 'activo', weight: 6 },
        { value: 'en_espera_cita', weight: 3 },
        { value: 'inactivo', weight: 1 },
      ]),
      isFictitious: true,
    });
  }

  const startedAt = Date.now();
  const BATCH = 500;
  for (let offset = 0; offset < rows.length; offset += BATCH) {
    await database.db.insert(patients).values(rows.slice(offset, offset + BATCH));
  }

  // Un representante para los menores, como en la vida real.
  await database.db.execute(sql`
    insert into patient_guardians (patient_id, full_name, relationship, phone)
    select p.id, 'Representante de ' || p.full_name, 'Madre', p.phone
      from patients p
     where p.is_fictitious = true
       and p.birth_date > (current_date - interval '18 years')
       and not exists (select 1 from patient_guardians g where g.patient_id = p.id)
  `);

  const totals = await database.db
    .select({ value: sql<number>`count(1)::int` })
    .from(patients)
    .where(and(eq(patients.isFictitious, true), isNull(patients.deletedAt)));

  // eslint-disable-next-line no-console -- script de línea de comandos
  console.log(
    `Pacientes de prueba insertados: ${String(rows.length)} en ${String(Date.now() - startedAt)} ms\n` +
      `Total ficticios en la base: ${String(totals[0]?.value ?? 0)}\n` +
      `Ejemplo: ${formatDocument('V', '90000000')} … ${formatDocument('V', String(90_000_000 + count - 1))}\n` +
      'Para borrarlos: npm run seed:demo -w @odontocrm/patients -- --reset',
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
