import { MigrationInterface, QueryRunner } from 'typeorm';

// The EMI's constantEMI already charges 1 or 2 months of "delay interest"
// (Slot 1/2 — see loan-rb-schedule.util.ts) to account for the real
// departmental/salary-deduction processing gap before recovery can start.
// Until now that gap was priced into the EMI but never actually reflected in
// the installment due-date schedule itself (getInstallmentStatus always
// started installment #1 one month after disbursement, regardless of slot) —
// an inconsistency: the member was charged for a delay that never happened
// to their collection schedule. This column freezes, at disbursement time,
// how many months the schedule itself should be pushed back by — same
// pattern as loan_master.penalrate/gracedays, which already freeze
// busrules-configured values per loan so a later business-rule change never
// silently alters an existing loan's schedule. NULL on any loan disbursed
// before this migration — getInstallmentStatus treats that as 0 (no shift),
// preserving today's behavior for existing loans.
export class AddLoanMasterDelayMonths1757700000000 implements MigrationInterface {
    name = 'AddLoanMasterDelayMonths1757700000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        const hasTable = await queryRunner.hasTable('loan_master');
        if (!hasTable) return;

        await queryRunner.query(`
            ALTER TABLE "loan_master"
            ADD COLUMN IF NOT EXISTS "delay_months" integer
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        const hasTable = await queryRunner.hasTable('loan_master');
        if (!hasTable) return;

        await queryRunner.query(`
            ALTER TABLE "loan_master"
            DROP COLUMN IF EXISTS "delay_months"
        `);
    }
}
