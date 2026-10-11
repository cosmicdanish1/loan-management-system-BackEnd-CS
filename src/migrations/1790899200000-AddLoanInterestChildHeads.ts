import { MigrationInterface, QueryRunner } from 'typeorm';

// ES-46: per-loan-type interest income heads. I1002 "INTT FROM MEMBER" stays as the parent/total;
// new postings go to I1013 (Regular Loan) / I1014 (Emergency Loan). Existing I1002 history is left
// as-is (no backfill). headmaster.interest mirrors I1002's 'RLN' marker for the matching loan type.
export class AddLoanInterestChildHeads1790899200000 implements MigrationInterface {
    name = 'AddLoanInterestChildHeads1790899200000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            INSERT INTO headmaster (code, parent_code, hposition, head_name, interest, headtype, op_bal, pflag)
            VALUES
              ('I1013', 'I1002', '', 'INTT FROM MEMBER - REGULAR LOAN',   'RLN', 'OTH', 0, 'I'),
              ('I1014', 'I1002', '', 'INTT FROM MEMBER - EMERGENCY LOAN', 'ALN', 'OTH', 0, 'I')
            ON CONFLICT (code) DO NOTHING
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        // Only removable while nothing has been posted to them.
        await queryRunner.query(`
            DELETE FROM headmaster h WHERE h.code IN ('I1013','I1014')
              AND NOT EXISTS (SELECT 1 FROM ledger l WHERE l.code = h.code)
        `);
    }
}
