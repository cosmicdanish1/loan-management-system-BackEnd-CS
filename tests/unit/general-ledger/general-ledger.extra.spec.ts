import { InternalServerErrorException, NotFoundException } from '@nestjs/common';
import { GeneralLedgerService } from '../../../src/modules/general-ledger/general-ledger.service';

const query = (opts: { rows?: any[]; raw?: any }) => {
  const q: any = {
    select: jest.fn().mockReturnThis(),
    addSelect: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    addOrderBy: jest.fn().mockReturnThis(),
    getRawMany: jest.fn().mockResolvedValue(opts.rows ?? []),
    getRawOne: jest.fn().mockResolvedValue(opts.raw ?? { balance: 0, unsupportedCount: 0 }),
    getMany: jest.fn().mockResolvedValue([]),
  };
  return q;
};

const build = (opts: { rows?: any[]; raw?: any; head?: any; headsFail?: Error } = {}) => {
  const entryQuery = query({ rows: opts.rows, raw: opts.raw });
  const openingQuery = query({ raw: opts.raw });
  const ledger: any = {
    createQueryBuilder: jest.fn().mockReturnValueOnce(entryQuery).mockReturnValueOnce(openingQuery),
  };
  const headMaster: any = {
    findOne: jest.fn().mockResolvedValue(opts.head === undefined ? { code: 'L1004', head_name: 'Compulsory Deposit' } : opts.head),
    createQueryBuilder: jest.fn(() => query({})),
  };
  const service = new GeneralLedgerService(ledger, headMaster);
  return { service, entryQuery, openingQuery, headMaster };
};

describe('GeneralLedgerService extra cases', () => {
  it('rejects an unknown head code with 404', async () => {
    const { service } = build({ head: null });
    await expect(service.getGeneralLedgerReport({ headCode: 'ZZZZ', fromDate: '2026-09-01', toDate: '2026-09-02' }))
      .rejects.toBeInstanceOf(NotFoundException);
  });

  it('expands the I1002 parent head to itself plus the per-loan-type children', async () => {
    const { service, entryQuery, openingQuery } = build({ head: { code: 'I1002', head_name: 'INTT FROM MEMBER' } });
    await service.getGeneralLedgerReport({ headCode: 'I1002', fromDate: '2026-09-01', toDate: '2026-09-02' });
    expect(entryQuery.where).toHaveBeenCalledWith('l.code IN (:...headCodes)', { headCodes: ['I1002', 'I1013', 'I1014'] });
    expect(openingQuery.where).toHaveBeenCalledWith('l.code IN (:...headCodes)', { headCodes: ['I1002', 'I1013', 'I1014'] });
  });

  it('parses money values with currency symbols and separators', async () => {
    const { service } = build({
      rows: [{
        trans_no: 1, trans_date: new Date('2026-09-01T00:00:00Z'), trans_type: 'CR',
        trans_amt: '₹1,234.50', receipt_vchr_no: 'V1', narration: '', mbno: 0, acc_no: 0, username: 'x',
      }],
      raw: { balance: '0', unsupportedCount: '0' },
    });

    const report = await service.getGeneralLedgerReport({ headCode: 'L1004', fromDate: '2026-09-01', toDate: '2026-09-01' });
    expect(report.entries[0].credit).toBe(1234.5);
    expect(report.totalCredits).toBe(1234.5);
  });

  it('rejects an unrecognized direction inside the selected range', async () => {
    const { service } = build({
      rows: [{ trans_no: 1, trans_date: new Date(), trans_type: 'XX', trans_amt: '10' }],
    });
    await expect(service.getGeneralLedgerReport({ headCode: 'L1004', fromDate: '2026-09-01', toDate: '2026-09-02' }))
      .rejects.toBeInstanceOf(InternalServerErrorException);
  });

  it('maps head masters and falls back to the code for a blank name', async () => {
    const { service, headMaster } = build();
    headMaster.createQueryBuilder = jest.fn(() => query({
      rows: [{ code: 'A1001', head_name: '', headtype: 'A', parent_code: null }],
    }));
    // getHeadMasters uses getMany, so route the same rows through it.
    headMaster.createQueryBuilder = jest.fn(() => {
      const q = query({ rows: [{ code: 'A1001', head_name: '', headtype: 'A', parent_code: null }] });
      q.getMany = jest.fn().mockResolvedValue([{ code: 'A1001', head_name: '', headtype: 'A', parent_code: null }]);
      return q;
    });

    await expect(service.getHeadMasters()).resolves.toEqual([
      { code: 'A1001', headName: 'A1001', headType: 'A', parentCode: null },
    ]);
  });

  it('fails instead of returning an empty head list when the database is unavailable', async () => {
    const { service, headMaster } = build();
    headMaster.createQueryBuilder = jest.fn(() => {
      const q: any = { select: jest.fn().mockReturnThis(), orderBy: jest.fn().mockReturnThis() };
      q.getMany = jest.fn().mockRejectedValue(new Error('database unavailable'));
      return q;
    });
    await expect(service.getHeadMasters()).rejects.toThrow();
  });
});
