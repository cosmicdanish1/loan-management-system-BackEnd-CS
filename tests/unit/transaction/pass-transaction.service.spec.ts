import { BadRequestException } from '@nestjs/common';
import { PassTransactionService } from '../../../src/modules/transaction/services-v2/pass-transaction.service';

type Call = { sql: string; params?: any[] };

interface RunnerOptions {
  header?: any;
  details?: any[];
  loan?: any;
  loanMasterRows?: any[];
  stagedRows?: any[];
  balances?: Record<string, number>;
  failOn?: string;
}

const build = (opts: RunnerOptions = {}) => {
  const calls: Call[] = [];
  const qr: any = {
    connect: jest.fn().mockResolvedValue(undefined),
    startTransaction: jest.fn().mockResolvedValue(undefined),
    commitTransaction: jest.fn().mockResolvedValue(undefined),
    rollbackTransaction: jest.fn().mockResolvedValue(undefined),
    release: jest.fn().mockResolvedValue(undefined),
    query: jest.fn(async (sql: string, params?: any[]) => {
      calls.push({ sql, params });
      if (opts.failOn && sql.includes(opts.failOn)) throw new Error('database down');
      if (sql.includes('FROM vouchers WHERE "voucherNumber"')) return opts.header ? [opts.header] : [];
      if (/SELECT mbno, code, trans_type, trans_amt FROM transactions WHERE receipt_vchr_no/.test(sql)) return opts.stagedRows ?? [];
      if (/FROM transactions WHERE receipt_vchr_no/.test(sql)) return opts.details ?? [];
      if (sql.includes('MAX(ledgerid)')) return [{ max_id: '10' }];
      if (sql.includes('MAX(trans_no)')) return [{ max_no: '20' }];
      if (sql.includes('FROM loan_pending')) return opts.loan ? [opts.loan] : [];
      if (sql.includes('FROM loan_master WHERE loancaseno::text')) return opts.loanMasterRows ?? [];
      if (sql.includes('FROM transactions WHERE receipt_vchr_no = $1')) return opts.stagedRows ?? [];
      if (sql.includes('FROM member_balances WHERE mbno')) {
        const key = String(params?.[0]);
        return key in (opts.balances ?? {}) ? [{ bal: String(opts.balances![key]) }] : [];
      }
      if (sql.includes('SELECT mbno, loantype, loan_amt FROM loan_master')) return opts.loanMasterRows ?? [];
      if (sql.includes('pflag FROM headmaster')) return [{ pflag: 'A' }];
      if (sql.includes('FROM yearend')) return [];
      return [];
    }),
  };
  const dataSource: any = { createQueryRunner: jest.fn().mockReturnValue(qr) };
  const config: any = { getConfigValue: jest.fn().mockResolvedValue(12) };
  const eligibility: any = { checkEligibility: jest.fn(), getDisbursementDeductions: jest.fn().mockResolvedValue([]) };
  const rdEvents: any = { recordLoanAddition: jest.fn() };
  const repayment: any = { calculateEarlyClosure: jest.fn() };
  const reagreement: any = {
    passInTransaction: jest.fn().mockResolvedValue({ newLoanCaseNo: 'NEW1' }),
    reverseInTransaction: jest.fn().mockResolvedValue({ reversed: true }),
  };
  const lien: any = { place: jest.fn(), release: jest.fn() };

  const service = new PassTransactionService(
    dataSource, config, eligibility, rdEvents, repayment, reagreement, lien,
  );
  return { service, qr, calls, reagreement, eligibility, lien, repayment };
};

const journalHeader = (over: Partial<Record<string, any>> = {}) => ({
  voucherNumber: 'J1', voucherType: 'JOURNAL', status: 'PENDING', description: 'journal', memberId: null,
  remarks: '', bankName: null, chequeNumber: null, ...over,
});

