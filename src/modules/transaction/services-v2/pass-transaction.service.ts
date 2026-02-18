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
            console.log(`[PassTransaction] Found ${details.length} transaction details for voucher ${voucherNo}`);

            // 4. Get Next IDs for Ledger
            const maxLedgerIdResult = await queryRunner.query("SELECT COALESCE(MAX(ledgerid), 0) as max_id FROM ledger");
            let nextLedgerId = parseInt(maxLedgerIdResult[0].max_id) + 1;

            const maxTransNoResult = await queryRunner.query("SELECT COALESCE(MAX(trans_no), 0) as max_no FROM ledger");
            let nextTransNo = parseInt(maxTransNoResult[0].max_no) + 1;

            const mode = (header.bankName || header.chequeNumber) ? 'T' : 'C'; // T=Transfer, C=Cash

            const parseMoney = (val: any) => {
                if (!val) return 0;
                return parseFloat(val.toString().replace(/[^0-9.-]+/g, "")) || 0;
            };

            if (isLoanVoucher) {
                // ==================== LOAN SPECIFIC LOGIC ====================
                console.log(`[PassTransaction] 🏦 Processing LOAN voucher for case: ${loanCaseNo}`);
                const lpQuery = `SELECT * FROM loan_pending WHERE loancaseno::text = $1`;
                const lpResult = await queryRunner.query(lpQuery, [loanCaseNo]);
                if (lpResult.length === 0) throw new Error(`Loan case ${loanCaseNo} not found in loan_pending`);
                const loan = lpResult[0];

                let rate = 12, penalrate = 2;
                try {
                    const rateKey = (loan.loantype === 'R' || loan.loantype === 'REG') ? 'RULE_LOAN_LT_INTEREST_RATE' : 'RULE_LOAN_EL_INTEREST_RATE';
                    rate = await this.systemConfigService.getConfigValue(rateKey);
                } catch (e) {
                    console.warn(`[PassTransaction] Could not fetch interest rate for ${loan.loantype}, using default 12%`);
                }

                const sanctionedAmt = parseMoney(loan.sanctioned_amt);
                const noOfInstal = loan.no_of_instal || 1;
                const instalAmt = Math.round(sanctionedAmt / noOfInstal);

                // Activate Loan
                const insertLoanMasterQuery = `
                    INSERT INTO loan_master (
                        mbno, loantype, loancaseno, loan_amt, payment_date, 
                        rate, no_of_instal, instal_amt, balance, openbalance, 
                        purpose, intt_amount, penalrate
                    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
                `;
                console.log(`[PassTransaction] Activating loan in loan_master for mbno: ${loan.mbno}`);
                await queryRunner.query(insertLoanMasterQuery, [
                    loan.mbno, loan.loantype, loan.loancaseno, sanctionedAmt, new Date(),
                    rate, noOfInstal, instalAmt, sanctionedAmt, sanctionedAmt,
                    loan.purpose || '', 0, penalrate
                ]);

                // Post Breakdown for Loan
                for (const detail of details) {
                    const amt = parseMoney(detail.trans_amt);
                    const headCode = detail.code || (loan.loantype === 'R' ? 'A1002' : 'A1047');

                    // Ledger Insert
                    console.log(`[PassTransaction] Posting to ledger: ${headCode}, Amount: ${amt}`);
                    await queryRunner.query(`
                        INSERT INTO ledger (
                            trans_no, trans_date, trans_type, code, mbno, acc_no, acc_type,
                            trans_amt, receipt_vchr_no, vchr_type, modeofpay, pl_balance,
                            narration, username, ledgerid
                        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
                    `, [
                        nextTransNo++, new Date(), 'P', headCode, loan.mbno,
                        loan.loancaseno, loan.loantype,
                        amt, voucherNo, 'JV', mode, 0,
                        detail.narration || '', postedBy, nextLedgerId++
                    ]);

                    // Cashbook Insert
                    let rcash = 0, rtransfer = 0, pcash = 0, ptransfer = 0;
                    if (mode === 'C') pcash = amt; else ptransfer = amt;

                    await queryRunner.query(`
                        INSERT INTO tblcashbook (headcode, headname, rcash, rtransfer, pcash, ptransfer, trans_date)
                        VALUES ($1, $2, $3, $4, $5, $6, $7)
                    `, [headCode, detail.narration || 'Loan Disbursement', rcash, rtransfer, pcash, ptransfer, new Date()]);
                }

                console.log(`[PassTransaction] Marking loan as PAID in loan_pending for case: ${loanCaseNo}`);
                await queryRunner.query(`UPDATE loan_pending SET flg_paid = 'Y' WHERE loancaseno::text = $1`, [loanCaseNo]);

            } else {
                // ==================== GENERIC POSTING LOGIC ====================
                console.log(`[PassTransaction] 📝 Processing GENERIC voucher: ${voucherNo}`);
                for (const detail of details) {
                    const amt = parseMoney(detail.trans_amt);
                    const headCode = detail.code || 'GL000';

                    // Ledger Insert (if member)
                    if (header.memberId) {
                        console.log(`[PassTransaction] Posting member ledger: ${header.memberId}, Code: ${headCode}`);
                        await queryRunner.query(`
                            INSERT INTO ledger (
                                trans_no, trans_date, trans_type, code, mbno,
                                trans_amt, receipt_vchr_no, vchr_type, modeofpay, pl_balance,
                                narration, username, ledgerid
                            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
                        `, [
                            nextTransNo++, new Date(), 'P', headCode, header.memberId,
                            amt, voucherNo, 'JV', mode, 0,
                            detail.narration || header.description, postedBy, nextLedgerId++
                        ]);
                    }

                    // Cashbook Insert
                    let rcash = 0, rtransfer = 0, pcash = 0, ptransfer = 0;
                    if (mode === 'C') pcash = amt; else ptransfer = amt;

                    await queryRunner.query(`
                        INSERT INTO tblcashbook (headcode, headname, rcash, rtransfer, pcash, ptransfer, trans_date)
                        VALUES ($1, $2, $3, $4, $5, $6, $7)
                    `, [headCode, detail.narration || header.description, rcash, rtransfer, pcash, ptransfer, new Date()]);
                }
            }

            // 8. Update Voucher and Transaction flags
            console.log(`[PassTransaction] Finalizing voucher status: ${voucherNo}`);
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
            await queryRunner.query(`DELETE FROM ledger WHERE "receipt_vchr_no" = $1`, [voucherNo]);

            // 4. Remove from tblcashbook (If voucher_no exists there, but archive suggests it doesn't)
            // For now, if tblcashbook has no unique identifier linked to voucher, it's hard to reverse selectively.
            // Some legacy systems use date + headcode + amount.
            // await queryRunner.query(`DELETE FROM tblcashbook WHERE "vchr_no" = $1`, [voucherNo]);

            // 5. Remove/Deactivate from loan_master
            if (loanCaseNo) {
                await queryRunner.query(`DELETE FROM loan_master WHERE "loancaseno"::text = $1`, [loanCaseNo]);
            }

            // 6. Reset Flags
            await queryRunner.query(`UPDATE vouchers SET status = 'PENDING', "authorizedAt" = NULL WHERE "voucherNumber" = $1`, [voucherNo]);
            await queryRunner.query(`UPDATE transactions SET pass_flag = 'N' WHERE receipt_vchr_no = $1`, [voucherNo]);
            await queryRunner.query(`UPDATE loan_pending SET flg_paid = 'N' WHERE loancaseno::text = $1`, [loanCaseNo]);

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
