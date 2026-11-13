import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { NoticeService } from '../../../src/modules/notice/services/notice.service';
import { NoticeController } from '../../../src/modules/notice/controllers/notice.controller';
import { DashboardSummaryService } from '../../../src/modules/notice/services/dashboard-summary.service';

function build(minSort: number | null = 5, rows: any[] = []) {
  const qb: any = {
    select: jest.fn().mockReturnThis(), getRawOne: jest.fn(async () => ({ minSortOrder: minSort })),
    where: jest.fn().mockReturnThis(), orderBy: jest.fn().mockReturnThis(), addOrderBy: jest.fn().mockReturnThis(),
    getMany: jest.fn(async () => rows),
  };
  const repo: any = {
    find: jest.fn(async () => []),
    findOne: jest.fn(async ({ where }: any) => rows.find(r => r.id === where.id) ?? null),
    createQueryBuilder: jest.fn(() => qb),
    create: jest.fn((x: any) => ({ ...x })),
    save: jest.fn(async (x: any) => ({ id: 1, ...x })),
    update: jest.fn(async () => ({})),
    delete: jest.fn(async () => ({ affected: 1 })),
  };
  return { svc: new NoticeService(repo), repo, qb };
}
const input = { title: 'T', message: 'M', type: 'info' as any, postedBy: 'admin' };
const admin = { username: 'admin', isAdmin: true };
const clerk = { username: 'clerk', isAdmin: false };
const other = { username: 'other', isAdmin: false };

describe('NoticeService', () => {
  it('lists notices for everyone plus the viewer\'s own private notes, important first', async () => {
    const { svc, qb } = build(5, [{ id: 1, postedBy: 'clerk', isPrivate: true }, { id: 2, postedBy: 'admin', isPrivate: false }]);
    const list = await svc.findAll(clerk);
    expect(qb.where).toHaveBeenCalledWith('n.is_private = false OR n.posted_by = :u', { u: 'clerk' });
    expect(qb.orderBy).toHaveBeenCalledWith('n.is_important', 'DESC');
    expect(list.map((n: any) => [n.id, n.mine, n.canManage])).toEqual([[1, true, true], [2, false, false]]);
  });
  it('a new notice goes to the top (one less than the current smallest sort order)', async () => {
    const { svc } = build(5);
    expect((await svc.create(input, admin)).sortOrder).toBe(4);
  });
  it('the first notice ever gets sort order 0', async () => {
    const { svc } = build(null);
    expect((await svc.create(input, admin)).sortOrder).toBe(0);
  });
  it('a sort order sent by the client is ignored', async () => {
    const { svc } = build(5);
    expect((await svc.create({ ...input, sortOrder: -999 } as any, admin)).sortOrder).toBe(4);
  });
  it('reorder writes the position of each id', async () => {
    const { svc, repo } = build();
    await svc.reorder([30, 10, 20]);
    expect(repo.update.mock.calls.map((c: any) => [c[0].id, c[1].sortOrder])).toEqual([[30, 0], [10, 1], [20, 2]]);
  });
  it('removing a missing notice is a 404', async () => {
    await expect(build().svc.remove(9, admin)).rejects.toBeInstanceOf(NotFoundException);
  });
  it('the author and an administrator can remove a notice; another user cannot', async () => {
    const rows = [{ id: 1, postedBy: 'clerk', isPrivate: false }];
    await expect(build(5, rows).svc.remove(1, clerk)).resolves.toBeUndefined();
    await expect(build(5, rows).svc.remove(1, admin)).resolves.toBeUndefined();
    await expect(build(5, rows).svc.remove(1, other)).rejects.toBeInstanceOf(ForbiddenException);
  });
  it('someone else\'s private note looks missing, even to an administrator', async () => {
    const rows = [{ id: 1, postedBy: 'clerk', isPrivate: true }];
    await expect(build(5, rows).svc.remove(1, admin)).rejects.toBeInstanceOf(NotFoundException);
    await expect(build(5, rows).svc.setPrivate(1, false, other)).rejects.toBeInstanceOf(NotFoundException);
  });
  it('the author publishes a private note; only the author can change who sees it', async () => {
    const rows = [{ id: 1, postedBy: 'clerk', isPrivate: true }];
    expect((await build(5, rows).svc.setPrivate(1, false, clerk)).isPrivate).toBe(false);
    const pub = [{ id: 2, postedBy: 'clerk', isPrivate: false }];
    await expect(build(5, pub).svc.setPrivate(2, true, admin)).rejects.toBeInstanceOf(ForbiddenException);
  });
  it('taking a notice back to private clears important and the mobile audience', async () => {
    const rows = [{ id: 1, postedBy: 'admin', isPrivate: false, isImportant: true, showOnMobile: true, audienceWing: '1', audienceOffice: 2 }];
    const n: any = await build(5, rows).svc.setPrivate(1, true, admin);
    expect([n.isPrivate, n.isImportant, n.showOnMobile, n.audienceWing, n.audienceOffice]).toEqual([true, false, false, null, null]);
  });
});

