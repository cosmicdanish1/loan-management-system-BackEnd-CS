/**
 * "Effective to" is a calendar date that the person enters (and the database stores as midnight), and it means
 * "valid up to and including that day" (ES-399). Compare against the END of that day, otherwise a rate that is
 * valid until 31 March already stops at 00:00 on 31 March.
 */
export function endOfEffectiveDay(effectiveTo: Date | string): Date {
  const d = new Date(effectiveTo);
  d.setHours(23, 59, 59, 999);
  return d;
}
