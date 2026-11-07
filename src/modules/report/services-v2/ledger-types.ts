/**
 * Ledger row types. The migrated ledger holds 'CR' / 'DR' (new) and the legacy 'R' / 'P' side by side.
 * The rest of the application reads 'R' as a credit and 'P' as a debit (member ledger, day book, loan position,
 * deposit reports), so every report uses the same rule (ES-424).
 */
export const DEBIT_TYPES_SQL = "('DR', 'P')";
export const CREDIT_TYPES_SQL = "('CR', 'R')";
export const isDebitType = (t: unknown): boolean => t === 'DR' || t === 'P';
export const isCreditType = (t: unknown): boolean => t === 'CR' || t === 'R';

/** A calendar date as sent by the screens: YYYY-MM-DD (or an ISO timestamp starting with it) that really exists. */
export function isRealDate(value: unknown): boolean {
  if (typeof value !== 'string' && !(value instanceof Date)) return false;
  const text = value instanceof Date ? value.toISOString() : value;
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:$|[T ])/.exec(text.trim());
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}
