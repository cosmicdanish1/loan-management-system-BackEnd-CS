import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Makes reducing balance the only supported interest method. The old
 * loan_payment_model column is intentionally left in place for rollback and
 * historical compatibility; application code no longer offers or selects a
 * combined-installment calculation path.
 */
export class UseReducingBalanceInterestMethod1759300000000 implements MigrationInterface {
  name = 'UseReducingBalanceInterestMethod1759300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE loan_master
      ADD COLUMN IF NOT EXISTS loan_interest_method varchar(32)
      NOT NULL DEFAULT 'REDUCING_BALANCE'
    `);
    await queryRunner.query(`
      UPDATE loan_master
      SET loan_interest_method = 'REDUCING_BALANCE'
      WHERE loan_interest_method IS NULL OR loan_interest_method <> 'REDUCING_BALANCE'
    `);
    await queryRunner.query(`
      DO $$ BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'chk_loan_master_interest_method'
        ) THEN
          ALTER TABLE loan_master
          ADD CONSTRAINT chk_loan_master_interest_method
          CHECK (loan_interest_method = 'REDUCING_BALANCE');
        END IF;
      END $$;
    `);
    await queryRunner.query(`
      INSERT INTO system_configs
        (key, name, description, value, "dataType", category, "isActive", "isReadonly", "defaultValue")
      VALUES
        ('RULE_LOAN_INTEREST_METHOD', 'Loan interest method',
         'The single supported loan-interest calculation method.',
         'REDUCING_BALANCE', 'string', 'business_rules', true, false,
         'REDUCING_BALANCE')
      ON CONFLICT (key) DO UPDATE
        SET value = 'REDUCING_BALANCE', "defaultValue" = 'REDUCING_BALANCE', "isActive" = true
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DELETE FROM system_configs WHERE key = 'RULE_LOAN_INTEREST_METHOD'`);
    await queryRunner.query(`ALTER TABLE loan_master DROP CONSTRAINT IF EXISTS chk_loan_master_interest_method`);
    await queryRunner.query(`ALTER TABLE loan_master DROP COLUMN IF EXISTS loan_interest_method`);
  }
}
