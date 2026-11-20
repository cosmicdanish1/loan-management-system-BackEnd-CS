import { BadRequestException } from '@nestjs/common';
import { InterestService } from '../../../src/modules/interest/interest.service';

// ES-583: the Yearly Fund Process window posts only through the RD/CD engine (legacy shape) - nothing to A1001 / L4001 / L1028
describe('interest/InterestService.processYearlyFundProcess (ES-583)', () => {
  function mk(o: { fy?: any[]; pct?: number; dividendExists?: boolean; failed?: any[] } = {}) {
    const calls: Array<[string, any[]?]> = [];
    const ds: any = {
      query: jest.fn(async (sql: string, p?: any[]) => {
        calls.push([sql, p]);
        if (/FROM yearend/.test(sql)) return o.fy ?? [{ yearcode: 3, e: '2027-03-31' }];
        if (/FROM dividend_master/.test(sql)) return o.dividendExists ? [{ x: 1 }] : [];
        if (/FROM member_master/.test(sql)) return [{ m: '5', n: 'Ram' }];
        return [];
      }),
    };
    const sys: any = { getBusinessRules: jest.fn().mockResolvedValue({ RULE_DIVIDEND_PCT: o.pct ?? 0 }) };
    const funds: any = { find: jest.fn().mockResolvedValue([{ memberNo: 5, sharesOpeningBalance: 1000 }]) };
    const members: any = { find: jest.fn().mockResolvedValue([{ mbno: 5 }]) };
    const rd: any = {
      previewFinancialYearClosing: jest.fn().mockResolvedValue({ total: 1, members: [{ mbno: '5', totalInterestIfClosedNow: 700, currentBalance: 10000 }] }),
      closeFinancialYear: jest.fn().mockResolvedValue({ succeeded: [{ mbno: '5', totalInterestCredited: 700, openingBalance: 9000, closingBalance: 10700 }], failed: o.failed ?? [] }),
    };
    const svc = new InterestService({} as any, {} as any, {} as any, members, funds, sys, ds, rd);
    return { svc, ds, calls, rd, funds };
  }
  const dto: any = { fromDate: '2026-04-01', toDate: '2027-03-31' };

  it('preview shows the RD/CD engine interest per member and writes nothing', async () => {
    const t = mk(); const r = await t.svc.processYearlyFundProcess(dto, true);
    expect(t.rd.previewFinancialYearClosing).toHaveBeenCalledWith(3, 200, 0);
    expect(r).toMatchObject({ totalMembers: 1, totalInterestAmount: 700, voucherNumber: 'PREVIEW' });
    expect(r.memberCalculations[0]).toMatchObject({ memberNumber: '5', memberName: 'Ram', interestAmount: 700, closingBalance: 10700 });
    expect(t.rd.closeFinancialYear).not.toHaveBeenCalled();
    expect(t.calls.some((c) => /INSERT/.test(c[0]))).toBe(false);
  });
  it('process closes the year through the engine as the logged-in user, and posts nothing to A1001 / L4001 / L1028 itself', async () => {
    const t = mk(); const r = await t.svc.processYearlyFundProcess(dto, false, 'bob');
    expect(t.rd.closeFinancialYear).toHaveBeenCalledWith(3, 'bob');
    expect(r).toMatchObject({ totalMembers: 1, totalInterestAmount: 700 });
    const all = JSON.stringify(t.calls);
    expect(/A1001|L4001|L1028|INSERT INTO ledger/.test(all)).toBe(false);
  });
  it('members the engine could not close are reported, not hidden', async () => {
    const t = mk({ failed: [{ mbno: '9', error: 'already closed' }] });
    expect((await t.svc.processYearlyFundProcess(dto, false)).voucherNumber).toMatch(/1 member\(s\) could not be closed.*9: already closed/);
  });
  it('with a lump sum, the group insurance of the year is previewed / posted through the Group Insurance module, after the interest', async () => {
    const t = mk();
    const gi: any = {
      preview: jest.fn().mockResolvedValue({ summary: { membersCharged: 6, totalToCollect: 1700000 }, alreadyPosted: null }),
      post: jest.fn().mockResolvedValue({ membersCharged: 6, totalCharged: 1700000, voucherNo: 'VCH9' }),
    };
    const svc = new InterestService({} as any, {} as any, {} as any, { find: jest.fn().mockResolvedValue([]) } as any, { find: jest.fn().mockResolvedValue([]) } as any,
      { getBusinessRules: jest.fn().mockResolvedValue({}) } as any, (t as any).ds, (t as any).rd, gi);
    const p = await svc.processYearlyFundProcess({ ...dto, insuranceLumpSum: 1700000 }, true);
    expect(gi.preview).toHaveBeenCalledWith({ yearcode: 3, lumpSum: 1700000, limit: 1 }); expect(p.voucherNumber).toMatch(/Group insurance: 6 members, 1700000/);
    const r = await svc.processYearlyFundProcess({ ...dto, insuranceLumpSum: 1700000 }, false, 'bob');
    expect(gi.post).toHaveBeenCalledWith({ yearcode: 3, lumpSum: 1700000 }, 'bob'); expect(r.voucherNumber).toMatch(/Group insurance posted: 6 members.*VCH9/);
    // no lump sum: the insurance is not touched
    gi.post.mockClear(); await svc.processYearlyFundProcess(dto, false); expect(gi.post).not.toHaveBeenCalled();
  });
  it('a failed insurance run (e.g. already posted) is reported, the interest result is kept', async () => {
    const t = mk();
    const gi: any = { post: jest.fn().mockRejectedValue(new Error('Group insurance for FY has already been posted')) };
    const svc = new InterestService({} as any, {} as any, {} as any, { find: jest.fn().mockResolvedValue([]) } as any, { find: jest.fn().mockResolvedValue([]) } as any,
      { getBusinessRules: jest.fn().mockResolvedValue({}) } as any, (t as any).ds, (t as any).rd, gi);
    const r = await svc.processYearlyFundProcess({ ...dto, insuranceLumpSum: 5 }, false);
    expect(r.totalInterestAmount).toBe(700); expect(r.voucherNumber).toMatch(/Group insurance NOT posted: .*already been posted/);
  });
  it('a date outside every financial year is refused', async () => {
    await expect(mk({ fy: [] }).svc.processYearlyFundProcess(dto, true)).rejects.toThrow(BadRequestException);
  });
  it('the dividend is declared (pending) only when a rate is set, once per year', async () => {
    const none = mk({ pct: 0 }); await none.svc.processYearlyFundProcess(dto, false);
    expect(none.calls.some((c) => /INSERT INTO dividend_master/.test(c[0]))).toBe(false);
    const on = mk({ pct: 10 }); await on.svc.processYearlyFundProcess(dto, false);
    const ins = on.calls.find((c) => /INSERT INTO dividend_master/.test(c[0])); expect(ins![1]).toEqual([5, 2027, 1000, 10, 100]);
    await expect(mk({ pct: 10, dividendExists: true }).svc.processYearlyFundProcess(dto, false)).rejects.toThrow(/already been declared/);
  });
});
