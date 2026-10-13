import { MigrationInterface, QueryRunner } from 'typeorm';

// ES-56: the voucher_master counters (p/r/j/d_vchr_no) were behind the voucher numbers already used by
// migrated data, so new vouchers reused existing numbers. Move each counter up to the highest number
// found in the ledger, staged transactions and voucher headers. Never lowers a counter.
export class SyncVoucherCounters1790985600000 implements MigrationInterface {
    name = 'SyncVoucherCounters1790985600000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        const columns: Array<[string, string]> = [
            ['P', 'p_vchr_no'],
            ['R', 'r_vchr_no'],
            ['J', 'j_vchr_no'],
            ['D', 'd_vchr_no'],
        ];
        for (const [prefix, column] of columns) {
            const rows = await queryRunner.query(
                `SELECT GREATEST(
                    COALESCE((SELECT MAX(substring(receipt_vchr_no from 2)::int) FROM ledger
                              WHERE receipt_vchr_no ~ '^${prefix}[0-9]+$'), 0),
                    COALESCE((SELECT MAX(substring(receipt_vchr_no from 2)::int) FROM transactions
                              WHERE receipt_vchr_no ~ '^${prefix}[0-9]+$'), 0),
                    COALESCE((SELECT MAX(substring("voucherNumber" from 2)::int) FROM vouchers
                              WHERE "voucherNumber" ~ '^${prefix}[0-9]+$'), 0)
                 ) AS highest`,
            );
            const highest = Number(rows?.[0]?.highest) || 0;
            if (highest <= 0) continue;
            const next = `${prefix}${String(highest).padStart(5, '0')}`;
            // Only ever move a counter forward.
            await queryRunner.query(
                `UPDATE voucher_master SET ${column} = $1
                 WHERE COALESCE(NULLIF(regexp_replace(${column}, '\\D', '', 'g'), ''), '0')::int < $2`,
                [next, highest],
            );
        }
    }

    public async down(): Promise<void> {
        // Counters only move forward; there is nothing safe to undo.
    }
}
