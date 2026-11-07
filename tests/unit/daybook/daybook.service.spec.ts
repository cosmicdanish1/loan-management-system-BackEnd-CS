import { DayBookService } from '../../../src/modules/daybook/daybook.service';

const query = (opts: { data?: any[]; one?: any; raw?: any; fail?: Error }) => {
  const q: any = {
    select: jest.fn().mockReturnThis(),
    addSelect: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    addOrderBy: jest.fn().mockReturnThis(),
    getMany: jest.fn().mockResolvedValue(opts.data ?? []),
    getOne: jest.fn().mockResolvedValue(opts.one ?? null),
    getRawOne: opts.fail ? jest.fn().mockRejectedValue(opts.fail) : jest.fn().mockResolvedValue(opts.raw ?? null),
  };
  return q;
};

const build = (opts: { rows?: any[]; opening?: any; move?: any; one?: any } = {}) => {
  const ledger: any = {
    query: jest.fn()
      .mockResolvedValueOnce(opts.rows ?? [])
      .mockResolvedValueOnce([opts.opening ?? { balance: '0' }])
      .mockResolvedValueOnce([opts.move ?? { cash_in: '0', cash_out: '0' }]),
    createQueryBuilder: jest.fn(() => query({ data: [], raw: { balance: '0', unsupportedCount: '0' } })),
    create: jest.fn((value) => value),
    save: jest.fn(async (value) => value),
  };
  const transactions: any = {
    create: jest.fn((value) => value),
    save: jest.fn(async (value) => value),
    createQueryBuilder: jest.fn(() => query({ raw: { maxTransNo: 10 } })),
  };
  const members: any = { findOne: jest.fn().mockResolvedValue({ f_name: 'Asha', m_name: '', l_name: 'Patil' }) };
  const interest: any = { createQueryBuilder: jest.fn(() => query({ one: { rate: '5.5' } })) };
  const service = new DayBookService(transactions, ledger, members, interest);
  return { service, ledger, transactions, interest };
};

describe('DayBookService grouped report', () => {
  it('groups payments and receipts by head and takes totals from the Cash-In-Hand movement', async () => {
    const { service } = build({
      rows: [
        { ledgerid: 1, trans_type: 'DR', mb_no: '1001', head_code: 'L1001', head_name: 'Savings', amount: '100', voucher_no: 'V1', username: 'clerk', member_name: 'Asha Patil' },
        { ledgerid: 2, trans_type: 'CR', mb_no: '1001', head_code: 'L1001', head_name: 'Savings', amount: '250', voucher_no: 'V1', username: 'clerk', member_name: 'Asha Patil' },
        { ledgerid: 3, trans_type: 'CR', mb_no: '0', head_code: 'L1004', head_name: 'CD', amount: '50', voucher_no: 'V2', username: 'clerk', member_name: '' },
      ],
      opening: { balance: '500' },
      move: { cash_in: '250', cash_out: '100' },
    });

    const report = await service.getDayBookGroupedReport({ date: '2026-09-20' });

    expect(report.openingBalance).toBe(500);
    expect(report.totalReceipts).toBe(250);
    expect(report.totalPayments).toBe(100);
    expect(report.closingBalance).toBe(650);
    expect(report.totalTransactions).toBe(3);
    expect(report.paymentGroups).toHaveLength(1);
    expect(report.paymentGroups[0].total).toBe(100);
    expect(report.receiptGroups.map((g) => g.headCode)).toEqual(['L1001', 'L1004']);
    expect(report.receiptGroups[1].entries[0]).toMatchObject({ mbNo: '', memberName: '' });
  });

  it('rejects a malformed date before querying', async () => {
    const { service } = build();
    await expect(service.getDayBookGroupedReport({ date: '20-09-2026' })).rejects.toThrow();
  });
});

