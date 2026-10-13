import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';

/**
 * The one place that says whether a member is active (ES-100).
 *
 * A member is ACTIVE when member_master.isactive = 'Y'. Becoming inactive is a manual step: the system only
 * FLAGS a member as ready — retirement date (member_master.date_of_retirement) has passed AND the RD balance
 * (member_balances.compulsory_deposit, "RD" and "CD" are the same account) is zero — and a user then marks the
 * member inactive here. Inactive means inactive everywhere: every module filters on isactive = 'Y'.
 */
export const ACTIVE_MEMBER_SQL = (alias = 'm') => `${alias}.isactive = 'Y'`;

/**
 * The legacy system stored "no retirement date" as 01-01-1900 (1,539 members). No real retirement date can be
 * before 1950, so anything earlier counts as NOT RECORDED: such a member is not retired, is never flagged as ready
 * to mark inactive, and is charged group insurance like any other active member. Use this wherever a retirement
 * date is read for a decision.
 */
export const RETIREMENT_DATE_FLOOR = '1950-01-01';
export const RETIREMENT_DATE_RECORDED_SQL = (col = 'm.date_of_retirement') =>
  `(${col} IS NOT NULL AND ${col}::date >= '${RETIREMENT_DATE_FLOOR}')`;

export type StatusCategory = 'ready' | 'retired-rd' | 'upcoming';

export interface StatusRow {
  memberNo: string;
  name: string;
  officeName: string | null;
  retirementDate: string | null;
  rdBalance: number;
  loanBalance: number;
  /** YYYY-MM the member is expected to become inactive, when it can already be told. */
  expectedInactiveMonth: string | null;
  note: string;
}

const DAY_MS = 86_400_000;

@Injectable()
export class MemberStatusService {
  constructor(private readonly dataSource: DataSource) {}

  // member_balances.mbno is a float, member_master.mbno a numeric: always compare them as numerics.
  private static readonly BASE_FROM = `
      FROM member_master m
      LEFT JOIN member_balances b ON b.mbno::numeric = m.mbno::numeric
      LEFT JOIN division_master d ON m.officeno = d.officeno AND m.wingno = d.wingno
     WHERE ${ACTIVE_MEMBER_SQL('m')}
       AND ${RETIREMENT_DATE_RECORDED_SQL('m.date_of_retirement')}`;

  private static readonly RD = `COALESCE(b.compulsory_deposit, 0)`;

  private where(category: StatusCategory, months: number): string {
    switch (category) {
      case 'ready':
        return `AND m.date_of_retirement::date <= current_date AND ${MemberStatusService.RD} <= 0`;
      case 'retired-rd':
        return `AND m.date_of_retirement::date <= current_date AND ${MemberStatusService.RD} > 0`;
      case 'upcoming':
        return `AND m.date_of_retirement::date > current_date
                AND m.date_of_retirement::date <= (current_date + (${Number(months)} * interval '1 month'))::date`;
    }
  }

  async summary(months = 12) {
    const m = Math.min(60, Math.max(1, Math.floor(Number(months) || 12)));
    const rows = await this.dataSource.query(`
      SELECT
        count(*) FILTER (WHERE m.date_of_retirement::date <= current_date AND ${MemberStatusService.RD} <= 0)::int AS ready,
        count(*) FILTER (WHERE m.date_of_retirement::date <= current_date AND ${MemberStatusService.RD} > 0)::int  AS retired_rd,
        count(*) FILTER (WHERE m.date_of_retirement::date > current_date
                          AND m.date_of_retirement::date <= (current_date + ($1::int * interval '1 month'))::date)::int AS upcoming
      ${MemberStatusService.BASE_FROM}`, [m]);
    const r = rows[0] || {};
    return { ready: r.ready || 0, retiredWithRd: r.retired_rd || 0, upcoming: r.upcoming || 0, upcomingMonths: m };
  }

  async list(opts: { category: StatusCategory; months?: number; search?: string; limit?: number; offset?: number }) {
    const category = opts.category;
    if (!['ready', 'retired-rd', 'upcoming'].includes(category)) {
      throw new BadRequestException('category must be ready, retired-rd or upcoming');
    }
    const months = Math.min(60, Math.max(1, Math.floor(Number(opts.months) || 12)));
    const limit = Math.min(500, Math.max(1, Math.floor(Number(opts.limit) || 100)));
    const offset = Math.max(0, Math.floor(Number(opts.offset) || 0));
    const search = (opts.search || '').trim();

    const params: any[] = [];
    let searchSql = '';
    if (search) {
      params.push(`%${search}%`);
      searchSql = `AND (m.mbno::text ILIKE $1 OR COALESCE(NULLIF(m.full_name,''), concat_ws(' ', m.f_name, m.m_name, m.l_name)) ILIKE $1)`;
    }
    const where = `${this.where(category, months)} ${searchSql}`;

    const [{ total }] = await this.dataSource.query(
      `SELECT count(*)::int AS total ${MemberStatusService.BASE_FROM} ${where}`, params);

    const rows = await this.dataSource.query(`
      SELECT m.mbno::text AS member_no,
             COALESCE(NULLIF(m.full_name,''), NULLIF(trim(concat_ws(' ', m.f_name, m.m_name, m.l_name)), '')) AS name,
             d.name AS office_name,
             to_char(m.date_of_retirement, 'YYYY-MM-DD') AS retirement_date,
             ${MemberStatusService.RD}::float AS rd_balance,
             (COALESCE(b.regularloan,0) + COALESCE(b.emergency_loan_balance,0))::float AS loan_balance
      ${MemberStatusService.BASE_FROM} ${where}
      ORDER BY m.date_of_retirement, m.mbno
      LIMIT ${limit} OFFSET ${offset}`, params);

    const today = new Date();
    const out: StatusRow[] = rows.map((r: any) => {
      let expected: string | null = null;
      let note = '';
      if (category === 'ready') {
        note = 'Retired and RD is zero — can be marked inactive';
      } else if (category === 'retired-rd') {
        note = `Retired, RD still ₹${Number(r.rd_balance).toLocaleString('en-IN')} — becomes inactive when RD reaches zero`;
      } else if (Number(r.rd_balance) <= 0) {
        expected = String(r.retirement_date).slice(0, 7);
        note = 'RD is zero — ready in the month of retirement';
      } else {
        const days = Math.ceil((new Date(r.retirement_date).getTime() - today.getTime()) / DAY_MS);
        note = `Retires in ${days} day${days === 1 ? '' : 's'}; RD ₹${Number(r.rd_balance).toLocaleString('en-IN')} must reach zero first`;
      }
      return {
        memberNo: r.member_no, name: r.name || '', officeName: r.office_name,
        retirementDate: r.retirement_date, rdBalance: Number(r.rd_balance), loanBalance: Number(r.loan_balance),
        expectedInactiveMonth: expected, note,
      };
    });
    return { rows: out, total, limit, offset };
  }

