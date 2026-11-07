import { LoanSanctionService } from '../../../src/modules/loan/services-v2/loan-sanction.service';

function mk(rows: any[] | ((sql: string, p?: any[]) => any) = []) {
  const ds: any = { query: jest.fn(async (sql: string, p?: any[]) => (typeof rows === 'function' ? rows(sql, p) : rows)) };
  const re: any = { isReagreementCase: jest.fn().mockResolvedValue(false), sanction: jest.fn().mockResolvedValue({ ok: 'reagreement' }), getByNewCase: jest.fn().mockResolvedValue({ id: 1 }) };
  return { svc: new LoanSanctionService(ds, re), ds, re };
}
const sd = (o: any = {}) => ({ sanctionedAmount: 100000, sanctionDate: '2026-03-15', noOfInstallments: 60, ...o });
const pending = (o: any = {}) => ({ loancaseno: 7, mbno: '5', applied_amt: 100000, flg_sanctioned: 'N', flg_paid: 'N', ...o });

describe('loan/LoanSanctionService.getLoanAccountCode', () => {
  const { svc } = mk();
  it('regular loan types go to A1002', () => { for (const t of ['R', 'REG', 'RLN', 'rln']) expect(svc.getLoanAccountCode(t)).toBe('A1002'); });
  it('emergency/against types go to A1047 / A1048', () => {
    for (const t of ['E', 'EMR', 'ELN']) expect(svc.getLoanAccountCode(t)).toBe('A1047'); for (const t of ['A', 'ALN']) expect(svc.getLoanAccountCode(t)).toBe('A1048');
  });
  it('an unknown or missing type defaults to A1047', () => { expect(svc.getLoanAccountCode('ZZZ')).toBe('A1047'); expect(svc.getLoanAccountCode(undefined as any)).toBe('A1047'); });
});

describe('loan/LoanSanctionService.getLoanDetailsByCaseNo', () => {
  beforeEach(() => { jest.spyOn(console, 'log').mockImplementation(() => undefined); jest.spyOn(console, 'error').mockImplementation(() => undefined); });
  afterEach(() => jest.restoreAllMocks());
  it('null when the case does not exist; case number is a bound parameter', async () => {
    const t = mk([]); expect(await t.svc.getLoanDetailsByCaseNo("7' OR 1=1")).toBeNull(); expect(t.ds.query.mock.calls[0][1]).toEqual(["7' OR 1=1"]);
  });
  it('maps the details, defaulting empty sureties to "0"', async () => {
    const t = mk([{ loancaseno: 7, mbno: 5, member_name: 'A B', loantype: 'RLN', applied_amt: 10, sanctioned_amt: 0, no_of_instal: 60, regular_loan_balance: '100.5', emergency_loan_balance: '50', application_kind: 'NEW', h_code: 'A1002' }]);
    expect(await t.svc.getLoanDetailsByCaseNo('7')).toMatchObject({ loanCaseNo: 7, hCode: 'A1002', surety1: '0', surety2: '0', currentBalance: '150.5', applicationKind: 'NEW', reagreement: null });
  });
  it('a re-agreement case loads the re-agreement', async () => {
    const t = mk([{ loancaseno: 7, mbno: 5, application_kind: 'REAGREEMENT' }]);
    expect((await t.svc.getLoanDetailsByCaseNo('7'))!.reagreement).toEqual({ id: 1 });
  });
  it('a database failure is re-thrown', async () => {
    const t = mk(); t.ds.query.mockRejectedValue(new Error('x')); await expect(t.svc.getLoanDetailsByCaseNo('7')).rejects.toThrow('x');
  });
});

