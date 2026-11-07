import { ShortRecoveryService } from '../../../src/modules/transaction/services-v2/short-recovery.service';

const build = (opts: { rows?: any[]; demand?: any; saveFails?: boolean } = {}) => {
  const calls: Array<{ sql: string; params?: any[] }> = [];
  const saved: any[] = [];
  const qr: any = {
    connect: jest.fn().mockResolvedValue(undefined),
    startTransaction: jest.fn().mockResolvedValue(undefined),
    commitTransaction: jest.fn().mockResolvedValue(undefined),
    rollbackTransaction: jest.fn().mockResolvedValue(undefined),
    release: jest.fn().mockResolvedValue(undefined),
    query: jest.fn(async (sql: string, params?: any[]) => {
      calls.push({ sql, params });
      if (sql.includes('FROM demand_master') && sql.includes('FOR UPDATE')) return opts.demand ? [opts.demand] : [];
      return [];
    }),
    manager: {
      save: jest.fn(async (entity: any, value: any) => {
        if (opts.saveFails) throw new Error('save failed');
        saved.push(value);
        return value;
      }),
    },
  };
  const dataSource: any = {
    query: jest.fn().mockResolvedValue(opts.rows ?? []),
    createQueryRunner: jest.fn().mockReturnValue(qr),
  };
  const service = new ShortRecoveryService({} as any, {} as any, dataSource);
  return { service, qr, dataSource, calls, saved };
};

describe('ShortRecoveryService list', () => {
  it('maps a legacy demand row to a pending shortfall line', async () => {
    const { service } = build({
      rows: [{
        serial: 0, memberNo: 1001, month: 4, year: 2026, totalDemand: '1000', balance: '300',
        fName: 'Asha', mName: 'Rao', lName: 'Patil',
      }],
    });

    const [line] = await service.findAll('APR', '2026', '');

    expect(line).toEqual({
      id: '2026-4-1001',
      memberNo: '1001',
      memberName: 'Asha Rao Patil',
      recoveryType: 'Demand Shortfall',
      expectedAmount: 1000,
      recoveredAmount: 700,
      shortfallAmount: 300,
      status: 'Pending',
    });
  });

  it('returns nothing for an unknown month', async () => {
    const { service, dataSource } = build();
    await expect(service.findAll('XYZ', '2026', '')).resolves.toEqual([]);
    expect(dataSource.query).not.toHaveBeenCalled();
  });

  it('adds the wing filter as a bound parameter', async () => {
    const { service, dataSource } = build();
    await service.findAll('APR', '2026', '7');
    const [sql, params] = dataSource.query.mock.calls[0];
    expect(sql).toContain('mm.wingno::text = $3');
    expect(params).toEqual([4, 2026, '7']);
  });
});

describe('ShortRecoveryService adjust', () => {
  it.each([
    ['a blank reason', ' ', 10, /reason/],
    ['a zero amount', 'reason', 0, /positive/],
    ['a negative amount', 'reason', -5, /positive/],
    ['a non-numeric amount', 'reason', 'abc', /positive/],
    ['a malformed identifier', 'reason', 10, /Invalid demand identifier/],
  ])('rejects %s', async (_label, reason, amount, message) => {
    const { service, qr } = build({ demand: { dmnd_srno: 1, totaldemand: 100, balance_for_month: 100 } });
    const id = _label === 'a malformed identifier' ? '2026-4' : '2026-4-1001';
    await expect(service.adjust(id, reason as string, amount as number)).rejects.toThrow(message as RegExp);
    expect(qr.rollbackTransaction).toHaveBeenCalled();
  });

  it('rejects an amount larger than the shortfall', async () => {
    const { service } = build({ demand: { dmnd_srno: 1, totaldemand: 1000, balance_for_month: 100 } });
    await expect(service.adjust('2026-4-1001', 'paid', 150)).rejects.toThrow(/cannot exceed/);
  });

  it('zeros the shortfall and records the adjustment in the same transaction', async () => {
    const { service, calls, saved } = build({ demand: { dmnd_srno: 77, totaldemand: 1000, balance_for_month: 300 } });

    await expect(service.adjust('2026-4-1001', 'counter payment', 300)).resolves.toEqual({ success: true });

    const update = calls.find(({ sql }) => sql.includes('UPDATE demand_master'));
    expect(update?.params).toEqual([0, 2026, 4, '1001']);
    expect(saved[0]).toMatchObject({ demandId: 77, adjustmentAmount: 300, reason: 'counter payment' });
  });

  it('rolls the demand update back when the audit row cannot be saved', async () => {
    const { service, qr } = build({
      demand: { dmnd_srno: 77, totaldemand: 1000, balance_for_month: 300 },
      saveFails: true,
    });
    await expect(service.adjust('2026-4-1001', 'counter payment', 100)).rejects.toThrow(/Failed to adjust/);
    expect(qr.rollbackTransaction).toHaveBeenCalled();
  });

  it('keeps the audit row traceable when the legacy demand serial is zero', async () => {
    const { service, saved } = build({ demand: { dmnd_srno: 0, totaldemand: 1000, balance_for_month: 300 } });
    await service.adjust('2026-4-1001', 'counter payment', 100);
    expect(saved[0].demandId).not.toBe(0);
  });
});
