import { Injectable, Logger, BadRequestException } from '@nestjs/common';
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
                throw new BadRequestException('Voucher header not found or already posted');
            }
            const header = headerResult[0];

            // Every row this posting writes carries the voucher's own date, not the
            // wall clock. Previously ledger/tblcashbook were stamped with new Date(),
            // so a backdated voucher showed its real date on the voucher screens but
            // today's date in Cash Book, Day Book, General Ledger and Member Ledger —
            // the same transaction reading differently in five windows.
            const postingDate = header.voucherDate ? new Date(header.voucherDate) : new Date();

            // 2. Determine if this is a Loan Disbursement or Generic Voucher
            const remarksMatch = (header.remarks || '').match(/LOAN_CASE:([^|]+)/);
            const isLoanVoucher = !!remarksMatch;
            const loanCaseNo = remarksMatch ? remarksMatch[1] : null;

            // 3. Fetch breakdown details from transactions table
            const detailsQuery = `SELECT * FROM transactions WHERE receipt_vchr_no = $1 AND pass_flag = 'N'`;
            const details = await queryRunner.query(detailsQuery, [voucherNo]);
            this.logger.log(`Found ${details.length} transaction details for voucher ${voucherNo}`);

            // 4. Get Next IDs for Ledger
            // BUG FIX 35 (same as voucher.service.ts / compulsory-deposit / journal-transfer):
            // `ledger` has no unique constraint on ledgerid or trans_no (confirmed via
            // pg_constraint — NOT NULL only), so two concurrent postings could both read the
            // same MAX and both INSERT successfully, silently producing duplicate ledger ids on
            // the actual books. The advisory lock is held for the rest of this transaction, so
            // it also covers the nextTransNo++/nextLedgerId++ increments used throughout the
            // posting loops below.
            await queryRunner.query(`SELECT pg_advisory_xact_lock(hashtext('ledger'))`);
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
                // Standard reducing-balance EMI — same fix as generateLoanVoucher's
                // instalAmt (this is only the fallback path when that one is skipped).
                const monthlyRate = (parseFloat(rate as any) || 12) / 100 / 12;
                const instalAmt = monthlyRate > 0
                    ? Math.round((sanctionedAmt * monthlyRate * Math.pow(1 + monthlyRate, noOfInstal) / (Math.pow(1 + monthlyRate, noOfInstal) - 1)) * 100) / 100
                    : Math.round(sanctionedAmt / noOfInstal);

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
                        loan.mbno, loan.loantype, loan.loancaseno, sanctionedAmt, postingDate,
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
                        nextTransNo++, postingDate, drcr, headCode, loan.mbno,
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
                    `, [headCode, detail.narration || 'Loan Disbursement', rcash, rtransfer, pcash, ptransfer, postingDate]);
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
                        nextTransNo++, postingDate, cashDrCr, cashCode, loan.mbno,
                        loan.loancaseno, cashAccType,
                        Math.abs(netCashOut), voucherNo, 'JV', mode, 0,
                        'Loan Disbursement - Cash/Bank Payout', postedBy, nextLedgerId++
                    ]);
                }

                this.logger.log(`Marking loan as PAID in loan_pending for case: ${loanCaseNo}`);
                await queryRunner.query(`UPDATE loan_pending SET flg_paid = 'Y' WHERE loancaseno::text = $1`, [loanCaseNo]);

                // Update member_balances to reflect the new outstanding principal
                // BUG FIX 37: this tested only for 'ELN' (or a name containing "EMERGENCY"), but
                // ALN is the loan type every real loan in this system actually uses — confirmed
                // live, zero RLN/ELN rows exist. So every emergency loan fell through to the
                // `else` and was added to regularloan instead of emergency_loan_balance.
                // Verified: a ₹20,000 ALN disbursement credited regularloan=20000.00.
                // This also contradicted getBalanceColumn() in this same file, which correctly
                // maps the ALN/emergency GL head A1047 → emergency_loan_balance.
                const isEmergencyDisb = (['ELN', 'ALN', 'A', 'E', 'EMR', 'ADD'].includes((loan.loantype || '').toUpperCase())
                    || (loan.loantype || '').toUpperCase().includes('EMERGENCY'));
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

                        const depDate = new Date(postingDate);
                        const matDate = new Date(postingDate);
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

                // BUG FIX: this branch is the only posting path for every non-loan voucher type
                // routed through Pass Transactions — Journal Transfer, and (as of this fix) FD
                // Interest Payout / FD Closure, which used to bypass Pass Transactions entirely
                // by posting straight to `ledger` at voucher-creation time (see
                // fixed-deposit.service.ts). It always hardcoded vchr_type='JV' and, per its own
                // now-stale comment, never wrote tblcashbook at all — correct for a pure Journal
                // Transfer (no cash moves), but wrong for FD Interest/Closure, which physically
                // pay cash out. `header.voucherType` (set at creation) now decides both.
                const isJournalVoucher = (header.voucherType || '').toUpperCase() === 'JOURNAL';
                const genericVchrType = isJournalVoucher ? 'JV' : 'P';

                for (const detail of details) {
                    const amt = parseMoney(detail.trans_amt);
                    const headCode = detail.code || 'GL000';
                    const drcr = (detail.trans_type === 'CR' || detail.trans_type === 'R') ? 'CR' : 'DR';
                    const mbno = detail.mbno || header.memberId || null;
                    const accType = (detail.acc_type || 'JV').toString().trim().toUpperCase();
                    const legMode = detail.modeofpay === 'B' ? 'B' : (detail.modeofpay === 'C' ? 'C' : mode);

                    // Ledger Insert
                    this.logger.log(`Posting ledger: ${drcr} ${headCode} ${amt} mbno:${mbno}`);
                    await queryRunner.query(`
                        INSERT INTO ledger (
                            trans_no, trans_date, trans_type, code, mbno, acc_no, acc_type,
                            trans_amt, receipt_vchr_no, vchr_type, modeofpay, pl_balance,
                            narration, username, ledgerid
                        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 0, $12, $13, $14)
                    `, [
                        nextTransNo++, postingDate, drcr, headCode, mbno,
                        detail.acc_no || 0, detail.acc_type || 'JV',
                        amt, voucherNo, genericVchrType,
                        legMode,
                        detail.narration || header.description, postedBy, nextLedgerId++
                    ]);

                    // Cash Book leg — only for real Payment/Receipt vouchers (pure Journal
                    // Transfers move nothing physical, so they correctly skip this), and only on
                    // the leg that's actually cash/bank (CINH/BANK), not every line of the
                    // voucher. DR on a cash/bank head = money coming in (receipt); CR = money
                    // going out (payment) — mirrors the loan-disbursement branch's convention.
                    if (!isJournalVoucher && (accType === 'CINH' || accType === 'BANK')) {
                        const isReceiptLeg = drcr === 'DR';
                        let rcash = 0, rtransfer = 0, pcash = 0, ptransfer = 0;
                        if (isReceiptLeg) { if (legMode === 'C') rcash = amt; else rtransfer = amt; }
                        else { if (legMode === 'C') pcash = amt; else ptransfer = amt; }
                        await queryRunner.query(`
                            INSERT INTO tblcashbook (headcode, headname, rcash, rtransfer, pcash, ptransfer, trans_date)
                            VALUES ($1, $2, $3, $4, $5, $6, $7)
                        `, [headCode, detail.narration || header.description || 'Transaction', rcash, rtransfer, pcash, ptransfer, postingDate]);
                    }

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

            // 7b. Cash-in-hand sufficiency check.
            //
            // BUG FIX 38: nothing anywhere verified that the paying account could actually cover
            // a cash payout. Confirmed live: a ₹4,94,550 cash loan disbursement was posted against
            // a cash-in-hand balance that was ALREADY negative (₹-31,425), taking it to ₹-5,25,975.
            // Cash in hand is a physical drawer — it cannot go below zero, so a negative balance
            // means the books no longer describe reality.
            //
            // Scoped deliberately:
            //  - CINH-type heads only. Bank accounts are left alone since an overdraft facility is
            //    a real product and blocking those could be wrong for this society.
            //  - Only blocks when THIS voucher is a net cash OUTflow on that head. A receipt that
            //    moves cash from -5,000 to -3,000 is an improvement and must still be allowed,
            //    otherwise an already-negative drawer could never be corrected.
            // This runs inside the transaction, after every ledger write, so the balance it reads
            // includes this voucher — and throwing here rolls the whole posting back.
            const cashHeads = await queryRunner.query(`
                SELECT l.code,
                       SUM(CASE WHEN l.trans_type = 'DR' THEN l.trans_amt::numeric ELSE -l.trans_amt::numeric END) AS voucher_delta
                FROM ledger l
                JOIN headmaster h ON h.code = l.code
                WHERE l.receipt_vchr_no = $1 AND TRIM(h.headtype) = 'CINH'
                GROUP BY l.code
            `, [voucherNo]);

            for (const ch of cashHeads) {
                const delta = Number(ch.voucher_delta) || 0;
                if (delta >= 0) continue; // net inflow (or neutral) — always allowed

                const balRes = await queryRunner.query(`
                    SELECT COALESCE(SUM(CASE WHEN trans_type = 'DR' THEN trans_amt::numeric ELSE -trans_amt::numeric END), 0) AS balance
                    FROM ledger WHERE code = $1
                `, [ch.code]);
                const resultingBalance = Number(balRes[0]?.balance || 0);

                if (resultingBalance < 0) {
                    const available = resultingBalance - delta; // balance before this voucher
                    throw new BadRequestException(
                        `Insufficient cash in hand (${ch.code}). Available before this voucher: ` +
                        `₹${available.toLocaleString('en-IN')}. This voucher pays out ` +
                        `₹${Math.abs(delta).toLocaleString('en-IN')}, which would leave ` +
                        `₹${resultingBalance.toLocaleString('en-IN')}.`
                    );
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
            // BUG FIX 34 (same pattern as loan-sanction.service.ts): a deliberate, typed rejection
            // (e.g. the cash-sufficiency check above) was being re-wrapped in a plain Error, which
            // NestJS serves as HTTP 500 — indistinguishable from a real server fault. Let typed
            // exceptions through untouched; only genuine unexpected failures become 500s.
            if (error instanceof BadRequestException) throw error;
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
                throw new BadRequestException('Voucher header not found or is not in POSTED status');
            }
            const header = headerResult[0];

            // 2. Extract loan case no, if any.
            // BUG FIX: this used to throw ('Voucher metadata missing for reversal') whenever
            // the voucher wasn't a loan disbursement — confirmed live, reversing a freshly-posted
            // plain Journal Transfer voucher failed 100% of the time. LOAN_CASE is only ever
            // present on loan-disbursement vouchers (see voucher.service.ts), so every other
            // voucher type this app posts through Pass Transactions — Journal Transfer, Saving
            // Receipt/Payment, Compulsory Deposit, FD — could never be reversed. Loan case is now
            // optional; the loan-specific rollback below only runs when it's actually present.
            const remarksMatch = (header.remarks || '').match(/LOAN_CASE:([^|]+)/);
            const isLoanVoucher = !!remarksMatch;
            const loanCaseNo = remarksMatch ? remarksMatch[1] : null;

            // 3. Remove from Ledger
            await queryRunner.query(`DELETE FROM ledger WHERE "receipt_vchr_no" = $1`, [voucherNo]);

            // 4. Remove from tblcashbook (If voucher_no exists there, but archive suggests it doesn't)
            // For now, if tblcashbook has no unique identifier linked to voucher, it's hard to reverse selectively.
            // Some legacy systems use date + headcode + amount.
            // await queryRunner.query(`DELETE FROM tblcashbook WHERE "vchr_no" = $1`, [voucherNo]);

            if (isLoanVoucher) {
                // 5a. Remove/Deactivate from loan_master and roll back member_balances
                const loanInfoResult = await queryRunner.query(
                    `SELECT mbno, loantype, loan_amt FROM loan_master WHERE loancaseno::text = $1`,
                    [loanCaseNo]
                );
                await queryRunner.query(`DELETE FROM loan_master WHERE "loancaseno"::text = $1`, [loanCaseNo]);

                if (loanInfoResult.length > 0) {
                    const li = loanInfoResult[0];
                    const disbAmt = parseFloat(li.loan_amt || 0);
                    // BUG FIX 37 (reversal side — must mirror the disbursement classification
                    // above exactly, or a reversed ALN loan would credit back the wrong column
                    // and permanently skew both balances).
                    const isEmergencyRev = (['ELN', 'ALN', 'A', 'E', 'EMR', 'ADD'].includes((li.loantype || '').toUpperCase())
                        || (li.loantype || '').toUpperCase().includes('EMERGENCY'));
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

                await queryRunner.query(`UPDATE loan_pending SET flg_paid = 'N' WHERE loancaseno::text = $1`, [loanCaseNo]);
            } else {
                // 5b. Generic/journal voucher — undo any member_balances change the generic
                // branch of passTransaction() applied, by replaying the same head→column
                // mapping (getBalanceColumn) and inverting the DR/CR delta it used.
                const details = await queryRunner.query(
                    `SELECT mbno, code, trans_type, trans_amt FROM transactions WHERE receipt_vchr_no = $1`,
                    [voucherNo]
                );
                for (const detail of details) {
                    if (!detail.mbno) continue;
                    const balCol = this.getBalanceColumn(detail.code);
                    if (!balCol) continue;
                    const drcr = (detail.trans_type === 'CR' || detail.trans_type === 'R') ? 'CR' : 'DR';
                    const amt = parseFloat(detail.trans_amt) || 0;
                    const balRes = await queryRunner.query(
                        `SELECT COALESCE(${balCol.col}, 0) as bal FROM member_balances WHERE mbno = $1`, [detail.mbno]
                    );
                    if (balRes.length === 0) continue;
                    const curBal = parseFloat(balRes[0].bal) || 0;
                    // Inverse of passTransaction's forward formula for this balance type.
                    const newBal = balCol.type === 'LIABILITY'
                        ? (drcr === 'CR' ? curBal - amt : curBal + amt)
                        : (drcr === 'CR' ? curBal + amt : curBal - amt);
                    await queryRunner.query(
                        `UPDATE member_balances SET ${balCol.col} = $1 WHERE mbno = $2`,
                        [newBal, detail.mbno]
                    );
                    this.logger.log(`Reversed ${balCol.col}: ${curBal} → ${newBal} for mbno ${detail.mbno}`);
                }
            }

            // 6. Reset Flags
            await queryRunner.query(`UPDATE vouchers SET status = 'PENDING', "authorizedAt" = NULL WHERE "voucherNumber" = $1`, [voucherNo]);
            await queryRunner.query(`UPDATE transactions SET pass_flag = 'N' WHERE receipt_vchr_no = $1`, [voucherNo]);

            await queryRunner.commitTransaction();
            this.logger.log(`Transaction reversed: ${voucherNo}`);

            return { success: true, message: 'Transaction reversed and moved back to pending status' };

        } catch (error: any) {
            await queryRunner.rollbackTransaction();
            this.logger.error('Reversal failed:', error);
            // 5.1 fix: same pattern as BUG FIX 34 above — don't downgrade a typed
            // rejection to a generic Error (always served as 500).
            if (error instanceof BadRequestException) throw error;
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
