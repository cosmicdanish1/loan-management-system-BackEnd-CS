import { BadRequestException } from '@nestjs/common';
import { RdRepaymentService } from '../../../src/modules/rd/services/rd-repayment.service';
import { RdMemberConfigService } from '../../../src/modules/rd/services/rd-member-config.service';
import { RdBalanceEventsService } from '../../../src/modules/rd/services/rd-balance-events.service';

const repay = (config: any[] = []) => {
  const ds: any = { query: jest.fn(async (sql: string) => (/FROM yearend/.test(sql) ? [{ start_date: '2026-04-01', end_date: '2027-03-31' }] : /FROM rd_member_config/.test(sql) ? config : /FROM member_master/.test(sql) ? [{ mbno: 5 }] : [])) };
  return { svc: new RdRepaymentService(ds), ds };
};
const pay = (t: any, a: any, m: any = 4, y: any = 2026) => t.svc.recordPayment('5', 3, m, y, a, new Date(2026, 3, 10), undefined, 'bob');

describe('RD counter payment checks (ES-353)', () => {
  it('every month of the financial year, also sent as text, is accepted; the ones just outside are refused', async () => {
    for (const [m, y] of [[4, 2026], ['4', '2026'], [12, 2026], [1, 2027], [3, 2027]]) await expect(pay(repay(), 500, m, y)).resolves.toMatchObject({ paidAmount: 500 });
    for (const [m, y] of [[3, 2026], [4, 2027], [13, 2026], [0, 2026], [4, 1999], [4.5, 2026], ['x', 2026]]) await expect(pay(repay(), 500, m, y)).rejects.toBeInstanceOf(BadRequestException);
  });
  it('NaN, Infinity, text, 0, negative and absurd amounts are refused before the database is written', async () => {
    for (const a of [NaN, Infinity, -Infinity, 'abc', 0, -1, 1e12, 10_000_000]) { const t = repay(); await expect(pay(t, a)).rejects.toBeInstanceOf(BadRequestException); expect(t.ds.query.mock.calls.some((c: any[]) => /INSERT INTO rd_installment_ledger/.test(c[0]))).toBe(false); }
  });
  it('up to 10 times the instalment is fine (paying ahead), above that is refused', async () => {
    await expect(pay(repay([{ monthly_rd_amount: '700' }]), 7000)).resolves.toBeDefined();
    await expect(pay(repay([{ monthly_rd_amount: '700' }]), 7000.01)).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('RD monthly amount and balance event amounts (ES-353)', () => {
  const cfg = () => { const ds: any = { query: jest.fn(async (sql: string) => (/FROM member_master/.test(sql) ? [{ mbno: 5 }] : /FROM yearend/.test(sql) ? [{ yearcode: 3 }] : [])) }; return { svc: new RdMemberConfigService(ds, { getRule: jest.fn().mockResolvedValue(100) } as any), ds }; };
  it('NaN, Infinity, 0, negative and 1e12 are refused; a normal amount is stored', async () => {
    for (const a of [NaN, Infinity, 0, -5, 1e12]) { const t = cfg(); await expect(t.svc.setMonthlyAmount('5', 3, a, 'u')).rejects.toBeInstanceOf(BadRequestException); expect(t.ds.query.mock.calls.some((c: any[]) => /INSERT INTO rd_member_config/.test(c[0]))).toBe(false); }
    const ok = cfg(); await ok.svc.setMonthlyAmount('5', 3, 500, 'u'); expect(ok.ds.query.mock.calls.some((c: any[]) => /INSERT INTO rd_member_config/.test(c[0]))).toBe(true);
  });
  it('opening balance: zero, negative, NaN and Infinity are refused with no transaction', async () => {
    for (const a of [0, -100, NaN, Infinity]) { const qr: any = { connect: jest.fn(), startTransaction: jest.fn(), query: jest.fn() }; const svc = new RdBalanceEventsService({ createQueryRunner: () => qr } as any, {} as any); await expect(svc.recordOpeningBalance('5', 3, a, new Date(), 'u')).rejects.toBeInstanceOf(BadRequestException); expect(qr.startTransaction).not.toHaveBeenCalled(); }
  });
});
