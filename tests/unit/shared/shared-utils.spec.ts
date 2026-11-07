import { isDebitNormal, calculateClosingBalance } from '../../../src/modules/shared/utils/balance-direction';
import { parseSafeDate, formatDateForDB } from '../../../src/modules/shared/utils/date-utils';
import { validateDoubleEntry } from '../../../src/modules/shared/utils/ledger-validation';
import { numberToWords } from '../../../src/modules/shared/utils/number-to-words';
import { generateVoucherNo } from '../../../src/modules/shared/utils/voucher-utils';
import { autoQueueNotification } from '../../../src/modules/shared/utils/auto-notify';
import { SequenceGeneratorService } from '../../../src/modules/shared/services/sequence-generator.service';

describe('shared/balance-direction', () => {
  it('A and E are debit normal; L, I, R, empty, null are credit normal', () => {
    for (const f of ['A', 'E', 'a', ' e ']) expect(isDebitNormal(f)).toBe(true);
    for (const f of ['L', 'I', 'R', '', null, undefined]) expect(isDebitNormal(f as any)).toBe(false);
  });
  it('asset closing = opening + debits - credits', () => expect(calculateClosingBalance('A', 100, 50, 30)).toBe(120));
  it('liability closing = opening + credits - debits', () => expect(calculateClosingBalance('L', 100, 50, 30)).toBe(80));
  it('rounds to 2 decimals (no floating point drift)', () => expect(calculateClosingBalance('A', 0.1, 0.2, 0)).toBe(0.3));
  it('can go negative (overdrawn)', () => expect(calculateClosingBalance('A', 0, 0, 10)).toBe(-10));
  it('large crore amounts stay exact to the paisa', () => expect(calculateClosingBalance('L', 666012345.67, 0.01, 0)).toBe(666012345.66));
});

describe('shared/date-utils', () => {
  it('DD-MM-YYYY and DD/MM/YYYY parse as day first', () => {
    expect(formatDateForDB(parseSafeDate('05-03-2026'))).toBe('2026-03-05');
    expect(formatDateForDB(parseSafeDate('5/3/2026'))).toBe('2026-03-05');
  });
  it('ISO strings parse', () => expect(parseSafeDate('2026-03-05T00:00:00').getFullYear()).toBe(2026));
  it('Date objects pass through unchanged', () => { const d = new Date(2020, 1, 1); expect(parseSafeDate(d)).toBe(d); });
  it('an impossible date such as 31-02-2026 is not silently moved to 3 March', () => {
    expect(() => parseSafeDate('31-02-2026')).toThrow(/Invalid date/);
  });
  it('unparseable text must not silently become today (a voucher would be dated today)', () => {
    expect(() => parseSafeDate('not a date')).toThrow(/Invalid date/);
  });
  it('formatDateForDB zero pads', () => expect(formatDateForDB(new Date(2026, 0, 2))).toBe('2026-01-02'));
});

describe('shared/validateDoubleEntry', () => {
  it('balanced entries are valid', () => expect(validateDoubleEntry([{ transType: 'DR', amount: 100 }, { transType: 'CR', amount: 100 }])).toMatchObject({ valid: true, difference: 0 }));
  it('unbalanced entries report the difference', () => expect(validateDoubleEntry([{ transType: 'DR', amount: 100 }, { transType: 'CR', amount: 99.5 }])).toMatchObject({ valid: false, difference: 0.5 }));
  it('floating point sums (0.1 + 0.2 = 0.3) balance', () => expect(validateDoubleEntry([{ transType: 'DR', amount: 0.1 }, { transType: 'DR', amount: 0.2 }, { transType: 'CR', amount: 0.3 }]).valid).toBe(true));
  it('splits across many lines add up', () => expect(validateDoubleEntry([{ transType: 'DR', amount: 100 }, ...Array(3).fill({ transType: 'CR', amount: 33.33 }), { transType: 'CR', amount: 0.01 }]).valid).toBe(true));
  it('a missing amount counts as zero', () => expect(validateDoubleEntry([{ transType: 'DR', amount: undefined as any }]).drTotal).toBe(0));
});

