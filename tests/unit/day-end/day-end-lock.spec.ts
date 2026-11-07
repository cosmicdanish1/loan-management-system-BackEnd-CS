import { BadRequestException } from '@nestjs/common';
import { DayEndService } from '../../../src/modules/admin/services/day-end.service';
import { DayEndStatus } from '../../../src/modules/admin/entities/day-end-process.entity';

/**
 * A tiny in-memory world: one day_end_processes table and a real mutual-exclusion lock, so two initiateDayEnd calls that start
 * together behave like two simultaneous requests against PostgreSQL's pg_advisory_xact_lock (ES-429).
 */
function world(opts: { completedFor?: string; saveFails?: boolean } = {}) {
  // the service compares with LOCAL midnight (it calls setHours(0,0,0,0)), so the stored date is local midnight too
  const local = (d: string) => { const [y, m, day] = d.split('-').map(Number); return new Date(y, m - 1, day); };
  const table: any[] = opts.completedFor ? [{ id: 1, processDate: local(opts.completedFor), status: DayEndStatus.COMPLETED }] : [];
  let held: Promise<void> | null = null;
  const log: string[] = [];

  const repoFor = (tx: boolean) => ({
    findOne: jest.fn(async ({ where }: any) => {
      await new Promise((r) => setTimeout(r, 1)); // a real query takes time: this is what lets two requests interleave
      return table.find((p) => (where.status ? p.status === where.status : true) && (where.processDate ? +p.processDate === +where.processDate : true)) ?? null;
    }),
    create: jest.fn((x: any) => ({ ...x, getDuration: () => 0 })),
    save: jest.fn(async (x: any) => {
      await new Promise((r) => setTimeout(r, 1));
      if (opts.saveFails) throw new Error('connection terminated');
      if (table.some((p) => p.id === x.id)) throw new Error('duplicate key value violates unique constraint "day_end_processes_pkey"');
      table.push(x);
      return x;
    }),
  });

  const makeRunner = () => {
    let release: (() => void) | null = null;
    const qr: any = {
      connect: jest.fn(),
      startTransaction: jest.fn(async () => { log.push('begin'); }),
      commitTransaction: jest.fn(async () => { log.push('commit'); release?.(); }),
      rollbackTransaction: jest.fn(async () => { log.push('rollback'); release?.(); }),
      release: jest.fn(async () => { release?.(); }),
      query: jest.fn(async (sql: string) => {
        if (/pg_advisory_xact_lock/.test(sql)) {
          while (held) await held; // wait for whoever holds the lock to commit / roll back
          held = new Promise<void>((res) => { release = () => { held = null; res(); release = null; }; });
          log.push('lock');
          return [];
        }
        if (/MAX\(id\)/.test(sql)) {
          await new Promise((r) => setTimeout(r, 1));
          return [{ next_id: Math.max(0, ...table.map((p) => p.id)) + 1 }];
        }
        return [];
      }),
      manager: { getRepository: () => repoFor(true) },
    };
    return qr;
  };

  const ds: any = {
    createQueryRunner: jest.fn(() => makeRunner()),
    query: jest.fn(async () => [{ working_date: '2024-01-15' }]),
  };
  const svc = new DayEndService({} as any, {} as any, {} as any, {} as any, ds, {} as any);
  jest.spyOn(svc as any, 'executeDayEndProcess').mockResolvedValue(undefined);
  jest.spyOn(svc as any, 'mapToResponseDto').mockImplementation((p: any) => ({ id: p.id, status: p.status }));
  return { svc, table, log, ds };
}

describe('DayEndService.initiateDayEnd under a lock (ES-429)', () => {
  it('two requests at the same moment: one starts the day-end, the other is told one is already in progress', async () => {
    const { svc, table } = world();
    const results = await Promise.allSettled([svc.initiateDayEnd({ processDate: '2024-01-15' } as any, 1), svc.initiateDayEnd({ processDate: '2024-01-15' } as any, 2)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(BadRequestException);
    expect(String(rejected.reason.message)).toMatch(/already in progress|currently in progress/);
    expect(table).toHaveLength(1);
  });

  it('five requests at once still start exactly one day-end', async () => {
    const { svc, table } = world();
    const results = await Promise.allSettled(Array.from({ length: 5 }, (_, i) => svc.initiateDayEnd({ processDate: '2024-01-15' } as any, i)));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(table.filter((p) => p.status === DayEndStatus.IN_PROGRESS)).toHaveLength(1);
  });

  it('even with forceReprocess, a second simultaneous request cannot start a second run', async () => {
    const { svc, table } = world({ completedFor: '2024-01-15' });
    const results = await Promise.allSettled([
      svc.initiateDayEnd({ processDate: '2024-01-15', forceReprocess: true } as any, 1),
      svc.initiateDayEnd({ processDate: '2024-01-15', forceReprocess: true } as any, 2),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(table.filter((p) => p.status === DayEndStatus.IN_PROGRESS)).toHaveLength(1);
  });

  it('process ids are unique and the lock is taken before anything is read', async () => {
    const { svc, table, log } = world();
    await svc.initiateDayEnd({ processDate: '2024-01-15' } as any, 1);
    expect(table.map((p) => p.id)).toEqual([1]);
    expect(log).toEqual(['begin', 'lock', 'commit']);
  });

  it('a refused request (already completed) rolls back, releases the lock and the connection, and the next request can proceed', async () => {
    const { svc, log, ds } = world({ completedFor: '2024-01-15' });
    await expect(svc.initiateDayEnd({ processDate: '2024-01-15' } as any, 1)).rejects.toThrow(/already completed/);
    expect(log).toEqual(['begin', 'lock', 'rollback']);
    // forcing it works right after: the lock was not left behind
    await expect(svc.initiateDayEnd({ processDate: '2024-01-15', forceReprocess: true } as any, 1)).resolves.toBeDefined();
    expect(ds.createQueryRunner).toHaveBeenCalledTimes(2);
  });

  it('every connection that was taken is released, on success and on refusal', async () => {
    const { svc, ds } = world();
    await svc.initiateDayEnd({ processDate: '2024-01-15' } as any, 1);
    await svc.initiateDayEnd({ processDate: '2024-01-15' } as any, 1).catch(() => undefined);
    const runners = ds.createQueryRunner.mock.results.map((r: any) => r.value);
    expect(runners).toHaveLength(2);
    for (const qr of runners) expect(qr.release).toHaveBeenCalledTimes(1);
  });

  it('a database failure while saving rolls back, releases the lock and is thrown to the caller (no half-started day-end)', async () => {
    const { svc, table, log, ds } = world({ saveFails: true });
    await expect(svc.initiateDayEnd({ processDate: '2024-01-15' } as any, 1)).rejects.toThrow('connection terminated');
    expect(table).toHaveLength(0);
    expect(log).toEqual(['begin', 'lock', 'rollback']);
    expect(ds.createQueryRunner.mock.results[0].value.release).toHaveBeenCalledTimes(1);
    expect((svc as any).executeDayEndProcess).not.toHaveBeenCalled();
  });

  it('the working date is still taken from getworkingdate, outside the lock', async () => {
    const { svc, ds } = world();
    await svc.initiateDayEnd({ processDate: '2030-12-31' } as any, 1);
    expect(ds.query.mock.calls[0][0]).toMatch(/getworkingdate/);
  });
});
