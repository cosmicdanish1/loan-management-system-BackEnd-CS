import { Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';

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

    async getSummary() {
        const [deposits, maturities, applications, members, retiring, demand] = await Promise.all([
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
                    savings: { count: r.sb_count, amount: r.sb_amount },
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
        ]);

        return { deposits, maturities, applications, members, retiring, demand, generatedAt: new Date().toISOString() };
    }
}
