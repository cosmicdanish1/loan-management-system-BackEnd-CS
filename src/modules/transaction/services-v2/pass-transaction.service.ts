import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { SystemConfigService } from '../../admin/services/system-config.service';

/**
 * Pass Transaction Service - Handles final posting of transactions.
 * 
 * @version 2.1 - Refactored to use standard legacy tables (vouchers, transactions, ledger, tblcashbook)
 */
@Injectable()
export class PassTransactionService {
    constructor(
        private readonly dataSource: DataSource,
        private readonly systemConfigService: SystemConfigService,
    ) { }

    /**
     * Pass Transaction - Final Posting
     */
    async passTransaction(voucherNo: string, postedBy: string = 'admin') {
        const queryRunner = this.dataSource.createQueryRunner();

        try {
            await queryRunner.connect();
            await queryRunner.startTransaction();

            console.log(`[PassTransaction] 🔒 Starting Pass Transaction for voucher: ${voucherNo}`);

            // 1. Fetch voucher from header table
            const voucherQuery = `SELECT * FROM vouchers WHERE "voucherNumber" = $1 AND status = 'PENDING'`;
            const headerResult = await queryRunner.query(voucherQuery, [voucherNo]);
            if (headerResult.length === 0) {
                throw new Error('Voucher header not found or already posted');
            }
            const header = headerResult[0];

            // 2. Determine if this is a Loan Disbursement or Generic Voucher
            const remarksMatch = (header.remarks || '').match(/LOAN_CASE:([^|]+)/);
            const isLoanVoucher = !!remarksMatch;
            const loanCaseNo = remarksMatch ? remarksMatch[1] : null;

            // 3. Fetch breakdown details from transactions table
            const detailsQuery = `SELECT * FROM transactions WHERE receipt_vchr_no = $1 AND pass_flag = 'N'`;
            const details = await queryRunner.query(detailsQuery, [voucherNo]);

            if (isLoanVoucher) {
                // ==================== LOAN SPECIFIC LOGIC ====================
                const lpQuery = `SELECT * FROM loan_pending WHERE loancaseno::text = $1`;
                const lpResult = await queryRunner.query(lpQuery, [loanCaseNo]);
                if (lpResult.length === 0) throw new Error('Loan case not found in loan_pending');
                const loan = lpResult[0];

                let rate = 12, penalrate = 2;
                try {
                    const rateKey = (loan.loantype === 'R' || loan.loantype === 'REG') ? 'RULE_LOAN_LT_INTEREST_RATE' : 'RULE_LOAN_EL_INTEREST_RATE';
                    rate = await this.systemConfigService.getConfigValue(rateKey);
                } catch (e) { }

                const parseMoney = (val: any) => parseFloat(val.toString().replace(/[^0-9.-]+/g, "")) || 0;
                const sanctionedAmt = parseMoney(loan.sanctioned_amt);
                const noOfInstal = loan.no_of_instal || 1;

                // Activate Loan
                const insertLoanMasterQuery = `
                    INSERT INTO loan_master (
                        mbno, loantype, loancaseno, loan_amt, payment_date, 
                        rate, no_of_instal, instal_amt, balance, openbalance, 
                        purpose, intt_amount, penalrate
                    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
                `;
                await queryRunner.query(insertLoanMasterQuery, [
                    loan.mbno, loan.loantype, loan.loancaseno, sanctionedAmt, new Date(),
                    rate, noOfInstal, Math.round(sanctionedAmt / noOfInstal), sanctionedAmt, sanctionedAmt,
                    loan.purpose, 0, penalrate
                ]);

                // Post Breakdown for Loan
                for (const detail of details) {
                    await queryRunner.query(`
                        INSERT INTO ledger (mbno, loantype, loancaseno, particulars, vchr_no, vchr_date, dr_amt, cr_amt, balance)
                        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
                    `, [loan.mbno, loan.loantype, loan.loancaseno, detail.particulars, voucherNo, new Date(), detail.trans_amt, 0, sanctionedAmt]);

                    await queryRunner.query(`
                        INSERT INTO tblcashbook (mbno, particulars, vchr_no, vchr_date, payment, receipt, balance, trans_type)
                        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                    `, [loan.mbno, detail.particulars, voucherNo, new Date(), detail.trans_amt, 0, 0, 'P']);
                }

                await queryRunner.query(`UPDATE loan_pending SET flg_paid = 'Y', p_date = NOW() WHERE loancaseno::text = $1`, [loanCaseNo]);

            } else {
                // ==================== GENERIC POSTING LOGIC ====================
                for (const detail of details) {
                    // Post to generic ledger if member ID exists, otherwise just cashbook
                    if (header.memberId) {
                        await queryRunner.query(`
                            INSERT INTO ledger (mbno, particulars, vchr_no, vchr_date, dr_amt, cr_amt)
                            VALUES ($1, $2, $3, $4, $5, $6)
                        `, [header.memberId, detail.particulars || header.description, voucherNo, new Date(), detail.trans_amt, 0]);
                    }

                    await queryRunner.query(`
                        INSERT INTO tblcashbook (mbno, particulars, vchr_no, vchr_date, payment, receipt, trans_type)
                        VALUES ($1, $2, $3, $4, $5, $6, $7)
                    `, [header.memberId || 0, detail.particulars || header.description, voucherNo, new Date(), detail.trans_amt, 0, 'P']);
                }
            }

            // 8. Update Voucher and Transaction flags
            await queryRunner.query(`UPDATE vouchers SET status = 'POSTED', "authorizedAt" = NOW() WHERE "voucherNumber" = $1`, [voucherNo]);
            await queryRunner.query(`UPDATE transactions SET pass_flag = 'Y' WHERE receipt_vchr_no = $1`, [voucherNo]);

            await queryRunner.commitTransaction();
            console.log(`[PassTransaction] ✅ Transaction passed successfully: ${voucherNo}`);

            return { success: true, message: 'Transaction posted successfully' };

        } catch (error: any) {
            await queryRunner.rollbackTransaction();
            console.error('[PassTransaction] ❌ Posting failed:', error);
            throw new Error('Failed to post transaction: ' + error.message);
        } finally {
            await queryRunner.release();
        }
    }

