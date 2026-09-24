import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddLoanPaymentModel1759200000000 implements MigrationInterface {
  name = 'AddLoanPaymentModel1759200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE loan_master
      ADD COLUMN IF NOT EXISTS loan_payment_model varchar(32) NOT NULL DEFAULT 'SEPARATE_INTEREST'
    `);
    await queryRunner.query(`
      ALTER TABLE loan_master
      ADD CONSTRAINT loan_master_payment_model_chk
      CHECK (loan_payment_model IN ('SEPARATE_INTEREST', 'COMBINED_INSTALLMENT'))
    `).catch(() => undefined);
    await queryRunner.query(`
      INSERT INTO system_configs
        (key, name, description, value, "dataType", category, "isActive", "isReadonly", "defaultValue")
      VALUES
        ('RULE_LOAN_PAYMENT_MODEL', 'Loan payment model',
         'Controls how future loans record principal and interest.',
         'SEPARATE_INTEREST', 'string', 'business_rules', true, false, 'SEPARATE_INTEREST')
      ON CONFLICT (key) DO NOTHING
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DELETE FROM system_configs WHERE key = 'RULE_LOAN_PAYMENT_MODEL'`);
    await queryRunner.query(`ALTER TABLE loan_master DROP CONSTRAINT IF EXISTS loan_master_payment_model_chk`);
    await queryRunner.query(`ALTER TABLE loan_master DROP COLUMN IF EXISTS loan_payment_model`);
  }
}
