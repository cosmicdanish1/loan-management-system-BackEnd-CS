import { Injectable, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { SequenceGeneratorService } from '../../shared/services/sequence-generator.service';
import { isDebitNormal } from '../../shared/utils/balance-direction';

const SHARE_HEAD_CODE = 'L1001';       // SHARE VALUE
const DIVIDEND_PAYABLE_HEAD_CODE = 'L1024'; // DIVIDEND PAID

export interface DividendCreditPreviewRow {
    mbno: string;
    memberName: string;
    dividendAmount: number;
    currentShareValue: number;
    newShareValue: number;
}

export interface DividendCreditResult {
    mbno: string;
    calculationYear: number;
    dividendAmount: number;
    newShareValue: number;
}

/**
 * Dividend CREDIT — the second, deliberately separate half of the dividend
 * feature (see DividendCalculationService's own docstring). This is what
 * actually applies "New Share Value = Existing Share Value + Previous
 * Financial Year's Dividend": at financial year N+1's close, it credits the
 * dividend that was CALCULATED for financial year N (via
 * DividendCalculationService, run back when year N itself closed) — never
 * the current year's own not-yet-finished calculation, which is exactly the
 * Calculation-Year vs Credit-Year separation the user's spec requires.
 *
 * Posts a real ledger entry per member (DR Dividend Paid / CR Share Value —
 * both credit-normal Liability heads, so this is a pure reallocation out of
 * a general dividend-payable pool into one member's own Share account, not
 * new money) rather than a bare balance bump, matching how every other
 * real-money credit in this codebase (e.g. Compulsory Deposit at member
 * creation) is posted through the actual ledger, not just a column update.
 */
@Injectable()
export class DividendCreditService {
    constructor(
        private readonly dataSource: DataSource,
        private readonly sequenceGenerator: SequenceGeneratorService,
    ) {}

    /** The financial year immediately before `yearcode`, found by start_date
     *  ordering — the mirror image of RD financial-year-closing's own
     *  "next year" lookup. Returns null when there is none (yearcode is the
     *  very first financial year in the system — nothing to credit yet). */
    async getPreviousYearcode(yearcode: number): Promise<{ yearcode: number; calculationYear: number } | null> {
        const currentRows = await this.dataSource.query(`SELECT start_date FROM yearend WHERE yearcode = $1`, [yearcode]);
        if (!currentRows[0]) throw new NotFoundException(`Financial year ${yearcode} not found.`);

        const prevRows = await this.dataSource.query(
            `SELECT yearcode, start_date FROM yearend WHERE start_date < $1 ORDER BY start_date DESC LIMIT 1`,
            [currentRows[0].start_date],
        );
        if (!prevRows[0]) return null;
        return { yearcode: Number(prevRows[0].yearcode), calculationYear: new Date(prevRows[0].start_date).getFullYear() };
    }

    /** Read-only preview of what crediting `yearcode`'s close would apply —
     *  every dividend_master row for the previous financial year's
     *  calculation year that hasn't been credited yet. Writes nothing. */
    async previewCreditForYear(yearcode: number): Promise<{
        creditYearcode: number;
        previousCalculationYear: number | null;
        members: DividendCreditPreviewRow[];
    }> {
        const previous = await this.getPreviousYearcode(yearcode);
        if (!previous) return { creditYearcode: yearcode, previousCalculationYear: null, members: [] };

        const rows = await this.dataSource.query(
            `SELECT dm.mbno, CONCAT(m.f_name, ' ', m.l_name) as member_name, dm.dividend_amount,
                    COALESCE(mb.shares, 0) as current_share_value
             FROM dividend_master dm
             LEFT JOIN member_master m ON m.mbno::text = dm.mbno
             LEFT JOIN member_balances mb ON mb.mbno = dm.mbno::numeric
             WHERE dm.year = $1 AND dm.credited_at IS NULL AND dm.mbno ~ '^[0-9]+$'
                   AND (dm.is_paid IS NULL OR dm.is_paid != 'Y')
             ORDER BY dm.mbno`,
            [previous.calculationYear],
        );

        const members: DividendCreditPreviewRow[] = rows.map((r: any) => {
            const dividendAmount = Number(r.dividend_amount);
            const currentShareValue = Number(r.current_share_value);
            return {
                mbno: String(r.mbno),
                memberName: (r.member_name || '').trim(),
                dividendAmount,
                currentShareValue,
                newShareValue: Math.round((currentShareValue + dividendAmount) * 100) / 100,
            };
        });

        return { creditYearcode: yearcode, previousCalculationYear: previous.calculationYear, members };
    }

    /** Credits one member's already-calculated prior-year dividend into
     *  their Share Value. Idempotent: re-running after a row is already
     *  credited (credited_at set) finds nothing to do and returns null,
     *  rather than crediting twice. Returns null too when there's no prior
     *  financial year, or no uncredited dividend row exists for this
     *  member. */
    async creditMemberDividend(mbno: string, creditYearcode: number, creditedBy: string): Promise<DividendCreditResult | null> {
        const previous = await this.getPreviousYearcode(creditYearcode);
        if (!previous) return null;

        const queryRunner = this.dataSource.createQueryRunner();
        await queryRunner.connect();
        await queryRunner.startTransaction();
        try {
            // FOR UPDATE locks this row for the duration of the transaction —
            // processDividendPayment's own UPDATE on the same row (a
            // completely separate code path, in utilities.service.ts) will
            // block until this transaction commits or rolls back, so the two
            // can never race each other into crediting AND cash-paying the
            // same dividend.
            const rows = await queryRunner.query(
                `SELECT id, dividend_amount FROM dividend_master
                 WHERE mbno = $1 AND year = $2 AND credited_at IS NULL
                       AND (is_paid IS NULL OR is_paid != 'Y') FOR UPDATE`,
                [mbno, previous.calculationYear],
            );
            if (rows.length === 0) {
                await queryRunner.rollbackTransaction();
                return null;
            }
            const dividendAmount = Math.round(Number(rows[0].dividend_amount) * 100) / 100;

            if (dividendAmount > 0) {
                const shareHeadRows = await queryRunner.query(`SELECT pflag FROM headmaster WHERE code = $1`, [SHARE_HEAD_CODE]);
                // L1001 is credit-normal (Liability) -> its own increase direction is 'CR'.
                const shareIncreaseDirection = isDebitNormal(shareHeadRows[0]?.pflag) ? 'DR' : 'CR';
                // The general dividend-payable pool is being drawn DOWN as it's
                // allocated to this member -> the opposite of its own increase direction.
                const payableDecreaseDirection = shareIncreaseDirection === 'CR' ? 'DR' : 'CR';

                const voucherNo = await this.sequenceGenerator.getNextVoucherNumber();
                const nextVchrId = await this.sequenceGenerator.getNextVoucherId();
                await queryRunner.query(
                    `INSERT INTO vouchers (id, "voucherNumber", "voucherDate", "voucherType", "totalAmount", description, status, remarks, "createdAt")
                     VALUES ($1, $2, NOW(), 'JOURNAL', $3, $4, 'POSTED', 'DIVIDEND_CREDIT', NOW())`,
                    [nextVchrId, voucherNo, dividendAmount, `Dividend Credit - FY ${previous.calculationYear} dividend, member ${mbno}`],
                );

                let nextLedgerId = (await queryRunner.query(`SELECT COALESCE(MAX(ledgerid), 0) + 1 as next_id FROM ledger`))[0].next_id;
                await queryRunner.query(
                    `INSERT INTO ledger (trans_date, trans_type, code, mbno, trans_amt, receipt_vchr_no, vchr_type, pl_balance, narration, username, ledgerid)
                     VALUES (NOW(), $1, $2, $3, $4, $5, 'JV', $4, $6, $7, $8)`,
                    [payableDecreaseDirection, DIVIDEND_PAYABLE_HEAD_CODE, mbno, dividendAmount, voucherNo,
                        `Dividend Credit - FY ${previous.calculationYear}`, creditedBy, nextLedgerId],
                );
                nextLedgerId = Number(nextLedgerId) + 1;
                await queryRunner.query(
                    `INSERT INTO ledger (trans_date, trans_type, code, mbno, trans_amt, receipt_vchr_no, vchr_type, pl_balance, narration, username, ledgerid)
                     VALUES (NOW(), $1, $2, $3, $4, $5, 'JV', $4, $6, $7, $8)`,
                    [shareIncreaseDirection, SHARE_HEAD_CODE, mbno, dividendAmount, voucherNo,
                        `Dividend Credit - FY ${previous.calculationYear}`, creditedBy, nextLedgerId],
                );

                await queryRunner.query(
                    `UPDATE member_balances SET shares = COALESCE(shares, 0) + $1 WHERE mbno = $2`,
                    [dividendAmount, mbno],
                );
            }

            const creditYearRow = await queryRunner.query(`SELECT start_date FROM yearend WHERE yearcode = $1`, [creditYearcode]);
            const creditedYear = new Date(creditYearRow[0].start_date).getFullYear();
            await queryRunner.query(
                `UPDATE dividend_master SET credited_at = NOW(), credited_year = $1, credited_by = $2 WHERE id = $3`,
                [creditedYear, creditedBy, rows[0].id],
            );

            const newShareRow = await queryRunner.query(`SELECT shares FROM member_balances WHERE mbno = $1`, [mbno]);
            await queryRunner.commitTransaction();

            return {
                mbno,
                calculationYear: previous.calculationYear,
                dividendAmount,
                newShareValue: Number(newShareRow[0]?.shares || 0),
            };
        } catch (error) {
            await queryRunner.rollbackTransaction();
            throw error;
        } finally {
            await queryRunner.release();
        }
    }

    /** Batch version — credits every member with an eligible uncredited
     *  prior-year dividend. One member's failure never aborts the batch,
     *  same resilience pattern as RD's closeFinancialYear: each member is
     *  its own transaction via creditMemberDividend. */
    async creditAllForYear(creditYearcode: number, creditedBy: string): Promise<{
        creditYearcode: number;
        credited: DividendCreditResult[];
        failed: Array<{ mbno: string; error: string }>;
    }> {
        const preview = await this.previewCreditForYear(creditYearcode);
        const credited: DividendCreditResult[] = [];
        const failed: Array<{ mbno: string; error: string }> = [];
        for (const member of preview.members) {
            try {
                const result = await this.creditMemberDividend(member.mbno, creditYearcode, creditedBy);
                if (result) credited.push(result);
            } catch (error: any) {
                failed.push({ mbno: member.mbno, error: error.message || 'Unknown error' });
            }
        }
        return { creditYearcode, credited, failed };
    }
}
