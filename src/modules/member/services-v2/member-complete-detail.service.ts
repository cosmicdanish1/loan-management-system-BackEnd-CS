import { BadRequestException, Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { DataSource } from 'typeorm';

/**
 * Member Complete Detail (ES-550) - read-only 360 degree view of one member.
 *
 * Every section runs its own query. If one table fails the section is returned empty and the
 * failure is listed in `warnings`, so the window still opens and the gap is visible (never silent).
 *
 * mbno is stored with different column types across tables (numeric, bigint, double precision,
 * varchar), so each query casts explicitly.
 */
@Injectable()
export class MemberCompleteDetailService implements OnModuleInit {
  private readonly logger = new Logger(MemberCompleteDetailService.name);

  constructor(private readonly dataSource: DataSource) { }

  /** Makes sure the menu row exists so Configure UserLevel Default Rights can list it (menu-action-map.ts id 245). */
  async onModuleInit(): Promise<void> {
    try {
      await this.dataSource.query(
        `INSERT INTO menumaster (menuid, menuname, menudesc, visibleflag)
         SELECT 245, 'MEMBER_COMPLETE_DETAIL', 'Member Complete Detail', 'Y'
          WHERE NOT EXISTS (SELECT 1 FROM menumaster WHERE menuid = 245)`,
      );
    } catch (e: any) {
      this.logger.warn(`menumaster seed for Member Complete Detail skipped: ${e?.message}`);
    }
  }

  async getCompleteDetail(memberNo: string, fromDate?: string, toDate?: string) {
    const mb = (memberNo || '').trim();
    if (!/^\d{1,12}$/.test(mb)) {
      throw new BadRequestException('memberNo must be a number');
    }
    const from = this.validDate(fromDate, 'fromDate');
    const to = this.validDate(toDate, 'toDate');

    const rows = await this.dataSource.query(
      `SELECT m.*, d.name AS office_name, w.wname AS wing_name
         FROM member_master m
         LEFT JOIN division_master d ON m.officeno = d.officeno AND m.wingno = d.wingno
         LEFT JOIN wingmast w ON m.wingno = w.wingno
        WHERE m.mbno = $1::numeric`,
      [mb],
    );
    if (rows.length === 0) throw new NotFoundException(`Member ${mb} not found`);
    const master = rows[0];

    const warnings: string[] = [];
    const q = async (label: string, sql: string, params: any[] = [mb]): Promise<any[]> => {
      try {
        return await this.dataSource.query(sql, params);
      } catch (e: any) {
        this.logger.warn(`Complete detail section "${label}" failed for ${mb}: ${e?.message}`);
        warnings.push(`${label}: ${e?.message || 'query failed'}`);
        return [];
      }
    };

    const [
      status, category, balances, funds, frs, frsBal, shareSnap, memberNominee,
      loans, loansPending, loanRepay, loanSurety, loanFlags, reagreements, lien,
      rd, rdConfig, rdLedger, rdFy, fd, fdNominee, joint, sb, dividend, insurance, demand,
      documents, mobile, ledger,
    ] = await Promise.all([
      q('Status history', `SELECT * FROM member_status_log WHERE mbno = $1::numeric ORDER BY done_at DESC`),
      q('Category', `SELECT * FROM membercategory WHERE mbno = $1::numeric`),
      q('Member balances', `SELECT * FROM member_balances WHERE mbno = $1::float8`),
      q('Funds master', `SELECT * FROM fundsmaster WHERE mbno = $1::numeric`),
      q('FRS', `SELECT * FROM frs WHERE mbno = $1::numeric ORDER BY sr_no`),
      q('FRS balance', `SELECT * FROM frs_balance WHERE mbno = $1::numeric`),
      q('Share snapshots', `SELECT * FROM share_monthly_balance WHERE mbno = $1::numeric ORDER BY snapshot_year DESC, snapshot_month DESC`),
      q('Nominee', `SELECT nominee_name, nominee_address, nominee_relation FROM member_master WHERE mbno = $1::numeric`),
      q('Loans', `SELECT * FROM loan_master WHERE mbno = $1::numeric ORDER BY payment_date DESC`),
      q('Pending loans', `SELECT * FROM loan_pending WHERE mbno = $1::numeric ORDER BY app_date DESC`),
      q('Loan repayments', `SELECT * FROM loan_repayment_ledger WHERE mbno = $1::numeric ORDER BY payment_date DESC, id DESC LIMIT 1000`),
      q('Loan surety', `SELECT * FROM suretymaster WHERE mbno = $1::numeric OR g1mbno = $1::numeric OR g2mbno = $1::numeric`),
      q('Loan payment flags', `SELECT * FROM loan_payment_flags WHERE mbno = $1::numeric ORDER BY created_at DESC`),
      q('Re-agreements', `SELECT id, reagreement_no, loantype, old_loancaseno, new_loancaseno, status, application_date, effective_date, old_rate, new_rate, outstanding_principal, new_monthly_installment FROM loan_reagreements WHERE mbno = $1::numeric ORDER BY id DESC`),
      q('RD lien', `SELECT * FROM rd_lien WHERE mbno = $1::numeric ORDER BY placed_at DESC`),
      q('RD accounts', `SELECT * FROM rdmaster WHERE mbno = $1::numeric ORDER BY deposit_date`),
      q('RD monthly config', `SELECT * FROM rd_member_config WHERE mbno = $1::numeric ORDER BY effective_from_date DESC`),
      q('RD instalments', `SELECT * FROM rd_installment_ledger WHERE mbno = $1::numeric ORDER BY installment_year DESC, installment_month DESC LIMIT 600`),
      q('RD year summary', `SELECT * FROM rd_financial_year_summary WHERE mbno = $1::numeric ORDER BY yearcode DESC`),
      q('FD accounts', `SELECT * FROM fdmaster WHERE mbno = $1::numeric ORDER BY depdate`),
      q('FD nominees', `SELECT * FROM fd_nominee WHERE mbno = $1::numeric ORDER BY account_number, srno`),
      q('Joint holders', `SELECT * FROM jointmaster WHERE mbno = $1::bigint`),
      q('Savings account', `SELECT * FROM sbmaster WHERE btrim(mbno) = $1::text`),
      q('Dividend', `SELECT * FROM dividend_master WHERE btrim(mbno) = $1::text ORDER BY year DESC`),
      q('Group insurance', `SELECT * FROM group_insurance_charge WHERE mbno = $1::numeric ORDER BY id DESC`),
      q('Demand', `SELECT * FROM demand_master WHERE mbno = $1::numeric ORDER BY demand_for_year DESC, demand_for_month DESC LIMIT 24`),
      q('Documents', `SELECT id, doc_type, file_name, uploaded_at FROM member_documents WHERE mbno = $1::numeric ORDER BY uploaded_at DESC`),
      q('Mobile app', `SELECT status, activated_at, blocked_reason, created_at, updated_at FROM mobile_account WHERE mbno = $1::numeric`),
      q(
        'Ledger',
        `SELECT trans_no, trans_date, trans_type, code, acc_no, acc_type, trans_amt, receipt_vchr_no, vchr_type, modeofpay, narration
           FROM ledger
          WHERE mbno = $1::numeric
            AND ($2::date IS NULL OR trans_date >= $2::date)
            AND ($3::date IS NULL OR trans_date <= $3::date)
          ORDER BY trans_date DESC, trans_no DESC
          LIMIT 2000`,
        [mb, from, to],
      ),
    ]);

    // FRS = MD (FRS1, head L1002) + MD1 (FRS2, head L1045). Confirmed by the user 2026-11-16 (ES-550).
    const frsMovement = await q(
      'FRS ledger totals',
      `SELECT acc_type,
              COALESCE(SUM(CASE WHEN upper(trans_type) LIKE 'C%' THEN trans_amt ELSE 0 END), 0) AS credits,
              COALESCE(SUM(CASE WHEN upper(trans_type) LIKE 'D%' THEN trans_amt ELSE 0 END), 0) AS debits,
              COUNT(*) AS entries
         FROM ledger WHERE mbno = $1::numeric AND acc_type IN ('MD', 'MD1') GROUP BY acc_type`,
    );
    const frsLedger = await q(
      'FRS ledger entries',
      `SELECT trans_date, acc_type, trans_type, trans_amt, code, receipt_vchr_no, vchr_type, modeofpay, narration, trans_no
         FROM ledger
        WHERE mbno = $1::numeric AND acc_type IN ('MD', 'MD1')
          AND ($2::date IS NULL OR trans_date >= $2::date)
          AND ($3::date IS NULL OR trans_date <= $3::date)
        ORDER BY trans_date DESC, trans_no DESC LIMIT 2000`,
      [mb, from, to],
    );
    const frsDemand = await q(
      'FRS demand',
      `SELECT demand_for_year, demand_for_month, md_amount AS frs1_demand, md1_amount AS frs2_demand,
              (COALESCE(md_amount,0) + COALESCE(md1_amount,0)) AS frs_demand_total, mdbalance AS frs1_balance, md1balance AS frs2_balance, passflag
         FROM demand_master WHERE mbno = $1::numeric AND (COALESCE(md_amount,0) <> 0 OR COALESCE(md1_amount,0) <> 0)
        ORDER BY demand_for_year DESC, demand_for_month DESC LIMIT 60`,
    );
    const f = funds[0] || {};
    const mv = (t: string) => frsMovement.find((r: any) => r.acc_type === t) || { credits: 0, debits: 0, entries: 0 };
    const part = (open: any, monthly: any, t: string) => {
      const m = mv(t);
      const o = Number(open) || 0, c = Number(m.credits) || 0, d = Number(m.debits) || 0;
      return { opening_balance: o, monthly_amount: Number(monthly) || 0, ledger_credits: c, ledger_debits: d, ledger_net: c - d, opening_plus_ledger_net: o + c - d, ledger_entries: Number(m.entries) || 0 };
    };
    const frs1 = part(f.mdopbal, f.mdamt, 'MD');
    const frs2 = part(f.md1_opbal, f.md1_amount, 'MD1');
    const frsSummary = [
      { head: 'FRS1 (MD)', ...frs1 },
      { head: 'FRS2 (MD1)', ...frs2 },
      {
        head: 'FRS total (FRS1 + FRS2)',
        opening_balance: frs1.opening_balance + frs2.opening_balance,
        monthly_amount: frs1.monthly_amount + frs2.monthly_amount,
        ledger_credits: frs1.ledger_credits + frs2.ledger_credits,
        ledger_debits: frs1.ledger_debits + frs2.ledger_debits,
        ledger_net: frs1.ledger_net + frs2.ledger_net,
        opening_plus_ledger_net: frs1.opening_plus_ledger_net + frs2.opening_plus_ledger_net,
        ledger_entries: frs1.ledger_entries + frs2.ledger_entries,
      },
    ];

    // Do not leak file system paths or the secret hash of the mobile PIN.
    const {
      signature_image_path, profile_photo_path, doc_front_path, doc_back_path, ...personal
    } = master;

    return {
      memberNo: mb,
      generatedAt: new Date().toISOString(),
      personal: {
        ...personal,
        hasSignature: !!signature_image_path,
        hasPhoto: !!profile_photo_path,
        hasDocFront: !!doc_front_path,
        hasDocBack: !!doc_back_path,
      },
      status, category,
      balances: balances[0] || null,
      funds: funds[0] || null,
      share: { snapshots: shareSnap },
      nominee: { member: memberNominee[0] || null, fd: fdNominee, joint },
      frs: { rows: frs, balance: frsBal[0] || null, summary: frsSummary, ledger: frsLedger, demand: frsDemand },
      loans: { master: loans, pending: loansPending, repayments: loanRepay, surety: loanSurety, flags: loanFlags, reagreements, rdLien: lien },
      rd: { accounts: rd, config: rdConfig, instalments: rdLedger, yearSummary: rdFy },
      fd: { accounts: fd },
      sb: sb,
      dividend,
      insurance,
      demand,
      documents,
      mobile: mobile[0] || null,
      ledger,
      ledgerLimited: ledger.length >= 2000,
      warnings,
    };
  }

  private validDate(v: string | undefined, name: string): string | null {
    if (!v) return null;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new BadRequestException(`${name} must be YYYY-MM-DD`);
    return v;
  }
}
