import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Aligns the persisted reducing-balance schedule key with the application:
 * member + loan type + case number. Older installations created this table
 * without loantype and with a case-only unique key, while quote/read paths
 * already scope schedules by all three loan identifiers.
 */
export class AddLoanRbScheduleLoanType1790553600000 implements MigrationInterface {
    name = 'AddLoanRbScheduleLoanType1790553600000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            ALTER TABLE loan_rb_schedule
            ADD COLUMN IF NOT EXISTS loantype varchar(20)
        `);

        // A schedule row can only be classified safely when it maps to exactly
        // one loan_master row. Abort instead of assigning the wrong loan type.
        await queryRunner.query(`
            DO $$
            DECLARE unresolved_count integer;
            BEGIN
                SELECT COUNT(*) INTO unresolved_count
                FROM loan_rb_schedule s
                WHERE (
                    SELECT COUNT(*)
                    FROM loan_master lm
                    WHERE lm.mbno = s.mbno AND lm.loancaseno = s.loancaseno
                ) <> 1;

                IF unresolved_count > 0 THEN
                    RAISE EXCEPTION
                        'Cannot backfill loan_rb_schedule.loantype: % schedule row(s) do not match exactly one loan_master member/case',
                        unresolved_count;
                END IF;

                IF EXISTS (
                    SELECT 1
                    FROM loan_rb_schedule s
                    JOIN loan_master lm
                      ON lm.mbno = s.mbno AND lm.loancaseno = s.loancaseno
                    WHERE s.loantype IS NOT NULL AND s.loantype <> lm.loantype
                ) THEN
                    RAISE EXCEPTION
                        'Cannot backfill loan_rb_schedule.loantype: existing non-null loan type conflicts with loan_master';
                END IF;
            END $$
        `);

        await queryRunner.query(`
            UPDATE loan_rb_schedule s
            SET loantype = lm.loantype
            FROM loan_master lm
            WHERE lm.mbno = s.mbno AND lm.loancaseno = s.loancaseno
              AND s.loantype IS NULL
        `);
        await queryRunner.query(`
            ALTER TABLE loan_rb_schedule ALTER COLUMN loantype SET NOT NULL
        `);

        await queryRunner.query(`
            ALTER TABLE loan_rb_schedule
            DROP CONSTRAINT IF EXISTS uq_loan_rb_schedule_case_instal
        `);
        await queryRunner.query(`
            ALTER TABLE loan_rb_schedule
            ADD CONSTRAINT uq_loan_rb_schedule_member_type_case_instal
            UNIQUE (mbno, loantype, loancaseno, installment_no)
        `);
        await queryRunner.query(`
            CREATE INDEX IF NOT EXISTS idx_loan_rb_schedule_member_type_case
            ON loan_rb_schedule (mbno, loantype, loancaseno)
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        // Add the old global key first. If newer data contains case collisions,
        // PostgreSQL will reject the rollback instead of deleting schedules.
        await queryRunner.query(`
            ALTER TABLE loan_rb_schedule
            ADD CONSTRAINT uq_loan_rb_schedule_case_instal
            UNIQUE (loancaseno, installment_no)
        `);
        await queryRunner.query(`
            DROP INDEX IF EXISTS idx_loan_rb_schedule_member_type_case
        `);
        await queryRunner.query(`
            ALTER TABLE loan_rb_schedule
            DROP CONSTRAINT uq_loan_rb_schedule_member_type_case_instal
        `);
        await queryRunner.query(`ALTER TABLE loan_rb_schedule DROP COLUMN loantype`);
    }
}
