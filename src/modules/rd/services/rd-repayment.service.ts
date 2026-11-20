import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { toDateOnlyString } from '../rd-date-math';
import { SequenceGeneratorService } from '../../shared/services';
import { postRdCdReceipt, RD_CD_HEAD } from '../rd-cd-receipt';
import { assertPostingDateOpen } from '../../shared/utils/posting-date';

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

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
 *
 * ES-353 (QA finding, overrides the line above): the amount is still what the operator enters, but it must be a real
 * number, not absurd, and not more than 10 times the configured instalment (70,000 on a 700 instalment was accepted).
 */
@Injectable()
export class RdRepaymentService {
    constructor(
        private readonly dataSource: DataSource,
        private readonly sequenceGenerator: SequenceGeneratorService,
    ) { }

    /**
     * Everything the RD/CD Repayment screen shows about a member apart from the 12 months: the one real balance
     * (member_balances.compulsory_deposit), the monthly amount, what was paid this year, what is locked by a Loan
     * Against RD, and the latest credits on the RD/CD head.
     */
    async getSummary(mbno: string, yearcode: number) {
        const bal = await this.dataSource.query(
            `SELECT compulsory_deposit::float AS balance, rd_amt::float AS rd_amt FROM member_balances WHERE mbno::numeric = $1::numeric LIMIT 1`,
            [mbno],
        );
        if (bal.length === 0) throw new NotFoundException(`Member ${mbno} not found.`);
        const cfg = await this.dataSource.query(
            `SELECT monthly_rd_amount::float AS amount, effective_from_date FROM rd_member_config
              WHERE mbno::text = $1 AND yearcode = $2 AND effective_from_date <= CURRENT_DATE
              ORDER BY effective_from_date DESC, id DESC LIMIT 1`,
            [mbno, yearcode],
        );
        const paid = await this.dataSource.query(
            `SELECT COALESCE(SUM(paid_amount), 0)::float AS total,
                    COUNT(*) FILTER (WHERE paid_amount > 0 AND paid_amount >= expected_amount)::int AS full_months,
                    COUNT(*) FILTER (WHERE due_date <= CURRENT_DATE)::int AS due_months
               FROM rd_installment_ledger WHERE mbno::text = $1 AND yearcode = $2`,
            [mbno, yearcode],
        );
        const lien = await this.dataSource.query(
            `SELECT COALESCE(SUM(lien_amount), 0)::float AS locked FROM rd_lien WHERE mbno::text = $1 AND status = 'ACTIVE'`,
            [mbno],
        );
        const receipts = await this.dataSource.query(
            `SELECT receipt_vchr_no AS "voucherNo", trans_date AS "date", trans_amt::float AS amount, narration
               FROM ledger
              WHERE mbno::numeric = $1::numeric AND TRIM(code) = $2 AND UPPER(TRIM(trans_type)) IN ('CR', 'R')
              ORDER BY trans_date DESC, ledgerid DESC LIMIT 6`,
            [mbno, RD_CD_HEAD],
        );
        const balance = Math.max(0, Number(bal[0].balance || 0));
        const locked = Number(lien[0]?.locked || 0);
        return {
            mbno,
            balance: round2(balance),
            monthlyAmount: cfg[0] ? Number(cfg[0].amount) : null,
            monthlyAmountFrom: cfg[0]?.effective_from_date ?? null,
            memberRecordMonthly: Number(bal[0].rd_amt || 0),
            paidThisYear: round2(Number(paid[0]?.total || 0)),
            paidMonths: Number(paid[0]?.full_months || 0),
            lockedByLoan: round2(locked),
            freeToWithdraw: round2(Math.max(0, balance - locked)),
            receipts,
        };
    }

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
    ): Promise<RdPendingInstallmentRow & { voucherNo: string; newBalance: number }> {
        // the screen may send the month and year as text ("4"); they are used as numbers from here on
        installmentMonth = Number(installmentMonth);
        installmentYear = Number(installmentYear);
        // ES-353: NaN, text and absurd figures are refused before anything is read or written
        if (!Number.isFinite(amount) || amount <= 0) throw new BadRequestException('Payment amount must be a number greater than zero.');
        if (amount > 9_999_999.99) throw new BadRequestException('Payment amount is too large.');
        if (!Number.isInteger(installmentMonth) || installmentMonth < 1 || installmentMonth > 12) {
            throw new BadRequestException('Installment month must be a whole number from 1 to 12.');
        }
        if (!Number.isInteger(installmentYear) || installmentYear < 2000 || installmentYear > 2100) {
            throw new BadRequestException('Installment year must be a whole number from 2000 to 2100.');
        }
        // the month has to be one of the months of this financial year
        const fyRows = await this.dataSource.query(`SELECT start_date, end_date FROM yearend WHERE yearcode = $1`, [yearcode]);
        if (!fyRows[0]) throw new NotFoundException(`Financial year ${yearcode} not found.`);
        const monthIndex = installmentYear * 12 + installmentMonth;
        const fyStart = new Date(fyRows[0].start_date);
        const fyEnd = new Date(fyRows[0].end_date);
        if (monthIndex < fyStart.getFullYear() * 12 + fyStart.getMonth() + 1 || monthIndex > fyEnd.getFullYear() * 12 + fyEnd.getMonth() + 1) {
            throw new BadRequestException(`${installmentMonth}/${installmentYear} is not a month of financial year ${yearcode}.`);
        }

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
        if (configRows[0] && expectedAmount > 0 && amount > expectedAmount * 10) {
            throw new BadRequestException(`Payment ${amount} is far above the monthly instalment ${expectedAmount} (more than 10 times). Check the amount.`);
        }

        // rd_installment_ledger has no dedicated "recorded by" column — folded
        // into narration instead, same as this codebase's other tables that
        // lack an audit-identity column of their own.
        const fullNarration = `${narration || 'Collected at counter'} (by ${recordedBy})`;

        const dueDateStr = toDateOnlyString(dueDate);
        const paidDateStr = toDateOnlyString(paidDate);
        const voucherNo = await this.sequenceGenerator.getNextVoucherNumber();

        // ES-508: the counter payment is cash received. The instalment row, the CD voucher, both ledger legs, the cash
        // book line and the member's RD/CD balance are written together, or not at all.
        const qr = this.dataSource.createQueryRunner();
        await qr.connect();
        await qr.startTransaction();
        try {
            await assertPostingDateOpen(qr, paidDate); // ES-458
            await qr.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`rd_repay_${mbno}`]);

            // a second payment for the month ADDS to the first (before, it replaced it)
            const saved = await qr.query(
                `INSERT INTO rd_installment_ledger
                    (mbno, yearcode, installment_month, installment_year, due_date, expected_amount, paid_amount, paid_date, is_arrear_clearance, receipt_no, narration)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
                 ON CONFLICT (mbno, yearcode, installment_month, installment_year) DO UPDATE SET
                    paid_amount = rd_installment_ledger.paid_amount + EXCLUDED.paid_amount,
                    paid_date = EXCLUDED.paid_date,
                    is_arrear_clearance = EXCLUDED.is_arrear_clearance,
                    receipt_no = EXCLUDED.receipt_no,
                    narration = EXCLUDED.narration
                 RETURNING paid_amount, expected_amount`,
                [mbno, yearcode, installmentMonth, installmentYear, dueDateStr, expectedAmount, amount, paidDateStr, isArrearClearance, voucherNo, fullNarration.slice(0, 250)],
            );
            const monthPaid = Number(saved[0].paid_amount);
            const monthExpected = Number(saved[0].expected_amount);

            // cash received: CD voucher, both ledger legs, cash book and the member's RD/CD balance (shared with Member Master)
            const { newBalance } = await postRdCdReceipt(qr, {
                mbno, amount, date: paidDateStr, voucherNo,
                text: `RD/CD ${installmentMonth}/${installmentYear} instalment`,
                description: `RD/CD ${installmentMonth}/${installmentYear} - ${narration || 'Collected at counter'}`,
                remarks: 'RD_CD_COUNTER', username: recordedBy,
            });

            await qr.commitTransaction();
            return {
                installmentMonth, installmentYear, dueDate: dueDateStr,
                expectedAmount: monthExpected, paidAmount: monthPaid, paidDate: paidDateStr,
                status: (monthPaid >= monthExpected ? 'PAID' : 'PARTIAL') as 'PAID' | 'PARTIAL',
                voucherNo, newBalance,
            };
        } catch (e) {
            await qr.rollbackTransaction();
            throw e;
        } finally {
            await qr.release();
        }
    }
}
