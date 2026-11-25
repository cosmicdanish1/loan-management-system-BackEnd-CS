// Member Master save: Personal Number is unique (ES-652) and odd dates are handled (ES-382).
import { BadRequestException, ConflictException } from '@nestjs/common';
import { MemberCrudService } from '../../../src/modules/member/services-v2/member-crud.service';

const TAKEN = 'This Personal Number is already registered. A member account with this Personal Number already exists.';

function mk(opts: { existing?: any; pfnoHolder?: boolean; insertError?: any } = {}) {
  const calls: Array<{ sql: string; params?: any[] }> = [];
  const row = { mbno: '300', f_name: 'A' };
  const ds: any = {
    query: jest.fn(async (sql: string, params?: any[]) => {
      calls.push({ sql, params });
      if (/SELECT \* FROM member_master WHERE mbno/.test(sql)) return opts.existing ? [opts.existing] : [];
      if (/WHERE btrim\(pfno\)/.test(sql)) return opts.pfnoHolder ? [{ mbno: '111' }] : [];
      if (/^\s*UPDATE member_master/.test(sql)) return [[row], 1];
      return [];
    }),
  };
  const qr: any = {
    connect: jest.fn(), startTransaction: jest.fn(), commitTransaction: jest.fn(), rollbackTransaction: jest.fn(), release: jest.fn(),
    query: jest.fn(async (sql: string, params?: any[]) => {
      calls.push({ sql, params });
      if (/INSERT INTO member_master/.test(sql) && opts.insertError) throw opts.insertError;
      return [row];
    }),
  };
  ds.createQueryRunner = jest.fn(() => qr);
  const seq: any = { generateNextMemberNumber: jest.fn().mockResolvedValue('9000000001'), getNextVoucherNumber: jest.fn().mockResolvedValue('V1') };
  const svc = new MemberCrudService({} as any, {} as any, ds, seq, {} as any, { setMonthlyAmount: jest.fn() } as any);
  (MemberCrudService as any).emailColumnReady = true;
  return { svc, calls, qr, ds };
}
const base = (o: any = {}) => ({ f_name: 'Ravi', officeno: 1, wingno: '1', sex: 'M', compulsory_deposit: 0, ...o });
const pfCheck = (calls: any[]) => calls.filter((c) => /WHERE btrim\(pfno\)/.test(c.sql));

describe('Personal Number is unique (ES-652)', () => {
  it('a new member with a number another member holds is refused (409) with the agreed message and nothing is inserted', async () => {
    const { svc, calls, qr } = mk({ pfnoHolder: true });
    await expect(svc.saveMemberMaster(base({ mbno: 'auto', pfno: '405455' }))).rejects.toThrow(new ConflictException(TAKEN));
    expect(calls.some((c) => /INSERT INTO member_master/.test(c.sql))).toBe(false);
    expect(qr.startTransaction).not.toHaveBeenCalled();
  });

  it('a new member with a free number is saved; the number is compared trimmed', async () => {
    const { svc, calls } = mk();
    await svc.saveMemberMaster(base({ mbno: 'auto', pfno: '  777  ' }));
    expect(pfCheck(calls)[0].params).toEqual(['777', null]);
    expect(calls.some((c) => /INSERT INTO member_master/.test(c.sql))).toBe(true);
  });

  it.each([[''], ['   '], [undefined], [null]])('a blank Personal Number %j is never compared (many members have none)', async (pf) => {
    const { svc, calls } = mk();
    await svc.saveMemberMaster(base({ mbno: 'auto', pfno: pf }));
    expect(pfCheck(calls)).toHaveLength(0);
  });

  it('an edit that changes the number to a taken one is refused', async () => {
    const { svc } = mk({ existing: { mbno: '300', pfno: '100' }, pfnoHolder: true });
    await expect(svc.saveMemberMaster(base({ mbno: '300', pfno: '405455' }))).rejects.toThrow(TAKEN);
  });

  it('an edit that changes the number to a free one is saved, and the member itself is excluded from the check', async () => {
    const { svc, calls } = mk({ existing: { mbno: '300', pfno: '100' } });
    await svc.saveMemberMaster(base({ mbno: '300', pfno: '101' }));
    expect(pfCheck(calls)[0].params).toEqual(['101', '300']);
    expect(calls.some((c) => /^\s*UPDATE member_master/.test(c.sql))).toBe(true);
  });

  it('an edit that keeps the number is never refused, even if the migrated data shares it with another member', async () => {
    const { svc, calls } = mk({ existing: { mbno: '300', pfno: '405455' }, pfnoHolder: true });
    await expect(svc.saveMemberMaster(base({ mbno: '300', pfno: '405455', remarks: 'x' }))).resolves.toBeDefined();
    expect(pfCheck(calls)).toHaveLength(0);
  });

  it('two saves at the same moment: the database refuses the second (23505) and the user sees the same message, with a rollback', async () => {
    const { svc, qr } = mk({ insertError: Object.assign(new Error('duplicate'), { code: '23505' }) });
    await expect(svc.saveMemberMaster(base({ mbno: 'auto', pfno: '888' }))).rejects.toThrow(TAKEN);
    expect(qr.rollbackTransaction).toHaveBeenCalled();
    expect(qr.release).toHaveBeenCalled();
  });

  it('the trigger message is mapped even without a code', async () => {
    const { svc } = mk({ insertError: new Error('PERSONAL_NUMBER_EXISTS') });
    await expect(svc.saveMemberMaster(base({ mbno: 'auto', pfno: '888' }))).rejects.toThrow(ConflictException);
  });

  it('any other database error is not turned into the Personal Number message', async () => {
    const { svc } = mk({ insertError: new Error('connection lost') });
    await expect(svc.saveMemberMaster(base({ mbno: 'auto', pfno: '888' }))).rejects.toThrow('connection lost');
  });

  it('100 different new numbers in a row all pass; each is checked once (stress)', async () => {
    const { svc, calls } = mk();
    for (let i = 0; i < 100; i++) await svc.saveMemberMaster(base({ mbno: 'auto', pfno: String(5000 + i) }));
    expect(pfCheck(calls)).toHaveLength(100);
  });
});

