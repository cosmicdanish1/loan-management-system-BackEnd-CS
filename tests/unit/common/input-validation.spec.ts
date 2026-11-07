import { BadRequestException, NotFoundException } from '@nestjs/common';
import { UtilitiesService } from '../../../src/modules/utilities/utilities.service';
import { parseBusinessDate } from '../../../src/modules/shared/utils/date-utils';
import { GlobalExceptionFilter } from '../../../src/common/filters/global-exception.filter';
import { DividendCalculationService } from '../../../src/modules/dividend/services/dividend-calculation.service';

// ES-300 / ES-302 / ES-303 / ES-313 / ES-317 / ES-328 / ES-357: bad input is refused with a reason before anything is written.

describe('parseBusinessDate', () => {
  it('accepts a normal date, a DD-MM-YYYY date and empty (= today)', () => {
    expect(parseBusinessDate('2026-03-15').getDate()).toBe(15);
    expect(parseBusinessDate('15-03-2026').getMonth()).toBe(2);
    expect(parseBusinessDate(undefined).getFullYear()).toBe(new Date().getFullYear());
  });
  it('refuses text that is not a date, with a message a user can act on', () => {
    expect(() => parseBusinessDate('yesterday', 'Voucher date')).toThrow("Voucher date 'yesterday' is not a valid date");
    expect(() => parseBusinessDate('31-02-2026', 'Voucher date')).toThrow(BadRequestException);
  });
  it('refuses a date far in the future or before 1950', () => {
    expect(() => parseBusinessDate('2099-01-01', 'Transfer date')).toThrow('Transfer date cannot be more than 31 days in the future');
    expect(() => parseBusinessDate('1900-01-01', 'Transfer date')).toThrow('cannot be before 1950');
  });
  it('allows a date a few days ahead', () => {
    const d = new Date(); d.setDate(d.getDate() + 5);
    const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    expect(() => parseBusinessDate(iso)).not.toThrow();
  });
});

function transferService(queryRows: Record<string, any[]> = {}) {
  const calls: string[] = [];
  const qr: any = {
    connect: jest.fn(), startTransaction: jest.fn(), commitTransaction: jest.fn(), rollbackTransaction: jest.fn(), release: jest.fn(),
    query: jest.fn(async (sql: string) => {
      calls.push(sql);
      if (/FROM member_master/.test(sql)) return queryRows.members ?? [{ mbno: '1001' }, { mbno: '1002' }];
      if (/MAX\(trans_no\)/.test(sql)) return [{ next_trans_no: 10, next_ledger_id: 20 }];
      return [];
    }),
  };
  const ds: any = { createQueryRunner: () => qr, query: jest.fn() };
  return { svc: new UtilitiesService(ds, {} as any, {} as any), qr, calls };
}
const good = { fromAccount: '1001', toAccount: '1002', amount: 100, transferDate: '2026-11-01', description: 'x' };

describe('UtilitiesService.processBalanceTransfer (ES-357)', () => {
  it.each([
    ['amount 0', { amount: 0 }, 'greater than 0'],
    ['negative amount', { amount: -100 }, 'greater than 0'],
    ['text amount', { amount: 'abc' }, 'greater than 0'],
    ['more than 2 decimals', { amount: 10.123 }, '2 decimal'],
    ['huge amount', { amount: 1e12 }, 'cannot be more than'],
    ['same account', { toAccount: '1001' }, 'cannot be the same'],
    ['account not digits', { fromAccount: 'abc' }, 'member number'],
    ['bad date', { transferDate: 'not a date' }, 'not a valid date'],
    ['future date', { transferDate: '2099-01-01' }, 'future'],
  ])('%s is a 400 and writes nothing', async (_n, patch, text) => {
    const { svc, calls } = transferService();
    await expect(svc.processBalanceTransfer({ ...good, ...(patch as any) })).rejects.toThrow(text as string);
    expect(calls.some(c => /INSERT INTO ledger/.test(c))).toBe(false);
  });

  it('a to-account that is not a member is a 400 and writes nothing', async () => {
    const { svc, calls } = transferService({ members: [{ mbno: '1001' }] });
    await expect(svc.processBalanceTransfer(good)).rejects.toThrow('To account 1002 is not a member');
    expect(calls.some(c => /INSERT INTO ledger/.test(c))).toBe(false);
  });

  it('a valid transfer posts one DR and one CR under the ledger lock', async () => {
    const { svc, calls, qr } = transferService();
    const r = await svc.processBalanceTransfer(good);
    expect(r.success).toBe(true);
    expect(calls.filter(c => /INSERT INTO ledger/.test(c))).toHaveLength(2);
    expect(calls.some(c => /pg_advisory_xact_lock/.test(c))).toBe(true);
    expect(qr.commitTransaction).toHaveBeenCalled();
  });
});

