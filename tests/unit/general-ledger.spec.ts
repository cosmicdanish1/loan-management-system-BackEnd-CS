import { BadRequestException, InternalServerErrorException } from '@nestjs/common';
import { GeneralLedgerService } from '../../src/modules/general-ledger/general-ledger.service';

describe('GeneralLedgerService', () => {
  const makeQuery = (entries: any[], opening: { balance: number; unsupportedCount: number } | Error) => {
    const entryQuery: any = {
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      addOrderBy: jest.fn().mockReturnThis(),
      getMany: jest.fn().mockResolvedValue(entries),
    };
    const openingQuery: any = {
      select: jest.fn().mockReturnThis(),
      addSelect: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      getRawOne: opening instanceof Error ? jest.fn().mockRejectedValue(opening) : jest.fn().mockResolvedValue(opening),
    };
    const ledgerRepository = {
      createQueryBuilder: jest.fn().mockReturnValueOnce(entryQuery).mockReturnValueOnce(openingQuery),
    };
    const headMasterRepository = {
      findOne: jest.fn().mockResolvedValue({ code: 'L1004', head_name: 'Compulsory Deposit' }),
    };
    const service = new GeneralLedgerService(ledgerRepository as any, headMasterRepository as any);
    return { service, entryQuery, openingQuery };
  };

  it('normalizes legacy R/P codes and uses inclusive, date-only boundaries', async () => {
    const { service, entryQuery } = makeQuery([
      { trans_no: 1, trans_date: new Date('2026-09-01T10:00:00'), trans_type: 'R', trans_amt: '50', mbno: 1001 },
      { trans_no: 2, trans_date: new Date('2026-09-02T10:00:00'), trans_type: 'P', trans_amt: '10', mbno: 1002 },
    ], { balance: 80, unsupportedCount: 0 });

    const report = await service.getGeneralLedgerReport({
      headCode: 'L1004', fromDate: '2026-09-01', toDate: '2026-09-02',
    });

    expect(report.entries.map(entry => entry.transactionType)).toEqual(['CR', 'DR']);
    expect(report.entries.map(entry => entry.balance)).toEqual([130, 120]);
    expect(report.totalCredits).toBe(50);
    expect(report.totalDebits).toBe(10);
    expect(report.closingBalance).toBe(120);
    expect(entryQuery.andWhere).toHaveBeenCalledWith(
      expect.stringContaining("CAST(:toDate AS date) + INTERVAL '1 day'"),
      { fromDate: '2026-09-01', toDate: '2026-09-02' },
    );
  });

  it('rejects a reversed date range before querying the report', async () => {
    const { service } = makeQuery([], { balance: 0, unsupportedCount: 0 });
    await expect(service.getGeneralLedgerReport({
      headCode: 'L1004', fromDate: '2026-09-03', toDate: '2026-09-02',
    })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('fails clearly instead of treating an opening-balance query failure as zero', async () => {
    const { service } = makeQuery([], new Error('database unavailable'));
    await expect(service.getGeneralLedgerReport({
      headCode: 'L1004', fromDate: '2026-09-01', toDate: '2026-09-02',
    })).rejects.toBeInstanceOf(InternalServerErrorException);
  });

  it('refuses to calculate totals when prior rows contain unknown directions', async () => {
    const { service } = makeQuery([], { balance: 0, unsupportedCount: 1 });
    await expect(service.getGeneralLedgerReport({
      headCode: 'L1004', fromDate: '2026-09-01', toDate: '2026-09-02',
    })).rejects.toBeInstanceOf(InternalServerErrorException);
  });
});