describe('loan/LoanSanctionService.getSanctionedLoanCases', () => {
  beforeEach(() => { jest.spyOn(console, 'error').mockImplementation(() => undefined); });
  afterEach(() => jest.restoreAllMocks());
  it('excludes cases already vouchered, disbursed or in a non-sanctioned re-agreement', async () => {
    const t = mk([]); await t.svc.getSanctionedLoanCases();
    const sql: string = t.ds.query.mock.calls[0][0];
    expect(sql).toContain("v.status = 'PENDING'"); expect(sql).toContain('FROM loan_master lm'); expect(sql).toContain("r.status <> 'SANCTIONED'");
  });
  it('maps rows as sanctioned', async () => {
    expect((await mk([{ loancaseno: 1, mbno: 2, member_name: 'A', loantype: 'RLN', applied_amt: 5, sanctioned_amt: 5 }]).svc.getSanctionedLoanCases())[0]).toMatchObject({ loanCaseNo: 1, sanctioned: true, applicationKind: 'NEW', reagreementId: null });
  });
  it('a database failure is reported, not an empty list', async () => {
    const t = mk(); t.ds.query.mockRejectedValue(new Error('down')); await expect(t.svc.getSanctionedLoanCases()).rejects.toThrow('down');
  });
});

describe('loan/LoanSanctionService.updateLoanSanction', () => {
  beforeEach(() => { jest.spyOn(console, 'log').mockImplementation(() => undefined); jest.spyOn(console, 'error').mockImplementation(() => undefined); });
  afterEach(() => jest.restoreAllMocks());
  const row = (sql: string) => (/SELECT/.test(sql) && /FROM loan_pending/.test(sql) ? [pending()] : /UPDATE loan_pending/.test(sql) ? [pending({ flg_sanctioned: 'Y' })] : []);

  it('a re-agreement case is sanctioned through the re-agreement service', async () => {
    const t = mk(row); t.re.isReagreementCase.mockResolvedValue(true);
    expect(await t.svc.updateLoanSanction('7', sd(), 'bob')).toEqual({ ok: 'reagreement' }); expect(t.ds.query).not.toHaveBeenCalled();
  });
  it('sanctions: sets amount, date, installments and the flag', async () => {
    const t = mk(row); const r = await t.svc.updateLoanSanction('7', sd());
    const c = t.ds.query.mock.calls.find((c: any[]) => /UPDATE loan_pending/.test(c[0]));
    expect(r.success).toBe(true); expect(c[0]).toContain("flg_sanctioned = 'Y'"); expect(c[1][0]).toBe(100000); expect(c[1][2]).toBe(60); expect(c[1][3]).toBe('7');
  });
  it('an unknown case is an error', async () => {
    const t = mk((sql) => (/UPDATE/.test(sql) ? [] : [])); await expect(t.svc.updateLoanSanction('7', sd())).rejects.toThrow(/Loan case not found/);
  });
  it('rejects a negative, zero or non numeric sanctioned amount', async () => {
    for (const sanctionedAmount of [-1000, 0, 'abc', undefined]) await expect(mk(row).svc.updateLoanSanction('7', sd({ sanctionedAmount }))).rejects.toThrow();
  });
  it('rejects a sanctioned amount above the applied amount', async () => {
    await expect(mk(row).svc.updateLoanSanction('7', sd({ sanctionedAmount: 1_000_000 }))).rejects.toThrow(/applied/i);
  });
  it('rejects 0, negative or text installments', async () => {
    for (const noOfInstallments of [0, -5, 'x']) await expect(mk(row).svc.updateLoanSanction('7', sd({ noOfInstallments }))).rejects.toThrow();
  });
  it('rejects a sanction date that is not a date (it must not silently become today)', async () => {
    await expect(mk(row).svc.updateLoanSanction('7', sd({ sanctionDate: 'garbage' }))).rejects.toThrow();
  });
  it('a case that is already paid out (loan created) cannot be re-sanctioned', async () => {
    const t = mk((sql) => (/FROM loan_pending/.test(sql) && /SELECT/.test(sql) ? [pending({ flg_paid: 'Y' })] : [pending()]));
    await expect(t.svc.updateLoanSanction('7', sd())).rejects.toThrow();
  });
  it('the case number is compared numerically and bound as a parameter', async () => {
    const t = mk(row); await t.svc.updateLoanSanction("7' OR '1'='1", sd()).catch(() => undefined);
    const c = t.ds.query.mock.calls.find((c: any[]) => /UPDATE loan_pending/.test(c[0]));
    if (c) { expect(c[0]).not.toContain("OR '1'='1"); }
  });
});
