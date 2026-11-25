// Member rules set in Modify Business Rules > Members: minimum age at joining and the deposit ranges; working date for the declaration date.
import { BadRequestException } from '@nestjs/common';
import { MemberCrudService } from '../../../src/modules/member/services-v2/member-crud.service';
import { loadMemberRules, rangeProblem, minAgeProblem, wholeYears, MEMBER_RULE_DEFAULTS, MEMBER_RULE_KEYS } from '../../../src/modules/member/member-rules';

describe('wholeYears / minAgeProblem', () => {
  it.each([
    ['2000-01-01', '2018-01-01', 18], ['2000-01-02', '2018-01-01', 17], ['1981-11-14', '2026-11-14', 45], ['1990-05-01', '1990-05-01', 0],
  ])('%s to %s = %s', (a, b, want) => expect(wholeYears(a, b)).toBe(want));
  it.each([[null, '2026-01-01'], ['2000-01-01', ''], ['x', 'y']])('missing dates give null', (a, b) => expect(wholeYears(a as any, b as any)).toBeNull());
  it('age 17 is refused with the minimum in the message; 18 is fine; minimum 0 switches the rule off', () => {
    expect(minAgeProblem('2000-01-02', '2018-01-01', 18)).toMatch(/at least 18 years old/);
    expect(minAgeProblem('2000-01-01', '2018-01-01', 18)).toBeNull();
    expect(minAgeProblem('2010-01-01', '2018-01-01', 0)).toBeNull();
  });
  it('another minimum from the settings', () => {
    expect(minAgeProblem('2000-01-01', '2020-01-01', 21)).toMatch(/at least 21/);
  });
  it('a missing date gives no message (the date checks do that)', () => {
    expect(minAgeProblem('', '2020-01-01', 18)).toBeNull();
    expect(minAgeProblem('2000-01-01', '', 18)).toBeNull();
  });
});

describe('rangeProblem', () => {
  it.each([
    [200, 20, 200, null], [20, 20, 200, null], [8, 20, 200, 'at least ₹20'], [250, 20, 200, 'at most ₹200'], [0, 20, 200, null],
    [8, 0, 0, null], [5000, 0, 0, null], [8, 10, 0, 'at least ₹10'], [50, 0, 40, 'at most ₹40'], [null, 20, 200, null],
  ])('value %s in [%s, %s] -> %s', (v, min, max, want) => {
    const r = rangeProblem('Monthly Contribution', v as any, min as number, max as number);
    if (want === null) expect(r).toBeNull(); else expect(r).toContain(want as string);
  });
});

describe('loadMemberRules', () => {
  const runner = (rows: any[] | Error) => ({ query: jest.fn(async () => { if (rows instanceof Error) throw rows; return rows; }) });
  it('nothing stored: the defaults (age 18, ranges off)', async () => {
    expect(await loadMemberRules(runner([]))).toEqual(MEMBER_RULE_DEFAULTS);
    expect(MEMBER_RULE_DEFAULTS.RULE_MEMBER_MIN_AGE).toBe(18);
  });
  it('stored values are used', async () => {
    const r = await loadMemberRules(runner([{ key: 'RULE_MEMBER_MIN_AGE', value: '21' }, { key: 'RULE_MEMBER_CD_MIN', value: '20' }, { key: 'RULE_MEMBER_CD_MAX', value: '200' }]));
    expect(r).toMatchObject({ RULE_MEMBER_MIN_AGE: 21, RULE_MEMBER_CD_MIN: 20, RULE_MEMBER_CD_MAX: 200, RULE_MEMBER_MD_MIN: 0 });
  });
  it('a bad, negative or unknown value is ignored', async () => {
    const r = await loadMemberRules(runner([{ key: 'RULE_MEMBER_MIN_AGE', value: 'abc' }, { key: 'RULE_MEMBER_CD_MAX', value: '-5' }, { key: 'OTHER', value: '9' }]));
    expect(r).toEqual(MEMBER_RULE_DEFAULTS);
  });
  it('a database error gives the defaults, a member save is never blocked by it', async () => {
    expect(await loadMemberRules(runner(new Error('down')))).toEqual(MEMBER_RULE_DEFAULTS);
  });
  it('asks only for its own keys', async () => {
    const r = runner([]);
    await loadMemberRules(r);
    expect(r.query.mock.calls[0]![1]).toEqual([[...MEMBER_RULE_KEYS]]);
  });
});

