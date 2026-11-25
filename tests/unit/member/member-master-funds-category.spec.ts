// Member Master save writes the funds table and the member category as the legacy does.
import { BadRequestException } from '@nestjs/common';
import { MemberCrudService } from '../../../src/modules/member/services-v2/member-crud.service';

type Opts = { existing?: any; noFundsRow?: boolean; typeRows?: any[]; castRows?: any[]; insertError?: any };
function mk(opts: Opts = {}) {
  const calls: Array<{ sql: string; params?: any[] }> = [];
  const row = { mbno: '300', f_name: 'A' };
  const handle = async (sql: string, params?: any[]) => {
    calls.push({ sql, params });
    if (/SELECT \* FROM member_master WHERE mbno/.test(sql)) return opts.existing ? [opts.existing] : [];
    if (/WHERE btrim\(pfno\)/.test(sql)) return [];
    if (/FROM membertypemaster/.test(sql)) return opts.typeRows ?? [{ id: 2 }];
    if (/FROM castcategorymaster/.test(sql)) return opts.castRows ?? [{ id: 6 }];
    if (/^\s*UPDATE fundsmaster/.test(sql)) return opts.noFundsRow ? [[], 0] : [[{ mbno: '300' }], 1];
    if (/^\s*UPDATE membercategory/.test(sql)) return [[{ mbno: '300' }], 1];
    if (/^\s*UPDATE member_master/.test(sql)) return [[row], 1];
    if (/INSERT INTO member_master/.test(sql) && opts.insertError) throw opts.insertError;
    return [row];
  };
  const qr: any = { connect: jest.fn(), startTransaction: jest.fn(), commitTransaction: jest.fn(), rollbackTransaction: jest.fn(), release: jest.fn(), query: jest.fn(handle) };
  const ds: any = { query: jest.fn(handle), createQueryRunner: jest.fn(() => qr) };
  const seq: any = { generateNextMemberNumber: jest.fn().mockResolvedValue('9000000001'), getNextVoucherNumber: jest.fn().mockResolvedValue('V1') };
  const svc = new MemberCrudService({} as any, {} as any, ds, seq, {} as any, { setMonthlyAmount: jest.fn() } as any);
  (MemberCrudService as any).emailColumnReady = true;
  return { svc, calls, qr, ds };
}
const base = (o: any = {}) => ({ f_name: 'Ravi', officeno: 1, wingno: '1', sex: 'M', ...o });
const find = (calls: any[], re: RegExp) => calls.find((c) => re.test(c.sql));

describe('funds table (Monthly Contribution = MDAMT, Compulsory Deposit = CDAMT)', () => {
  it('an edit writes both amounts', async () => {
    const { svc, calls } = mk({ existing: { mbno: '300', pfno: '' } });
    await svc.saveMemberMaster(base({ mbno: '300', monthly_contribution: 0, compulsory_deposit: 200 }));
    expect(find(calls, /^\s*UPDATE fundsmaster/)!.params).toEqual(['300', 0, 200]);
  });

  it('a member with no funds row gets one', async () => {
    const { svc, calls } = mk({ existing: { mbno: '300', pfno: '' }, noFundsRow: true });
    await svc.saveMemberMaster(base({ mbno: '300', monthly_contribution: 8, compulsory_deposit: 200 }));
    expect(find(calls, /^\s*INSERT INTO fundsmaster/)!.params).toEqual(['300', 8, 200]);
  });

  it('an amount that was not sent is passed as null so the stored one is kept', async () => {
    const { svc, calls } = mk({ existing: { mbno: '300', pfno: '' } });
    await svc.saveMemberMaster(base({ mbno: '300', monthly_contribution: 8 }));
    expect(find(calls, /^\s*UPDATE fundsmaster/)!.params).toEqual(['300', 8, null]);
  });

  it('nothing sent: the funds table is not touched', async () => {
    const { svc, calls } = mk({ existing: { mbno: '300', pfno: '' } });
    await svc.saveMemberMaster(base({ mbno: '300' }));
    expect(calls.some((c) => /fundsmaster/.test(c.sql))).toBe(false);
  });

  it('empty amounts count as not sent', async () => {
    const { svc, calls } = mk({ existing: { mbno: '300', pfno: '' } });
    await svc.saveMemberMaster(base({ mbno: '300', monthly_contribution: '', compulsory_deposit: '' }));
    expect(calls.some((c) => /fundsmaster/.test(c.sql))).toBe(false);
  });

  it('a new member is saved with a funds row inside the same transaction', async () => {
    const { svc, calls, qr } = mk();
    await svc.saveMemberMaster(base({ mbno: 'auto', monthly_contribution: 8, compulsory_deposit: 0 }));
    expect(find(calls, /^\s*UPDATE fundsmaster/)).toBeDefined();
    expect(qr.commitTransaction).toHaveBeenCalled();
  });
});