describe('DayBookService SB report', () => {
  it('splits deposits and withdrawals by cash and transfer mode', async () => {
    const { service, ledger } = build();
    ledger.query.mockReset();
    ledger.query
      .mockResolvedValueOnce([
        { tr_no: 1, acc_no: 'A1', ac_name: 'Asha', trans_type: 'CR', modeofpay: 'C', amount: '100' },
        { tr_no: 2, acc_no: 'A2', ac_name: 'Bala', trans_type: 'CR', modeofpay: 'B', amount: '40' },
        { tr_no: 3, acc_no: 'A1', ac_name: 'Asha', trans_type: 'DR', modeofpay: 'C', amount: '60' },
        { tr_no: 4, acc_no: 'A3', ac_name: 'Chitra', trans_type: 'DR', modeofpay: 'T', amount: '20' },
      ])
      .mockResolvedValueOnce([{ opening_balance: '300' }]);

    const report = await service.getDayBookSBReport('2026-09-20');

    expect(report).toMatchObject({
      openingBalance: 300,
      totalDepositCash: 100,
      totalDepositTransfer: 40,
      totalDeposit: 140,
      totalWithdrawalCash: 60,
      totalWithdrawalTransfer: 20,
      totalWithdrawal: 80,
      closingBalance: 360,
      totalTransactions: 4,
    });
    expect(report.entries[1]).toMatchObject({ srNo: 2, depositTransfer: 40, depositCash: 0 });
    expect(report.entries[3]).toMatchObject({ withdrawalTransfer: 20, withdrawalCash: 0 });
  });
});

describe('DayBookService member interest', () => {
  it('keeps the true minimum balance when a withdrawal brings the balance to zero', async () => {
    const { service, ledger } = build();
    ledger.createQueryBuilder = jest.fn(() => query({
      data: [
        { trans_type: 'CR', trans_amt: '100' },
        { trans_type: 'DR', trans_amt: '100' },
        { trans_type: 'CR', trans_amt: '50' },
      ],
    }));

    const result = await service.calculateMemberInterest({
      memberCode: '1001', fromDate: '2026-01-01', toDate: '2026-01-31', interestRate: 12,
    } as any);

    expect(result.minBalance).toBe(0);
    expect(result.principalAmount).toBe(0);
    expect(result.interestAmount).toBe(0);
  });
});

describe('DayBookService interest payment', () => {
  it('credits the member savings head, not Cash-In-Hand, when paying savings interest', async () => {
    const { service, ledger } = build();

    await service.payInterestToMember({
      memberCode: '1001', interestAmount: 75, paymentDate: '2026-03-31', narration: 'Saving Interest',
    } as any);

    expect(ledger.save).toHaveBeenCalledWith(expect.objectContaining({
      trans_type: 'CR', code: 'A001', mbno: 1001, trans_amt: 75,
    }));
  });

  it('rejects a non-numeric interest amount instead of posting "NaN" to the ledger', async () => {
    const { service } = build();
    await expect(service.payInterestToMember({
      memberCode: '1001', interestAmount: 'not-a-number', paymentDate: '2026-03-31',
    } as any)).rejects.toThrow();
  });
});

describe('DayBookService flat day book', () => {
  it('rejects an unsupported ledger direction', async () => {
    const { service, ledger } = build();
    ledger.createQueryBuilder = jest.fn(() => query({
      data: [{ trans_no: 1, trans_type: 'XX', trans_amt: '10', code: 'A001', mbno: 1001 }],
    }));
    await expect(service.getDayBookReport({ date: '2026-09-20' } as any)).rejects.toThrow();
  });

  it('rejects an unsupported opening-balance row', async () => {
    const { service, ledger } = build();
    ledger.createQueryBuilder = jest.fn(() => query({
      data: [],
      raw: { balance: '0', unsupportedCount: '1' },
    }));
    await expect(service.getDayBookReport({ date: '2026-09-20' } as any)).rejects.toThrow();
  });
});
