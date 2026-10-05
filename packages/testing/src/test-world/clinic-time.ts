/**
 * Tiempo del consultorio para el modo test.
 *
 * La zona es fija (`America/Caracas`, UTC−4 todo el año, plan §16). Se calcula
 * con el desplazamiento explícito en lugar de con la zona del proceso para que el
 * mundo generado sea **idéntico en cualquier máquina**, tenga la `TZ` que tenga.
 */
export const CLINIC_TIME_ZONE = 'America/Caracas';
export const CLINIC_UTC_OFFSET = '-04:00';
const OFFSET_MS = 4 * 60 * 60 * 1000;

/** Día del consultorio (`YYYY-MM-DD`) al que pertenece un instante. */
export const clinicDate = (instant: Date): string =>
  new Date(instant.getTime() - OFFSET_MS).toISOString().slice(0, 10);

/** Instante real de una fecha y hora del consultorio. */
export const clinicInstant = (date: string, time = '00:00'): Date =>
  new Date(`${date}T${time.length === 5 ? `${time}:00` : time}${CLINIC_UTC_OFFSET}`);

/** Suma (o resta) días a una fecha `YYYY-MM-DD`. */
export const addDays = (date: string, days: number): string => {
  const base = new Date(`${date}T12:00:00Z`);
  base.setUTCDate(base.getUTCDate() + days);
  return base.toISOString().slice(0, 10);
};

/** Día de la semana (0 = domingo … 6 = sábado). */
export const weekdayOf = (date: string): number => new Date(`${date}T12:00:00Z`).getUTCDay();

/** El consultorio trabaja de lunes a viernes (plan §16). */
export const isWorkday = (date: string): boolean => {
  const weekday = weekdayOf(date);
  return weekday >= 1 && weekday <= 5;
};

/** Fecha laborable `offset` días laborables hacia atrás (0 = la más reciente). */
export const previousWorkday = (date: string, offset = 0): string => {
  let current = date;
  let remaining = offset;
  while (remaining > 0 || !isWorkday(current)) {
    current = addDays(current, -1);
    if (isWorkday(current)) remaining -= 1;
  }
  return current;
};

/** Fecha laborable `offset` días laborables hacia adelante (0 = la más próxima). */
export const nextWorkday = (date: string, offset = 0): string => {
  let current = date;
  let remaining = offset;
  while (remaining > 0 || !isWorkday(current)) {
    current = addDays(current, 1);
    if (isWorkday(current)) remaining -= 1;
  }
  return current;
};

/** Hora `HH:MM` a partir de los minutos desde la medianoche. */
export const clinicTime = (minutesFromMidnight: number): string => {
  const hours = Math.floor(minutesFromMidnight / 60);
  const minutes = minutesFromMidnight % 60;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
};

/** Suma minutos a una hora `HH:MM`. */
export const addMinutes = (time: string, minutes: number): string => {
  const [hours = '0', mins = '0'] = time.split(':');
  return clinicTime(Number(hours) * 60 + Number(mins) + minutes);
};

/**
 * Rejilla de franjas del consultorio (plan §16 y plantillas de `scheduling`):
 * de 08:00 a 12:00 y de 13:00 a 17:00, en franjas de 30 minutos → 16 al día.
 */
export const CLINIC_SLOTS: readonly string[] = [
  ...Array.from({ length: 8 }, (_, index) => clinicTime(8 * 60 + index * 30)),
  ...Array.from({ length: 8 }, (_, index) => clinicTime(13 * 60 + index * 30)),
];

/** Edad cumplida en una fecha, calculada en UTC (hallazgo de la Fase 2). */
export const ageAt = (birthDate: string, at: string): number => {
  const birth = new Date(`${birthDate}T00:00:00Z`);
  const reference = new Date(`${at}T00:00:00Z`);
  let age = reference.getUTCFullYear() - birth.getUTCFullYear();
  const monthDiff = reference.getUTCMonth() - birth.getUTCMonth();
  if (monthDiff < 0 || (monthDiff === 0 && reference.getUTCDate() < birth.getUTCDate())) age -= 1;
  return age;
};
