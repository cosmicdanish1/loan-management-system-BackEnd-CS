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
     * Generate next sequential loan case number
     */
    async generateNextLoanCaseNo(): Promise<string> {
        const { value } = await this.getNextValue('LOAN_CASE');
        return value.toString();
    }

    /**
     * Get next sequential voucher number
     */
    async getNextVoucherNumber(): Promise<string> {
        const { value, prefix } = await this.getNextValue('VOUCHER_NO', 'VCH', true);
        return `${prefix}${value.toString().padStart(3, '0')}`;
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
