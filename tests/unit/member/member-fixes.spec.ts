import { MemberBalanceService } from '../../../src/modules/member/services-v2/member-balance.service';
import { photoUploadConfig, documentUploadConfig, signatureUploadConfig } from '../../../src/modules/member/config/multer.config';

const row = (o: any = {}) => ({ mbno: '5', member_name: 'A', office_name: 'HQ', basic_pay: '1', is_active: 'Y', shares: '0', compulsory_deposit: '0', rd_amount: '0', regular_loan_balance: '0', emergency_loan_balance: '0', frs_balance: '0', ...o });
const svcOf = (member: any, master: any[] = []) => new MemberBalanceService({ query: jest.fn(async (sql: string) => (/FROM member_master m/.test(sql) ? [member] : /FROM loan_master/.test(sql) ? master : [])) } as any);
beforeEach(() => { jest.spyOn(console, 'log').mockImplementation(() => undefined); jest.spyOn(console, 'error').mockImplementation(() => undefined); });
afterEach(() => jest.restoreAllMocks());

describe('member balance: every loan counted once (ES-396, ES-404)', () => {
  it('loan_master is the source when it has rows for a kind of loan, member_balances otherwise; other types are added', async () => {
    const both: any = await svcOf(row({ regular_loan_balance: '5000', emergency_loan_balance: '800' }), [{ loantype: 'RLN', total_balance: '5000' }, { loantype: 'ALN', total_balance: '800' }, { loantype: 'XYZ', total_balance: '100.10' }]).getMemberBalance('5');
    expect(both.summary.totalLiabilities).toBe(5900.1); expect(both.balanceItems.filter((i: any) => i.type === 'liability').map((i: any) => i.code)).toEqual(['RLN', 'ALN', 'XYZ']);
    const differ: any = await svcOf(row({ regular_loan_balance: '4000' }), [{ loantype: 'RLN', total_balance: '5000' }]).getMemberBalance('5');
    expect(differ.summary.totalLiabilities).toBe(5000); // loan_master wins when it has the loan
    const fill: any = await svcOf(row(), [{ loantype: 'RLN', total_balance: '700' }]).getMemberBalance('5');
    expect(fill.summary.totalLiabilities).toBe(700); expect(fill.loans.totalBalance).toBe(700);
  });
  it('quick balance and full balance give the same net for members with loan_master-only loans and RD/FRS', async () => {
    const member = row({ shares: '1000.10', compulsory_deposit: '500.20', rd_amount: '300', frs_balance: '50', regular_loan_balance: '200' });
    const master = [{ loantype: 'RLN', total_balance: '200' }, { loantype: 'XYZ', total_balance: '75.55' }];
    const full: any = await svcOf(member, master).getMemberBalance('5');
    const quickDs: any = { query: jest.fn(async (sql: string) => (/FROM member_balances mb/.test(sql) ? [{ shares: '1000.10', compulsory_deposit: '500.20', rd_amount: '300', frs_balance: '50', regular_loan: '200', emergency_loan: '0' }] : master)) };
    const quick: any = await new MemberBalanceService(quickDs).getQuickBalance('5');
    expect(quick.netBalance).toBe(full.summary.netBalance); expect(quick.totalLoans).toBe(full.summary.totalLiabilities);
  });
});

describe('upload file extensions come from the content type (ES-403)', () => {
  const name = (cfg: any, file: any, req: any = { params: { mbno: '1', type: 'photo' }, body: { docType: 'kyc' } }) => new Promise<string>((res, rej) => cfg.storage.getFilename(req, file, (e: any, v: string) => (e ? rej(e) : res(v))));
  it('.html / .exe / .php / double extension names get the extension of their real content type', async () => {
    for (const original of ['evil.html', 'virus.exe', 'shell.php', 'shell.php.png', 'a.PNG.html', 'noext']) {
      expect(await name(photoUploadConfig, { originalname: original, mimetype: 'image/png' })).toMatch(/\.png$/);
      expect(await name(signatureUploadConfig, { originalname: original, mimetype: 'image/jpeg' })).toMatch(/\.jpg$/);
      expect(await name(documentUploadConfig, { originalname: original, mimetype: 'application/pdf' })).toMatch(/\.pdf$/);
    }
  });
  it('without a known content type no extension from the client name is used', async () => {
    expect(await name(documentUploadConfig, { originalname: 'shell.php', mimetype: 'text/x-php' })).not.toMatch(/\.php$/);
    expect(await name(photoUploadConfig, { originalname: 'evil.html' })).toMatch(/\.jpg$/);
  });
});
