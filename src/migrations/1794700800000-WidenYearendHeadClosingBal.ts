import { MigrationInterface, QueryRunner } from 'typeorm';

// ES-644: yearend_head.closing_bal was numeric(18,0), so the paise of a head's opening balance were dropped when a year
// was saved in Head Opening Balance (headmaster.op_bal is numeric(19,4), the legacy column is money). Same width as
// headmaster.op_bal. Widening a numeric column never changes an existing value, so it is safe to run on any install,
// and running it twice does nothing.
export class WidenYearendHeadClosingBal1794700800000 implements MigrationInterface {
    name = 'WidenYearendHeadClosingBal1794700800000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            DO $$
            BEGIN
                IF EXISTS (
                    SELECT 1 FROM information_schema.columns
                     WHERE table_name = 'yearend_head' AND column_name = 'closing_bal'
                       AND (numeric_scale IS DISTINCT FROM 4 OR numeric_precision IS DISTINCT FROM 19)
                ) THEN
                    ALTER TABLE "yearend_head" ALTER COLUMN "closing_bal" TYPE numeric(19,4);
                END IF;
            END $$;
        `);
    }

    public async down(): Promise<void> {
        // not reversed: narrowing would round the paise away again
    }
}
