import { MemberLedgerService } from '../../src/modules/member-ledger/member-ledger.service';

describe('MemberLedgerService columnar balance boundaries', () => {
  const createService = (ledgerRows: any[]) => {
    const memberRepository = {
      findOne: jest.fn().mockResolvedValue({ mbno: '1001', f_name: 'Test', m_name: '', l_name: 'Member' }),
    };
    const dataSource = {
      query: jest.fn()
        .mockResolvedValueOnce(ledgerRows)
        .mockResolvedValueOnce([{ ltl: '0', emer: '0' }]),
    };
    const service = new MemberLedgerService(
      {} as any,
      memberRepository as any,
      {} as any,
      dataSource as any,
    );
    return service;
  };

  it('returns all account heads with member-specific activity and full ledger date bounds', async () => {
    const dataSource = {
      query: jest.fn().mockResolvedValue([
        { code: 'A1000', headName: 'Asset', transactionCount: 0, minDate: '2017-04-05', maxDate: '2026-09-18' },
        { code: 'L1004', headName: 'Compulsory Deposit', transactionCount: 3, minDate: '2017-04-05', maxDate: '2026-09-18' },
      ]),
    };
    const service = new MemberLedgerService(
      {} as any,
      { findOne: jest.fn().mockResolvedValue({ mbno: '1001', f_name: 'Test', m_name: '', l_name: 'Member' }) } as any,
      {} as any,
      dataSource as any,
    );

    const context = await service.getMemberLedgerContext({ memberNumber: '1001' });

    expect(context).toMatchObject({ exists: true, memberName: 'Test Member', minDate: '2017-04-05', maxDate: '2026-09-18' });
    expect(context.heads).toEqual([
      { code: 'A1000', headName: 'Asset', transactionCount: 0, hasData: false },
      { code: 'L1004', headName: 'Compulsory Deposit', transactionCount: 3, hasData: true },
    ]);
    expect(dataSource.query).toHaveBeenCalledWith(expect.stringContaining('FROM headmaster'), ['1001']);
  });

  it('normalizes legacy R/P receipt-payment codes in the personal member ledger', async () => {
    const makeQuery = (result: any[]) => ({
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      addOrderBy: jest.fn().mockReturnThis(),
      getMany: jest.fn().mockResolvedValue(result),
    });
    const entryQuery = makeQuery([
      { trans_no: 1, trans_date: new Date('2026-01-02T10:00:00'), trans_type: 'R', trans_amt: '100', receipt_vchr_no: 'R1', narration: 'Deposit', username: 'clerk' },
      { trans_no: 2, trans_date: new Date('2026-01-03T10:00:00'), trans_type: 'P', trans_amt: '20', receipt_vchr_no: 'P1', narration: 'Withdrawal', username: 'clerk' },
    ]);
    const openingQuery = makeQuery([]);
    const service = new MemberLedgerService(
      { createQueryBuilder: jest.fn().mockReturnValueOnce(entryQuery).mockReturnValueOnce(openingQuery) } as any,
      { findOne: jest.fn().mockResolvedValue({ mbno: '1001', f_name: 'Test', m_name: '', l_name: 'Member' }) } as any,
      { findOne: jest.fn().mockResolvedValue({ head_name: 'Share' }) } as any,
      {} as any,
    );

    const report = await service.getMemberLedgerReport({
      memberNumber: '1001', headCode: 'L1001', fromDate: '2026-01-01', toDate: '2026-01-31',
    });

    expect(report.entries.map(entry => entry.transactionType)).toEqual(['CR', 'DR']);
    expect(report.entries.map(entry => entry.balance)).toEqual([100, 80]);
    expect(report.totalCredits).toBe(100);
    expect(report.totalDebits).toBe(20);
    expect(report.closingBalance).toBe(80);
  });

  it('returns pre-period Share/CD balances and end-period balances separately', async () => {
    const service = createService([
      { date_key: '2025-12-31', acc_type: 'SHR', trans_type: 'R', trans_amt: '100.00' },
      { date_key: '2025-12-31', acc_type: 'CD', trans_type: 'CR', trans_amt: '500.00' },
      { date_key: '2026-01-05', acc_type: 'SHR', trans_type: 'P', trans_amt: '25.00' },
      { date_key: '2026-01-05', acc_type: 'CD', trans_type: 'R', trans_amt: '40.00' },
    ]);

    const report = await service.getMemberColumnarLedgerReport({
      memberNumber: '1001', fromDate: '2026-01-01', toDate: '2026-01-31',
    });

    expect(report.opening).toMatchObject({ share: 100, cd: 500 });
    expect(report.rows[0].share.bal).toBe(75);
    expect(report.rows[0].cd.bal).toBe(540);
    expect(report.closing).toMatchObject({ share: 75, cd: 540 });
  });

  it('preserves balances through the selected end date when the period has no activity', async () => {
    const service = createService([
      { date_key: '2025-12-31', acc_type: 'SHR', trans_type: 'R', trans_amt: '100.00' },
      { date_key: '2025-12-31', acc_type: 'CD', trans_type: 'CR', trans_amt: '500.00' },
    ]);

    const report = await service.getMemberColumnarLedgerReport({
      memberNumber: '1001', fromDate: '2026-01-01', toDate: '2026-01-31',
    });

    expect(report.rows).toHaveLength(0);
    expect(report.opening).toMatchObject({ share: 100, cd: 500 });
    expect(report.closing).toMatchObject({ share: 100, cd: 500 });
  });
});
