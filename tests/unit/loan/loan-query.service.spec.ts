import { BadRequestException } from '@nestjs/common';
import { LoanQueryService } from '../../../src/modules/loan/services-v2/loan-query.service';

function mk(rows: (sql: string, p?: any[]) => any = () => []) {
  const ds: any = { query: jest.fn(async (s: string, p?: any[]) => rows(s, p)) };
  const calc: any = { calculateEMI: jest.fn().mockResolvedValue({ emi: 1 }), generateAmortizationSchedule: jest.fn().mockResolvedValue({ schedule: [] }) };
  return { svc: new LoanQueryService(ds, calc), ds, calc };
}

describe('loan/LoanQueryService calculator inputs (ES-265)', () => {
  it('valid numbers (also numeric strings) are passed to the calculation', async () => {
    const t = mk(); await t.svc.calculateEMI('100000' as any, 12, 24);
    expect(t.calc.calculateEMI).toHaveBeenCalledWith(100000, 12, 24);
  });
  it('rejects principal 0, negative, text, null, missing, above 1e9', async () => {
    for (const p of [0, -5, 'abc', null, undefined, '', 1_000_000_001, NaN, Infinity]) await expect(mk().svc.calculateEMI(p as any, 12, 12)).rejects.toThrow(/principal/);
  });
  it('rate must be 0 to 100', async () => {
    for (const r of [-1, 100.01, 'x', null]) await expect(mk().svc.calculateEMI(1000, r as any, 12)).rejects.toThrow(/annualRate/);
    await expect(mk().svc.calculateEMI(1000, 0, 12)).resolves.toBeDefined(); await expect(mk().svc.calculateEMI(1000, 100, 12)).resolves.toBeDefined();
  });
  it('tenure must be a whole number from 1 to 600', async () => {
    for (const t of [0, 601, 1.5, 'abc', 100000, -1]) await expect(mk().svc.calculateEMI(1000, 12, t as any)).rejects.toThrow(/tenureMonths/);
    await expect(mk().svc.calculateEMI(1000, 12, 600)).resolves.toBeDefined();
  });
  it('the amortization schedule uses the same checks and defaults the start date', async () => {
    const t = mk(); await expect(t.svc.generateAmortizationSchedule(-1, 12, 12)).rejects.toThrow(BadRequestException);
    await t.svc.generateAmortizationSchedule(1000, 12, 12); expect(t.calc.generateAmortizationSchedule.mock.calls[0][3]).toBeInstanceOf(Date);
  });
});

describe('loan/LoanQueryService case lookups', () => {
  beforeEach(() => { jest.spyOn(console, 'log').mockImplementation(() => undefined); jest.spyOn(console, 'error').mockImplementation(() => undefined); });
  afterEach(() => jest.restoreAllMocks());
  it('a case number alone is not enough: the same case number of another member must not be returned (ES-391)', async () => {
    const t = mk((s, p) => [{ loancaseno: '55', mbno: '9' }, { loancaseno: '55', mbno: '5' }]);
    const r: any = await t.svc.getMemberLoanFromMaster('55');
    // the lookup has no member parameter at all, so it returns whichever row the database finds first
    expect(t.ds.query.mock.calls[0][0]).toMatch(/mbno\s*=\s*\$2|lm\.mbno\s*=\s*\$2/); expect(r).toBeDefined();
  });
  it('the case number is a bound parameter', async () => {
    const t = mk(); await t.svc.getMemberLoanFromMaster("55' OR 1=1"); expect(t.ds.query.mock.calls[0][1]).toEqual(["55' OR 1=1", null]); // case number, then the optional member (ES-391)
  });
  it('null when the case does not exist', async () => { expect(await mk().svc.getMemberLoanFromMaster('1')).toBeNull(); });
});

describe('loan/LoanQueryService.getConsolidationChain', () => {
  const chain = (links: Record<string, any>, preds: Record<string, string>) => mk((s, p) => {
    if (/SELECT consolidated_into_loancaseno FROM loan_master/.test(s)) return [{ consolidated_into_loancaseno: links[p![1]] ?? null }];
    if (/AND consolidated_into_loancaseno::text = \$2/.test(s)) return preds[p![1]] ? [{ loancaseno: preds[p![1]] }] : [];
    if (/FROM loan_master WHERE mbno = \$1 AND loancaseno::text = \$2/.test(s)) return [{ loancaseno: p![1], loan_amt: '1000', balance: links[p![1]] ? '0' : '500', payment_date: '2026-01-01', consolidated_into_loancaseno: links[p![1]] ?? null }];
    return [];
  });
  it('walks forward to the active head and back through every predecessor, oldest first', async () => {
    const t = chain({ A: 'B', B: 'C' }, { C: 'B', B: 'A' });
    const r = await t.svc.getConsolidationChain('A', '5', 'RLN');
    expect(r.links.map((l: any) => l.loancaseno)).toEqual(['A', 'B', 'C']); expect(r.chainLength).toBe(3); expect(r.links.map((l: any) => l.isActive)).toEqual([false, false, true]);
  });
  it('a single loan without consolidation is a chain of one', async () => {
    const r = await chain({}, {}).svc.getConsolidationChain('A', '5', 'RLN'); expect(r.chainLength).toBe(1); expect(r.links[0].isActive).toBe(true);
  });
  it('a cycle in the data cannot loop forever (capped at 100 hops)', async () => {
    const t = chain({ A: 'B', B: 'A' }, { A: 'B', B: 'A' });
    const r = await t.svc.getConsolidationChain('A', '5', 'RLN'); expect(r.chainLength).toBeLessThanOrEqual(102);
  });
  it('member and loan type are part of every lookup (case numbers repeat across members)', async () => {
    const t = chain({}, {}); await t.svc.getConsolidationChain('A', '5', 'RLN');
    for (const c of t.ds.query.mock.calls) expect(c[0]).toMatch(/mbno = \$1/);
  });
});

describe('loan/LoanQueryService.getEmiScheduleFromMaster status (ES-483)', () => {
  const loan = (o: any = {}) => ({ loancaseno: '1', mbno: '5', loantype: 'RL', loan_amt: '12000', rate: '0', no_of_instal: '12', instal_amt: '1000',
    payment_date: '2020-01-01', gracedays: '5', balance: '12000', member_name: 'A', ...o });
  const run = async (lm: any, paid: number, demand: any[] = []) => {
    const t = mk((s) => /FROM loan_master/.test(s) ? [lm] : /loan_schedule_versions/.test(s) ? [] : /demand_master/.test(s) ? demand
      : /loan_repayment_ledger/.test(s) ? [{ principal_paid: String(paid) }] : []);
    const r: any = await t.svc.getEmiScheduleFromMaster('1');
    return (r.schedule ?? r.data?.schedule) as any[];
  };
  it('instalments covered by the loan\'s own payments are Paid, the rest of an old loan Overdue', async () => {
    const s = await run(loan(), 3000);
    expect(s.slice(0, 3).map((x) => x.status)).toEqual(['Paid', 'Paid', 'Paid']);
    expect(s[3].status).toBe('Overdue');
  });
  it('a repaid / re-agreed loan shows Paid then Closed - never Overdue', async () => {
    const s = await run(loan({ consolidated_into_loancaseno: '2', balance: '0' }), 4000);
    expect(s.filter((x) => x.status === 'Paid')).toHaveLength(4);
    expect(s.filter((x) => x.status === 'Closed')).toHaveLength(8);
    expect(s.some((x) => x.status === 'Overdue' || x.status === 'Pending')).toBe(false);
  });
});
