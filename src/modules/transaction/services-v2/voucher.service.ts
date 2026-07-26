import { Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { SequenceGeneratorService } from '../../shared/services';
import { generateVoucherNo } from '../../shared/utils/voucher-utils';
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
    private readonly logger = new Logger(VoucherService.name);

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

            this.logger.log(`Creating generic ${dto.voucherType} voucher: ${JSON.stringify(dto)}`);

            // Normalize: accept 'transactions' or 'breakdown' from frontend callers
            const transactions: any[] = Array.isArray(dto.transactions)
                ? dto.transactions
                : Array.isArray(dto.breakdown)
                    ? dto.breakdown
                    : [];

            if (transactions.length === 0) {
                throw new Error('No transaction entries provided. At least one entry is required.');
            }

            // 1. Canonical voucher number from voucher_master — P for payments, R for receipts.
            const voucherNumber = await generateVoucherNo(queryRunner, dto.voucherType === 'PAYMENT' ? 'P' : 'R');

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
            this.logger.log(`Generic voucher ${voucherNumber} created successfully`);

            // 4. Send Notification (Async/Non-blocking)
            if (dto.memberId) {
                const totalAmount = transactions.reduce((sum: number, t: any) => sum + (t.amount || 0), 0);
                this.notificationService.sendManualNotification({
                    memberNo: dto.memberId.toString(),
                    channel: NotificationChannel.SMS,
                    message: `Transaction Confirmed: Your ${dto.voucherType} of ₹${totalAmount} has been processed. Voucher: ${voucherNumber}. - Espat Society`,
                    recipient: '' // Service will fetch if empty
                }).catch(e => this.logger.error('Failed to send auto-notification:', e));
            }

            return {
                success: true,
                message: 'Voucher created successfully',
                voucherNo: voucherNumber
            };

        } catch (error: any) {
            await queryRunner.rollbackTransaction();
            this.logger.error('Error creating generic voucher:', error);
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

            this.logger.log(`Generating voucher for loan disbursement using standard tables: ${JSON.stringify(voucherData)}`);

            // 1. Canonical Payment voucher number from voucher_master (P) — loan
            // disbursement is a payment out, consistent with the Payment Voucher screen.
            const voucherNumber = await generateVoucherNo(queryRunner, 'P');

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

            // Check for existing voucher for this loan case (prevent duplicates)
            const existingVoucher = await queryRunner.query(
                `SELECT "id", "voucherNumber", "status" FROM vouchers
                 WHERE "remarks" LIKE '%LOAN_CASE:' || $1 || '%' AND "status" IN ('PENDING', 'POSTED')`,
                [voucherData.loanCaseNo]
            );
            if (existingVoucher.length > 0) {
                throw new Error(`Voucher ${existingVoucher[0].voucherNumber} already exists for this loan case (status: ${existingVoucher[0].status})`);
            }

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
                `LOAN_CASE:${voucherData.loanCaseNo}|PAY_MODE:${voucherData.paymentMode}|BANK:${voucherData.bankName || ''}`,
                new Date()
            ]);

            // 4. Auto-calculate 5% Share & FD deductions
            const sanctionedAmt = parseFloat(loan.sanctioned_amt.toString().replace(/[^0-9.-]+/g, ""));
            const requiredShare = sanctionedAmt * 0.05;
            const requiredFd = sanctionedAmt * 0.05;

            const shareResult = await queryRunner.query(
                `SELECT COALESCE(shares::numeric, 0) as shares FROM member_balances WHERE mbno = $1`, [loan.mbno]
            );
            const currentShare = Number(shareResult[0]?.shares || 0);

            const fdResult = await queryRunner.query(
                `SELECT COALESCE(SUM(fdamount::numeric), 0) as fd_total FROM fdmaster WHERE mbno = $1 AND status = '0' AND fdrdflag = 'F'`, [loan.mbno]
            );
            const currentFd = Number(fdResult[0]?.fd_total || 0);

            // For top-up loans: check if member has an existing active loan where share/FD was already covered
            const existingLoanResult = await queryRunner.query(
                `SELECT COUNT(*) as cnt FROM loan_master WHERE mbno = $1 AND balance > 0`, [loan.mbno]
            );
            const hasExistingActiveLoan = Number(existingLoanResult[0]?.cnt || 0) > 0;

            let shareTopUp = 0;
            let fdTopUp = 0;
            if (!hasExistingActiveLoan) {
                shareTopUp = Math.max(0, requiredShare - currentShare);
                fdTopUp = Math.max(0, requiredFd - currentFd);
            }

            // Merge auto-deductions into breakdown (avoid duplicates if frontend already added them)
            const breakdown: any[] = Array.isArray(voucherData.breakdown) ? [...voucherData.breakdown] : [];
            const hasShareEntry = breakdown.some((e: any) => e.code === 'L1001' && e.rp === 'Receipt');
            const hasFdEntry = breakdown.some((e: any) => e.code === 'A003' && e.rp === 'Receipt');

            if (shareTopUp > 0 && !hasShareEntry) {
                breakdown.push({ key: 'auto-share', srNo: 'auto', code: 'L1001', name: 'SHARE VALUE (5% Auto)', rp: 'Receipt', amount: shareTopUp });
            }
            if (fdTopUp > 0 && !hasFdEntry) {
                breakdown.push({ key: 'auto-fd', srNo: 'auto', code: 'A003', name: 'FIXED DEPOSIT (5% Auto)', rp: 'Receipt', amount: fdTopUp });
            }

            // 5. Insert breakdown entries into 'transactions' table
            const transInsert = `
                INSERT INTO transactions (
                    trans_no, trans_type, trans_date, mbno, trans_amt,
                    receipt_vchr_no, vchr_type, modeofpay, pass_flag, cashier_flag,
                    narration, code, cheq_amt
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
            `;
            const payMode = voucherData.paymentMode === 'CASH' ? 'C' : 'B';
            let loanDR = 0;
            let deductionCR = 0;

            for (const entry of breakdown) {
                const transNo = await this.getNextId('transactions');
                const amt = parseFloat(entry.amount) || 0;
                const isMainLoan = (entry.rp === 'Payment');
                const transType = isMainLoan ? 'DR' : 'CR';

                await queryRunner.query(transInsert, [
                    transNo, transType, new Date(), loan.mbno, amt,
                    voucherNumber, 'P', payMode, 'N', 'N',
                    `${entry.name || ''} [Code: ${entry.code}]`, entry.code || null, 0
                ]);

                if (isMainLoan) loanDR += amt;
                else deductionCR += amt;
            }

            // 5. Auto-create balancing CR entry for cash/bank
            // Cash CR = Loan DR - Deduction CRs (what member actually gets)
            const cashAmount = loanDR - deductionCR;
            const cashCode = payMode === 'C' ? 'A1001' : (voucherData.bankName || 'A1001');
            const crTransNo = await this.getNextId('transactions');
            await queryRunner.query(transInsert, [
                crTransNo, 'CR', new Date(), loan.mbno, cashAmount,
                voucherNumber, 'P', payMode, 'N', 'N',
                `Cash/Bank disbursement for Loan Case ${voucherData.loanCaseNo}`,
                cashCode, 0
            ]);

            // 6. Create loan_master record (legacy: loan account for balance tracking)
            const busrules = await queryRunner.query(
                `SELECT COALESCE(rlnrate, 12) as rln_rate, COALESCE(elnrate, 12) as eln_rate,
                        COALESCE(rlnpenalrate, 2) as rln_penal, COALESCE(edlpenalrate, 2) as eln_penal
                 FROM busrules ORDER BY appdate DESC LIMIT 1`
            );
            const rules = busrules[0] || {};
            const isRLN = ['R', 'REG', 'RLN'].includes((loan.loantype || '').toUpperCase());
            const loanRate = parseFloat(isRLN ? rules.rln_rate : rules.eln_rate) || 12;
            const penalRate = parseFloat(isRLN ? rules.rln_penal : rules.eln_penal) || 2;
            const noOfInstal = parseInt(loan.no_of_instal) || 60;
            const instalAmt = Math.round((sanctionedAmt / noOfInstal) * 100) / 100;
            const inttAmount = Math.round((sanctionedAmt * loanRate / 1200) * 100) / 100;

            await queryRunner.query(`
                INSERT INTO loan_master (mbno, loantype, loancaseno, loan_amt, balance, openbalance,
                    rate, no_of_instal, instal_amt, payment_date, purpose, intt_amount, penalrate)
                VALUES ($1, $2, $3, $4, $5, 0, $6, $7, $8, $9, $10, $11, $12)
                ON CONFLICT DO NOTHING
            `, [
                loan.mbno, loan.loantype, voucherData.loanCaseNo,
                sanctionedAmt, sanctionedAmt,
                loanRate, noOfInstal, instalAmt,
                new Date(), loan.purpose || '',
                inttAmount, penalRate
            ]);

            // 7. Mark loan_pending as paid
            await queryRunner.query(
                `UPDATE loan_pending SET flg_paid = 'Y' WHERE loancaseno::text = $1`,
                [voucherData.loanCaseNo]
            );

            await queryRunner.commitTransaction();
            this.logger.log(`Voucher ${voucherNumber} staged + loan_master created + flg_paid=Y`);

            // Auto-queue loan disbursement notification
            try {
                const { autoQueueNotification } = require('../../shared/utils/auto-notify');
                autoQueueNotification(this.dataSource, String(loan.mbno),
                    `Your loan #${voucherData.loanCaseNo} of ₹${sanctionedAmt.toLocaleString('en-IN')} has been sanctioned & disbursed. Voucher: ${voucherNumber}. — FIBE Credit Society`,
                    'LOAN_DISBURSED'
                ).catch(() => {});
            } catch {}


            return {
                success: true,
                message: 'Voucher generated and staged successfully',
                voucherNo: voucherNumber
            };

        } catch (error: any) {
            await queryRunner.rollbackTransaction();
            this.logger.error('Error generating voucher:', error);
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

            this.logger.log(`Deleting pending voucher: ${voucherNo}`);

            // 1. Verify voucher exists and is PENDING
            const voucherResult = await queryRunner.query(
                `SELECT * FROM vouchers WHERE "voucherNumber" = $1`, [voucherNo]
            );

            if (voucherResult.length === 0) {
                // Already deleted — clean up any orphan transactions and return success
                await queryRunner.query(`DELETE FROM transactions WHERE receipt_vchr_no = $1`, [voucherNo]);
                await queryRunner.commitTransaction();
                return { success: true, message: `Voucher ${voucherNo} already removed` };
            }

            if (voucherResult[0].status !== 'PENDING') {
                throw new Error(`Cannot delete voucher ${voucherNo} — status is ${voucherResult[0].status}. Only PENDING vouchers can be deleted.`);
            }

            // Extract loan case no to reset loan_pending
            const remarksMatch = (voucherResult[0].remarks || '').match(/LOAN_CASE:([^|]+)/);
            const loanCaseNo = remarksMatch ? remarksMatch[1] : '';

            // 2. Delete transaction rows linked to this voucher
            await queryRunner.query(`DELETE FROM transactions WHERE receipt_vchr_no = $1`, [voucherNo]);

            // 3. Delete the voucher header
            await queryRunner.query(`DELETE FROM vouchers WHERE "voucherNumber" = $1`, [voucherNo]);

            // 4. Reset loan_pending and remove loan_master so case reappears in Loan Payment dropdown
            if (loanCaseNo) {
                await queryRunner.query(
                    `UPDATE loan_pending SET flg_paid = 'N' WHERE loancaseno::text = $1`,
                    [loanCaseNo]
                );
                await queryRunner.query(
                    `DELETE FROM loan_master WHERE loancaseno::text = $1`,
                    [loanCaseNo]
                );
            }

            await queryRunner.commitTransaction();
            this.logger.log(`Voucher ${voucherNo} deleted, loan case ${loanCaseNo} reset`);

            return { success: true, message: `Voucher ${voucherNo} deleted successfully` };

        } catch (error: any) {
            await queryRunner.rollbackTransaction();
            this.logger.error('Error deleting voucher:', error);
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
                    COALESCE(m.f_name, '') as f_name,
                    COALESCE(m.m_name, '') as m_name,
                    COALESCE(m.l_name, '') as l_name
                FROM vouchers v
                LEFT JOIN member_master m ON CAST(v."memberId" AS text) = CAST(m.mbno AS text)
                WHERE v.status = 'PENDING'
                  AND v."voucherNumber" IS NOT NULL
                ORDER BY v."createdAt" DESC
            `;

            const result = await this.dataSource.query(query);

            const flatRows = [];
            for (const row of result) {
                const remarksMatch = (row.remarks || '').match(/LOAN_CASE:([^|]+)/);
                const loanCaseNo = remarksMatch ? remarksMatch[1] : '';
                const memberName = `${row.f_name || ''} ${row.m_name || ''} ${row.l_name || ''}`.trim();

                const transQuery = `SELECT * FROM transactions WHERE receipt_vchr_no = $1 AND pass_flag = 'N' ORDER BY trans_no`;
                const trans = await this.dataSource.query(transQuery, [row.voucherNumber]);

                const vchrType = row.voucherType === 'JOURNAL' ? 'J' : 'P';
                if (trans.length === 0) {
                    flatRows.push({
                        id: row.id,
                        trNo: '',
                        voucherNo: row.voucherNumber,
                        memberNo: row.memberId || '',
                        memberName: memberName || 'Journal Entry',
                        noOfAcc: '0',
                        head: '',
                        transType: 'DR',
                        amount: parseFloat(row.totalAmount),
                        vchrType,
                        loanCaseNo,
                        status: row.status,
                        narration: row.description,
                        chequeNo: row.chequeNumber || '',
                        chequeDate: row.chequeDate || '',
                        chequeAmount: 0,
                        bankName: row.bankName || '',
                        passFlag: 'N',
                    });
                } else {
                    for (const t of trans) {
                        flatRows.push({
                            id: row.id,
                            trNo: t.trans_no != null ? t.trans_no.toString() : '',
                            voucherNo: row.voucherNumber,
                            memberNo: row.memberId || '',
                            memberName: memberName || 'Journal Entry',
                            noOfAcc: '0',
                            head: t.code || '',
                            transType: (t.trans_type === 'CR' || t.trans_type === 'R') ? 'CR' : 'DR',
                            amount: parseFloat(t.trans_amt) || 0,
                            vchrType,
                            loanCaseNo,
                            status: row.status,
                            narration: t.narration || row.description || '',
                            chequeNo: row.chequeNumber || '',
                            chequeDate: row.chequeDate || '',
                            chequeAmount: 0,
                            bankName: row.bankName || '',
                            passFlag: t.pass_flag || 'N',
                        });
                    }
                }
            }

            return flatRows;

        } catch (error: any) {
            this.logger.error('Error fetching pending vouchers:', error);
            throw new Error('Failed to fetch pending vouchers: ' + error.message);
        }
    }

    async getVoucherDetails(voucherNo: string) {
        // Implement if needed for specific view, similar to getPendingVouchers item fetch
        const pending = await this.getPendingVouchers();
        return pending.find(v => v.voucherNo === voucherNo) || null;
    }
}
