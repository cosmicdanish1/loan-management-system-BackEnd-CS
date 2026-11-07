import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { OfficeService } from '../../../src/modules/admin/services/office.service';
import { WingService } from '../../../src/modules/admin/services/wing.service';
import { DesignationService } from '../../../src/modules/admin/services/designation.service';
import { CastCategoryService } from '../../../src/modules/admin/services/cast-category.service';
import { MemberFundsService } from '../../../src/modules/admin/services/member-funds.service';
import { MemberBalanceService } from '../../../src/modules/admin/services/member-balance.service';
import { MemberAdminService } from '../../../src/modules/admin/services/member-admin.service';

const repo = (o: any = {}) => ({
  find: jest.fn().mockResolvedValue([]), findOne: jest.fn().mockResolvedValue(null), create: jest.fn((x) => ({ ...x })),
  save: jest.fn(async (x) => x), delete: jest.fn().mockResolvedValue({ affected: 1 }), ...o,
}) as any;
const dsCount = (n: number) => ({ query: jest.fn().mockResolvedValue([{ n }]) }) as any;

describe('admin/OfficeService', () => {
  it('findOne 404', async () => { await expect(new OfficeService(repo(), dsCount(0)).findOne(1)).rejects.toThrow(NotFoundException); });
  it('create saves the entity', async () => {
    const r = repo(); await new OfficeService(r, dsCount(0)).create({ officeId: 5, name: 'X' } as any);
    expect(r.save).toHaveBeenCalled();
  });
  it('create with an existing office id is refused (does not overwrite the existing office)', async () => {
    const r = repo({ findOne: jest.fn().mockResolvedValue({ officeId: 5, name: 'OLD' }) });
    await expect(new OfficeService(r, dsCount(0)).create({ officeId: 5, name: 'NEW' } as any)).rejects.toThrow(ConflictException);
  });
  it('update merges fields', async () => {
    const r = repo({ findOne: jest.fn().mockResolvedValue({ officeId: 5, name: 'OLD' }) });
    expect(await new OfficeService(r, dsCount(0)).update(5, { name: 'NEW' } as any)).toMatchObject({ name: 'NEW' });
  });
  it('remove 409 while members belong to the office', async () => {
    await expect(new OfficeService(repo(), dsCount(3)).remove(5)).rejects.toThrow(/3 member/);
  });
  it('remove 404 when nothing was deleted', async () => {
    await expect(new OfficeService(repo({ delete: jest.fn().mockResolvedValue({ affected: 0 }) }), dsCount(0)).remove(5)).rejects.toThrow(NotFoundException);
  });
  it('remove succeeds when unused', async () => { await expect(new OfficeService(repo(), dsCount(0)).remove(5)).resolves.toBeUndefined(); });
});

describe('admin/WingService', () => {
  it('findOne 404', async () => { await expect(new WingService(repo(), dsCount(0)).findOne('1')).rejects.toThrow(NotFoundException); });
  it('create with an existing wing id is refused', async () => {
    const r = repo({ findOne: jest.fn().mockResolvedValue({ wingId: '1' }) });
    await expect(new WingService(r, dsCount(0)).create({ wingId: '1', name: 'x' } as any)).rejects.toThrow(ConflictException);
  });
  it('remove 409 while members use it', async () => { await expect(new WingService(repo(), dsCount(2)).remove('1')).rejects.toThrow(ConflictException); });
  it('remove passes the id as text parameter', async () => {
    const ds = dsCount(0); await new WingService(repo(), ds).remove('7');
    expect(ds.query.mock.calls[0][1]).toEqual(['7']);
  });
});

describe('admin/DesignationService', () => {
  it('findAll orders by code', async () => {
    const r = repo(); await new DesignationService(r, {} as any).findAll();
    expect(r.find).toHaveBeenCalledWith({ order: { code: 'ASC' } });
  });
  it('findOne 404', async () => { await expect(new DesignationService(repo(), {} as any).findOne('A')).rejects.toThrow(NotFoundException); });
  it('create with an existing code is refused', async () => {
    const r = repo({ findOne: jest.fn().mockResolvedValue({ code: 'A', name: 'OLD' }) });
    await expect(new DesignationService(r, dsCount(0)).create({ code: 'A', name: 'NEW' } as any)).rejects.toThrow(ConflictException);
  });
  it('remove 404 when nothing deleted', async () => {
    await expect(new DesignationService(repo({ delete: jest.fn().mockResolvedValue({ affected: 0 }) }), dsCount(0)).remove('A')).rejects.toThrow(NotFoundException);
  });
  it('a designation that members use cannot be deleted', async () => {
    const r = repo({ findOne: jest.fn().mockResolvedValue({ code: 'A' }) });
    await expect(new DesignationService(r, dsCount(2)).remove('A')).rejects.toThrow(/2 member/);
    expect(r.delete).not.toHaveBeenCalled();
  });
});