describe('NoticeController', () => {
  const ctl = () => { const b = build(); return { c: new NoticeController(b.svc), ...b }; };
  it('reorder rejects a body that is not a list of ids (this used to crash with a 500)', async () => {
    const { c } = ctl();
    await expect(c.reorder({} as any)).rejects.toBeInstanceOf(BadRequestException);
    await expect(c.reorder(undefined as any)).rejects.toBeInstanceOf(BadRequestException);
    await expect(c.reorder({ orderedIds: 'x' } as any)).rejects.toBeInstanceOf(BadRequestException);
  });
  it('reorder with a list of non-numbers is a 400, not a database error', async () => {
    const { c } = ctl();
    await expect(c.reorder({ orderedIds: ['a', null, {}] as any })).rejects.toBeInstanceOf(BadRequestException);
  });
  it('create rejects an empty title or message', async () => {
    const { c } = ctl();
    await expect(c.create({ ...input, title: '   ' })).rejects.toBeInstanceOf(BadRequestException);
    await expect(c.create({ ...input, message: '' })).rejects.toBeInstanceOf(BadRequestException);
  });
  it('create rejects an unknown notice type', async () => {
    const { c } = ctl();
    await expect(c.create({ ...input, type: 'HACK' as any })).rejects.toBeInstanceOf(BadRequestException);
  });
  it('create takes the poster from the logged-in user, not from the body', async () => {
    const { c, repo } = ctl();
    await (c as any).create({ ...input, postedBy: 'someone-else' }, { user: { username: 'real-user' } });
    expect(repo.create.mock.calls[0][0].postedBy).toBe('real-user');
  });
  it('only an administrator can mark a notice important', async () => {
    const { c, repo } = ctl();
    await expect((c as any).create({ ...input, isImportant: true }, { user: { username: 'clerk', role: 'clerk' } })).rejects.toBeInstanceOf(ForbiddenException);
    await (c as any).create({ ...input, isImportant: true }, { user: { username: 'boss', role: 'admin' } });
    expect(repo.create.mock.calls[0][0].isImportant).toBe(true);
  });
  it('a private note cannot be important, go to phones, or take an unknown colour', async () => {
    const { c } = ctl();
    const boss = { user: { username: 'boss', role: 'admin' } };
    await expect((c as any).create({ ...input, isPrivate: true, isImportant: true }, boss)).rejects.toBeInstanceOf(BadRequestException);
    await expect((c as any).create({ ...input, isPrivate: true, showOnMobile: true }, boss)).rejects.toBeInstanceOf(BadRequestException);
    await expect((c as any).create({ ...input, isPrivate: true, color: 'neon' }, boss)).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('DashboardSummaryService', () => {
  const svc = (impl: (sql: string) => any) => new DashboardSummaryService({ query: jest.fn(async (sql: string) => impl(sql)) } as any);

  it('one failing section leaves only that section null', async () => {
    const s = svc((sql) => {
      if (/FROM fdmaster\s+WHERE coalesce/.test(sql) && /LIMIT 100/.test(sql)) throw new Error('boom');
      if (/loan_pending/.test(sql)) return [{ pending_count: 2, pending_amount: 100, sanctioned_count: 1, sanctioned_amount: 50, disbursed_count: 0, disbursed_amount: 0 }];
      if (/member_master WHERE memb_date/.test(sql)) return [{ new_this_month: 3, new_last_month: 4 }];
      if (/FROM demand_master/.test(sql)) return [{ demand: 1000, recovered: 400, members: 10 }];
      if (/count\(\*\)::int AS n FROM member_master/.test(sql)) return [{ n: 0 }];
      if (/FROM fdmaster/.test(sql) && /fd_count/.test(sql)) return [{ fd_count: 1, fd_amount: 2, sb_count: 3, sb_amount: 4, shares: 5, compulsory: 6 }];
      return [];
    });
    const r: any = await s.getSummary();
    expect(r.maturities).toBeNull();
    expect(r.applications).toEqual({ pending: { count: 2, amount: 100 }, sanctioned: { count: 1, amount: 50 }, disbursedThisMonth: { count: 0, amount: 0 } });
    expect(r.members).toEqual({ newThisMonth: 3, newLastMonth: 4 });
    expect(r.demand).toEqual({ demand: 1000, recovered: 400, members: 10 });
    expect(r.deposits.fixedRecurring).toEqual({ count: 1, amount: 2 });
    expect(typeof r.generatedAt).toBe('string');
  });
  it('every section failing still returns an object with nulls', async () => {
    const r: any = await svc(() => { throw new Error('down'); }).getSummary();
    expect([r.deposits, r.maturities, r.applications, r.members, r.retiring, r.demand]).toEqual([null, null, null, null, null, null]);
  });
});