describe('shared/numberToWords (Indian system)', () => {
  const cases: Array<[number, string]> = [
    [1, 'One Only'], [19, 'Nineteen Only'], [21, 'Twenty One Only'], [100, 'One Hundred Only'], [101, 'One Hundred and One Only'],
    [1000, 'One Thousand Only'], [12345, 'Twelve Thousand Three Hundred and Forty Five Only'],
    [100000, 'One Lakh Only'], [10000000, 'One Crore Only'], [123456789, 'Twelve Crore Thirty Four Lakh Fifty Six Thousand Seven Hundred and Eighty Nine Only'],
  ];
  it.each(cases)('%d', (n, words) => expect(numberToWords(n)).toBe(words));
  it('zero is written as Zero', () => expect(numberToWords(0)).toBe('Zero Only'));
  it('amounts of 100 crore or more are not reported as "overflow"', () => expect(numberToWords(1_000_000_000)).not.toBe('overflow'));
  it('a fractional amount (paise) is not turned into an empty string', () => expect(numberToWords(1234.5)).not.toBe(''));
});

describe('shared/generateVoucherNo', () => {
  const runner = (last: string | undefined, used: Set<string> = new Set()) => {
    const calls: any[] = [];
    return {
      calls,
      query: jest.fn(async (sql: string, params?: any[]) => {
        calls.push([sql, params]);
        if (/FROM voucher_master/.test(sql)) return last === undefined ? [] : [{ last }];
        if (/SELECT 1 WHERE EXISTS/.test(sql)) return used.has(params![0]) ? [{ '?column?': 1 }] : [];
        return [];
      }),
    };
  };
  it('increments the highest counter and pads to 5 digits', async () => expect(await generateVoucherNo(runner('P00004'), 'P')).toBe('P00005'));
  it('starts at 00001 when no row exists', async () => expect(await generateVoucherNo(runner(undefined), 'R')).toBe('R00001'));
  it('uses the column of the type', async () => {
    const r = runner('J00009'); await generateVoucherNo(r, 'J');
    expect(r.calls[0][0]).toContain('j_vchr_no');
  });
  it('locks the counter row (FOR UPDATE)', async () => {
    const r = runner('P00001'); await generateVoucherNo(r, 'P');
    expect(r.calls[0][0]).toContain('FOR UPDATE');
  });
  it('skips numbers that already exist in ledger / transactions / vouchers (ES-56)', async () => {
    expect(await generateVoucherNo(runner('R00010', new Set(['R00011', 'R00012'])), 'R')).toBe('R00013');
  });
  it('writes the new counter back', async () => {
    const r = runner('D00001'); await generateVoucherNo(r, 'D');
    const upd = r.calls.find((c) => /UPDATE voucher_master/.test(c[0]));
    expect(upd[1]).toEqual(['D00002']);
  });
  it('rejects an unknown voucher type', async () => {
    await expect(generateVoucherNo(runner('X00001'), 'X' as any)).rejects.toThrow(/Invalid voucher type/);
  });
  it('the number grows past 99999 without breaking', async () => expect(await generateVoucherNo(runner('P99999'), 'P')).toBe('P100000'));
  it('copes with a corrupt counter value (no digits)', async () => expect(await generateVoucherNo(runner('garbage'), 'P')).toBe('P00001'));
});

describe('shared/autoQueueNotification', () => {
  it('queues an SMS to the phone when there is one', async () => {
    const ds: any = { query: jest.fn().mockResolvedValueOnce([{ phone: '9876543210', email: 'a@b.c' }]).mockResolvedValue([]) };
    await autoQueueNotification(ds, '5', 'hello');
    expect(ds.query.mock.calls[1][1]).toEqual(['5', 'SMS', 'TRANSACTION', 'hello', '9876543210']);
  });
  it('falls back to email', async () => {
    const ds: any = { query: jest.fn().mockResolvedValueOnce([{ phone: '', email: 'a@b.c' }]).mockResolvedValue([]) };
    await autoQueueNotification(ds, '5', 'hello');
    expect(ds.query.mock.calls[1][1][1]).toBe('EMAIL');
  });
  it('queues nothing when the member has no phone and no email', async () => {
    const ds: any = { query: jest.fn().mockResolvedValueOnce([{ phone: '', email: '' }]) };
    await autoQueueNotification(ds, '5', 'hello');
    expect(ds.query).toHaveBeenCalledTimes(1);
  });
  it('never throws when the database fails', async () => {
    const ds: any = { query: jest.fn().mockRejectedValue(new Error('x')) };
    await expect(autoQueueNotification(ds, '5', 'hello')).resolves.toBeUndefined();
  });
});

