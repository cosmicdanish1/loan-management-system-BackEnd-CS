import { CashBookReportsService } from '../../../src/modules/report/services-v2/cash-book-reports.service';
import { MemberReportsService } from '../../../src/modules/report/services-v2/member-reports.service';
import { UtilityReportsService } from '../../../src/modules/report/services-v2/utility-reports.service';
import { FinancialStatementsService } from '../../../src/modules/report/services-v2/financial-statements.service';
import { LoanReportsService } from '../../../src/modules/report/services-v2/loan-reports.service';

// Routes SQL to canned rows by regex; records every call.
function ds(routes: Array<[RegExp, any]>) {
  const calls: Array<{ sql: string; params: any[] }> = [];
  const query = jest.fn(async (sql: string, params: any[] = []) => {
    calls.push({ sql, params });
    for (const [re, rows] of routes) if (re.test(sql)) return typeof rows === 'function' ? rows(sql, params) : rows;
    return [];
  });
  return { query, calls, createQueryRunner: jest.fn() } as any;
}

describe('report extra: cash book legacy R/P rows', () => {
  it('daily cash book counts a legacy P row as a payment, not a receipt', async () => {
    const d = ds([
      [/FROM ledger l/, [
        { voucher_no: 'V1', member_no: '1', trans_type: 'R', amount: '500', head_code: 'A1', head_name: 'H' },
        { voucher_no: 'V1', member_no: '1', trans_type: 'P', amount: '200', head_code: 'A2', head_name: 'H2' },
      ]],
    ]);
    const r: any = await new CashBookReportsService(d).getCashBookDaily('2026-09-05');
    expect(r.vouchers[0].totalReceipt).toBe(500);
    expect(r.vouchers[0].totalPayment).toBe(200);
  });

  it('daily cash book opening balance includes legacy R/P cash rows', async () => {
    const d = ds([[/FROM ledger l/, []], [/trans_date::date < \$1::date AND code = 'A1001'/, [{ balance: '0' }]]]);
    await new CashBookReportsService(d).getCashBookDaily('2026-09-05');
    const sql = d.calls.map((c: any) => c.sql).join('\n');
    expect(sql).toMatch(/'R'/);
    expect(sql).toMatch(/'P'/);
  });

  it('detail ledger puts a legacy R row on the credit side and a legacy P row on the debit side', async () => {
    const d = ds([
      [/SELECT head_name FROM headmaster/, [{ head_name: 'Cash' }]],
      [/SELECT COUNT/, [{ count: '2' }]],
      [/FROM ledger\s+WHERE code = \$1 AND trans_date::date >= \$2::date AND trans_date::date <= \$3::date\s+ORDER/, [
        { trans_date: '2026-09-01', voucher_no: 'V1', trans_type: 'R', amount: '300' },
        { trans_date: '2026-09-02', voucher_no: 'V2', trans_type: 'P', amount: '100' },
      ]],
      [/COALESCE\(SUM/, [{ balance: '0' }]],
    ]);
    const r: any = await new CashBookReportsService(d).getDetailLedger({ head_code: 'A1001', from_date: '2026-09-01', to_date: '2026-09-30' });
    // the application reads a legacy R as a credit and a legacy P as a debit (member ledger, day book, loan position)
    expect(r.transactions[0]).toMatchObject({ credit: 300, debit: 0 });
    expect(r.transactions[1]).toMatchObject({ debit: 100, credit: 0 });
    expect(r.transactions[1].balance).toBe(-200);
  });

  it('monthly cash book rejects an unknown month name', async () => {
    await expect(new CashBookReportsService(ds([])).getCashBookMonthly({ month: 'Foo', year: 2026 })).rejects.toThrow(/Invalid month/);
  });

  it('monthly cash book uses the real last day of February in a leap year', async () => {
    const d = ds([[/COUNT\(DISTINCT/, [{ count: '0' }]], [/COALESCE\(SUM\(COALESCE/, [{ balance: '0' }]]]);
    await new CashBookReportsService(d).getCashBookMonthly({ month: 'Feb', year: 2028 });
    expect(d.calls[0].params).toEqual(['2028-02-01', '2028-02-29']);
  });

  it('monthly cash book closing = opening + receipts - payments', async () => {
    const d = ds([
      [/COUNT\(DISTINCT/, [{ count: '1' }]],
      [/GROUP BY headcode/, [{ code: 'A1', headName: 'H', receipt: '1000', payment: '400' }]],
      [/COALESCE\(SUM\(COALESCE/, [{ balance: '250' }]],
    ]);
    const r: any = await new CashBookReportsService(d).getCashBookMonthly({ month: 'Sep', year: 2026 });
    expect(r.openingBalance).toBe(250);
    expect(r.closingBalance).toBe(850);
  });

  it('monthly cash book paging keys continue from the offset', async () => {
    const d = ds([
      [/COUNT\(DISTINCT/, [{ count: '30' }]],
      [/GROUP BY headcode/, [{ code: 'A1', headName: 'H', receipt: '1', payment: '0' }, { code: 'A2', headName: 'H', receipt: '1', payment: '0' }]],
      [/COALESCE\(SUM\(COALESCE/, [{ balance: '0' }]],
    ]);
    const r: any = await new CashBookReportsService(d).getCashBookMonthly({ month: 'Sep', year: 2026, limit: 2, offset: 10 });
    expect(r.data.map((x: any) => x.key)).toEqual(['10', '11']);
  });

  it('detail ledger with an offset adds the balance of the skipped rows', async () => {
    const d = ds([
      [/SELECT head_name/, [{ head_name: 'X' }]],
      [/SELECT COUNT/, [{ count: '5' }]],
      [/\) pre/, [{ balance: '70' }]],
      [/< \$2::date/, [{ balance: '100' }]],
      [/ORDER BY trans_date ASC, trans_no ASC/, [{ trans_date: '2026-09-09', trans_type: 'DR', amount: '10' }]],
    ]);
    const r: any = await new CashBookReportsService(d).getDetailLedger({ head_code: 'A1', from_date: '2026-09-01', to_date: '2026-09-30', limit: 1, offset: 3 });
    expect(r.transactions[0].balance).toBe(180);
  });

  it('bank ledger opening balance and running balance carry through', async () => {
    const d = ds([
      [/SELECT head_name/, [{ head_name: 'SBI' }]],
      [/SELECT COUNT/, [{ count: '1' }]],
      [/< \$2::date/, [{ balance: '1000' }]],
      [/CAST\(trans_amt AS numeric\) as amount/, [{ trans_date: '2026-09-02', trans_type: 'CR', amount: '300' }]],
    ]);
    const r: any = await new CashBookReportsService(d).getBankDetailLedger({ bank_head_code: 'B1', from_date: '2026-09-01', to_date: '2026-09-30' });
    expect(r.openingBalance).toBe(1000);
    expect(r.transactions[0].balance).toBe(700);
  });

  it('bank ledger opening balance counts legacy P rows on the debit side (like DR) and R rows with the credits', async () => {
    const d = ds([[/SELECT head_name/, [{ head_name: 'SBI' }]], [/SELECT COUNT/, [{ count: '0' }]]]);
    await new CashBookReportsService(d).getBankDetailLedger({ bank_head_code: 'B1', from_date: '2026-09-01', to_date: '2026-09-30' });
    const ob = d.calls.find((c: any) => /< \$2::date/.test(c.sql));
    // legacy P counts on the debit side, so it is NOT subtracted with the credits (R / CR)
    expect(ob.sql).toContain("trans_type IN ('DR', 'P') THEN CAST(trans_amt AS numeric) ELSE -CAST(trans_amt AS numeric)");
  });
});

describe('report extra: member reports', () => {
  it('statement row keys are unique when an offset is used', async () => {
    const d = ds([
      [/FROM member_master m/, [{ mbno: '1', member_name: 'A', office_name: 'O' }]],
      [/SELECT COUNT/, [{ count: '9' }]],
      [/FROM ledger\s+WHERE mbno/, [{ date: '2026-09-01', type: 'CR', amount: '1' }, { date: '2026-09-02', type: 'CR', amount: '2' }, { date: '2026-09-03', type: 'CR', amount: '3' }]],
    ]);
    const r: any = await new MemberReportsService(d).getMemberStatement({ memberNo: '1', limit: 3, offset: 6 });
    expect(new Set(r.transactions.map((t: any) => t.key)).size).toBe(3);
  });

  it('statement of an unknown member is a not-found error, not a 200 with null', async () => {
    await expect(new MemberReportsService(ds([])).getMemberStatement({ memberNo: '404' })).rejects.toThrow();
  });

  it('member ledger running balance treats legacy R as credit and P as debit', async () => {
    const d = ds([[/FROM ledger l/, [
      { transDate: '2026-09-01', transType: 'R', transAmt: '500' },
      { transDate: '2026-09-02', transType: 'P', transAmt: '200' },
    ]]]);
    const r: any = await new MemberReportsService(d).getMemberLedger({ memberNo: '1', fromDate: '2026-09-01', toDate: '2026-09-30' });
    expect(r[1].runningBalance).toBe('300.00');
  });

  it('member ledger adds the head filter as a bound parameter', async () => {
    const d = ds([[/FROM ledger l/, []]]);
    await new MemberReportsService(d).getMemberLedger({ memberNo: '1', fromDate: '2026-09-01', toDate: '2026-09-30', headCode: "A1'; DROP TABLE ledger;--" });
    expect(d.calls[0].sql).not.toMatch(/DROP TABLE/);
    expect(d.calls[0].params[3]).toContain('DROP TABLE');
  });

  it('member ledger running balance is the cumulative CR minus DR', async () => {
    const d = ds([[/FROM ledger l/, [
      { transDate: 'a', transType: 'CR', transAmt: '100' },
      { transDate: 'b', transType: 'DR', transAmt: '30' },
      { transDate: 'c', transType: 'CR', transAmt: '5.5' },
    ]]]);
    const r: any = await new MemberReportsService(d).getMemberLedger({ memberNo: '1', fromDate: '2026-09-01', toDate: '2026-09-30' });
    expect(r.map((x: any) => x.runningBalance)).toEqual(['100.00', '70.00', '75.50']);
  });
});

describe('report extra: financial summary', () => {
  const svc = (rows: any[]) => new UtilityReportsService(ds([[/FROM\s+headmaster h/, rows]]));
  const dto = (o: any = {}) => ({ fromDate: '2026-04-01', toDate: '2026-09-30', includeOpBal: true, hideZeroClosing: false, hideZeroTrans: false, ...o }) as any;

  it('maps the rows and parses numbers', async () => {
    const r: any = await svc([{ head_code: 'A1', head_name: 'H', headtype: 'A', opening_balance: '10', period_debit: '5', period_credit: '2', closing_balance: '7' }]).getFinancialSummary(dto());
    expect(r[0]).toMatchObject({ headCode: 'A1', openingBalance: 10, periodDebit: 5, periodCredit: 2, closingBalance: 7 });
  });
  it('hideZeroClosing removes heads with a zero closing balance', async () => {
    const r: any = await svc([{ head_code: 'A1', closing_balance: '0' }, { head_code: 'A2', closing_balance: '5' }]).getFinancialSummary(dto({ hideZeroClosing: true }));
    expect(r.map((x: any) => x.headCode)).toEqual(['A2']);
  });
  it('hideZeroTrans removes heads with no period activity', async () => {
    const r: any = await svc([{ head_code: 'A1', period_debit: '0', period_credit: '0' }, { head_code: 'A2', period_debit: '1', period_credit: '0' }]).getFinancialSummary(dto({ hideZeroTrans: true }));
    expect(r.map((x: any) => x.headCode)).toEqual(['A2']);
  });
  it('SQL counts legacy R/P rows (CR/DR only would drop old data)', async () => {
    const d = ds([[/FROM\s+headmaster h/, []]]);
    await new UtilityReportsService(d).getFinancialSummary(dto());
    expect(d.calls[0].sql).toMatch(/'R'/);
  });
  it('passes the dates and the opening-balance flag as bound parameters', async () => {
    const d = ds([[/FROM\s+headmaster h/, []]]);
    await new UtilityReportsService(d).getFinancialSummary(dto({ includeOpBal: false }));
    expect(d.calls[0].params[2]).toBe(false);
  });
});

describe('report extra: financial statements', () => {
  it('createReportSchedule rolls back and reports failure when a detail insert fails', async () => {
    const qr = { connect: jest.fn(), startTransaction: jest.fn(), commitTransaction: jest.fn(), rollbackTransaction: jest.fn(), release: jest.fn(), query: jest.fn() };
    qr.query.mockResolvedValueOnce([{ id: 7 }]).mockRejectedValueOnce(new Error('x'));
    const d: any = { createQueryRunner: () => qr };
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const r: any = await new FinancialStatementsService(d).createReportSchedule({ schedule_name: 's', template_name: 't', report_type: 'TB', details: [{ particulars: 'p', code_from: 'A', code_to: 'B' }] });
    expect(r.success).toBe(false);
    expect(qr.rollbackTransaction).toHaveBeenCalled();
    expect(qr.commitTransaction).not.toHaveBeenCalled();
    expect(qr.release).toHaveBeenCalled();
  });
  it('createReportSchedule updating a schedule replaces its details inside one transaction', async () => {
    const qr = { connect: jest.fn(), startTransaction: jest.fn(), commitTransaction: jest.fn(), rollbackTransaction: jest.fn(), release: jest.fn(), query: jest.fn().mockResolvedValue([]) };
    const r: any = await new FinancialStatementsService({ createQueryRunner: () => qr } as any).createReportSchedule({ id: 3, schedule_name: 's', template_name: 't', report_type: 'TB', details: [{ particulars: 'p', code_from: 'A', code_to: 'B' }] });
    expect(r).toEqual({ success: true, data: { id: 3 } });
    expect(qr.query.mock.calls.map((c: any) => c[0]).join('|')).toMatch(/UPDATE.*DELETE.*INSERT/s);
  });
  it('executeReportSchedule totals lines and handles NULL sums (no rows in range)', async () => {
    const d = ds([
      [/FROM report_schedule_details/, [{ particulars: 'a', code_from: 'A', code_to: 'B' }, { particulars: 'b', code_from: 'C', code_to: 'D' }]],
      [/FROM tblcashbook/, (_s: string, p: any[]) => (p[3] === 'A' ? [{ cur_receipts: '100', cur_payments: '40', prog_receipts: '300', prog_payments: '90' }] : [{ cur_receipts: null, cur_payments: null, prog_receipts: null, prog_payments: null }])],
    ]);
    const r: any = await new FinancialStatementsService(d).executeReportSchedule({ scheduleId: 1, fromDate: '2026-09-01', toDate: '2026-09-30', financialYearStart: '2026-04-01' });
    expect(r.data.grandTotals).toMatchObject({ currentReceipts: 100, currentPayments: 40, currentBalance: 60, progressiveBalance: 210 });
  });
  it('executeReportSchedule says so when the schedule has no lines', async () => {
    const r: any = await new FinancialStatementsService(ds([])).executeReportSchedule({ scheduleId: 1, fromDate: 'a', toDate: 'b', financialYearStart: 'c' });
    expect(r.success).toBe(false);
  });
  it('getReportScheduleDetails reports a missing schedule', async () => {
    const r: any = await new FinancialStatementsService(ds([])).getReportScheduleDetails(9);
    expect(r.success).toBe(false);
  });
  it('balance sheet splits liabilities (1) and assets (2) and reports the difference', async () => {
    const d = ds([[/FROM \(/, [
      { head_code: 'L1', head_name: 'L', maincd: 1, closingbalance: '300' },
      { head_code: 'A1', head_name: 'A', maincd: 2, closingbalance: '250' },
    ]]]);
    const r: any = await new FinancialStatementsService(d).getBalanceSheet();
    expect(r.data.totals).toEqual({ totalLiabilities: 300, totalAssets: 250, netResult: 0, difference: -50 });
  });
  it('balance sheet refuses a malformed as-on date and never passes it to SQL (ES-332)', async () => {
    const d = ds([[/FROM \(/, []]]);
    await expect(new FinancialStatementsService(d).getBalanceSheet("2026-09-30'; DROP")).rejects.toThrow(/YYYY-MM-DD/);
    expect(d.calls).toHaveLength(0);
  });
  it('balance sheet suppress options add SQL filters', async () => {
    const d = ds([[/FROM \(/, []]]);
    await new FinancialStatementsService(d).getBalanceSheet(undefined, false, false);
    expect(d.calls[0].sql).toMatch(/ABS\(closingbalance\)/);
    expect(d.calls[0].sql).toMatch(/debit <> 0 OR credit <> 0/);
  });
});

describe('report extra: loan reports', () => {
  it('defaulter list binds min balance and loan type', async () => {
    const d = ds([[/FROM loan_master/, []]]);
    await new LoanReportsService(d, { getDueStatus: jest.fn() } as any).getDefaulterList({ minBalance: 500, loanType: 'RLN' });
    expect(d.calls[0].params).toEqual([500, 'RLN']);
  });
  it('loan ledger for an unknown case returns an empty ledger', async () => {
    const d = ds([[/FROM member_master/, [{ member_name: 'A' }]]]);
    const r: any = await new LoanReportsService(d, {} as any).getMemberLoanLedger({ memberNo: '1', loanCaseNo: '9' });
    expect(r.transactions).toEqual([]);
  });
  it('loan ledger running balance falls by principal only, not interest', async () => {
    const d = ds([
      [/FROM member_master/, [{ member_name: 'A' }]],
      [/FROM loan_master/, [{ loan_amt: '10000', payment_date: '2026-01-01', current_balance: '9000', no_of_instal: 10, instal_amt: '1100', rate: '12' }]],
      [/SUM\(principal_amount\)/, [{ principal_paid: '0' }]],
      [/FROM loan_repayment_ledger/, [{ date: '2026-02-01', payment_amount: '1100', principal_amount: '1000', interest_amount: '100', penal_amount: '0', is_payroll_lag_credit: false }]],
    ]);
    const r: any = await new LoanReportsService(d, {} as any).getMemberLoanLedger({ memberNo: '1', loanCaseNo: '1' });
    expect(r.closingBalance).toBe(9000);
  });
  it('loan ledger paging does not change the closing balance', async () => {
    const pay = Array.from({ length: 4 }, (_, i) => ({ date: `2026-0${i + 2}-01`, payment_amount: '100', principal_amount: '100', interest_amount: '0', penal_amount: '0', is_payroll_lag_credit: false }));
    const d = ds([
      [/FROM member_master/, [{ member_name: 'A' }]],
      [/FROM loan_master/, [{ loan_amt: '1000', payment_date: '2026-01-01', current_balance: '600' }]],
      [/SUM\(principal_amount\)/, [{ principal_paid: '0' }]],
      [/FROM loan_repayment_ledger/, pay],
    ]);
    const r: any = await new LoanReportsService(d, {} as any).getMemberLoanLedger({ memberNo: '1', loanCaseNo: '1', limit: 2, offset: 0 });
    expect(r.closingBalance).toBe(600);
    expect(r.transactions).toHaveLength(2);
  });
  it('loan ledger without a case accepts legacy D type as a debit', async () => {
    const d = ds([
      [/FROM member_master/, [{ member_name: 'A' }]],
      [/SELECT COUNT/, [{ count: '2' }]],
      [/FROM ledger\s+WHERE mbno/, [{ date: '2026-01-01', type: 'D', amount: '1000' }, { date: '2026-02-01', type: 'CR', amount: '200' }]],
    ]);
    const r: any = await new LoanReportsService(d, {} as any).getMemberLoanLedger({ memberNo: '1' });
    expect(JSON.stringify(r)).toContain('1000');
  });
});
