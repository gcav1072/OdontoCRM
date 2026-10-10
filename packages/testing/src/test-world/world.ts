import {
  clinicalAlerts,
  CLINICAL_SECTION_KEYS,
  conditionsConflict,
  formatDocument,
  TEST_MODE_SEED,
  type AppointmentStatus,
  type Channel,
  type ClinicalSectionKey,
  type ClinicalSessionContent,
  type DocType,
  type PatientStatus,
  type Sex,
  type ToothCondition,
  type ToothSurface,
} from '@odontocrm/contracts';
import { createRng, type SeededRandom } from '../prng.js';
import {
  addDays,
  addMinutes,
  ageAt,
  clinicDate,
  clinicInstant,
  CLINIC_SLOTS,
  isWorkday,
  nextWorkday,
  previousWorkday,
  weekdayOf,
} from './clinic-time.js';
import {
  buildPrescription,
  buildRecordSections,
  buildSessionContent,
  type TestClinicalProfile,
} from './clinical-content.js';
import { buildBillingWorld, type TestWorldBilling } from './billing.js';
import { deterministicUuid, FICTITIOUS_SEQUENCE_MIN } from './ids.js';

/**
 * El **mundo de prueba** del modo test (ADR 0020): un conjunto de datos
 * ficticios, determinista y completo —pacientes, solicitudes, citas, historias,
 * sesiones, odontogramas y récipes— del que cada servicio siembra su parte.
 *
 * Dos ideas sostienen este diseño:
 *
 * 1. **El mundo es puro y derivado de la semilla.** No se pasan datos entre
 *    servicios: cada seed vuelve a calcular el mismo mundo y encuentra los mismos
 *    UUID, así que `patients` inserta al paciente y `clinical` se refiere a él sin
 *    consultar nada. Es lo que permite que `seed:verify` compare huellas y que
 *    `seed:reset` borre exactamente lo ficticio en las nueve bases.
 * 2. **Todo cuelga de un día ancla.** El ancla es hoy (hora de Venezuela) salvo
 *    que se fije con `--anchor`: las citas atendidas caen en las semanas
 *    anteriores y la jornada de hoy tiene sala de espera y consultorio, que es lo
 *    que hace falta para demostrar el sistema y para que los reportes tengan
 *    historia reciente.
 */

/** El ancla por defecto: hoy en el consultorio. */
export const defaultAnchor = (now: Date = new Date()): string => clinicDate(now);

export type TestPatientRole = 'atendido' | 'no_asistio' | 'en_sala' | 'en_espera' | 'hoy';

export interface TestWorldGuardian {
  fullName: string;
  docType: DocType;
  docNumber: string;
  relationship: string;
  phone: string;
}

export interface TestWorldPatient {
  id: string;
  index: number;
  docType: DocType;
  docNumber: string;
  /** Documento formateado (`V-90000001`), como lo publican los eventos. */
  document: string;
  fullName: string;
  birthDate: string;
  age: number;
  sex: Sex;
  phone: string;
  phoneAlt: string | null;
  email: string | null;
  address: string;
  occupation: string | null;
  status: PatientStatus;
  isFictitious: true;
  registeredAt: string;
  role: TestPatientRole;
  profile: TestClinicalProfile;
  /** Visitas atendidas (0, 1 o 2). */
  visits: number;
  guardian: TestWorldGuardian | null;
}

export interface TestWorldRequest {
  id: string;
  /** Ticket del rango reservado (900.001+): no compite con los reales. */
  ticketNumber: number;
  patientId: string;
  patientName: string;
  patientDocument: string;
  patientPhone: string;
  channel: Channel;
  reason: string;
  priority: number;
  status: AppointmentStatus;
  requestedAt: string;
  notes: string;
}

export interface TestWorldAppointment {
  id: string;
  requestId: string;
  patientId: string;
  patientName: string;
  patientDocument: string;
  patientPhone: string;
  date: string;
  startTime: string;
  endTime: string;
  durationMinutes: number;
  slotKind: 'franja';
  status: AppointmentStatus;
  scheduledAt: string;
  notifiedAt: string | null;
  /** Cuándo confirmó el paciente su asistencia (ADR 0052). */
  confirmedAt: string | null;
  checkedInAt: string | null;
  calledAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  noShowAt: string | null;
  cancelledAt: string | null;
  rescheduledAt: string | null;
  rescheduledFromId: string | null;
  callCount: number;
  clinicalSessionId: string | null;
  noShowReason: string | null;
  cancelReason: string | null;
  notes: string;
}

export interface TestWorldCapacity {
  date: string;
  capacity: number;
  notes: string | null;
}

export interface TestWorldFinding {
  id: string;
  odontogramId: string;
  patientId: string;
  toothNumber: number;
  /** `null` = pieza completa (ausente, corona, implante…). */
  surface: ToothSurface | null;
  condition: ToothCondition;
  state: 'pendiente' | 'completado';
  recordedAt: string;
  sessionId: string | null;
}

export interface TestWorldRecord {
  id: string;
  patientId: string;
  status: 'firmada';
  sections: Record<ClinicalSectionKey, Record<string, unknown>>;
  alertCodes: string[];
  createdAt: string;
  signedAt: string;
  consentRegisteredAt: string;
}

export interface TestWorldSession {
  id: string;
  recordId: string;
  patientId: string;
  appointmentId: string;
  sessionNumber: number;
  status: 'cerrada';
  content: ClinicalSessionContent;
  procedureCodes: string[];
  openedAt: string;
  closedAt: string;
  /** Piezas tratadas en la sesión: de aquí salen los hallazgos del odontograma. */
  teeth: number[];
}

export interface TestWorldPrescriptionItem {
  medicationName: string;
  presentation: string | null;
  route: 'oral' | 'sublingual' | 'topica' | 'intramuscular' | 'endovenosa' | 'otra' | null;
  dose: string;
  frequency: string;
  duration: string | null;
  instructions: string | null;
  quantity: string | null;
}