describe('admin/CastCategoryService', () => {
  it('findOne 404', async () => { await expect(new CastCategoryService(repo()).findOne(1)).rejects.toThrow(NotFoundException); });
  it('create with an existing id is refused', async () => {
    const r = repo({ findOne: jest.fn().mockResolvedValue({ id: 1, name: 'OLD' }) });
    await expect(new CastCategoryService(r).create({ id: 1, name: 'NEW' } as any)).rejects.toThrow(ConflictException);
  });
  it('update merges', async () => {
    const r = repo({ findOne: jest.fn().mockResolvedValue({ id: 1, name: 'A' }) });
    expect(await new CastCategoryService(r).update(1, { name: 'B' } as any)).toMatchObject({ name: 'B' });
  });
  it('remove 404', async () => {
    await expect(new CastCategoryService(repo({ delete: jest.fn().mockResolvedValue({ affected: 0 }) })).remove(1)).rejects.toThrow(NotFoundException);
  });
});

describe('admin/MemberFundsService', () => {
  const mk = (member?: any, existing?: any) => {
    const r = repo({ findOne: jest.fn().mockResolvedValue(existing ?? null), manager: { query: jest.fn().mockResolvedValue(member ? [member] : []) } });
    return { svc: new MemberFundsService(r), r };
  };
  it('findByMember returns zero defaults for a member without a row', async () => {
    expect(await mk().svc.findByMember(5)).toMatchObject({ memberNo: 5, monthlyContributionInstallment: 0, sharesInstallment: 0 });
  });
  it('getMemberList returns text member numbers', async () => {
    const { svc, r } = mk(); r.find.mockResolvedValue([{ memberNo: 1 }, { memberNo: 2 }]);
    expect(await svc.getMemberList()).toEqual(['1', '2']);
  });
  it('a member who joined at 50+ may only have the 2 rupee contribution', async () => {
    const { svc } = mk({ dob: '1960-01-01', memb_date: '2020-01-01' });
    await expect(svc.updateBalances(5, { monthlyContributionInstallment: 100 } as any)).rejects.toThrow(BadRequestException);
  });
  it('the 2 rupee contribution is allowed for a 50+ member', async () => {
    const { svc } = mk({ dob: '1960-01-01', memb_date: '2020-01-01' });
    await expect(svc.updateBalances(5, { monthlyContributionInstallment: 2 } as any)).resolves.toBeDefined();
  });
  it('a member under 50 may have any contribution', async () => {
    const { svc } = mk({ dob: '1990-01-01', memb_date: '2020-01-01' });
    await expect(svc.updateBalances(5, { monthlyContributionInstallment: 100 } as any)).resolves.toBeDefined();
  });
  it('updating the funds of a member that does not exist is refused (no orphan row)', async () => {
    const { svc } = mk(undefined, undefined);
    await expect(svc.updateBalances(987654321, { sharesInstallment: 5 } as any)).rejects.toThrow(NotFoundException);
  });
  it('updating existing funds merges into the row', async () => {
    const { svc } = mk({ dob: '1990-01-01' }, { memberNo: 5, sharesInstallment: 1 });
    expect(await svc.updateBalances(5, { sharesInstallment: 9 } as any)).toMatchObject({ sharesInstallment: 9 });
  });
});

describe('admin/MemberBalanceService + MemberAdminService', () => {
  it('findOne 404', async () => { await expect(new MemberBalanceService(repo()).findOne(5)).rejects.toThrow(NotFoundException); });
  it('update of a member without balances row creates one for a REAL member only', async () => {
    const r = repo(); r.manager = { query: jest.fn().mockResolvedValue([]) };
    await expect(new MemberBalanceService(r).update(987654321, { shareBalance: 5 } as any)).rejects.toThrow(NotFoundException);
  });
  it('updateOffice 404 for an unknown member', async () => {
    await expect(new MemberAdminService(repo()).updateOffice(5, '2')).rejects.toThrow(NotFoundException);
  });
  it('updateOffice changes the office id', async () => {
    const r = repo({ findOne: jest.fn().mockResolvedValue({ memberNo: 5, officeId: '1' }) });
    expect(await new MemberAdminService(r).updateOffice(5, '2')).toMatchObject({ officeId: '2' });
  });
});
