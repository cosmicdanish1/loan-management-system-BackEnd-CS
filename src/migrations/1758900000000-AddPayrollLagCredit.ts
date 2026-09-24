import { MigrationInterface, QueryRunner } from 'typeorm';

// Automatic detection of the "payroll-lag" payment: when a loan consolidates
// an existing active loan of the same type (see the existingActiveLoans
// logic in pass-transaction.service.ts), the member's payroll deduction
// system (BSP) takes ~1 delayMonths cycle to receive and act on the closure
// instruction — so one more old-rate EMI still gets deducted after the new,
// consolidated loan is already live. That payment is real money the member
// already paid, but it belongs to the now-closed predecessor loan, not the
// new one's installment schedule.
//
// loan_master gets the old EMI's principal/interest split and a watch
// window (disbursement + delayMonths, the same delay used for slot pricing)
// frozen on it at consolidation time, so recordLoanRepayment() can recognize
// a matching stray payment automatically instead of a human typing a manual
// -7,650-style adjustment into the closure screen every time. NULL on any
// loan that wasn't a consolidation (the normal case) — nothing changes for
// those.
//
// loan_repayment_ledger gets a flag marking a row as this kind of credit —
// getInstallmentStatus's pooling and getLedgerHistoryTotals's totals both
// exclude flagged rows (the money never applied to any installment of the
// new loan), while calculateEarlyClosure/executeEarlyClosure automatically
// net it back out of the final closure amount, replacing the manual
// adjustment step.
export class AddPayrollLagCredit1758900000000 implements MigrationInterface {
    name = 'AddPayrollLagCredit1758900000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        if (await queryRunner.hasTable('loan_master')) {
            await queryRunner.query(`
                ALTER TABLE "loan_master"
                ADD COLUMN IF NOT EXISTS "payroll_lag_watch_until" date,
                ADD COLUMN IF NOT EXISTS "payroll_lag_old_principal" numeric(14,2),
                ADD COLUMN IF NOT EXISTS "payroll_lag_old_interest" numeric(14,2)
            `);
        }
        if (await queryRunner.hasTable('loan_repayment_ledger')) {
            await queryRunner.query(`
                ALTER TABLE "loan_repayment_ledger"
                ADD COLUMN IF NOT EXISTS "is_payroll_lag_credit" boolean NOT NULL DEFAULT false
            `);
        }
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        if (await queryRunner.hasTable('loan_master')) {
            await queryRunner.query(`
                ALTER TABLE "loan_master"
                DROP COLUMN IF EXISTS "payroll_lag_watch_until",
                DROP COLUMN IF EXISTS "payroll_lag_old_principal",
                DROP COLUMN IF EXISTS "payroll_lag_old_interest"
            `);
        }
        if (await queryRunner.hasTable('loan_repayment_ledger')) {
            await queryRunner.query(`
                ALTER TABLE "loan_repayment_ledger"
                DROP COLUMN IF EXISTS "is_payroll_lag_credit"
            `);
        }
    }
}