export interface TestWorldPrescription {
  id: string;
  sessionId: string;
  patientId: string;
  /** Número del rango reservado (900.001+): `RX-900001`. */
  number: number;
  verifyCode: string;
  issuedAt: string;
  generalInstructions: string;
  items: TestWorldPrescriptionItem[];
}

export interface TestWorld {
  seed: string;
  anchor: string;
  /** Instante de referencia con el que se calculó el mundo. */
  reference: string;
  patients: TestWorldPatient[];
  requests: TestWorldRequest[];
  appointments: TestWorldAppointment[];
  capacities: TestWorldCapacity[];
  records: TestWorldRecord[];
  sessions: TestWorldSession[];
  prescriptions: TestWorldPrescription[];
  findings: TestWorldFinding[];
  /** Tasas, aranceles, facturas, cobros y nota de crédito (Fase 11). */
  billing: TestWorldBilling;
  totals: {
    patients: number;
    requests: number;
    appointments: number;
    attended: number;
    noShows: number;
    today: number;
    records: number;
    sessions: number;
    prescriptions: number;
    findings: number;
    rates: number;
    aranceles: number;
    invoices: number;
    drafts: number;
    payments: number;
    creditNotes: number;
  };
}

export interface TestWorldOptions {
  /** Día de referencia del consultorio (`YYYY-MM-DD`). Por defecto, hoy. */
  anchor?: string;
  /** Instante con el que se calcula «hoy» (se inyecta en las pruebas). */
  now?: Date;
}

/**
 * Rango reservado de consecutivos ficticios (tickets, récipes y documentos de
 * facturación). Vive en `ids.js` —lo comparten los tres— y se reexporta aquí, que es
 * donde el mundo lo usa.
 */
export { FICTITIOUS_SEQUENCE_MIN };

const NAMES_FEMENINE = [
  'María Fernanda Pérez',
  'Carmen Teresa Gómez',
  'Yulimar del Valle Salazar',
  'Daniela Andreína Guerra',
  'Rosa Amelia Delgado',
  'Andreína Isabel Suárez',
  'Ana Isabel Peña',
  'Sofía Alejandra Ruiz',
  'Valentina Rojas',
  'Marisela Quintero',
  'Gabriela Ferrer',
  'Elena del Carmen Blanco',
  'Yohana Coromoto Marcano',
  'Luisa Fernanda Aponte',
  'Norelys Beatriz Narváez',
  'Carlota Virginia Lárez',
  'Marbella Josefina Rondón',
  'Zuleima Antonia Boada',
  'Katiuska del Mar Hernández',
  'Rosangela Pilar Vásquez',
] as const;

const NAMES_MASCULINE = [
  'José Gregorio Rodríguez',
  'Luis Alberto Hernández',
  'Rafael Eduardo Marcano',
  'Andrés Eloy Rondón',
  'Jesús Alberto Aponte',
  'Manuel Alejandro Narváez',
  'Pedro José Márquez',
  'Wilmer Antonio Colmenares',
  'Carlos Eduardo Lárez',
  'Miguel Ángel Torres',
  'Jean Carlos Boada',
  'Freddy Ramón Salazar',
  'Héctor Manuel Guerra',
  'Iván Alexander Ferrer',
  'Óscar Enrique Delgado',
  'Douglas José Quintero',
  'Alexander de Jesús Peña',
  'Jhonatan David Suárez',
  'Richard Antonio Blanco',
  'Gustavo Adolfo Vásquez',
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
  'Chofer',
  'Pescador',
  'Enfermera',
  null,
] as const;

const ADDRESSES = [
  'Av. Principal, Res. Los Jardines, piso 2, apto 2-A',
  'Calle Sucre, casa 12, Porlamar',
  'Sector Los Robles, vereda 3, casa 8',
  'Urb. Jorge Coll, calle 5 con avenida 2',
  'Calle Igualdad, edificio Mar Caribe, piso 3',
  'Av. 4 de Mayo, sector Genovés, casa 21',
  'Villa Rosa, calle El Colegio, casa 4',
] as const;

const REASONS_ADULT = [
  'Me duele una muela desde hace tres días y no puedo masticar',
  'Se me partió un diente comiendo y quiero que me lo revise',
  'Tengo las encías inflamadas y me sangran al cepillarme',
  'Quiero una limpieza y revisión general',
  'Me molesta el frío en los dientes de adelante',
  'Me falta una muela y quiero saber qué opciones tengo',
  'Tengo una caries que me está creciendo',
  'Me sale sangre cuando me cepillo y tengo mal aliento',
  'Quiero revisarme porque tengo diabetes y me dijeron que debo cuidarme la boca',
  'Me duele la encía alrededor de una muela del juicio',
] as const;

const REASONS_CHILD = [
  'Al niño le duele una muela y no ha dormido bien',
  'La niña tiene un diente negro adelante y me preocupa',
  'Vengo a que le revisen los dientes al niño, es la primera vez',
  'Al niño le sangran las encías cuando se cepilla',
  'Se le cayó un diente jugando y quiero que lo vean',
] as const;

const REASONS_CONTROL = [
  'Vengo a control, me hicieron una restauración el mes pasado',
  'Vengo por la limpieza de control',
  'Quiero revisar cómo va el tratamiento de las encías',
  'Vengo a que me revisen la corona que me pusieron',
] as const;

const NO_SHOW_REASONS = [
  'No asistió y no avisó',
  'Avisó que no podía llegar y no se reprogramó',
  'No asistió; se le envió el recordatorio por Telegram',
  'No llegó a la cita del día',
] as const;

const CANCEL_REASONS = [
  'La paciente canceló porque estaba fuera de la ciudad',
  'Se canceló por una emergencia familiar del paciente',
] as const;

/**
 * Plantilla del mundo: 40 pacientes repartidos en los tramos de edad que piden
 * los reportes (0-12, 13-17, 18-40, 41-65, 66+), con el papel que juegan en la
 * jornada y el perfil clínico que decide su historia, sus hallazgos y su récipe.
 *
 * Los perfiles no son decorativos: cada uno tiene que aparecer al menos una vez
 * para que los seis reportes y el semáforo del consultorio muestren datos
 * (diabéticos, hipertensos, alérgicos y anticoagulados incluidos).
 */
