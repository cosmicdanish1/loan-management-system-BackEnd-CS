import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { SequenceGeneratorService } from '../../shared/services';
import { NotificationService } from '../../notification/services/notification.service';
import { NotificationChannel } from '../../notification/entities/notification-log.entity';

/**
 * Voucher Service - Handles voucher generation and staging.
 * 
 * @version 2.2 - Refactored to use standard legacy tables (vouchers, transactions)
 * to comply with "no new table" constraint.
 */
@Injectable()
export class VoucherService {
    constructor(
        private readonly dataSource: DataSource,
        private readonly sequenceGenerator: SequenceGeneratorService,
        private readonly notificationService: NotificationService,
    ) { }

    /**
     * Create a generic voucher (Payment, Receipt, etc.)
     * Uses 'vouchers' and 'transactions' tables
     */
    async createVoucher(dto: any) {
        const queryRunner = this.dataSource.createQueryRunner();

        try {
            await queryRunner.connect();
            await queryRunner.startTransaction();

            console.log(`[Voucher] 🚀 Creating generic ${dto.voucherType} voucher:`, dto);

            // Normalize: accept 'transactions' or 'breakdown' from frontend callers
            const transactions: any[] = Array.isArray(dto.transactions)
                ? dto.transactions
                : Array.isArray(dto.breakdown)
                    ? dto.breakdown
                    : [];

            if (transactions.length === 0) {
                throw new Error('No transaction entries provided. At least one entry is required.');
            }

            // 1. Get sequential voucher number
            const voucherNumber = await this.sequenceGenerator.getNextVoucherNumber();

            // 2. Insert into 'vouchers' table
            const voucherHeaderQuery = `
                INSERT INTO vouchers (
                    "id", "voucherNumber", "voucherDate", "voucherType", "totalAmount", 
                    "description", "memberId", "payeeName", "status", "remarks", 
                    "chequeNumber", "chequeDate", "bankName", "createdAt"
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
            `;

            const nextVoucherId = await this.getNextId('vouchers');
            const totalAmount = transactions.reduce((sum: number, t: any) => sum + (t.amount || 0), 0);

            await queryRunner.query(voucherHeaderQuery, [
                nextVoucherId,
                voucherNumber,
                dto.voucherDate || new Date(),
                dto.voucherType,
                totalAmount,
                dto.description,
                dto.memberId || null,
                dto.payeeName || '',
                'PENDING',
                dto.remarks || '',
                dto.chequeNumber || null,
                dto.chequeDate || null,
                dto.bankName || null,
                new Date()
            ]);

            // 3. Insert breakdown into 'transactions' table
            for (const entry of transactions) {
                const transNo = await this.getNextId('transactions');
                const transQuery = `
                    INSERT INTO transactions (
                        trans_no, trans_type, trans_date, mbno, trans_amt, 
                        receipt_vchr_no, vchr_type, modeofpay, pass_flag, cashier_flag,
                        narration, code, username, acc_no, cheq_amt
                    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
                `;

                await queryRunner.query(transQuery, [
                    transNo,
                    dto.voucherType === 'PAYMENT' ? 'P' : 'R', // P for Payment, R for Receipt
                    dto.voucherDate || new Date(),
                    dto.memberId || null,
                    entry.amount,
                    voucherNumber,
                    dto.voucherType === 'PAYMENT' ? 'PV' : 'RV', // PV: Payment Voucher, RV: Receipt Voucher
                    dto.paymentMethod === 'CASH' ? 'C' : 'B',
                    'N', // pass_flag (pending approval)
                    'N', // cashier_flag
                    entry.description || dto.description,
                    entry.debitAccount || entry.code || null,
                    'admin', // Should be from auth context in real app
                    entry.rdSrNo ? parseInt(entry.rdSrNo.replace(/[^0-9]/g, '')) || null : null,
                    0 // cheq_amt default
                ]);
            }

            await queryRunner.commitTransaction();
            console.log(`[Voucher] ✅ Generic voucher ${voucherNumber} created successfully`);

            // 4. Send Notification (Async/Non-blocking)
            if (dto.memberId) {
                const totalAmount = transactions.reduce((sum: number, t: any) => sum + (t.amount || 0), 0);
                this.notificationService.sendManualNotification({
                    memberNo: dto.memberId.toString(),
                    channel: NotificationChannel.SMS,
                    message: `Transaction Confirmed: Your ${dto.voucherType} of ₹${totalAmount} has been processed. Voucher: ${voucherNumber}. - Espat Society`,
                    recipient: '' // Service will fetch if empty
                }).catch(e => console.error('Failed to send auto-notification:', e));
            }

            return {
                success: true,
                message: 'Voucher created successfully',
                voucherNo: voucherNumber
            };

        } catch (error: any) {
            await queryRunner.rollbackTransaction();
            console.error('[Voucher] ❌ Error creating generic voucher:', error);
            throw new Error('Failed to create voucher: ' + error.message);
        } finally {
            await queryRunner.release();
        }
    }

