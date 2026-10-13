import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { generateVoucherNo } from '../shared/utils/voucher-utils';

/**
 * Yearly Group Insurance (ES-98).
 *
 *  - A lump sum is decided for the financial year and divided by the number of ACTIVE members (member_master.isactive = 'Y').
 *  - A member who joined during the year pays only for the months left, the joining month counted:
 *      joins in July -> July..March = 9 months -> 9/12 of the yearly share.
 *  - The amount each member owes is rounded UP, after the pro-rata.
 *  - It is deducted from the member's RD (member_balances.compulsory_deposit; RD and CD are the same account) at year end.
 *    RD is allowed to go negative here: the shortfall is recovered when the member next takes a loan and from the first
 *    deposits of the new financial year (both simply add to the same balance).
 *  - Ledger: one Journal voucher, DR L1004 (RD, acc type CD) / CR L1003 (Member Group Accidental Insurance) per member —
 *    the same shape the manual yearly voucher had.
 *  - One POSTED run per financial year (unique index) so nobody can be charged twice.
 */
export const RD_HEAD = 'L1004';
export const INSURANCE_HEAD = 'L1003';

export interface RunOptions {
  yearcode: number;
  lumpSum: number;
  postingDate?: string; // YYYY-MM-DD, defaults to the financial year end
}

type RowFilter = 'all' | 'negative' | 'partial';

@Injectable()
export class GroupInsuranceService {
  private readonly logger = new Logger(GroupInsuranceService.name);

  constructor(private readonly dataSource: DataSource) {}

  // ── financial years ──────────────────────────────────────────────────────────
  // yearend stores naive timestamps that sit a few hours either side of midnight depending on who created the row,
  // so +12h before ::date puts every stored boundary on the intended calendar day.
  private async loadYear(yearcode: number, runner: { query: (s: string, p?: any[]) => Promise<any> } = this.dataSource) {
    const rows = await runner.query(
      `SELECT yearcode, to_char((start_date + interval '12 hours')::date, 'YYYY-MM-DD') AS fy_start,
              to_char((end_date + interval '12 hours')::date, 'YYYY-MM-DD') AS fy_end
         FROM yearend WHERE yearcode = $1`, [yearcode]);
    if (!rows.length) throw new NotFoundException(`Financial year ${yearcode} not found`);
    const r = rows[0];
    const y1 = Number(r.fy_start.slice(0, 4));
    return { yearcode: Number(r.yearcode), fyStart: r.fy_start as string, fyEnd: r.fy_end as string, label: `${y1}-${String((y1 + 1) % 100).padStart(2, '0')}` };
  }

  async context() {
    const years = await this.dataSource.query(
      `SELECT yearcode, to_char((start_date + interval '12 hours')::date, 'YYYY-MM-DD') AS fy_start,
              to_char((end_date + interval '12 hours')::date, 'YYYY-MM-DD') AS fy_end, closed_at
         FROM yearend ORDER BY yearcode DESC`);
    const today = new Date().toISOString().slice(0, 10);
    const current = years.find((y: any) => y.fy_start <= today && today <= y.fy_end) || years[0] || null;
    const runs = await this.runs();
    return {
      today,
      currentYearcode: current ? Number(current.yearcode) : null,
      years: years.map((y: any) => ({
        yearcode: Number(y.yearcode), fyStart: y.fy_start, fyEnd: y.fy_end, closed: !!y.closed_at,
        label: `${y.fy_start.slice(0, 4)}-${String((Number(y.fy_start.slice(0, 4)) + 1) % 100).padStart(2, '0')}`,
        run: runs.find((r: any) => r.yearcode === Number(y.yearcode)) || null,
      })),
    };
  }

