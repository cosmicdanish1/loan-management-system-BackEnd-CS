import { BadRequestException } from '@nestjs/common';
import { LoanEligibilityService, REGULAR_LOAN_RULE_DEFAULTS, REGULAR_LOAN_RULE_KEYS, REGULAR_LOAN_NUMERIC_RULE_KEYS } from '../../../src/modules/loan/services-v2/loan-eligibility.service';

interface Fx {
  rules?: Record<string, string | null>; apply?: string | null; outstanding?: number; shares?: number; rd?: number; yearcode?: number | null;
  locked?: number; busrules?: any; negCd?: number; minBal?: number; rdYearClosed?: boolean; otherLocks?: number; failRules?: boolean;
}
function mk(fx: Fx = {}) {
  const ds: any = {
    query: jest.fn(async (sql: string, p?: any[]) => {
      if (/FROM system_configs/.test(sql)) {
        if (fx.failRules) throw new Error('no table');
        const key = p![0] as string;
        if (key.startsWith('RULE_LOAN_ELIGIBILITY_APPLY_')) return fx.apply === undefined ? [] : [{ value: fx.apply }];
        const v = (fx.rules ?? {})[key]; return v === undefined ? [] : [{ value: v }];
      }
      if (/FROM busrules/.test(sql)) return fx.busrules ? [fx.busrules] : [];
      if (/FROM yearend/.test(sql)) return fx.yearcode === null ? [] : [{ yearcode: fx.yearcode ?? 3 }];
      if (/FROM rd_lien/.test(sql) && /loancaseno <>/.test(sql)) return [{ total: fx.otherLocks ?? 0 }];
      if (/FROM rd_lien/.test(sql)) return [{ total: fx.locked ?? 0 }];
      if (/regularloan::numeric|emergency_loan_balance::numeric/.test(sql)) return [{ total: fx.outstanding ?? 0 }];
      if (/shares::numeric/.test(sql)) return [{ shares: fx.shares ?? 0 }];
      if (/compulsory_deposit/.test(sql) && /::float AS cd/.test(sql)) return [{ cd: fx.negCd ?? 0 }];
      if (/rd_financial_year_summary/.test(sql)) return fx.rdYearClosed ? [{ closed_at: new Date() }] : [];
      return [];
    }),
  };
  const rdEvents: any = { getTotalCurrentHoldings: jest.fn().mockResolvedValue(fx.rd ?? 0) };
  const rdRules: any = { getRule: jest.fn().mockResolvedValue(fx.minBal ?? 0) };
  return { svc: new LoanEligibilityService(ds, rdEvents, rdRules), ds, rdEvents, rdRules };
}

describe('loan/eligibility rule defaults', () => {
  it('defaults: 10 lakh limit, 5% RD, 5% share, deduct, outstanding + new', () => {
    expect(REGULAR_LOAN_RULE_DEFAULTS).toMatchObject({ RULE_LOAN_R_MAX_LIMIT: 1000000, RULE_LOAN_R_RD_PCT: 5, RULE_LOAN_R_SHARE_PCT: 5, RULE_LOAN_R_SHORTFALL_MODE: 'DEDUCT', RULE_LOAN_R_LIMIT_CALC: 'OUTSTANDING_PLUS_NEW' });
  });
  it('numeric rule keys are exactly the numeric defaults', () => {
    expect(REGULAR_LOAN_NUMERIC_RULE_KEYS.sort()).toEqual(REGULAR_LOAN_RULE_KEYS.filter((k) => typeof REGULAR_LOAN_RULE_DEFAULTS[k] === 'number').sort());
  });
});

