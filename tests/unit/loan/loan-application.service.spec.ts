import { BadRequestException } from '@nestjs/common';
import { LoanApplicationService } from '../../../src/modules/loan/services-v2/loan-application.service';

interface Opt { unknownMembers?: string[]; pending?: any[]; outstanding?: number; card?: any; cfg?: Record<string, number>; suretyRows?: any[]; throwOn?: RegExp }
function mk(o: Opt = {}) {
  const calls: any[] = [];
  const route = (sql: string, p?: any[]) => {
    calls.push([sql, p]);
    if (o.throwOn && o.throwOn.test(sql)) throw new Error('db error');
    if (/FROM member_master/.test(sql)) return (o.unknownMembers ?? []).includes(String(p![0])) ? [] : [{ '?column?': 1 }];
    if (/FROM busrules/.test(sql)) return o.card ? [o.card] : [];
    if (/FROM member_balances/.test(sql)) return [{ total: o.outstanding ?? 0 }];
    if (/SELECT loancaseno.*FROM loan_pending/.test(sql)) return o.pending ?? [];
    if (/FROM suretymaster/.test(sql)) return o.suretyRows ?? [];
    if (/INSERT INTO loan_pending|UPDATE loan_pending/.test(sql)) return [{ loancaseno: p![p!.length - 1] }];
    return [];
  };
  const qr: any = { connect: jest.fn(), startTransaction: jest.fn(), commitTransaction: jest.fn(), rollbackTransaction: jest.fn(), release: jest.fn(), query: jest.fn(async (s: string, p?: any[]) => route(s, p)) };
  const ds: any = { query: jest.fn(async (s: string, p?: any[]) => route(s, p)), createQueryRunner: jest.fn(() => qr) };
  const seq: any = { generateNextLoanCaseNo: jest.fn().mockResolvedValue('1001') };
  const cfg: any = { getConfigValue: jest.fn(async (k: string) => { const v = (o.cfg ?? {})[k]; if (v === undefined) throw new Error('missing'); return v; }) };
  const elig: any = { enforceEligibility: jest.fn().mockResolvedValue(undefined) };
  return { svc: new LoanApplicationService(ds, seq, cfg, elig), ds, qr, seq, elig, calls };
}
const app = (x: any = {}) => ({ memberNo: '5', loanType: 'Regular', loanAmount: 100000, noOfInstallments: 60, ...x });

