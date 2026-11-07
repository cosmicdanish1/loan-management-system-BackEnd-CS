import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { MemberCrudService } from '../../../src/modules/member/services-v2/member-crud.service';
import { MemberLookupService } from '../../../src/modules/member/services-v2/member-lookup.service';

const yearsAgo = (y: number) => { const d = new Date(); d.setFullYear(d.getFullYear() - y); return d.toISOString(); };
const dto = (o: any = {}) => ({ firstName: 'A', lastName: 'B', dateOfBirth: yearsAgo(30), address: 'x', phoneNumber: '9876543210', shareAmount: 1000, ...o });

function mk(cfg: Record<string, number> = { RULE_MEMBER_MIN_AGE: 18, RULE_MEMBER_MAX_AGE: 60, RULE_MEMBER_MIN_SHARE_AMT: 500 }) {
  const repo: any = {
    findOne: jest.fn().mockResolvedValue(null), create: jest.fn((x) => x), save: jest.fn(async (x) => ({ id: 1, ...x })), count: jest.fn().mockResolvedValue(0),
    createQueryBuilder: jest.fn(),
  };
  const qr: any = { connect: jest.fn(), startTransaction: jest.fn(), commitTransaction: jest.fn(), rollbackTransaction: jest.fn(), release: jest.fn(), query: jest.fn().mockResolvedValue([]) };
  const ds: any = { query: jest.fn().mockResolvedValue([]), createQueryRunner: jest.fn(() => qr) };
  const seq: any = { generateNextMemberNumber: jest.fn().mockResolvedValue('900000001'), peekNextMemberNumber: jest.fn().mockResolvedValue('900000001') };
  const sys: any = { getConfigValue: jest.fn(async (k: string) => cfg[k]) };
  const svc = new MemberCrudService(repo, repo, ds, seq, sys, { setMonthlyAmount: jest.fn() } as any);
  return { svc, repo, ds, qr, seq, sys };
}

describe('member/MemberCrudService.create', () => {
  it('rejects invalid data with the list of errors', async () => {
    await expect(mk().svc.create(dto({ firstName: '' }) as any)).rejects.toThrow(BadRequestException);
  });
  it('uses the configured age range (RULE_MEMBER_MAX_AGE = 60 rejects a 65 year old)', async () => {
    await expect(mk().svc.create(dto({ dateOfBirth: yearsAgo(65) }) as any)).rejects.toThrow(/between 18 and 60/);
  });
  it('enforces the configured minimum share capital', async () => {
    await expect(mk().svc.create(dto({ shareAmount: 100 }) as any)).rejects.toThrow(/Minimum share capital/);
  });
  it('a missing share amount counts as zero and is rejected when a minimum exists', async () => {
    await expect(mk().svc.create(dto({ shareAmount: undefined }) as any)).rejects.toThrow(/Minimum share capital/);
  });
  it('works when the age rules are not configured in system config (no crash, sensible defaults)', async () => {
    const { svc } = mk({});
    await expect(svc.create(dto() as any)).resolves.toBeDefined();
  });
  it('409 for a duplicate phone, email, Aadhar and PAN', async () => {
    for (const [field, extra] of [['phone', {}], ['email', { email: 'a@b.com' }], ['Aadhar', { aadharNumber: '123456789012' }], ['PAN', { panNumber: 'ABCDE1234F' }]] as any) {
      const { svc, repo } = mk();
      const order = field === 'phone' ? 0 : field === 'email' ? 1 : field === 'Aadhar' ? 1 : 1 + (extra.aadharNumber ? 1 : 0);
      for (let i = 0; i < order; i++) repo.findOne.mockResolvedValueOnce(null);
      repo.findOne.mockResolvedValueOnce({ id: 9 });
      await expect(svc.create(dto(extra) as any)).rejects.toThrow(ConflictException);
    }
  });
  it('saves ACTIVE with a formatted phone and a MEM number', async () => {
    const { svc, repo } = mk();
    repo.findOne.mockResolvedValue(null);
    await svc.create(dto() as any);
    const c = repo.create.mock.calls[0][0];
    expect(c).toMatchObject({ status: 'ACTIVE', phoneNumber: '919876543210', memberNumber: 'MEM000001' });
  });
  it('the next number follows the last id', async () => {
    const { svc, repo } = mk();
    repo.findOne.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: 41 });
    await svc.create(dto() as any);
    expect(repo.create.mock.calls[0][0].memberNumber).toBe('MEM000042');
  });
});