// ── through the real save ──
type Opts = { rules?: Record<string, string>; existing?: any; stored?: { mdamt?: number; cdamt?: number }; workingDate?: string | null; policy?: string };
function mk(o: Opts = {}) {
  const calls: Array<{ sql: string; params?: any[] }> = [];
  const row = { mbno: '300', f_name: 'A' };
  const handle = async (sql: string, params?: any[]) => {
    calls.push({ sql, params });
    if (/SELECT \* FROM member_master WHERE mbno/.test(sql)) return o.existing ? [o.existing] : [];
    if (/FROM system_configs WHERE key = ANY/.test(sql)) return Object.entries(o.rules ?? {}).map(([key, value]) => ({ key, value }));
    if (/SELECT mdamt, cdamt FROM fundsmaster/.test(sql)) return o.stored ? [o.stored] : [];
    if (/to_regclass/.test(sql)) return [{ t: o.policy ? 'window_date_policy' : null }];
    if (/window_date_policy WHERE/.test(sql)) return [{ mode: o.policy }];
    if (/AS d FROM getworkingdate/.test(sql)) return o.workingDate === null ? [] : [{ d: o.workingDate ?? '2026-08-25' }];
    if (/WHERE btrim\(pfno\)/.test(sql)) return [];
    if (/dayend_flag = 'Y'/.test(sql) || /closed_at IS NOT NULL/.test(sql) || /FROM yearend WHERE start_date/.test(sql)) return [];
    if (/^\s*UPDATE (fundsmaster|membercategory)/.test(sql)) return [[{ mbno: '300' }], 1];
    if (/^\s*UPDATE member_master/.test(sql)) return [[row], 1];
    return [row];
  };
  const qr: any = { connect: jest.fn(), startTransaction: jest.fn(), commitTransaction: jest.fn(), rollbackTransaction: jest.fn(), release: jest.fn(), query: jest.fn(handle) };
  const ds: any = { query: jest.fn(handle), createQueryRunner: jest.fn(() => qr) };
  const seq: any = { generateNextMemberNumber: jest.fn().mockResolvedValue('990042383'), getNextVoucherNumber: jest.fn().mockResolvedValue('V1') };
  const svc = new MemberCrudService({} as any, {} as any, ds, seq, {} as any, { setMonthlyAmount: jest.fn() } as any);
  (MemberCrudService as any).emailColumnReady = true;
  return { svc, calls, qr, ds };
}
const base = (x: any = {}) => ({ f_name: 'Ravi', officeno: 1, wingno: '1', sex: 'M', ...x });
const msgs = (e: any) => e?.response?.message as string[];

describe('minimum age at joining on save', () => {
  it('a 17-year-old on the membership date is refused (400) and nothing is saved', async () => {
    const { svc, qr } = mk();
    await expect(svc.saveMemberMaster(base({ mbno: 'auto', dob: '2000-01-02', memb_date: '2018-01-01' }))).rejects.toThrow(BadRequestException);
    expect(qr.startTransaction).not.toHaveBeenCalled();
  });
  it('exactly 18 is accepted', async () => {
    const { svc } = mk();
    await expect(svc.saveMemberMaster(base({ mbno: 'auto', dob: '2000-01-01', memb_date: '2018-01-01' }))).resolves.toBeDefined();
  });
  it('the minimum comes from the settings (21 refuses a 20-year-old)', async () => {
    const { svc } = mk({ rules: { RULE_MEMBER_MIN_AGE: '21' } });
    await expect(svc.saveMemberMaster(base({ mbno: 'auto', dob: '2000-01-01', memb_date: '2020-06-01' }))).rejects.toMatchObject({ response: { message: [expect.stringContaining('at least 21')] } });
  });
  it('a minimum of 0 switches the rule off', async () => {
    const { svc } = mk({ rules: { RULE_MEMBER_MIN_AGE: '0' } });
    await expect(svc.saveMemberMaster(base({ mbno: 'auto', dob: '2010-01-01', memb_date: '2012-01-01' }))).resolves.toBeDefined();
  });
  it('an existing member under 18 (old data) can still be edited when the dates are not changed', async () => {
    const { svc } = mk({ existing: { mbno: '300', pfno: '', dob: '1990-01-01', memb_date: '2000-01-01' } });
    await expect(svc.saveMemberMaster(base({ mbno: '300', dob: '1990-01-01', memb_date: '2000-01-01', remarks: 'x' }))).resolves.toBeDefined();
  });
  it('but changing the membership date of such a member is checked', async () => {
    const { svc } = mk({ existing: { mbno: '300', pfno: '', dob: '1990-01-01', memb_date: '2000-01-01' } });
    await expect(svc.saveMemberMaster(base({ mbno: '300', dob: '1990-01-01', memb_date: '2001-01-01' }))).rejects.toThrow(BadRequestException);
  });
  it('no dates at all: not checked', async () => {
    const { svc } = mk();
    await expect(svc.saveMemberMaster(base({ mbno: 'auto' }))).resolves.toBeDefined();
  });
});

