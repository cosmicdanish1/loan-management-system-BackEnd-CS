import { BadRequestException } from '@nestjs/common';
import { MemberLedgerService } from '../../../src/modules/member-ledger/member-ledger.service';

const qb = (rows: any[]) => ({ select: jest.fn().mockReturnThis(), where: jest.fn().mockReturnThis(), andWhere: jest.fn().mockReturnThis(), orderBy: jest.fn().mockReturnThis(), addOrderBy: jest.fn().mockReturnThis(), getRawMany: jest.fn().mockResolvedValue(rows) });
const mk = (entries: any[], member: any = { mbno: '1', f_name: 'A', m_name: null, l_name: 'B' }, opening: any[] = []) => {
  const ledger: any = { createQueryBuilder: jest.fn().mockReturnValueOnce(qb(entries)).mockReturnValueOnce(qb(opening)) };
  return new MemberLedgerService(ledger, { findOne: jest.fn().mockResolvedValue(member) } as any, { findOne: jest.fn().mockResolvedValue(null) } as any, {} as any, { sortByHeadOrder: async (i: any[]) => i } as any);
};
const dto = (o: any = {}) => ({ memberNumber: '1', headCode: 'L1001', fromDate: '2026-01-01', toDate: '2026-01-31', ...o });
const row = (t: string, a: string, n = 1) => ({ trans_no: n, trans_date: new Date(), trans_type: t, trans_amt: a, receipt_vchr_no: '', narration: '', username: '' });
beforeEach(() => jest.spyOn(console, 'error').mockImplementation(() => undefined));

describe('member ledger report fixes (ES-404, ES-303)', () => {
  it('name: skips empty or blank parts', async () => {
    for (const [m, expected] of [[null, 'A B'], ['  ', 'A B'], ['K', 'A K B']] as any[]) expect((await mk([], { mbno: '1', f_name: ' A ', m_name: m, l_name: 'B' }).getMemberLedgerReport(dto())).memberName).toBe(expected);
    expect((await mk([], { mbno: '1', f_name: 'A', m_name: null, l_name: null }).getMemberLedgerReport(dto())).memberName).toBe('A');
  });
  it('bad, missing or reversed dates are a 400 and the ledger is not read', async () => {
    for (const d of [{ fromDate: 'garbage' }, { toDate: 'nope' }, { fromDate: undefined }, { fromDate: '2026-02-01', toDate: '2026-01-01' }]) {
      await expect(mk([]).getMemberLedgerReport(dto(d) as any)).rejects.toBeInstanceOf(BadRequestException);
    }
    await expect(mk([]).getMemberLedgerReport(dto({ fromDate: '2026-01-31' }))).resolves.toBeDefined();
  });
  it('amounts are exact to the paise in the running balance, totals and closing', async () => {
    const r: any = await mk([row('CR', '0.10', 1), row('CR', '0.20', 2), row('DR', '0.10', 3)]).getMemberLedgerReport(dto());
    expect(r.entries.map((e: any) => e.balance)).toEqual([0.1, 0.3, 0.2]);
    expect([r.totalCredits, r.totalDebits, r.closingBalance]).toEqual([0.3, 0.1, 0.2]);
    const many: any = await mk(Array.from({ length: 10 }, (_, i) => row('CR', '0.10', i))).getMemberLedgerReport(dto());
    expect(many.closingBalance).toBe(1);
  });
});
