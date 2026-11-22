// RD/CD Transaction Legacy: a bulk CHARGE debits each member's Compulsory Deposit and credits the chosen head.
import { CompulsoryDepositService } from '../../../src/modules/transaction/services-v2/compulsory-deposit.service';

const build = (opts: { balances?: Record<number, number>; heads?: string[]; members?: number[] } = {}) => {
  const calls: Array<{ sql: string; params?: any[] }> = [];
  const balances = opts.balances ?? { 1001: 500, 1002: 100 };
  const qr: any = {
    connect: jest.fn().mockResolvedValue(undefined),
    startTransaction: jest.fn().mockResolvedValue(undefined),
    commitTransaction: jest.fn().mockResolvedValue(undefined),
    rollbackTransaction: jest.fn().mockResolvedValue(undefined),
    release: jest.fn().mockResolvedValue(undefined),
    query: jest.fn(async (sql: string, params?: any[]) => {
      calls.push({ sql, params });
      if (/FROM headmaster WHERE UPPER\(TRIM\(code\)\)/.test(sql)) return (opts.heads ?? ['L1007']).includes(params?.[0]) ? [{ '?column?': 1 }] : [];
      if (/SELECT mbno FROM member_master/.test(sql)) {
        return (params?.[0] || []).filter((m: number) => (opts.members ?? [1001, 1002]).includes(Number(m))).map((m: number) => ({ mbno: m }));
      }
      if (/FROM member_balances WHERE mbno::numeric = ANY/.test(sql)) {
        return (params?.[0] || []).filter((m: number) => balances[Number(m)] !== undefined).map((m: number) => ({ mbno: m, bal: balances[Number(m)] }));
      }
      if (/UPDATE member_balances/.test(sql)) return [[{ balance: 450 }], 1];
      if (/MAX\(id\)/.test(sql)) return [{ next_id: '5' }];
      if (/MAX\(trans_no\)/.test(sql)) return [{ next_id: '40' }];
      if (/MAX\(ledgerid\)/.test(sql)) return [{ next_id: '70' }];
      return [];
    }),
  };
  const dataSource: any = { query: jest.fn().mockResolvedValue([]), createQueryRunner: jest.fn().mockReturnValue(qr) };
  const sequenceGenerator: any = { getNextVoucherNumber: jest.fn().mockResolvedValue('VCH2001') };
  return { service: new CompulsoryDepositService(dataSource, sequenceGenerator), qr, dataSource, calls };
};

const dto = (over: Partial<Record<string, any>> = {}) => ({
  incomeHeadCode: 'L1007',
  totalAmount: 50,
  narration: 'Transfer for CDS',
  distributions: [
    { memberNo: 1001, memberName: 'Asha', currentBalance: 500, postAmount: 50 },
    { memberNo: 1002, memberName: 'Bala', currentBalance: 100, postAmount: 0 },
  ],
  ...over,
});

const wroteNothing = (calls: Array<{ sql: string }>) =>
  expect(calls.some(({ sql }) => /INSERT INTO|UPDATE member_balances/.test(sql))).toBe(false);