interface PatientSlot {
  band: '0-12' | '13-17' | '18-40' | '41-65' | '66+';
  role: TestPatientRole;
  profile: TestClinicalProfile;
  visits: 0 | 1 | 2;
}

const PLAN: readonly PatientSlot[] = [
  // 0-12 · ocho pacientes: cuatro pediátricos, dos con caries múltiple y dos sanos.
  { band: '0-12', role: 'atendido', profile: 'pediatrico', visits: 1 },
  { band: '0-12', role: 'atendido', profile: 'caries_multiple', visits: 1 },
  { band: '0-12', role: 'atendido', profile: 'pediatrico', visits: 1 },
  { band: '0-12', role: 'en_espera', profile: 'sano', visits: 0 },
  { band: '0-12', role: 'no_asistio', profile: 'sano', visits: 0 },
  { band: '0-12', role: 'atendido', profile: 'caries_multiple', visits: 1 },
  { band: '0-12', role: 'hoy', profile: 'pediatrico', visits: 0 },
  { band: '0-12', role: 'en_espera', profile: 'pediatrico', visits: 0 },

  // 13-17 · cinco adolescentes.
  { band: '13-17', role: 'atendido', profile: 'caries_multiple', visits: 1 },
  { band: '13-17', role: 'atendido', profile: 'sano', visits: 1 },
  { band: '13-17', role: 'atendido', profile: 'periodontal', visits: 1 },
  { band: '13-17', role: 'en_espera', profile: 'sano', visits: 0 },
  { band: '13-17', role: 'hoy', profile: 'caries_multiple', visits: 0 },

  // 18-40 · catorce adultos: la mayoría con historia, con los crónicos repartidos.
  { band: '18-40', role: 'atendido', profile: 'sano', visits: 2 },
  { band: '18-40', role: 'atendido', profile: 'caries_multiple', visits: 2 },
  { band: '18-40', role: 'atendido', profile: 'diabetes', visits: 1 },
  { band: '18-40', role: 'atendido', profile: 'periodontal', visits: 2 },
  { band: '18-40', role: 'atendido', profile: 'alergia_penicilina', visits: 1 },
  { band: '18-40', role: 'atendido', profile: 'sano', visits: 1 },
  { band: '18-40', role: 'atendido', profile: 'caries_multiple', visits: 1 },
  { band: '18-40', role: 'no_asistio', profile: 'sano', visits: 0 },
  { band: '18-40', role: 'en_sala', profile: 'hipertension', visits: 1 },
  { band: '18-40', role: 'en_espera', profile: 'caries_multiple', visits: 0 },
  { band: '18-40', role: 'en_espera', profile: 'sano', visits: 0 },
  { band: '18-40', role: 'hoy', profile: 'periodontal', visits: 0 },
  { band: '18-40', role: 'hoy', profile: 'sano', visits: 0 },
  { band: '18-40', role: 'atendido', profile: 'anticoagulado', visits: 1 },

  // 41-65 · ocho adultos mayores.
  { band: '41-65', role: 'atendido', profile: 'hipertension', visits: 2 },
  { band: '41-65', role: 'atendido', profile: 'periodontal', visits: 2 },
  { band: '41-65', role: 'atendido', profile: 'diabetes', visits: 1 },
  { band: '41-65', role: 'atendido', profile: 'caries_multiple', visits: 1 },
  { band: '41-65', role: 'atendido', profile: 'periodontal', visits: 1 },
  { band: '41-65', role: 'no_asistio', profile: 'hipertension', visits: 0 },
  { band: '41-65', role: 'en_espera', profile: 'diabetes', visits: 0 },
  { band: '41-65', role: 'en_espera', profile: 'sano', visits: 0 },
  { band: '41-65', role: 'hoy', profile: 'alergia_penicilina', visits: 0 },

  // 66+ · cuatro adultos mayores, con los dos desdentados parciales.
  { band: '66+', role: 'atendido', profile: 'edentulo_parcial', visits: 1 },
  { band: '66+', role: 'atendido', profile: 'edentulo_parcial', visits: 1 },
  { band: '66+', role: 'no_asistio', profile: 'hipertension', visits: 0 },
  { band: '66+', role: 'en_sala', profile: 'diabetes', visits: 1 },
];

const AGE_RANGE: Readonly<Record<PatientSlot['band'], readonly [number, number]>> = {
  '0-12': [2, 12],
  '13-17': [13, 17],
  '18-40': [18, 40],
  '41-65': [41, 65],
  '66+': [66, 84],
};

const iso = (date: Date): string => date.toISOString();

/** Hora del consultorio en ISO con desplazamiento (`-04:00`), como los eventos. */
const clinicIso = (date: string, time: string): string => iso(clinicInstant(date, time));

const addHoursToIso = (instant: string, hours: number): string =>
  iso(new Date(new Date(instant).getTime() + hours * 3_600_000));

const addMinutesToIso = (instant: string, minutes: number): string =>
  iso(new Date(new Date(instant).getTime() + minutes * 60_000));

/** Documento reservado para datos ficticios: 90.000.000+ (ADR 0020). */
const fictitiousDocument = (index: number): string => String(90_000_000 + index);