  async runs() {
    const rows = await this.dataSource.query(`
      SELECT id, yearcode, fy_label, to_char(fy_start,'YYYY-MM-DD') AS fy_start, to_char(fy_end,'YYYY-MM-DD') AS fy_end,
             lump_sum::float AS lump_sum, active_members, per_member_amount::float AS per_member_amount,
             to_char(posting_date,'YYYY-MM-DD') AS posting_date, voucher_no, charged_members, total_charged::float AS total_charged,
             status, created_by, created_at
        FROM group_insurance_run ORDER BY yearcode DESC, id DESC`);
    return rows.map((r: any) => ({
      id: r.id, yearcode: r.yearcode, fyLabel: r.fy_label, fyStart: r.fy_start, fyEnd: r.fy_end, lumpSum: r.lump_sum,
      activeMembers: r.active_members, perMemberAmount: r.per_member_amount,
      postingDate: r.posting_date, voucherNo: r.voucher_no, chargedMembers: r.charged_members,
      totalCharged: r.total_charged, status: r.status, createdBy: r.created_by, createdAt: r.created_at,
    }));
  }

  // ── the calculation (single source for preview and post) ────────────────────
  private validate(o: RunOptions) {
    if (!Number.isInteger(o.yearcode)) throw new BadRequestException('Choose a financial year');
    if (!(Number(o.lumpSum) > 0) || Number(o.lumpSum) > 1e9) throw new BadRequestException('Enter the lump sum insurance amount for the year');
  }

  /** CTE that yields one row per member who will be charged. Params: $1 fyStart, $2 fyEnd, $3 lumpSum, $4 postingDate. Retired members are never charged. */
  private static readonly CALC_CTE = `
    base AS (
      SELECT DISTINCT ON (m.mbno::numeric) m.mbno::numeric AS mbno,
             COALESCE(NULLIF(m.full_name,''), NULLIF(trim(concat_ws(' ', m.f_name, m.m_name, m.l_name)), ''), '') AS name,
             m.memb_date::date AS join_date,
             CASE WHEN m.date_of_retirement IS NOT NULL AND m.date_of_retirement::date >= '1950-01-01' THEN m.date_of_retirement::date END AS retire_date,  -- 01-01-1900 = not recorded
             COALESCE(b.cd, 0)::numeric AS rd,
             (b.cd IS NOT NULL) AS has_balance_row,
             CASE WHEN m.memb_date IS NULL OR m.memb_date::date < $1::date THEN 12
                  WHEN m.memb_date::date > $2::date THEN 0
                  ELSE 12 - ((extract(year FROM m.memb_date)::int * 12 + extract(month FROM m.memb_date)::int)
                           - (extract(year FROM $1::date)::int * 12 + extract(month FROM $1::date)::int)) END AS months
        FROM member_master m
        LEFT JOIN (SELECT mbno::numeric AS mbno, sum(compulsory_deposit) AS cd FROM member_balances GROUP BY 1) b ON b.mbno = m.mbno::numeric
       WHERE m.isactive = 'Y'
       ORDER BY m.mbno::numeric, m.memb_date NULLS FIRST   -- a member number that appears twice is charged once
    ),
    eligible AS (
      SELECT * FROM base
       WHERE months > 0 AND (retire_date IS NULL OR retire_date > $4::date)
    ),
    stats AS (SELECT count(*)::int AS n FROM eligible),
    calc AS (
      SELECT e.mbno, e.name, e.join_date, e.retire_date, e.rd, e.has_balance_row, e.months, s.n,
             ($3::numeric / s.n) AS per_member,
             ceil(round(($3::numeric / s.n) * e.months / 12, 2)) AS charge
        FROM eligible e CROSS JOIN stats s
    )`;

  private params(o: RunOptions, fyStart: string, fyEnd: string, postingDate: string) {
    return [fyStart, fyEnd, Number(o.lumpSum), postingDate];
  }