describe('member type and cast category (MEMBERCATEGORY)', () => {
  it('names are turned into ids: member type "Other Nominal" and cast "OBC"', async () => {
    const { svc, calls } = mk({ existing: { mbno: '300', pfno: '' } });
    await svc.saveMemberMaster(base({ mbno: '300', member_type: 'other nominal', cast_category: 'obc' }));
    expect(find(calls, /^\s*UPDATE membercategory/)!.params).toEqual(['300', 6, 2]);
  });

  it('a member type sent as a number is used as it is', async () => {
    const { svc, calls } = mk({ existing: { mbno: '300', pfno: '' } });
    await svc.saveMemberMaster(base({ mbno: '300', member_type: '3' }));
    expect(find(calls, /^\s*UPDATE membercategory/)!.params).toEqual(['300', null, 3]);
  });

  it('an unknown member type name is refused (400) and no category row is written', async () => {
    const { svc, calls } = mk({ existing: { mbno: '300', pfno: '' }, typeRows: [] });
    await expect(svc.saveMemberMaster(base({ mbno: '300', member_type: 'Nonsense' }))).rejects.toThrow(BadRequestException);
    expect(calls.some((c) => /^\s*(UPDATE|INSERT) (INTO )?membercategory/.test(c.sql))).toBe(false);
  });

  it('a cast category that is not in the master leaves the stored code alone', async () => {
    const { svc, calls } = mk({ existing: { mbno: '300', pfno: '' }, castRows: [] });
    await svc.saveMemberMaster(base({ mbno: '300', member_type: 'Regular', cast_category: 'Unknown' }));
    expect(find(calls, /^\s*UPDATE membercategory/)!.params).toEqual(['300', null, 2]);
  });

  it('neither sent: the category table is not touched', async () => {
    const { svc, calls } = mk({ existing: { mbno: '300', pfno: '' } });
    await svc.saveMemberMaster(base({ mbno: '300' }));
    expect(calls.some((c) => /membercategory/.test(c.sql))).toBe(false);
  });
});

describe('gross salary is no longer written by the screen', () => {
  it('an edit that does not send it keeps the stored value', async () => {
    const { svc, calls } = mk({ existing: { mbno: '300', pfno: '', gross_salary: 30000 } });
    await svc.saveMemberMaster(base({ mbno: '300' }));
    expect(find(calls, /^\s*UPDATE member_master/)!.params![14]).toBe(30000);
  });
  it('a new member that does not send it gets 0, not null', async () => {
    const { svc, calls } = mk();
    await svc.saveMemberMaster(base({ mbno: 'auto' }));
    expect(find(calls, /INSERT INTO member_master/)!.params![14]).toBe(0);
  });
});

describe('member number taken at the same moment', () => {
  it('the trigger message becomes a friendly "save again" answer', async () => {
    const { svc } = mk({ insertError: new Error('MEMBER_NUMBER_EXISTS') });
    await expect(svc.saveMemberMaster(base({ mbno: 'auto' }))).rejects.toThrow(/save again/);
  });
});
