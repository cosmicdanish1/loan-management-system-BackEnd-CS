import { Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { SystemConfigService } from '../../admin/services/system-config.service';

/**
 * Pass Transaction Service - Handles final posting of transactions.
 * 
 * @version 2.1 - Refactored to use standard legacy tables (vouchers, transactions, ledger, tblcashbook)
 */
@Injectable()
export class PassTransactionService {
    private readonly logger = new Logger(PassTransactionService.name);

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

            this.logger.log(`Starting Pass Transaction for voucher: ${voucherNo}`);

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
            this.logger.log(`Found ${details.length} transaction details for voucher ${voucherNo}`);

            // 4. Get Next IDs for Ledger
            const maxLedgerIdResult = await queryRunner.query("SELECT COALESCE(MAX(ledgerid), 0) as max_id FROM ledger");
            let nextLedgerId = parseInt(maxLedgerIdResult[0].max_id) + 1;

            const maxTransNoResult = await queryRunner.query("SELECT COALESCE(MAX(trans_no), 0) as max_no FROM ledger");
            let nextTransNo = parseInt(maxTransNoResult[0].max_no) + 1;

            // T=Transfer (bank), C=Cash. Loan vouchers carry PAY_MODE in remarks
            // (PAY_MODE:CASH|BANK); generic vouchers carry it on the bankName/cheque columns.
            const payModeMatch = (header.remarks || '').match(/PAY_MODE:(\w+)/i);
            const isBankMode = payModeMatch
                ? payModeMatch[1].toLowerCase() === 'bank'
                : !!(header.bankName || header.chequeNumber);
            const mode = isBankMode ? 'T' : 'C';

            const parseMoney = (val: any) => {
                if (!val) return 0;
                return parseFloat(val.toString().replace(/[^0-9.-]+/g, "")) || 0;
            };

            if (isLoanVoucher) {
                // ==================== LOAN SPECIFIC LOGIC ====================
                this.logger.log(`Processing LOAN voucher for case: ${loanCaseNo}`);
                const lpQuery = `SELECT * FROM loan_pending WHERE loancaseno::text = $1`;
                const lpResult = await queryRunner.query(lpQuery, [loanCaseNo]);
                if (lpResult.length === 0) throw new Error(`Loan case ${loanCaseNo} not found in loan_pending`);
                const loan = lpResult[0];

                let rate = 12, penalrate = 2;
                try {
                    const rateKey = (loan.loantype === 'R' || loan.loantype === 'REG') ? 'RULE_LOAN_LT_INTEREST_RATE' : 'RULE_LOAN_EL_INTEREST_RATE';
                    rate = await this.systemConfigService.getConfigValue(rateKey);
                } catch (e) {
                    this.logger.warn(`Could not fetch interest rate for ${loan.loantype}, using default 12%`);
                }

                const sanctionedAmt = parseMoney(loan.sanctioned_amt);
                const noOfInstal = loan.no_of_instal || 1;
                const instalAmt = Math.round(sanctionedAmt / noOfInstal);

                // Activate Loan (if not already created by generateLoanVoucher)
                const existingLoan = await queryRunner.query(
                    `SELECT 1 FROM loan_master WHERE loancaseno::text = $1`, [loan.loancaseno]
                );
                if (existingLoan.length === 0) {
                    this.logger.log(`Activating loan in loan_master for mbno: ${loan.mbno}`);
                    await queryRunner.query(`
                        INSERT INTO loan_master (
                            mbno, loantype, loancaseno, loan_amt, payment_date,
                            rate, no_of_instal, instal_amt, balance, openbalance,
                            purpose, intt_amount, penalrate
                        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
                    `, [
                        loan.mbno, loan.loantype, loan.loancaseno, sanctionedAmt, new Date(),
                        rate, noOfInstal, instalAmt, sanctionedAmt, 0,
                        loan.purpose || '', 0, penalrate
                    ]);
                } else {
                    this.logger.log(`loan_master already exists for case ${loan.loancaseno}, skipping`);
                }

                // Post Breakdown for Loan — Payment lines DR the head (loan disbursed),
                // Receipt (deduction) lines CR the head. Track the net cash actually paid out.
                let netCashOut = 0; // gross disbursement − deductions
                for (const detail of details) {
                    const amt = parseMoney(detail.trans_amt);
                    const headCode = detail.code || (loan.loantype === 'RLN' ? 'A1002' : 'A1047');
                    const isReceipt = (detail.trans_type === 'CR' || detail.trans_type === 'R');
                    const drcr = isReceipt ? 'CR' : 'DR';
                    netCashOut += isReceipt ? -amt : amt;

                    // Ledger Insert (proper DR/CR — was hardcoded 'P', which broke head-balance maths)
                    this.logger.log(`Posting to ledger: ${drcr} ${headCode}, Amount: ${amt}`);
                    await queryRunner.query(`
                        INSERT INTO ledger (
                            trans_no, trans_date, trans_type, code, mbno, acc_no, acc_type,
                            trans_amt, receipt_vchr_no, vchr_type, modeofpay, pl_balance,
                            narration, username, ledgerid
                        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
                    `, [
                        nextTransNo++, new Date(), drcr, headCode, loan.mbno,
                        loan.loancaseno, loan.loantype,
                        amt, voucherNo, 'JV', mode, 0,
                        detail.narration || '', postedBy, nextLedgerId++
                    ]);

                    // Cashbook Insert — receipts are inflows, payments are outflows
                    let rcash = 0, rtransfer = 0, pcash = 0, ptransfer = 0;
                    if (isReceipt) { if (mode === 'C') rcash = amt; else rtransfer = amt; }
                    else { if (mode === 'C') pcash = amt; else ptransfer = amt; }

                    await queryRunner.query(`
                        INSERT INTO tblcashbook (headcode, headname, rcash, rtransfer, pcash, ptransfer, trans_date)
                        VALUES ($1, $2, $3, $4, $5, $6, $7)
                    `, [headCode, detail.narration || 'Loan Disbursement', rcash, rtransfer, pcash, ptransfer, new Date()]);
                }

                // Balancing cash/bank ledger leg — CR the net paid out so the ledger self-balances
                // (DR loan = CR deductions + CR cash). Cash → A1001/CINH, bank → the captured account.
                if (Math.round(netCashOut * 100) !== 0) {
                    const bankMatch = (header.remarks || '').match(/BANK:([^|]*)/);
                    const bankCode = (bankMatch && bankMatch[1].trim()) ? bankMatch[1].trim() : 'A1008';
                    const cashCode = mode === 'C' ? 'A1001' : bankCode;
                    const cashAccType = mode === 'C' ? 'CINH' : 'BANK';
                    const cashDrCr = netCashOut > 0 ? 'CR' : 'DR';
                    await queryRunner.query(`
                        INSERT INTO ledger (
                            trans_no, trans_date, trans_type, code, mbno, acc_no, acc_type,
                            trans_amt, receipt_vchr_no, vchr_type, modeofpay, pl_balance,
                            narration, username, ledgerid
                        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
                    `, [
                        nextTransNo++, new Date(), cashDrCr, cashCode, loan.mbno,
                        loan.loancaseno, cashAccType,
                        Math.abs(netCashOut), voucherNo, 'JV', mode, 0,
                        'Loan Disbursement - Cash/Bank Payout', postedBy, nextLedgerId++
                    ]);
                }

                this.logger.log(`Marking loan as PAID in loan_pending for case: ${loanCaseNo}`);
                await queryRunner.query(`UPDATE loan_pending SET flg_paid = 'Y' WHERE loancaseno::text = $1`, [loanCaseNo]);

                // Update member_balances to reflect the new outstanding principal
                const isEmergencyDisb = (loan.loantype === 'ELN' || (loan.loantype || '').toUpperCase().includes('EMERGENCY'));
                if (isEmergencyDisb) {
                    await queryRunner.query(
                        `UPDATE member_balances SET emergency_loan_balance = COALESCE(emergency_loan_balance, 0) + $1 WHERE mbno = $2`,
                        [sanctionedAmt, loan.mbno]
                    );
                } else {
                    await queryRunner.query(
                        `UPDATE member_balances SET regularloan = COALESCE(regularloan, 0) + $1 WHERE mbno = $2`,
                        [sanctionedAmt, loan.mbno]
                    );
                }
                this.logger.log(`member_balances updated (+${sanctionedAmt}) for mbno: ${loan.mbno}`);

                // Auto-update Share Value and create FD from deduction entries
                for (const detail of details) {
                    const amt = parseMoney(detail.trans_amt);
                    if (amt <= 0) continue;
                    const isReceipt = (detail.trans_type === 'CR' || detail.trans_type === 'R');
                    if (!isReceipt) continue;

                    const headCode = detail.code || '';

                    // Share Value deduction (L1001) → increase member_balances.shares
                    if (headCode === 'L1001') {
                        await queryRunner.query(
                            `UPDATE member_balances SET shares = COALESCE(shares::numeric, 0) + $1 WHERE mbno = $2`,
                            [amt, loan.mbno]
                        );
                        this.logger.log(`Share Value increased by ₹${amt} for mbno: ${loan.mbno}`);
                    }

                    // Fixed Deposit deduction (A003) → create new FD in fdmaster
                    if (headCode === 'A003') {
                        const nextAccResult = await queryRunner.query(
                            `SELECT COALESCE(MAX(account_number::int), 500000) + 2 AS next_acc FROM fdmaster WHERE fdrdflag = 'F'`
                        );
                        const nextAccNo = String(nextAccResult[0]?.next_acc || 500002);

                        const memberResult = await queryRunner.query(
                            `SELECT f_name, m_name, l_name FROM member_master WHERE mbno = $1`, [loan.mbno]
                        );
                        const mem = memberResult[0] || {};

                        const depDate = new Date();
                        const matDate = new Date();
                        matDate.setFullYear(matDate.getFullYear() + 1);

                        await queryRunner.query(
                            `INSERT INTO fdmaster (mbno, account_number, prefix, f_name, m_name, l_name, certno, depunit, depperiod, rate, depdate, matdate, fdamount, matamount, interestbalance, interestpayamentmode, interestamount, intpaid, status, nominee, nage, naddr, nrelation, fdrdflag, remarks, openbal, operationmode, intcalmethod, headcode)
                             VALUES ($1, $2, '', $3, $4, $5, '', 2, 1, 0, $6, $7, $8, $8, 0, 1, 0, 0, '0', '', '', '', '', 'F', $9, 0, 1, 1, 'A003')`,
                            [
                                loan.mbno, nextAccNo,
                                mem.f_name || '', mem.m_name || '', mem.l_name || '',
                                depDate, matDate, amt,
                                `Auto FD from Loan Case ${loanCaseNo} (5% rule)`
                            ]
                        );
                        this.logger.log(`Created FD account ${nextAccNo} for ₹${amt} for mbno: ${loan.mbno}`);
                    }
                }

            } else {
                // ==================== GENERIC / JOURNAL VOUCHER POSTING ====================
                this.logger.log(`Processing GENERIC/JV voucher: ${voucherNo}`);

                for (const detail of details) {
                    const amt = parseMoney(detail.trans_amt);
                    const headCode = detail.code || 'GL000';
                    const drcr = (detail.trans_type === 'CR' || detail.trans_type === 'R') ? 'CR' : 'DR';
                    const mbno = detail.mbno || header.memberId || null;

                    // Ledger Insert
                    this.logger.log(`Posting ledger: ${drcr} ${headCode} ${amt} mbno:${mbno}`);
                    await queryRunner.query(`
                        INSERT INTO ledger (
                            trans_no, trans_date, trans_type, code, mbno, acc_no, acc_type,
                            trans_amt, receipt_vchr_no, vchr_type, modeofpay, pl_balance,
                            narration, username, ledgerid
                        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'JV', $10, 0, $11, $12, $13)
                    `, [
                        nextTransNo++, new Date(), drcr, headCode, mbno,
                        detail.acc_no || 0, detail.acc_type || 'JV',
                        amt, voucherNo, mode,
                        detail.narration || header.description, postedBy, nextLedgerId++
                    ]);

                    // Journal entries do not touch cashbook (no cash movement — pure accounting transfer)
                    // Only Payment (P) and Receipt (R) vouchers should update tblcashbook

                    // Member balance update (if member number present)
                    if (mbno) {
                        const balCol = this.getBalanceColumn(headCode);
                        if (balCol) {
                            const balRes = await queryRunner.query(
                                `SELECT COALESCE(${balCol.col}, 0) as bal FROM member_balances WHERE mbno = $1`, [mbno]
                            );
                            if (balRes.length > 0) {
                                const curBal = parseFloat(balRes[0].bal) || 0;
                                const newBal = balCol.type === 'LIABILITY'
                                    ? (drcr === 'CR' ? curBal + amt : curBal - amt)
                                    : (drcr === 'CR' ? curBal - amt : curBal + amt);
                                await queryRunner.query(
                                    `UPDATE member_balances SET ${balCol.col} = $1 WHERE mbno = $2`,
                                    [newBal, mbno]
                                );
                                this.logger.log(`Balance ${balCol.col}: ${curBal} → ${newBal} for mbno ${mbno}`);
                            }
                        }
                    }
                }
            }

            // 8. Update Voucher and Transaction flags
            this.logger.log(`Finalizing voucher status: ${voucherNo}`);
            await queryRunner.query(`UPDATE vouchers SET status = 'POSTED', "authorizedAt" = NOW() WHERE "voucherNumber" = $1`, [voucherNo]);
            await queryRunner.query(`UPDATE transactions SET pass_flag = 'Y' WHERE receipt_vchr_no = $1`, [voucherNo]);

            await queryRunner.commitTransaction();
            this.logger.log(`Transaction passed successfully: ${voucherNo}`);

            // Auto-queue notification for loan postings
            if (isLoanVoucher && loanCaseNo) {
                try {
                    const { autoQueueNotification } = require('../../shared/utils/auto-notify');
                    autoQueueNotification(this.dataSource, String(header.memberId || ''),
                        `Your loan transaction has been posted to ledger. Voucher: ${voucherNo}. — FIBE Credit Society`,
                        'TRANSACTION_POSTED'
                    ).catch(() => {});
                } catch {}
            }

            return { success: true, message: 'Transaction posted successfully' };

        } catch (error: any) {
            await queryRunner.rollbackTransaction();
            this.logger.error('Posting failed:', error);
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

            this.logger.log(`Reversing Transaction: ${voucherNo}`);

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

            // 5. Remove/Deactivate from loan_master and roll back member_balances
            if (loanCaseNo) {
                const loanInfoResult = await queryRunner.query(
                    `SELECT mbno, loantype, loan_amt FROM loan_master WHERE loancaseno::text = $1`,
                    [loanCaseNo]
                );
                await queryRunner.query(`DELETE FROM loan_master WHERE "loancaseno"::text = $1`, [loanCaseNo]);

                if (loanInfoResult.length > 0) {
                    const li = loanInfoResult[0];
                    const disbAmt = parseFloat(li.loan_amt || 0);
                    const isEmergencyRev = (li.loantype === 'ELN' || (li.loantype || '').toUpperCase().includes('EMERGENCY'));
                    if (isEmergencyRev) {
                        await queryRunner.query(
                            `UPDATE member_balances SET emergency_loan_balance = GREATEST(0, COALESCE(emergency_loan_balance, 0) - $1) WHERE mbno = $2`,
                            [disbAmt, li.mbno]
                        );
                    } else {
                        await queryRunner.query(
                            `UPDATE member_balances SET regularloan = GREATEST(0, COALESCE(regularloan, 0) - $1) WHERE mbno = $2`,
                            [disbAmt, li.mbno]
                        );
                    }
                    this.logger.log(`member_balances rolled back (-${disbAmt}) for mbno: ${li.mbno}`);
                }
            }

            // 6. Reset Flags
            await queryRunner.query(`UPDATE vouchers SET status = 'PENDING', "authorizedAt" = NULL WHERE "voucherNumber" = $1`, [voucherNo]);
            await queryRunner.query(`UPDATE transactions SET pass_flag = 'N' WHERE receipt_vchr_no = $1`, [voucherNo]);
            await queryRunner.query(`UPDATE loan_pending SET flg_paid = 'N' WHERE loancaseno::text = $1`, [loanCaseNo]);

            await queryRunner.commitTransaction();
            this.logger.log(`Transaction reversed: ${voucherNo}`);

            return { success: true, message: 'Transaction reversed and moved back to pending status' };

        } catch (error: any) {
            await queryRunner.rollbackTransaction();
            this.logger.error('Reversal failed:', error);
            throw new Error('Failed to reverse transaction: ' + error.message);
        } finally {
            await queryRunner.release();
        }
    }

    private getBalanceColumn(headCode: string): { col: string; type: 'LIABILITY' | 'ASSET' } | null {
        const map: Record<string, { col: string; type: 'LIABILITY' | 'ASSET' }> = {
            'A1047': { col: 'emergency_loan_balance', type: 'ASSET' },
            'A1002': { col: 'regularloan', type: 'ASSET' },
        };
        return map[headCode] || null;
    }
}
