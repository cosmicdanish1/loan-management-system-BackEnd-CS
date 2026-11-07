import { BadRequestException, ForbiddenException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { MemberDataService } from '../../../src/modules/mobile/data/member-data.service';

const ME = { mbno: '900000001', deviceId: 7 };

function build(over: { loans?: any[]; extra?: any[]; flags?: Record<string, boolean>; schedule?: any; ledger?: any } = {}) {
  const flags = { home: true, accounts: true, loans: true, ledger: true, notices: true, ...(over.flags ?? {}) };
  const ds = {
    query: jest.fn(async (sql: string, _params?: any[]) => {
      if (sql.includes('FROM loan_master')) return over.extra ?? [];
      if (sql.includes('loan_payment_flags')) return [];
      if (sql.includes('loan_repayment_ledger')) return Array.from({ length: 3 }, (_, i) => ({ id: i + 1, payment_date: '2026-0' + (i + 1) + '-05', payment_amount: 100 }));
      if (sql.includes('sbmaster')) return [{ acc_no: 'S1', balance: 10 }];
      if (sql.includes('dashboard_notices')) return [];
      if (sql.includes('FROM member_master')) return [{ name: 'Test Member' }];
      return [];
    }),
  };
  const loanQuery = {
    getMemberLoansFromMaster: jest.fn(async (..._a: any[]) => over.loans ?? []),
    getEmiScheduleFromMaster: jest.fn(async (..._a: any[]) => over.schedule ?? { schedule: [{ month: 1, dueDate: '2026-11-05', emiAmount: 100, principalAmount: 80, interestAmount: 20, balance: 900, status: 'Pending' }] }),
  };
  const balances = { getQuickBalance: jest.fn(async () => ({ shares: 500, compulsoryDeposit: 1200 })) };
  const ledger = { getMemberDetailLedgerReport: jest.fn(async () => over.ledger ?? { totalDebits: 0, totalCredits: 0, entries: [] }) };
  const appCode = { requireApproval: jest.fn(async () => undefined) };
  const flagSvc = { assertOn: jest.fn(async (k: string) => { if (!flags[k as keyof typeof flags]) throw new NotFoundException('off'); }), isOn: jest.fn(async (k: string) => !!flags[k as keyof typeof flags]) };
  const svc = new MemberDataService(ds as any, loanQuery as any, balances as any, ledger as any, appCode as any, flagSvc as any);
  return { svc, ds, loanQuery, ledger, appCode };
}

const loan = (caseNo: number, type: string, balance: number, extra: object = {}) => ({ loancaseno: caseNo, loantype: type, loan_amt: 1000, balance, no_of_instal: 10, instal_amt: 100, ...extra });
const loanRow = (caseNo: number, type: string) => ({ loancaseno: String(caseNo), loantype: type, rate: 9, payment_date: '2025-01-01', purpose: 'x' });

describe('MemberDataService: member isolation', () => {
  it('only ever queries with the member number from the token', async () => {
    const { svc, loanQuery, ds } = build({ loans: [loan(1, 'RLN', 500)], extra: [loanRow(1, 'RLN')] });
    await svc.loans(ME);
    expect(loanQuery.getMemberLoansFromMaster).toHaveBeenCalledWith('900000001');
    for (const c of ds.query.mock.calls) expect(c[1]?.[0]).toBe('900000001');
  });

  it('a loan that is not the member\'s own (or has another type) is "not found", also for schedule and payments', async () => {
    const { svc, loanQuery } = build({ loans: [loan(1, 'RLN', 500)], extra: [loanRow(1, 'RLN')] });
    await expect(svc.loan(ME, 'RLN', '999')).rejects.toBeInstanceOf(NotFoundException);
    await expect(svc.loan(ME, 'ELN', '1')).rejects.toBeInstanceOf(NotFoundException); // same case number, other type
    await expect(svc.schedule(ME, 'RLN', '999')).rejects.toBeInstanceOf(NotFoundException);
    await expect(svc.payments(ME, 'RLN', '999')).rejects.toBeInstanceOf(NotFoundException);
    expect(loanQuery.getEmiScheduleFromMaster).not.toHaveBeenCalled();
  });

  it('the EMI schedule is looked up WITH the member and loan type (case numbers are shared by several members)', async () => {
    const { svc, loanQuery } = build({ loans: [loan(1, 'RLN', 500)], extra: [loanRow(1, 'RLN')] });
    const s = await svc.schedule(ME, 'rln', '1');
    expect(loanQuery.getEmiScheduleFromMaster).toHaveBeenCalledWith('1', { mbno: '900000001', loantype: 'RLN' });
    expect(s.installments[0]).toMatchObject({ installmentNo: 1, status: 'UPCOMING', emi: '100.00' });
    expect(s.summary).toEqual({ paid: 0, overdue: 0, upcoming: 1, total: 1 });
  });

  it('rejects malformed loan references', async () => {
    const { svc } = build();
    await expect(svc.loan(ME, 'RLN; DROP', '1')).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.loan(ME, 'RLN', '1x')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('payments are paged newest first and use member + type + case number', async () => {
    const { svc, ds } = build({ loans: [loan(1, 'RLN', 500)], extra: [loanRow(1, 'RLN')] });
    const r = await svc.payments(ME, 'RLN', '1', undefined, 2);
    expect(r.payments).toHaveLength(2);
    expect(r.nextCursor).toBeTruthy();
    const call = ds.query.mock.calls.find((c) => String(c[0]).includes('loan_repayment_ledger'))!;
    expect(call[1]).toEqual(['900000001', '1', 'RLN']);
    expect(String(call[0])).toContain('is_payroll_lag_credit = false');
  });
});

describe('MemberDataService: honesty about problems', () => {
  it('does not say "no loans" when the desktop service failed silently', async () => {
    const { svc } = build({ loans: [], extra: [loanRow(1, 'RLN')] });
    await expect(svc.loans(ME)).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('a member with really no loans gets an empty list', async () => {
    const { svc } = build({ loans: [], extra: [] });
    await expect(svc.loans(ME)).resolves.toEqual({ loans: [] });
  });

  it('sorts active loans first and shows a merged loan as 0 outstanding', async () => {
    const { svc } = build({
      loans: [loan(5, 'RLN', 0), loan(9, 'ALN', 800), loan(3, 'RLN', 300, { consolidatedIntoLoancaseno: 9 })],
      extra: [loanRow(5, 'RLN'), loanRow(9, 'ALN'), loanRow(3, 'RLN')],
    });
    const { loans } = await svc.loans(ME);
    expect(loans.map((l) => `${l.caseNo}:${l.status}`)).toEqual(['9:ACTIVE', '5:CLOSED', '3:MERGED']);
    expect(loans[2].outstanding).toBe('0.00');
  });
});

describe('MemberDataService: switches, ledger and home', () => {
  it('a switched-off feature answers not found', async () => {
    const { svc } = build({ flags: { loans: false } });
    await expect(svc.loans(ME)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('ledger: last 12 months need no approval, older ranges need the App Code approval', async () => {
    const { svc, appCode, ledger } = build();
    const fmt = (d: Date) => d.toISOString().slice(0, 10);
    const today = new Date();
    const recent = new Date(); recent.setMonth(recent.getMonth() - 3);
    await svc.ledgerPage(ME, { from: fmt(recent), to: fmt(today) });
    expect(appCode.requireApproval).not.toHaveBeenCalled();

    const old = new Date(); old.setMonth(old.getMonth() - 20);
    await svc.ledgerPage(ME, { from: fmt(old), to: fmt(today) }, 'approval-token');
    expect(appCode.requireApproval).toHaveBeenCalledWith(ME, 'LARGE_STATEMENT', 'approval-token');
    expect(ledger.getMemberDetailLedgerReport).toHaveBeenCalledWith({ memberNumber: '900000001', fromDate: fmt(old), toDate: fmt(today) });

    appCode.requireApproval.mockRejectedValueOnce(new ForbiddenException('need code'));
    await expect(svc.ledgerPage(ME, { from: fmt(old), to: fmt(today) })).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('ledger: validates the dates and returns the newest entries first', async () => {
    const { svc } = build({
      ledger: { totalDebits: 10, totalCredits: 20, entries: [
        { date: '2026-09-01', accountHead: 'A', debit: 0, credit: 10 }, { date: '2026-09-02', accountHead: 'B', debit: 10, credit: 0 },
      ] },
    });
    await expect(svc.ledgerPage(ME, { from: 'bad', to: '2026-01-01' })).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.ledgerPage(ME, { from: '2026-02-01', to: '2026-01-01' })).rejects.toBeInstanceOf(BadRequestException);
    const r = await svc.ledgerPage(ME, { from: new Date(Date.now() - 86400000 * 30).toISOString().slice(0, 10), to: new Date().toISOString().slice(0, 10) });
    expect(r.entries.map((e) => e.head)).toEqual(['B', 'A']);
    expect(r.totals).toEqual({ debit: '10.00', credit: '20.00' });
  });

  it('home: totals, next EMI across loans and the neutral office-visit flag', async () => {
    const { svc, loanQuery } = build({
      loans: [loan(1, 'RLN', 500, { ledgerShowsRepaid: true }), loan(2, 'ALN', 250)],
      extra: [loanRow(1, 'RLN'), loanRow(2, 'ALN')],
    });
    loanQuery.getEmiScheduleFromMaster.mockImplementation(async (caseNo: any) => ({
      schedule: [
        { month: 1, dueDate: '2026-10-05', emiAmount: 100, principalAmount: 80, interestAmount: 20, balance: 0, status: 'Paid' },
        { month: 2, dueDate: caseNo === '1' ? '2026-12-05' : '2026-11-05', emiAmount: caseNo === '1' ? 100 : 55, principalAmount: 80, interestAmount: 20, balance: 0, status: 'Pending' },
      ],
    }));
    const h = await svc.home(ME);
    expect(h.balances).toEqual({ shares: '500.00', compulsoryDeposit: '1200.00', savings: '10.00', loansOutstanding: '750.00' });
    expect(h.activeLoans).toBe(2);
    expect(h.nextEmi).toMatchObject({ caseNo: '2', dueDate: '2026-11-05', emi: '55.00' });
    expect(h.needsOfficeVisit).toBe(true);
    expect(h.member).toEqual({ memberNo: '900000001', name: 'Test Member' });
  });

  it('home survives a loan whose schedule cannot be built', async () => {
    const { svc, loanQuery } = build({ loans: [loan(1, 'RLN', 500)], extra: [loanRow(1, 'RLN')] });
    loanQuery.getEmiScheduleFromMaster.mockRejectedValue(new Error('no schedule'));
    const h = await svc.home(ME);
    expect(h.nextEmi).toBeNull();
    expect(h.activeLoans).toBe(1);
  });
});
