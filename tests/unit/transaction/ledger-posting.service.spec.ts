import { LedgerPostingService } from '../../../src/modules/transaction/services-v2/ledger-posting.service';

const summaryRow = (over: Partial<Record<string, any>> = {}) => ({
  mbno: 1001, totaldemand: '1000', balance_for_month: '600',
  principal: '700', interest: '200', savings: '100', member_name: 'Asha Patil', ...over,
});

const build = (rows: any[] = [summaryRow()]) => {
  const dataSource: any = {
    query: jest.fn().mockResolvedValue(rows),
    createQueryRunner: jest.fn(),
  };
  const demand: any = { count: jest.fn() };
  const service = new LedgerPostingService(demand, dataSource);
  return { service, dataSource };
};

const runner = (over: Record<string, any> = {}) => {
  const qr: any = {
    connect: jest.fn().mockResolvedValue(undefined),
    startTransaction: jest.fn().mockResolvedValue(undefined),
    commitTransaction: jest.fn().mockResolvedValue(undefined),
    rollbackTransaction: jest.fn().mockResolvedValue(undefined),
    release: jest.fn().mockResolvedValue(undefined),
    query: jest.fn(async (sql: string) => {
      if (/MAX\(trans_no\)/.test(sql)) return [{ next_no: '41', next_ledger_id: '91' }];
      return over.query ? over.query(sql) : [];
    }),
  };
  return qr;
};

describe('LedgerPostingService summary', () => {
  it('returns nothing for an unknown month or year without querying', async () => {
    const { service, dataSource } = build();
    await expect(service.getSummary({ month: 'XYZ', year: '2026', branch: '' })).resolves.toEqual([]);
    await expect(service.getSummary({ month: 'JAN', year: 'abc', branch: '' })).resolves.toEqual([]);
    expect(dataSource.query).not.toHaveBeenCalled();
  });

  it('splits each member demand into send, received and short recovery', async () => {
    const { service } = build();
    const [member] = await service.getSummary({ month: 'JAN', year: '2026', branch: '' });

    expect(member.memberNo).toBe('1001');
    expect(member.memberName).toBe('Asha Patil');
    expect(member.heads).toEqual([
      { code: 'PRINCIPAL', headName: 'Loan Principal', balance: 420, demandSend: 700, demandReceived: 280, shortRecovery: 420 },
      { code: 'INTEREST', headName: 'Loan Interest', balance: 120, demandSend: 200, demandReceived: 80, shortRecovery: 120 },
      { code: 'SAVINGS', headName: 'Savings Contribution', balance: 60, demandSend: 100, demandReceived: 40, shortRecovery: 60 },
    ]);
    expect(member.totalSend).toBe(1000);
    expect(member.totalReceived).toBe(400);
    expect(member.totalShort).toBe(600);
  });

  it('falls back to the total demand as principal when the component columns are empty', async () => {
    const { service } = build([summaryRow({ principal: '0', interest: '0', savings: '0' })]);
    const [member] = await service.getSummary({ month: 'JAN', year: '2026', branch: '' });
    expect(member.heads).toEqual([
      expect.objectContaining({ code: 'PRINCIPAL', demandSend: 1000 }),
    ]);
  });

  it('adds the branch condition as a bound parameter', async () => {
    const { service, dataSource } = build();
    await service.getSummary({ month: 'FEB', year: '2026', branch: '12' });
    const [sql, params] = dataSource.query.mock.calls[0];
    expect(sql).toContain('dm.officeno::text = $3');
    expect(params).toEqual([2, 2026, '12']);
  });

  it('labels a member with no name row by member number', async () => {
    const { service } = build([summaryRow({ member_name: '' })]);
    const [member] = await service.getSummary({ month: 'JAN', year: '2026', branch: '' });
    expect(member.memberName).toBe('Member 1001');
  });
});

