import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

@Injectable()
export class LoanMonthEndService {
    constructor(private readonly dataSource: DataSource) {}

    /**
     * Capture month-end loan balance snapshot for all members with active loans.
     * Safe to re-run — uses ON CONFLICT DO UPDATE.
     */
    async captureMonthEndSnapshot(month: number, year: number): Promise<{ success: boolean; captured: number; message: string }> {
        const queryRunner = this.dataSource.createQueryRunner();
        await queryRunner.connect();
        await queryRunner.startTransaction();

        try {
            // Aggregate current balances from loan_master grouped by member + loantype
            // BUG FIX 39 (same defect found in pass-transaction.service.ts and
            // loan-repayment.service.ts): tested only 'ELN', but ALN is the loan type every real
            // loan in this system uses — every historical month-end snapshot would have filed
            // 100% of real emergency-loan balances under "regular" instead.
            const activeLoans = await queryRunner.query(
                `SELECT
                    mbno,
                    SUM(CASE WHEN loantype IN ('ELN','ALN','A','E','EMR','ADD') OR loantype ILIKE '%EMERGENCY%' THEN balance ELSE 0 END) as emergency_balance,
                    SUM(CASE WHEN loantype IN ('ELN','ALN','A','E','EMR','ADD') OR loantype ILIKE '%EMERGENCY%' THEN 0 ELSE balance END) as regular_balance
                 FROM loan_master
                 WHERE balance > 0
                 GROUP BY mbno`
            );

            let count = 0;
            for (const row of activeLoans) {
                await queryRunner.query(
                    `INSERT INTO loan_monthly_balance
                        (mbno, snapshot_month, snapshot_year, regular_loan_balance, emergency_loan_balance, snapshot_date)
                     VALUES ($1, $2, $3, $4, $5, CURRENT_DATE)
                     ON CONFLICT (mbno, snapshot_month, snapshot_year) DO UPDATE
                         SET regular_loan_balance   = EXCLUDED.regular_loan_balance,
                             emergency_loan_balance = EXCLUDED.emergency_loan_balance,
                             snapshot_date          = EXCLUDED.snapshot_date`,
                    [row.mbno, month, year, parseFloat(row.regular_balance || 0), parseFloat(row.emergency_balance || 0)]
                );
                count++;
            }

            await queryRunner.commitTransaction();
            return { success: true, captured: count, message: `Captured ${count} member balances for ${month}/${year}` };
        } catch (error: any) {
            await queryRunner.rollbackTransaction();
            throw new Error('Month-end snapshot failed: ' + error.message);
        } finally {
            await queryRunner.release();
        }
    }

    async getMonthlyBalanceReport(month: number, year: number): Promise<any[]> {
        return this.dataSource.query(
            `SELECT
                lmb.mbno,
                CONCAT(m.f_name, ' ', m.l_name) as member_name,
                lmb.regular_loan_balance,
                lmb.emergency_loan_balance,
                (lmb.regular_loan_balance + lmb.emergency_loan_balance) as total_outstanding,
                lmb.snapshot_date
             FROM loan_monthly_balance lmb
             LEFT JOIN member_master m ON m.mbno = lmb.mbno
             WHERE lmb.snapshot_month = $1 AND lmb.snapshot_year = $2
             ORDER BY lmb.mbno`,
            [month, year]
        );
    }

    async getMemberBalanceHistory(mbno: string): Promise<any[]> {
        return this.dataSource.query(
            `SELECT snapshot_month, snapshot_year, regular_loan_balance, emergency_loan_balance,
                    (regular_loan_balance + emergency_loan_balance) as total_outstanding, snapshot_date
             FROM loan_monthly_balance
             WHERE mbno = $1
             ORDER BY snapshot_year DESC, snapshot_month DESC`,
            [mbno]
        );
    }
}
