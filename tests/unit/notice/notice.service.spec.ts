import { BadRequestException, NotFoundException } from '@nestjs/common';
import { NoticeService } from '../../../src/modules/notice/services/notice.service';
import { NoticeController } from '../../../src/modules/notice/controllers/notice.controller';
import { DashboardSummaryService } from '../../../src/modules/notice/services/dashboard-summary.service';

function build(minSort: number | null = 5) {
  const qb: any = { select: jest.fn().mockReturnThis(), getRawOne: jest.fn(async () => ({ minSortOrder: minSort })) };
  const repo: any = {
    find: jest.fn(async () => []),
    createQueryBuilder: jest.fn(() => qb),
    create: jest.fn((x: any) => ({ ...x })),
    save: jest.fn(async (x: any) => ({ id: 1, ...x })),
    update: jest.fn(async () => ({})),
    delete: jest.fn(async () => ({ affected: 1 })),
  };
  return { svc: new NoticeService(repo), repo, qb };
}
const input = { title: 'T', message: 'M', type: 'info' as any, postedBy: 'admin' };

describe('NoticeService', () => {
  it('lists by sort order, newest first within a tie', async () => {
    const { svc, repo } = build();
    await svc.findAll();
    expect(repo.find).toHaveBeenCalledWith({ order: { sortOrder: 'ASC', createdAt: 'DESC' } });
  });
  it('a new notice goes to the top (one less than the current smallest sort order)', async () => {
    const { svc } = build(5);
    expect((await svc.create(input)).sortOrder).toBe(4);
  });
  it('the first notice ever gets sort order 0', async () => {
    const { svc } = build(null);
    expect((await svc.create(input)).sortOrder).toBe(0);
  });
  it('a sort order sent by the client is ignored', async () => {
    const { svc } = build(5);
    expect((await svc.create({ ...input, sortOrder: -999 } as any)).sortOrder).toBe(4);
  });
  it('reorder writes the position of each id', async () => {
    const { svc, repo } = build();
    await svc.reorder([30, 10, 20]);
    expect(repo.update.mock.calls.map((c: any) => [c[0].id, c[1].sortOrder])).toEqual([[30, 0], [10, 1], [20, 2]]);
  });
  it('removing a missing notice is a 404', async () => {
    const { svc, repo } = build();
    repo.delete.mockResolvedValue({ affected: 0 });
    await expect(svc.remove(9)).rejects.toBeInstanceOf(NotFoundException);
  });
  it('removing an existing notice succeeds', async () => {
    await expect(build().svc.remove(1)).resolves.toBeUndefined();
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