describe('LedgerPostingService posting', () => {
  it('refuses invalid parameters before opening a transaction', async () => {
    const { service, dataSource } = build();
    const result = await service.postUpdate({ month: 'XYZ', year: '2026', head: 'Loan Interest', totalAmount: 10, recordCount: 1 });
    expect(result).toEqual({ success: false, message: 'Invalid parameters for ledger posting.' });
    expect(dataSource.createQueryRunner).not.toHaveBeenCalled();
  });

  it('rolls back when the posted total does not match the pending demand', async () => {
    const { service, dataSource } = build();
    const qr = runner();
    dataSource.createQueryRunner.mockReturnValue(qr);

    await expect(service.postUpdate({
      month: 'JAN', year: '2026', head: 'Loan Interest', totalAmount: 900, recordCount: 1,
    })).rejects.toThrow(/does not match pending demand/);

    expect(qr.rollbackTransaction).toHaveBeenCalled();
    expect(qr.commitTransaction).not.toHaveBeenCalled();
    expect(qr.release).toHaveBeenCalled();
  });

  // ES-414: the summary is read on the posting's own transaction (under the month lock), and every head of the
  // demand is posted with its own amount, not the whole total under the one head named in the request.
  const postingRunner = (rows: any[]) => runner({ query: (sql: string) => (/FROM demand_master dm/.test(sql) ? rows : []) });

  it('posts one DR/CR pair per demand head, advances ids and marks the demand as posted', async () => {
    const { service, dataSource } = build();
    const qr = postingRunner([summaryRow()]);
    dataSource.createQueryRunner.mockReturnValue(qr);

    const result = await service.postUpdate({
      month: 'JAN', year: '2026', head: 'Loan Interest', totalAmount: 1000, recordCount: 1,
    });

    expect(result).toMatchObject({ success: true, totalPosted: 1000, recordCount: 1 });
    expect(result.voucherNo).toBe('G00041');
    expect(dataSource.query).not.toHaveBeenCalled(); // nothing read outside the transaction

    const insertParams = qr.query.mock.calls.filter(([sql]: any) => String(sql).startsWith('INSERT INTO ledger'));
    expect(insertParams).toHaveLength(6);
    expect(insertParams.map(([sql]: any) => (String(sql).includes("'DR'") ? 'DR' : 'CR'))).toEqual(['DR', 'CR', 'DR', 'CR', 'DR', 'CR']);
    expect(insertParams.map(([, p]: any) => [p[2], p[4]])).toEqual([['A1001', 700], ['A1003', 700], ['A1001', 200], ['L1028', 200], ['A1001', 100], ['L1001', 100]]);
    expect(insertParams.map(([, p]: any) => p[0])).toEqual([41, 42, 43, 44, 45, 46]);
    expect(insertParams.every(([, p]: any) => p[5] === 'G00041')).toBe(true);

    const update = qr.query.mock.calls.find(([sql]: any) => String(sql).startsWith('UPDATE demand_master'));
    expect(update[0]).toContain("demand_posted = 'Y'");
    expect(qr.commitTransaction).toHaveBeenCalled();
  });

  it('takes the month lock before reading the pending demand', async () => {
    const { service, dataSource } = build();
    const qr = postingRunner([summaryRow()]);
    dataSource.createQueryRunner.mockReturnValue(qr);
    await service.postUpdate({ month: 'JAN', year: '2026', head: 'Loan Interest', totalAmount: 1000, recordCount: 1 });
    const sqls = qr.query.mock.calls.map(([sql]: any) => String(sql));
    const lock = sqls.findIndex((q: string) => /pg_advisory_xact_lock/.test(q));
    const read = sqls.findIndex((q: string) => /FROM demand_master dm/.test(q));
    expect(lock).toBeGreaterThan(-1); expect(lock).toBeLessThan(read);
    expect(qr.query.mock.calls[lock][1]).toEqual(['demand_posting:1:2026']);
  });

  it('uses totalOfficeAmount when supplied and posts only the heads that have an amount', async () => {
    const { service, dataSource } = build();
    const qr = postingRunner([summaryRow({ totaldemand: '500', balance_for_month: '500', principal: '500', interest: '0', savings: '0' })]);
    dataSource.createQueryRunner.mockReturnValue(qr);

    await service.postUpdate({
      month: 'JAN', year: '2026', head: 'Savings', totalAmount: 1, totalOfficeAmount: 500, recordCount: 1,
    });

    const insertParams = qr.query.mock.calls.filter(([sql]: any) => String(sql).startsWith('INSERT INTO ledger'));
    expect(insertParams).toHaveLength(2);
    expect(insertParams[0][1]).toEqual(expect.arrayContaining(['A1001', 500, 'LN']));
    expect(insertParams[1][1]).toEqual(expect.arrayContaining(['A1003', 500, 'LN']));
  });
});