  private resolvePostingDate(o: RunOptions, fyStart: string, fyEnd: string) {
    const d = o.postingDate || fyEnd;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) throw new BadRequestException('Posting date must be YYYY-MM-DD');
    if (d < fyStart || d > fyEnd) throw new BadRequestException(`Posting date must fall inside the financial year (${fyStart} to ${fyEnd})`);
    return d;
  }

  async preview(o: RunOptions & { filter?: RowFilter; search?: string; limit?: number; offset?: number }) {
    this.validate(o);
    const fy = await this.loadYear(o.yearcode);
    const postingDate = this.resolvePostingDate(o, fy.fyStart, fy.fyEnd);
    const p = this.params(o, fy.fyStart, fy.fyEnd, postingDate);

    const [sum] = await this.dataSource.query(`
      WITH ${GroupInsuranceService.CALC_CTE}
      SELECT count(*)::int AS members, COALESCE(max(n),0)::int AS n,
             COALESCE(max(per_member),0)::float AS per_member,
             COALESCE(sum(charge),0)::float AS total,
             count(*) FILTER (WHERE months < 12)::int AS partial_year,
             count(*) FILTER (WHERE rd - charge < 0)::int AS goes_negative,
             count(*) FILTER (WHERE rd < 0)::int AS already_negative,
             COALESCE(sum(GREATEST(0, charge - GREATEST(0, rd))),0)::float AS uncovered_total,
             count(*) FILTER (WHERE NOT has_balance_row)::int AS no_balance_row
        FROM calc`, p);

    const [excl] = await this.dataSource.query(`
      WITH ${GroupInsuranceService.CALC_CTE}
      SELECT (SELECT count(*) FROM member_master WHERE isactive = 'Y')::int AS active_total,
             (SELECT count(*) - count(DISTINCT mbno) FROM member_master WHERE isactive = 'Y')::int AS duplicate_numbers,
             (SELECT count(*) FROM base WHERE months = 0)::int AS joins_after_year_end,
             (SELECT count(*) FROM base WHERE months > 0 AND NOT (retire_date IS NULL OR retire_date > $4::date))::int AS retired_excluded
      `, p);

    const limit = Math.min(500, Math.max(1, Math.floor(Number(o.limit) || 100)));
    const offset = Math.max(0, Math.floor(Number(o.offset) || 0));
    const where: string[] = [];
    const rp = [...p];
    if (o.filter === 'negative') where.push('rd - charge < 0');
    if (o.filter === 'partial') where.push('months < 12');
    if ((o.search || '').trim()) { rp.push(`%${o.search!.trim()}%`); where.push(`(mbno::text ILIKE $${rp.length} OR name ILIKE $${rp.length})`); }
    const w = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const [{ total: rowTotal }] = await this.dataSource.query(`
      WITH ${GroupInsuranceService.CALC_CTE} SELECT count(*)::int AS total FROM calc ${w}`, rp);
    const rows = await this.dataSource.query(`
      WITH ${GroupInsuranceService.CALC_CTE}
      SELECT mbno::text AS member_no, name, to_char(join_date,'YYYY-MM-DD') AS join_date, months,
             round(per_member * months / 12, 2)::float AS calc_amount, charge::float AS charge,
             rd::float AS rd_before, (rd - charge)::float AS rd_after,
             GREATEST(0, charge - GREATEST(0, rd))::float AS uncovered,
             (retire_date IS NOT NULL AND retire_date <= $4::date) AS retired
        FROM calc ${w} ORDER BY mbno LIMIT ${limit} OFFSET ${offset}`, rp);

    const existing = (await this.runs()).find((r: any) => r.yearcode === o.yearcode && r.status === 'POSTED') || null;
    return {
      yearcode: fy.yearcode, fyLabel: fy.label, fyStart: fy.fyStart, fyEnd: fy.fyEnd, postingDate,
      lumpSum: Number(o.lumpSum),
      summary: {
        activeMembers: excl.active_total, membersCharged: sum.members, divisor: sum.n,
        perMemberYearly: Number(sum.per_member), totalToCollect: sum.total, difference: Number(o.lumpSum) - sum.total,
        partialYear: sum.partial_year, goesNegative: sum.goes_negative, alreadyNegative: sum.already_negative,
        uncoveredTotal: sum.uncovered_total, retiredExcluded: excl.retired_excluded,
        joinsAfterYearEnd: excl.joins_after_year_end, noBalanceRow: sum.no_balance_row, duplicateNumbers: excl.duplicate_numbers,
      },
      alreadyPosted: existing,
      rows: rows.map((r: any) => ({
        memberNo: r.member_no, name: r.name, joinDate: r.join_date, months: r.months, calcAmount: r.calc_amount,
        charge: r.charge, rdBefore: r.rd_before, rdAfter: r.rd_after, uncovered: r.uncovered, retired: r.retired,
      })),
      rowTotal, limit, offset,
    };
  }

  // ── posting ──────────────────────────────────────────────────────────────────
  async post(o: RunOptions, username: string) {
    this.validate(o);
    const qr = this.dataSource.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();
    try {
      // serialise: one run per year, and the ledger id/trans_no allocation below
      await qr.query(`SELECT pg_advisory_xact_lock(hashtext('group_insurance'))`);
      await qr.query(`SELECT pg_advisory_xact_lock(hashtext('ledger'))`);

      const fy = await this.loadYear(o.yearcode, qr);
      const postingDate = this.resolvePostingDate(o, fy.fyStart, fy.fyEnd);
      const done = await qr.query(`SELECT id FROM group_insurance_run WHERE yearcode = $1 AND status = 'POSTED'`, [o.yearcode]);
      if (done.length) throw new ConflictException(`Group insurance for ${fy.label} has already been posted`);

      const p = this.params(o, fy.fyStart, fy.fyEnd, postingDate);
      // Everything is recomputed here from the lump sum — nothing the client previewed is trusted.
      await qr.query(`CREATE TEMP TABLE _gi_calc ON COMMIT DROP AS
        WITH ${GroupInsuranceService.CALC_CTE}
        SELECT row_number() OVER (ORDER BY mbno) AS rn, mbno, months, n, per_member, rd,
               round(per_member * months / 12, 2) AS calc_amount, charge
          FROM calc WHERE charge > 0`, p);
      const [agg] = await qr.query(`SELECT count(*)::int AS members, COALESCE(sum(charge),0)::numeric AS total, COALESCE(max(n),0)::int AS n,
                                           COALESCE(max(per_member),0)::numeric AS per_member FROM _gi_calc`);
      if (!agg.members) throw new BadRequestException('There is nobody to charge with these settings');

      const voucherNo = await generateVoucherNo(qr, 'J');
      const [run] = await qr.query(`
        INSERT INTO group_insurance_run (yearcode, fy_label, fy_start, fy_end, lump_sum, active_members, per_member_amount,
                                         include_retired, posting_date, voucher_no, charged_members, total_charged, created_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7,false,$8,$9,$10,$11,$12) RETURNING id`,
        [fy.yearcode, fy.label, fy.fyStart, fy.fyEnd, o.lumpSum, agg.n, agg.per_member,
         postingDate, voucherNo, agg.members, agg.total, username]);

      await qr.query(`
        INSERT INTO group_insurance_charge (run_id, mbno, months, calc_amount, charge, rd_before, rd_after, uncovered)
        SELECT $1, mbno, months, per_member * months / 12, charge, rd, rd - charge, GREATEST(0, charge - GREATEST(0, rd))
          FROM _gi_calc`, [run.id]);

      // ledger: DR RD / CR insurance head, per member, one voucher
      const [{ max_trans }] = await qr.query(`SELECT COALESCE(MAX(trans_no), 0)::bigint AS max_trans FROM ledger`);
      const [{ max_id }] = await qr.query(`SELECT COALESCE(MAX(ledgerid), 0)::bigint AS max_id FROM ledger`);
      const dt = `${postingDate} 00:00:00`;
      await qr.query(`
        INSERT INTO ledger (trans_no, trans_date, trans_type, code, mbno, acc_no, acc_type, trans_amt, receipt_vchr_no,
                            vchr_type, modeofpay, pl_balance, narration, username, ledgerid)
        SELECT $1::bigint + (rn * 2 - 1), $2::timestamp, 'DR', '${RD_HEAD}', mbno, 0, 'CD', charge, $3, 'J', 'J', rd - charge,
               'TRF To MEMBER GROUP ACCIDENTAL INSURANCE ' || $5, $4, $6::bigint + (rn * 2 - 1)
          FROM _gi_calc`, [max_trans, dt, voucherNo, username, fy.label, max_id]);
      await qr.query(`
        INSERT INTO ledger (trans_no, trans_date, trans_type, code, mbno, acc_no, acc_type, trans_amt, receipt_vchr_no,
                            vchr_type, modeofpay, pl_balance, narration, username, ledgerid)
        SELECT $1::bigint + (rn * 2), $2::timestamp, 'CR', '${INSURANCE_HEAD}', mbno, 0, 'OTH', charge, $3, 'J', 'J', 0,
               'TRF From COMPULSORY DEPOSIT ' || $5, $4, $6::bigint + (rn * 2)
          FROM _gi_calc`, [max_trans, dt, voucherNo, username, fy.label, max_id]);

      // the real RD balance. It may go negative on purpose (recovered later), so no floor here.
      await qr.query(`
        UPDATE member_balances mb SET compulsory_deposit = COALESCE(mb.compulsory_deposit, 0) - c.charge
          FROM _gi_calc c WHERE mb.mbno::numeric = c.mbno`);
      await qr.query(`
        INSERT INTO member_balances (mbno, compulsory_deposit)
        SELECT c.mbno, -c.charge FROM _gi_calc c
         WHERE NOT EXISTS (SELECT 1 FROM member_balances mb WHERE mb.mbno::numeric = c.mbno)`);

      // cashbook transfer lines for the two heads (same shape Member Balance Transfer writes)
      await qr.query(`INSERT INTO tblcashbook (headcode, headname, rcash, rtransfer, pcash, ptransfer, trans_date)
                      VALUES ($1, 'Group insurance - RD debited', 0, 0, 0, $2, $3::timestamp),
                             ($4, 'Group insurance - premium credited', 0, $2, 0, 0, $3::timestamp)`,
        [RD_HEAD, agg.total, dt, INSURANCE_HEAD]);

      await qr.commitTransaction();
      this.logger.log(`Group insurance ${fy.label} posted: ${agg.members} members, total ${agg.total}, voucher ${voucherNo}`);
      return { runId: run.id, voucherNo, fyLabel: fy.label, membersCharged: agg.members, totalCharged: Number(agg.total) };
    } catch (e) {
      await qr.rollbackTransaction();
      this.logger.error('Group insurance post failed', e as any);
      throw e;
    } finally {
      await qr.release();
    }
  }

  async runDetail(runId: number, opts: { search?: string; limit?: number; offset?: number } = {}) {
    const [run] = (await this.runs()).filter((r: any) => r.id === runId);
    if (!run) throw new NotFoundException('Run not found');
    const limit = Math.min(500, Math.max(1, Math.floor(Number(opts.limit) || 100)));
    const offset = Math.max(0, Math.floor(Number(opts.offset) || 0));
    const params: any[] = [runId];
    let w = '';
    if ((opts.search || '').trim()) { params.push(`%${opts.search!.trim()}%`); w = `AND (c.mbno::text ILIKE $2 OR m.full_name ILIKE $2 OR m.f_name ILIKE $2 OR m.l_name ILIKE $2)`; }
    const [{ total }] = await this.dataSource.query(
      `SELECT count(*)::int AS total FROM group_insurance_charge c LEFT JOIN (SELECT DISTINCT ON (mbno::numeric) mbno::numeric AS mbno, full_name, f_name, m_name, l_name FROM member_master ORDER BY mbno::numeric) m ON m.mbno = c.mbno WHERE c.run_id = $1 ${w}`, params);
    const rows = await this.dataSource.query(`
      SELECT c.mbno::text AS member_no,
             COALESCE(NULLIF(m.full_name,''), NULLIF(trim(concat_ws(' ', m.f_name, m.m_name, m.l_name)), ''), '') AS name,
             c.months, c.calc_amount::float AS calc_amount, c.charge::float AS charge, c.rd_before::float AS rd_before,
             c.rd_after::float AS rd_after, c.uncovered::float AS uncovered
        FROM group_insurance_charge c LEFT JOIN (SELECT DISTINCT ON (mbno::numeric) mbno::numeric AS mbno, full_name, f_name, m_name, l_name FROM member_master ORDER BY mbno::numeric) m ON m.mbno = c.mbno
       WHERE c.run_id = $1 ${w} ORDER BY c.mbno LIMIT ${limit} OFFSET ${offset}`, params);
    return {
      run, total, limit, offset,
      rows: rows.map((r: any) => ({
        memberNo: r.member_no, name: r.name, months: r.months, calcAmount: r.calc_amount, charge: r.charge,
        rdBefore: r.rd_before, rdAfter: r.rd_after, uncovered: r.uncovered,
      })),
    };
  }
}
