import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { PostCDTransactionDto } from '../dto/compulsory-deposit.dto';
import { generateVoucherNo } from '../../shared/utils/voucher-utils';

@Injectable()
export class CompulsoryDepositService {
    private readonly logger = new Logger(CompulsoryDepositService.name);

    constructor(private readonly dataSource: DataSource) { }

    /**
     * Get list of members with active CD accounts or balances
     */
    async getCDAccountList() {
        try {
            const query = `
                SELECT 
                    m.mbno as "memberNo",
                    TRIM(COALESCE(m.f_name, '') || ' ' || COALESCE(m.m_name, '') || ' ' || COALESCE(m.l_name, '')) as "memberName",
                    COALESCE(mb.compulsory_deposit, 0) as "currentBalance"
                FROM member_master m
                LEFT JOIN member_balances mb ON m.mbno = mb.mbno
                WHERE m.isactive = 'Y'
                ORDER BY m.mbno ASC
            `;
            return await this.dataSource.query(query);
        } catch (error) {
            this.logger.error('Error fetching CD account list', error);
            throw error;
        }
    }

    /**
     * Get Income/GL Heads.
     * BUG FIX: this read from a `main` table — confirmed live it has 0 rows, so the
     * Income Head dropdown was always empty, and since it's required before posting,
     * the entire screen could never actually be used. Real GL heads (including
     * income-type ones, pflag='I') live in `headmaster`, the same table every other
     * head-driven screen this session already uses. Excludes I1000, the section root.
     */
    async getIncomeHeads() {
        try {
            const query = `SELECT code, head_name as name FROM headmaster WHERE pflag = 'I' AND code != 'I1000' ORDER BY head_name ASC`;
            return await this.dataSource.query(query);
        } catch (error) {
            this.logger.error('Error fetching income heads', error);
            throw error;
        }
    }

