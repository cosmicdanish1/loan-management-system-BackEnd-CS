import { NotFoundException } from '@nestjs/common';
import { LoanSuretyService } from '../../../src/modules/loan/services-v2/loan-surety.service';

function mk(opts: { members?: Record<string, any>; pending?: any[]; sm?: any[]; fail?: RegExp } = {}) {
  const members = opts.members ?? { '8': { mbno: '8', isactive: 'Y', name: 'S One' }, '9': { mbno: '9', isactive: 'Y', name: 'S Two' }, '5': { mbno: '5', isactive: 'Y', name: 'Borrower' } };
  const route = (sql: string, p?: any[]) => {
    if (opts.fail?.test(sql)) throw new Error('db error');
    if (/FROM member_master\s+WHERE mbno = \$1/.test(sql)) return members[String(p![0])] ? [members[String(p![0])]] : [];
    if (/FROM loan_pending\s+WHERE loancaseno/.test(sql)) return opts.pending ?? [{ mbno: '5', loancaseno: '77', g1mbno: '1', g2mbno: '2' }];
    if (/UPDATE suretymaster/.test(sql)) return opts.sm ?? [{ mbno: '5' }];
    return [];
  };
  const qr: any = { connect: jest.fn(), startTransaction: jest.fn(), commitTransaction: jest.fn(), rollbackTransaction: jest.fn(), release: jest.fn(), query: jest.fn(async (s: string, p?: any[]) => route(s, p)) };
  const ds: any = { query: jest.fn(async (s: string, p?: any[]) => route(s, p)), createQueryRunner: jest.fn(() => qr) };
  return { svc: new LoanSuretyService(ds), ds, qr };
}

describe('loan/LoanSuretyService.validateSurety', () => {
  beforeEach(() => { jest.spyOn(console, 'log').mockImplementation(() => undefined); jest.spyOn(console, 'error').mockImplementation(() => undefined); });
  afterEach(() => jest.restoreAllMocks());
  it('unknown member is invalid', async () => { expect(await mk().svc.validateSurety('1234')).toEqual({ valid: false, message: 'Member 1234 not found' }); });
  it('an inactive member is invalid and named', async () => {
    const t = mk({ members: { '8': { mbno: '8', isactive: 'N', name: 'Old Man' } } });
    expect(await t.svc.validateSurety('8')).toEqual({ valid: false, message: 'Member 8 (Old Man) is not active' });
  });
  it('an active member is valid', async () => { expect(await mk().svc.validateSurety('8')).toEqual({ valid: true }); });
  it('a database error is not reported as "invalid member"', async () => {
    const t = mk(); t.ds.query.mockRejectedValue(new Error('down'));
    await expect(t.svc.validateSurety('8')).rejects.toThrow('down');
  });
  it('the member number is a bound parameter', async () => {
    const t = mk(); await t.svc.validateSurety("8' OR '1'='1"); expect(t.ds.query.mock.calls[0][1]).toEqual(["8' OR '1'='1"]);
  });
});