    /**
     * Generate voucher for loan disbursement
     * Uses 'vouchers' table and 'transactions' table (pending)
     */
    async generateLoanVoucher(voucherData: any) {
        const queryRunner = this.dataSource.createQueryRunner();

        try {
            await queryRunner.connect();
            await queryRunner.startTransaction();

            console.log('[Voucher] 🎯 Generating voucher for loan disbursement using standard tables:', voucherData);

            // 1. Get sequential voucher number
            const voucherNumber = await this.sequenceGenerator.getNextVoucherNumber();

            // 2. Validate loan case exists and is sanctioned
            const loanQuery = `
                SELECT loancaseno, mbno, sanctioned_amt, flg_sanctioned, flg_paid, loantype, purpose
                FROM loan_pending 
                WHERE loancaseno = $1 AND flg_sanctioned = 'Y' AND flg_paid = 'N'
            `;

            const loanResult = await queryRunner.query(loanQuery, [voucherData.loanCaseNo]);
            if (loanResult.length === 0) {
                throw new Error('Loan case not found or not sanctioned or already disbursed');
            }
            const loan = loanResult[0];

            // 3. Insert into standard 'vouchers' table
            // We store the loan case number in the remarks field as a searchable tag
            const voucherHeaderQuery = `
                INSERT INTO vouchers (
                    "id", "voucherNumber", "voucherDate", "voucherType", "totalAmount", 
                    "description", "memberId", "payeeName", "status", "remarks", "createdAt"
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
            `;

            const totalAmount = voucherData.actualAmount || parseFloat(loan.sanctioned_amt.toString().replace(/[^0-9.-]+/g, ""));
            const nextId = await this.getNextId('vouchers');

            await queryRunner.query(voucherHeaderQuery, [
                nextId,
                voucherNumber,
                new Date(),
                'PAYMENT',
                totalAmount,
                `Loan disbursement for case ${voucherData.loanCaseNo}`,
                loan.mbno,
                voucherData.payeeName || loan.member_name || '', // Note: payeeName might needs join or passed
                'PENDING',
                `LOAN_CASE:${voucherData.loanCaseNo}|PAY_MODE:${voucherData.paymentMode}`,
                new Date()
            ]);

            // 4. Insert breakdown into 'transactions' table with pass_flag = 'N'
            if (voucherData.breakdown && Array.isArray(voucherData.breakdown)) {
                for (const entry of voucherData.breakdown) {
                    const transNo = await this.getNextId('transactions');
                    const transQuery = `
                        INSERT INTO transactions (
                            trans_no, trans_type, trans_date, mbno, trans_amt, 
                            receipt_vchr_no, vchr_type, modeofpay, pass_flag, cashier_flag,
                            narration, code, cheq_amt
                        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
                    `;

                    await queryRunner.query(transQuery, [
                        transNo,
                        'P', // Payment
                        new Date(),
                        loan.mbno,
                        entry.amount,
                        voucherNumber,
                        'LD', // Loan Disbursement
                        voucherData.paymentMode === 'CASH' ? 'C' : 'B',
                        'N', // pass_flag
                        'N', // cashier_flag
                        `${entry.name} [Code: ${entry.code}]`,
                        entry.code || null,
                        0 // cheq_amt default
                    ]);
                }
            }

            await queryRunner.commitTransaction();
            console.log(`[Voucher] ✅ Voucher ${voucherNumber} staged successfully in standard tables`);

            return {
                success: true,
                message: 'Voucher generated and staged successfully',
                voucherNo: voucherNumber
            };

        } catch (error: any) {
            await queryRunner.rollbackTransaction();
            console.error('[Voucher] ❌ Error generating voucher:', error);
            throw new Error('Failed to generate voucher: ' + error.message);
        } finally {
            await queryRunner.release();
        }
    }

    /**
     * Helper to get next numeric ID for a table
     */
    private async getNextId(tableName: string): Promise<number> {
        let idColumn = 'id';
        if (tableName === 'transactions') idColumn = 'trans_no';

        const result = await this.dataSource.query(`SELECT COALESCE(MAX(${idColumn}), 0) + 1 as next_id FROM ${tableName}`);
        return parseInt(result[0].next_id);
    }

