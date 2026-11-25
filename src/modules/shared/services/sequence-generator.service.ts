import { Injectable, Logger } from '@nestjs/common';
import { DataSource, Repository } from 'typeorm';
import { InjectRepository } from '@nestjs/typeorm';
import { SequenceMaster } from '../entities/sequence-master.entity';

/**
 * Centralized service for generating sequential IDs across the application.
 * This avoids duplicate sequence generation code in multiple services.
 * Now optimized to use a dedicated sequence_master table with atomic updates.
 */
@Injectable()
export class SequenceGeneratorService {
    private readonly logger = new Logger(SequenceGeneratorService.name);

    constructor(
        private readonly dataSource: DataSource,
        @InjectRepository(SequenceMaster)
        private readonly sequenceRepository: Repository<SequenceMaster>
    ) { }

    /**
     * Get the next value for a given sequence key atomically.
     * Optionally resets every year.
     */
    private async getNextValue(key: string, defaultPrefix: string = '', resetYearly: boolean = false): Promise<{ value: number, prefix: string }> {
        const currentYear = new Date().getFullYear();
        let sequence = await this.sequenceRepository.findOne({ where: { sequence_key: key } });

        // Atomic update and retrieval
        let query = `
            INSERT INTO sequence_master (sequence_key, last_value, prefix, reset_yearly, last_year)
            VALUES ($1, 1, $2, $3, $4)
            ON CONFLICT (sequence_key) DO UPDATE 
            SET 
                last_value = CASE 
                    WHEN sequence_master.reset_yearly = true AND sequence_master.last_year < $4 THEN 1
                    ELSE sequence_master.last_value + 1 
                END,
                last_year = $4
            RETURNING last_value, prefix
        `;

        const result = await this.dataSource.query(query, [key, defaultPrefix, resetYearly, currentYear]);
        return {
            value: parseInt(result[0].last_value),
            prefix: result[0].prefix || defaultPrefix
        };
    }

    /** New members are numbered inside this block (the legacy's block for new members: 990,042,382 was the last one used). */
    static readonly MEMBER_BLOCK_FIRST = 990000000;
    static readonly MEMBER_BLOCK_LAST = 999999999;

    /**
     * The next member number for a NEW member.
     *
     * Numbers continue after the highest number already used in the new-member block 990,000,000 to 999,999,999. That block
     * holds ten million numbers, far more than the 20 lakh members a city of this size can produce. The counter is one
     * atomic statement (the row is locked, so two saves at the same moment never get the same number), it can never fall
     * behind numbers that are already in the table, and a number a member already holds is skipped. The test numbers of
     * the QA runs (above 9,999,999,999) and the old series (3xxxxxxx, 61xxxxxxx) are not part of the block. The database
     * also refuses a duplicate member number (migration 1794960000000), so a lost race can only ever ask the user to save again.
     */
    async generateNextMemberNumber(): Promise<string> {
        const year = new Date().getFullYear();
        for (let attempt = 0; attempt < 10000; attempt++) {
            const rows = await this.dataSource.query(
                `INSERT INTO sequence_master (sequence_key, last_value, prefix, reset_yearly, last_year)
                 VALUES ('MEMBER_NO_NEW',
                         COALESCE((SELECT MAX(mbno) FROM member_master WHERE mbno BETWEEN $1 AND $2), $1 - 1)::bigint + 1, '', false, $3)
                 ON CONFLICT (sequence_key) DO UPDATE SET
                     last_value = GREATEST(sequence_master.last_value,
                                           COALESCE((SELECT MAX(mbno) FROM member_master WHERE mbno BETWEEN $1 AND $2), $1 - 1)::bigint) + 1,
                     last_year = $3
                 RETURNING last_value`,
                [SequenceGeneratorService.MEMBER_BLOCK_FIRST, SequenceGeneratorService.MEMBER_BLOCK_LAST, year],
            );
            const value = parseInt(rows[0].last_value, 10);
            if (value > SequenceGeneratorService.MEMBER_BLOCK_LAST) {
                throw new Error('The new-member number block is full. Please contact support.');
            }
            const used = await this.dataSource.query(`SELECT 1 FROM member_master WHERE mbno = $1::numeric LIMIT 1`, [value.toString()]);
            if (used.length === 0) return value.toString();
        }
        throw new Error('Could not find a free member number. Please contact support.');
    }