const birthDateFor = (rng: SeededRandom, anchor: string, band: PatientSlot['band']): string => {
  const [minAge, maxAge] = AGE_RANGE[band];
  const age = rng.int(minAge, maxAge);
  const anchorDate = new Date(`${anchor}T12:00:00Z`);
  const year = anchorDate.getUTCFullYear() - age;
  const month = rng.int(1, 12);
  const day = rng.int(1, 28);
  return `${String(year)}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
};

/** Piezas del odontograma según la dentición y el perfil clínico. */
const findingsFor = (
  rng: SeededRandom,
  patient: TestWorldPatient,
  session: TestWorldSession,
): Omit<TestWorldFinding, 'id' | 'odontogramId' | 'patientId' | 'recordedAt' | 'sessionId'>[] => {
  const temporal = patient.age <= 12;
  const quadrantTeeth = temporal
    ? [51, 52, 53, 54, 55, 61, 62, 63, 64, 65, 71, 72, 73, 74, 75, 81, 82, 83, 84, 85]
    : [
        11, 12, 13, 14, 15, 16, 17, 21, 22, 23, 24, 25, 26, 27, 31, 32, 33, 34, 35, 36, 37, 41, 42,
        43, 44, 45, 46, 47,
      ];
  const surfaces: readonly ToothSurface[] = [
    'occlusal',
    'mesial',
    'distal',
    'vestibular',
    'lingual',
  ];
  const used = new Set<string>();
  /** Condiciones vigentes por pieza, para no generar parejas imposibles (spec §3). */
  const porPieza = new Map<number, ToothCondition[]>();
  const findings: Omit<
    TestWorldFinding,
    'id' | 'odontogramId' | 'patientId' | 'recordedAt' | 'sessionId'
  >[] = [];

  const push = (
    toothNumber: number,
    surface: ToothSurface | null,
    condition: ToothCondition,
    state: 'pendiente' | 'completado',
  ): void => {
    const key = `${String(toothNumber)}|${surface ?? 'completa'}|${condition}`;
    if (used.has(key)) return;
    // El generador arma la boca como el servicio: sin parejas imposibles. Así no nace
    // una caries sobre una pieza ausente ni un implante con extracción indicada
    // (spec anexo ADR 0032 §3), que el servidor rechazaría.
    const vigentes = porPieza.get(toothNumber) ?? [];
    if (vigentes.some((otra) => conditionsConflict(otra, condition))) return;
    used.add(key);
    vigentes.push(condition);
    porPieza.set(toothNumber, vigentes);
    findings.push({ toothNumber, surface, condition, state });
  };

  const pickTeeth = (count: number): number[] => rng.shuffle(quadrantTeeth).slice(0, count);

  switch (patient.profile) {
    case 'sano':
      // Boca sana: alguna restauración antigua como mucho.
      if (patient.age >= 18 && rng.bool(0.4)) {
        const [tooth] = pickTeeth(1);
        if (tooth !== undefined) push(tooth, rng.pick(surfaces), 'restauracion', 'completado');
      }
      break;
    case 'pediatrico':
      for (const tooth of pickTeeth(rng.int(1, 3)))
        push(tooth, rng.pick(surfaces), 'caries', 'pendiente');
      break;
    case 'caries_multiple':
      // La caries solo existe `pendiente` (spec anexo ADR 0032 §2): lo que se trató es
      // una restauración, y esa sí puede ir completada.
      for (const tooth of pickTeeth(rng.int(4, 6)))
        push(tooth, rng.pick(surfaces), 'caries', 'pendiente');
      for (const tooth of pickTeeth(rng.int(1, 3)))
        push(tooth, rng.pick(surfaces), 'restauracion', 'completado');
      break;
    case 'periodontal':
      for (const tooth of pickTeeth(rng.int(1, 3)))
        push(tooth, rng.pick(surfaces), 'caries', 'pendiente');
      for (const tooth of pickTeeth(rng.int(2, 3)))
        push(tooth, rng.pick(surfaces), 'restauracion', 'completado');
      break;
    case 'edentulo_parcial': {
      // La pérdida de una pieza es tan pronto congénita como quirúrgica: el generador
      // reparte `ausente` y `extraida` para que el reporte de salud bucal vea las dos.
      for (const tooth of pickTeeth(rng.int(3, 5)))
        push(tooth, null, rng.bool(0.5) ? 'extraida' : 'ausente', 'completado');
      for (const tooth of pickTeeth(rng.int(1, 2))) push(tooth, null, 'corona', 'completado');
      for (const tooth of pickTeeth(rng.int(1, 2)))
        push(tooth, rng.pick(surfaces), 'caries', 'pendiente');
      break;
    }
    default:
      // Crónicos (diabetes, hipertensión, alergias, anticoagulado): boca con
      // hallazgos suficientes para que el reporte de salud bucal los cuente.
      for (const tooth of pickTeeth(rng.int(1, 3)))
        push(tooth, rng.pick(surfaces), 'caries', 'pendiente');
      for (const tooth of pickTeeth(rng.int(1, 2)))
        push(tooth, rng.pick(surfaces), 'restauracion', 'completado');
      break;
  }

  // Las piezas que se trataron en la sesión tienen que estar en la boca: si el
  // perfil no las marcó, se añade una restauración (lo que se hizo ese día).
  for (const tooth of session.teeth) {
    if (findings.some((finding) => finding.toothNumber === tooth)) continue;
    push(tooth, rng.pick(surfaces), 'restauracion', 'completado');
  }

  return findings;
};

/**
 * Construye el mundo completo. Es una función pura: la misma semilla y el mismo
 * ancla dan exactamente el mismo resultado en cualquier máquina.
 */
export const buildTestWorld = (options: TestWorldOptions = {}): TestWorld => {
  const now = options.now ?? new Date();
  const anchor = options.anchor ?? defaultAnchor(now);
  const reference = iso(now);
  const rng = createRng(`${TEST_MODE_SEED}:${anchor}`);

  const patients: TestWorldPatient[] = [];
  const requests: TestWorldRequest[] = [];
  const appointments: TestWorldAppointment[] = [];
  const records: TestWorldRecord[] = [];
  const sessions: TestWorldSession[] = [];
  const prescriptions: TestWorldPrescription[] = [];
  const findings: TestWorldFinding[] = [];
  const capacities: TestWorldCapacity[] = [];

  const pacientesUsados: TestWorldPatient[] = [];
  let ticketCursor = FICTITIOUS_SEQUENCE_MIN;
  let prescriptionCursor = FICTITIOUS_SEQUENCE_MIN;

  // --- 1. Pacientes --------------------------------------------------------
  const nombresFemeninos = rng.shuffle(NAMES_FEMENINE);
  const nombresMasculinos = rng.shuffle(NAMES_MASCULINE);
  let femenino = 0;
  let masculino = 0;

  PLAN.forEach((slot, index) => {
    const sex: Sex = (index % 5 === 2 || index % 5 === 3 ? 'M' : 'F') as Sex;
    const fullName =
      sex === 'M'
        ? (nombresMasculinos[masculino++ % nombresMasculinos.length] ?? 'Paciente de prueba')
        : (nombresFemeninos[femenino++ % nombresFemeninos.length] ?? 'Paciente de prueba');
    const birthDate = birthDateFor(rng, anchor, slot.band);
    const age = ageAt(birthDate, anchor);
    const docNumber = fictitiousDocument(index);
    const docType: DocType = index % 11 === 10 ? 'E' : 'V';
    const phone = `+5841${String(rng.int(2, 6))}${String(rng.int(1_000_000, 9_999_999))}`;
    const isMinor = age < 18;
    const role = slot.role;
    const status: PatientStatus =
      role === 'en_espera' ? 'en_espera_cita' : role === 'no_asistio' ? 'en_espera_cita' : 'activo';

    patients.push({
      id: deterministicUuid('patient', docNumber),
      index,
      docType,
      docNumber,
      document: formatDocument(docType, docNumber),
      fullName: `${fullName}${index % 7 === 3 ? ' (ficticio)' : ''}`,
      birthDate,
      age,
      sex,
      phone,
      phoneAlt: rng.bool(0.3) ? `+5821${String(rng.int(2_000_000, 9_999_999))}` : null,
      email: rng.bool(0.35) ? `paciente${String(90_000_000 + index)}@ejemplo.test` : null,
      address: rng.pick(ADDRESSES),
      occupation: isMinor ? 'Estudiante' : rng.pick(OCCUPATIONS),
      status,
      isFictitious: true,
      registeredAt: iso(
        clinicInstant(
          previousWorkday(anchor, rng.int(2, 120)),
          `${String(rng.int(8, 15)).padStart(2, '0')}:${rng.pick(['05', '20', '35', '50'])}`,
        ),
      ),
      role,
      profile: slot.profile,
      visits: slot.visits,
      guardian: isMinor
        ? {
            fullName: `Representante de ${fullName}`,
            docType: 'V',
            docNumber: String(80_000_000 + index),
            relationship: rng.pick(['Madre', 'Padre', 'Abuela', 'Tía'] as const),
            phone,
          }
        : null,
    });
  });

  pacientesUsados.push(...patients);

  // --- 2. Solicitudes y citas ---------------------------------------------
  const motivo = (patient: TestWorldPatient, control: boolean): string => {
    if (control) return rng.pick(REASONS_CONTROL);
    if (patient.age <= 12) return rng.pick(REASONS_CHILD);
    return rng.pick(REASONS_ADULT);
  };

  const usados = new Set<string>();
  const franjaLibre = (date: string, preferida?: string): string => {
    if (preferida !== undefined && !usados.has(`${date}|${preferida}`)) {
      usados.add(`${date}|${preferida}`);
      return preferida;
    }
    const libres = CLINIC_SLOTS.filter((slot) => !usados.has(`${date}|${slot}`));
    const elegida = libres[0] ?? CLINIC_SLOTS[0] ?? '08:00';
    usados.add(`${date}|${elegida}`);
    return elegida;
  };

  const nuevaSolicitud = (
    patient: TestWorldPatient,
    requestedAt: string,
    reason: string,
    status: AppointmentStatus,
  ): TestWorldRequest => {
    ticketCursor += 1;
    const request: TestWorldRequest = {
      id: deterministicUuid('request', `${String(ticketCursor)}`),
      ticketNumber: ticketCursor,
      patientId: patient.id,
      patientName: patient.fullName,
      patientDocument: patient.document,
      patientPhone: patient.phone,
      channel: rng.weighted<Channel>([
        { value: 'telegram', weight: 5 },
        { value: 'presencial', weight: 3 },
        { value: 'telefono', weight: 2 },
        { value: 'registro', weight: 2 },
        { value: 'whatsapp', weight: 1 },
      ]),
      reason,
      priority: rng.bool(0.15) ? rng.int(1, 3) : 0,
      status,
      requestedAt,
      notes: 'MODO TEST: solicitud ficticia (ADR 0020)',
    };
    requests.push(request);
    return request;
  };

  /** Crea la cita de una solicitud con su ciclo completo hasta el estado pedido. */
  const nuevaCita = (input: {
    patient: TestWorldPatient;
    request: TestWorldRequest;
    date: string;
    startTime: string;
    status:
      | 'atendido'
      | 'no_asistio'
      | 'programada'
      | 'notificada'
      | 'confirmada'
      | 'en_sala_espera'
      | 'en_consulta'
      | 'cancelada'
      | 'reprogramada';
    control?: boolean;
    rescheduledFromId?: string;
  }): TestWorldAppointment => {
    const startTime = franjaLibre(input.date, input.startTime);
    const endTime = addMinutes(startTime, 30);
    const inicio = clinicInstant(input.date, startTime).getTime();
    // La cita se programa después de la solicitud y el aviso, antes de la cita.
    const scheduledAt = addHoursToIso(input.request.requestedAt, rng.int(2, 20));
    const notifiedAt = addHoursToIso(scheduledAt, rng.int(1, 12));
    const base: TestWorldAppointment = {
      id: deterministicUuid('appointment', `${input.patient.docNumber}:${input.date}:${startTime}`),
      requestId: input.request.id,
      patientId: input.patient.id,
      patientName: input.patient.fullName,
      patientDocument: input.patient.document,
      patientPhone: input.patient.phone,
      date: input.date,
      startTime,
      endTime,
      durationMinutes: 30,
      slotKind: 'franja',
      status: 'programada',
      scheduledAt,
      notifiedAt: null,
      confirmedAt: null,
      checkedInAt: null,
      calledAt: null,
      startedAt: null,
      finishedAt: null,
      noShowAt: null,
      cancelledAt: null,
      rescheduledAt: null,
      rescheduledFromId: input.rescheduledFromId ?? null,
      callCount: 0,
      clinicalSessionId: null,
      noShowReason: null,
      cancelReason: null,
      notes: 'MODO TEST: cita ficticia (ADR 0020)',
    };

    const enFecha = (minutesBefore: number): string =>
      clinicIso(input.date, addMinutes(startTime, -minutesBefore));

    if (
      input.status !== 'programada' &&
      input.status !== 'cancelada' &&
      input.status !== 'reprogramada'
    ) {
      base.notifiedAt =
        new Date(notifiedAt).getTime() > inicio - 3_600_000
          ? addHoursToIso(clinicIso(input.date, startTime), -18)
          : notifiedAt;
    }

    /**
     * Confirmación del paciente (ADR 0052), derivada **sin gastar aleatoriedad**:
     * un `rng.int` de más movería la secuencia del generador y cambiaría todos los
     * datos del mundo (y con ellos lo que afirman las pruebas). Cinco horas después
     * del aviso y, si eso no cabría, una hora antes de la cita.
     */
    const confirmadoEn = (): string | null => {
      if (base.notifiedAt === null) return null;
      const cincoDespues = new Date(addHoursToIso(base.notifiedAt, 5)).getTime();
      return iso(new Date(Math.min(cincoDespues, inicio - 3_600_000)));
    };

    switch (input.status) {
      case 'atendido': {
        base.status = 'atendido';
        base.confirmedAt = confirmadoEn();
        base.checkedInAt = enFecha(12);
        base.calledAt = enFecha(4);
        base.startedAt = enFecha(-2);
        base.finishedAt = clinicIso(input.date, addMinutes(startTime, 35));
        break;
      }
      case 'no_asistio': {
        base.status = 'no_asistio';
        base.noShowAt = clinicIso(input.date, addMinutes(startTime, 20));
        base.noShowReason = rng.pick(NO_SHOW_REASONS);
        break;
      }
      case 'en_sala_espera': {
        base.status = 'en_sala_espera';
        base.confirmedAt = confirmadoEn();
        base.checkedInAt = enFecha(8);
        break;
      }
      case 'en_consulta': {
        base.status = 'en_consulta';
        base.confirmedAt = confirmadoEn();
        base.checkedInAt = enFecha(20);
        base.calledAt = enFecha(12);
        base.callCount = 1;
        base.startedAt = enFecha(6);
        break;
      }
      case 'notificada': {
        base.status = 'notificada';
        break;
      }
      case 'confirmada': {
        base.status = 'confirmada';
        base.confirmedAt = confirmadoEn();
        break;
      }
      case 'cancelada': {
        base.status = 'cancelada';
        base.cancelledAt = addHoursToIso(scheduledAt, rng.int(2, 30));
        base.cancelReason = rng.pick(CANCEL_REASONS);
        break;
      }
      case 'reprogramada': {
        base.status = 'reprogramada';
        base.rescheduledAt = addHoursToIso(scheduledAt, rng.int(4, 40));
        break;
      }
      default: {
        base.status = 'programada';
      }
    }

    appointments.push(base);
    if (
      input.request.status === 'en_espera_cita' &&
      base.status !== 'cancelada' &&
      base.status !== 'reprogramada'
    ) {
      input.request.status = 'programada';
    }
    if (base.status === 'cancelada') {
      // Cancelar devuelve la solicitud a la cola (decisión del ADR 0028).
      input.request.status = 'en_espera_cita';
    }
    return base;
  };

  const atendidos = patients.filter((patient) => patient.role === 'atendido');
  const noAsistencias = patients.filter((patient) => patient.role === 'no_asistio');
  const enSala = patients.filter((patient) => patient.role === 'en_sala');
  const hoy = patients.filter((patient) => patient.role === 'hoy');
  const enEspera = patients.filter((patient) => patient.role === 'en_espera');

  // 2a. Citas atendidas en días anteriores (26 en total, con una segunda visita
  //     más reciente para los pacientes que la tienen planificada).
  let hueco = 1;
  for (const patient of atendidos) {
    const visitas = patient.visits === 0 ? 1 : patient.visits;
    // La segunda visita es siempre más reciente que la primera: las sesiones se
    // numeran por paciente en orden cronológico.
    const diasAtras = visitas === 2 ? [rng.int(21, 55), rng.int(2, 12)] : [rng.int(3, 55)];

    diasAtras.forEach((offset, visita) => {
      const date = previousWorkday(anchor, offset);
      const startTime = CLINIC_SLOTS[(hueco * 3) % CLINIC_SLOTS.length] ?? '08:00';
      hueco += 1;
      const control = visita > 0;
      const request = nuevaSolicitud(
        patient,
        addHoursToIso(clinicIso(date, '08:00'), -24 * rng.int(2, 25)),
        motivo(patient, control),
        'en_espera_cita',
      );
      nuevaCita({ patient, request, date, startTime, status: 'atendido', control });
    });
  }

  // 2b. Inasistencias: quedan en la cola, sin historia clínica.
  noAsistencias.forEach((patient, index) => {
    const date = previousWorkday(anchor, 1 + index);
    const request = nuevaSolicitud(
      patient,
      addHoursToIso(clinicIso(date, '08:00'), -24 * rng.int(2, 15)),
      motivo(patient, false),
      'en_espera_cita',
    );
    nuevaCita({
      patient,
      request,
      date,
      startTime: CLINIC_SLOTS[4 + index] ?? '10:00',
      status: 'no_asistio',
    });
  });

  // 2c. Dos cancelaciones (la solicitud vuelve a la cola) y una reprogramación
  //     con su cita nueva el día de hoy.
  const cancelados = enEspera.slice(0, 2);
  cancelados.forEach((patient, index) => {
    const date = previousWorkday(anchor, 3 + index);
    const request = nuevaSolicitud(
      patient,
      addHoursToIso(clinicIso(date, '08:00'), -24 * rng.int(3, 12)),
      motivo(patient, false),
      'en_espera_cita',
    );
    nuevaCita({
      patient,
      request,
      date,
      startTime: CLINIC_SLOTS[6 + index] ?? '11:00',
      status: 'cancelada',
    });
  });

  const reprogramado = enEspera[2];
  if (reprogramado !== undefined) {
    const date = previousWorkday(anchor, 4);
    const request = nuevaSolicitud(
      reprogramado,
      addHoursToIso(clinicIso(date, '08:00'), -24 * rng.int(4, 10)),
      motivo(reprogramado, false),
      'en_espera_cita',
    );
    const vieja = nuevaCita({
      patient: reprogramado,
      request,
      date,
      startTime: CLINIC_SLOTS[9] ?? '13:30',
      status: 'reprogramada',
    });
    const nuevaFecha = nextWorkday(anchor, 0);
    nuevaCita({
      patient: reprogramado,
      request,
      date: nuevaFecha,
      startTime: CLINIC_SLOTS[12] ?? '15:00',
      status: 'programada',
      rescheduledFromId: vieja.id,
    });
  }

  // 2d. La jornada de hoy: dos pacientes en sala/consultorio y el resto
  //     programados (incluida la cita reprogramada).
  const hoyIso = anchor;
  enSala.forEach((patient, index) => {
    const request = nuevaSolicitud(
      patient,
      addHoursToIso(clinicIso(hoyIso, '07:00'), -24 * 10),
      motivo(patient, false),
      'en_espera_cita',
    );
    nuevaCita({
      patient,
      request,
      date: hoyIso,
      startTime: CLINIC_SLOTS[1 + index * 2] ?? '08:30',
      status: index === 0 ? 'en_sala_espera' : 'en_consulta',
    });
  });

  hoy.forEach((patient, index) => {
    const request = nuevaSolicitud(
      patient,
      addHoursToIso(clinicIso(hoyIso, '07:00'), -24 * rng.int(1, 6)),
      motivo(patient, false),
      'en_espera_cita',
    );
    nuevaCita({
      patient,
      request,
      date: hoyIso,
      startTime: CLINIC_SLOTS[5 + index * 2] ?? '10:30',
      // Un tercio de la jornada de hoy en cada estado: así el mundo ejercita la
      // cita confirmada (ADR 0052) además de la avisada y la recién programada.
      status: index % 3 === 0 ? 'confirmada' : index % 3 === 1 ? 'notificada' : 'programada',
    });
  });

  // 2e. Solicitudes todavía en la cola, sin cita: las que no se usaron arriba
  //     más un par de controles de pacientes ya atendidos.
  const enCola = [...enEspera.slice(3), ...atendidos.slice(0, 1)];
  enCola.forEach((patient, index) => {
    const requestedAt = addHoursToIso(clinicIso(hoyIso, '07:00'), -rng.int(2, 96) + index);
    nuevaSolicitud(patient, requestedAt, motivo(patient, true), 'en_espera_cita');
  });

  /**
   * El estado del paciente se deduce de su agenda: quien tiene una cita queda
   * `activo` (el servicio lo promueve solo al programarla) y quien sigue en la
   * cola, `en_espera_cita`. Se fija aquí para que `seed:verify` no vea cambiar el
   * dato cuando el consumidor de pacientes procese los eventos.
   */
  for (const patient of patients) {
    patient.status = appointments.some((appointment) => appointment.patientId === patient.id)
      ? 'activo'
      : 'en_espera_cita';
  }

  // --- 3. Cupos de la jornada (plantillas del consultorio) -----------------
  for (let offset = -10; offset <= 5; offset += 1) {
    const date = addDays(anchor, offset);
    if (!isWorkday(date)) continue;
    const capacidad = weekdayOf(date) === 5 ? 12 : 16;
    capacities.push({
      date,
      capacity: capacidad,
      notes: capacidad === 12 ? 'MODO TEST: viernes con jornada corta' : null,
    });
  }

  // --- 4. Historias, sesiones, récipes y odontogramas ----------------------
  const citasAtendidas = appointments
    .filter((appointment) => appointment.status === 'atendido')
    .sort((left, right) => (left.date < right.date ? -1 : left.date > right.date ? 1 : 0));

  const sesionesPorPaciente = new Map<string, number>();
  /** Claves naturales de hallazgos ya registrados, por paciente. */
  const clavesDeHallazgos = new Map<string, Set<string>>();

  for (const appointment of citasAtendidas) {
    const patient = patients.find((item) => item.id === appointment.patientId);
    if (patient === undefined) continue;

    const solicitud = requests.find((item) => item.id === appointment.requestId);
    const sessionNumber = (sesionesPorPaciente.get(patient.id) ?? 0) + 1;
    sesionesPorPaciente.set(patient.id, sessionNumber);

    const recordId = deterministicUuid('record', patient.docNumber);
    let record = records.find((item) => item.id === recordId);
    if (record === undefined) {
      const sections = buildRecordSections({
        profile: patient.profile,
        sex: patient.sex,
        age: patient.age,
        reason: solicitud?.reason ?? 'Consulta odontológica de prueba',
        fullName: patient.fullName,
      });
      record = {
        id: recordId,
        patientId: patient.id,
        status: 'firmada',
        sections,
        alertCodes: clinicalAlerts(sections).map((alert) => alert.code),
        createdAt: addMinutesToIso(appointment.startedAt ?? appointment.scheduledAt, -20),
        signedAt: addMinutesToIso(appointment.finishedAt ?? appointment.scheduledAt, 15),
        consentRegisteredAt: addMinutesToIso(
          appointment.checkedInAt ?? appointment.scheduledAt,
          10,
        ),
      };
      records.push(record);
    }

    const teeth = rng
      .shuffle(
        patient.age <= 12 ? [54, 55, 64, 65, 74, 75, 84, 85] : [16, 26, 36, 46, 11, 21, 37, 47],
      )
      .slice(0, rng.int(1, 2));
    const sessionId = deterministicUuid('session', `${patient.docNumber}:${String(sessionNumber)}`);
    const content = buildSessionContent({
      profile: patient.profile,
      reason: rng.pick(REASONS_CONTROL),
      teeth,
      sessionNumber,
    });
    const session: TestWorldSession = {
      id: sessionId,
      recordId,
      patientId: patient.id,
      appointmentId: appointment.id,
      sessionNumber,
      status: 'cerrada',
      content,
      procedureCodes: content.procedimientos.map((procedimiento) => procedimiento.code),
      openedAt: appointment.startedAt ?? appointment.scheduledAt,
      closedAt: appointment.finishedAt ?? appointment.scheduledAt,
      teeth: [...teeth],
    };
    sessions.push(session);
    appointment.clinicalSessionId = sessionId;

    // El odontograma se marca dentro de la sesión (Fase 7). Un mismo hallazgo
    // (pieza, cara y condición) no se repite entre visitas: la segunda vez sería
    // una actualización, y aquí el mundo solo registra la primera.
    const yaRegistrados = clavesDeHallazgos.get(patient.id) ?? new Set<string>();
    clavesDeHallazgos.set(patient.id, yaRegistrados);

    for (const finding of findingsFor(rng, patient, session)) {
      const claveNatural = `${String(finding.toothNumber)}|${finding.surface ?? 'completa'}|${finding.condition}`;
      if (yaRegistrados.has(claveNatural)) continue;
      yaRegistrados.add(claveNatural);

      findings.push({
        ...finding,
        id: deterministicUuid(
          'finding',
          `${patient.docNumber}:${String(finding.toothNumber)}:${finding.surface ?? 'completa'}:${finding.condition}`,
        ),
        odontogramId: deterministicUuid('odontogram', patient.docNumber),
        patientId: patient.id,
        recordedAt: addMinutesToIso(session.closedAt, -rng.int(1, 10)),
        sessionId,
      });
    }

    // Récipe: solo cuando el perfil lo justifica (el contenido lo decide el
    // módulo de contenido clínico, que conoce los medicamentos del catálogo).
    const catalogo = MEDICATION_CATALOG.map((nombre) => ({
      name: nombre,
      presentations: [],
      routes: [],
    }));
    const receta = buildPrescription({
      profile: patient.profile,
      reason: rng.pick(REASONS_CONTROL),
      teeth,
      medications: catalogo,
    });
    if (receta !== null) {
      prescriptionCursor += 1;
      prescriptions.push({
        id: deterministicUuid('prescription', `${patient.docNumber}:${String(sessionNumber)}`),
        sessionId,
        patientId: patient.id,
        number: prescriptionCursor,
        verifyCode: deterministicUuid('verify', `${patient.docNumber}:${String(sessionNumber)}`)
          .replace(/-/g, '')
          .slice(0, 10)
          .toUpperCase(),
        issuedAt: addMinutesToIso(session.closedAt, 20),
        generalInstructions: receta.generalInstructions,
        items: receta.items.map((item) => ({ ...item })),
      });
    }
  }

  // --- 5. Facturación: tasas, aranceles, facturas, cobros y la nota de crédito ---
  //     Va al final a propósito: factura las sesiones que acaban de construirse, con
  //     su propio generador derivado de la semilla.
  const billing = buildBillingWorld({ anchor, patients, sessions });

  return {
    seed: TEST_MODE_SEED,
    anchor,
    reference,
    patients,
    requests,
    appointments,
    capacities,
    records,
    sessions,
    prescriptions,
    findings,
    billing,
    totals: {
      patients: patients.length,
      requests: requests.length,
      appointments: appointments.length,
      attended: appointments.filter((appointment) => appointment.status === 'atendido').length,
      noShows: appointments.filter((appointment) => appointment.status === 'no_asistio').length,
      today: appointments.filter((appointment) => appointment.date === anchor).length,
      records: records.length,
      sessions: sessions.length,
      prescriptions: prescriptions.length,
      findings: findings.length,
      rates: billing.rates.length,
      aranceles: billing.aranceles.length,
      invoices: billing.invoices.length,
      drafts: billing.invoices.filter((invoice) => invoice.status === 'borrador').length,
      payments: billing.invoices.reduce((suma, invoice) => suma + invoice.payments.length, 0),
      creditNotes: billing.invoices.filter((invoice) => invoice.creditNote !== null).length,
    },
  };
};

/**
 * Nombres del catálogo de medicamentos que siembra la migración de `clinical`
 * (Fase 7). El seed no lo toca: solo elige de aquí para que los récipes apunten a
 * medicamentos que existen.
 */
export const MEDICATION_CATALOG: readonly string[] = [
  'Amoxicilina',
  'Amoxicilina + ácido clavulánico',
  'Azitromicina',
  'Clindamicina',
  'Metronidazol',
  'Doxiciclina',
  'Ibuprofeno',
  'Naproxeno',
  'Ketoprofeno',
  'Diclofenaco',
  'Celecoxib',
  'Ketorolaco',
  'Paracetamol',
  'Metamizol',
  'Tramadol',
  'Dexametasona',
  'Prednisona',
  'Clorhexidina',
  'Nistatina',
  'Povidona yodada',
  'Fluoruro de sodio',
  'Lidocaína 2 % con epinefrina',
  'Mepivacaína 3 %',
  'Articaína 4 % con epinefrina',
  'Benzocaína gel 20 %',
];

/** Secciones obligatorias para firmar (espejo de `CLINICAL_SIGNATURE_SECTIONS`). */
export const REQUIRED_SECTIONS: readonly ClinicalSectionKey[] = CLINICAL_SECTION_KEYS.filter(
  (key) =>
    (
      [
        'motivo_consulta',
        'anamnesis',
        'examen_extraoral',
        'examen_intraoral',
        'diagnostico',
        'plan_tratamiento',
      ] as readonly string[]
    ).includes(key),
);
