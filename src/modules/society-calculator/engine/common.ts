/** Small shared helpers of the Society Calculator engine (pure, no database). */
import { BadRequestException } from '@nestjs/common';

export { round2, applyLoanRounding } from '../../loan/services-v2/loan-rb-schedule.util';

/** 'YYYY-MM-DD' -> local-midnight Date. Throws a plain-language 400 for anything else (incl. 2026-02-31). */
export function parseYmd(value: string, label = 'date'): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value ?? '').trim());
  if (!m) throw new BadRequestException(`${label} must be a date in the form YYYY-MM-DD.`);
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  const date = new Date(y, mo - 1, d);
  if (date.getFullYear() !== y || date.getMonth() !== mo - 1 || date.getDate() !== d) {
    throw new BadRequestException(`${label} is not a real calendar date.`);
  }
  return date;
}

/** Local calendar date as 'YYYY-MM-DD' (never toISOString: that shifts the day in time zones ahead of UTC). */
export function ymd(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export const daysInMonth = (year: number, month0: number): number => new Date(year, month0 + 1, 0).getDate();

/** Whole calendar months from `from` to `to` (day of month ignored). */
export const monthsBetween = (from: Date, to: Date): number =>
  (to.getFullYear() - from.getFullYear()) * 12 + (to.getMonth() - from.getMonth());

/** The bank-style EMI the old Calculator shows. Kept ONLY to show how far it is from the society method. */
export function bankStyleEmi(principal: number, annualRate: number, months: number): number {
  const r = annualRate / 1200;
  if (r === 0) return principal / months;
  const f = Math.pow(1 + r, months);
  return (principal * r * f) / (f - 1);
}
