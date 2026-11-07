/**
 * Response ALLOW-LISTS for the member app (ES-223, PRD section 7.1).
 * Every route returns what these functions build, never a database row or a desktop service object. A field that is not named
 * here cannot reach a phone. Never add: Aadhaar, salary / pay, signature, document paths, staff user names, Loan Position
 * notices, payment "check this" flags, internal ledger fault text, other members' data (surety shows name + number only).
 * Money is always a string with two decimals ("125000.00") so nothing is lost in JSON numbers.
 */

export const money = (v: unknown): string => {
  const n = typeof v === 'number' ? v : parseFloat(String(v ?? '0'));
  return (Number.isFinite(n) ? n : 0).toFixed(2);
};

export const maskTail = (v: string | null | undefined, visible = 4): string | null => {
  const s = String(v ?? '').trim();
  if (!s) return null;
  return s.length <= visible ? s : 'X'.repeat(s.length - visible) + s.slice(-visible);
};

const LOAN_TYPE_NAMES: Record<string, string> = { RLN: 'Regular loan', ELN: 'Emergency loan', ALN: 'Additional loan' };
export const loanTypeName = (code: string | null | undefined): string => LOAN_TYPE_NAMES[String(code ?? '').toUpperCase()] ?? String(code ?? 'Loan');

const iso = (d: unknown): string | null => {
  if (!d) return null;
  const t = new Date(d as any);
  return Number.isNaN(t.getTime()) ? null : t.toISOString();
};
const dateOnly = (d: unknown): string | null => {
  if (!d) return null;
  if (typeof d === 'string' && /^\d{4}-\d{2}-\d{2}/.test(d)) return d.slice(0, 10);
  const t = new Date(d as any);
  if (Number.isNaN(t.getTime())) return null;
  // local (office) calendar day, not UTC, so "the 1st" is never shown as the 31st
  return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
};

// ───────────── profile ─────────────

export interface ProfileRow {
  mbno: string;
  name: string;
  designation?: string | null;
  office?: string | null;
  dob?: unknown;
  address?: string | null;
  phone?: string | null;
  email?: string | null;
  pan?: string | null;
  hasAadhaar?: boolean;
  retirementDate?: unknown;
  nomineeName?: string | null;
  nomineeRelation?: string | null;
  nomineeAddress?: string | null;
}

export function toProfile(r: ProfileRow) {
  return {
    memberNo: r.mbno,
    name: r.name,
    designation: r.designation ?? null,
    office: r.office ?? null,
    dateOfBirth: dateOnly(r.dob),
    address: r.address ?? null,
    phone: maskTail(r.phone?.replace(/\D/g, '').slice(-10)),
    email: r.email ? r.email.replace(/^(.).*(@.*)$/, '$1***$2') : null,
    pan: maskTail(r.pan, 4),
    kycVerified: !!(r.hasAadhaar && r.pan), // only a tick: the Aadhaar number itself never leaves the server
    retirementDate: dateOnly(r.retirementDate),
    nominee: r.nomineeName ? { name: r.nomineeName, relation: r.nomineeRelation ?? null, address: r.nomineeAddress ?? null } : null,
  };
}

// ───────────── accounts ─────────────

export interface BalanceSource {
  shares?: unknown;
  compulsory_deposit?: unknown;
  rd_amount?: unknown;
}
export interface SavingsSource {
  acc_no: string;
  balance: unknown;
  opening_date?: unknown;
  status?: string | null;
}

export function toAccountsSummary(b: BalanceSource, savings: SavingsSource[]) {
  const accounts = savings.map((s) => ({ accountNo: String(s.acc_no), balance: money(s.balance), openedOn: dateOnly(s.opening_date), status: s.status ?? null }));
  return {
    shares: money(b.shares),
    compulsoryDeposit: money(b.compulsory_deposit),
    savings: { total: money(accounts.reduce((sum, a) => sum + parseFloat(a.balance), 0)), accounts },
  };
}

// ───────────── loans ─────────────

export interface LoanSource {
  loancaseno: string | number;
  loantype: string;
  loan_amt: number;
  balance: number;
  no_of_instal?: number | null;
  instal_amt?: number | null;
  consolidatedIntoLoancaseno?: string | number | null;
  ledgerShowsRepaid?: boolean;
  rate?: unknown;
  payment_date?: unknown;
  purpose?: string | null;
  /** true when staff flagged this account for a manual balance confirmation (internal reason is never exposed) */
  needsOfficeVisit?: boolean;
}

export type LoanStatus = 'ACTIVE' | 'CLOSED' | 'MERGED';

