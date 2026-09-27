import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Turns on the agreed tiered penalty policy for all loan types. The activation
 * date is the migration day, so already-overdue loans do not accrue historical
 * penalties before the policy existed. The global annual rate remains sourced
 * from the existing RULE_PENAL_RATE business rule (bus rules.rlnpenalrate).
 */
export class ActivateGlobalTieredLoanPenalties1790294400000 implements MigrationInterface {
  name = 'ActivateGlobalTieredLoanPenalties1790294400000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      UPDATE system_configs
      SET value = CURRENT_DATE::text, "dataType" = 'string', "updatedAt" = NOW()
      WHERE key = 'RULE_TIERED_LOAN_PENALTY_ACTIVATION_DATE'
    `);
    await queryRunner.query(`
      UPDATE system_configs
      SET value = 'true', "dataType" = 'boolean', "isActive" = true, "updatedAt" = NOW()
      WHERE key = 'RULE_TIERED_LOAN_PENALTY_ENABLED'
    `);
    await queryRunner.query(`
      INSERT INTO system_configs
        (key, name, description, value, "dataType", category, "isActive", "isReadonly", "defaultValue")
      SELECT 'RULE_TIERED_LOAN_PENALTY_ENABLED', 'Tiered loan penalties enabled',
             'Applies the tiered penalty system to all active loan types.',
             'true', 'boolean', 'business_rules', true, false, 'true'
      WHERE NOT EXISTS (
        SELECT 1 FROM system_configs WHERE key = 'RULE_TIERED_LOAN_PENALTY_ENABLED'
      )
    `);
    await queryRunner.query(`
      INSERT INTO system_configs
        (key, name, description, value, "dataType", category, "isActive", "isReadonly", "defaultValue")
      SELECT 'RULE_TIERED_LOAN_PENALTY_ACTIVATION_DATE', 'Tiered loan penalty activation date',
             'Existing overdue installments accrue penalties only from this date.',
             CURRENT_DATE::text, 'string', 'business_rules', true, true, CURRENT_DATE::text
      WHERE NOT EXISTS (
        SELECT 1 FROM system_configs WHERE key = 'RULE_TIERED_LOAN_PENALTY_ACTIVATION_DATE'
      )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DELETE FROM system_configs WHERE key IN (
      'RULE_TIERED_LOAN_PENALTY_ENABLED', 'RULE_TIERED_LOAN_PENALTY_ACTIVATION_DATE'
    )`);
  }
}
