import { DayBookService } from '../../src/modules/daybook/daybook.service';

describe('DayBookService CD report', () => {
  it('includes CD rows identified by ledger markers and balances legacy R/P as receipt/payment', async () => {
    const dayRows = [
      {
        trans_no: 10, trans_date: new Date('2026-09-20T10:00:00'), trans_type: 'R',
        trans_amt: '75.00', code: 'L1004', acc_type: 'CD', vchr_type: 'CD',
        mbno: 1001, receipt_vchr_no: 'R001', narration: '', username: 'clerk',
      },
      {
        trans_no: 11, trans_date: new Date('2026-09-20T11:00:00'), trans_type: 'P',
        trans_amt: '20.00', code: '', acc_type: '', vchr_type: 'CD',
        mbno: 1002, receipt_vchr_no: 'P001', narration: '', username: 'clerk',
      },
    ];
    const makeQueryBuilder = () => ({
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      addOrderBy: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      addSelect: jest.fn().mockReturnThis(),
      getMany: jest.fn().mockResolvedValue(dayRows),
      getRawOne: jest.fn().mockResolvedValue({ balance: '100.00', unsupportedCount: '0' }),
    });
    const rowsQuery = makeQueryBuilder();
    const openingQuery = makeQueryBuilder();
    const ledgerRepository = {
      createQueryBuilder: jest.fn()
        .mockReturnValueOnce(rowsQuery)
        .mockReturnValueOnce(openingQuery),
      query: jest.fn().mockResolvedValue([{ code: 'L1004', head_name: 'Liability Account L1004' }]),
    };
    const memberRepository = {
      findOne: jest.fn().mockResolvedValue({ f_name: 'CD', m_name: '', l_name: 'Member' }),
    };
    const service = new DayBookService(
      {} as any,
      ledgerRepository as any,
      memberRepository as any,
      {} as any,
    );

    const report = await service.getDayBookReport({ date: '2026-09-20', filterType: 'cd' });

    expect(rowsQuery.andWhere).toHaveBeenCalledWith(
      '(l.acc_type = :cdType OR l.code = :cdCode OR l.vchr_type = :cdVoucherType)',
      { cdType: 'CD', cdCode: 'L1004', cdVoucherType: 'CD' },
    );
    expect(openingQuery.andWhere).toHaveBeenCalledWith(
      '(l.acc_type = :cdType OR l.code = :cdCode OR l.vchr_type = :cdVoucherType)',
      { cdType: 'CD', cdCode: 'L1004', cdVoucherType: 'CD' },
    );
    expect(openingQuery.select.mock.calls[0][0]).toContain("IN ('CR', 'R')");
    expect(openingQuery.select.mock.calls[0][0]).toContain("IN ('DR', 'P')");
    expect(report.entries.map(entry => entry.transactionType)).toEqual(['CR', 'DR']);
    expect(report.entries[0]).toMatchObject({ headCode: 'L1004', headName: 'Compulsory Deposit' });
    expect(report.entries[1]).toMatchObject({ headCode: 'L1004', headName: 'Compulsory Deposit' });
    expect(report.totalReceipts).toBe(75);
    expect(report.totalPayments).toBe(20);
    expect(report.openingBalance).toBe(100);
    expect(report.closingBalance).toBe(155);
  });
});