describe('member/MemberCrudService.findAll', () => {
  const qb = () => { const q: any = { andWhere: jest.fn().mockReturnThis(), orderBy: jest.fn().mockReturnThis(), skip: jest.fn().mockReturnThis(), take: jest.fn().mockReturnThis(), getManyAndCount: jest.fn().mockResolvedValue([[], 25]) }; return q; };
  it('paginates and reports page count', async () => {
    const { svc, repo } = mk(); const q = qb(); repo.createQueryBuilder.mockReturnValue(q);
    const r = await svc.findAll({ page: 3, limit: 10 } as any);
    expect(q.skip).toHaveBeenCalledWith(20); expect(q.take).toHaveBeenCalledWith(10);
    expect(r.pagination).toEqual({ page: 3, limit: 10, total: 25, pages: 3 });
  });
  it('search text is a bound parameter', async () => {
    const { svc, repo } = mk(); const q = qb(); repo.createQueryBuilder.mockReturnValue(q);
    await svc.findAll({ search: "x' OR 1=1" } as any);
    expect(q.andWhere.mock.calls[0][0]).not.toContain('1=1'); expect(q.andWhere.mock.calls[0][1]).toEqual({ search: "%x' OR 1=1%" });
  });
  it('applies each filter once', async () => {
    const { svc, repo } = mk(); const q = qb(); repo.createQueryBuilder.mockReturnValue(q);
    await svc.findAll({ memberNumber: 'M', firstName: 'f', lastName: 'l', phoneNumber: 'p', email: 'e', status: 'ACTIVE' } as any);
    expect(q.andWhere).toHaveBeenCalledTimes(6);
  });
  it('sort column goes in orderBy (validated by the DTO IsIn list)', async () => {
    const { svc, repo } = mk(); const q = qb(); repo.createQueryBuilder.mockReturnValue(q);
    await svc.findAll({ sortBy: 'firstName', sortOrder: 'ASC' } as any);
    expect(q.orderBy).toHaveBeenCalledWith('member.firstName', 'ASC');
  });
});

