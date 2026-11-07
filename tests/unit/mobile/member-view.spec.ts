import {
  decodeCursor, encodeCursor, money, page, toAccountsSummary, toLedgerEntry, toLoan, toNotice, toProfile, toRepayment, toScheduleRow,
} from '../../../src/modules/mobile/data/member-view.mappers';

/** Keys that must never be in any response sent to a phone (PRD 7.1). Also used by the e2e test on real data. */
export const FORBIDDEN_KEY = /aadh?a?a?r|basic_?pay|gross|salary|signature|password|mpin|secret|token_?hash|posted_?by|user_?name|pf_?no|doc_?(front|back)|photo_?path|loan_?position|checked_?(by|note)|flag_?code|ledger_?balance|ledgerShowsRepaid|is_payroll|payroll_lag|created_?by/i;

export function scanKeys(value: unknown, path = ''): string[] {
  if (Array.isArray(value)) return value.flatMap((v, i) => scanKeys(v, `${path}[${i}]`));
  if (value && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>).flatMap(([k, v]) => (FORBIDDEN_KEY.test(k) ? [`${path}.${k}`] : []).concat(scanKeys(v, `${path}.${k}`)));
  }
  return [];
}

// Every source object carries sentinel values for the things that must NOT leave the server.
const SENTINELS = ['AADHAAR-SENTINEL-1234', 'SALARY-SENTINEL-99999', 'SIGNATURE-SENTINEL', 'FLAGTEXT-SENTINEL', 'STAFFNAME-SENTINEL', 'LAGCREDIT-SENTINEL'];
const leaks = (out: unknown) => SENTINELS.filter((s) => JSON.stringify(out).includes(s));

