import { BadRequestException } from '@nestjs/common';
import { DemandGenerationService } from '../../../src/modules/transaction/services-v2/demand-generation.service';

const build = (opts: {
  count?: number;
  members?: any[];
  loans?: any[];
  failOn?: string;
} = {}) => {
  const calls: Array<{ sql: string; params?: any[] }> = [];
  const qr: any = {
    connect: jest.fn().mockResolvedValue(undefined),
    startTransaction: jest.fn().mockResolvedValue(undefined),
    commitTransaction: jest.fn().mockResolvedValue(undefined),
    rollbackTransaction: jest.fn().mockResolvedValue(undefined),
    release: jest.fn().mockResolvedValue(undefined),
    query: jest.fn(async (sql: string, params?: any[]) => {
      calls.push({ sql, params });
      if (opts.failOn && sql.includes(opts.failOn)) throw new Error('db down');
      if (sql.includes('LOCK TABLE')) return [];
      if (sql.includes('COUNT(*)')) return [{ cnt: String(opts.count ?? 0) }];
      if (sql.includes('FROM member_master')) return opts.members ?? [];
      if (sql.includes('FROM loan_master')) return opts.loans ?? [];
      if (sql.includes('MAX(dmnd_srno)')) return [{ next_serial: '5' }];
      return [];
    }),
  };
  const dataSource: any = { createQueryRunner: jest.fn().mockReturnValue(qr) };
  const service = new DemandGenerationService({} as any, dataSource);
  return { service, qr, dataSource, calls };
};

const dto = (over: Partial<Record<string, any>> = {}) => ({ month: 'APR', year: '2026', divisionRO: '', ...over });

describe('DemandGenerationService validation', () => {
  it('rejects an unknown month', async () => {
    const { service, dataSource } = build();
    await expect(service.generateDemand(dto({ month: 'XYZ' }))).rejects.toBeInstanceOf(BadRequestException);
    expect(dataSource.createQueryRunner).not.toHaveBeenCalled();
  });

  it('rejects a year that is not four digits or is far outside the allowed window', async () => {
    const { service } = build();
    await expect(service.generateDemand(dto({ year: '26' }))).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.generateDemand(dto({ year: '1899' }))).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.generateDemand(dto({ year: '2999' }))).rejects.toBeInstanceOf(BadRequestException);
  });

  it('accepts a lower-case month name', async () => {
    const { service } = build();
    await expect(service.generateDemand(dto({ month: ' apr ' }))).resolves.toMatchObject({ success: true });
  });
});

describe('DemandGenerationService generation', () => {
  it('skips a period that already has demand, inside the transaction', async () => {
    const { service, qr } = build({ count: 3 });

    const result = await service.generateDemand(dto());

    expect(result).toEqual({ success: true, message: 'Demand for APR 2026 already exists (3 records). Process skipped.' });
    expect(qr.rollbackTransaction).toHaveBeenCalled();
  });

  it('creates one demand per member with an active loan and skips members without one', async () => {
    const { service, calls } = build({
      members: [{ mbno: 1001, officeno: '1' }, { mbno: '1002', officeno: '2' }],
      loans: [{ mbno: '1001', total_emi: '450.50' }, { mbno: 1002, total_emi: '0' }],
    });

    const result = await service.generateDemand(dto());

    expect(result.message).toBe('Successfully generated demand for 1 members for APR 2026.');
    const inserts = calls.filter(({ sql }) => sql.includes('INSERT INTO demand_master'));
    expect(inserts).toHaveLength(1);
    expect(inserts[0].params).toEqual([4, 2026, '1001', '1', 5, 450.5]);
  });

  it('scopes generation to the supplied member list', async () => {
    const { service, calls } = build({ members: [{ mbno: 1001, officeno: '1' }], loans: [{ mbno: 1001, total_emi: '10' }] });

    await service.generateDemand(dto({ memberNos: ['1001', '1002'], divisionRO: '1' }));

    const memberQuery = calls.find(({ sql }) => sql.includes('FROM member_master'));
    expect(memberQuery?.params).toEqual(['1', ['1001', '1002']]);
  });

  it('rolls back and wraps a write failure', async () => {
    const { service, qr } = build({
      members: [{ mbno: 1001, officeno: '1' }],
      loans: [{ mbno: 1001, total_emi: '10' }],
      failOn: 'INSERT INTO demand_master',
    });
    await expect(service.generateDemand(dto())).rejects.toThrow(/Failed to generate demand/);
    expect(qr.rollbackTransaction).toHaveBeenCalled();
    expect(qr.release).toHaveBeenCalled();
  });
});
