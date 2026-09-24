import { Injectable } from '@nestjs/common';
import { DataSource, QueryRunner } from 'typeorm';
import { SystemConfigService } from '../../admin/services/system-config.service';
import { calculateConstantEmi, persistRbSchedule, round2, LoanRoundingMode, DEFAULT_SLOT1_START_DAY, DEFAULT_SLOT1_END_DAY } from '../../loan/services-v2/loan-rb-schedule.util';
import { LOAN_INTEREST_METHOD } from '../../loan/services-v2/loan-payment-model';
import { LoanEligibilityService } from '../../loan/services-v2/loan-eligibility.service';
import { LoanRepaymentService } from '../../loan/services-v2/loan-repayment.service';
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
        private readonly loanRepaymentService: LoanRepaymentService,
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

            // Populated only when this disbursement consolidates one or more
            // existing same-type loans — returned to the caller so the Pass
            // Transactions screen can surface it explicitly instead of the
            // consolidation happening invisibly (previously nothing in the
            // response indicated it at all).
            let consolidationSummary: {
                newLoanCaseNo: string;
                combinedPrincipal: number;
                oldClosureInterestTotal: number;
                consolidatedCases: Array<{
                    loancaseno: string;
                    oldBalance: number;
                    nrInterest: number;
                    apInterest: number;
                    penalInterest: number;
                    closureInterest: number;
                }>;
            } | null = null;

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
                // Reducing balance is the only supported interest method.
                // Principal and interest are always posted separately; there
                // is no combined-installment calculation branch anymore.
                const isEmergencyLoan = (['ELN', 'ALN', 'A', 'E', 'EMR', 'ADD'].includes((loan.loantype || '').toUpperCase())
                    || (loan.loantype || '').toUpperCase().includes('EMERGENCY'));
                const balanceCol = isEmergencyLoan ? 'emergency_loan_balance' : 'regularloan';

                // Loan consolidation: the legacy system merged every new loan a
                // member took (of the same loan type) into whatever they already
                // owed, recalculating one combined monthly EMI each time — a
                // member never carried two separate payments for the same loan
                // type. Our own disbursement flow had no equivalent (confirmed by
                // searching this whole module and loan-eligibility.service.ts for
                // any "does this member already have an active loan of this type"
                // check — none existed), so a second loan became a fully
                // independent case with its own EMI. FOR UPDATE locks any existing
                // active case(s) of this type for this member for the rest of this
                // transaction, so two simultaneous disbursements can never both
                // consolidate against the same now-stale balance.
                const existingActiveLoans = await queryRunner.query(
                    `SELECT loancaseno, balance, loan_amt, no_of_instal, instal_amt FROM loan_master
                     WHERE mbno = $1 AND loantype = $2 AND balance > 0
                     FOR UPDATE`,
                    [loan.mbno, loan.loantype]
                );
                const existingBalanceTotal = existingActiveLoans.reduce(
                    (sum: number, r: any) => sum + (parseFloat(r.balance) || 0), 0
                );
                const combinedPrincipal = round2(existingBalanceTotal + sanctionedAmt);
                if (existingActiveLoans.length > 0) {
                    console.log(`[PassTransaction] Consolidating ${existingActiveLoans.length} existing active ${loan.loantype} case(s) `
                        + `(total balance ₹${existingBalanceTotal}) into new case ${loan.loancaseno} — combined principal ₹${combinedPrincipal}`);

                    // DEFENSIVE RECONCILIATION — loan_master.balance (existingBalanceTotal
                    // above) and member_balances.{regularloan|emergency_loan_balance} are two
                    // independently-maintained figures for the same "member's outstanding on
                    // this loan type" concept. loan-application.service.ts's own eligibility
                    // check explicitly distrusts loan_master.balance ("set once at
                    // disbursement and never reduced") and reads member_balances instead;
                    // portfolio-wide as of 2026-09-21 the two totals disagreed by roughly 9x
                    // (₹697.9M in loan_master.balance vs ₹76.5M in member_balances) — not a
                    // rounding artifact, a real structural drift. Consolidating on whichever
                    // figure happens to be wrong would silently mis-size the new combined
                    // principal, so refuse rather than guess when they disagree materially for
                    // THIS member. This does not touch either value — it only blocks this one
                    // disbursement until the member's figures are reconciled by hand.
                    const mbRows = await queryRunner.query(
                        `SELECT COALESCE(${balanceCol}::numeric, 0) as v FROM member_balances WHERE mbno = $1`,
                        [loan.mbno]
                    );
                    const memberBalancesOutstanding = parseFloat(mbRows[0]?.v || '0');
                    const reconTolerance = 10; // whole-rupee rounding drift only
                    const reconDiff = Math.abs(existingBalanceTotal - memberBalancesOutstanding);
                    if (reconDiff > reconTolerance) {
                        throw new Error(
                            `Loan consolidation blocked for member ${loan.mbno} (${loan.loantype}): `
                            + `loan_master.balance total is ₹${existingBalanceTotal.toFixed(2)} but `
                            + `member_balances.${balanceCol} is ₹${memberBalancesOutstanding.toFixed(2)} `
                            + `(disagree by ₹${reconDiff.toFixed(2)}, tolerance ₹${reconTolerance}). `
                            + `These two balances must be reconciled manually before this member's `
                            + `loans can be consolidated — proceeding could over- or under-size the `
                            + `new combined principal.`
                        );
                    }
                }

                // oldClosureInterest — the NR/AP/penalty interest genuinely owed
                // on each old case being absorbed, as of the moment of
                // consolidation. Reuses calculateEarlyClosure() (a pure,
                // read-only quote — the same formula the standalone Early
                // Closure screen uses) instead of reimplementing the AP-average
                // method here. Deliberately takes only nrInterest + apInterest +
                // penalInterest, never finalClosureAmount or outstandingPrincipal
                // — outstandingPrincipal is already inside existingBalanceTotal/
                // combinedPrincipal above, so folding it in again here would
                // double-count the old principal. applyRdShare is false because
                // RD/Share sizing for THIS disbursement is computed fresh below
                // against the new combined principal, not the old case's own
                // closure-time RD/Share adjustment.
                let oldClosureInterestTotal = 0;
                const oldClosureBreakdown: Record<string, { nrInterest: number; apInterest: number; penalInterest: number; closureInterest: number }> = {};
                if (existingActiveLoans.length > 0) {
                    const consolidationPostingDate = new Date();
                    for (const oldLoan of existingActiveLoans) {
                        const closureQuote = await this.loanRepaymentService.calculateEarlyClosure(
                            oldLoan.loancaseno, consolidationPostingDate, 0, false, loan.mbno,
                        );

                        // Same defensive principle as the loan_master.balance vs
                        // member_balances check above, applied to a THIRD
                        // independent source: calculateEarlyClosure derives
                        // outstandingPrincipal from loan_repayment_ledger history,
                        // not from loan_master.balance. If they disagree for this
                        // specific old case, combinedPrincipal above was already
                        // sized off a balance this closure math doesn't agree
                        // with — refuse rather than price NR/AP interest against
                        // an installment-count split that doesn't match the money
                        // actually being folded in.
                        const oldBalanceForRecon = round2(parseFloat(oldLoan.balance) || 0);
                        const ledgerDerivedOutstanding = round2(closureQuote.outstandingPrincipal || 0);
                        const ledgerReconDiff = Math.abs(oldBalanceForRecon - ledgerDerivedOutstanding);
                        if (ledgerReconDiff > 10) {
                            throw new Error(
                                `Loan consolidation blocked for member ${loan.mbno}, old case ${oldLoan.loancaseno}: `
                                + `loan_master.balance is ₹${oldBalanceForRecon.toFixed(2)} but the closure-quote's `
                                + `ledger-derived outstanding principal is ₹${ledgerDerivedOutstanding.toFixed(2)} `
                                + `(disagree by ₹${ledgerReconDiff.toFixed(2)}, tolerance ₹10). This case's balance `
                                + `and its repayment history disagree and must be reconciled manually before it `
                                + `can be consolidated.`
                            );
                        }

                        const nrInterest = round2(closureQuote.nrInterest || 0);
                        const apInterest = round2(closureQuote.apInterest || 0);
                        const penalInterest = round2(closureQuote.penalInterest || 0);
                        const closureInterest = round2(nrInterest + apInterest + penalInterest);
                        oldClosureBreakdown[oldLoan.loancaseno] = { nrInterest, apInterest, penalInterest, closureInterest };
                        oldClosureInterestTotal = round2(oldClosureInterestTotal + closureInterest);
                        console.log(`[PassTransaction] Old case ${oldLoan.loancaseno} closure interest as of consolidation: `
                            + `NR=₹${nrInterest} + AP=₹${apInterest} + penal=₹${penalInterest} = ₹${closureInterest}`);
                    }
                    if (oldClosureInterestTotal > 0) {
                        console.log(`[PassTransaction] Total oldClosureInterest across ${existingActiveLoans.length} absorbed case(s): ₹${oldClosureInterestTotal} — will be withheld from fresh disbursement`);
                    }
                    consolidationSummary = {
                        newLoanCaseNo: loan.loancaseno,
                        combinedPrincipal,
                        oldClosureInterestTotal,
                        consolidatedCases: existingActiveLoans.map((oldLoan: any) => ({
                            loancaseno: oldLoan.loancaseno,
                            oldBalance: round2(parseFloat(oldLoan.balance) || 0),
                            ...oldClosureBreakdown[oldLoan.loancaseno],
                        })),
                    };
                }

                // Cooperative society's own interest rule (not standard bank
                // EMI amortization): equal-principal reducing-balance schedule
                // sized over the original term, plus 1 or 2 extra months of
                // interest on the full principal depending on which
                // application-date slot the member applied in (departmental/
                // salary-deduction processing delay). See loan-rb-schedule.util.ts
                // for the full method and rationale. Uses combinedPrincipal (not
                // just sanctionedAmt) so a consolidated loan's EMI genuinely
                // reflects the member's full combined debt, not just the new slice.
                // Slot delay months (RULE_LOAN_SLOT1_DELAY_MONTHS / _SLOT2_) —
                // configurable on "Modify Business Rules" (General Settings tab),
                // defaulting to the society's original 1/2 months. Read once here
                // and frozen onto loan_master.delay_months below, same as
                // penalrate/gracedays above, so a later change to the business
                // rule never silently reschedules an already-disbursed loan.
                let slot1DelayMonths = 1, slot2DelayMonths = 2;
                try {
                    slot1DelayMonths = await this.systemConfigService.getConfigValue('RULE_LOAN_SLOT1_DELAY_MONTHS');
                } catch (e) { /* use default */ }
                try {
                    slot2DelayMonths = await this.systemConfigService.getConfigValue('RULE_LOAN_SLOT2_DELAY_MONTHS');
                } catch (e) { /* use default */ }

                // Which application days fall in Slot 1 (RULE_LOAN_SLOT1_START_DAY /
                // _END_DAY) — Slot 2 is every other day by definition, so the two
                // slots can never be configured to overlap or leave a gap. Read
                // here for the same reason as the delay months above: resolved at
                // disbursement and frozen onto the loan, never re-read later.
                let slot1StartDay = DEFAULT_SLOT1_START_DAY, slot1EndDay = DEFAULT_SLOT1_END_DAY;
                try {
                    slot1StartDay = await this.systemConfigService.getConfigValue('RULE_LOAN_SLOT1_START_DAY');
                } catch (e) { /* use default */ }
                try {
                    slot1EndDay = await this.systemConfigService.getConfigValue('RULE_LOAN_SLOT1_END_DAY');
                } catch (e) { /* use default */ }

                // Constant-monthly-interest rounding (RULE_LOAN_ROUNDING_MODE).
                // Defaults to NEAREST — the society's manual/legacy worksheets work in
                // whole rupees, and this is the ONLY place the rounding is applied:
                // instal_amt below freezes it, and every later calculation
                // (getInstallmentStatus, calculateEarlyClosure) re-derives from
                // instal_amt rather than rounding again.
                let roundingMode: LoanRoundingMode = 'NEAREST';
                try {
                    const configured = await this.systemConfigService.getConfigValue('RULE_LOAN_ROUNDING_MODE');
                    if (['NONE', 'NEAREST', 'UP', 'DOWN'].includes(configured)) roundingMode = configured;
                } catch (e) { /* use default */ }

                const appDate = loan.app_date ? new Date(loan.app_date) : new Date();
                const emiCalc = calculateConstantEmi(combinedPrincipal, rate, noOfInstal, appDate, slot1DelayMonths, slot2DelayMonths, roundingMode, slot1StartDay, slot1EndDay);
                const instalAmt = round2(emiCalc.monthlyPrincipal);
                console.log(`[PassTransaction] ${LOAN_INTEREST_METHOD} slot ${emiCalc.slot} (+${emiCalc.delayMonths}mo, slot1 window ${slot1StartDay}-${slot1EndDay}) — RB interest=${emiCalc.totalRBInterest}, delay interest=${emiCalc.delayInterest}, separate interest schedule=${emiCalc.totalRBInterest} (rounding=${roundingMode}), principal EMI=${instalAmt}`);

                // Activate Loan
                const insertLoanMasterQuery = `
                    INSERT INTO loan_master (
                        mbno, loantype, loancaseno, loan_amt, payment_date,
                        rate, no_of_instal, instal_amt, balance, openbalance,
                        purpose, intt_amount, penalrate, gracedays, smpenalpct, smpenaldiv, delay_months, loan_payment_model, loan_interest_method
                    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)
                `;
                console.log(`[PassTransaction] Activating loan in loan_master for mbno: ${loan.mbno}`);
                await queryRunner.query(insertLoanMasterQuery, [
                    loan.mbno, loan.loantype, loan.loancaseno, combinedPrincipal, new Date(),
                    rate, noOfInstal, instalAmt, combinedPrincipal, 0,  // balance=combinedPrincipal, openbalance=0 (matches legacy)
                    loan.purpose || '', emiCalc.monthlyInterestForEMI, penalrate, gracedays, smpenalpct, smpenaldiv, emiCalc.delayMonths,
                    'SEPARATE_INTEREST',
                    LOAN_INTEREST_METHOD,
                ]);

                // Freeze the payroll-lag detection window for this consolidation —
                // see AddPayrollLagCredit1758900000000's doc comment. Only set when
                // an existing loan is actually being absorbed; a fresh loan (no
                // consolidation) has nothing to watch for. oldMonthlyPrincipal/
                // Interest is each absorbed loan's OWN frozen EMI split (its own
                // instal_amt minus its own loan_amt/no_of_instal) — summed across
                // every case being consolidated, the same way payroll would have
                // been deducting one line per active loan. The watch window reuses
                // emiCalc.delayMonths (the same slot delay already priced into this
                // new loan's own EMI) rather than a separate config value, per the
                // user's explicit instruction — BSP's real processing lag has
                // consistently landed well inside even the shorter 1-month slot in
                // every real case checked this session.
                if (existingActiveLoans.length > 0) {
                    let oldMonthlyPrincipal = 0;
                    let oldMonthlyInterest = 0;
                    for (const oldLoan of existingActiveLoans) {
                        const oldN = parseInt(oldLoan.no_of_instal, 10) || 0;
                        const oldAmt = parseFloat(oldLoan.loan_amt) || 0;
                        const oldInstal = parseFloat(oldLoan.instal_amt) || 0;
                        if (oldN <= 0) continue;
                        const mp = round2(oldAmt / oldN);
                        oldMonthlyPrincipal += mp;
                        oldMonthlyInterest += round2(oldInstal - mp);
                    }
                    const watchUntil = new Date();
                    watchUntil.setMonth(watchUntil.getMonth() + emiCalc.delayMonths);
                    // loancaseno alone is unscoped enough to hit a different member's
                    // case sharing this number, or (within this same member) the
                    // sibling case of another loan type — same class of collision
                    // found and fixed in loan-repayment.service.ts this session.
                    await queryRunner.query(
                        `UPDATE loan_master
                         SET payroll_lag_watch_until = $1, payroll_lag_old_principal = $2, payroll_lag_old_interest = $3
                         WHERE loancaseno::text = $4 AND mbno = $5 AND loantype = $6`,
                        [watchUntil, round2(oldMonthlyPrincipal), round2(oldMonthlyInterest), loan.loancaseno, loan.mbno, loan.loantype]
                    );
                    console.log(`[PassTransaction] Payroll-lag watch armed for case ${loan.loancaseno}: `
                        + `expecting up to one more old-rate payment of ~₹${round2(oldMonthlyPrincipal)}+₹${round2(oldMonthlyInterest)} `
                        + `through ${watchUntil.toDateString()}`);
                }

                // Persist the true reducing-balance schedule separately from
                // the flat instal_amt above — early closure reads this table
                // for genuine accrued interest, never the constant-EMI split.
                // Built from combinedPrincipal, so a consolidated loan finally
                // gets a real RB schedule (and therefore the proper
                // rbAdjustment reconciliation at early closure) — something no
                // migrated/legacy multi-loan account ever had, since this is the
                // only place in the codebase that ever writes loan_rb_schedule.
                await persistRbSchedule(queryRunner, loan.loancaseno, loan.mbno, emiCalc.rbSchedule);

                // Close out every case just absorbed into this new one — balance
                // zeroed (not via the normal repayment path, since no money
                // actually moved) and a real ledger row explaining why, so the
                // old case's own history shows a genuine reason it reached zero
                // rather than silently disappearing. consolidated_into_loancaseno
                // keeps a permanent, queryable link from old case to new.
                for (const oldLoan of existingActiveLoans) {
                    const oldBalance = round2(parseFloat(oldLoan.balance) || 0);
                    const breakdown = oldClosureBreakdown[oldLoan.loancaseno] || { nrInterest: 0, apInterest: 0, penalInterest: 0, closureInterest: 0 };
                    // mbno+loantype-scoped for the same reason as the arming UPDATE above —
                    // existingActiveLoans was fetched WHERE mbno=loan.mbno AND
                    // loantype=loan.loantype, so oldLoan is guaranteed to share both.
                    await queryRunner.query(
                        `UPDATE loan_master SET balance = 0, consolidated_into_loancaseno = $1 WHERE loancaseno::text = $2 AND mbno = $3 AND loantype = $4`,
                        [loan.loancaseno, oldLoan.loancaseno, loan.mbno, loan.loantype]
                    );
                    // BUG FIX: this row used to post the old balance as BOTH
                    // payment_amount and principal_amount (the same bound
                    // parameter, $7, reused for both) with interest_amount
                    // hardcoded 0 — so oldClosureInterest was invisible in this
                    // old case's own audit trail even after being computed and
                    // withheld above. principal_amount is the transferred
                    // balance only (already inside combinedPrincipal, so it is
                    // NOT charged again here); interest_amount/penal_amount are
                    // the NR+AP / penalty components actually withheld from the
                    // member's fresh cash; payment_amount is the total value
                    // this consolidation event represents for this old case.
                    await queryRunner.query(
                        `INSERT INTO loan_repayment_ledger
                            (mbno, loancaseno, loantype, payment_date, payment_month, payment_year, payment_amount,
                             principal_amount, interest_amount, penal_amount, months_overdue, receipt_no, narration, posted_by)
                         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 0, NULL, $11, $12)`,
                        [
                            loan.mbno, oldLoan.loancaseno, loan.loantype, new Date(),
                            new Date().getMonth() + 1, new Date().getFullYear(),
                            round2(oldBalance + breakdown.closureInterest), oldBalance,
                            round2(breakdown.nrInterest + breakdown.apInterest), breakdown.penalInterest,
                            `Consolidated into loan case ${loan.loancaseno} (principal ₹${oldBalance} `
                            + `+ closure interest ₹${breakdown.closureInterest}: NR ₹${breakdown.nrInterest} `
                            + `+ AP ₹${breakdown.apInterest} + penal ₹${breakdown.penalInterest})`,
                            postedBy,
                        ]
                    );
                }

                // Mirror of the decrement in loan-repayment.service.ts
                // (recordLoanRepayment / executeEarlyClosure) — until now
                // nothing on the disbursement side ever increased
                // member_balances, so the eligibility check in
                // loan-application.service.ts (which reads member_balances as
                // "current outstanding") never reflected a newly disbursed
                // loan; only repayments/closures ever moved the number, and
                // only downward. UPDATE...RETURNING falls back to INSERT for
                // members with no row yet — member_balances has no unique
                // constraint on mbno to UPSERT against. isEmergencyLoan/balanceCol
                // declared once, up near sanctionedAmt above, and reused here.
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
                // above was already created for the FULL combinedPrincipal, but
                // the cash/transfer leg posted below is reduced by the shortfall,
                // and that same amount is separately credited to the RD/Share GL
                // heads instead of the member's hand.
                //
                // CORRECTED (was briefly "fixed" to pass combinedPrincipal here,
                // which was itself wrong — caught by the worked-example
                // verification script, see _verify-worked-example-500k.ts):
                // checkEligibility()/getDisbursementDeductions() ALREADY adds the
                // member's existing outstanding internally
                // (getExistingOutstanding() reads the exact same
                // member_balances.{regularloan|emergency_loan_balance} column
                // existingBalanceTotal was reconciled against above) — its
                // `totalExposure = existingOutstanding + loanAmount`. Passing
                // combinedPrincipal (which is ALSO existingOutstanding +
                // sanctionedAmt) double-counts the old balance: totalExposure
                // would become 2×existingOutstanding + sanctionedAmt instead of
                // existingOutstanding + sanctionedAmt. The function's contract is
                // "pass the fresh/incremental amount"; it reconstructs total
                // exposure (= combinedPrincipal) itself. sanctionedAmt is correct
                // here, unconditionally — this is a no-op change from the
                // original code, restored after being briefly (and wrongly)
                // "fixed".
                const deductions = await this.loanEligibilityService.getDisbursementDeductions(
                    loan.mbno, sanctionedAmt, loan.loantype,
                );
                const shareRdDeductionTotal = round2(deductions.reduce((sum, d) => sum + d.amount, 0));

                // cashAfterOldInterest / netDisbursement guard — oldClosureInterest
                // plus any RD/Share shortfall are both withheld from the same pool
                // of fresh cash (sanctionedAmt). If that pool can't cover them,
                // proceeding would either produce a negative payout or silently
                // under-fund the RD/Share/interest postings below (the per-leg
                // Math.min cap prevents any single cash leg from going negative,
                // but leaves the shortfall unposted instead of erroring) — refuse
                // outright instead, per spec: no partial-payment feature, no
                // silent under-funding.
                const totalWithheld = round2(oldClosureInterestTotal + shareRdDeductionTotal);
                if (totalWithheld > sanctionedAmt) {
                    throw new Error(
                        `Loan consolidation blocked for member ${loan.mbno} (${loan.loantype}): total `
                        + `withholding (oldClosureInterest ₹${oldClosureInterestTotal} + RD/Share shortfall `
                        + `₹${shareRdDeductionTotal} = ₹${totalWithheld}) exceeds the fresh disbursement of `
                        + `₹${sanctionedAmt}. This would produce a negative payout, which this system does not `
                        + `support — the member must cover the shortfall directly, or the fresh loan amount `
                        + `must be increased, before this can be disbursed.`
                    );
                }

                let remainingDeduction = totalWithheld;
                if (remainingDeduction > 0) {
                    console.log(`[PassTransaction] Total withheld from disbursement: ₹${remainingDeduction} `
                        + `(oldClosureInterest ₹${oldClosureInterestTotal} + RD/Share shortfall ₹${shareRdDeductionTotal})`);
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

                    // BUG FIX: the RD branch above kept the member's RD
                    // balance (rd_balance_events) in sync with what was just
                    // withheld, but Share had no equivalent — a withheld
                    // Share shortfall was posted to the Share GL head above
                    // but never credited to member_balances.shares, so the
                    // member's tracked Share balance (read by
                    // LoanEligibilityService.getShareBalance, the exact same
                    // column executeEarlyClosure debits on closure) stayed at
                    // its old value even after the member effectively paid
                    // into it. The member_balances row for loan.mbno is
                    // already guaranteed to exist by this point (the
                    // regularloan/emergency_loan_balance UPDATE-or-INSERT
                    // above runs first), so a plain UPDATE is sufficient here
                    // — no INSERT fallback needed.
                    if (deduction.kind === 'SHARE' && deduction.amount > 0) {
                        await queryRunner.query(
                            `UPDATE member_balances SET shares = COALESCE(shares, 0) + $1 WHERE mbno = $2`,
                            [deduction.amount, loan.mbno]
                        );
                    }
                }

                // Post oldClosureInterest to the interest-income head, once per
                // absorbed old case, so each is separately audit-linked (which
                // old case produced how much, and its NR/AP/penal split) rather
                // than folded into one unexplained reduction in what the member
                // receives. I1002 "INTT FROM MEMBER" is the same generic
                // loan-interest-income head the rest of the system posts loan
                // interest to (see loan-reports.service.ts).
                for (const oldLoan of existingActiveLoans) {
                    const breakdown = oldClosureBreakdown[oldLoan.loancaseno];
                    if (!breakdown || breakdown.closureInterest <= 0) continue;
                    const closureInterestHeadCode = 'I1002';
                    const closureInterestDirection = await this.increaseDirection(queryRunner, closureInterestHeadCode);
                    const closureNarration = `Old case ${oldLoan.loancaseno} closure interest on consolidation `
                        + `into ${loan.loancaseno} (NR ₹${breakdown.nrInterest} + AP ₹${breakdown.apInterest} `
                        + `+ penal ₹${breakdown.penalInterest})`;
                    console.log(`[PassTransaction] Posting oldClosureInterest to ledger: ${closureInterestHeadCode}, `
                        + `Amount: ${breakdown.closureInterest}, Type: ${closureInterestDirection}`);
                    await queryRunner.query(`
                        INSERT INTO ledger (
                            trans_no, trans_date, trans_type, code, mbno, acc_no, acc_type,
                            trans_amt, receipt_vchr_no, vchr_type, modeofpay, pl_balance,
                            narration, username, ledgerid
                        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
                    `, [
                        nextTransNo++, new Date(), closureInterestDirection, closureInterestHeadCode, loan.mbno,
                        loan.loancaseno, loan.loantype,
                        breakdown.closureInterest, voucherNo, 'JV', mode, 0,
                        closureNarration, postedBy, nextLedgerId++
                    ]);

                    await queryRunner.query(`
                        INSERT INTO tblcashbook (headcode, headname, rcash, rtransfer, pcash, ptransfer, trans_date)
                        VALUES ($1, $2, 0, 0, 0, 0, $3)
                    `, [closureInterestHeadCode, 'INTT FROM MEMBER (old loan consolidation)', new Date()]);
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

            return {
                success: true,
                message: 'Transaction posted successfully',
                ...(consolidationSummary ? { consolidation: consolidationSummary } : {}),
            };

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