describe('PassTransactionService guards', () => {
  it('rejects a missing or already posted voucher', async () => {
    const { service, qr } = build({ header: null });
    await expect(service.passTransaction('NOPE')).rejects.toBeInstanceOf(BadRequestException);
    expect(qr.rollbackTransaction).toHaveBeenCalled();
  });

  it('rejects a reversal of a voucher that is not POSTED', async () => {
    const { service } = build({ header: null });
    await expect(service.reverseTransaction('NOPE')).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('PassTransactionService journal posting', () => {
  it('moves the regular-loan balance down on a credit and posts the ledger leg', async () => {
    const { service, calls } = build({
      header: journalHeader(),
      details: [{ trans_no: 1, trans_type: 'CR', trans_amt: '100', code: 'A1002', mbno: 1001, acc_type: 'RLN', narration: 'x' }],
      balances: { '1001': 500 },
    });

    const result = await service.passTransaction('J1', 'clerk');
    expect(result.success).toBe(true);

    const ledgerInsert = calls.find(({ sql }) => sql.includes('INSERT INTO ledger'));
    expect(ledgerInsert?.params).toEqual(expect.arrayContaining(['CR', 'A1002', 1001, 100, 'J1']));

    const balanceUpdate = calls.find(({ sql }) => sql.includes('UPDATE member_balances SET regularloan'));
    expect(balanceUpdate?.params).toEqual([400, 1001]);
    expect(calls.some(({ sql }) => sql.includes('INSERT INTO tblcashbook'))).toBe(false);
  });

  it('moves the emergency-loan balance up on a debit', async () => {
    const { service, calls } = build({
      header: journalHeader(),
      details: [{ trans_no: 1, trans_type: 'DR', trans_amt: '150', code: 'A1047', mbno: 1001, acc_type: 'ALN' }],
      balances: { '1001': 200 },
    });

    await service.passTransaction('J1');
    expect(calls.find(({ sql }) => sql.includes('UPDATE member_balances SET emergency_loan_balance'))?.params)
      .toEqual([350, 1001]);
  });

  it('does not touch member_balances for a head without a balance column', async () => {
    const { service, calls } = build({
      header: journalHeader(),
      details: [{ trans_no: 1, trans_type: 'DR', trans_amt: '10', code: 'L1001', mbno: 1001 }],
      balances: { '1001': 200 },
    });
    await service.passTransaction('J1');
    expect(calls.some(({ sql }) => sql.includes('UPDATE member_balances'))).toBe(false);
  });

  it('rejects a journal line without a head code instead of posting to the phantom head GL000', async () => {
    const { service } = build({
      header: journalHeader(),
      details: [{ trans_no: 1, trans_type: 'DR', trans_amt: '10', code: null, mbno: 1001 }],
    });
    await expect(service.passTransaction('J1')).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('PassTransactionService receipt and payment cash book', () => {
  it('writes one cash-book line for the explaining head of a receipt', async () => {
    const { service, calls } = build({
      header: { ...journalHeader(), voucherType: 'RECEIPT' },
      details: [
        { trans_no: 1, trans_type: 'CR', trans_amt: '100', code: 'A001', acc_type: 'CINH' },
        { trans_no: 2, trans_type: 'DR', trans_amt: '100', code: 'A1001', acc_type: 'CINH' },
      ],
    });

    await service.passTransaction('J1');
    const cash = calls.filter(({ sql }) => sql.includes('INSERT INTO tblcashbook'));
    expect(cash).toHaveLength(1);
    expect(cash[0].params?.slice(2, 6)).toEqual([100, 0, 0, 0]);
  });

  it('writes one payment line for a payment voucher', async () => {
    const { service, calls } = build({
      header: { ...journalHeader(), voucherType: 'PAYMENT' },
      details: [
        { trans_no: 1, trans_type: 'DR', trans_amt: '70', code: 'A001' },
        { trans_no: 2, trans_type: 'CR', trans_amt: '70', code: 'A1001' },
      ],
    });

    await service.passTransaction('J1');
    const cash = calls.filter(({ sql }) => sql.includes('INSERT INTO tblcashbook'));
    expect(cash).toHaveLength(1);
    expect(cash[0].params?.slice(2, 6)).toEqual([0, 0, 70, 0]);
  });
});

describe('PassTransactionService reversal', () => {
  it('inverts the member balance and clears the voucher for a journal reversal', async () => {
    const { service, calls } = build({
      header: { ...journalHeader(), status: 'POSTED' },
      stagedRows: [{ mbno: 1001, code: 'A1002', trans_type: 'CR', trans_amt: '100' }],
      balances: { '1001': 400 },
    });

    await service.reverseTransaction('J1', 'clerk');

    expect(calls.find(({ sql }) => sql.includes('UPDATE member_balances SET regularloan'))?.params).toEqual([500, 1001]);
    expect(calls.some(({ sql }) => sql.includes('DELETE FROM ledger'))).toBe(true);
    expect(calls.some(({ sql }) => sql.includes('DELETE FROM tblcashbook'))).toBe(true);
    const voucherReset = calls.find(({ sql }) => sql.includes('UPDATE vouchers SET status = \'PENDING\''));
    expect(voucherReset).toBeDefined();
  });

  it('removes the loan, its schedules and the member balance on a disbursement reversal', async () => {
    const { service, calls } = build({
      header: { ...journalHeader(), voucherType: 'PAYMENT', status: 'POSTED', remarks: 'LOAN_CASE:LC1' },
      loanMasterRows: [{ mbno: 1001, loantype: 'RLN', loan_amt: '5000' }],
    });

    await service.reverseTransaction('P1');

    expect(calls.some(({ sql }) => sql.includes('DELETE FROM loan_schedule_versions'))).toBe(true);
    expect(calls.some(({ sql }) => sql.includes('DELETE FROM loan_rb_schedule'))).toBe(true);
    expect(calls.some(({ sql }) => sql.includes('DELETE FROM loan_master'))).toBe(true);
    expect(calls.find(({ sql }) => sql.includes('UPDATE member_balances SET regularloan = GREATEST'))?.params)
      .toEqual([5000, 1001]);
    expect(calls.find(({ sql }) => sql.includes("UPDATE loan_pending SET flg_paid = 'N'"))).toBeDefined();
  });

  it('routes a re-agreement voucher to the re-agreement service', async () => {
    const { service, reagreement, calls } = build({
      header: { ...journalHeader(), status: 'POSTED', sourceModule: 'LOAN_REAGREEMENT' },
    });

    const result = await service.reverseTransaction('R1');
    expect(reagreement.reverseInTransaction).toHaveBeenCalled();
    expect(result).toMatchObject({ success: true, reagreement: { reversed: true } });
    expect(calls.some(({ sql }) => sql.includes('DELETE FROM ledger'))).toBe(false);
  });
});