describe('response allow-lists never leak internal fields (ES-223)', () => {
  it('profile: no Aadhaar number, salary or signature; phone/PAN/email masked', () => {
    const out = toProfile({
      mbno: '900000001', name: 'Test Member', designation: 'Clerk', office: 'Main Office', dob: '1980-02-03', address: 'Somewhere',
      phone: '9876543210', email: 'someone@example.com', pan: 'ABCDE1234F', hasAadhaar: true, retirementDate: '2040-02-03',
      nomineeName: 'Nominee', nomineeRelation: 'Wife', nomineeAddress: 'Home',
      // extras a careless caller might pass:
      ...({ aadharno: SENTINELS[0], basic_pay: SENTINELS[1], gross_salary: SENTINELS[1], signature_image_path: SENTINELS[2] } as object),
    } as any);
    expect(leaks(out)).toEqual([]);
    expect(scanKeys(out)).toEqual([]);
    expect(out.phone).toBe('XXXXXX3210');
    expect(out.pan).toBe('XXXXXX234F');
    expect(out.email).toBe('s***@example.com');
    expect(out.kycVerified).toBe(true);
    expect(out.dateOfBirth).toBe('1980-02-03');
  });

  it('profile: KYC tick needs both an Aadhaar on record and a PAN, and missing data stays null', () => {
    expect(toProfile({ mbno: '1', name: 'A', hasAadhaar: true, pan: '' }).kycVerified).toBe(false);
    const empty = toProfile({ mbno: '1', name: 'A' });
    expect(empty).toMatchObject({ phone: null, email: null, pan: null, nominee: null, dateOfBirth: null });
  });

  it('loan: shows only the allowed fields, hides internal flags and the reason behind "visit the office"', () => {
    const out = toLoan({
      loancaseno: '4501', loantype: 'RLN', loan_amt: 100000, balance: 62500.5, no_of_instal: 24, instal_amt: 4800, rate: '9.5',
      payment_date: '2025-03-10T00:00:00', purpose: 'Home repair', ledgerShowsRepaid: true, needsOfficeVisit: false,
      ...({ ledgerBalance: 12.5, gracedays: 5, penalrate: 2, payroll_lag_old_principal: 100, checked_note: SENTINELS[3] } as object),
    } as any);
    expect(scanKeys(out)).toEqual([]);
    expect(leaks(out)).toEqual([]);
    expect(out).toMatchObject({ caseNo: '4501', loanType: 'RLN', loanTypeName: 'Regular loan', sanctionedAmount: '100000.00', outstanding: '62500.50', emi: '4800.00', status: 'ACTIVE', needsOfficeVisit: true });
    expect(Object.keys(out).sort()).toEqual(['caseNo', 'disbursedOn', 'emi', 'interestRate', 'loanType', 'loanTypeName', 'mergedIntoCaseNo', 'needsOfficeVisit', 'outstanding', 'purpose', 'sanctionedAmount', 'status', 'tenureMonths'].sort());
  });

  it('loan: closed, merged and flagged states', () => {
    expect(toLoan({ loancaseno: 1, loantype: 'ELN', loan_amt: 5000, balance: 0 }).status).toBe('CLOSED');
    const merged = toLoan({ loancaseno: 1, loantype: 'RLN', loan_amt: 5000, balance: 900, consolidatedIntoLoancaseno: 77 });
    expect(merged).toMatchObject({ status: 'MERGED', outstanding: '0.00', mergedIntoCaseNo: '77' });
    // "ledger shows repaid" only matters for an active loan; a closed loan never asks the member to visit
    expect(toLoan({ loancaseno: 1, loantype: 'RLN', loan_amt: 5000, balance: 0, ledgerShowsRepaid: true }).needsOfficeVisit).toBe(false);
    expect(toLoan({ loancaseno: 1, loantype: 'RLN', loan_amt: 5000, balance: 100, needsOfficeVisit: true }).needsOfficeVisit).toBe(true);
  });

  it('repayment: no staff name, narration or payroll-lag marker', () => {
    const out = toRepayment({
      id: 9, payment_date: '2026-09-05', payment_amount: '4800', principal_amount: '3900.5', interest_amount: '899.5', penal_amount: '0', payment_source: 'DEMAND', receipt_no: 'R-77',
      ...({ posted_by: SENTINELS[4], narration: SENTINELS[3], is_payroll_lag_credit: SENTINELS[5] } as object),
    } as any);
    expect(scanKeys(out)).toEqual([]);
    expect(leaks(out)).toEqual([]);
    expect(out).toMatchObject({ amount: '4800.00', principal: '3900.50', mode: 'Salary deduction' });
    expect(toRepayment({ id: 1, payment_date: '2026-01-01', payment_amount: 1, payment_source: 'CASH' }).mode).toBe('Counter');
    expect(toRepayment({ id: 1, payment_date: '2026-01-01', payment_amount: 1, payment_source: 'WEIRD' }).mode).toBe('Other');
  });

  it('schedule row: only PAID / OVERDUE / UPCOMING', () => {
    const row = { month: 3, dueDate: '2026-12-05', emiAmount: 4800, principalAmount: 3900, interestAmount: 900, balance: 50000 };
    expect(toScheduleRow({ ...row, status: 'Paid' }).status).toBe('PAID');
    expect(toScheduleRow({ ...row, status: 'Overdue' }).status).toBe('OVERDUE');
    expect(toScheduleRow({ ...row, status: 'Pending' }).status).toBe('UPCOMING');
    expect(toScheduleRow({ ...row, status: 'Whatever' }).status).toBe('UPCOMING');
    expect(toScheduleRow({ ...row, status: 'Paid' })).toMatchObject({ installmentNo: 3, dueDate: '2026-12-05', emi: '4800.00', balanceAfter: '50000.00' });
  });

  it('ledger entry: trims long particulars and keeps money as strings', () => {
    const out = toLedgerEntry({ date: '2026-09-05T00:00:00', accountHead: 'Savings', voucherNo: 'V1', particulars: 'x'.repeat(300), debit: 0, credit: 1200.5, ...({ username: SENTINELS[4] } as object) } as any);
    expect(out.particulars).toHaveLength(140);
    expect(out).toMatchObject({ head: 'Savings', debit: '0.00', credit: '1200.50', balance: null });
    expect(leaks(out)).toEqual([]);
    expect(scanKeys(out)).toEqual([]);
  });

  it('accounts and notices: allow-listed', () => {
    const acc = toAccountsSummary({ shares: 5000, compulsory_deposit: '12000.5', ...({ int_rate: 8, regularloan: 99999 } as object) } as any, [{ acc_no: 'S-1', balance: 100.25, opening_date: '2024-01-01', status: 'ACTIVE' }, { acc_no: 'S-2', balance: 50 }]);
    expect(acc).toMatchObject({ shares: '5000.00', compulsoryDeposit: '12000.50', savings: { total: '150.25' } });
    expect(JSON.stringify(acc)).not.toContain('99999');
    const n = toNotice({ id: 3, title: 'AGM', message: 'On 5th', type: 'info', created_at: '2026-10-01T10:00:00Z', ...({ posted_by: SENTINELS[4] } as object) } as any);
    expect(leaks(n)).toEqual([]);
    expect(n).toMatchObject({ id: 3, title: 'AGM', postedAt: '2026-10-01T10:00:00.000Z' });
  });
});

describe('money and paging', () => {
  it('money is always a 2-decimal string and never NaN', () => {
    expect(money(1)).toBe('1.00');
    expect(money('12.345')).toBe('12.35');
    expect(money(null)).toBe('0.00');
    expect(money('abc')).toBe('0.00');
  });
  it('page() uses an opaque cursor, caps the size at 100 and ends with null', () => {
    const all = Array.from({ length: 230 }, (_, i) => i);
    const p1 = page(all, undefined, 500);
    expect(p1.items).toHaveLength(100);
    const p2 = page(all, p1.nextCursor!, 100);
    expect(p2.items[0]).toBe(100);
    const p3 = page(all, p2.nextCursor!, 100);
    expect(p3.items).toHaveLength(30);
    expect(p3.nextCursor).toBeNull();
    expect(decodeCursor(encodeCursor(40))).toBe(40);
    expect(decodeCursor('not-a-cursor')).toBe(0);
    expect(page([], undefined, 10)).toEqual({ items: [], nextCursor: null });
  });
});