    /**
     * Reverse Transaction - Rollback Posting
     */
    async reverseTransaction(voucherNo: string, reversedBy: string = 'admin') {
        const queryRunner = this.dataSource.createQueryRunner();

        try {
            await queryRunner.connect();
            await queryRunner.startTransaction();

            console.log(`[PassTransaction] 🔄 Reversing Transaction: ${voucherNo}`);

            // 1. Fetch voucher metadata
            const voucherQuery = `SELECT * FROM vouchers WHERE "voucherNumber" = $1 AND status = 'POSTED'`;
            const headerResult = await queryRunner.query(voucherQuery, [voucherNo]);
            if (headerResult.length === 0) {
                throw new Error('Voucher header not found or is not in POSTED status');
            }
            const header = headerResult[0];

            // 2. Extract loan case no
            const remarksMatch = (header.remarks || '').match(/LOAN_CASE:([^|]+)/);
            if (!remarksMatch) throw new Error('Voucher metadata missing for reversal');
            const loanCaseNo = remarksMatch[1];

            // 3. Remove from Ledger
            await queryRunner.query(`DELETE FROM ledger WHERE "vchr_no" = $1`, [voucherNo]);

            // 4. Remove from tblcashbook
            await queryRunner.query(`DELETE FROM tblcashbook WHERE "vchr_no" = $1`, [voucherNo]);

            // 5. Remove/Deactivate from loan_master
            await queryRunner.query(`DELETE FROM loan_master WHERE "loancaseno"::text = $1`, [loanCaseNo]);

            // 6. Reset Flags
            await queryRunner.query(`UPDATE vouchers SET status = 'PENDING', "authorizedAt" = NULL WHERE "voucherNumber" = $1`, [voucherNo]);
            await queryRunner.query(`UPDATE transactions SET pass_flag = 'N' WHERE receipt_vchr_no = $1`, [voucherNo]);
            await queryRunner.query(`UPDATE loan_pending SET flg_paid = 'N', p_date = NULL WHERE loancaseno::text = $1`, [loanCaseNo]);

            await queryRunner.commitTransaction();
            console.log(`[PassTransaction] ✅ Transaction reversed: ${voucherNo}`);

            return { success: true, message: 'Transaction reversed and moved back to pending status' };

        } catch (error: any) {
            await queryRunner.rollbackTransaction();
            console.error('[PassTransaction] ❌ Reversal failed:', error);
            throw new Error('Failed to reverse transaction: ' + error.message);
        } finally {
            await queryRunner.release();
        }
    }
}
