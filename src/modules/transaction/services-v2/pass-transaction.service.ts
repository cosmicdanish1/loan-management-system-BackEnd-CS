import { Injectable } from '@nestjs/common';
import { DataSource, QueryRunner } from 'typeorm';
import { SystemConfigService } from '../../admin/services/system-config.service';
import { calculateConstantEmi, persistRbSchedule } from '../../loan/services-v2/loan-rb-schedule.util';
import { LoanEligibilityService } from '../../loan/services-v2/loan-eligibility.service';
import { RdBalanceEventsService } from '../../rd/services/rd-balance-events.service';
import { isDebitNormal } from '../../shared/utils/balance-direction';

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
        private readonly loanEligibilityService: LoanEligibilityService,
        private readonly rdBalanceEventsService: RdBalanceEventsService,
    ) { }

    /** Current financial year per the real yearend table, read within the
     *  caller's own transaction — same April-March convention the RD system
     *  uses everywhere else. */
    private async getCurrentYearcode(queryRunner: QueryRunner): Promise<number | null> {
        const rows = await queryRunner.query(
            `SELECT yearcode FROM yearend WHERE start_date <= NOW() AND end_date >= NOW() LIMIT 1`,
        );
        return rows[0] ? Number(rows[0].yearcode) : null;
    }

    /**
     * Direction for an INCREASE to the given head — 'DR' for a debit-normal
     * head (Asset/Expense), 'CR' for a credit-normal one (Liability/Income/
     * Reserve), per headmaster.pflag (same convention already relied on by
     * the General Ledger report's opening/closing-balance formula). Loan
     * disbursement always increases the loan-account head (a debit-normal
     * Asset) and, when withheld into RD/Share instead of cash, increases
     * those liability heads too — so this one lookup correctly drives both.
     */
    private async increaseDirection(queryRunner: QueryRunner, headCode: string): Promise<'DR' | 'CR'> {
        const rows = await queryRunner.query(`SELECT pflag FROM headmaster WHERE code = $1`, [headCode]);
        return isDebitNormal(rows[0]?.pflag) ? 'DR' : 'CR';
    }

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

                // Penal rate, grace days, and same-month penal %/divisor — all
                // configured PER LOAN TYPE on the "Modify Business Rules" screen
                // (busrules.{type}penalrate/{type}gracedays/{type}smpct/{type}smdiv).
                // Previously penalrate was hardcoded to 2 for every loan type, and
                // gracedays/smpenalpct/smpenaldiv were never read at all — every
                // real loan got gracedays=0 (grace period silently non-functional,
                // even a payment made exactly on the due date was charged a
                // penalty) regardless of what was configured. Lives in a separate
                // config table (busrules) from systemConfigService's own store,
                // hence the direct query here rather than going through that
                // service. Column names are built from a whitelist, never from
                // unvalidated input, before being interpolated into SQL.
                let gracedays = 0, smpenalpct = 1, smpenaldiv = 4;
                try {
                    const KNOWN_PREFIXES = ['rln', 'eln', 'aln', 'edl', 'fln'];
                    const upperType = (loan.loantype || '').toUpperCase();
                    let prefix = upperType.toLowerCase();
                    if (!KNOWN_PREFIXES.includes(prefix)) {
                        // Same classification used elsewhere for "which bucket does
                        // this loan type belong to" — falls back to 'rln' (regular)
                        // for anything unrecognized, matching the loan_master
                        // default when nothing better is known.
                        prefix = (['ELN', 'ALN', 'A', 'E', 'EMR', 'ADD'].includes(upperType) || upperType.includes('EMERGENCY'))
                            ? 'aln' : 'rln';
                    }
                    const busRulesRows = await queryRunner.query(
                        `SELECT ${prefix}penalrate, ${prefix}gracedays, ${prefix}smpct, ${prefix}smdiv
                         FROM busrules ORDER BY appdate DESC LIMIT 1`
                    );
                    const row = busRulesRows[0] || {};
                    const configuredPenalRate = parseFloat(row[`${prefix}penalrate`]);
                    if (!isNaN(configuredPenalRate) && configuredPenalRate > 0) penalrate = configuredPenalRate;
                    const configuredGraceDays = parseInt(row[`${prefix}gracedays`], 10);
                    if (!isNaN(configuredGraceDays) && configuredGraceDays >= 0) gracedays = configuredGraceDays;
                    const configuredSmPct = parseFloat(row[`${prefix}smpct`]);
                    if (!isNaN(configuredSmPct) && configuredSmPct >= 0) smpenalpct = configuredSmPct;
                    const configuredSmDiv = parseFloat(row[`${prefix}smdiv`]);
                    if (!isNaN(configuredSmDiv) && configuredSmDiv > 0) smpenaldiv = configuredSmDiv;
                } catch (e) {
                    console.warn(`[PassTransaction] Could not fetch penal/grace rules from busrules for ${loan.loantype}, using defaults`);
                }

                const sanctionedAmt = parseMoney(loan.sanctioned_amt);
                const noOfInstal = loan.no_of_instal || 1;

                // Cooperative society's own interest rule (not standard bank
                // EMI amortization): equal-principal reducing-balance schedule
                // sized over the original term, plus 1 or 2 extra months of
                // interest on the full principal depending on which
                // application-date slot the member applied in (departmental/
                // salary-deduction processing delay). See loan-rb-schedule.util.ts
                // for the full method and rationale.
                const appDate = loan.app_date ? new Date(loan.app_date) : new Date();
                const emiCalc = calculateConstantEmi(sanctionedAmt, rate, noOfInstal, appDate);
                const instalAmt = emiCalc.constantEMI;
                console.log(`[PassTransaction] Slot ${emiCalc.slot} (+${emiCalc.delayMonths}mo) — RB interest=${emiCalc.totalRBInterest}, delay interest=${emiCalc.delayInterest}, constant EMI=${instalAmt}`);

                // Activate Loan
                const insertLoanMasterQuery = `
                    INSERT INTO loan_master (
                        mbno, loantype, loancaseno, loan_amt, payment_date,
                        rate, no_of_instal, instal_amt, balance, openbalance,
                        purpose, intt_amount, penalrate, gracedays, smpenalpct, smpenaldiv
                    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
                `;
                console.log(`[PassTransaction] Activating loan in loan_master for mbno: ${loan.mbno}`);
                await queryRunner.query(insertLoanMasterQuery, [
                    loan.mbno, loan.loantype, loan.loancaseno, sanctionedAmt, new Date(),
                    rate, noOfInstal, instalAmt, sanctionedAmt, 0,  // balance=sanctionedAmt, openbalance=0 (matches legacy)
                    loan.purpose || '', emiCalc.monthlyInterestForEMI, penalrate, gracedays, smpenalpct, smpenaldiv
                ]);

                // Persist the true reducing-balance schedule separately from
                // the flat instal_amt above — early closure reads this table
                // for genuine accrued interest, never the constant-EMI split.
                await persistRbSchedule(queryRunner, loan.loancaseno, loan.mbno, emiCalc.rbSchedule);

                // Mirror of the decrement in loan-repayment.service.ts
                // (recordLoanRepayment / executeEarlyClosure) — until now
                // nothing on the disbursement side ever increased
                // member_balances, so the eligibility check in
                // loan-application.service.ts (which reads member_balances as
                // "current outstanding") never reflected a newly disbursed
                // loan; only repayments/closures ever moved the number, and
                // only downward. UPDATE...RETURNING falls back to INSERT for
                // members with no row yet — member_balances has no unique
                // constraint on mbno to UPSERT against.
                const isEmergencyLoan = (['ELN', 'ALN', 'A', 'E', 'EMR', 'ADD'].includes((loan.loantype || '').toUpperCase())
                    || (loan.loantype || '').toUpperCase().includes('EMERGENCY'));
                const balanceCol = isEmergencyLoan ? 'emergency_loan_balance' : 'regularloan';
                const balUpdateResult = await queryRunner.query(
                    `UPDATE member_balances SET ${balanceCol} = COALESCE(${balanceCol}, 0) + $1 WHERE mbno = $2 RETURNING mbno`,
                    [sanctionedAmt, loan.mbno]
                );
                if (balUpdateResult.length === 0) {
                    await queryRunner.query(
                        `INSERT INTO member_balances (mbno, emergency_loan_balance, regularloan) VALUES ($1, $2, $3)`,
                        [loan.mbno, isEmergencyLoan ? sanctionedAmt : 0, isEmergencyLoan ? 0 : sanctionedAmt]
                    );
                }

                // RD & Share Value requirement — per loan type, configurable and
                // defaulting to on (see loan-eligibility.service.ts). Any shortfall
                // is withheld from what's actually handed to the member, never
                // added on top of the sanctioned amount they owe: loan_master
                // above was already created for the FULL sanctionedAmt, but the
                // cash/transfer leg posted below is reduced by the shortfall, and
                // that same amount is separately credited to the RD/Share GL
                // heads instead of the member's hand.
                const deductions = await this.loanEligibilityService.getDisbursementDeductions(
                    loan.mbno, sanctionedAmt, loan.loantype,
                );
                let remainingDeduction = deductions.reduce((sum, d) => sum + d.amount, 0);
                if (remainingDeduction > 0) {
                    console.log(`[PassTransaction] RD/Share shortfall of ${remainingDeduction} being withheld from disbursement`);
                }

                // Post Breakdown for Loan
                for (const detail of details) {
                    const fullAmt = parseMoney(detail.trans_amt);
                    const withheld = Math.min(remainingDeduction, fullAmt);
                    remainingDeduction -= withheld;
                    const amt = fullAmt - withheld;
                    const headCode = detail.code || (loan.loantype === 'RLN' ? 'A1002' : 'A1047');

                    if (amt <= 0) continue; // fully withheld against the RD/Share shortfall

                    // Ledger Insert
                    // BUG FIX 41: was hardcoded 'P' (a payment/receipt marker, not a
                    // real accounting direction) for every leg regardless of which
                    // head it was — corrupting any report that classifies Debit vs
                    // Credit off trans_type (General Ledger, Member Ledger Report,
                    // Detail/Bank Detail Ledger). Disbursing a loan always increases
                    // this debit-normal Asset head, so this always resolves to 'DR'.
                    const loanLegDirection = await this.increaseDirection(queryRunner, headCode);
                    console.log(`[PassTransaction] Posting to ledger: ${headCode}, Amount: ${amt}, Type: ${loanLegDirection}`);
                    await queryRunner.query(`
                        INSERT INTO ledger (
                            trans_no, trans_date, trans_type, code, mbno, acc_no, acc_type,
                            trans_amt, receipt_vchr_no, vchr_type, modeofpay, pl_balance,
                            narration, username, ledgerid
                        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
                    `, [
                        nextTransNo++, new Date(), loanLegDirection, headCode, loan.mbno,
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

                // Post the withheld RD/Share amounts to their own GL heads —
                // same ledger/cashbook shape as the disbursement lines above,
                // just crediting the member's RD/Share pool instead of handing
                // them cash.
                for (const deduction of deductions) {
                    if (deduction.amount <= 0) continue;
                    // Same BUG FIX 41 as the disbursement leg above — crediting the
                    // member's RD/Share pool increases a credit-normal Liability
                    // head, so this always resolves to 'CR'.
                    const deductionDirection = await this.increaseDirection(queryRunner, deduction.code);
                    console.log(`[PassTransaction] Posting RD/Share deduction to ledger: ${deduction.code}, Amount: ${deduction.amount}, Type: ${deductionDirection}`);
                    await queryRunner.query(`
                        INSERT INTO ledger (
                            trans_no, trans_date, trans_type, code, mbno, acc_no, acc_type,
                            trans_amt, receipt_vchr_no, vchr_type, modeofpay, pl_balance,
                            narration, username, ledgerid
                        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
                    `, [
                        nextTransNo++, new Date(), deductionDirection, deduction.code, loan.mbno,
                        loan.loancaseno, loan.loantype,
                        deduction.amount, voucherNo, 'JV', mode, 0,
                        deduction.name, postedBy, nextLedgerId++
                    ]);

                    await queryRunner.query(`
                        INSERT INTO tblcashbook (headcode, headname, rcash, rtransfer, pcash, ptransfer, trans_date)
                        VALUES ($1, $2, 0, 0, 0, 0, $3)
                    `, [deduction.code, deduction.name, new Date()]);

                    // The RD balance timeline (rd_balance_events) must also
                    // reflect this addition — it's what the opening-balance
                    // interest calculator (Step 8) and the next loan's
                    // eligibility check (Step 9, above) both read as the
                    // member's current RD balance. Posted within THIS SAME
                    // transaction: if disbursement fails after this point and
                    // rolls back, the balance event rolls back with it (see
                    // appendEvent's externalQueryRunner handling).
                    if (deduction.kind === 'RD' && deduction.amount > 0) {
                        const yearcode = await this.getCurrentYearcode(queryRunner);
                        if (yearcode) {
                            await this.rdBalanceEventsService.recordLoanAddition(
                                loan.mbno, yearcode, deduction.amount, new Date(),
                                `RD shortfall withheld from loan ${loan.loancaseno} disbursement`,
                                postedBy, queryRunner,
                            );
                        } else {
                            console.warn(`[PassTransaction] No current financial year found — RD balance event for loan ${loan.loancaseno}'s shortfall was NOT recorded`);
                        }
                    }
                }

                console.log(`[PassTransaction] Marking loan as PAID in loan_pending for case: ${loanCaseNo}`);
                await queryRunner.query(`UPDATE loan_pending SET flg_paid = 'Y' WHERE loancaseno::text = $1`, [loanCaseNo]);

            } else {
                // ==================== GENERIC POSTING LOGIC ====================
                console.log(`[PassTransaction] 📝 Processing GENERIC voucher: ${voucherNo}`);
                for (const detail of details) {
                    const amt = parseMoney(detail.trans_amt);
                    const headCode = detail.code || 'GL000';
                    // BUG FIX: was hardcoded 'P' for all entries — a Receipt entry (trans_type='R')
                    // was being posted to the ledger as a Payment, corrupting debit/credit balances.
                    // Now uses the actual trans_type from the transactions table row.
                    const entryTransType = detail.trans_type || 'P';

                    // Ledger Insert (if member)
                    if (header.memberId) {
                        console.log(`[PassTransaction] Posting member ledger: ${header.memberId}, Code: ${headCode}, Type: ${entryTransType}`);
                        await queryRunner.query(`
                            INSERT INTO ledger (
                                trans_no, trans_date, trans_type, code, mbno,
                                trans_amt, receipt_vchr_no, vchr_type, modeofpay, pl_balance,
                                narration, username, ledgerid
                            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
                        `, [
                            nextTransNo++, new Date(), entryTransType, headCode, header.memberId,
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

            // 5. Remove/Deactivate from loan_master (and its RB schedule, so a
            // reversed-then-repassed loan gets a fresh schedule, not a stale one)
            if (loanCaseNo) {
                // Read the loan row BEFORE deleting it — need mbno/loantype/loan_amt
                // to undo the member_balances increment made at disbursement.
                const loanRows = await queryRunner.query(
                    `SELECT mbno, loantype, loan_amt FROM loan_master WHERE loancaseno::text = $1`,
                    [loanCaseNo]
                );
                await queryRunner.query(`DELETE FROM loan_master WHERE "loancaseno"::text = $1`, [loanCaseNo]);
                await queryRunner.query(`DELETE FROM loan_rb_schedule WHERE loancaseno::text = $1`, [loanCaseNo]);

                if (loanRows.length > 0) {
                    const loan = loanRows[0];
                    const isEmergencyLoan = (['ELN', 'ALN', 'A', 'E', 'EMR', 'ADD'].includes((loan.loantype || '').toUpperCase())
                        || (loan.loantype || '').toUpperCase().includes('EMERGENCY'));
                    const balanceCol = isEmergencyLoan ? 'emergency_loan_balance' : 'regularloan';
                    await queryRunner.query(
                        `UPDATE member_balances SET ${balanceCol} = GREATEST(0, COALESCE(${balanceCol}, 0) - $1) WHERE mbno = $2`,
                        [parseFloat(loan.loan_amt) || 0, loan.mbno]
                    );
                }
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
