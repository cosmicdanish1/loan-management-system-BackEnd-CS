import { Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { isSbEnabled } from '../../shared/utils/sb-feature';
import { CREDIT_TYPES_SQL, DEBIT_TYPES_SQL } from '../../report/services-v2/ledger-types';

/**
 * Figures for the dashboard widgets, in one call. Every section runs on its own, so
 * a problem in one query leaves that section `null` instead of blanking the dashboard.
 *
 * Definitions (kept here so the widgets and the reports can be reconciled):
 *  - Fixed / recurring deposits: FD and RD are the same thing in this app (`fdmaster`); open = status is not 'C'.
 *  - Savings: `sbmaster` rows with status 'Active'.
 *  - Shares and compulsory deposit: the member balance snapshot (`member_balances`).
 *  - Applications: `loan_pending`. Pending = not sanctioned; sanctioned = sanctioned but not yet paid out.
 *  - Demand recovered: demand rows for this month already posted to the ledger (demand_posted = 'Y').
 *  - RD dues: this month's instalments (`rd_member_config` amount vs `rd_installment_ledger` paid).
 */
@Injectable()
export class DashboardSummaryService {
    private readonly logger = new Logger(DashboardSummaryService.name);

    constructor(private readonly dataSource: DataSource) { }

    private async section<T>(name: string, run: () => Promise<T>): Promise<T | null> {
        try {
            return await run();
        } catch (err: any) {
            this.logger.warn(`Dashboard summary "${name}" failed: ${err?.message}`);
            return null;
        }
    }

    /**
     * Cash-In-Hand (A1001) opening, receipts, payments and closing for each of the last `days` days, in ONE query.
     * Same rules as the daily Cash-Book (receipts = debit legs, payments = credit legs), so the figures match it.
     * The dashboard used to ask for the Cash-Book report once per day (7 reports of 2-5 seconds each) on every load.
     */
    async getCashTrend(daysRequested = 7) {
        const days = Math.min(31, Math.max(1, Math.floor(Number(daysRequested)) || 7));
        const rows = await this.dataSource.query(`
            WITH span AS (SELECT (current_date - ($1::int - 1))::date AS first_day),
            opening AS (
                SELECT coalesce(sum(CASE WHEN trans_type IN ${DEBIT_TYPES_SQL} THEN CAST(trans_amt AS numeric) ELSE 0 END), 0) -
                       coalesce(sum(CASE WHEN trans_type IN ${CREDIT_TYPES_SQL} THEN CAST(trans_amt AS numeric) ELSE 0 END), 0) AS balance
                FROM ledger, span
                WHERE code = 'A1001' AND trans_date < span.first_day
            ),
            daily AS (
                SELECT trans_date::date AS day,
                       coalesce(sum(CASE WHEN trans_type IN ${DEBIT_TYPES_SQL} THEN CAST(trans_amt AS numeric) ELSE 0 END), 0) AS receipts,
                       coalesce(sum(CASE WHEN trans_type IN ${CREDIT_TYPES_SQL} THEN CAST(trans_amt AS numeric) ELSE 0 END), 0) AS payments
                FROM ledger, span
                WHERE code = 'A1001' AND trans_date >= span.first_day AND trans_date < current_date + 1
                GROUP BY 1
            )
            SELECT to_char(g.day, 'YYYY-MM-DD') AS date,
                   (SELECT balance FROM opening)::float AS opening_base,
                   coalesce(d.receipts, 0)::float AS receipts,
                   coalesce(d.payments, 0)::float AS payments
            FROM generate_series((SELECT first_day FROM span), current_date, interval '1 day') AS g(day)
            LEFT JOIN daily d ON d.day = g.day::date
            ORDER BY g.day
        `, [days]);

        let running = Number(rows[0]?.opening_base) || 0;
        return rows.map((r: any) => {
            const opening = running;
            running = opening + r.receipts - r.payments;
            return { date: r.date, opening, receipts: r.receipts, payments: r.payments, closing: running };
        });
    }

    async getSummary() {
        const [deposits, maturities, applications, members, retiring, demand, rdDues] = await Promise.all([
            this.section('deposits', async () => {
                const rows = await this.dataSource.query(`
                    SELECT
                      (SELECT count(*) FROM fdmaster WHERE coalesce(status,'') <> 'C')::int AS fd_count,
                      (SELECT coalesce(sum(fdamount),0) FROM fdmaster WHERE coalesce(status,'') <> 'C')::float AS fd_amount,
                      (SELECT count(*) FROM sbmaster WHERE coalesce(status,'Active') = 'Active')::int AS sb_count,
                      (SELECT coalesce(sum(balance),0) FROM sbmaster WHERE coalesce(status,'Active') = 'Active')::float AS sb_amount,
                      (SELECT coalesce(sum(shares),0) FROM member_balances)::float AS shares,
                      (SELECT coalesce(sum(compulsory_deposit),0) FROM member_balances)::float AS compulsory
                `);
                const r = rows[0];
                return {
                    fixedRecurring: { count: r.fd_count, amount: r.fd_amount },
                    // null when the Saving Bank feature is switched off (SB_ENABLED) - the widget then leaves it out
                    savings: isSbEnabled() ? { count: r.sb_count, amount: r.sb_amount } : null,
                    shares: r.shares,
                    compulsory: r.compulsory,
                };
            }),

            this.section('maturities', async () => {
                const rows = await this.dataSource.query(`
                    SELECT account_number::text AS account_no, mbno::text AS member_no,
                           nullif(trim(concat_ws(' ', f_name, m_name, l_name)), '') AS name,
                           matdate, coalesce(matamount, fdamount, 0)::float AS amount, fdrdflag AS kind
                    FROM fdmaster
                    WHERE coalesce(status,'') <> 'C'
                      AND matdate >= date_trunc('month', current_date)
                      AND matdate <  date_trunc('month', current_date) + interval '1 month'
                    ORDER BY matdate, account_number
                    LIMIT 100
                `);
                return rows.map((r: any) => ({
                    accountNo: r.account_no, memberNo: r.member_no, name: r.name,
                    date: r.matdate, amount: r.amount, kind: r.kind,
                }));
            }),

            this.section('applications', async () => {
                const rows = await this.dataSource.query(`
                    SELECT
                      count(*) FILTER (WHERE coalesce(flg_sanctioned,'N') <> 'Y')::int AS pending_count,
                      coalesce(sum(applied_amt) FILTER (WHERE coalesce(flg_sanctioned,'N') <> 'Y'),0)::float AS pending_amount,
                      count(*) FILTER (WHERE flg_sanctioned = 'Y' AND coalesce(flg_paid,'N') <> 'Y')::int AS sanctioned_count,
                      coalesce(sum(coalesce(sanctioned_amt, applied_amt)) FILTER (WHERE flg_sanctioned = 'Y' AND coalesce(flg_paid,'N') <> 'Y'),0)::float AS sanctioned_amount,
                      count(*) FILTER (WHERE flg_paid = 'Y' AND sanctioned_date >= date_trunc('month', current_date))::int AS disbursed_count,
                      coalesce(sum(coalesce(sanctioned_amt, applied_amt)) FILTER (WHERE flg_paid = 'Y' AND sanctioned_date >= date_trunc('month', current_date)),0)::float AS disbursed_amount
                    FROM loan_pending
                `);
                const r = rows[0];
                return {
                    pending: { count: r.pending_count, amount: r.pending_amount },
                    sanctioned: { count: r.sanctioned_count, amount: r.sanctioned_amount },
                    disbursedThisMonth: { count: r.disbursed_count, amount: r.disbursed_amount },
                };
            }),

            this.section('members', async () => {
                const rows = await this.dataSource.query(`
                    SELECT
                      (SELECT count(*) FROM member_master WHERE memb_date >= date_trunc('month', current_date))::int AS new_this_month,
                      (SELECT count(*) FROM member_master WHERE memb_date >= date_trunc('month', current_date) - interval '1 month'
                                                             AND memb_date <  date_trunc('month', current_date))::int AS new_last_month
                `);
                return { newThisMonth: rows[0].new_this_month, newLastMonth: rows[0].new_last_month };
            }),

            this.section('retiring', async () => {
                const where = `date_of_retirement >= current_date AND date_of_retirement < current_date + interval '6 months'
                               AND coalesce(flg_retire,'') <> 'Y'`;
                const [count] = await this.dataSource.query(`SELECT count(*)::int AS n FROM member_master WHERE ${where}`);
                const rows = await this.dataSource.query(`
                    SELECT m.mbno::text AS member_no,
                           coalesce(nullif(m.full_name,''), nullif(trim(concat_ws(' ', m.f_name, m.m_name, m.l_name)), '')) AS name,
                           m.date_of_retirement AS retire_date,
                           coalesce((SELECT sum(l.balance) FROM loan_master l WHERE l.mbno = m.mbno), 0)::float AS loan_balance
                    FROM member_master m
                    WHERE ${where}
                    ORDER BY m.date_of_retirement, m.mbno
                    LIMIT 8
                `);
                return {
                    count: count.n,
                    upcoming: rows.map((r: any) => ({ memberNo: r.member_no, name: r.name, date: r.retire_date, loanBalance: r.loan_balance })),
                };
            }),

            this.section('demand', async () => {
                const rows = await this.dataSource.query(`
                    SELECT coalesce(sum(totaldemand),0)::float AS demand,
                           coalesce(sum(totaldemand) FILTER (WHERE demand_posted = 'Y'),0)::float AS recovered,
                           count(*)::int AS members
                    FROM demand_master
                    WHERE demand_for_year = extract(year from current_date)::int
                      AND demand_for_month = extract(month from current_date)::int
                `);
                const r = rows[0];
                return { demand: r.demand, recovered: r.recovered, members: r.members };
            }),

            // RD instalments for the current calendar month. A member counts when they have an RD amount set
            // for this financial year (the latest setting in force on the 5th, the due day) or already have a
            // ledger row for the month. "Paid" never counts more than was expected, so an over-payment by one
            // member cannot hide another member's shortfall.
            this.section('rdDues', async () => {
                const rows = await this.dataSource.query(`
                    WITH fy AS (SELECT yearcode FROM yearend WHERE current_date BETWEEN start_date AND end_date ORDER BY yearcode DESC LIMIT 1),
                    cfg AS (SELECT DISTINCT ON (c.mbno) c.mbno::text AS mbno, c.monthly_rd_amount::float AS amt
                            FROM rd_member_config c JOIN fy ON c.yearcode = fy.yearcode
                            WHERE c.effective_from_date <= (date_trunc('month', current_date) + interval '4 days')
                            ORDER BY c.mbno, c.effective_from_date DESC, c.id DESC),
                    led AS (SELECT l.mbno::text AS mbno, l.expected_amount::float AS expected, l.paid_amount::float AS paid
                            FROM rd_installment_ledger l JOIN fy ON l.yearcode = fy.yearcode
                            WHERE l.installment_month = extract(month from current_date)::int
                              AND l.installment_year = extract(year from current_date)::int),
                    j AS (SELECT coalesce(led.expected, cfg.amt, 0) AS expected, coalesce(led.paid, 0) AS paid
                          FROM cfg FULL JOIN led USING (mbno))
                    SELECT count(*)::int AS members,
                           coalesce(sum(expected),0)::float AS expected,
                           coalesce(sum(least(paid, expected)),0)::float AS paid,
                           count(*) FILTER (WHERE paid >= expected)::int AS paid_members,
                           count(*) FILTER (WHERE paid > 0 AND paid < expected)::int AS partial_members,
                           count(*) FILTER (WHERE paid <= 0)::int AS unpaid_members
                    FROM j WHERE expected > 0
                `);
                const r = rows[0];
                return {
                    members: r.members, expected: r.expected, paid: r.paid,
                    paidMembers: r.paid_members, partialMembers: r.partial_members, unpaidMembers: r.unpaid_members,
                };
            }),
        ]);

        return { deposits, maturities, applications, members, retiring, demand, rdDues, generatedAt: new Date().toISOString() };
    }
}
