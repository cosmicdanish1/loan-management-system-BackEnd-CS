import { NotFoundException, BadRequestException } from '@nestjs/common';
import { BalanceService } from '../../../src/modules/utility/services/balance.service';
import { DataConsistencyService } from '../../../src/modules/utility/services/data-consistency.service';
import { DataCorrectionService } from '../../../src/modules/utility/services/data-correction.service';

// ES-427: these services read member_master / member_balances / loan_master / ledger, not the empty ORM tables.
const dsFor = (answers: Array<[RegExp, any[]]>) => ({
  query: jest.fn(async (sql: string) => {
    for (const [re, rows] of answers) if (re.test(sql)) return rows;
    return [];
  }),
}) as any;

const MEMBER = { mbno: '610026924', name: 'HEMOO YADAV', shares: '51700', compulsory_deposit: '100000', rd_amt: '75131' };

describe('BalanceService (live tables)', () => {
  it('adds shares and deposits and subtracts open loans for a real member', async () => {
    const ds = dsFor([
      [/FROM member_master m/, [MEMBER]],
      [/FROM loan_master/, [{ total: '1473255' }]],
      [/MAX\(trans_date\)/, [{ last_date: new Date('2026-08-11') }]],
    ]);
    const r = await new BalanceService(ds).getMemberBalance({ memberId: 610026924 });
    expect(r).toMatchObject({ memberNumber: '610026924', shareBalance: 51700, totalDepositBalance: 175131, totalLoanBalance: 1473255, netBalance: -1246424 });
  });

  it('a member that does not exist is a 404, not a 500', async () => {
    await expect(new BalanceService(dsFor([])).getMemberBalance({ memberId: 1999999999 })).rejects.toBeInstanceOf(NotFoundException);
  });

  it('refuses an account type it does not support', async () => {
    await expect(new BalanceService(dsFor([])).getAccountBalance('xyz', 1)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('refuses a loan case number shared by two members instead of returning one of them (ES-391)', async () => {
    const ds = dsFor([[/FROM loan_master\s+WHERE loancaseno/, [{ loancaseno: '1494', mbno: '1', balance: '5' }, { loancaseno: '1494', mbno: '2', balance: '9' }]]]);
    await expect(new BalanceService(ds).getAccountBalance('loan', 1494)).rejects.toThrow('used by 2 members');
  });

  it('statement: opening balance plus credits minus debits gives a running balance', async () => {
    const ds = dsFor([
      [/FROM member_master m/, [MEMBER]],
      [/SUM\(CASE WHEN trans_type = 'CR'/, [{ balance: '1000' }]],
      [/ORDER BY trans_date ASC/, [
        { trans_no: '1', trans_date: new Date('2025-02-01'), trans_type: 'CR', trans_amt: '500', receipt_vchr_no: 'R1', narration: 'a' },
        { trans_no: '2', trans_date: new Date('2025-03-01'), trans_type: 'DR', trans_amt: '200', receipt_vchr_no: 'P1', narration: 'b' },
      ]],
    ]);
    const r = await new BalanceService(ds).generateAccountStatement({ memberId: 610026924, fromDate: '2025-01-01', toDate: '2025-12-31' });
    expect(r.account).toMatchObject({ openingBalance: 1000, closingBalance: 1300 });
    expect(r.summary).toEqual({ totalDebits: 200, totalCredits: 500, transactionCount: 2 });
  });

  it('statement: From after To is a 400', async () => {
    await expect(new BalanceService(dsFor([])).generateAccountStatement({ memberId: 1, fromDate: '2025-12-31', toDate: '2025-01-01' })).rejects.toThrow('From date');
  });
});

describe('DataConsistencyService (live tables)', () => {
  it('is HEALTHY only when every check finds nothing', async () => {
    const r = await new DataConsistencyService(dsFor([[/count\(\*\) AS n/, [{ n: '0' }]], [/SUM\(CASE/, [{ dr: '10', cr: '10' }]]])).runConsistencyChecks();
    expect(r.overallStatus).toBe('HEALTHY');
    expect(r.passedChecks).toBe(8);
  });

  it('reports a real problem instead of PASS (a ledger row with a zero or negative amount)', async () => {
    const ds = dsFor([
      [/trans_amt <= 0/, [{ n: '3' }]],
      [/count\(\*\) AS n/, [{ n: '0' }]],
      [/SUM\(CASE/, [{ dr: '10', cr: '10' }]],
    ]);
    const r = await new DataConsistencyService(ds).runConsistencyChecks();
    expect(r.overallStatus).toBe('CRITICAL_ISSUES');
    expect(r.checks.find(c => c.checkName.startsWith('Numerical'))).toMatchObject({ status: 'FAIL', affectedRecords: 3 });
  });

  it('a ledger whose debits and credits differ is a warning with the difference', async () => {
    const ds = dsFor([[/SUM\(CASE/, [{ dr: '100', cr: '160.5' }]]]);
    const r = await new DataConsistencyService(ds).checkBalanceConsistency();
    expect(r.status).toBe('WARNING');
    expect(r.message).toContain('credits higher');
  });

  it('a check whose query fails is a FAIL, never a silent PASS', async () => {
    const ds = { query: jest.fn().mockRejectedValue(new Error('boom')) } as any;
    const r = await new DataConsistencyService(ds).checkDuplicateRecords();
    expect(r.status).toBe('FAIL');
  });
});

describe('DataCorrectionService (switched off)', () => {
  const svc = new DataCorrectionService();
  it.each([
    ['autoFixConsistencyIssues', () => svc.autoFixConsistencyIssues()],
    ['fixOrphanedRecords', () => svc.fixOrphanedRecords([])],
    ['correctBalanceDiscrepancies', () => svc.correctBalanceDiscrepancies([])],
    ['removeDuplicateRecords', () => svc.removeDuplicateRecords('member', 'oldest')],
    ['fixDataIntegrityIssues', () => svc.fixDataIntegrityIssues()],
    ['recalculateAllBalances', () => svc.recalculateAllBalances()],
  ])('%s refuses with a clear reason and changes nothing', async (_n, run) => {
    await expect((run as any)()).rejects.toThrow('switched off');
  });
});
