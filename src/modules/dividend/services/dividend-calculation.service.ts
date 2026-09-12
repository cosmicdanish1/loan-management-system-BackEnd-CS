import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { DataSource } from 'typeorm';

export interface FinancialYearMonth {
    month: number;
    year: number;
}

export interface MemberDividendPreview {
    mbno: string;
    memberName: string;
    totalProduct: number;
    monthsFound: number;
    monthsExpected: number;
    dividendRate: number;
    dividendAmount: number;
}

/**
 * Dividend calculation — the "Total Product × Approved Dividend Rate ÷ 1200"
 * formula, using share_monthly_balance's monthly snapshots as Total Product
 * (the sum of a member's closing Share Capital balance at each month-end for
 * the financial year). This is the CALCULATION step only: it writes a
 * dividend_master row for the year the dividend was EARNED, but never
 * touches member_balances.shares — crediting a prior year's calculated
 * dividend into Share Value is a deliberately separate step (per the user's
 * spec: Dividend Calculation Year and Dividend Credit Year must stay
 * distinct), not built yet.
 *
 * A month with no snapshot row is simply not counted — same limitation as
 * the RD payment-pattern engine's own "no row = invisible" gap. monthsFound
 * vs monthsExpected in the preview is exactly so an operator can see when a
 * member's Total Product is understated because a month was never captured,
 * rather than trusting a silently-incomplete total.
 */
@Injectable()
export class DividendCalculationService {
    constructor(private readonly dataSource: DataSource) {}

    /** Every (month, year) pair in a financial year, derived from the actual
     *  yearend row rather than assuming April-March — so this still works
     *  correctly if the financial year boundary is ever configured
     *  differently. */
    async getFinancialYearMonths(yearcode: number): Promise<FinancialYearMonth[]> {
        const rows = await this.dataSource.query(
            `SELECT start_date, end_date FROM yearend WHERE yearcode = $1`,
            [yearcode],
        );
        if (!rows[0]) throw new NotFoundException(`Financial year ${yearcode} not found.`);

        const start = new Date(rows[0].start_date);
        const end = new Date(rows[0].end_date);
        const months: FinancialYearMonth[] = [];
        const cursor = new Date(start.getFullYear(), start.getMonth(), 1);
        const endMonth = new Date(end.getFullYear(), end.getMonth(), 1);
        while (cursor <= endMonth) {
            months.push({ month: cursor.getMonth() + 1, year: cursor.getFullYear() });
            cursor.setMonth(cursor.getMonth() + 1);
        }
        return months;
    }

    /** Read-only preview of what committing this year's dividend calculation
     *  would produce, for every member with at least one Share snapshot in
     *  the financial year — safe to call repeatedly, writes nothing. */
    async previewDividendForYear(yearcode: number, dividendRatePercent: number): Promise<{
        yearcode: number;
        calculationYear: number;
        dividendRatePercent: number;
        monthsExpected: number;
        members: MemberDividendPreview[];
    }> {
        if (dividendRatePercent <= 0) throw new BadRequestException('Dividend rate must be greater than zero.');

        const months = await this.getFinancialYearMonths(yearcode);
        const startRow = await this.dataSource.query(`SELECT start_date FROM yearend WHERE yearcode = $1`, [yearcode]);
        const calculationYear = new Date(startRow[0].start_date).getFullYear();

        const conditions = months.map((_, i) => `(snapshot_month = $${i * 2 + 1} AND snapshot_year = $${i * 2 + 2})`).join(' OR ');
        const params = months.flatMap((m) => [m.month, m.year]);

        const rows = await this.dataSource.query(
            `SELECT
                smb.mbno,
                CONCAT(m.f_name, ' ', m.l_name) as member_name,
                COUNT(*) as months_found,
                SUM(smb.share_balance) as total_product
             FROM share_monthly_balance smb
             LEFT JOIN member_master m ON m.mbno::text = smb.mbno::text
             WHERE (${conditions}) AND smb.mbno::text ~ '^[0-9]+$'
             GROUP BY smb.mbno, m.f_name, m.l_name
             ORDER BY smb.mbno`,
            params,
        );

        const members: MemberDividendPreview[] = rows.map((r: any) => {
            const totalProduct = Math.round(Number(r.total_product) * 100) / 100;
            const dividendAmount = Math.round((totalProduct * dividendRatePercent / 1200) * 100) / 100;
            return {
                mbno: String(r.mbno),
                memberName: (r.member_name || '').trim(),
                totalProduct,
                monthsFound: Number(r.months_found),
                monthsExpected: months.length,
                dividendRate: dividendRatePercent,
                dividendAmount,
            };
        });

        return { yearcode, calculationYear, dividendRatePercent, monthsExpected: months.length, members };
    }

    /** Commits the calculation into dividend_master, one row per member, for
     *  the financial year's calculation year — resumable/idempotent via
     *  ON CONFLICT DO UPDATE (re-running after fixing a missing snapshot
     *  recalculates cleanly rather than creating a duplicate row). Does NOT
     *  set is_paid and does NOT touch member_balances.shares — this is only
     *  "the dividend for this year has now been calculated and recorded",
     *  never a credit or a cash payout. */
    async commitDividendForYear(
        yearcode: number,
        dividendRatePercent: number,
    ): Promise<{ success: boolean; calculationYear: number; membersCommitted: number }> {
        const preview = await this.previewDividendForYear(yearcode, dividendRatePercent);

        const queryRunner = this.dataSource.createQueryRunner();
        await queryRunner.connect();
        await queryRunner.startTransaction();
        try {
            for (const member of preview.members) {
                await queryRunner.query(
                    `INSERT INTO dividend_master (mbno, year, share_amount, dividend_rate, dividend_amount, is_paid, created_at)
                     VALUES ($1, $2, $3, $4, $5, NULL, NOW())
                     ON CONFLICT (mbno, year) DO UPDATE
                         SET share_amount = EXCLUDED.share_amount,
                             dividend_rate = EXCLUDED.dividend_rate,
                             dividend_amount = EXCLUDED.dividend_amount
                     WHERE dividend_master.is_paid IS NULL OR dividend_master.is_paid != 'Y'`,
                    [member.mbno, preview.calculationYear, member.totalProduct, dividendRatePercent, member.dividendAmount],
                );
            }
            await queryRunner.commitTransaction();
            return { success: true, calculationYear: preview.calculationYear, membersCommitted: preview.members.length };
        } catch (error) {
            await queryRunner.rollbackTransaction();
            throw error;
        } finally {
            await queryRunner.release();
        }
    }
}
