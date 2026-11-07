import { BadRequestException, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

@Injectable()
export class DividendPaymentService {
    constructor(private readonly dataSource: DataSource) { }

    /**
     * Get pending dividends for a member
     * Joins interestpaid with interestmaster to get the rate
     */
    async getPendingDividends(memberNo: string) {
        const query = `
            SELECT 
                ip.id,
                ip.wrno as "wrNo",
                ip.opbal as "balance",
                im.rate as "rate",
                ip.interest as "dividend",
                ip.paid
            FROM interestpaid ip
            LEFT JOIN interestmaster im ON ip.id = im.id
            WHERE ip.mbno = $1 AND (ip.paid IS NULL OR ip.paid != 'Y')
        `;

        const result = await this.dataSource.query(query, [memberNo]);

        return result.map(row => ({
            ...row,
            balance: parseFloat(row.balance) || 0,
            rate: parseFloat(row.rate) || 0,
            dividend: parseFloat(row.dividend) || 0
        }));
    }

    /**
     * Process dividend payment
     * 1. Updates interestpaid records
     * 2. (Optional) Could integrate with VoucherService to create accounting entries
     */
    async processDividendPayment(dto: {
        memberNo: string,
        paymentMode: string,
        chequeNo?: string,
        chequeDate?: string,
        bankName?: string,
        narration?: string,
        vouchers: string[], // List of WR NOs or IDs
        totalAmount: number
    }) {
        const queryRunner = this.dataSource.createQueryRunner();
        await queryRunner.connect();
        await queryRunner.startTransaction();

        try {
            const { memberNo, paymentMode, chequeNo, chequeDate, bankName, narration, vouchers, totalAmount } = dto;
            const paymentDate = new Date();

            // ES-419: a payment must name at least one warrant, and the amount paid must be exactly what those
            // warrants are worth. Before, an empty list "succeeded" and any total was accepted without a check.
            const warrantNos = Array.isArray(vouchers) ? vouchers.map((v) => String(v ?? '').trim()) : [];
            if (warrantNos.length === 0 || warrantNos.some((v) => !v)) {
                throw new BadRequestException('Select at least one dividend warrant to pay.');
            }
            if (new Set(warrantNos).size !== warrantNos.length) {
                throw new BadRequestException('The same warrant is listed more than once.');
            }
            const requestedTotal = Number(totalAmount);
            if (!Number.isFinite(requestedTotal) || requestedTotal <= 0) {
                throw new BadRequestException('totalAmount must be a number greater than 0.');
            }
            // locked, so two payments of the same warrant can not both pass this check
            const unpaid = await queryRunner.query(
                `SELECT wrno, interest FROM interestpaid
                 WHERE mbno = $1 AND wrno = ANY($2) AND (paid IS NULL OR paid != 'Y')
                 FOR UPDATE`,
                [memberNo, warrantNos],
            );
            const found = new Set((unpaid || []).map((r: any) => String(r.wrno).trim()));
            const missing = warrantNos.filter((w) => !found.has(w));
            if (missing.length > 0) {
                throw new BadRequestException(`Warrant(s) not found for member ${memberNo} or already paid: ${missing.join(', ')}`);
            }
            const warrantsTotal = Math.round((unpaid as any[]).reduce((sum, r) => sum + (Number(r.interest) || 0), 0) * 100) / 100;
            if (Math.abs(Math.round((warrantsTotal - requestedTotal) * 100) / 100) > 0.01) {
                throw new BadRequestException(`The total ${requestedTotal} does not match the warrants being paid (${warrantsTotal}).`);
            }

            // Use a specific voucher number or generate one
            // For now, we'll just use a mock or timestamp based one if needed, 
            // but ideally we should use the SequenceGeneratorService if available.
            const voucherNo = `DV-${Date.now().toString().slice(-6)}`;

            for (const wrNo of vouchers) {
                const updateQuery = `
                    UPDATE interestpaid 
                    SET 
                        paid = 'Y', 
                        paydate = $1, 
                        payment_mode = $2, 
                        cheque_no = $3, 
                        vchrno = $4
                    WHERE mbno = $5 AND wrno = $6
                `;
                await queryRunner.query(updateQuery, [
                    paymentDate,
                    paymentMode.toUpperCase(),
                    chequeNo || null,
                    voucherNo,
                    memberNo,
                    wrNo
                ]);
            }

            // In a full implementation, you'd also insert into 'vouchers' and 'transactions' tables
            // as we did in the Receipt module.

            await queryRunner.commitTransaction();

            return {
                success: true,
                message: 'Dividend payment processed successfully',
                voucherNo
            };
        } catch (error) {
            await queryRunner.rollbackTransaction();
            throw error;
        } finally {
            await queryRunner.release();
        }
    }
}