    /**
     * Post Bulk CD Transaction
     */
    async postCDInterestAction(dto: PostCDTransactionDto, username: string = 'admin') {
        // BUG FIX: nothing checked that totalAmount (the single debit) actually
        // equals the sum of the per-member credits — the trusted frontend always
        // computes totalAmount as that same sum, but a direct API call with a
        // mismatched value would post an unbalanced journal entry with no error.
        // Journal Transfer Entry already validates this server-side; this endpoint
        // didn't.
        const distributionSum = dto.distributions.reduce((sum, d) => sum + Number(d.postAmount || 0), 0);
        if (Math.abs(distributionSum - Number(dto.totalAmount)) > 0.01) {
            throw new BadRequestException(
                `Unbalanced: totalAmount (${dto.totalAmount}) does not match the sum of distributions (${distributionSum})`,
            );
        }

        const queryRunner = this.dataSource.createQueryRunner();
        await queryRunner.connect();
        await queryRunner.startTransaction();

        try {
            this.logger.log(`Starting bulk CD posting: Head ${dto.incomeHeadCode}, Total ${dto.totalAmount}`);

            // 1. Canonical Journal voucher number from voucher_master (J). CD interest is
            // posted as a journal entry (vchr_type 'J'). This also removes the previous
            // MAX(CAST(voucherNumber AS INTEGER)) read, which would break now that other
            // voucher types write prefixed strings (e.g. J00002) into the shared vouchers table.
            const voucherNo = await generateVoucherNo(queryRunner, 'J');

            // 2. Create Voucher Header
            const nextVchrId = await this.getNextId(queryRunner, 'vouchers', 'id');
            await queryRunner.query(`
                INSERT INTO vouchers (
                    id, "voucherNumber", "voucherDate", "voucherType", "totalAmount", 
                    description, status, "remarks", "createdAt"
                ) VALUES ($1, $2, NOW(), 'JOURNAL', $3, $4, 'POSTED', 'CD_POSTING', NOW())
            `, [nextVchrId, voucherNo, dto.totalAmount, dto.narration || 'Bulk Compulsory Deposit Interest Posting']);

            // 3. Post DEBIT entry to Income Head
            // BUG FIX: this omitted cheq_amt entirely — NOT NULL with no default
            // (confirmed via information_schema) — so every single call crashed with
            // a not-null-constraint violation. Confirmed live before fixing. Matches
            // the same cheq_amt=0 convention journal-transfer.service.ts already uses.
            const nextTransId = await this.getNextId(queryRunner, 'transactions', 'trans_no');
            await queryRunner.query(`
                INSERT INTO transactions (
                    trans_no, trans_type, trans_date, trans_amt, receipt_vchr_no, vchr_type,
                    modeofpay, pass_flag, cashier_flag, code, narration, username, cheq_amt
                ) VALUES ($1, 'DR', NOW(), $2, $3, 'CD', 'J', 'Y', 'Y', $4, $5, $6, 0)
            `, [nextTransId, dto.totalAmount, voucherNo, dto.incomeHeadCode.substring(0, 5), 'Bulk CD Post (Debit Head)', username]);

            // 4. Post CREDIT entries per member and update balances
            let currentTransNo = nextTransId + 1;
            for (const dist of dto.distributions) {
                if (dist.postAmount <= 0) continue;

                // a. Individual transaction record — same cheq_amt NOT NULL gap as the debit leg above.
                await queryRunner.query(`
                    INSERT INTO transactions (
                        trans_no, trans_type, trans_date, mbno, trans_amt, receipt_vchr_no,
                        vchr_type, modeofpay, pass_flag, cashier_flag, narration, username, cheq_amt
                    ) VALUES ($1, 'CR', NOW(), $2, $3, $4, 'CD', 'J', 'Y', 'Y', $5, $6, 0)
                `, [currentTransNo++, dist.memberNo, dist.postAmount, voucherNo, `CD Credit: ${dto.narration}`, username]);

                // b. Update Member Balance
                await queryRunner.query(`
                    UPDATE member_balances 
                    SET compulsory_deposit = COALESCE(compulsory_deposit, 0) + $1 
                    WHERE mbno = $2
                `, [dist.postAmount, dist.memberNo]);

                // c. Post to Ledger for Member Audit
                // BUG FIX 41: this insert omitted code, trans_no, acc_no, and acc_type entirely —
                // all four are nullable with no default (confirmed via information_schema), so
                // every CD interest credit landed in the ledger with a NULL GL head and no
                // transaction number. Untraceable in any GL report or reconciliation. `code`
                // is L1004 — the real "COMPULSORY DEPOSIT" head, an exact name match, not a
                // guess like the still-missing A001/A003 heads elsewhere.
                const ledgerId = await this.getNextId(queryRunner, 'ledger', 'ledgerid');
                const ledgerTransNo = await this.getNextId(queryRunner, 'ledger', 'trans_no');
                await queryRunner.query(`
                    INSERT INTO ledger (
                        trans_no, trans_date, trans_type, code, mbno, acc_no, acc_type, trans_amt,
                        receipt_vchr_no, vchr_type, pl_balance, narration, username, ledgerid
                    ) VALUES ($1, NOW(), 'CR', 'L1004', $2, 0, 'CD', $3, $4, 'J', $5, $6, $7, $8)
                `, [ledgerTransNo, dist.memberNo, dist.postAmount, voucherNo, dist.currentBalance + dist.postAmount, `CD Post: ${dto.narration}`, username, ledgerId]);
            }

            await queryRunner.commitTransaction();
            return { success: true, message: `Successfully posted CD interest. Voucher No: ${voucherNo}`, voucherNo };

        } catch (error) {
            await queryRunner.rollbackTransaction();
            this.logger.error('CD Post Failed', error);
            throw error;
        } finally {
            await queryRunner.release();
        }
    }

    // BUG FIX 35 (same as voucher.service.ts): no unique constraint exists on any of these
    // id/trans_no columns (confirmed via pg_constraint — NOT NULL only), so a bare MAX()+1 read
    // lets two concurrent transactions silently compute and insert the same id. A transaction-
    // scoped advisory lock serializes callers without needing a new sequence object.
    private async getNextId(queryRunner: any, table: string, col: string): Promise<number> {
        await queryRunner.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [table]);
        const res = await queryRunner.query(`SELECT COALESCE(MAX(${col}), 0) + 1 as next_id FROM ${table}`);
        return parseInt(res[0].next_id);
    }
}