  /** Current status of one member plus everything that should make a person think before marking inactive. */
  async check(memberNo: string) {
    const rows = await this.dataSource.query(`
      SELECT m.mbno::text AS member_no, m.isactive,
             COALESCE(NULLIF(m.full_name,''), NULLIF(trim(concat_ws(' ', m.f_name, m.m_name, m.l_name)), '')) AS name,
             CASE WHEN ${RETIREMENT_DATE_RECORDED_SQL('m.date_of_retirement')} THEN to_char(m.date_of_retirement, 'YYYY-MM-DD') END AS retirement_date,
             (${RETIREMENT_DATE_RECORDED_SQL('m.date_of_retirement')} AND m.date_of_retirement::date <= current_date) AS retired,
             COALESCE(b.compulsory_deposit, 0)::float AS rd_balance,
             (COALESCE(b.regularloan,0) + COALESCE(b.emergency_loan_balance,0))::float AS loan_balance
        FROM member_master m
        LEFT JOIN member_balances b ON b.mbno::numeric = m.mbno::numeric
       WHERE m.mbno::text = $1`, [String(memberNo)]);
    if (!rows.length) throw new NotFoundException(`Member ${memberNo} not found`);
    const r = rows[0];
    const warnings: string[] = [];
    if (!r.retired) warnings.push(r.retirement_date
      ? `Retirement date ${r.retirement_date} has not been reached yet`
      : 'No retirement date is recorded for this member');
    if (Number(r.rd_balance) > 0) warnings.push(`RD balance is ₹${Number(r.rd_balance).toLocaleString('en-IN')}, not zero`);
    if (Number(r.loan_balance) > 0) warnings.push(`Loan outstanding of ₹${Number(r.loan_balance).toLocaleString('en-IN')}`);
    return {
      memberNo: r.member_no, name: r.name || '', active: r.isactive === 'Y',
      retirementDate: r.retirement_date, retired: !!r.retired,
      rdBalance: Number(r.rd_balance), loanBalance: Number(r.loan_balance),
      readyToInactivate: !!r.retired && Number(r.rd_balance) <= 0,
      warnings,
    };
  }

  async markInactive(memberNo: string, reason: string, force: boolean, by: string) {
    const info = await this.check(memberNo);
    if (!info.active) throw new BadRequestException(`Member ${memberNo} is already inactive`);
    if (!reason || reason.trim().length < 3) throw new BadRequestException('A reason is required');
    if (info.warnings.length && !force) {
      throw new ConflictException({ message: 'Member does not meet the inactive conditions', warnings: info.warnings });
    }
    await this.dataSource.transaction(async (em) => {
      const res = await em.query(`UPDATE member_master SET isactive = 'N' WHERE mbno::text = $1 AND isactive = 'Y' RETURNING mbno`, [String(memberNo)]);
      if (!res.length) throw new BadRequestException(`Member ${memberNo} is already inactive`);
      await em.query(
        `INSERT INTO member_status_log (mbno, action, reason, retirement_date, rd_balance, loan_balance, forced, done_by)
         VALUES ($1, 'MARK_INACTIVE', $2, $3, $4, $5, $6, $7)`,
        [memberNo, reason.trim(), info.retirementDate, info.rdBalance, info.loanBalance, info.warnings.length > 0, by]);
    });
    return { memberNo, active: false };
  }

  async reactivate(memberNo: string, reason: string, by: string) {
    const info = await this.check(memberNo);
    if (info.active) throw new BadRequestException(`Member ${memberNo} is already active`);
    if (!reason || reason.trim().length < 3) throw new BadRequestException('A reason is required');
    await this.dataSource.transaction(async (em) => {
      await em.query(`UPDATE member_master SET isactive = 'Y' WHERE mbno::text = $1`, [String(memberNo)]);
      await em.query(
        `INSERT INTO member_status_log (mbno, action, reason, retirement_date, rd_balance, loan_balance, forced, done_by)
         VALUES ($1, 'REACTIVATE', $2, $3, $4, $5, false, $6)`,
        [memberNo, reason.trim(), info.retirementDate, info.rdBalance, info.loanBalance, by]);
    });
    return { memberNo, active: true };
  }

  async history(memberNo: string) {
    return this.dataSource.query(
      `SELECT id, action, reason, to_char(retirement_date,'YYYY-MM-DD') AS retirement_date,
              rd_balance::float AS rd_balance, loan_balance::float AS loan_balance, forced, done_by, done_at
         FROM member_status_log WHERE mbno::text = $1 ORDER BY done_at DESC, id DESC`, [String(memberNo)]);
  }
}
