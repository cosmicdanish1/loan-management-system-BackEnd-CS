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

    /**
     * Generate next sequential member number (8 digits)
     */
    async generateNextMemberNumber(): Promise<string> {
        const { value } = await this.getNextValue('MEMBER_NO');
        return value.toString().padStart(8, '0');
    }

    /**
     * Show the member number the next Save will receive WITHOUT consuming it (ES-310).
     * generateNextMemberNumber() increments the counter, so calling it for a screen preview burned a number
     * on every open and the number shown never matched the one saved.
     */
    async peekNextMemberNumber(): Promise<string> {
        const rows = await this.dataSource.query(`SELECT last_value FROM sequence_master WHERE sequence_key = 'MEMBER_NO'`);
        const next = rows.length ? parseInt(rows[0].last_value, 10) + 1 : 1;
        return next.toString().padStart(8, '0');
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
