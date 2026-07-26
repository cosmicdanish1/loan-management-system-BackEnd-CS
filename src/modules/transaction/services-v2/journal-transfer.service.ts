import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { CreateJournalVoucherDto } from '../dto/journal-transfer.dto';
import { generateVoucherNo } from '../../shared/utils/voucher-utils';

@Injectable()
export class JournalTransferService {
    private readonly logger = new Logger(JournalTransferService.name);

    constructor(private readonly dataSource: DataSource) {}

    async postJournalEntry(dto: CreateJournalVoucherDto, username: string = 'admin') {
        if (!dto.rows?.length) {
            throw new BadRequestException('Journal entry requires at least two rows');
        }

        const totalDebit = dto.rows.reduce((sum, row) => sum + Number(row.debit || 0), 0);
        const totalCredit = dto.rows.reduce((sum, row) => sum + Number(row.credit || 0), 0);

        if (Math.abs(totalDebit - totalCredit) > 0.01) {
            throw new BadRequestException(`Unbalanced: Debit (${totalDebit}) != Credit (${totalCredit})`);
        }
        if (totalDebit <= 0) {
            throw new BadRequestException('Amount must be greater than zero');
        }

        const postingRows = dto.rows.filter(row => Number(row.debit || 0) > 0 || Number(row.credit || 0) > 0);
        if (postingRows.length < 2) {
            throw new BadRequestException('At least two rows with amounts required');
        }

        const queryRunner = this.dataSource.createQueryRunner();
        await queryRunner.connect();
        await queryRunner.startTransaction();

        try {
            const voucherNo = await generateVoucherNo(queryRunner, 'J');

            // 1. Create Voucher Header — PENDING (not POSTED)
            const nextVchrId = await this.getNextId(queryRunner, 'vouchers', 'id');

            // Build memberId from first row with a member number (for the voucher header)
            const firstMemberRow = postingRows.find(r => r.mbno);
            const memberId = firstMemberRow ? firstMemberRow.mbno : null;

            await queryRunner.query(`
                INSERT INTO vouchers (
                    id, "voucherNumber", "voucherDate", "voucherType", "totalAmount",
                    "description", "memberId", "status", "remarks", "createdAt"
                ) VALUES ($1, $2, NOW(), 'JOURNAL', $3, $4, $5, 'PENDING', $6, NOW())
            `, [
                nextVchrId,
                voucherNo,
                totalDebit,
                dto.narration || 'Journal Transfer Entry',
                memberId,
                `JV_TYPE:${dto.transferType || 'headToHead'}|CHQ:${dto.chequeNo || ''}`,
            ]);

            // 2. Insert transaction rows — pass_flag = 'N' (pending, NOT posted)
            let currentTransNo = await this.getNextId(queryRunner, 'transactions', 'trans_no');

            for (const row of postingRows) {
                const debit = Number(row.debit || 0);
                const credit = Number(row.credit || 0);
                const amount = debit > 0 ? debit : credit;
                const type = debit > 0 ? 'DR' : 'CR';
                const headCode = (row.code || '').toString().trim().toUpperCase().substring(0, 5);

                await queryRunner.query(`
                    INSERT INTO transactions (
                        trans_no, trans_type, trans_date, mbno, acc_no, acc_type, trans_amt,
                        receipt_vchr_no, vchr_type, modeofpay, pass_flag, cashier_flag,
                        code, narration, username, cheq_no, cheq_amt
                    ) VALUES ($1, $2, NOW(), $3, $4, 'JV', $5, $6, 'JV', 'J', 'N', 'N', $7, $8, $9, $10, 0)
                `, [
                    currentTransNo++,
                    type,
                    row.mbno || null,
                    Number(row.rdSdSrNo || 0) || 0,
                    amount,
                    voucherNo,
                    headCode || null,
                    row.narration || dto.narration,
                    username,
                    dto.chequeNo || null,
                ]);
            }

            await queryRunner.commitTransaction();
            this.logger.log(`Journal voucher ${voucherNo} created (PENDING) — ${postingRows.length} entries, Total: ${totalDebit}`);

            return {
                success: true,
                message: `Journal voucher ${voucherNo} created. Go to Pass Transactions to post.`,
                voucherNo,
            };

        } catch (error) {
            await queryRunner.rollbackTransaction();
            this.logger.error('Journal Entry Failed', error);
            throw error;
        } finally {
            await queryRunner.release();
        }
    }

    private async getNextId(queryRunner: any, table: string, col: string): Promise<number> {
        const res = await queryRunner.query(`SELECT COALESCE(MAX(${col}), 0) + 1 as next_id FROM ${table}`);
        return parseInt(res[0].next_id);
    }
}
