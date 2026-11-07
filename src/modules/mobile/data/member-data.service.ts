import { BadRequestException, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { LoanQueryService } from '../../loan/services-v2/loan-query.service';
import { MemberLedgerService } from '../../member-ledger/member-ledger.service';
import { MemberBalanceService } from '../../member/services-v2/member-balance.service';
import { AppCodeService } from '../access/app-code.service';
import { MOBILE_DS } from '../mobile.constants';
import { FeatureFlagService } from './feature-flag.service';
import {
  LoanSource, money, page, toAccountsSummary, toLedgerEntry, toLoan, toNotice, toProfile, toRepayment, toScheduleRow,
} from './member-view.mappers';

export interface MemberCtx {
  mbno: string;
  deviceId: number;
}

const CASE_NO = /^\d{1,18}$/;
const LOAN_TYPE = /^[A-Za-z0-9]{2,5}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
export const LEDGER_FREE_MONTHS = 12;

/**
 * The member's own data (PRD section 10). Hard rules:
 *  - the member number ONLY comes from the signed-in token (`ctx`), never from the URL, query or body;
 *  - a loan is identified by loan type + case number AND must belong to that member (case numbers alone are not unique);
 *  - nothing is returned except what the mappers allow (member-view.mappers.ts);
 *  - the numbers come from the same services the desktop uses, so the phone and the counter agree.
 */
@Injectable()
export class MemberDataService {
  constructor(
    @InjectDataSource(MOBILE_DS) private readonly ds: DataSource,
    private readonly loanQuery: LoanQueryService,
    private readonly balances: MemberBalanceService,
    private readonly ledger: MemberLedgerService,
    private readonly appCode: AppCodeService,
    private readonly flags: FeatureFlagService,
  ) {}

  // ───────────── profile ─────────────

  async profile(ctx: MemberCtx) {
    await this.flags.assertOn('home');
    const rows: any[] = await this.ds.query(
      `SELECT m.mbno::text AS mbno,
              COALESCE(NULLIF(trim(m.full_name), ''), trim(concat_ws(' ', m.f_name, m.m_name, m.l_name))) AS name,
              d.designationname AS designation,
              dv.name AS office,
              m.dob, COALESCE(NULLIF(trim(m.present_address), ''), m.permanent_address) AS address,
              m.phoneno AS phone, m.email, m.pan_no AS pan,
              (COALESCE(trim(m.aadharno), '') <> '') AS has_aadhaar,
              COALESCE(m.date_of_retirement, m.supanuationdate) AS retirement,
              m.nominee_name, m.nominee_relation, m.nominee_address
         FROM member_master m
         LEFT JOIN designation_master d ON d.designationcode = m.desig
         LEFT JOIN division_master dv ON dv.officeno = m.officeno AND dv.wingno = m.wingno
        WHERE m.mbno = $1`,
      [ctx.mbno],
    );
    if (!rows.length) throw new NotFoundException('Member not found');
    const r = rows[0];
    return toProfile({
      mbno: r.mbno, name: r.name, designation: r.designation, office: r.office, dob: r.dob, address: r.address, phone: r.phone, email: r.email,
      pan: r.pan, hasAadhaar: r.has_aadhaar, retirementDate: r.retirement,
      nomineeName: r.nominee_name, nomineeRelation: r.nominee_relation, nomineeAddress: r.nominee_address,
    });
  }

  // ───────────── accounts ─────────────

  async accounts(ctx: MemberCtx) {
    await this.flags.assertOn('accounts');
    const quick = await this.balances.getQuickBalance(ctx.mbno);
    const savings: any[] = await this.ds.query(
      `SELECT acc_no, balance, opening_date, status FROM sbmaster WHERE mbno = $1 ORDER BY acc_no`,
      [ctx.mbno],
    );
    return toAccountsSummary({ shares: quick.shares, compulsory_deposit: quick.compulsoryDeposit }, savings);
  }

  // ───────────── loans ─────────────

  /** Open "check this" flags that staff raised on a member's loans. Only the fact is used, never the text. */
  private async flaggedCases(mbno: string): Promise<Set<string>> {
    const rows: Array<{ k: string }> = await this.ds.query(
      `SELECT DISTINCT concat(loantype, '-', loancaseno) AS k FROM loan_payment_flags WHERE mbno = $1 AND status = 'OPEN'`,
      [mbno],
    );
    return new Set(rows.map((r) => r.k));
  }

  private async loanList(mbno: string): Promise<Array<ReturnType<typeof toLoan>>> {
    const base: any[] = await this.loanQuery.getMemberLoansFromMaster(mbno);
    const extra: any[] = await this.ds.query(
      `SELECT DISTINCT ON (loancaseno, loantype) loancaseno::text AS loancaseno, loantype, rate, payment_date, purpose
         FROM loan_master WHERE mbno = $1 ORDER BY loancaseno, loantype`,
      [mbno],
    );
    // The desktop service swallows database errors and returns an empty list. For a member "no loans" would be a false
    // statement, so an empty list is only believed when the loan table agrees.
    if (base.length === 0 && extra.length > 0) {
      throw new ServiceUnavailableException({ statusCode: 503, code: 'DATA_UNAVAILABLE', message: 'Your loans cannot be shown right now. Please try again later.' });
    }
    const flagged = await this.flaggedCases(mbno);
    const byKey = new Map(extra.map((e) => [`${e.loantype}-${e.loancaseno}`, e]));
    return base.map((b) => {
      const key = `${b.loantype}-${b.loancaseno}`;
      const e = byKey.get(key);
      const src: LoanSource = { ...b, rate: e?.rate, payment_date: e?.payment_date, purpose: e?.purpose, needsOfficeVisit: flagged.has(key) };
      return toLoan(src);
    });
  }

  async loans(ctx: MemberCtx) {
    await this.flags.assertOn('loans');
    const all = await this.loanList(ctx.mbno);
    const rank = { ACTIVE: 0, CLOSED: 1, MERGED: 2 } as const;
    return { loans: [...all].sort((a, b) => rank[a.status] - rank[b.status] || Number(b.caseNo) - Number(a.caseNo)) };
  }

  /** The loan must exist for THIS member with THIS type: a case number that belongs to somebody else looks like "not found". */
  private async ownLoan(ctx: MemberCtx, loanType: string, caseNo: string) {
    if (!LOAN_TYPE.test(loanType) || !CASE_NO.test(caseNo)) throw new BadRequestException('Invalid loan reference');
    const found = (await this.loanList(ctx.mbno)).find((l) => l.loanType === loanType.toUpperCase() && l.caseNo === caseNo);
    if (!found) throw new NotFoundException({ statusCode: 404, code: 'LOAN_NOT_FOUND', message: 'Loan not found' });
    return found;
  }

  async loan(ctx: MemberCtx, loanType: string, caseNo: string) {
    await this.flags.assertOn('loans');
    const loan = await this.ownLoan(ctx, loanType, caseNo);
    return { loan };
  }

  async schedule(ctx: MemberCtx, loanType: string, caseNo: string) {
    await this.flags.assertOn('loans');
    const loan = await this.ownLoan(ctx, loanType, caseNo);
    const s = await this.loanQuery.getEmiScheduleFromMaster(caseNo, { mbno: ctx.mbno, loantype: loan.loanType });
    const rows = (s.schedule as any[]).map(toScheduleRow);
    return {
      loan: { caseNo: loan.caseNo, loanType: loan.loanType },
      installments: rows,
      summary: {
        paid: rows.filter((r) => r.status === 'PAID').length,
        overdue: rows.filter((r) => r.status === 'OVERDUE').length,
        upcoming: rows.filter((r) => r.status === 'UPCOMING').length,
        total: rows.length,
      },
    };
  }

  async payments(ctx: MemberCtx, loanType: string, caseNo: string, cursor?: string, limit = 50) {
    await this.flags.assertOn('loans');
    const loan = await this.ownLoan(ctx, loanType, caseNo);
    // Real receipts only: payroll-lag credits are internal bookkeeping entries (see Loan Position), not payments by the member.
    const rows: any[] = await this.ds.query(
      `SELECT id, payment_date, payment_amount, principal_amount, interest_amount, penal_amount, payment_source, receipt_no
         FROM loan_repayment_ledger
        WHERE mbno = $1 AND loancaseno::text = $2 AND loantype = $3 AND is_payroll_lag_credit = false
        ORDER BY payment_date DESC, id DESC`,
      [ctx.mbno, caseNo, loan.loanType],
    );
    const p = page(rows, cursor, limit);
    return { payments: p.items.map(toRepayment), nextCursor: p.nextCursor };
  }

  // ───────────── ledger / passbook ─────────────

  async ledgerPage(ctx: MemberCtx, q: { from: string; to: string; cursor?: string; limit?: number }, approval?: string) {
    await this.flags.assertOn('ledger');
    if (!DATE.test(q.from) || !DATE.test(q.to)) throw new BadRequestException('from and to must be YYYY-MM-DD');
    const from = new Date(q.from + 'T00:00:00');
    const to = new Date(q.to + 'T00:00:00');
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from > to) throw new BadRequestException('Invalid date range');

    // More than 12 months back is a larger privacy-heavy export: it needs the App Code approval (approved action LARGE_STATEMENT).
    const limitDate = new Date();
    limitDate.setMonth(limitDate.getMonth() - LEDGER_FREE_MONTHS);
    if (from < limitDate) await this.appCode.requireApproval(ctx, 'LARGE_STATEMENT', approval);

    const report = await this.ledger.getMemberDetailLedgerReport({ memberNumber: ctx.mbno, fromDate: q.from, toDate: q.to });
    const newestFirst = [...report.entries].reverse();
    const p = page(newestFirst, q.cursor, q.limit ?? 50);
    return {
      from: q.from,
      to: q.to,
      totals: { debit: money(report.totalDebits), credit: money(report.totalCredits) },
      entries: p.items.map(toLedgerEntry),
      nextCursor: p.nextCursor,
    };
  }

  // ───────────── notices ─────────────

  async notices(ctx: MemberCtx) {
    await this.flags.assertOn('notices');
    const rows: any[] = await this.ds.query(
      `SELECT n.id, n.title, n.message, n.type, n.created_at
         FROM dashboard_notices n
         JOIN member_master m ON m.mbno = $1
        WHERE n.show_on_mobile = true
          AND (n.audience_wing IS NULL OR n.audience_wing = m.wingno)
          AND (n.audience_office IS NULL OR n.audience_office = m.officeno)
        ORDER BY n.sort_order ASC, n.created_at DESC LIMIT 50`,
      [ctx.mbno],
    );
    return { notices: rows.map(toNotice) };
  }

  // ───────────── home ─────────────

  async home(ctx: MemberCtx) {
    await this.flags.assertOn('home');
    const [profileRow, accounts, loanList, noticeCount] = await Promise.all([
      this.ds.query(
        `SELECT COALESCE(NULLIF(trim(full_name), ''), trim(concat_ws(' ', f_name, m_name, l_name))) AS name FROM member_master WHERE mbno = $1`,
        [ctx.mbno],
      ),
      this.flags.isOn('accounts').then((on) => (on ? this.accounts(ctx) : null)),
      this.flags.isOn('loans').then((on) => (on ? this.loanList(ctx.mbno) : [])),
      this.flags.isOn('notices').then((on) => (on ? this.notices(ctx).then((n) => n.notices.length) : 0)),
    ]);

    const active = loanList.filter((l) => l.status === 'ACTIVE');
    const outstanding = active.reduce((sum, l) => sum + parseFloat(l.outstanding), 0);

    // Next instalment across the (up to 3 largest) active loans: the earliest instalment that is not paid yet.
    let nextEmi: { caseNo: string; loanType: string; dueDate: string | null; emi: string; status: string } | null = null;
    for (const l of active.slice(0, 3)) {
      try {
        const s = await this.loanQuery.getEmiScheduleFromMaster(l.caseNo, { mbno: ctx.mbno, loantype: l.loanType });
        const nxt = (s.schedule as any[]).map(toScheduleRow).find((r) => r.status !== 'PAID');
        if (nxt && (!nextEmi || (nxt.dueDate && (!nextEmi.dueDate || nxt.dueDate < nextEmi.dueDate)))) {
          nextEmi = { caseNo: l.caseNo, loanType: l.loanType, dueDate: nxt.dueDate, emi: nxt.emi, status: nxt.status };
        }
      } catch {
        /* one loan without a schedule must not break the home screen */
      }
    }

    return {
      asOf: new Date().toISOString(),
      member: { memberNo: ctx.mbno, name: profileRow[0]?.name ?? '' },
      balances: accounts
        ? { shares: accounts.shares, compulsoryDeposit: accounts.compulsoryDeposit, savings: accounts.savings.total, loansOutstanding: money(outstanding) }
        : null,
      activeLoans: active.length,
      nextEmi,
      needsOfficeVisit: loanList.some((l) => l.needsOfficeVisit),
      noticeCount,
    };
  }
}