describe('loan/LoanEligibilityService.checkEligibility (regular / emergency)', () => {
  it('exempt when the rule is switched off for the loan type', async () => {
    const r = await mk({ apply: 'false' }).svc.checkEligibility('5', 100000, 'RLN');
    expect(r).toMatchObject({ ruleApplies: false, isEligible: true, netDisbursement: 100000 });
  });
  it('an unknown loan type is exempt', async () => { expect((await mk().svc.checkEligibility('5', 1000, 'XYZ')).ruleApplies).toBe(false); });
  it('rule on by default and switch values true / 1 / Y count as on', async () => {
    for (const apply of [undefined, 'true', '1', 'Y']) expect((await mk({ apply: apply as any }).svc.checkEligibility('5', 1000, 'RLN')).ruleApplies).toBe(true);
    for (const apply of ['false', '0', 'N']) expect((await mk({ apply }).svc.checkEligibility('5', 1000, 'RLN')).ruleApplies).toBe(false);
  });
  it('fully covered member: no shortfall, eligible, net = loan', async () => {
    const r = await mk({ rd: 100000, shares: 100000 }).svc.checkEligibility('5', 500000, 'RLN');
    expect(r).toMatchObject({ requiredRd: 25000, requiredShare: 25000, rdShortfall: 0, shareShortfall: 0, isEligible: true, netDisbursement: 500000, message: 'Member meets the RD and Share Value requirements in full.' });
  });
  it('DEDUCT mode: shortfall is withheld from the disbursement', async () => {
    const r = await mk({ rd: 10000, shares: 20000 }).svc.checkEligibility('5', 400000, 'RLN');
    expect(r.rdShortfall).toBe(10000); expect(r.shareShortfall).toBe(0); expect(r.totalShortfall).toBe(10000); expect(r.netDisbursement).toBe(390000); expect(r.isEligible).toBe(true);
  });
  it('BLOCK mode: any shortfall makes the member ineligible', async () => {
    const r = await mk({ rd: 0, shares: 0, rules: { RULE_LOAN_R_SHORTFALL_MODE: 'block' } }).svc.checkEligibility('5', 100000, 'RLN');
    expect(r.isEligible).toBe(false); expect(r.message).toMatch(/blocked by the configured shortfall policy/);
  });
  it('IGNORE mode: shortfall is not counted at all', async () => {
    const r = await mk({ rules: { RULE_LOAN_R_SHORTFALL_MODE: 'IGNORE' } }).svc.checkEligibility('5', 100000, 'RLN');
    expect(r.totalShortfall).toBe(0); expect(r.netDisbursement).toBe(100000);
  });
  it('maximum limit includes the existing outstanding by default', async () => {
    const r = await mk({ outstanding: 600000, rd: 1e6, shares: 1e6 }).svc.checkEligibility('5', 500000, 'RLN');
    expect(r).toMatchObject({ totalExposure: 1100000, withinMaxLimit: false, isEligible: false }); expect(r.message).toMatch(/exceeds the maximum limit/);
  });
  it('NEW_ONLY calculation ignores the existing outstanding', async () => {
    const r = await mk({ outstanding: 600000, rd: 1e6, shares: 1e6, rules: { RULE_LOAN_R_LIMIT_CALC: 'new_only' } }).svc.checkEligibility('5', 500000, 'RLN');
    expect(r.totalExposure).toBe(500000); expect(r.isEligible).toBe(true);
  });
  it('exactly the limit is allowed', async () => {
    const r = await mk({ rd: 1e6, shares: 1e6 }).svc.checkEligibility('5', 1000000, 'RLN'); expect(r.withinMaxLimit).toBe(true);
  });
  it('required RD/share use the total exposure and the configured percentages', async () => {
    const r = await mk({ outstanding: 100000, rules: { RULE_LOAN_R_RD_PCT: '10', RULE_LOAN_R_SHARE_PCT: '2' } }).svc.checkEligibility('5', 100000, 'RLN');
    expect(r.requiredRd).toBe(20000); expect(r.requiredShare).toBe(4000);
  });
  it('emergency loan reads the emergency balance, regular reads the regular balance', async () => {
    const a = mk({ outstanding: 5 }); await a.svc.checkEligibility('5', 1, 'ALN'); expect(a.ds.query.mock.calls.some((c: any[]) => /emergency_loan_balance::numeric/.test(c[0]))).toBe(true);
    const b = mk({ outstanding: 5 }); await b.svc.checkEligibility('5', 1, 'RLN'); expect(b.ds.query.mock.calls.some((c: any[]) => /regularloan::numeric/.test(c[0]))).toBe(true);
  });
  it('no current financial year means RD of 0', async () => {
    const r = await mk({ yearcode: null, rd: 999999 }).svc.checkEligibility('5', 100000, 'RLN'); expect(r.currentRd).toBe(0);
  });
  it('a bad or missing rule value falls back to the default (no NaN)', async () => {
    const r = await mk({ rules: { RULE_LOAN_R_MAX_LIMIT: 'abc', RULE_LOAN_R_RD_PCT: '' } }).svc.checkEligibility('5', 100000, 'RLN');
    expect(r.maxLimit).toBe(1000000); expect(r.rdPct).toBe(5);
  });
  it('when the rule table cannot be read the defaults apply and the rule stays on', async () => {
    const r = await mk({ failRules: true }).svc.checkEligibility('5', 100000, 'RLN'); expect(r.ruleApplies).toBe(true); expect(r.maxLimit).toBe(1000000);
  });
  it('a negative loan amount is not eligible (cannot create a negative requirement)', async () => {
    await expect(mk().svc.enforceEligibility('5', -100000, 'RLN')).rejects.toThrow(BadRequestException);
  });
  it('enforceEligibility throws the message when ineligible and passes otherwise', async () => {
    await expect(mk({ outstanding: 999999 }).svc.enforceEligibility('5', 100000, 'RLN')).rejects.toThrow(/exceeds the maximum limit/);
    await expect(mk({ rd: 1e6, shares: 1e6 }).svc.enforceEligibility('5', 100000, 'RLN')).resolves.toBeUndefined();
  });
});

