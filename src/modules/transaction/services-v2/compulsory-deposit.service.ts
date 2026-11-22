import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { assertPostingDateOpen } from '../../shared/utils/posting-date';
import { lockLedgerIds, lockNextId } from '../../shared/utils/ledger-lock';
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
     * Get the income heads (headmaster, pflag 'I'; I1000 is the group head). ES-571: this read the `main` table,
     * which has no rows, so the Compulsory Deposit screen's head list was always empty.
     */
    async getIncomeHeads() {
        try {
            const query = `SELECT TRIM(code) AS code, TRIM(head_name) AS name FROM headmaster WHERE pflag = 'I' AND TRIM(code) <> 'I1000' ORDER BY head_name ASC`;
            return await this.dataSource.query(query);
        } catch (error) {
            this.logger.error('Error fetching income heads', error);
            throw error;
        }
    }

    /** Heads a CD charge can be credited to: income and liability heads other than the Compulsory Deposit head itself (RD/CD Transaction Legacy) */
    async getChargeHeads() {
        return this.dataSource.query(
            `SELECT TRIM(code) AS code, TRIM(head_name) AS name FROM headmaster WHERE pflag IN ('I', 'L') AND TRIM(code) <> '' AND TRIM(code) NOT LIKE '%000' AND TRIM(code) <> $1 ORDER BY TRIM(code) ASC`, [CD_HEAD_CODE],
        );
    }

    /**
     * Post Bulk CD Transaction
     */
    async postCDInterestAction(dto: PostCDTransactionDto, username: string = 'admin', mode: 'interest' | 'charge' = 'interest') {
        // interest: the head is debited and each member's Compulsory Deposit is credited.
        // charge (RD/CD Transaction Legacy): the opposite - each member's Compulsory Deposit is debited and the head is credited.
        const isCharge = mode === 'charge';
        const queryRunner = this.dataSource.createQueryRunner();
        await queryRunner.connect();
        await queryRunner.startTransaction();

        try {
            this.logger.log(`Starting bulk CD ${mode} posting: Head ${dto.incomeHeadCode}, Total ${dto.totalAmount}`);

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

            // ES-570: nothing was checked beyond the totals, so an unknown income head, a member that does not exist
            // or the same member twice was posted. All three are refused here, before anything is written.
            const headCode = String(dto.incomeHeadCode ?? '').trim().toUpperCase();
            const validHead = await queryRunner.query(
                isCharge
                    ? `SELECT 1 FROM headmaster WHERE UPPER(TRIM(code)) = $1 AND pflag IN ('I', 'L') AND UPPER(TRIM(code)) <> '${CD_HEAD_CODE}' AND TRIM(code) <> '' AND TRIM(code) NOT LIKE '%000' LIMIT 1`
                    : `SELECT 1 FROM headmaster WHERE UPPER(TRIM(code)) = $1 LIMIT 1`, [headCode],
            );
            if (!headCode || validHead.length === 0) {
                throw new BadRequestException(`Unknown income head code: ${dto.incomeHeadCode}`);
            }
            const postingRows = distributions.filter((d) => Number(d.postAmount) > 0);
            const memberNos = postingRows.map((d) => Number(d.memberNo));
            const repeated = memberNos.filter((m, i) => memberNos.indexOf(m) !== i);
            if (repeated.length > 0) {
                throw new BadRequestException(`Member ${[...new Set(repeated)].join(', ')} appears more than once in the list.`);
            }
            if (memberNos.length > 0) {
                const found = await queryRunner.query(`SELECT mbno FROM member_master WHERE mbno = ANY($1)`, [memberNos]);
                const foundSet = new Set(found.map((m: any) => Number(m.mbno)));
                const missing = memberNos.filter((m) => !foundSet.has(m));
                if (missing.length > 0) {
                    throw new BadRequestException(`Unknown member number(s): ${missing.join(', ')}`);
                }
                // A charge can not take more than the member holds: the balances are locked and checked before anything is written.
                if (isCharge) {
                    const held = await queryRunner.query(
                        `SELECT mbno::numeric AS mbno, COALESCE(compulsory_deposit, 0)::float AS bal FROM member_balances WHERE mbno::numeric = ANY($1::numeric[]) FOR UPDATE`, [memberNos],
                    );
                    const heldMap = new Map<number, number>(held.map((r: any) => [Number(r.mbno), Number(r.bal)]));
                    const short = postingRows.filter((d) => round2(Number(d.postAmount)) > round2(heldMap.get(Number(d.memberNo)) ?? 0));
                    if (short.length > 0) {
                        const sample = short.slice(0, 10).map((d) => `${d.memberNo} (has ${round2(heldMap.get(Number(d.memberNo)) ?? 0)}, charge ${d.postAmount})`).join(', ');
                        throw new BadRequestException(`The Compulsory Deposit of ${short.length} member(s) is less than the charge: ${sample}${short.length > 10 ? ', ...' : ''}`);
                    }
                }
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
                ) VALUES ($1, $2, NOW(), 'JOURNAL', $3, $4, 'POSTED', $5, NOW())
            `, [nextVchrId, voucherNo, dto.totalAmount, dto.narration || (isCharge ? 'Bulk Compulsory Deposit Charge' : 'Bulk Compulsory Deposit Interest Posting'), isCharge ? 'CD_CHARGE' : 'CD_POSTING']);

            // 3. Post DEBIT entry to Income Head
            const nextTransId = await this.getNextId(queryRunner, 'transactions', 'trans_no');
            await queryRunner.query(`
                INSERT INTO transactions (
                    trans_no, trans_type, trans_date, trans_amt, receipt_vchr_no, vchr_type,
                    modeofpay, pass_flag, cashier_flag, code, narration, username, cheq_amt
                ) VALUES ($1, $7, NOW(), $2, $3, 'CD', 'J', 'Y', 'Y', $4, $5, $6, 0)
            `, [nextTransId, dto.totalAmount, voucherNo, headCode.substring(0, 5), isCharge ? 'Bulk CD Charge (Credit Head)' : 'Bulk CD Post (Debit Head)', username, isCharge ? 'R' : 'P']);

            // Ledger ids and numbers for every row of this voucher, taken once under the shared ledger lock (ES-445)
            await lockNextId(queryRunner, 'ledger', 'ledgerid');
            let ledgerId = Number((await queryRunner.query(`SELECT COALESCE(MAX(ledgerid), 0) + 1 as next_id FROM ledger`))[0].next_id);
            let ledgerTransNo = Number((await queryRunner.query(`SELECT COALESCE(MAX(trans_no), 0) + 1 as next_id FROM ledger`))[0].next_id);
            const insertLedger = async (code: string, direction: 'DR' | 'CR', mbno: number, accType: string, amount: number, plBalance: number, text: string) => {
                await queryRunner.query(`
                    INSERT INTO ledger (
                        trans_no, trans_date, trans_type, code, mbno, acc_no, acc_type, trans_amt, receipt_vchr_no,
                        vchr_type, modeofpay, pl_balance, narration, username, ledgerid
                    ) VALUES ($1, NOW(), $2, $3, $4, 0, $5, $6, $7, 'CD', 'J', $8, $9, $10, $11)
                `, [ledgerTransNo++, direction, code, mbno, accType, amount, voucherNo, plBalance, text, username, ledgerId++]);
            };

            // 4. Post CREDIT entries per member and update balances
            let currentTransNo = nextTransId + 1;
            for (const dist of dto.distributions) {
                if (dist.postAmount <= 0) continue;

                // a. Individual transaction record
                await queryRunner.query(`
                    INSERT INTO transactions (
                        trans_no, trans_type, trans_date, mbno, trans_amt, receipt_vchr_no, 
                        vchr_type, modeofpay, pass_flag, cashier_flag, narration, username, cheq_amt
                    ) VALUES ($1, $7, NOW(), $2, $3, $4, 'CD', 'J', 'Y', 'Y', $5, $6, 0)
                `, [currentTransNo++, dist.memberNo, dist.postAmount, voucherNo, `${isCharge ? 'CD Charge' : 'CD Credit'}: ${dto.narration}`, username, isCharge ? 'P' : 'R']);

                // b. Update Member Balance. UPDATE ... RETURNING comes back as [rows, count]; a member with no balance row yet
                // gets one (before, the update silently matched nothing and the stored balance never grew).
                const balRaw = await queryRunner.query(`
                    UPDATE member_balances
                    SET compulsory_deposit = COALESCE(compulsory_deposit, 0) + $1
                    WHERE mbno::numeric = $2::numeric
                    RETURNING compulsory_deposit::float AS balance
                `, [isCharge ? -Number(dist.postAmount) : Number(dist.postAmount), dist.memberNo]);
                const balRows: any[] = Array.isArray(balRaw?.[0]) ? balRaw[0] : (balRaw || []);
                let newBalance: number;
                if (balRows.length === 0) {
                    await queryRunner.query(`INSERT INTO member_balances (mbno, compulsory_deposit) VALUES ($1, $2)`, [dist.memberNo, isCharge ? 0 : dist.postAmount]);
                    newBalance = isCharge ? 0 : round2(Number(dist.postAmount));
                } else {
                    newBalance = round2(Number(balRows[0].balance));
                }

                // c. Post to Ledger for Member Audit (ES-578: credit, account type CD, real balance after the credit)
                await insertLedger(CD_HEAD_CODE, isCharge ? 'DR' : 'CR', dist.memberNo, 'CD', Number(dist.postAmount), newBalance, `${isCharge ? 'CD Charge' : 'CD Post'}: ${dto.narration}`);
            }

            // d. ES-578: the matching DEBIT of the income head, so the general ledger balances (before, it was written to
            // `transactions` only). It is a head-only line, member 0, like the other journal head lines.
            await insertLedger(headCode, isCharge ? 'CR' : 'DR', 0, 'OTH', round2(headerTotal), 0, isCharge ? 'Bulk CD Charge (Credit Head)' : 'Bulk CD Post (Debit Head)');

            await queryRunner.commitTransaction();
            return { success: true, message: `Successfully posted CD ${isCharge ? 'charge' : 'interest'}. Voucher No: ${voucherNo}`, voucherNo };

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