describe('loan/LoanSuretyService.changeLoanSurety', () => {
  beforeEach(() => { jest.spyOn(console, 'log').mockImplementation(() => undefined); jest.spyOn(console, 'error').mockImplementation(() => undefined); });
  afterEach(() => jest.restoreAllMocks());
  it('an invalid surety 1 or surety 2 is refused before anything is written', async () => {
    const t = mk(); await expect(t.svc.changeLoanSurety('77', { surety1: '404' })).rejects.toThrow(/Surety 1: Member 404 not found/);
    await expect(t.svc.changeLoanSurety('77', { surety1: '8', surety2: '404' })).rejects.toThrow(/Surety 2/);
    expect(t.qr.connect).not.toHaveBeenCalled();
  });
  it('unknown loan case is a 404 before anything else is checked or opened (ES-371)', async () => {
    const t = mk({ pending: [] }); await expect(t.svc.changeLoanSurety('77', { surety1: '404' })).rejects.toThrow(/Loan case 77 not found/);
    await expect(mk({ pending: [] }).svc.changeLoanSurety('77', { surety1: '8' })).rejects.toBeInstanceOf(NotFoundException);
    expect(t.qr.connect).not.toHaveBeenCalled();
  });
  it('updates loan_pending and suretymaster in one transaction', async () => {
    const t = mk(); const r = await t.svc.changeLoanSurety('77', { surety1: '8', surety2: '9' });
    expect(r).toMatchObject({ success: true, memberNo: '5', loanCaseNo: '77', updatedTables: { loan_pending: true, suretymaster: true } });
    expect(t.qr.commitTransaction).toHaveBeenCalledTimes(1);
  });
  it('a missing second surety is stored as NULL', async () => {
    const t = mk(); await t.svc.changeLoanSurety('77', { surety1: '8' });
    expect(t.qr.query.mock.calls.find((c: any[]) => /UPDATE loan_pending/.test(c[0]))[1]).toEqual(['8', null, '77']);
  });
  it('a member cannot stand surety for his own loan', async () => {
    const t = mk(); await expect(t.svc.changeLoanSurety('77', { surety1: '5' })).rejects.toThrow();
    expect(t.qr.query.mock.calls.some((c: any[]) => /UPDATE loan_pending/.test(c[0]))).toBe(false);
  });
  it('the same member cannot be both sureties', async () => {
    const t = mk(); await expect(t.svc.changeLoanSurety('77', { surety1: '8', surety2: '8' })).rejects.toThrow();
  });
  it('the change of one case does not rewrite the sureties of the member\'s other loans (suretymaster is updated by case)', async () => {
    const t = mk(); await t.svc.changeLoanSurety('77', { surety1: '8' });
    const sm = t.qr.query.mock.calls.find((c: any[]) => /UPDATE suretymaster/.test(c[0]));
    expect(sm[0]).toMatch(/loancaseno/);
  });
  it('a loan that is already disbursed (in loan_master) cannot have its surety changed silently', async () => {
    const t = mk({ pending: [{ mbno: '5', loancaseno: '77', flg_paid: 'Y', g1mbno: '1', g2mbno: '2' }] });
    await expect(t.svc.changeLoanSurety('77', { surety1: '8' })).rejects.toThrow();
  });
  it('a failing update rolls back and releases', async () => {
    const t = mk({ fail: /UPDATE suretymaster/ }); await expect(t.svc.changeLoanSurety('77', { surety1: '8' })).rejects.toThrow(/Failed to update loan sureties/);
    expect(t.qr.rollbackTransaction).toHaveBeenCalled(); expect(t.qr.commitTransaction).not.toHaveBeenCalled();
  });
  it('a connection failure does not call rollback on a transaction that never started', async () => {
    const t = mk(); t.qr.connect.mockRejectedValue(new Error('no connection'));
    await expect(t.svc.changeLoanSurety('77', { surety1: '8' })).rejects.toThrow(/no connection/); expect(t.qr.rollbackTransaction).not.toHaveBeenCalled();
  });
});

describe('loan/LoanSuretyService reads', () => {
  beforeEach(() => { jest.spyOn(console, 'log').mockImplementation(() => undefined); jest.spyOn(console, 'error').mockImplementation(() => undefined); });
  afterEach(() => jest.restoreAllMocks());
  it('getLoanSureties: null for an unknown case; empty strings for missing sureties', async () => {
    const t = mk(); t.ds.query.mockResolvedValueOnce([]); expect(await t.svc.getLoanSureties('1')).toBeNull();
    t.ds.query.mockResolvedValueOnce([{ loancaseno: 1, mbno: 5, surety1: null, surety2: null, surety1_name: null, surety2_name: null }]);
    expect(await t.svc.getLoanSureties('1')).toMatchObject({ surety1: '', surety2: '', surety1Name: '' });
  });
  it('getLoanSuretyCases uses the text member number and one row per case', async () => {
    const t = mk(); t.ds.query.mockResolvedValue([]); await t.svc.getLoanSuretyCases('5');
    expect(t.ds.query.mock.calls[0][1]).toEqual(['5']); expect(t.ds.query.mock.calls[0][0]).toContain('DISTINCT ON (lp.loancaseno)');
  });
  it('case status is ACTIVE once a loan_master row exists, SANCTIONED after sanction, else PENDING', async () => {
    const t = mk(); t.ds.query.mockResolvedValue([]); await t.svc.getLoanSuretyCases('5');
    const sql: string = t.ds.query.mock.calls[0][0]; expect(sql).toMatch(/'ACTIVE'[^]*'SANCTIONED'[^]*'PENDING'/);
  });
});
