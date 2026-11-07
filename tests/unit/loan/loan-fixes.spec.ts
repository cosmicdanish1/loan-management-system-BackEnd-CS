import { BadRequestException } from '@nestjs/common';
import { buildReducingBalanceSchedule, round2 } from '../../../src/modules/loan/services-v2/loan-rb-schedule.util';
import { LoanMonthEndService } from '../../../src/modules/loan/services-v2/loan-month-end.service';
import { LoanSanctionService } from '../../../src/modules/loan/services-v2/loan-sanction.service';
import { LoanQueryService } from '../../../src/modules/loan/services-v2/loan-query.service';

describe('reducing balance schedule always adds up (ES-407)', () => {
  it('for many amounts and tenures the principal column equals the loan and the last balance is 0', () => {
    for (const amt of [100, 1000, 99999.99, 100000, 250000.5, 7]) for (const n of [1, 2, 3, 7, 12, 36, 60, 97]) {
      const { schedule } = buildReducingBalanceSchedule(amt, 12, n);
      expect(schedule).toHaveLength(n);
      expect(round2(schedule.reduce((s, r) => s + r.principal, 0))).toBe(round2(amt));
      expect(schedule[n - 1].closingBalance).toBe(0);
      for (const r of schedule) expect(round2(r.openingBalance - r.principal)).toBe(r.closingBalance);
    }
  });
});

describe('loan month-end snapshot input (ES-370)', () => {
  const mk = () => { const qr: any = { connect: jest.fn(), startTransaction: jest.fn(), commitTransaction: jest.fn(), rollbackTransaction: jest.fn(), release: jest.fn(), query: jest.fn(async () => []) }; return { svc: new LoanMonthEndService({ createQueryRunner: () => qr } as any), qr }; };
  it('month 1-12 and year 1900-2100 (also as text) work; anything else is a 400 before a transaction starts', async () => {
    for (const [m, y] of [[1, 1900], [12, 2100], ['3', '2026']]) await expect(mk().svc.captureMonthEndSnapshot(m as any, y as any)).resolves.toMatchObject({ success: true });
    for (const [m, y] of [[13, 2026], [0, 2026], [1.5, 2026], ['x', 2026], [3, 1800], [3, 2101], [3, 'y'], [null, 2026]]) {
      const t = mk(); await expect(t.svc.captureMonthEndSnapshot(m as any, y as any)).rejects.toBeInstanceOf(BadRequestException); expect(t.qr.startTransaction).not.toHaveBeenCalled();
    }
  });
});

