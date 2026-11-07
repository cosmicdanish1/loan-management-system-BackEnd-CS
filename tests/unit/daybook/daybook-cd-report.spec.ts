import { DayBookService } from '../../../src/modules/daybook/daybook.service';

describe('DayBookService CD report', () => {
  it('scopes rows by the CD markers and balances legacy R/P as receipt/payment', async () => {
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
    const rowsQuery: any = {
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      addOrderBy: jest.fn().mockReturnThis(),
      getMany: jest.fn().mockResolvedValue(dayRows),
    };
    const statements: string[] = [];
    const ledgerRepository = {
      createQueryBuilder: jest.fn().mockReturnValue(rowsQuery),
      query: jest.fn(async (sql: string) => {
        statements.push(sql);
        if (/head_master/.test(sql)) return [{ code: 'L1004', head_name: 'Compulsory Deposit' }];
        if (/fundsmaster/.test(sql)) return [{ total: '5000' }];
        return [{ net: '-120' }];
      }),
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

    // The CD opening balance is the members' CD amount rolled back by the CD movement,
    // because the L1004 ledger itself carries migrated loan/journal legs.
    const fundsQuery = statements.find((sql) => /fundsmaster/.test(sql));
    const movementQuery = statements.find((sql) => /FROM ledger/.test(sql));
    expect(fundsQuery).toContain('SUM(cdamt)');
    expect(movementQuery).toContain("trans_type IN ('CR','R')");
    expect(movementQuery).toContain("code = 'L1004'");
    expect(movementQuery).toContain("acc_type = 'CD'");
    expect(movementQuery).toContain("vchr_type IN ('R','D')");

    expect(report.entries.map(entry => entry.transactionType)).toEqual(['CR', 'DR']);
    expect(report.entries[0]).toMatchObject({ headCode: 'L1004', headName: 'Compulsory Deposit' });
    expect(report.entries[1]).toMatchObject({ headCode: 'L1004', headName: 'Compulsory Deposit' });
    expect(report.totalReceipts).toBe(75);
    expect(report.totalPayments).toBe(20);
    expect(report.openingBalance).toBe(5120);
    expect(report.closingBalance).toBe(5175);
  });
});