    /**
     * The number the next Save will receive, WITHOUT using it (ES-310): the same rule as generateNextMemberNumber, read-only.
     */
    async peekNextMemberNumber(): Promise<string> {
        const first = SequenceGeneratorService.MEMBER_BLOCK_FIRST;
        const last = SequenceGeneratorService.MEMBER_BLOCK_LAST;
        const [hi] = await this.dataSource.query(`SELECT COALESCE(MAX(mbno), $1 - 1)::bigint AS m FROM member_master WHERE mbno BETWEEN $1 AND $2`, [first, last]);
        const [seq] = await this.dataSource.query(`SELECT last_value FROM sequence_master WHERE sequence_key = 'MEMBER_NO_NEW'`);
        let next = Math.max(parseInt(hi.m, 10), seq ? parseInt(seq.last_value, 10) : 0) + 1;
        for (let i = 0; i < 10000 && next <= last; i++, next++) {
            const used = await this.dataSource.query(`SELECT 1 FROM member_master WHERE mbno = $1::numeric LIMIT 1`, [next.toString()]);
            if (used.length === 0) break;
        }
        if (next > last) throw new Error('The new-member number block is full. Please contact support.');
        return next.toString();
    }

    /**
     * Generate next sequential loan case number
     */
    async generateNextLoanCaseNo(): Promise<string> {
        // ES-391: case numbers of migrated loans are shared between members, and a few legacy numbers sit above the
        // counter. A new number is only handed out when no loan (sanctioned or pending) already uses it.
        for (let attempt = 0; attempt < 1000; attempt++) {
            const { value } = await this.getNextValue('LOAN_CASE');
            const used = await this.dataSource.query(
                `SELECT 1 FROM loan_master WHERE loancaseno::text = $1
                 UNION ALL
                 SELECT 1 FROM loan_pending WHERE loancaseno::text = $1
                 LIMIT 1`,
                [value.toString()],
            );
            if (used.length === 0) return value.toString();
        }
        throw new Error('Could not find a free loan case number. Please contact support.');
    }

    /**
     * Get next sequential voucher number
     */
    async getNextVoucherNumber(): Promise<string> {
        // ES-460: the counter restarts at 1 each new year (reset_yearly), but voucher numbers are unique. Without a check
        // the first voucher of the new year was VCH001 again, which already exists, so every create failed with a 500
        // until the counter had climbed past the old numbers. Like generateVoucherNo and generateNextLoanCaseNo, a number
        // that is already used (voucher header, staged or posted rows) is skipped. The reset rule itself is not changed:
        // whether numbers should restart each year at all is an owner decision (see ES-465).
        for (let attempt = 0; attempt < 100000; attempt++) {
            const { value, prefix } = await this.getNextValue('VOUCHER_NO', 'VCH', true);
            const candidate = `${prefix}${value.toString().padStart(3, '0')}`;
            const used = await this.dataSource.query(
                `SELECT 1 WHERE EXISTS (SELECT 1 FROM vouchers WHERE "voucherNumber" = $1)
                          OR EXISTS (SELECT 1 FROM transactions WHERE receipt_vchr_no = $1)
                          OR EXISTS (SELECT 1 FROM ledger WHERE receipt_vchr_no = $1)`,
                [candidate],
            );
            if (!used || used.length === 0) return candidate;
        }
        throw new Error('Could not find a free voucher number. Please contact support.');
    }

    /**
     * Get next sequential voucher ID
     */
    async getNextVoucherId(): Promise<number> {
        const { value } = await this.getNextValue('VOUCHER_ID');
        return value;
    }

    /**
     * Generic method for any other sequences
     */
    async generateSequence(key: string, prefix: string = '', padding: number = 0): Promise<string> {
        const { value } = await this.getNextValue(key, prefix);
        return `${prefix}${value.toString().padStart(padding, '0')}`;
    }
}