    /**
     * Delete/Reject a pending voucher (only PENDING status)
     */
    async deleteVoucher(voucherNo: string) {
        const queryRunner = this.dataSource.createQueryRunner();

        try {
            await queryRunner.connect();
            await queryRunner.startTransaction();

            console.log(`[Voucher] 🗑️ Deleting pending voucher: ${voucherNo}`);

            // 1. Verify voucher exists and is PENDING
            const voucherResult = await queryRunner.query(
                `SELECT * FROM vouchers WHERE "voucherNumber" = $1`, [voucherNo]
            );

            if (voucherResult.length === 0) {
                throw new Error(`Voucher ${voucherNo} not found`);
            }

            if (voucherResult[0].status !== 'PENDING') {
                throw new Error(`Cannot delete voucher ${voucherNo} - status is ${voucherResult[0].status}. Only PENDING vouchers can be deleted.`);
            }

            // 2. Delete transaction rows linked to this voucher
            const deletedTrans = await queryRunner.query(
                `DELETE FROM transactions WHERE receipt_vchr_no = $1`, [voucherNo]
            );
            console.log(`[Voucher] Deleted ${deletedTrans[1] || 0} transaction rows for ${voucherNo}`);

            // 3. Delete the voucher header
            await queryRunner.query(
                `DELETE FROM vouchers WHERE "voucherNumber" = $1`, [voucherNo]
            );

            await queryRunner.commitTransaction();
            console.log(`[Voucher] ✅ Voucher ${voucherNo} deleted successfully`);

            return { success: true, message: `Voucher ${voucherNo} deleted successfully` };

        } catch (error: any) {
            await queryRunner.rollbackTransaction();
            console.error('[Voucher] ❌ Error deleting voucher:', error);
            throw new Error('Failed to delete voucher: ' + error.message);
        } finally {
            await queryRunner.release();
        }
    }

    /**
     * Get pending vouchers ready for Pass Transaction
     */
    async getPendingVouchers() {
        try {
            const query = `
                SELECT 
                    v.*,
                    m.f_name, m.m_name, m.l_name
                FROM vouchers v
                JOIN member_master m ON v."memberId" = m.mbno
                WHERE v.status = 'PENDING'
                ORDER BY v."createdAt" DESC
            `;

            const result = await this.dataSource.query(query);

            const vouchersWithDetails = [];
            for (const row of result) {
                // Extract loan case no from remarks
                const remarksMatch = (row.remarks || '').match(/LOAN_CASE:([^|]+)/);
                const loanCaseNo = remarksMatch ? remarksMatch[1] : '';

                let loanType = 'GENERAL';
                if (loanCaseNo) {
                    const lp = await this.dataSource.query(`SELECT loantype FROM loan_pending WHERE loancaseno::text = $1`, [loanCaseNo]);
                    if (lp.length > 0) loanType = lp[0].loantype;
                }

                // Fetch details from transactions table
                const transQuery = `SELECT * FROM transactions WHERE receipt_vchr_no = $1 AND pass_flag = 'N'`;
                const trans = await this.dataSource.query(transQuery, [row.voucherNumber]);

                vouchersWithDetails.push({
                    id: row.id,
                    voucherNo: row.voucherNumber,
                    memberNo: row.memberId,
                    memberName: `${row.f_name || ''} ${row.m_name || ''} ${row.l_name || ''}`.trim(),
                    amount: parseFloat(row.totalAmount),
                    vchrType: row.voucherType || 'Loan Disbursement',
                    loanType: loanType,
                    status: row.status,
                    narration: row.description,
                    loanCaseNo: loanCaseNo,
                    paymentMode: row.bankName || row.chequeNumber ? 'bank' : 'cash',
                    chequeNo: row.chequeNumber,
                    chequeDate: row.chequeDate,
                    bankName: row.bankName,
                    createdDate: row.createdAt,
                    breakdown: trans.map((t: any, idx: number) => ({
                        srNo: (idx + 1).toString(),
                        code: t.code || '',
                        name: t.narration || t.particulars,
                        rp: 'P',
                        amount: parseFloat(t.trans_amt)
                    }))
                });
            }

            return vouchersWithDetails;

        } catch (error: any) {
            console.error('[Voucher] ❌ Error fetching pending vouchers:', error);
            throw new Error('Failed to fetch pending vouchers: ' + error.message);
        }
    }

    async getVoucherDetails(voucherNo: string) {
        // Implement if needed for specific view, similar to getPendingVouchers item fetch
        const pending = await this.getPendingVouchers();
        return pending.find(v => v.voucherNo === voucherNo) || null;
    }
}
