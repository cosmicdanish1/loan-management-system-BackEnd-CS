import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { MemberStatusService, ACTIVE_MEMBER_SQL, RETIREMENT_DATE_RECORDED_SQL, RETIREMENT_DATE_FLOOR } from '../../../src/modules/member-status/member-status.service';

function mk() {
  const em: any = { query: jest.fn().mockResolvedValue([{ mbno: 1 }]) };
  const ds: any = { query: jest.fn(), transaction: jest.fn(async (fn: any) => fn(em)) };
  return { svc: new MemberStatusService(ds), ds, em };
}
const row = (o: any = {}) => ({ member_no: '10', isactive: 'Y', name: 'A B', retirement_date: '2020-01-01', retired: true, rd_balance: 0, loan_balance: 0, ...o });

describe('member-status/SQL helpers', () => {
  it('active means isactive = Y', () => expect(ACTIVE_MEMBER_SQL('x')).toBe("x.isactive = 'Y'"));
  it('a retirement date before 1950 counts as not recorded', () => {
    expect(RETIREMENT_DATE_FLOOR).toBe('1950-01-01');
    expect(RETIREMENT_DATE_RECORDED_SQL('c')).toContain("c::date >= '1950-01-01'");
  });
});

describe('member-status/summary', () => {
  it('clamps months to 1..60 and falls back to 12', async () => {
    const { svc, ds } = mk(); ds.query.mockResolvedValue([{}]);
    expect((await svc.summary(500)).upcomingMonths).toBe(60);
    expect((await svc.summary(0)).upcomingMonths).toBe(12);
    expect((await svc.summary(-4)).upcomingMonths).toBe(1);
    expect((await svc.summary(NaN as any)).upcomingMonths).toBe(12);
  });
  it('maps counts and defaults missing counts to 0', async () => {
    const { svc, ds } = mk(); ds.query.mockResolvedValue([{ ready: 3, retired_rd: 2 }]);
    expect(await svc.summary(6)).toEqual({ ready: 3, retiredWithRd: 2, upcoming: 0, upcomingMonths: 6 });
  });
  it('passes months as a bound parameter, not text', async () => {
    const { svc, ds } = mk(); ds.query.mockResolvedValue([{}]);
    await svc.summary(7);
    expect(ds.query.mock.calls[0][1]).toEqual([7]);
  });
});

describe('member-status/list', () => {
  const setup = (rows: any[]) => { const t = mk(); t.ds.query.mockResolvedValueOnce([{ total: rows.length }]).mockResolvedValueOnce(rows); return t; };
  it('rejects an unknown category', async () => {
    await expect(mk().svc.list({ category: 'x' as any })).rejects.toThrow(BadRequestException);
  });
  it('clamps limit to 500 and offset to >= 0', async () => {
    const { svc, ds } = setup([]);
    const r = await svc.list({ category: 'ready', limit: 99999, offset: -5 });
    expect(r).toMatchObject({ limit: 500, offset: 0 });
    expect(ds.query.mock.calls[1][0]).toContain('LIMIT 500 OFFSET 0');
  });
  it('search text goes in as a bound parameter, never into the SQL text', async () => {
    const { svc, ds } = setup([]);
    await svc.list({ category: 'ready', search: "x'; DROP TABLE member_master;--" });
    expect(ds.query.mock.calls[0][0]).not.toContain('DROP TABLE');
    expect(ds.query.mock.calls[0][1]).toEqual(["%x'; DROP TABLE member_master;--%"]);
  });
  it('ready category note', async () => {
    const { svc } = setup([{ member_no: '1', name: 'A', retirement_date: '2020-01-01', rd_balance: 0, loan_balance: 0 }]);
    const r = await svc.list({ category: 'ready' });
    expect(r.rows[0].note).toMatch(/can be marked inactive/);
  });
  it('retired-rd note shows the RD balance', async () => {
    const { svc } = setup([{ member_no: '1', name: 'A', retirement_date: '2020-01-01', rd_balance: 12000, loan_balance: 0 }]);
    expect((await svc.list({ category: 'retired-rd' })).rows[0].note).toContain('12,000');
  });
  it('upcoming with zero RD gives the expected inactive month', async () => {
    const { svc } = setup([{ member_no: '1', name: 'A', retirement_date: '2027-03-15', rd_balance: 0, loan_balance: 0 }]);
    expect((await svc.list({ category: 'upcoming' })).rows[0].expectedInactiveMonth).toBe('2027-03');
  });
  it('upcoming with RD > 0 has no expected month and says RD must reach zero', async () => {
    const d = new Date(Date.now() + 10 * 86400000).toISOString().slice(0, 10);
    const { svc } = setup([{ member_no: '1', name: 'A', retirement_date: d, rd_balance: 500, loan_balance: 0 }]);
    const r = (await svc.list({ category: 'upcoming' })).rows[0];
    expect(r.expectedInactiveMonth).toBeNull(); expect(r.note).toMatch(/must reach zero/);
  });
  it('missing name becomes an empty string', async () => {
    const { svc } = setup([{ member_no: '1', name: null, retirement_date: '2020-01-01', rd_balance: 0, loan_balance: 0 }]);
    expect((await svc.list({ category: 'ready' })).rows[0].name).toBe('');
  });
});