describe('CompulsoryDepositService charge (RD/CD Transaction Legacy)', () => {
  it('lists the heads a charge can be credited to, without the Compulsory Deposit head itself', async () => {
    const { service, dataSource } = build();
    await service.getChargeHeads();
    const [sql, params] = dataSource.query.mock.calls[0];
    expect(sql).toMatch(/pflag IN \('I', 'L'\)/);
    expect(params).toEqual(['L1004']);
  });

  it('lowers the member balance, debits the member and credits the head', async () => {
    const { service, calls } = build();
    const result = await service.postCDInterestAction(dto(), 'clerk', 'charge');

    expect(result).toEqual({ success: true, message: 'Successfully posted CD charge. Voucher No: VCH2001', voucherNo: 'VCH2001' });

    // balance goes DOWN by the charge
    expect(calls.find(({ sql }) => sql.includes('UPDATE member_balances'))?.params).toEqual([-50, 1001]);

    // ledger: member row is a debit on L1004, head row is the matching credit
    const ledger = calls.filter(({ sql }) => sql.includes('INSERT INTO ledger'));
    expect(ledger).toHaveLength(2);
    expect(ledger[0].params).toEqual(expect.arrayContaining(['DR', 'L1004', 1001, 'CD', 50]));
    expect(ledger[1].params).toEqual(expect.arrayContaining(['CR', 'L1007', 0, 'OTH', 50]));

    // transactions: head row is the credit (R), member row the debit (P)
    const trans = calls.filter(({ sql }) => sql.includes('INSERT INTO transactions'));
    expect(trans).toHaveLength(2);
    expect(trans[0].params?.[6]).toBe('R');
    expect(trans[1].params?.[6]).toBe('P');

    // header is marked as a charge
    const header = calls.find(({ sql }) => sql.includes('INSERT INTO vouchers'));
    expect(header?.params?.[4]).toBe('CD_CHARGE');
  });

  it('refuses a charge larger than the member holds and writes nothing', async () => {
    const { service, calls, qr } = build({ balances: { 1001: 20, 1002: 100 } });
    await expect(service.postCDInterestAction(dto(), 'clerk', 'charge')).rejects.toThrow(/less than the charge/);
    wroteNothing(calls);
    expect(qr.rollbackTransaction).toHaveBeenCalled();
  });

  it('treats a member with no balance row as holding nothing', async () => {
    const { service, calls } = build({ balances: {} });
    await expect(service.postCDInterestAction(dto(), 'clerk', 'charge')).rejects.toThrow(/less than the charge/);
    wroteNothing(calls);
  });

  it('allows a charge equal to the whole balance', async () => {
    const { service } = build({ balances: { 1001: 50, 1002: 0 } });
    await expect(service.postCDInterestAction(dto(), 'clerk', 'charge')).resolves.toMatchObject({ success: true });
  });

  it('refuses a head that is not an income/liability head or is the member CD head', async () => {
    const { service, calls } = build({ heads: ['L1007'] });
    await expect(service.postCDInterestAction(dto({ incomeHeadCode: 'L1004' }), 'clerk', 'charge')).rejects.toThrow(/Unknown income head/);
    wroteNothing(calls);
    // the head check itself is restricted for a charge
    const headCheck = calls.find(({ sql }) => /FROM headmaster WHERE/.test(sql));
    expect(headCheck?.sql).toMatch(/pflag IN \('I', 'L'\)/);
    expect(headCheck?.sql).toMatch(/<> 'L1004'/);
  });

  it('still refuses a header total that differs from the member lines, a repeated member and an unknown member', async () => {
    await expect(build().service.postCDInterestAction(dto({ totalAmount: 99 }), 'c', 'charge')).rejects.toThrow(/must equal the sum/);
    await expect(build().service.postCDInterestAction(dto({
      totalAmount: 100,
      distributions: [
        { memberNo: 1001, memberName: 'A', currentBalance: 500, postAmount: 50 },
        { memberNo: 1001, memberName: 'A', currentBalance: 500, postAmount: 50 },
      ],
    }), 'c', 'charge')).rejects.toThrow(/more than once/);
    await expect(build({ members: [1001] }).service.postCDInterestAction(dto({
      totalAmount: 50,
      distributions: [{ memberNo: 1002, memberName: 'B', currentBalance: 100, postAmount: 50 }],
    }), 'c', 'charge')).rejects.toThrow(/Unknown member/);
  });

  it('keeps the interest direction unchanged by default', async () => {
    const { service, calls } = build({ heads: ['I1002'] });
    await service.postCDInterestAction(dto({ incomeHeadCode: 'I1002' }), 'clerk');
    expect(calls.find(({ sql }) => sql.includes('UPDATE member_balances'))?.params).toEqual([50, 1001]);
    const ledger = calls.filter(({ sql }) => sql.includes('INSERT INTO ledger'));
    expect(ledger[0].params).toEqual(expect.arrayContaining(['CR', 'L1004']));
    expect(ledger[1].params).toEqual(expect.arrayContaining(['DR', 'I1002']));
  });
});
