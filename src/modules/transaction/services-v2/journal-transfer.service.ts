import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { CreateJournalVoucherDto } from '../dto/journal-transfer.dto';
import { generateVoucherNo } from '../../shared/utils/voucher-utils';

@Injectable()
export class JournalTransferService {
    private readonly logger = new Logger(JournalTransferService.name);

    constructor(private readonly dataSource: DataSource) { }

    /**
     * Create a balanced Journal voucher in PENDING status.
     *
     * Nothing is posted to the ledger or to member balances here: the voucher (and its staged
     * `transactions` rows, pass_flag 'N') must be approved in Pass Transactions, which does the
     * real posting (PassTransactionService.passTransaction) and can reverse it again.
     */
    async postJournalEntry(dto: CreateJournalVoucherDto, username: string = 'admin') {
        if (!dto.rows?.length) {
            throw new BadRequestException('Journal entry requires at least two rows');
        }

        const totalDebit = dto.rows.reduce((sum, row) => sum + Number(row.debit || 0), 0);
        const totalCredit = dto.rows.reduce((sum, row) => sum + Number(row.credit || 0), 0);

        if (Math.abs(totalDebit - totalCredit) > 0.01) {
            throw new BadRequestException(`Unbalanced Journal Entry: Total Debit (₹${totalDebit}) must equal Total Credit (₹${totalCredit})`);
        }
        if (totalDebit <= 0) {
            throw new BadRequestException('Amount must be greater than zero');
        }
        if (dto.rows.some(row => Number(row.debit || 0) < 0 || Number(row.credit || 0) < 0)) {
            throw new BadRequestException('Debit and credit amounts cannot be negative');
        }

        const postingRows = dto.rows.filter(row => Number(row.debit || 0) > 0 || Number(row.credit || 0) > 0);
        if (postingRows.length < 2) {
            throw new BadRequestException('At least two rows with amounts required');
        }
        if (postingRows.some(row => Number(row.debit || 0) > 0 && Number(row.credit || 0) > 0)) {
            throw new BadRequestException('A row cannot have both a debit and a credit amount');
        }

        const normalizedCodes = postingRows.map(row => (row.code || '').toString().trim().toUpperCase());
        if (normalizedCodes.some(code => !code)) {
            throw new BadRequestException('Every posting row requires a head code');
        }

        const queryRunner = this.dataSource.createQueryRunner();
        await queryRunner.connect();
        await queryRunner.startTransaction();

        try {
            // Reject any head code that doesn't exist in headmaster — an unvalidated code
            // silently truncated to 5 chars and posted straight to the ledger, where it can
            // never join back to a real head in Trial Balance / General Ledger / Balance Sheet.
            const uniqueCodes = [...new Set(normalizedCodes)];
            const validHeads = await queryRunner.query(
                `SELECT code FROM headmaster WHERE UPPER(TRIM(code)) = ANY($1)`, [uniqueCodes]
            );
            const validCodeSet = new Set(validHeads.map((h: any) => h.code.toString().trim().toUpperCase()));
            const invalidCodes = uniqueCodes.filter(code => !validCodeSet.has(code));
            if (invalidCodes.length > 0) {
                throw new BadRequestException(`Unknown head code(s): ${invalidCodes.join(', ')}`);
            }

            // Reject any member number that doesn't exist — an unvalidated mbno posts a
            // phantom member into the ledger with no way to ever look it up again.
            const uniqueMbnos = [...new Set(postingRows.filter(r => r.mbno).map(r => r.mbno))];
            if (uniqueMbnos.length > 0) {
                const validMembers = await queryRunner.query(
                    `SELECT mbno FROM member_master WHERE mbno = ANY($1)`, [uniqueMbnos]
                );
                const validMbnoSet = new Set(validMembers.map((m: any) => Number(m.mbno)));
                const invalidMbnos = uniqueMbnos.filter(mbno => !validMbnoSet.has(Number(mbno)));
                if (invalidMbnos.length > 0) {
                    throw new BadRequestException(`Unknown member number(s): ${invalidMbnos.join(', ')}`);
                }
            }

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
                const headCode = (row.code || '').toString().trim().toUpperCase();
                // Loan heads carry their loan account type (RLN / ALN) like every other loan posting, otherwise the
                // Member Ledger's loan balance and the Loan Position panel would not see this journal. Pass
                // Transactions copies the staged acc_type onto the ledger row. Other heads keep 'JV'.
                const rowAccType = headCode === 'A1002' ? 'RLN' : headCode === 'A1047' ? 'ALN' : 'JV';

                await queryRunner.query(`
                    INSERT INTO transactions (
                        trans_no, trans_type, trans_date, mbno, acc_no, acc_type, trans_amt,
                        receipt_vchr_no, vchr_type, modeofpay, pass_flag, cashier_flag,
                        code, narration, username, cheq_no, cheq_amt
                    ) VALUES ($1, $2, NOW(), $3, $4, $5, $6, $7, 'JV', 'J', 'N', 'N', $8, $9, $10, $11, 0)
                `, [
                    currentTransNo++,
                    type,
                    row.mbno || null,
                    Number(row.rdSdSrNo || 0) || 0,
                    rowAccType,
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

    // No unique constraint exists on any of these id/trans_no columns (NOT NULL only), so a bare
    // MAX()+1 read lets two concurrent transactions silently compute and insert the same id. A
    // transaction-scoped advisory lock serializes callers without needing a new sequence object.
    private async getNextId(queryRunner: any, table: string, col: string): Promise<number> {
        await queryRunner.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [table]);
        const res = await queryRunner.query(`SELECT COALESCE(MAX(${col}), 0) + 1 as next_id FROM ${table}`);
        return parseInt(res[0].next_id);
    }
}
