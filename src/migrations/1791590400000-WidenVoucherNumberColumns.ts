import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * ES-494: voucher numbers were stored in varchar(6) columns, but the voucher counter gives numbers like VCH### and,
 * from the 1000th voucher, VCH1000 (7 characters). Every INSERT into ledger / transactions would then fail with
 * "value too long for type character varying(6)" and no voucher could be created, passed or posted.
 *
 * Every column that holds a voucher number is widened to varchar(20) (the width already used by
 * group_insurance_run.voucher_no). Widening a varchar is a metadata-only change in PostgreSQL: no table rewrite, no
 * data change, indexes stay valid. The migration is idempotent: a column that is already 20 or wider is left alone.
 *
 * down() does nothing on purpose: narrowing back would fail (or cut data) as soon as one longer number exists.
 */
export const VOUCHER_NUMBER_COLUMNS: Array<[string, string]> = [
    ['ledger', 'receipt_vchr_no'],
    ['transactions', 'receipt_vchr_no'],
    ['demand_master', 'receipt_vchr_no'],
    ['demand_masterdelete', 'receipt_vchr_no'],
    ['demand_receipt', 'receipt_vchr_no'],
    ['demandbyhand', 'receipt_vchr_no'],
    ['demandbyhanddeleted', 'receipt_vchr_no'],
    ['bank_cheq_master', 'receipt_vchr_no'],
    ['led', 'receipt_vchr_no'],
    ['interestpaid', 'vchrno'],
    ['fd_interest_master', 'vchrno'],
    ['mpjint', 'vchrno'],
    ['tblmembdetledger', 'vchr_no'],
    ['voucher_master', 'r_vchr_no'],
    ['voucher_master', 'p_vchr_no'],
    ['voucher_master', 'j_vchr_no'],
    ['voucher_master', 'd_vchr_no'],
];

export const VOUCHER_NUMBER_WIDTH = 20;

export class WidenVoucherNumberColumns1791590400000 implements MigrationInterface {
    name = 'WidenVoucherNumberColumns1791590400000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        for (const [table, column] of VOUCHER_NUMBER_COLUMNS) {
            const rows: Array<{ data_type: string; character_maximum_length: number | null }> = await queryRunner.query(
                `SELECT data_type, character_maximum_length FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2`,
                [table, column],
            );
            if (rows.length === 0) continue; // table/column not in this database
            const { data_type, character_maximum_length } = rows[0];
            if (data_type !== 'character varying' && data_type !== 'character') continue;
            if (character_maximum_length !== null && character_maximum_length >= VOUCHER_NUMBER_WIDTH) continue;
            await queryRunner.query(`ALTER TABLE "${table}" ALTER COLUMN "${column}" TYPE varchar(${VOUCHER_NUMBER_WIDTH})`);
        }
    }

    public async down(): Promise<void> {
        // intentionally empty, see the note above
    }
}