describe('odd dates (ES-382)', () => {
  it.each([['1900-01-01'], ['1900-01-01T00:00:00.000Z'], ['1899-12-31'], [new Date('1900-01-01')]])('placeholder retirement date %j is saved as empty', async (v) => {
    const { svc, calls } = mk({ existing: { mbno: '300', pfno: '' } });
    await svc.saveMemberMaster(base({ mbno: '300', dor: v, date_of_retirement: v, dob: '1970-01-01' }));
    const upd = calls.find((c) => /^\s*UPDATE member_master/.test(c.sql))!;
    expect(upd.params![13]).toBeNull(); // $14 = dor
  });

  it('the placeholder withdrawal date is saved as empty too', async () => {
    const { svc, calls } = mk({ existing: { mbno: '300', pfno: '' } });
    await svc.saveMemberMaster(base({ mbno: '300', supanuationdate: '1900-01-01' }));
    expect(calls.find((c) => /^\s*UPDATE member_master/.test(c.sql))!.params![34]).toBeNull();
  });

  it('a real retirement date is kept', async () => {
    const { svc, calls } = mk({ existing: { mbno: '300', pfno: '' } });
    await svc.saveMemberMaster(base({ mbno: '300', dor: '2030-05-31', dob: '1970-05-14' }));
    expect(String(calls.find((c) => /^\s*UPDATE member_master/.test(c.sql))!.params![13])).toContain('2030-05-31');
  });

  it('isPlaceholderDate', () => {
    expect(MemberCrudService.isPlaceholderDate('1900-01-01')).toBe(true);
    expect(MemberCrudService.isPlaceholderDate('1901-01-01')).toBe(false);
    expect(MemberCrudService.isPlaceholderDate('2018-01-01')).toBe(false);
    expect(MemberCrudService.isPlaceholderDate(null)).toBe(false);
    expect(MemberCrudService.isPlaceholderDate('')).toBe(false);
    expect(MemberCrudService.isPlaceholderDate('not a date')).toBe(false);
  });

  it('a membership date before the birth date is refused (400) for a new member', async () => {
    const { svc } = mk();
    await expect(svc.saveMemberMaster(base({ mbno: 'auto', dob: '1990-05-01', memb_date: '1988-05-12' }))).rejects.toThrow(BadRequestException);
  });

  it('on an edit it is refused only when the dates are changed; other edits of a migrated member still work', async () => {
    const existing = { mbno: '300', pfno: '', dob: '1990-05-01', memb_date: '1988-05-12' };
    const ok = mk({ existing });
    await expect(ok.svc.saveMemberMaster(base({ mbno: '300', dob: '1990-05-01', memb_date: '1988-05-12', remarks: 'x' }))).resolves.toBeDefined();
    const bad = mk({ existing });
    await expect(bad.svc.saveMemberMaster(base({ mbno: '300', dob: '1990-05-01', memb_date: '1989-01-01' }))).rejects.toMatchObject({ response: { message: [expect.stringContaining('Membership date cannot be before')] } });
  });

  it('membership on the birth day passes the date-order check (the minimum-age rule then refuses a newborn)', async () => {
    const { svc } = mk();
    await expect(svc.saveMemberMaster(base({ mbno: 'auto', dob: '1990-05-01', memb_date: '1990-05-01' }))).rejects.toMatchObject({ response: { message: [expect.stringContaining('at least 18 years old')] } });
  });

  it('a birth date in the future is still refused', async () => {
    const { svc } = mk();
    await expect(svc.saveMemberMaster(base({ mbno: 'auto', dob: '2099-01-01' }))).rejects.toThrow(BadRequestException);
  });
});

describe('Personal Number spaces', () => {
  it('spaces around the number are removed before the length check and before saving', async () => {
    const { svc, calls } = mk();
    await svc.saveMemberMaster(base({ mbno: 'auto', pfno: '   123456789   ' })); // 9 characters once trimmed (limit 10)
    const ins = calls.find((c) => /INSERT INTO member_master/.test(c.sql))!;
    expect(ins.params).toContain('123456789');
    expect(pfCheck(calls)[0].params![0]).toBe('123456789');
  });
});
