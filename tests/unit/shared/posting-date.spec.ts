import { BadRequestException } from '@nestjs/common';
import { assertPostingDateOpen } from '../../../src/modules/shared/utils/posting-date';

// ES-458: no posting on a day-ended day or inside a closed financial year; everything else stays open
describe('shared/assertPostingDateOpen', () => {
  const runnerWith = (closedDay: boolean, closedYear: number | null) => ({
    query: jest.fn(async (sql: string, _params?: any[]) => {
      if (/FROM getworkingdate/.test(sql)) return closedDay ? [{ '?column?': 1 }] : [];
      if (/FROM yearend/.test(sql)) return closedYear === null ? [] : [{ yearcode: closedYear }];
      return [];
    }),
  });

  it('refuses a day that Day-End has closed, with a clear message', async () => {
    const r = runnerWith(true, null);
    await expect(assertPostingDateOpen(r, '2026-08-24')).rejects.toThrow(BadRequestException);
    await expect(assertPostingDateOpen(r, '2026-08-24')).rejects.toThrow(/2026-08-24 is already closed/);
  });
  it('refuses a date inside a closed financial year', async () => {
    const r = runnerWith(false, 3);
    await expect(assertPostingDateOpen(r, new Date(2027, 5, 1))).rejects.toThrow(/financial year 3, which is closed/);
  });
  it('lets an open day and an open year through', async () => {
    const r = runnerWith(false, null);
    await expect(assertPostingDateOpen(r, '2026-11-07')).resolves.toBeUndefined();
  });
  it('a date with no working-date row is open (migrated history and days not reached yet)', async () => {
    const r = runnerWith(false, null);
    await expect(assertPostingDateOpen(r, '2019-03-01')).resolves.toBeUndefined();
    expect(r.query.mock.calls[0][0]).toContain("dayend_flag = 'Y'");
  });
  it('checks the calendar day the Date falls on (local), not its time of day', async () => {
    const r = runnerWith(false, null);
    await assertPostingDateOpen(r, new Date(2026, 7, 24, 23, 59));
    expect(r.query.mock.calls[0][1]).toEqual(['2026-08-24']);
  });
  it('accepts an ISO timestamp text and uses its date part', async () => {
    const r = runnerWith(false, null);
    await assertPostingDateOpen(r, '2026-08-24T05:30:00.000Z');
    expect(r.query.mock.calls[0][1]).toEqual(['2026-08-24']);
  });
  it('does nothing when no date is given (the caller uses the current clock)', async () => {
    const r = runnerWith(true, 1);
    await expect(assertPostingDateOpen(r, undefined)).resolves.toBeUndefined();
    await expect(assertPostingDateOpen(r, null)).resolves.toBeUndefined();
    expect(r.query).not.toHaveBeenCalled();
  });
  it('does not hide a database error (a failed check must stop the posting)', async () => {
    const r = { query: jest.fn().mockRejectedValue(new Error('db down')) };
    await expect(assertPostingDateOpen(r, '2026-08-24')).rejects.toThrow('db down');
  });
});
