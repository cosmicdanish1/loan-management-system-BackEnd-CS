import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { assertPostingDateOpen } from '../../shared/utils/posting-date';
import { lockLedgerIds } from '../../shared/utils/ledger-lock';
import { SequenceGeneratorService } from '../../shared/services';
import { DataSource } from 'typeorm';
import { PostCDTransactionDto } from '../dto/compulsory-deposit.dto';

/** The member's Compulsory Deposit head; the audit ledger row of each member credit is written on it (ES-420) */
const CD_HEAD_CODE = 'L1004';

@Injectable()
export class CompulsoryDepositService {
    private readonly logger = new Logger(CompulsoryDepositService.name);

    constructor(
        private readonly dataSource: DataSource,
        private readonly sequenceGenerator: SequenceGeneratorService,
    ) { }

    /**
     * Get list of members with active CD accounts or balances
     */
    async getCDAccountList() {
        try {
            const query = `
                SELECT 
                    m.mbno as "memberNo",
                    REGEXP_REPLACE(TRIM(COALESCE(m.f_name, '') || ' ' || COALESCE(m.m_name, '') || ' ' || COALESCE(m.l_name, '')), '\\s+', ' ', 'g') as "memberName",
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
     * Get Income/GL Heads from 'main' table
     */
    async getIncomeHeads() {
        try {
            const query = `SELECT maincode as code, mainname as name FROM main ORDER BY mainname ASC`;
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
        const queryRunner = this.dataSource.createQueryRunner();
        await queryRunner.connect();
        await queryRunner.startTransaction();

        try {
            this.logger.log(`Starting bulk CD posting: Head ${dto.incomeHeadCode}, Total ${dto.totalAmount}`);

            // ES-420: the header total is the debit of the income head and the member lines are the credits, so they
            // must be equal. Before, a header of 100 over member lines of 50 was posted as it was.
            const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
            const distributions = Array.isArray(dto.distributions) ? dto.distributions : [];
            if (distributions.some((d) => !Number.isFinite(Number(d.postAmount)) || Number(d.postAmount) < 0)) {
                throw new BadRequestException('Every member amount must be a number of 0 or more.');
            }
            const headerTotal = Number(dto.totalAmount);
            const linesTotal = round2(distributions.reduce((sum, d) => sum + (Number(d.postAmount) > 0 ? Number(d.postAmount) : 0), 0));
            if (!Number.isFinite(headerTotal) || headerTotal <= 0 || round2(headerTotal) !== linesTotal) {
                throw new BadRequestException(`The total ${dto.totalAmount} must equal the sum of the member amounts (${linesTotal}).`);
            }

            // 1. Generate Voucher Number.
            // ES-461: this used MAX(CAST("voucherNumber" AS INTEGER)), which fails on every VCH### number ("invalid input
            // syntax for type integer: VCH061"), so bulk CD posting never worked. The shared generator is used instead,
            // the same one every other voucher uses (it also skips numbers that already exist).
            await assertPostingDateOpen(queryRunner, new Date()); // ES-458
            const voucherNo = await this.sequenceGenerator.getNextVoucherNumber();

            // 2. Create Voucher Header
            const nextVchrId = await this.getNextId(queryRunner, 'vouchers', 'id');
            await queryRunner.query(`
                INSERT INTO vouchers (
                    id, "voucherNumber", "voucherDate", "voucherType", "totalAmount", 
                    description, status, "remarks", "createdAt"
                ) VALUES ($1, $2, NOW(), 'JOURNAL', $3, $4, 'POSTED', 'CD_POSTING', NOW())
            `, [nextVchrId, voucherNo, dto.totalAmount, dto.narration || 'Bulk Compulsory Deposit Interest Posting']);

            // 3. Post DEBIT entry to Income Head
            const nextTransId = await this.getNextId(queryRunner, 'transactions', 'trans_no');
            await queryRunner.query(`
                INSERT INTO transactions (
                    trans_no, trans_type, trans_date, trans_amt, receipt_vchr_no, vchr_type,
                    modeofpay, pass_flag, cashier_flag, code, narration, username, cheq_amt
                ) VALUES ($1, 'P', NOW(), $2, $3, 'CD', 'J', 'Y', 'Y', $4, $5, $6, 0)
            `, [nextTransId, dto.totalAmount, voucherNo, dto.incomeHeadCode.substring(0, 5), 'Bulk CD Post (Debit Head)', username]);

            // 4. Post CREDIT entries per member and update balances
            let currentTransNo = nextTransId + 1;
            for (const dist of dto.distributions) {
                if (dist.postAmount <= 0) continue;

                // a. Individual transaction record
                await queryRunner.query(`
                    INSERT INTO transactions (
                        trans_no, trans_type, trans_date, mbno, trans_amt, receipt_vchr_no, 
                        vchr_type, modeofpay, pass_flag, cashier_flag, narration, username, cheq_amt
                    ) VALUES ($1, 'R', NOW(), $2, $3, $4, 'CD', 'J', 'Y', 'Y', $5, $6, 0)
                `, [currentTransNo++, dist.memberNo, dist.postAmount, voucherNo, `CD Credit: ${dto.narration}`, username]);

                // b. Update Member Balance
                await queryRunner.query(`
                    UPDATE member_balances 
                    SET compulsory_deposit = COALESCE(compulsory_deposit, 0) + $1 
                    WHERE mbno = $2
                `, [dist.postAmount, dist.memberNo]);

                // c. Post to Ledger for Member Audit
                const ledgerId = await this.getNextId(queryRunner, 'ledger', 'ledgerid');
                await queryRunner.query(`
                    INSERT INTO ledger (
                        trans_date, trans_type, code, mbno, trans_amt, receipt_vchr_no, 
                        vchr_type, pl_balance, narration, username, ledgerid
                    ) VALUES (NOW(), 'R', $8, $1, $2, $3, 'CD', $4, $5, $6, $7)
                `, [dist.memberNo, dist.postAmount, voucherNo, dist.currentBalance + dist.postAmount, `CD Post: ${dto.narration}`, username, ledgerId, CD_HEAD_CODE]);
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

    private async getNextId(queryRunner: any, table: string, col: string): Promise<number> {
        // ES-420: lock (held until commit) before reading MAX, with the same key the other posting services use for
        // this table, so two postings at the same moment can not both get the same id.
        await queryRunner.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`${table}.${col}`]);
        if (table === 'ledger') await lockLedgerIds(queryRunner); // ES-445: the one shared ledger id lock
        const res = await queryRunner.query(`SELECT COALESCE(MAX(${col}), 0) + 1 as next_id FROM ${table}`);
        return parseInt(res[0].next_id);
    }
}
