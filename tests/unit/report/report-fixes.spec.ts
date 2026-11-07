import { BadRequestException, NotFoundException } from '@nestjs/common';
import { DividendReportsService } from '../../../src/modules/report/services-v2/dividend-reports.service';
import { LoanReportsService } from '../../../src/modules/report/services-v2/loan-reports.service';
import { MemberReportsService } from '../../../src/modules/report/services-v2/member-reports.service';
import { CashBookReportsService } from '../../../src/modules/report/services-v2/cash-book-reports.service';
import { UtilityReportsService } from '../../../src/modules/report/services-v2/utility-reports.service';
import { isRealDate, isDebitType, isCreditType, DEBIT_TYPES_SQL, CREDIT_TYPES_SQL } from '../../../src/modules/report/services-v2/ledger-types';

function ds(routes: Array<[RegExp, any]> = []) {
  const calls: Array<{ sql: string; params: any[] }> = [];
  const query = jest.fn(async (sql: string, params: any[] = []) => {
    calls.push({ sql, params });
    for (const [re, rows] of routes) if (re.test(sql)) return typeof rows === 'function' ? rows(sql, params) : rows;
    return /COUNT/i.test(sql) ? [{ count: '0' }] : [];
  });
  return { query, calls } as any;
}

describe('report fixes: validation (ES-328, ES-303, ES-370)', () => {
  describe('dividend rate', () => {
    const run = (rate: any) => { const d = ds(); return { d, p: new DividendReportsService(d).getDividendReport({ year: 2026, dividendRate: rate }) }; };
    it('0 to 100 is accepted, including the edges and a number sent as text', async () => {
      for (const r of [0, 0.5, 10, 100, '12', '99.5']) await expect(run(r).p).resolves.toBeDefined();
    });
    it('negative, above 100, not a number and Infinity are refused and nothing is queried', async () => {
      for (const r of [-0.01, 100.01, 250, 'abc', NaN, Infinity, -Infinity]) {
        const { d, p } = run(r);
        await expect(p).rejects.toBeInstanceOf(BadRequestException);
        expect(d.query).not.toHaveBeenCalled();
      }
    });
    it('no rate means the default of 10', async () => {
      const d = ds(); await new DividendReportsService(d).getDividendReport({ year: 2026 });
      expect(d.calls.some((c: any) => c.params.includes(10))).toBe(true);
    });
  });

  describe('new loans disbursed dates', () => {
    const run = (dto: any) => { const d = ds(); return { d, p: new LoanReportsService(d, {} as any).getNewLoanDisbursed(dto) }; };
    it('real dates (also ISO timestamps) are accepted', async () => {
      await expect(run({ fromDate: '2026-04-01', toDate: '2027-03-31' }).p).resolves.toBeDefined();
      await expect(run({ fromDate: '2026-04-01T00:00:00.000Z', toDate: '2026-04-01T23:59:59.000Z' }).p).resolves.toBeDefined();
      await expect(run({ fromDate: '2028-02-29', toDate: '2028-02-29' }).p).resolves.toBeDefined();
    });
    it('text, impossible dates, empty and missing values are refused and nothing is queried', async () => {
      for (const bad of ['invalid-date', '2026-02-30', '2027-02-29', '2026-13-01', '01-04-2026', '', undefined, null, 20260401]) {
        const { d, p } = run({ fromDate: bad, toDate: '2026-12-31' });
        await expect(p).rejects.toBeInstanceOf(BadRequestException);
        expect(d.query).not.toHaveBeenCalled();
      }
      await expect(run({ fromDate: '2026-04-01', toDate: 'nope' }).p).rejects.toBeInstanceOf(BadRequestException);
    });
    it('from after to is refused; the same day is fine', async () => {
      await expect(run({ fromDate: '2026-05-02', toDate: '2026-05-01' }).p).rejects.toThrow(/cannot be after/);
      await expect(run({ fromDate: '2026-05-01', toDate: '2026-05-01' }).p).resolves.toBeDefined();
    });
  });

  describe('member profile and statement', () => {
    const profileRow = { mbno: '1001', full_name: 'Asha', share_balance: '1', isactive: 'Y' };
    it('an unknown member is a 404 for both reports', async () => {
      await expect(new MemberReportsService(ds()).getMemberProfile({ memberNo: '9999' })).rejects.toBeInstanceOf(NotFoundException);
      await expect(new MemberReportsService(ds()).getMemberStatement({ memberNo: '9999' })).rejects.toBeInstanceOf(NotFoundException);
    });
    it('an empty, blank, missing or non-text member number is a 400 and the database is not asked', async () => {
      for (const bad of ['', '   ', undefined, null, 5]) {
        const d = ds();
        await expect(new MemberReportsService(d).getMemberProfile({ memberNo: bad as any })).rejects.toBeInstanceOf(BadRequestException);
        expect(d.query).not.toHaveBeenCalled();
      }
    });
    it('the member number is trimmed and bound as a parameter', async () => {
      const d = ds([[/FROM member_master m/, [profileRow]]]);
      await new MemberReportsService(d).getMemberProfile({ memberNo: " 1001'; DROP TABLE x;-- " });
      expect(d.calls[0].sql).not.toContain('DROP TABLE');
      expect(d.calls[0].params[0]).toBe("1001'; DROP TABLE x;--");
    });
    it('statement row keys continue from the offset and start at 0 without one', async () => {
      const rows = [{ date: 'a', type: 'CR', amount: '1' }, { date: 'b', type: 'CR', amount: '2' }];
      const mk = () => ds([[/FROM member_master m/, [{ mbno: '1', member_name: 'A' }]], [/FROM ledger\s+WHERE mbno/, rows]]);
      expect((await new MemberReportsService(mk()).getMemberStatement({ memberNo: '1', limit: 2, offset: 40 }) as any).transactions.map((t: any) => t.key)).toEqual(['40', '41']);
      expect((await new MemberReportsService(mk()).getMemberStatement({ memberNo: '1' }) as any).transactions.map((t: any) => t.key)).toEqual(['0', '1']);
    });
  });

  describe('balance range', () => {
    const run = (min: any, max: any) => { const d = ds(); return { d, p: new MemberReportsService(d).getMemberBalanceRangeReport({ minBalance: min, maxBalance: max }) }; };
    it('min above max is a 400 and nothing is queried; equal values and numbers sent as text work', async () => {
      const bad = run(10, 5);
      await expect(bad.p).rejects.toThrow(/cannot be greater/);
      expect(bad.d.query).not.toHaveBeenCalled();
      await expect(run(5, 5).p).resolves.toBeDefined();
      await expect(run('0', '1000').p).resolves.toBeDefined();
      await expect(run(-100, 100).p).resolves.toBeDefined();
    });
    it('values that are not numbers are refused', async () => {
      for (const [a, b] of [['abc', 5], [1, 'x'], [NaN, 1], [undefined, 1], [1, Infinity]]) await expect(run(a, b).p).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('detail ledger head code', () => {
    it('missing, empty, blank or non-text head codes are a 400 and nothing is queried', async () => {
      for (const bad of ['', '   ', undefined, null, 5]) {
        const d = ds();
        await expect(new CashBookReportsService(d).getDetailLedger({ head_code: bad as any, from_date: '2026-09-01', to_date: '2026-09-30' })).rejects.toBeInstanceOf(BadRequestException);
        expect(d.query).not.toHaveBeenCalled();
      }
    });
  });
});

describe('report fixes: legacy R / P ledger rows are read like CR / DR everywhere (ES-424)', () => {
  it('helpers: R is a credit, P is a debit, nothing else is either', () => {
    expect(['CR', 'R'].every(isCreditType)).toBe(true);
    expect(['DR', 'P'].every(isDebitType)).toBe(true);
    for (const t of ['CR', 'R']) expect(isDebitType(t)).toBe(false);
    for (const t of ['DR', 'P']) expect(isCreditType(t)).toBe(false);
    for (const t of [undefined, null, '', 'X', 'cr', 'r']) { expect(isDebitType(t)).toBe(false); expect(isCreditType(t)).toBe(false); }
    expect(DEBIT_TYPES_SQL).toBe("('DR', 'P')");
    expect(CREDIT_TYPES_SQL).toBe("('CR', 'R')");
  });
  it('isRealDate knows leap years and rejects impossible dates', () => {
    for (const ok of ['2028-02-29', '2026-12-31', '2026-01-01T10:00:00Z', '2026-01-01 10:00:00']) expect(isRealDate(ok)).toBe(true);
    for (const bad of ['2026-02-29', '2100-02-29', '2026-04-31', '2026-00-10', '2026-1-1', 'x', '', 20260101 as any, null as any]) expect(isRealDate(bad)).toBe(false);
    expect(isRealDate(new Date('2026-05-05'))).toBe(true);
  });
  it('daily cash book: P is a payment and R a receipt on each voucher, and totals follow', async () => {
    const d = ds([[/FROM ledger l/, [
      { voucher_no: 'V1', member_no: '1', trans_type: 'R', amount: '500', head_code: 'A1', head_name: 'H' },
      { voucher_no: 'V1', member_no: '1', trans_type: 'P', amount: '200', head_code: 'A2', head_name: 'H2' },
      { voucher_no: 'V2', member_no: '2', trans_type: 'CR', amount: '50', head_code: 'A1', head_name: 'H' },
      { voucher_no: 'V2', member_no: '2', trans_type: 'DR', amount: '30', head_code: 'A2', head_name: 'H2' },
    ]]]);
    const r: any = await new CashBookReportsService(d).getCashBookDaily('2026-09-05');
    expect(r.vouchers.map((v: any) => [v.totalReceipt, v.totalPayment])).toEqual([[500, 200], [50, 30]]);
  });
  it('the cash balance SQL (opening and the day) counts R/P with CR/DR', async () => {
    const d = ds(); await new CashBookReportsService(d).getCashBookDaily('2026-09-05');
    const sql = d.calls.map((c: any) => c.sql).join('\n');
    expect(sql).toContain(`trans_type IN ${DEBIT_TYPES_SQL}`);
    expect(sql).toContain(`trans_type IN ${CREDIT_TYPES_SQL}`);
    expect(sql).not.toMatch(/trans_type = 'DR'|trans_type = 'CR'/);
  });
  it('detail ledger and bank ledger: opening-balance SQL and row sides use the same rule', async () => {
    const d = ds([[/SELECT head_name/, [{ head_name: 'X' }]], [/ORDER BY trans_date ASC, trans_no ASC/, [{ trans_date: 'a', trans_type: 'P', amount: '40' }, { trans_date: 'b', trans_type: 'R', amount: '10' }]]]);
    const cb = new CashBookReportsService(d);
    const det: any = await cb.getDetailLedger({ head_code: 'H1', from_date: '2026-09-01', to_date: '2026-09-30' });
    expect(det.transactions.map((t: any) => [t.debit, t.credit])).toEqual([[40, 0], [0, 10]]);
    const bank: any = await cb.getBankDetailLedger({ bank_head_code: 'B1', from_date: '2026-09-01', to_date: '2026-09-30' });
    expect(bank.transactions.map((t: any) => [t.debit, t.credit])).toEqual([[40, 0], [0, 10]]);
    const sql = d.calls.map((c: any) => c.sql).join('\n');
    expect(sql).not.toMatch(/trans_type = 'DR'|trans_type = 'CR'/);
  });
  it('member ledger running balance: R adds, P subtracts, CR adds, DR subtracts, unknown types change nothing', async () => {
    const d = ds([[/FROM ledger l/, [
      { transDate: 'a', transType: 'R', transAmt: '100' }, { transDate: 'b', transType: 'P', transAmt: '30' },
      { transDate: 'c', transType: 'CR', transAmt: '5' }, { transDate: 'd', transType: 'DR', transAmt: '1' }, { transDate: 'e', transType: 'X', transAmt: '999' },
    ]]]);
    const r: any = await new MemberReportsService(d).getMemberLedger({ memberNo: '1', fromDate: '2026-09-01', toDate: '2026-09-30' });
    expect(r.map((x: any) => x.runningBalance)).toEqual(['100.00', '70.00', '75.00', '74.00', '74.00']);
  });
  it('financial summary SQL reads CR/R as credit and DR/P as debit in opening, period and closing', async () => {
    const d = ds([[/FROM\s+headmaster h/, []]]);
    await new UtilityReportsService(d).getFinancialSummary({ fromDate: '2026-04-01', toDate: '2026-09-30', includeOpBal: true, hideZeroClosing: false, hideZeroTrans: false } as any);
    const sql = d.calls[0].sql;
    expect((sql.match(/IN \('CR', 'R'\)/g) || []).length).toBe(3);
    expect((sql.match(/IN \('DR', 'P'\)/g) || []).length).toBe(3);
    expect(sql).not.toMatch(/trans_type = 'DR'|trans_type = 'CR'/);
  });
});