// ES-447: the recovered loan money must also reach the loans (balance, member balance, repayment ledger), in the same
// transaction as the GL rows, before the demand is marked posted.
describe('LedgerPostingService loan recovery (ES-447)', () => {
  const zero = { rln_p: '0', rln_i: '0', eln_p: '0', eln_i: '0', aln_p: '0', aln_i: '0', mln_p: '0', mln_i: '0' };
  const recoveryRow = (over: Partial<Record<string, any>> = {}) => ({ mbno: 1001, ...zero, rln_p: '700', rln_i: '200', ...over });

  const make = (recoveryRows: any[], loans: any[]) => {
    const dataSource: any = { query: jest.fn().mockResolvedValue([]), createQueryRunner: jest.fn() };
    const service = new LedgerPostingService({ count: jest.fn() } as any, dataSource);
    const qr = runner({
      query: (sql: string) => {
        if (/FROM demand_master dm/.test(sql)) return [summaryRow()];
        if (/FROM demand_master\s+WHERE/.test(sql)) return recoveryRows;
        if (/FROM loan_master/.test(sql)) return loans;
        return [];
      },
    });
    dataSource.createQueryRunner.mockReturnValue(qr);
    return { service, qr };
  };
  const post = (service: LedgerPostingService) => service.postUpdate({ month: 'JAN', year: '2026', head: 'Loan Interest', totalAmount: 1000, recordCount: 1 });
  const calls = (qr: any, re: RegExp) => qr.query.mock.calls.filter(([sql]: any) => re.test(String(sql)));

  it('applies the recovered principal to the loan, reduces the member balance and writes a SYSTEM-BULK DEMAND row', async () => {
    const { service, qr } = make([recoveryRow()], [{ loancaseno: '10', loantype: 'RLN', balance: '5000' }]);
    const result: any = await post(service);

    const [loanUpdate] = calls(qr, /^UPDATE loan_master SET balance/);
    expect(loanUpdate[1]).toEqual([700, '10', '1001', 'RLN']);
    const [balanceUpdate] = calls(qr, /^UPDATE member_balances SET regularloan/);
    expect(balanceUpdate[1]).toEqual([700, '1001']);
    const [repayment] = calls(qr, /^INSERT INTO loan_repayment_ledger/);
    expect(repayment[0]).toContain("'SYSTEM-BULK', 'DEMAND'");
    expect(repayment[1]).toEqual([1001, '10', 'RLN', 1, 2026, 900, 700, 200, 'G00041', 'Bulk Demand Recovery Posting']);
    expect(result.loanRecovery).toEqual({ members: 1, loanCases: 1, principal: 700, interest: 200 });
  });

  it('applies principal oldest loan first and splits the interest in proportion', async () => {
    const { service, qr } = make([recoveryRow()], [
      { loancaseno: '10', loantype: 'RLN', balance: '300' },
      { loancaseno: '11', loantype: 'RLN', balance: '1000' },
    ]);
    await post(service);

    const updates = calls(qr, /^UPDATE loan_master SET balance/).map(([, p]: any) => [p[1], p[0]]);
    expect(updates).toEqual([['10', 300], ['11', 400]]);
    const rows = calls(qr, /^INSERT INTO loan_repayment_ledger/).map(([, p]: any) => [p[1], p[6], p[7]]);
    expect(rows).toEqual([['10', 300, 85.71], ['11', 400, 114.29]]); // interest adds up to exactly 200
  });

  it('never applies more principal than the loans owe', async () => {
    const { service, qr } = make([recoveryRow()], [{ loancaseno: '10', loantype: 'RLN', balance: '200' }]);
    const result: any = await post(service);
    expect(calls(qr, /^UPDATE loan_master SET balance/)[0][1][0]).toBe(200);
    expect(result.loanRecovery.principal).toBe(200);
  });

  it('records interest-only recovery against the oldest case without touching the balance', async () => {
    const { service, qr } = make([recoveryRow({ rln_p: '0', rln_i: '150' })], [{ loancaseno: '10', loantype: 'RLN', balance: '5000' }]);
    await post(service);
    expect(calls(qr, /^UPDATE loan_master SET balance/)).toHaveLength(0);
    expect(calls(qr, /^UPDATE member_balances/)).toHaveLength(0);
    expect(calls(qr, /^INSERT INTO loan_repayment_ledger/)[0][1].slice(5, 8)).toEqual([150, 0, 150]);
  });

  it('writes nothing to the loans when the member has no active loan of that type', async () => {
    const { service, qr } = make([recoveryRow()], []);
    const result: any = await post(service);
    expect(calls(qr, /^UPDATE loan_master/)).toHaveLength(0);
    expect(calls(qr, /^INSERT INTO loan_repayment_ledger/)).toHaveLength(0);
    expect(result.loanRecovery).toEqual({ members: 0, loanCases: 0, principal: 0, interest: 0 });
  });

  it('moves the emergency loan balance for an ALN recovery', async () => {
    const { service, qr } = make([recoveryRow({ rln_p: '0', rln_i: '0', aln_p: '500', aln_i: '50' })], [{ loancaseno: '20', loantype: 'ALN', balance: '3000' }]);
    await post(service);
    expect(calls(qr, /^UPDATE member_balances SET emergency_loan_balance/)).toHaveLength(1);
    expect(calls(qr, /^UPDATE member_balances SET regularloan/)).toHaveLength(0);
  });

  it('locks the loan rows so a manual repayment on the same loan waits', async () => {
    const { service, qr } = make([recoveryRow()], [{ loancaseno: '10', loantype: 'RLN', balance: '5000' }]);
    await post(service);
    expect(calls(qr, /FROM loan_master/)[0][0]).toMatch(/FOR UPDATE/);
    expect(calls(qr, /FROM demand_master\s+WHERE/)[0][0]).toMatch(/FOR UPDATE/);
  });

  it('runs inside the posting transaction, before the demand is marked posted', async () => {
    const { service, qr } = make([recoveryRow()], [{ loancaseno: '10', loantype: 'RLN', balance: '5000' }]);
    await post(service);
    const order = qr.query.mock.calls.map(([sql]: any) => String(sql));
    const repaymentAt = order.findIndex((s: string) => s.startsWith('INSERT INTO loan_repayment_ledger'));
    const postedAt = order.findIndex((s: string) => s.startsWith('UPDATE demand_master'));
    expect(repaymentAt).toBeGreaterThan(-1);
    expect(repaymentAt).toBeLessThan(postedAt);
    expect(qr.commitTransaction).toHaveBeenCalledTimes(1);
  });

  it('rolls everything back when a loan write fails (no half-applied month)', async () => {
    const { service, qr } = make([recoveryRow()], [{ loancaseno: '10', loantype: 'RLN', balance: '5000' }]);
    const base = qr.query.getMockImplementation();
    qr.query.mockImplementation(async (sql: string, params?: any[]) => {
      if (/^INSERT INTO loan_repayment_ledger/.test(String(sql))) throw new Error('disk full');
      return base(sql, params);
    });
    await expect(post(service)).rejects.toThrow(/disk full/);
    expect(qr.rollbackTransaction).toHaveBeenCalled();
    expect(qr.commitTransaction).not.toHaveBeenCalled();
  });
});