describe('UtilitiesService.saveSavingTransaction (ES-302)', () => {
  const base = { accountNo: '213', transDate: '2026-11-01', transactionType: 'deposit' as const, amount: 10, paymentMode: 'cash' as const, narration: 'n' };
  const mk = (balance: string | null) => {
    const calls: Array<[string, any[]]> = [];
    const qr: any = {
      connect: jest.fn(), startTransaction: jest.fn(), commitTransaction: jest.fn(), rollbackTransaction: jest.fn(), release: jest.fn(),
      query: jest.fn(async (sql: string, p: any[]) => {
        calls.push([sql, p]);
        if (/FROM sbmaster/.test(sql)) return balance === null ? [] : [{ acc_no: '213', mbno: '5', balance }];
        if (/MAX\(trans_no\)/.test(sql)) return [{ next_trans_no: 1, next_ledger_id: 1 }];
        if (/voucher_master/.test(sql)) return [{ last: 'R00001' }];
        return [];
      }),
    };
    return { svc: new UtilitiesService({ createQueryRunner: () => qr, query: jest.fn() } as any, {} as any, {} as any), calls, qr };
  };

  it.each([
    ['no account', { accountNo: '' }, 'Account number is required'],
    ['amount 0', { amount: 0 }, 'greater than 0'],
    ['negative amount', { amount: -5 }, 'greater than 0'],
    ['3 decimals', { amount: 1.234 }, '2 decimal'],
    ['unknown type', { transactionType: 'BANANA' }, "'deposit' or 'withdrawal'"],
    ['unknown mode', { paymentMode: 'cheque' }, "'cash' or 'bank'"],
    ['future date', { transDate: '2099-01-01' }, 'future'],
  ])('%s is a 400', async (_n, patch, text) => {
    await expect(mk('100.00').svc.saveSavingTransaction({ ...base, ...(patch as any) })).rejects.toThrow(text as string);
  });

  it('an account that does not exist is a 404', async () => {
    await expect(mk(null).svc.saveSavingTransaction(base)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('a withdrawal above the balance is refused', async () => {
    await expect(mk('5.00').svc.saveSavingTransaction({ ...base, transactionType: 'withdrawal', amount: 10 })).rejects.toThrow('more than the balance');
  });

  it('adds to the balance as a number, not as joined text ("1000.00" + 10 is 1010)', async () => {
    const { svc, calls } = mk('1000.00');
    await svc.saveSavingTransaction(base);
    const update = calls.find(([sql]) => /UPDATE sbmaster SET balance/.test(sql))!;
    expect(update[1][0]).toBe(1010);
  });

  it('writes only columns the ledger has (no cheque_no / cheque_date / bank_name)', async () => {
    const { svc, calls } = mk('1000.00');
    await svc.saveSavingTransaction({ ...base, paymentMode: 'bank', chequeNo: '123456', bankName: 'SBI' });
    const inserts = calls.filter(([sql]) => /INSERT INTO ledger/.test(sql));
    expect(inserts).toHaveLength(2);
    for (const [sql] of inserts) expect(sql).not.toMatch(/\bcheque_no\b|\bcheque_date\b|[^_]bank_name\b/);
    expect(inserts[0][1].join('|')).toContain('Cheque 123456');
  });
});

describe('UtilitiesService.saveDepositLoanSlabs / saveDemandPrintOrder (ES-302)', () => {
  const svc = () => new UtilitiesService({ createQueryRunner: jest.fn(), query: jest.fn() } as any, {} as any, {} as any);
  it('a missing body is a 400, not a TypeError', async () => {
    await expect(svc().saveDepositLoanSlabs(undefined as any, undefined as any)).rejects.toThrow('Slab type is required');
    await expect(svc().saveDepositLoanSlabs(undefined as any, 'RD')).rejects.toThrow('rows must be a list');
    await expect(svc().saveDemandPrintOrder(undefined as any)).rejects.toThrow('rows must be a list');
  });
  it('a bad slab row names the row and the field', async () => {
    await expect(svc().saveDepositLoanSlabs([{ fromAmount: 'abc' }], 'RD')).rejects.toThrow('Row 1: fromAmount');
    await expect(svc().saveDepositLoanSlabs([{ interestRate: 150 }], 'RD')).rejects.toThrow('cannot be more than 100');
    await expect(svc().saveDepositLoanSlabs([{ fromAmount: 500, uptoAmount: 100 }], 'RD')).rejects.toThrow("'Upto amount' is less");
  });
  it('a print-order row needs a head code and a whole print order', async () => {
    await expect(svc().saveDemandPrintOrder([{ printOrder: 1 }])).rejects.toThrow('head code is required');
    await expect(svc().saveDemandPrintOrder([{ headCode: 'A1', printOrder: 'x' }])).rejects.toThrow('print order must be a whole number');
  });
});

describe('DividendCalculationService.commitDividendForYear (ES-328)', () => {
  const mk = (settled: any[]) => {
    const ds: any = {
      query: jest.fn(async (sql: string) => {
        if (/credited_at IS NOT NULL OR is_paid/.test(sql)) return settled;
        return [];
      }),
      createQueryRunner: jest.fn(),
    };
    const svc = new DividendCalculationService(ds);
    jest.spyOn(svc, 'previewDividendForYear').mockResolvedValue({ yearcode: 1, calculationYear: 2026, dividendRatePercent: 12, monthsExpected: 12, members: [] } as any);
    return { svc, ds };
  };
  it('refuses to recalculate a year already credited or paid at another rate', async () => {
    const { svc, ds } = mk([{ dividend_rate: '10.00' }]);
    await expect(svc.commitDividendForYear(1, 12)).rejects.toThrow('already credited or paid at 10%');
    expect(ds.createQueryRunner).not.toHaveBeenCalled();
  });
});

describe('GlobalExceptionFilter hides technical text (ES-302)', () => {
  const run = (err: Error) => {
    const json = jest.fn();
    const res: any = { status: jest.fn(() => ({ json })) };
    const host: any = { switchToHttp: () => ({ getResponse: () => res, getRequest: () => ({ method: 'POST', url: '/x', requestId: 'abc123' }) }) };
    new GlobalExceptionFilter().catch(err, host);
    return json.mock.calls[0][0];
  };
  it.each([
    'Failed to save: null value in column "trans_amt" of relation "ledger" violates not-null constraint',
    "Cannot read properties of undefined (reading 'substring')",
    'rows is not iterable',
    'invalid input syntax for type date: "-1"',
  ])('replaces "%s" with a plain message and a reference', (text) => {
    const body = run(new Error(text));
    expect(body.statusCode).toBe(500);
    expect(body.message).not.toContain('column');
    expect(body.message).not.toContain('properties');
    expect(body.message).toContain('reference abc123');
  });
  it('keeps a readable message from the application', () => {
    expect(run(new Error('Balance transfer could not be saved. Please try again.')).message).toContain('could not be saved');
  });
});