describe('loan/LoanEligibilityService loan against RD (ELN)', () => {
  const eln = (fx: Fx, amt: number) => mk({ busrules: { loanagainstdeppercent: 90, elnmaxloanamt: 500000 }, ...fx }).svc.checkEligibility('5', amt, 'ELN');
  it('max = the smallest of 90% of RD less locked, free RD less the minimum balance, and the ceiling less locked', async () => {
    const r = await eln({ rd: 100000, locked: 0, minBal: 5000 }, 50000);
    expect(r).toMatchObject({ rdBacked: true, maxLoanAmount: 90000, isEligible: true });
  });
  it('the minimum balance floor can be the binding limit', async () => {
    const r = await eln({ rd: 100000, locked: 0, minBal: 20000 }, 90000); expect(r.maxLoanAmount).toBe(80000); expect(r.isEligible).toBe(false);
  });
  it('locked RD reduces both free RD and the limit', async () => {
    const r = await eln({ rd: 100000, locked: 40000, minBal: 0 }, 10000); expect(r.freeRd).toBe(60000); expect(r.maxLoanAmount).toBe(50000);
  });
  it('the ceiling (elnmaxloanamt) binds for a large RD', async () => {
    const r = await eln({ rd: 1e7, locked: 0, minBal: 0 }, 600000); expect(r.maxLoanAmount).toBe(500000); expect(r.isEligible).toBe(false); expect(r.message).toMatch(/ceiling/);
  });
  it('no free RD: not eligible with an explanation', async () => {
    const r = await eln({ rd: 0 }, 1000); expect(r.isEligible).toBe(false); expect(r.message).toMatch(/no free RD/);
  });
  it('the ceiling already used up by locked RD', async () => {
    const r = await eln({ rd: 1e7, locked: 500000 }, 1000); expect(r.isEligible).toBe(false); expect(r.message).toMatch(/reaches the/);
  });
  it('missing busrules rows use 90% and a 5 lakh ceiling', async () => {
    const r = await mk({ rd: 1e7 }).svc.checkEligibility('5', 1000, 'ELN'); expect(r.maxLoanAmount).toBe(500000); expect(r.rdPct).toBe(90);
  });
  it('an amount of exactly the maximum is allowed, one rupee more is not', async () => {
    expect((await eln({ rd: 100000, minBal: 0 }, 90000)).isEligible).toBe(true); expect((await eln({ rd: 100000, minBal: 0 }, 90001)).isEligible).toBe(false);
  });
  it('the rule switch does not apply to loan against RD (always checked)', async () => {
    const r = await mk({ apply: 'false', rd: 0 }).svc.checkEligibility('5', 1000, 'ELN'); expect(r.ruleApplies).toBe(true); expect(r.isEligible).toBe(false);
  });
});