describe('shared/SequenceGeneratorService', () => {
  const mk = (row: any) => {
    const ds: any = { query: jest.fn().mockResolvedValue(row) };
    const repo: any = { findOne: jest.fn().mockResolvedValue(null) };
    return { svc: new SequenceGeneratorService(ds, repo), ds };
  };
  it('member number is 8 digit padded', async () => expect(await mk([{ last_value: '42', prefix: '' }]).svc.generateNextMemberNumber()).toBe('00000042'));
  // the counter query answers with the number; the "is it already used?" query answers from usedNumbers
  const mkCase = (numbers: number[], usedNumbers: number[]) => {
    let i = 0;
    const ds: any = { query: jest.fn(async (sql: string, params: any[]) => {
      if (/sequence_master/.test(sql)) return [{ last_value: String(numbers[i++]) }];
      return usedNumbers.includes(Number(params[0])) ? [{ '?column?': 1 }] : [];
    }) };
    return new SequenceGeneratorService(ds, { findOne: jest.fn() } as any);
  };
  it('loan case number is plain', async () => expect(await mkCase([7], []).generateNextLoanCaseNo()).toBe('7'));
  it('a loan case number that an existing loan already uses is skipped (ES-391)', async () => expect(await mkCase([7, 8, 9], [7, 8]).generateNextLoanCaseNo()).toBe('9'));
  // ES-460: voucher numbers go through an "is it already used?" check; the counter query answers with the number
  const mkVoucher = (numbers: number[], usedNumbers: number[]) => {
    let i = 0;
    const ds: any = { query: jest.fn(async (sql: string, params: any[]) => {
      if (/sequence_master/.test(sql)) return [{ last_value: String(numbers[i++]), prefix: 'VCH' }];
      return usedNumbers.includes(Number(String(params[0]).replace(/\D/g, ''))) ? [{ '?column?': 1 }] : [];
    }) };
    return { svc: new SequenceGeneratorService(ds, { findOne: jest.fn() } as any), ds };
  };
  it('voucher number uses the stored prefix and 3 digit padding', async () => expect(await mkVoucher([5], []).svc.getNextVoucherNumber()).toBe('VCH005'));
  it('a voucher number that already exists is skipped, so the first voucher of a new year does not fail (ES-460)', async () => {
    // the counter restarted at 1 but VCH001..VCH003 are taken
    expect(await mkVoucher([1, 2, 3, 4], [1, 2, 3]).svc.getNextVoucherNumber()).toBe('VCH004');
  });
  it('voucher id is numeric', async () => expect(await mk([{ last_value: '9' }]).svc.getNextVoucherId()).toBe(9));
  it('allocation is a single atomic UPSERT (no read-then-write race)', async () => {
    const { svc, ds } = mk([{ last_value: '1' }]); await svc.getNextVoucherId();
    expect(ds.query.mock.calls[0][0]).toContain('ON CONFLICT (sequence_key) DO UPDATE');
  });
  it('the voucher counter resets yearly', async () => {
    const { svc, ds } = mkVoucher([1], []); await svc.getNextVoucherNumber();
    expect(ds.query.mock.calls[0][1]).toEqual(['VOUCHER_NO', 'VCH', true, new Date().getFullYear()]);
  });
  it('peek does not consume the number', async () => {
    const { svc, ds } = mk([{ last_value: '41' }]);
    expect(await svc.peekNextMemberNumber()).toBe('00000042'); expect(ds.query.mock.calls[0][0]).not.toContain('INSERT');
  });
  it('peek on an empty table starts at 1', async () => expect(await mk([]).svc.peekNextMemberNumber()).toBe('00000001'));
  it('generateSequence applies prefix and padding', async () => expect(await mk([{ last_value: '3' }]).svc.generateSequence('K', 'X-', 4)).toBe('X-0003'));
});
