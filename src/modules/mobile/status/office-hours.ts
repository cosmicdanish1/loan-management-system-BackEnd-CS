import { MOBILE_OFFICE_TZ } from '../mobile.constants';

export interface OfficeState {
  /** Local office date-time parts (Asia/Kolkata) the decision was made on. */
  localTime: string; // HH:mm
  isoWeekday: number; // 1 = Monday ... 7 = Sunday
  isOfficeDay: boolean;
  isOpen: boolean;
}

const WEEKDAYS: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

const toMinutes = (hhmm: string): number | null => {
  const m = /^(\d{1,2}):(\d{2})$/.exec((hhmm || '').trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  return h > 23 || min > 59 ? null : h * 60 + min;
};

/** Parses "1,2,3,4,5,6" into ISO weekday numbers; ignores junk. */
export function parseOfficeDays(value: string): number[] {
  return (value || '')
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n >= 1 && n <= 7);
}

/**
 * Is the society office open at `now`? Always evaluated in the office time zone (Asia/Kolkata), never in the server's
 * zone, so a PC with the wrong time zone gives the same answer (earlier modules had opposite time-zone bugs).
 * Bad or missing settings fall back to 10:00-18:00, Monday to Saturday.
 */
export function officeStateAt(now: Date, open: string, close: string, days: number[]): OfficeState {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: MOBILE_OFFICE_TZ,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  const isoWeekday = WEEKDAYS[get('weekday')] ?? 1;
  const hh = get('hour').padStart(2, '0');
  const mm = get('minute').padStart(2, '0');
  const minutes = Number(hh) * 60 + Number(mm);

  const openMin = toMinutes(open) ?? 10 * 60;
  const closeMin = toMinutes(close) ?? 18 * 60;
  const officeDays = days.length ? days : [1, 2, 3, 4, 5, 6];
  const isOfficeDay = officeDays.includes(isoWeekday);

  return {
    localTime: `${hh}:${mm}`,
    isoWeekday,
    isOfficeDay,
    isOpen: isOfficeDay && minutes >= openMin && minutes < closeMin,
  };
}