describe('member/MemberCrudService.findOne / update / remove / statistics', () => {
  it('findOne 404 when no member_master row', async () => {
    await expect(mk().svc.findOne(5)).rejects.toThrow(NotFoundException);
  });
  it('findOne returns the row', async () => {
    const { svc, ds } = mk(); ds.query.mockResolvedValue([{ mbno: 5 }]);
    expect(await svc.findOne(5)).toEqual({ mbno: 5 });
  });
  it('statistics counts each status', async () => {
    const { svc, repo } = mk(); repo.count.mockResolvedValueOnce(10).mockResolvedValueOnce(6).mockResolvedValueOnce(3).mockResolvedValueOnce(1);
    expect(await svc.getStatistics()).toEqual({ totalMembers: 10, activeMembers: 6, inactiveMembers: 3, suspendedMembers: 1 });
  });
  it('update 404 for an unknown member', async () => {
    await expect(mk().svc.update(1, {} as any)).rejects.toThrow(NotFoundException);
  });
  it('update with only a phone change must not demand the other required fields (partial update)', async () => {
    const { svc, repo } = mk(); repo.findOne.mockResolvedValue({ id: 1, phoneNumber: '919000000000' });
    await expect(svc.update(1, { phoneNumber: '9876543210' } as any)).resolves.toBeDefined();
  });
  it('update 409 when the new phone belongs to another member', async () => {
    const { svc, repo } = mk();
    repo.findOne.mockResolvedValueOnce({ id: 1, phoneNumber: '919000000000' }).mockResolvedValueOnce({ id: 2 });
    await expect(svc.update(1, dto({ phoneNumber: '9876543210' }) as any)).rejects.toThrow(ConflictException);
  });
  it('remove 404 for an unknown member', async () => {
    await expect(mk().svc.remove(5)).rejects.toThrow(NotFoundException);
  });
  it('remove refuses a member that has ledger entries and lists them', async () => {
    const { svc, ds } = mk();
    ds.query.mockResolvedValueOnce([{ mbno: 5 }]).mockResolvedValueOnce([{ n: 3 }]);
    ds.query.mockResolvedValue([{ n: 0, total: 0 }]);
    await expect(svc.remove(5)).rejects.toThrow(/3 ledger entries/);
  });
  it('remove refuses a member with a non-zero share / deposit balance', async () => {
    const { svc, ds } = mk();
    ds.query.mockImplementation(async (sql: string) => (/SELECT mbno FROM member_master/.test(sql) ? [{ mbno: 5 }] : /fundsmaster/.test(sql) ? [{ total: 100 }] : [{ n: 0 }]));
    await expect(svc.remove(5)).rejects.toThrow(/share \/ deposit balance/);
  });
  it('remove of a clean member deletes in one transaction and commits', async () => {
    const { svc, ds, qr } = mk();
    ds.query.mockImplementation(async (sql: string) => (/SELECT mbno FROM member_master/.test(sql) ? [{ mbno: 5 }] : /fundsmaster/.test(sql) ? [{ total: 0 }] : [{ n: 0 }]));
    await svc.remove(5);
    expect(qr.commitTransaction).toHaveBeenCalled(); expect(qr.release).toHaveBeenCalled();
    expect(qr.query.mock.calls.map((c: any[]) => c[0]).join(' ')).toContain('DELETE FROM member_master');
  });
  it('remove rolls back and releases when a delete fails', async () => {
    const { svc, ds, qr } = mk();
    ds.query.mockImplementation(async (sql: string) => (/SELECT mbno FROM member_master/.test(sql) ? [{ mbno: 5 }] : /fundsmaster/.test(sql) ? [{ total: 0 }] : [{ n: 0 }]));
    qr.query.mockRejectedValueOnce(new Error('fk'));
    await expect(svc.remove(5)).rejects.toThrow('fk');
    expect(qr.rollbackTransaction).toHaveBeenCalled(); expect(qr.release).toHaveBeenCalled();
  });
});