describe('loan sanction rules (ES-318)', () => {
  const mk = (pending: any) => { const ds: any = { query: jest.fn(async (sql: string) => (/UPDATE loan_pending/.test(sql) ? [pending] : [pending])) }; return { svc: new LoanSanctionService(ds, { isReagreementCase: jest.fn().mockResolvedValue(false) } as any), ds }; };
  const ok = { loancaseno: 7, mbno: '5', applied_amt: 100000, flg_paid: 'N', disbursed: false };
  const sd = (o: any = {}) => ({ sanctionedAmount: 100000, sanctionDate: '2026-03-15', noOfInstallments: 60, ...o });
  it('sanctioning exactly the applied amount, or less, works', async () => {
    await expect(mk(ok).svc.updateLoanSanction('7', sd())).resolves.toMatchObject({ success: true });
    await expect(mk(ok).svc.updateLoanSanction('7', sd({ sanctionedAmount: '50000.50' }))).resolves.toMatchObject({ success: true });
  });
  it('bad amounts and installments are a 400 and nothing is written', async () => {
    for (const o of [{ sanctionedAmount: 0 }, { sanctionedAmount: -1 }, { sanctionedAmount: 'x' }, { sanctionedAmount: '' }, { sanctionedAmount: 100001 }, { noOfInstallments: 0 }, { noOfInstallments: 1.5 }, { noOfInstallments: 'x' }, { noOfInstallments: 601 }]) {
      const t = mk(ok); await expect(t.svc.updateLoanSanction('7', sd(o))).rejects.toBeInstanceOf(BadRequestException);
      expect(t.ds.query.mock.calls.some((c: any[]) => /UPDATE loan_pending/.test(c[0]))).toBe(false);
    }
  });
  it('a case that is paid out or already has a loan_master row is refused', async () => {
    for (const p of [{ ...ok, flg_paid: 'Y' }, { ...ok, disbursed: true }]) await expect(mk(p).svc.updateLoanSanction('7', sd())).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('loan lookups by case number (ES-391)', () => {
  const mk = (rows: any[]) => { const ds: any = { query: jest.fn(async () => rows) }; return { svc: new LoanQueryService(ds, {} as any), ds }; };
  beforeEach(() => { jest.spyOn(console, 'log').mockImplementation(() => undefined); jest.spyOn(console, 'error').mockImplementation(() => undefined); });
  afterEach(() => jest.restoreAllMocks());
  const two = [{ loancaseno: '55', mbno: '9', loantype: 'RLN' }, { loancaseno: '55', mbno: '5', loantype: 'RLN' }];
  it('without a member an ambiguous case number is not guessed; with one the member is a bound parameter', async () => {
    expect(await mk(two).svc.getMemberLoanFromMaster('55')).toBeNull();
    expect(await mk(two).svc.getMemberLoanFromPending('55')).toBeNull();
    const t = mk([two[1]]); expect(await t.svc.getMemberLoanFromMaster('55', '5')).toMatchObject({ memberNo: '5' });
    expect(t.ds.query.mock.calls[0][1]).toEqual(['55', '5']);
  });
  it('a case that belongs to one member is returned even without a member', async () => {
    expect(await mk([two[0]]).svc.getMemberLoanFromMaster('55')).toMatchObject({ memberNo: '9' });
  });
});

import { ShareMonthEndService } from '../../../src/modules/dividend/services/share-month-end.service';
describe('month-end report endpoints refuse invalid months and years (ES-370)', () => {
  const ds = () => ({ query: jest.fn().mockResolvedValue([]) } as any);
  it.each([[new LoanMonthEndService(ds())], [new ShareMonthEndService(ds())]])('%#: valid values query with bound parameters; 13, 0, 1800, text and decimals are a 400 and nothing is queried', async (svc: any) => {
    await expect(svc.getMonthlyBalanceReport(3, 2026)).resolves.toEqual([]);
    for (const [m, y] of [[13, 2026], [0, 2026], [3, 1800], [3, 2101], ['x', 2026], [3, 'y'], [1.5, 2026], [NaN, 2026]]) {
      const t = ds(); const s: any = svc.constructor === LoanMonthEndService ? new LoanMonthEndService(t) : new ShareMonthEndService(t);
      await expect(s.getMonthlyBalanceReport(m as any, y as any)).rejects.toBeInstanceOf(BadRequestException); expect(t.query).not.toHaveBeenCalled();
    }
  });
});

describe('sanction against the Business Rules card limits (ES-318)', () => {
  const mk = (card: any, type = 'RLN') => {
    const ds: any = { query: jest.fn(async (sql: string) => (/FROM busrules/.test(sql) ? (card instanceof Error ? (() => { throw card; })() : card ? [card] : []) : [{ loancaseno: 7, mbno: '5', loantype: type, applied_amt: 1_000_000, flg_paid: 'N', disbursed: false }])) };
    return { svc: new LoanSanctionService(ds, { isReagreementCase: jest.fn().mockResolvedValue(false) } as any), ds };
  };
  const sd = (o: any = {}) => ({ sanctionedAmount: 400000, sanctionDate: '2026-03-15', noOfInstallments: 60, ...o });
  beforeEach(() => { jest.spyOn(console, 'log').mockImplementation(() => undefined); jest.spyOn(console, 'warn').mockImplementation(() => undefined); jest.spyOn(console, 'error').mockImplementation(() => undefined); });
  afterEach(() => jest.restoreAllMocks());
  it('within the card passes (also exactly at the limit); above the amount or the installments is a 400; the card column follows the loan type', async () => {
    await expect(mk({ max_amt: 500000, max_inst: 60 }).svc.updateLoanSanction('7', sd())).resolves.toMatchObject({ success: true });
    await expect(mk({ max_amt: 400000, max_inst: 60 }).svc.updateLoanSanction('7', sd())).resolves.toMatchObject({ success: true });
    await expect(mk({ max_amt: 300000, max_inst: 60 }).svc.updateLoanSanction('7', sd())).rejects.toThrow(/Business Rules/);
    await expect(mk({ max_amt: 500000, max_inst: 36 }).svc.updateLoanSanction('7', sd())).rejects.toThrow(/installments/);
    const t = mk({ max_amt: 500000, max_inst: 60 }, 'ELN'); await t.svc.updateLoanSanction('7', sd());
    expect(t.ds.query.mock.calls.find((c: any[]) => /FROM busrules/.test(c[0]))![0]).toContain('elnmaxloanamt');
  });
  it('an empty card (0) or a card that cannot be read does not block a sanction; an unknown loan type has no card', async () => {
    await expect(mk({ max_amt: 0, max_inst: 0 }).svc.updateLoanSanction('7', sd())).resolves.toBeDefined();
    await expect(mk(new Error('no column')).svc.updateLoanSanction('7', sd())).resolves.toBeDefined();
    const t = mk({ max_amt: 1 }, 'ZZZ'); await t.svc.updateLoanSanction('7', sd()); expect(t.ds.query.mock.calls.some((c: any[]) => /FROM busrules/.test(c[0]))).toBe(false);
  });
});
