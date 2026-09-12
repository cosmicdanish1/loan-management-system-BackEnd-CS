import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

/**
 * Monthly Share Capital balance snapshot — the historical data source the
 * dividend calculation needs. member_balances.shares is only ever a single
 * current running number; without a month-by-month history there is no way
 * to compute "Total Product" (the sum of each month's closing balance) for
 * a financial year, past or future. Mirrors LoanMonthEndService's exact
 * pattern (safe to re-run via ON CONFLICT DO UPDATE).
 */
@Injectable()
export class ShareMonthEndService {
    constructor(private readonly dataSource: DataSource) {}

    /**
     * Capture this month's closing Share Capital balance for every member
     * who currently holds shares. Only member_balances.shares is read (the
     * single current-balance column) — this is a SNAPSHOT of "what the
     * balance is right now", taken once per month, not a reconstruction of
     * what it was mid-month for members whose balance changed since.
     */
    async captureMonthEndSnapshot(month: number, year: number): Promise<{ success: boolean; captured: number; message: string }> {
        const queryRunner = this.dataSource.createQueryRunner();
        await queryRunner.connect();
        await queryRunner.startTransaction();

        try {
            // member_balances has a handful of rows with a literal NaN mbno
            // (bad legacy data, not a real member) -- Postgres treats NaN as
            // self-equal and greater than every real value for float8, so
            // "mbno > 0" alone does NOT exclude them, and they'd all collapse
            // into one bogus row via this query's own ON CONFLICT upsert
            // below. mbno::text ~ '^[0-9]+$' is what actually filters them.
            const rows = await queryRunner.query(
                `SELECT mbno, shares FROM member_balances WHERE COALESCE(shares, 0) > 0 AND mbno::text ~ '^[0-9]+$'`,
            );

            let count = 0;
            for (const row of rows) {
                await queryRunner.query(
                    `INSERT INTO share_monthly_balance
                        (mbno, snapshot_month, snapshot_year, share_balance, snapshot_date)
                     VALUES ($1, $2, $3, $4, CURRENT_DATE)
                     ON CONFLICT (mbno, snapshot_month, snapshot_year) DO UPDATE
                         SET share_balance = EXCLUDED.share_balance,
                             snapshot_date = EXCLUDED.snapshot_date`,
                    [row.mbno, month, year, parseFloat(row.shares) || 0],
                );
                count++;
            }

            await queryRunner.commitTransaction();
            return { success: true, captured: count, message: `Captured ${count} member Share balances for ${month}/${year}` };
        } catch (error: any) {
            await queryRunner.rollbackTransaction();
            throw new Error('Share month-end snapshot failed: ' + error.message);
        } finally {
            await queryRunner.release();
        }
    }

    async getMonthlyBalanceReport(month: number, year: number): Promise<any[]> {
        return this.dataSource.query(
            `SELECT
                smb.mbno,
                CONCAT(m.f_name, ' ', m.l_name) as member_name,
                smb.share_balance,
                smb.snapshot_date
             FROM share_monthly_balance smb
             LEFT JOIN member_master m ON m.mbno::text = smb.mbno::text
             WHERE smb.snapshot_month = $1 AND smb.snapshot_year = $2
             ORDER BY smb.mbno`,
            [month, year],
        );
    }

    async getMemberBalanceHistory(mbno: string): Promise<any[]> {
        return this.dataSource.query(
            `SELECT snapshot_month, snapshot_year, share_balance, snapshot_date
             FROM share_monthly_balance
             WHERE mbno::text = $1
             ORDER BY snapshot_year DESC, snapshot_month DESC`,
            [mbno],
        );
    }
}