describe('member/MemberCrudService.saveMemberMaster (legacy member_master form)', () => {
  const data = (o: any = {}) => ({ f_name: 'A', officeno: 1, l_name: 'B', dob: '1990-01-01', memb_date: '2020-01-01', ...o });
  it('ES-481: an empty body gets plain field messages, nothing is written', async () => {
    const { svc, ds, qr } = mk();
    const err: any = await svc.saveMemberMaster({}).catch((e: any) => e);
    expect(err.getStatus()).toBe(400);
    const body = err.getResponse();
    expect(body.code).toBe('VALIDATION_FAILED');
    expect(body.message).toEqual(['First name is required.', 'Office is required.']);
    expect(body.errors.map((e: any) => e.field)).toEqual(['f_name', 'officeno']);
    expect(ds.query).not.toHaveBeenCalled(); expect(qr.query).not.toHaveBeenCalled();
  });
  it('ES-481: bad number and date values are named', async () => {
    const { svc } = mk();
    const err: any = await svc.saveMemberMaster(data({ age: 'abc', gross_salary: -5, dob: 'zz' })).catch((e: any) => e);
    expect(err.getResponse().message).toEqual(expect.arrayContaining(['Age must be a number.', 'Gross salary cannot be less than 0.', 'Date of birth must be a valid date.']));
  });
  it('update path: 404 when no row was updated', async () => {
    const { svc, ds } = mk(); ds.query.mockResolvedValue([]);
    await expect(svc.saveMemberMaster(data({ mbno: '900000005' }))).rejects.toThrow(NotFoundException);
  });
  it('update path returns the updated row and copies date_of_retirement into dor', async () => {
    const { svc, ds } = mk(); ds.query.mockResolvedValue([[{ mbno: '1' }, 1]]);
    await svc.saveMemberMaster(data({ mbno: '900000005', date_of_retirement: '2040-01-01' }));
    expect(ds.query.mock.calls[0][1][13]).toBe('2040-01-01');
  });
  it('insert path allocates a member number and commits', async () => {
    const { svc, qr, seq } = mk(); qr.query.mockResolvedValue([{ mbno: '900000001' }]);
    expect(await svc.saveMemberMaster(data())).toEqual({ mbno: '900000001' });
    expect(seq.generateNextMemberNumber).toHaveBeenCalled(); expect(qr.commitTransaction).toHaveBeenCalled();
  });
  it('insert path: a failure rolls back and releases', async () => {
    const { svc, qr } = mk(); qr.query.mockRejectedValue(new Error('dup'));
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    await expect(svc.saveMemberMaster(data())).rejects.toThrow('dup');
    expect(qr.rollbackTransaction).toHaveBeenCalled(); expect(qr.release).toHaveBeenCalled();
  });
  it('a member who joins at 50 or more gets the restricted FRS amount (fundsmaster.mdamt = 2)', async () => {
    const { svc, qr } = mk(); qr.query.mockResolvedValue([{ mbno: '1' }]);
    await svc.saveMemberMaster(data({ dob: '1960-01-01', memb_date: '2020-01-01' }));
    expect(qr.query.mock.calls.some((c: any[]) => /UPDATE fundsmaster SET mdamt = 2/.test(c[0]))).toBe(true);
  });
  it('a member who joins younger than 50 does not', async () => {
    const { svc, qr } = mk(); qr.query.mockResolvedValue([{ mbno: '1' }]);
    await svc.saveMemberMaster(data({ dob: '1990-01-01', memb_date: '2020-01-01' }));
    expect(qr.query.mock.calls.some((c: any[]) => /fundsmaster/.test(c[0]))).toBe(false);
  });
  it('initial compulsory deposit posts voucher, ledger, cashbook and balance in the same transaction', async () => {
    const { svc, qr } = mk(); qr.query.mockResolvedValue([{ mbno: '1', ledgerid: 5, next_id: 5, pflag: 'C' }]);
    (svc as any).sequenceGenerator.getNextVoucherNumber = jest.fn().mockResolvedValue(77);
    (svc as any).sequenceGenerator.getNextVoucherId = jest.fn().mockResolvedValue(8);
    await svc.saveMemberMaster(data({ compulsory_deposit: 500, startRd: false }));
    const sql = qr.query.mock.calls.map((c: any[]) => c[0]).join('\n');
    expect(sql).toContain('INSERT INTO vouchers'); expect(sql).toContain('INSERT INTO ledger'); expect(sql).toContain('INSERT INTO tblcashbook');
    expect(qr.commitTransaction).toHaveBeenCalled();
  });
});

describe('member/MemberLookupService', () => {
  const mkL = () => { const ds: any = { query: jest.fn().mockResolvedValue([]) }; return { svc: new MemberLookupService(ds), ds }; };
  beforeEach(() => jest.spyOn(console, 'log').mockImplementation(() => undefined));
  afterEach(() => jest.restoreAllMocks());
  it('default limit 500, max 1000', async () => {
    const { svc, ds } = mkL();
    await svc.lookupMembers(); expect(ds.query.mock.calls[0][1].slice(0, 2)).toEqual([500, 0]);
    await svc.lookupMembers('', 99999); expect(ds.query.mock.calls[1][1][0]).toBe(1000);
  });
  it('search is a bound parameter', async () => {
    const { svc, ds } = mkL();
    await svc.lookupMembers("a'; DROP TABLE x;--");
    expect(ds.query.mock.calls[0][0]).not.toContain('DROP TABLE'); expect(ds.query.mock.calls[0][1][2]).toBe("%a'; DROP TABLE x;--%");
  });
  it('a negative limit is not sent to the database as LIMIT -5', async () => {
    const { svc, ds } = mkL();
    await svc.lookupMembers('', -5);
    expect(ds.query.mock.calls[0][1][0]).toBeGreaterThan(0);
  });
  it('a database error is reported to the caller and not hidden as an empty list', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const { svc, ds } = mkL(); ds.query.mockRejectedValue(new Error('db down'));
    await expect(svc.lookupMembers('x')).rejects.toThrow('db down');
  });
});