describe('loan/LoanApplicationService.saveLoanApplication', () => {
  beforeEach(() => { jest.spyOn(console, 'log').mockImplementation(() => undefined); jest.spyOn(console, 'error').mockImplementation(() => undefined); jest.spyOn(console, 'warn').mockImplementation(() => undefined); });
  afterEach(() => jest.restoreAllMocks());

  it('maps loan type names to RLN / ALN / ELN', async () => {
    for (const [name, code] of [['Regular', 'RLN'], ['EMERGENCY LOAN', 'ALN'], ['LOAN AGAINST RD', 'ELN']]) {
      const t = mk({ card: { max_amt: 1000000, max_inst: 120 } });
      await t.svc.saveLoanApplication(app({ loanType: name }));
      expect(t.qr.query.mock.calls.find((c: any[]) => /INSERT INTO loan_pending/.test(c[0]))[1][1]).toBe(code);
    }
  });
  it('allocates a case number when none is given and uses the given one otherwise', async () => {
    const t = mk({ card: { max_amt: 1000000, max_inst: 120 } });
    expect((await t.svc.saveLoanApplication(app())).loanCaseNo).toBe('1001');
    expect((await mk({ card: { max_amt: 1000000, max_inst: 120 } }).svc.saveLoanApplication(app({ loanCaseNo: '55' }))).loanCaseNo).toBe('55');
  });
  it('a new case is inserted unsanctioned and unpaid with sanctioned amount 0', async () => {
    const t = mk({ card: { max_amt: 1000000, max_inst: 120 } }); await t.svc.saveLoanApplication(app());
    const p = t.qr.query.mock.calls.find((c: any[]) => /INSERT INTO loan_pending/.test(c[0]))[1];
    expect(p[4]).toBe(0); expect(p[8]).toBe('N'); expect(p[9]).toBe('N');
  });
  it('rejects an amount over the Business Rules card limit (outstanding + applied)', async () => {
    const t = mk({ card: { max_amt: 500000, max_inst: 120 }, outstanding: 450000 });
    await expect(t.svc.saveLoanApplication(app({ loanAmount: 100000 }))).rejects.toThrow(/exceeds maximum limit/);
  });
  it('rejects a tenure over the card limit', async () => {
    const t = mk({ card: { max_amt: 500000, max_inst: 60 } });
    await expect(t.svc.saveLoanApplication(app({ noOfInstallments: 61 }))).rejects.toThrow(/exceeds maximum allowed tenure/);
  });
  it('falls back to system config when the card has no limits', async () => {
    const t = mk({ card: { max_amt: 0, max_inst: 0 }, cfg: { RULE_LOAN_LT_MAX_AMT: 200000, RULE_LOAN_LT_MAX_TENURE: 36 } });
    await expect(t.svc.saveLoanApplication(app({ loanAmount: 250000, noOfInstallments: 12 }))).rejects.toThrow(/2,00,000|200,000/);
  });
  it('loan against RD is not capped by outstanding + applied (but still by tenure)', async () => {
    const t = mk({ card: { max_amt: 100, max_inst: 120 }, outstanding: 5000 });
    await expect(t.svc.saveLoanApplication(app({ loanType: 'ELN', loanAmount: 900000, noOfInstallments: 24 }))).resolves.toBeDefined();
  });
  it('runs the central eligibility rules before saving', async () => {
    const t = mk({ card: { max_amt: 1000000, max_inst: 120 } }); t.elig.enforceEligibility.mockRejectedValue(new BadRequestException('not eligible'));
    await expect(t.svc.saveLoanApplication(app())).rejects.toThrow('not eligible'); expect(t.qr.connect).not.toHaveBeenCalled();
  });
  it('rejects a member that does not exist (ES-317)', async () => {
    const t = mk({ card: { max_amt: 1000000, max_inst: 120 }, unknownMembers: ['5'] });
    await expect(t.svc.saveLoanApplication(app())).rejects.toThrow(/was not found/);
    expect(t.qr.connect).not.toHaveBeenCalled();
  });
  it('rejects a surety that is not a member (ES-317)', async () => {
    const t = mk({ card: { max_amt: 1000000, max_inst: 120 }, unknownMembers: ['77'] });
    await expect(t.svc.saveLoanApplication(app({ surety1: '77' }))).rejects.toThrow(/First surety 77 is not a member/);
  });
  it('rejects an unknown loan type instead of guessing from its first letters (ES-317)', async () => {
    const t = mk({ card: { max_amt: 1000000, max_inst: 120 } });
    await expect(t.svc.saveLoanApplication(app({ loanType: 'ZZZ' }))).rejects.toThrow(/Loan type 'ZZZ' is not valid/);
  });
  it('rejects an application date far in the future (ES-317)', async () => {
    const t = mk({ card: { max_amt: 1000000, max_inst: 120 } });
    await expect(t.svc.saveLoanApplication(app({ applDate: '2099-01-01' }))).rejects.toThrow(/future/);
  });
  it('rejects an amount of 0, a negative amount and a non numeric amount', async () => {
    for (const loanAmount of [0, -5000, 'abc']) {
      const t = mk({ card: { max_amt: 1000000, max_inst: 120 } });
      await expect(t.svc.saveLoanApplication(app({ loanAmount }))).rejects.toThrow(BadRequestException);
    }
  });
  it('rejects 0 or negative installments (the default of 60 is only for a missing value)', async () => {
    for (const noOfInstallments of [-3, 'x']) {
      const t = mk({ card: { max_amt: 1000000, max_inst: 120 } });
      await expect(t.svc.saveLoanApplication(app({ noOfInstallments }))).rejects.toThrow(BadRequestException);
    }
  });
  it('a surety cannot be the borrower himself', async () => {
    const t = mk({ card: { max_amt: 1000000, max_inst: 120 } });
    await expect(t.svc.saveLoanApplication(app({ surety1: '5' }))).rejects.toThrow(BadRequestException);
  });
  it('the same member cannot be both sureties', async () => {
    const t = mk({ card: { max_amt: 1000000, max_inst: 120 } });
    await expect(t.svc.saveLoanApplication(app({ surety1: '8', surety2: '8' }))).rejects.toThrow(BadRequestException);
  });
  it('re-posting an existing case number of ANOTHER member does not overwrite that member\'s application', async () => {
    const t = mk({ card: { max_amt: 1000000, max_inst: 120 }, pending: [{ loancaseno: '55', mbno: '9' }] });
    await expect(t.svc.saveLoanApplication(app({ loanCaseNo: '55' }))).rejects.toThrow(BadRequestException);
    expect(t.qr.query.mock.calls.some((c: any[]) => /UPDATE loan_pending/.test(c[0]))).toBe(false);
  });
  it('re-posting an existing case of the same member updates it', async () => {
    const t = mk({ card: { max_amt: 1000000, max_inst: 120 }, pending: [{ loancaseno: '55', mbno: '5' }] });
    const r = await t.svc.saveLoanApplication(app({ loanCaseNo: '55' }));
    expect(r.message).toBe('Loan application updated successfully');
  });
  it('an application that is already sanctioned cannot be edited back to different terms', async () => {
    const t = mk({ card: { max_amt: 1000000, max_inst: 120 }, pending: [{ loancaseno: '55', mbno: '5', flg_sanctioned: 'Y' }] });
    await expect(t.svc.saveLoanApplication(app({ loanCaseNo: '55' }))).rejects.toThrow(BadRequestException);
  });
  it('writes the sureties into suretymaster (insert when the member has no row, update otherwise)', async () => {
    const a = mk({ card: { max_amt: 1000000, max_inst: 120 } }); await a.svc.saveLoanApplication(app({ surety1: '8', surety2: '9' }));
    expect(a.qr.query.mock.calls.some((c: any[]) => /INSERT INTO suretymaster/.test(c[0]))).toBe(true);
    const b = mk({ card: { max_amt: 1000000, max_inst: 120 }, suretyRows: [{ mbno: '5' }] }); await b.svc.saveLoanApplication(app({ surety1: '8', surety2: '9' }));
    expect(b.qr.query.mock.calls.some((c: any[]) => /UPDATE suretymaster/.test(c[0]))).toBe(true);
  });
  it('nominee rows are trimmed to column sizes, blank nominees are skipped, age must be an integer', async () => {
    const t = mk({ card: { max_amt: 1000000, max_inst: 120 } });
    const r = await t.svc.saveLoanApplication(app({ nominees: [{ name: 'N'.repeat(80), address: 'A'.repeat(80), age: '41x', relation: 'R'.repeat(40) }, { name: '  ' }] }));
    const ins = t.qr.query.mock.calls.find((c: any[]) => /INSERT INTO loan_nominee/.test(c[0]))[1];
    expect(r.nomineesSaved).toBe(1); expect(ins[2]).toHaveLength(50); expect(ins[3]).toHaveLength(50); expect(ins[4]).toBe(41); expect(ins[5]).toHaveLength(25);
  });
  it('FDR rows with a blank number are skipped; lien accepts true and "true"', async () => {
    const t = mk({ card: { max_amt: 1000000, max_inst: 120 } });
    const r = await t.svc.saveLoanApplication(app({ loanType: 'ELN', fdrDetails: [{ fdrNo: 'F1', lien: 'true', amount: '1000' }, { fdrNo: '' }] }));
    expect(r.fdrRowsSaved).toBe(1);
  });
  it('purpose is cut to 50 characters and form number to 10', async () => {
    const t = mk({ card: { max_amt: 1000000, max_inst: 120 } }); await t.svc.saveLoanApplication(app({ purpose: 'P'.repeat(90), formNumber: 'F'.repeat(30) }));
    const p = t.qr.query.mock.calls.find((c: any[]) => /INSERT INTO loan_pending/.test(c[0]))[1];
    expect(p[7]).toHaveLength(50); expect(p[10]).toHaveLength(10);
  });
  it('a failure in any step rolls everything back and releases the connection', async () => {
    const t = mk({ card: { max_amt: 1000000, max_inst: 120 }, throwOn: /INSERT INTO loan_pending/ });
    await expect(t.svc.saveLoanApplication(app())).rejects.toThrow(/Failed to save loan application/);
    expect(t.qr.rollbackTransaction).toHaveBeenCalled(); expect(t.qr.commitTransaction).not.toHaveBeenCalled(); expect(t.qr.release).toHaveBeenCalled();
  });
  it('an application date that is not a date is refused', async () => {
    const t = mk({ card: { max_amt: 1000000, max_inst: 120 } });
    await expect(t.svc.saveLoanApplication(app({ applDate: 'garbage' }))).rejects.toThrow(BadRequestException);
  });
});

