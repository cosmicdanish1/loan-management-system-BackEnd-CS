// ES-455: the loan limit counts the member's loans that are sanctioned but not yet paid out (owner decision 2026-11-20).
import { BadRequestException } from '@nestjs/common';
import { LoanEligibilityService } from '../../../src/modules/loan/services-v2/loan-eligibility.service';

/** A data source that answers the few queries the limit check makes. */
const make = (opts: { outstanding: number; sanctionedNotPaid: number; maxLimit?: number; applies?: boolean }) => {
  const ds: any = {
    query: jest.fn(async (sql: string, params?: any[]) => {
      if (/FROM system_configs/.test(sql)) {
        const key = params?.[0];
        if (key === 'RULE_LOAN_R_MAX_LIMIT') return [{ value: String(opts.maxLimit ?? 1000000) }];
        if (key === 'RULE_LOAN_R_LIMIT_CALC') return [{ value: 'OUTSTANDING_PLUS_NEW' }];
        if (/RULE_LOAN_ELIGIBILITY_APPLY/.test(String(key))) return [{ value: String(opts.applies ?? true) }];
        return [];
      }
      if (/FROM member_balances/.test(sql)) return [{ total: opts.outstanding }];
      if (/FROM loan_pending/.test(sql)) return [{ total: opts.sanctionedNotPaid }];
      return [];
    }),
  };
  return { svc: new LoanEligibilityService(ds, null as any, null as any), ds };
};

describe('loan limit counts sanctioned-but-not-paid loans (ES-455)', () => {
  it('refuses a loan that, with the sanctioned-not-paid ones, goes over the limit', async () => {
    const { svc } = make({ outstanding: 0, sanctionedNotPaid: 600000 });
    await expect(svc.assertWithinExposureLimit('1', 600000, 'RLN', '9')).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.assertWithinExposureLimit('1', 600000, 'RLN', '9')).rejects.toThrow(/sanctioned but not yet paid/);
  });

  it('allows a loan that stays within the limit, exactly at the limit included', async () => {
    const { svc } = make({ outstanding: 100000, sanctionedNotPaid: 600000 });
    await expect(svc.assertWithinExposureLimit('1', 300000, 'RLN', '9')).resolves.toBeUndefined();
  });

  it('adds the existing balance too', async () => {
    const { svc } = make({ outstanding: 500000, sanctionedNotPaid: 400000 });
    await expect(svc.assertWithinExposureLimit('1', 200000, 'RLN', '9')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('leaves the case itself out and binds the member, type and case as parameters', async () => {
    const { svc, ds } = make({ outstanding: 0, sanctionedNotPaid: 0 });
    await svc.assertWithinExposureLimit('77', 100000, 'rln', '555');
    const call = ds.query.mock.calls.find((c: any[]) => /FROM loan_pending/.test(c[0]));
    expect(call[1]).toEqual(['77', 'RLN', '555']);
    expect(call[0]).toMatch(/flg_sanctioned = 'Y'/);
    expect(call[0]).toMatch(/<> 'Y'/);
  });

  it('does nothing for Loan Against RD or when the rule is switched off for the type', async () => {
    const eln = make({ outstanding: 0, sanctionedNotPaid: 9999999 });
    await expect(eln.svc.assertWithinExposureLimit('1', 900000, 'ELN', '9')).resolves.toBeUndefined();
    const off = make({ outstanding: 0, sanctionedNotPaid: 9999999, applies: false });
    await expect(off.svc.assertWithinExposureLimit('1', 900000, 'RLN', '9')).resolves.toBeUndefined();
  });
});
