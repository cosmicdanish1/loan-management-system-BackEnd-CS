/** Plain-language input checks for the Society Calculator endpoints (clear 400 message, never NaN / 500). */
import { BadRequestException } from '@nestjs/common';
import { parseYmd } from './common';

export type Body = Record<string, any>;
const fail = (msg: string): never => { throw new BadRequestException(msg); };

export function reqNum(b: Body, key: string, label: string, min = 0, max = 999_999_999.99, minExclusive = false): number {
  const raw = b?.[key];
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN;
  if (!Number.isFinite(n)) return fail(`${label} must be a number.`);
  if (minExclusive ? n <= min : n < min) return fail(`${label} must be ${minExclusive ? 'greater than' : 'at least'} ${min}.`);
  if (n > max) return fail(`${label} can be at most ${max}.`);
  return n;
}
export function optNum(b: Body, key: string, label: string, dflt: number, min = 0, max = 999_999_999.99): number {
  const raw = b?.[key];
  if (raw === undefined || raw === null || raw === '') return dflt;
  return reqNum(b, key, label, min, max);
}
export function reqInt(b: Body, key: string, label: string, min: number, max: number): number {
  const n = reqNum(b, key, label, min, max);
  return Number.isInteger(n) ? n : fail(`${label} must be a whole number.`);
}
export function optInt(b: Body, key: string, label: string, dflt: number, min: number, max: number): number {
  const raw = b?.[key];
  if (raw === undefined || raw === null || raw === '') return dflt;
  return reqInt(b, key, label, min, max);
}
export function reqDate(b: Body, key: string, label: string): Date { return parseYmd(String(b?.[key] ?? ''), label); }
export function optDate(b: Body, key: string, label: string): Date | undefined {
  const raw = b?.[key];
  return raw === undefined || raw === null || raw === '' ? undefined : parseYmd(String(raw), label);
}
export function oneOf<T extends string>(b: Body, key: string, label: string, allowed: readonly T[], dflt?: T): T {
  const raw = b?.[key];
  if ((raw === undefined || raw === null || raw === '') && dflt !== undefined) return dflt;
  return (allowed as readonly string[]).includes(String(raw)) ? (raw as T) : fail(`${label} must be one of: ${allowed.join(', ')}.`);
}
export function list(b: Body, key: string, label: string, max = 500): any[] {
  const raw = b?.[key];
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) return fail(`${label} must be a list.`);
  if (raw.length > max) return fail(`${label} can have at most ${max} rows.`);
  return raw;
}