describe('deposit ranges on save', () => {
  const rules = { RULE_MEMBER_CD_MIN: '20', RULE_MEMBER_CD_MAX: '200', RULE_MEMBER_MD_MIN: '20', RULE_MEMBER_MD_MAX: '200' };
  it('ranges off (default): any amount is accepted', async () => {
    const { svc } = mk();
    await expect(svc.saveMemberMaster(base({ mbno: 'auto', monthly_contribution: 8, compulsory_deposit: 5000 }))).resolves.toBeDefined();
  });
  it('Monthly Contribution 8 is refused when the minimum is 20 (the legacy refusal), 0 is accepted, 20 and 200 are accepted', async () => {
    const a = mk({ rules });
    await expect(a.svc.saveMemberMaster(base({ mbno: 'auto', monthly_contribution: 8 }))).rejects.toMatchObject({ response: { message: [expect.stringContaining('Monthly Contribution must be in range')] } });
    for (const v of [0, 20, 200]) await expect(mk({ rules }).svc.saveMemberMaster(base({ mbno: 'auto', monthly_contribution: v }))).resolves.toBeDefined();
  });
  it('Compulsory Deposit above the maximum is refused', async () => {
    await expect(mk({ rules }).svc.saveMemberMaster(base({ mbno: 'auto', compulsory_deposit: 250 }))).rejects.toMatchObject({ response: { message: [expect.stringContaining('Compulsory Deposit must be in range')] } });
  });
  it('both problems are reported together', async () => {
    const err: any = await mk({ rules }).svc.saveMemberMaster(base({ mbno: 'auto', monthly_contribution: 8, compulsory_deposit: 250 })).catch((e) => e);
    expect(msgs(err)).toHaveLength(2);
  });
  it('an amount that did not change is not checked again (5,653 members hold 8)', async () => {
    const { svc } = mk({ rules, existing: { mbno: '300', pfno: '' }, stored: { mdamt: 8, cdamt: 200 } });
    await expect(svc.saveMemberMaster(base({ mbno: '300', monthly_contribution: 8, compulsory_deposit: 200 }))).resolves.toBeDefined();
  });
  it('but a changed amount is', async () => {
    const { svc } = mk({ rules, existing: { mbno: '300', pfno: '' }, stored: { mdamt: 8, cdamt: 200 } });
    await expect(svc.saveMemberMaster(base({ mbno: '300', monthly_contribution: 9, compulsory_deposit: 200 }))).rejects.toThrow(BadRequestException);
  });
  it('an amount that was not sent is not checked', async () => {
    const { svc } = mk({ rules });
    await expect(svc.saveMemberMaster(base({ mbno: 'auto' }))).resolves.toBeDefined();
  });
});

describe('working date (Day End > Date settings, key MEMBER_MASTER)', () => {
  it('a new member with a nominee and no declaration date gets the WORKING date', async () => {
    const { svc, calls } = mk({ workingDate: '2026-08-25' });
    await svc.saveMemberMaster(base({ mbno: 'auto', nominee_name: 'RAM' }));
    const ins = calls.find((c) => /INSERT INTO member_master/.test(c.sql))!;
    expect(ins.params).toContain('2026-08-25');
  });
  it('switched to the system date it gets today (India time)', async () => {
    const { svc, calls } = mk({ policy: 'SYSTEM', workingDate: '2026-08-25' });
    await svc.saveMemberMaster(base({ mbno: 'auto', nominee_name: 'RAM' }));
    const ins = calls.find((c) => /INSERT INTO member_master/.test(c.sql))!;
    expect(ins.params).not.toContain('2026-08-25');
    expect(ins.params!.some((p) => /^\d{4}-\d{2}-\d{2}$/.test(String(p)))).toBe(true);
    expect(calls.some((c) => /window_date_policy WHERE/.test(c.sql) && c.params?.[0] === 'MEMBER_MASTER')).toBe(true);
  });
  it('a typed declaration date is kept', async () => {
    const { svc, calls } = mk({ workingDate: '2026-08-25' });
    await svc.saveMemberMaster(base({ mbno: 'auto', nominee_name: 'RAM', declare_date: '2026-01-05' }));
    const ins = calls.find((c) => /INSERT INTO member_master/.test(c.sql))!;
    expect(ins.params).toContain('2026-01-05');
    expect(ins.params).not.toContain('2026-08-25');
  });
  it('no nominee: no declaration date is invented', async () => {
    const { svc, calls } = mk({ workingDate: '2026-08-25' });
    await svc.saveMemberMaster(base({ mbno: 'auto' }));
    expect(calls.find((c) => /INSERT INTO member_master/.test(c.sql))!.params).not.toContain('2026-08-25');
  });
  it('an edit never changes the declaration date by itself', async () => {
    const { svc, calls } = mk({ workingDate: '2026-08-25', existing: { mbno: '300', pfno: '' } });
    await svc.saveMemberMaster(base({ mbno: '300', nominee_name: 'RAM' }));
    expect(calls.find((c) => /^\s*UPDATE member_master/.test(c.sql))!.params).not.toContain('2026-08-25');
  });
  it('the starting RD/CD deposit is dated with the working date, not the computer clock', async () => {
    const { svc, calls } = mk({ workingDate: '2026-08-25' });
    await svc.saveMemberMaster(base({ mbno: 'auto', compulsory_deposit: 200, monthly_contribution: 0 })).catch(() => undefined);
    const yr = calls.find((c) => /FROM yearend WHERE start_date <= \$1::date/.test(c.sql));
    expect(yr?.params).toEqual(['2026-08-25']);
  });
});
