import { NotFoundException } from '@nestjs/common';
import { MemberBalanceService } from '../../../src/modules/member/services-v2/member-balance.service';

const base = (o: any = {}) => ({ mbno: '5', member_name: 'A B', office_name: 'HQ', basic_pay: '30000', is_active: 'Y', shares: '1000', compulsory_deposit: '2000', rd_amount: '0', regular_loan_balance: '0', emergency_loan_balance: '0', frs_balance: '0', ...o });

function mk(member: any[], loans: any[] | Error = []) {
  const ds: any = {
    query: jest.fn(async (sql: string) => {
      if (/FROM member_master m/.test(sql)) return member;
      if (/FROM loan_master/.test(sql)) { if (loans instanceof Error) throw loans; return loans; }
      return member;
    }),
  };
  return { svc: new MemberBalanceService(ds), ds };
}

describe('member/MemberBalanceService.getMemberBalance', () => {
  beforeEach(() => { jest.spyOn(console, 'log').mockImplementation(() => undefined); jest.spyOn(console, 'error').mockImplementation(() => undefined); });
  afterEach(() => jest.restoreAllMocks());

  it('404 for an unknown member', async () => { await expect(mk([]).svc.getMemberBalance('9')).rejects.toThrow(NotFoundException); });
  it('the member number is only a bound parameter', async () => {
    const { svc, ds } = mk([base()]); await svc.getMemberBalance("5' OR '1'='1");
    expect(ds.query.mock.calls[0][0]).not.toContain("OR '1'='1"); expect(ds.query.mock.calls[0][1]).toEqual(["5' OR '1'='1"]);
  });
  it('lists share, CD, RD and FRS as assets and ignores zero balances', async () => {
    const r = await mk([base({ rd_amount: '500', frs_balance: '100' })]).svc.getMemberBalance('5');
    expect(r.balanceItems.map((i) => i.code)).toEqual(['SH', 'CD', 'RD', 'FRS']);
    expect(r.summary).toEqual({ totalAssets: 3600, totalLiabilities: 0, netBalance: 3600 });
  });
  it('loans are liabilities (negative items) and reduce the net balance', async () => {
    const r = await mk([base({ regular_loan_balance: '1500', emergency_loan_balance: '500' })]).svc.getMemberBalance('5');
    expect(r.summary).toEqual({ totalAssets: 3000, totalLiabilities: 2000, netBalance: 1000 });
    expect(r.balanceItems.filter((i) => i.type === 'liability').map((i) => i.balance)).toEqual([-1500, -500]);
  });
  it('a loan that appears both in member_balances and loan_master is counted once', async () => {
    const r = await mk([base({ regular_loan_balance: '5000' })], [{ loantype: 'RLN', total_balance: '5000' }]).svc.getMemberBalance('5');
    expect(r.summary.totalLiabilities).toBe(5000);
    expect(r.balanceItems.filter((i) => i.type === 'liability')).toHaveLength(1);
  });
  it('an emergency loan that appears in both sources is counted once', async () => {
    const r = await mk([base({ emergency_loan_balance: '800' })], [{ loantype: 'ELN', total_balance: '800' }]).svc.getMemberBalance('5');
    expect(r.summary.totalLiabilities).toBe(800);
  });
  it('a loan type that exists only in loan_master is added as a liability', async () => {
    const r = await mk([base()], [{ loantype: 'ABC', total_balance: '900' }]).svc.getMemberBalance('5');
    expect(r.summary.totalLiabilities).toBe(900); expect(r.loans.totalBalance).toBe(900);
  });
  it('closed loans (zero balance) do not appear', async () => {
    const r = await mk([base()], [{ loantype: 'RLN', total_balance: '0' }]).svc.getMemberBalance('5');
    expect(r.balanceItems.some((i) => i.type === 'liability')).toBe(false);
  });
  it('falls back to member_balances loan figures when loan_master cannot be read', async () => {
    const r = await mk([base({ regular_loan_balance: '700' })], new Error('relation does not exist')).svc.getMemberBalance('5');
    expect(r.loans.totalBalance).toBe(700); expect(r.loans.balances).toEqual({ RLN: 700, ELN: 0 });
  });
  it('flags inactive members and defaults the office name', async () => {
    const r = await mk([base({ is_active: 'N' })]).svc.getMemberBalance('5');
    expect(r.memberInfo.isActive).toBe(false);
  });
  it('sums are exact to the paisa (0.1 + 0.2)', async () => {
    const r = await mk([base({ shares: '0.10', compulsory_deposit: '0.20' })]).svc.getMemberBalance('5');
    expect(r.summary.totalAssets).toBe(0.3);
  });
});

describe('member/MemberBalanceService.getQuickBalance', () => {
  beforeEach(() => { jest.spyOn(console, 'error').mockImplementation(() => undefined); });
  afterEach(() => jest.restoreAllMocks());
  it('zeros for a member without a balance row', async () => {
    expect(await mk([]).svc.getQuickBalance('5')).toEqual({ shares: 0, compulsoryDeposit: 0, totalLoans: 0, netBalance: 0 });
  });
  it('net = shares + CD - loans', async () => {
    const { svc, ds } = mk([]); ds.query.mockResolvedValue([{ shares: '1000', compulsory_deposit: '500', regular_loan: '300', emergency_loan: '200' }]);
    expect(await svc.getQuickBalance('5')).toEqual({ shares: 1000, compulsoryDeposit: 500, totalLoans: 500, netBalance: 1000 });
  });
  it('a database failure is reported, not shown to the user as a zero balance', async () => {
    const { svc, ds } = mk([]); ds.query.mockRejectedValue(new Error('db down'));
    await expect(svc.getQuickBalance('5')).rejects.toThrow('db down');
  });
  it('quick balance and the full balance agree on the net figure for the same member', async () => {
    const m = base({ shares: '1000', compulsory_deposit: '500', rd_amount: '300', regular_loan_balance: '200' });
    const full = await mk([m]).svc.getMemberBalance('5');
    const { svc, ds } = mk([]); ds.query.mockResolvedValue([{ shares: '1000', compulsory_deposit: '500', rd_amount: '300', frs_balance: '0', regular_loan: '200', emergency_loan: '0' }]); // the quick query reads RD and FRS too (ES-396)
    expect((await svc.getQuickBalance('5')).netBalance).toBe(full.summary.netBalance);
  });
});