export function toLoan(l: LoanSource) {
  const merged = !!l.consolidatedIntoLoancaseno;
  const status: LoanStatus = merged ? 'MERGED' : l.balance > 0 ? 'ACTIVE' : 'CLOSED';
  return {
    caseNo: String(l.loancaseno),
    loanType: String(l.loantype),
    loanTypeName: loanTypeName(l.loantype),
    sanctionedAmount: money(l.loan_amt),
    outstanding: money(merged ? 0 : l.balance),
    emi: money(l.instal_amt),
    tenureMonths: l.no_of_instal ?? null,
    interestRate: l.rate === undefined || l.rate === null ? null : String(Number(l.rate)),
    disbursedOn: dateOnly(l.payment_date),
    purpose: l.purpose ?? null,
    status,
    mergedIntoCaseNo: merged ? String(l.consolidatedIntoLoancaseno) : null,
    // PRD 7.3: a neutral line, never the internal reason
    needsOfficeVisit: !!(l.needsOfficeVisit || (status === 'ACTIVE' && l.ledgerShowsRepaid)),
  };
}

export interface ScheduleRowSource {
  month: number;
  dueDate: string;
  emiAmount: number;
  principalAmount: number;
  interestAmount: number;
  balance: number;
  status: string;
}

export function toScheduleRow(r: ScheduleRowSource) {
  const status = String(r.status).toUpperCase(); // PAID, PENDING, OVERDUE
  return {
    installmentNo: r.month,
    dueDate: dateOnly(r.dueDate),
    emi: money(r.emiAmount),
    principal: money(r.principalAmount),
    interest: money(r.interestAmount),
    balanceAfter: money(r.balance),
    status: status === 'PAID' ? 'PAID' : status === 'OVERDUE' ? 'OVERDUE' : 'UPCOMING',
  };
}

export interface RepaymentSource {
  id: number;
  payment_date: unknown;
  payment_amount: unknown;
  principal_amount?: unknown;
  interest_amount?: unknown;
  penal_amount?: unknown;
  payment_source?: string | null;
  receipt_no?: string | null;
}

// payment_source values seen in loan_repayment_ledger: DEMAND (salary deduction) and CASH (counter)
const SOURCE_NAMES: Record<string, string> = { DEMAND: 'Salary deduction', PAYROLL: 'Salary deduction', CASH: 'Counter', MANUAL: 'Counter', COUNTER: 'Counter' };

export function toRepayment(r: RepaymentSource) {
  const src = String(r.payment_source ?? '').toUpperCase();
  return {
    id: Number(r.id),
    date: dateOnly(r.payment_date),
    amount: money(r.payment_amount),
    principal: money(r.principal_amount),
    interest: money(r.interest_amount),
    penalty: money(r.penal_amount),
    mode: SOURCE_NAMES[src] ?? (src ? 'Other' : null),
    receiptNo: r.receipt_no ?? null,
  };
}

// ───────────── ledger / passbook ─────────────

export interface LedgerEntrySource {
  date: unknown;
  accountHead: string;
  voucherNo?: string | null;
  particulars?: string | null;
  debit: number;
  credit: number;
  balance?: number;
}

export function toLedgerEntry(e: LedgerEntrySource) {
  return {
    date: dateOnly(e.date),
    head: e.accountHead,
    voucherNo: e.voucherNo ?? null,
    particulars: (e.particulars ?? '').toString().slice(0, 140),
    debit: money(e.debit),
    credit: money(e.credit),
    balance: e.balance === undefined || e.balance === null ? null : money(e.balance),
  };
}

// ───────────── notices ─────────────

export interface NoticeSource {
  id: number;
  title: string;
  message: string;
  type: string;
  created_at: unknown;
}

export function toNotice(n: NoticeSource) {
  return { id: Number(n.id), title: n.title, message: n.message, type: n.type, postedAt: iso(n.created_at) };
}

// ───────────── paging ─────────────

/** Opaque cursor: the offset of the next row. */
export const encodeCursor = (offset: number): string => Buffer.from(JSON.stringify({ o: offset })).toString('base64url');
export const decodeCursor = (c?: string): number => {
  if (!c) return 0;
  try {
    const o = Number(JSON.parse(Buffer.from(c, 'base64url').toString('utf8')).o);
    return Number.isInteger(o) && o >= 0 ? o : 0;
  } catch {
    return 0;
  }
};
export function page<T>(all: T[], cursor: string | undefined, limit: number): { items: T[]; nextCursor: string | null } {
  const start = decodeCursor(cursor);
  const size = Math.min(Math.max(Math.trunc(limit) || 50, 1), 100); // server cap 100 (PRD 8.6)
  const items = all.slice(start, start + size);
  return { items, nextCursor: start + size < all.length ? encodeCursor(start + size) : null };
}