describe('loan/LoanEligibilityService.getDisbursementDeductions', () => {
  it('no shortfall, no negative RD: nothing to deduct', async () => {
    expect(await mk({ rd: 1e6, shares: 1e6 }).svc.getDisbursementDeductions('5', 100000, 'RLN')).toEqual([]);
  });
  it('share and RD shortfalls become two deductions with their heads', async () => {
    const d = await mk({ rd: 0, shares: 0 }).svc.getDisbursementDeductions('5', 100000, 'RLN');
    expect(d.map((x) => [x.kind, x.code, x.amount])).toEqual([['SHARE', 'L1001', 5000], ['RD', 'L1004', 5000]]);
  });
  it('a negative RD balance (group insurance) is cleared first from the disbursement', async () => {
    const d = await mk({ rd: 1e6, shares: 1e6, negCd: -750.456 }).svc.getDisbursementDeductions('5', 100000, 'RLN');
    expect(d[0]).toMatchObject({ kind: 'RD_NEGATIVE', amount: 750.46 });
  });
  it('the total of all deductions never exceeds the loan amount', async () => {
    const d = await mk({ rd: 0, shares: 0, negCd: -500000 }).svc.getDisbursementDeductions('5', 100000, 'RLN');
    expect(d.reduce((s, x) => s + x.amount, 0)).toBeLessThanOrEqual(100000);
  });
  it('an exempt loan type skips the shortfall but still clears negative RD', async () => {
    const d = await mk({ apply: 'false', negCd: -100 }).svc.getDisbursementDeductions('5', 1000, 'RLN');
    expect(d.map((x) => x.kind)).toEqual(['RD_NEGATIVE']);
  });
});

describe('loan/LoanEligibilityService.getRdShareClosureAdjustment', () => {
  const adj = (fx: Fx, amt: number) => mk({ minBal: 1000, ...fx }).svc.getRdShareClosureAdjustment('5', amt, '9');
  it('uses RD above the minimum balance first, then share above its minimum', async () => {
    const r = await adj({ rd: 5000, shares: 3000 }, 6000);
    expect(r).toMatchObject({ rdAvailable: 4000, shareAvailable: 2000, appliedFromRdShare: 6000, fromRd: 4000, fromShare: 2000, payableByMember: 0 });
  });
  it('the member pays what RD and share cannot cover', async () => {
    const r = await adj({ rd: 5000, shares: 3000 }, 10000); expect(r).toMatchObject({ appliedFromRdShare: 6000, payableByMember: 4000 });
  });
  it('RD locked for other loans is not available', async () => {
    const r = await adj({ rd: 5000, otherLocks: 3000, shares: 1000 }, 5000); expect(r.rdAvailable).toBe(1000);
  });
  it('a closed RD year gives no RD', async () => {
    const r = await adj({ rd: 5000, rdYearClosed: true, shares: 1000 }, 5000); expect(r).toMatchObject({ rdAvailable: 0, rdYearClosed: true });
  });
  it('applied + payable always equals the closure amount', async () => {
    for (const amt of [0, 1, 999.99, 6000, 123456.78]) { const r = await adj({ rd: 5000, shares: 3000 }, amt); expect(Math.round((r.appliedFromRdShare + r.payableByMember) * 100) / 100).toBe(amt); }
  });
  it('no financial year: RD is 0 and nothing is read for the closed flag', async () => {
    const r = await adj({ yearcode: null, rd: 9999, shares: 3000 }, 5000); expect(r).toMatchObject({ currentRd: 0, yearcode: null });
  });
});