describe('member-status/check', () => {
  it('404 for an unknown member', async () => {
    const { svc, ds } = mk(); ds.query.mockResolvedValue([]);
    await expect(svc.check('9')).rejects.toThrow(NotFoundException);
  });
  it('retired member with zero RD and loan is ready, no warnings', async () => {
    const { svc, ds } = mk(); ds.query.mockResolvedValue([row()]);
    expect(await svc.check('10')).toMatchObject({ active: true, readyToInactivate: true, warnings: [] });
  });
  it('not retired: warns with the date', async () => {
    const { svc, ds } = mk(); ds.query.mockResolvedValue([row({ retired: false, retirement_date: '2040-01-01' })]);
    const r = await svc.check('10');
    expect(r.readyToInactivate).toBe(false); expect(r.warnings[0]).toContain('2040-01-01');
  });
  it('no retirement date recorded is called out', async () => {
    const { svc, ds } = mk(); ds.query.mockResolvedValue([row({ retired: false, retirement_date: null })]);
    expect((await svc.check('10')).warnings[0]).toMatch(/No retirement date/);
  });
  it('RD and loan balances create warnings', async () => {
    const { svc, ds } = mk(); ds.query.mockResolvedValue([row({ rd_balance: 100, loan_balance: 2000 })]);
    const w = (await svc.check('10')).warnings;
    expect(w).toHaveLength(2); expect(w.join(' ')).toMatch(/RD balance.*Loan outstanding/);
  });
  it('active flag follows isactive', async () => {
    const { svc, ds } = mk(); ds.query.mockResolvedValue([row({ isactive: 'N' })]);
    expect((await svc.check('10')).active).toBe(false);
  });
});

describe('member-status/markInactive', () => {
  it('rejects an already inactive member', async () => {
    const { svc, ds } = mk(); ds.query.mockResolvedValue([row({ isactive: 'N' })]);
    await expect(svc.markInactive('10', 'reason', false, 'u')).rejects.toThrow(/already inactive/);
  });
  it('requires a reason of at least 3 characters', async () => {
    const { svc, ds } = mk(); ds.query.mockResolvedValue([row()]);
    for (const r of ['', '  ', 'ab', undefined as any]) await expect(svc.markInactive('10', r, false, 'u')).rejects.toThrow('A reason is required');
  });
  it('409 with the warnings when conditions are not met and not forced', async () => {
    const { svc, ds } = mk(); ds.query.mockResolvedValue([row({ rd_balance: 500 })]);
    await expect(svc.markInactive('10', 'retired', false, 'u')).rejects.toThrow(ConflictException);
  });
  it('force overrides the warnings and logs forced = true', async () => {
    const { svc, ds, em } = mk(); ds.query.mockResolvedValue([row({ rd_balance: 500 })]);
    await svc.markInactive('10', 'retired', true, 'u');
    expect(em.query.mock.calls[1][1][5]).toBe(true);
  });
  it('clean member: updates and logs once, in one transaction', async () => {
    const { svc, ds, em } = mk(); ds.query.mockResolvedValue([row()]);
    expect(await svc.markInactive('10', ' retired ', false, 'u')).toEqual({ memberNo: '10', active: false });
    expect(ds.transaction).toHaveBeenCalledTimes(1);
    expect(em.query.mock.calls[1][1][1]).toBe('retired');
  });
  it('a concurrent change (update touches no row) is rejected and nothing is logged', async () => {
    const { svc, ds, em } = mk(); ds.query.mockResolvedValue([row()]); em.query.mockResolvedValueOnce([]);
    await expect(svc.markInactive('10', 'retired', false, 'u')).rejects.toThrow(/already inactive/);
    expect(em.query).toHaveBeenCalledTimes(1);
  });
});

describe('member-status/reactivate', () => {
  it('rejects an already active member', async () => {
    const { svc, ds } = mk(); ds.query.mockResolvedValue([row()]);
    await expect(svc.reactivate('10', 'back', 'u')).rejects.toThrow(/already active/);
  });
  it('requires a reason', async () => {
    const { svc, ds } = mk(); ds.query.mockResolvedValue([row({ isactive: 'N' })]);
    await expect(svc.reactivate('10', 'x', 'u')).rejects.toThrow('A reason is required');
  });
  it('sets Y and logs REACTIVATE', async () => {
    const { svc, ds, em } = mk(); ds.query.mockResolvedValue([row({ isactive: 'N' })]);
    expect(await svc.reactivate('10', 'came back', 'u')).toEqual({ memberNo: '10', active: true });
    expect(em.query.mock.calls[0][0]).toContain("isactive = 'Y'");
    expect(em.query.mock.calls[1][0]).toContain("'REACTIVATE'");
  });
  it('history is read by member number as text', async () => {
    const { svc, ds } = mk(); ds.query.mockResolvedValue([]);
    await svc.history('10');
    expect(ds.query.mock.calls[0][1]).toEqual(['10']);
  });
});
