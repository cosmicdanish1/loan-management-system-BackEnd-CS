import { MigrationInterface, QueryRunner } from 'typeorm';

// ES-457: the debit (expense) leg of an interest posting (voucher type IN) was written with the member's number and the
// member's account type (SB / FD). It was therefore counted in the member's own balance, and the credited interest was
// netted away again by every later interest run and every ledger-based report. The leg is now head-only (member 0,
// type OTH), as the legacy interest journals and this app's other income / cash legs are. This turns the rows written
// before the fix into the same shape. Idempotent: a second run finds nothing to change. Only the expense leg of an
// interest posting is touched (type IN, DR, tagged SB / FD); the member's credit leg stays as it is.
export class FixInterestExpenseLegTags1794441600000 implements MigrationInterface {
    name = 'FixInterestExpenseLegTags1794441600000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            UPDATE ledger
               SET mbno = 0, acc_no = 0, acc_type = 'OTH'
             WHERE vchr_type = 'IN'
               AND trans_type = 'DR'
               AND acc_type IN ('SB', 'FD')
               AND narration LIKE 'Interest expense - %'`);
    }

    public async down(): Promise<void> {
        // The member number the leg carried cannot be rebuilt from the row; the other leg of the voucher still names it.
    }
}
