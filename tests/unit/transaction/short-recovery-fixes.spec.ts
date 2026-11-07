import { BadRequestException, NotFoundException } from '@nestjs/common';
import { ShortRecoveryService } from '../../../src/modules/transaction/services-v2/short-recovery.service';

const mk = (demand: any) => {
  const qr: any = { connect: jest.fn(), startTransaction: jest.fn(), commitTransaction: jest.fn(), rollbackTransaction: jest.fn(), release: jest.fn(),
    query: jest.fn(async (sql: string) => (sql.includes('FROM demand_master') && sql.includes('FOR UPDATE') ? (demand ? [demand] : []) : [])), manager: { save: jest.fn() } };
  return { svc: new ShortRecoveryService({} as any, {} as any, { createQueryRunner: () => qr } as any), qr };
};

describe('short recovery adjust answers 400 / 404, not 500 (ES-371)', () => {
  it('missing, malformed or unknown demand ids, empty reason and bad amounts are 400; an unknown demand is 404', async () => {
    const d = { dmnd_srno: 1, totaldemand: 100, balance_for_month: 100 };
    for (const [id, reason, amount] of [[undefined, 'r', 10], ['', 'r', 10], ['abc', 'r', 10], ['2026-4', 'r', 10], ['x-y-z', 'r', 10], ['2026-4-1001', '', 10], ['2026-4-1001', 'r', NaN], ['2026-4-1001', 'r', -5], ['2026-4-1001', 'r', 500]] as any[]) {
      const t = mk(d); await expect(t.svc.adjust(id, reason, amount)).rejects.toBeInstanceOf(BadRequestException); expect(t.qr.commitTransaction).not.toHaveBeenCalled(); expect(t.qr.rollbackTransaction).toHaveBeenCalled();
    }
    await expect(mk(null).svc.adjust('2026-4-1001', 'r', 10)).rejects.toBeInstanceOf(NotFoundException);
  });
});