describe('loan/LoanApplicationService lists', () => {
  beforeEach(() => { jest.spyOn(console, 'log').mockImplementation(() => undefined); jest.spyOn(console, 'error').mockImplementation(() => undefined); });
  afterEach(() => jest.restoreAllMocks());
  it('member loan cases map the columns and the member number is a bound parameter', async () => {
    const t = mk(); t.ds.query.mockResolvedValue([{ loancaseno: 7, loantype: 'RLN', loan_amt: '1000', balance: '0', purpose: 'x', flg_sanctioned: 'Y' }]);
    const r = await t.svc.getMemberLoanCases("5' OR 1=1");
    expect(r[0]).toMatchObject({ loanCaseNo: 7, loanType: 'RLN', sanctioned: true }); expect(t.ds.query.mock.calls[0][1]).toEqual(["5' OR 1=1"]);
  });
  it('list screens report a database failure instead of an empty list', async () => {
    const t = mk(); t.ds.query.mockRejectedValue(new Error('down'));
    await expect(t.svc.getAllLoanCases()).rejects.toThrow('down');
  });
  it('the all-cases list hides cases already turned into a voucher by re-agreement', async () => {
    const t = mk(); t.ds.query.mockResolvedValue([]); await t.svc.getAllLoanCases();
    expect(t.ds.query.mock.calls[0][0]).toContain("status = 'VOUCHERED'");
  });
  it('pending loans of a member map the sanctioned flag', async () => {
    const t = mk(); t.ds.query.mockResolvedValue([{ loancaseno: 1, loantype: 'ALN', applied_amt: 5, sanctioned_amt: 4, flg_sanctioned: 'N', app_date: 'd' }]);
    expect((await t.svc.getMemberPendingLoans('5'))[0]).toMatchObject({ loanCaseNo: 1, sanctioned: false });
  });
});
