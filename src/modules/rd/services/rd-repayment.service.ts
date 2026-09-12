import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { toDateOnlyString } from '../rd-date-math';

export interface RdPendingInstallmentRow {
    installmentMonth: number;
    installmentYear: number;
    dueDate: string;
    expectedAmount: number;
    paidAmount: number;
    paidDate: string | null;
    status: 'PAID' | 'PARTIAL' | 'UNPAID';
}

/**
 * The RD counter window — the second of the two ways a member's monthly RD
 * gets recorded (the first is the Excel demand import, wired into
 * demand-import.service.ts). This is for whatever a member did NOT pay via
 * that import: a single-member, operator-driven action, same shape as the
 * existing Loan Repayment screen. Per the user's explicit instruction, the
 * amount recorded is exactly what the operator enters — no auto-calculation
 * or validation against the member's configured monthly amount.
 */
@Injectable()
export class RdRepaymentService {
    constructor(private readonly dataSource: DataSource) { }

    /** Every calendar month of the financial year, April first, with
     *  whatever payment status it currently has — including months with no
     *  ledger row at all yet (shown as UNPAID with the member's configured
     *  amount as the expected figure, so the operator has something to work
     *  against even before any payment or import has touched that month). */
    async getPendingInstallments(mbno: string, yearcode: number): Promise<RdPendingInstallmentRow[]> {
        const fyRows = await this.dataSource.query(`SELECT start_date, end_date FROM yearend WHERE yearcode = $1`, [yearcode]);
        if (!fyRows[0]) throw new NotFoundException(`Financial year ${yearcode} not found.`);
        const fyStart = new Date(fyRows[0].start_date);

        const existingRows = await this.dataSource.query(
            `SELECT installment_month, installment_year, due_date, expected_amount, paid_amount, paid_date
             FROM rd_installment_ledger WHERE mbno = $1 AND yearcode = $2`,
            [mbno, yearcode],
        );
        const existingByMonth = new Map<string, any>(
            existingRows.map((r: any) => [`${r.installment_month}-${r.installment_year}`, r]),
        );

        const configRows = await this.dataSource.query(
            `SELECT monthly_rd_amount, effective_from_date FROM rd_member_config
             WHERE mbno = $1 AND yearcode = $2 ORDER BY effective_from_date ASC, id ASC`,
            [mbno, yearcode],
        );

        const months: RdPendingInstallmentRow[] = [];
        for (let i = 0; i < 12; i++) {
            const calendarMonth = fyStart.getMonth() + 1 + i > 12 ? (fyStart.getMonth() + 1 + i - 12) : fyStart.getMonth() + 1 + i;
            const calendarYear = fyStart.getMonth() + 1 + i > 12 ? fyStart.getFullYear() + 1 : fyStart.getFullYear();
            const key = `${calendarMonth}-${calendarYear}`;
            const existing = existingByMonth.get(key);

            if (existing) {
                const paidAmount = Number(existing.paid_amount);
                const expectedAmount = Number(existing.expected_amount);
                months.push({
                    installmentMonth: calendarMonth,
                    installmentYear: calendarYear,
                    dueDate: existing.due_date,
                    expectedAmount,
                    paidAmount,
                    paidDate: existing.paid_date,
                    status: paidAmount >= expectedAmount ? 'PAID' : paidAmount > 0 ? 'PARTIAL' : 'UNPAID',
                });
            } else {
                const dueDate = new Date(calendarYear, calendarMonth - 1, 5);
                const applicable = [...configRows].reverse().find((c: any) => new Date(c.effective_from_date) <= dueDate);
                months.push({
                    installmentMonth: calendarMonth,
                    installmentYear: calendarYear,
                    dueDate: toDateOnlyString(dueDate),
                    expectedAmount: applicable ? Number(applicable.monthly_rd_amount) : 0,
                    paidAmount: 0,
                    paidDate: null,
                    status: 'UNPAID',
                });
            }
        }
        return months;
    }

    /** Records exactly what the operator enters for one specific month —
     *  never auto-calculated or reconciled against the configured amount.
     *  is_arrear_clearance is set purely from the calendar relationship
     *  between the installment's own month and the date it's actually being
     *  paid on (later = arrears clearance, same month = on time). */
    async recordPayment(
        mbno: string,
        yearcode: number,
        installmentMonth: number,
        installmentYear: number,
        amount: number,
        paidDate: Date,
        narration: string | undefined,
        recordedBy: string,
    ): Promise<RdPendingInstallmentRow> {
        if (amount <= 0) throw new BadRequestException('Payment amount must be greater than zero.');

        const closedRows = await this.dataSource.query(
            `SELECT closed_at FROM rd_financial_year_summary WHERE mbno = $1 AND yearcode = $2`,
            [mbno, yearcode],
        );
        if (closedRows[0]?.closed_at) {
            throw new BadRequestException(`RD financial year ${yearcode} is already closed for member ${mbno} — cannot record a payment against it.`);
        }

        const member = await this.dataSource.query(`SELECT mbno FROM member_master WHERE CAST(mbno AS text) = $1`, [mbno]);
        if (member.length === 0) throw new NotFoundException(`Member ${mbno} not found.`);

        const dueDate = new Date(installmentYear, installmentMonth - 1, 5);
        const isArrearClearance = paidDate.getFullYear() > installmentYear
            || (paidDate.getFullYear() === installmentYear && paidDate.getMonth() + 1 > installmentMonth);

        const configRows = await this.dataSource.query(
            `SELECT monthly_rd_amount FROM rd_member_config
             WHERE mbno = $1 AND yearcode = $2 AND effective_from_date <= $3
             ORDER BY effective_from_date DESC, id DESC LIMIT 1`,
            [mbno, yearcode, toDateOnlyString(dueDate)],
        );
        const expectedAmount = configRows[0] ? Number(configRows[0].monthly_rd_amount) : amount;

        // rd_installment_ledger has no dedicated "recorded by" column — folded
        // into narration instead, same as this codebase's other tables that
        // lack an audit-identity column of their own.
        const fullNarration = `${narration || 'Collected at counter'} (by ${recordedBy})`;

        const dueDateStr = toDateOnlyString(dueDate);
        const paidDateStr = toDateOnlyString(paidDate);
        await this.dataSource.query(
            `INSERT INTO rd_installment_ledger
                (mbno, yearcode, installment_month, installment_year, due_date, expected_amount, paid_amount, paid_date, is_arrear_clearance, narration)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
             ON CONFLICT (mbno, yearcode, installment_month, installment_year) DO UPDATE SET
                paid_amount = EXCLUDED.paid_amount,
                paid_date = EXCLUDED.paid_date,
                is_arrear_clearance = EXCLUDED.is_arrear_clearance,
                narration = EXCLUDED.narration`,
            [mbno, yearcode, installmentMonth, installmentYear, dueDateStr, expectedAmount, amount, paidDateStr, isArrearClearance, fullNarration],
        );

        return {
            installmentMonth, installmentYear, dueDate: dueDateStr,
            expectedAmount, paidAmount: amount, paidDate: paidDateStr,
            status: amount >= expectedAmount ? 'PAID' : 'PARTIAL',
        };
    }
}
