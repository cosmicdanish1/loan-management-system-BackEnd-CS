import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { RdBalanceEventsService } from '../../rd/services/rd-balance-events.service';
import { RdRulesService } from '../../rd/rd-rules.service';

/**
 * Regular Loan eligibility rule defaults. Every one of these is overridable
 * from the Modify Business Rules screen (persisted in `system_configs` under
 * the key shown) — these are only the fallbacks used when a key has never been
 * configured.
 */
export interface RegularLoanRules {
    RULE_LOAN_R_MAX_LIMIT: number;
    RULE_LOAN_R_RD_PCT: number;
    RULE_LOAN_R_SHARE_PCT: number;
    RULE_LOAN_R_SHORTFALL_MODE: string;
    RULE_LOAN_R_LIMIT_CALC: string;
    RULE_LOAN_R_RD_HEAD_CODE: string;
    RULE_LOAN_R_SHARE_HEAD_CODE: string;
    /** Minimum Share Value a member must retain after RD/Share are adjusted
     *  toward a full early closure — the Share-side counterpart to RD's own
     *  RULE_RD_MIN_BALANCE_AFTER_WITHDRAWAL (reused as-is for the RD side,
     *  since it's the exact same "how much must stay behind" concept; Share
     *  has no equivalent rule of its own yet, hence this new one). */
    RULE_LOAN_R_SHARE_MIN_BALANCE: number;
}

export const REGULAR_LOAN_RULE_DEFAULTS: RegularLoanRules = {
    /** Maximum total regular-loan exposure a member may carry. */
    RULE_LOAN_R_MAX_LIMIT: 1000000,
    /** RD required, as a % of total exposure after the new loan. */
    RULE_LOAN_R_RD_PCT: 5,
    /** Share Value required, as a % of total exposure after the new loan. */
    RULE_LOAN_R_SHARE_PCT: 5,
    /**
     * What to do when RD/Share fall short of the requirement:
     *   DEDUCT — reduce the disbursement by the shortfall (default)
     *   BLOCK  — refuse the loan application outright
     *   IGNORE — record the shortfall but neither deduct nor block
     */
    RULE_LOAN_R_SHORTFALL_MODE: 'DEDUCT',
    /**
     * How total exposure is derived:
     *   OUTSTANDING_PLUS_NEW — existing regular outstanding + new loan (default)
     *   NEW_ONLY             — the new loan amount alone
     */
    RULE_LOAN_R_LIMIT_CALC: 'OUTSTANDING_PLUS_NEW',
    // GL head the RD shortfall is credited to at disbursement. RD has no
    // GL head of its own in this system's chart of accounts — it's posted
    // under L1004 "COMPULSORY DEPOSIT" (headtype CD) everywhere else RD
    // touches the ledger (interest.service.ts's RD interest calculation,
    // ledger-posting.service.ts's bulk recovery — both confirmed live in
    // earlier sessions). Using the same code here rather than inventing a
    // new one keeps this consistent with the rest of the app.
    RULE_LOAN_R_RD_HEAD_CODE: 'L1004',
    /** GL head the Share shortfall is credited to at disbursement. */
    RULE_LOAN_R_SHARE_HEAD_CODE: 'L1001',
    /** Matches the RD side's own default (RULE_RD_MIN_BALANCE_AFTER_WITHDRAWAL),
     *  per the user's explicit spec of ₹1,000 in both. */
    RULE_LOAN_R_SHARE_MIN_BALANCE: 1000,
};

/** The system_configs keys backing the Regular Loan rules above. */
export const REGULAR_LOAN_RULE_KEYS = Object.keys(
    REGULAR_LOAN_RULE_DEFAULTS,
) as Array<keyof RegularLoanRules>;

/** Rules stored as a number; everything else is persisted as a string. */
export const REGULAR_LOAN_NUMERIC_RULE_KEYS: string[] = REGULAR_LOAN_RULE_KEYS.filter(
    (k) => typeof REGULAR_LOAN_RULE_DEFAULTS[k] === 'number',
);

export interface EligibilityStatus {
    /** Whether the RD/Share rule actually applies to this loan's type — each
     *  type (RLN/ALN/ELN) can be switched on/off independently from the
     *  "Modify Business Rules" screen (RULE_LOAN_ELIGIBILITY_APPLY_{type}),
     *  all defaulting to on. False means this loan's type currently has the
     *  rule turned off. */
    ruleApplies: boolean;

    loanAmount: number;
    existingOutstanding: number;
    totalExposure: number;

    // Rule 1 — maximum regular loan limit
    maxLimit: number;
    withinMaxLimit: boolean;

    // Rule 2 — RD requirement
    rdPct: number;
    requiredRd: number;
    currentRd: number;
    rdShortfall: number;

    // Rule 3 — Share Value requirement
    sharePct: number;
    requiredShare: number;
    currentShare: number;
    shareShortfall: number;

    // Rule 4 — shortfall handling
    shortfallMode: string;
    totalShortfall: number;
    /** What the member actually receives once the shortfall is withheld. */
    netDisbursement: number;
    /** GL heads the shortfalls are credited to — read this rather than
     *  hardcoding a code client-side, so it always reflects whatever is
     *  actually configured (see RULE_LOAN_R_RD_HEAD_CODE / _SHARE_HEAD_CODE). */
    rdHeadCode: string;
    shareHeadCode: string;

    /** True when the loan may proceed (within limit, and not BLOCK-ed). */
    isEligible: boolean;
    message?: string;

    // ── Backwards-compatible aliases ───────────────────────────────────────
    // Older callers/UI read these names; kept so nothing silently breaks.
    additionalShareRequired: number;
    requiredFd: number;
    currentFd: number;
    additionalFdRequired: number;
}

@Injectable()
export class LoanEligibilityService {
    private readonly logger = new Logger(LoanEligibilityService.name);

    constructor(
        private readonly dataSource: DataSource,
        private readonly rdBalanceEvents: RdBalanceEventsService,
        private readonly rdRules: RdRulesService,
    ) { }

    /**
     * Read a business rule from system_configs, falling back to the documented
     * default when the key has never been configured.
     *
     * Deliberately queries the table directly rather than going through
     * SystemConfigService.getConfigValue(), which throws NotFoundException on a
     * missing key — a rule that has simply never been set should quietly use
     * its default, not 500 the loan screen.
     */
    private async getRule<K extends keyof RegularLoanRules>(
        key: K,
    ): Promise<RegularLoanRules[K]> {
        const fallback = REGULAR_LOAN_RULE_DEFAULTS[key];
        try {
            const rows = await this.dataSource.query(
                `SELECT value FROM system_configs WHERE key = $1 AND "isActive" = true LIMIT 1`,
                [key],
            );
            const raw = rows[0]?.value;
            if (raw === undefined || raw === null || raw === '') return fallback;
            if (typeof fallback === 'number') {
                const n = Number(raw);
                return (Number.isFinite(n) ? n : fallback) as RegularLoanRules[K];
            }
            return String(raw).toUpperCase() as RegularLoanRules[K];
        } catch (error: any) {
            this.logger.warn(`Could not read rule ${key}, using default: ${error.message}`);
            return fallback;
        }
    }

    /**
     * Whether the RD/Share eligibility rule applies to this loan type,
     * configurable per type from "Modify Business Rules"
     * (RULE_LOAN_ELIGIBILITY_APPLY_RLN / _ALN / _ELN) — all default to true
     * (applies to every real loan type) until explicitly turned off.
     * Deliberately queries system_configs directly, same as getRule() above,
     * rather than going through SystemConfigService (which 404s on a key
     * that's simply never been set).
     */
    private async isEligibilityRuleApplicable(loanType?: string): Promise<boolean> {
        const type = (loanType || '').toString().toUpperCase();
        if (!['RLN', 'ALN', 'ELN'].includes(type)) return false;
        const key = `RULE_LOAN_ELIGIBILITY_APPLY_${type}`;
        try {
            const rows = await this.dataSource.query(
                `SELECT value FROM system_configs WHERE key = $1 AND "isActive" = true LIMIT 1`,
                [key],
            );
            const raw = rows[0]?.value;
            if (raw === undefined || raw === null || raw === '') return true; // default: on
            return raw === 'true' || raw === '1' || raw === 'Y';
        } catch (error: any) {
            this.logger.warn(`Could not read ${key}, defaulting to enabled: ${error.message}`);
            return true;
        }
    }

    private exemptResult(loanAmount: number, message: string): EligibilityStatus {
        return {
            ruleApplies: false,
            loanAmount,
            existingOutstanding: 0,
            totalExposure: loanAmount,
            maxLimit: 0,
            withinMaxLimit: true,
            rdPct: 0,
            requiredRd: 0,
            currentRd: 0,
            rdShortfall: 0,
            sharePct: 0,
            requiredShare: 0,
            currentShare: 0,
            shareShortfall: 0,
            shortfallMode: 'NONE',
            totalShortfall: 0,
            netDisbursement: loanAmount,
            rdHeadCode: '',
            shareHeadCode: '',
            isEligible: true,
            message,
            additionalShareRequired: 0,
            requiredFd: 0,
            currentFd: 0,
            additionalFdRequired: 0,
        };
    }

    /**
     * Evaluate the RD/Share eligibility rules for a member.
     *
     * Applies to whichever loan types currently have the rule switched on
     * (RULE_LOAN_ELIGIBILITY_APPLY_RLN/_ALN/_ELN on "Modify Business Rules" —
     * all default to on). A type with the rule off always comes back exempt
     * and eligible.
     *
     * Rules, in order:
     *   1. Total exposure (existing outstanding of that same loan type + new
     *      loan) must not exceed the configured maximum limit.
     *   2. RD balance must be at least the configured % of total exposure.
     *   3. Share Value must be at least the configured % of total exposure.
     *   4. Any RD/Share shortfall is withheld from the disbursement — it is
     *      NEVER added to the loan, and nothing is deducted when both
     *      requirements are already met.
     */
    async checkEligibility(
        memberNo: string,
        loanAmount: number,
        loanType?: string,
    ): Promise<EligibilityStatus> {
        if (!(await this.isEligibilityRuleApplicable(loanType))) {
            return this.exemptResult(
                loanAmount,
                'This loan type currently has the RD/Share eligibility rule switched off in Modify Business Rules.',
            );
        }

        const [maxLimit, rdPct, sharePct, shortfallMode, limitCalc, rdHeadCode, shareHeadCode] = await Promise.all([
            this.getRule('RULE_LOAN_R_MAX_LIMIT'),
            this.getRule('RULE_LOAN_R_RD_PCT'),
            this.getRule('RULE_LOAN_R_SHARE_PCT'),
            this.getRule('RULE_LOAN_R_SHORTFALL_MODE'),
            this.getRule('RULE_LOAN_R_LIMIT_CALC'),
            this.getRule('RULE_LOAN_R_RD_HEAD_CODE'),
            this.getRule('RULE_LOAN_R_SHARE_HEAD_CODE'),
        ]);

        // ── Rule 1: total exposure vs. maximum limit ───────────────────────
        // Existing outstanding of THIS SAME loan type only — an ALN
        // applicant's exposure is checked against their emergency-loan
        // balance, not their regular-loan balance, and vice versa.
        const existingOutstanding = await this.getExistingOutstanding(memberNo, loanType);
        const totalExposure =
            limitCalc === 'NEW_ONLY' ? loanAmount : existingOutstanding + loanAmount;
        const withinMaxLimit = totalExposure <= maxLimit;

        // ── Rules 2 & 3: RD and Share requirements, both on TOTAL EXPOSURE ──
        // (not on the new loan amount alone — a top-up must satisfy the
        // requirement for the member's whole regular-loan book.)
        //
        // RD balance reads the new rd_balance_events timeline (built from
        // scratch this session to replace the old fdmaster/fdrdflag='R'
        // account, confirmed to hold zero real member data) for the CURRENT
        // financial year. A member with no RD activity yet simply has a
        // balance of 0, same as before this rebuild.
        const requiredRd = totalExposure * (rdPct / 100);
        const requiredShare = totalExposure * (sharePct / 100);

        const [currentRd, currentShare] = await Promise.all([
            this.getRdBalance(memberNo),
            this.getShareBalance(memberNo),
        ]);

        const rdShortfall = Math.max(0, requiredRd - currentRd);
        const shareShortfall = Math.max(0, requiredShare - currentShare);

        // ── Rule 4: shortfall handling ─────────────────────────────────────
        // Nothing is withheld when both requirements are already met.
        const totalShortfall =
            shortfallMode === 'IGNORE' ? 0 : rdShortfall + shareShortfall;
        const netDisbursement = Math.max(0, loanAmount - totalShortfall);

        // A shortfall alone does not make the member ineligible — it is
        // withheld from the disbursement instead. Only breaching the maximum
        // limit (or an explicit BLOCK policy) stops the loan.
        const blockedByShortfall = shortfallMode === 'BLOCK' && totalShortfall > 0;
        const isEligible = withinMaxLimit && !blockedByShortfall;

        let message: string;
        if (!withinMaxLimit) {
            message =
                `Total regular loan exposure ₹${totalExposure.toLocaleString('en-IN')} ` +
                `(existing ₹${existingOutstanding.toLocaleString('en-IN')} + new ₹${loanAmount.toLocaleString('en-IN')}) ` +
                `exceeds the maximum limit of ₹${maxLimit.toLocaleString('en-IN')}.`;
        } else if (totalShortfall > 0) {
            const shortfallParts: string[] = [];
            if (rdShortfall > 0) shortfallParts.push(`RD shortfall ₹${rdShortfall.toLocaleString('en-IN')}`);
            if (shareShortfall > 0) shortfallParts.push(`Share shortfall ₹${shareShortfall.toLocaleString('en-IN')}`);
            message =
                `${shortfallParts.join('. ')}. ` +
                (blockedByShortfall
                    ? 'Loan blocked by the configured shortfall policy.'
                    : `₹${totalShortfall.toLocaleString('en-IN')} will be withheld from the disbursement ` +
                      `(net payable ₹${netDisbursement.toLocaleString('en-IN')}).`);
        } else {
            message = 'Member meets the RD and Share Value requirements in full.';
        }

        return {
            ruleApplies: true,
            loanAmount,
            existingOutstanding,
            totalExposure,
            maxLimit,
            withinMaxLimit,
            rdPct,
            requiredRd,
            currentRd,
            rdShortfall,
            sharePct,
            requiredShare,
            currentShare,
            shareShortfall,
            shortfallMode,
            totalShortfall,
            netDisbursement,
            rdHeadCode,
            shareHeadCode,
            isEligible,
            message,
            // Backwards-compatible aliases
            additionalShareRequired: shareShortfall,
            requiredFd: requiredRd,
            currentFd: currentRd,
            additionalFdRequired: rdShortfall,
        };
    }

    /**
     * Member's existing outstanding for THIS SAME loan type.
     *
     * Reads member_balances (regularloan for RLN, emergency_loan_balance for
     * ALN/ELN), which disbursement and repayment/closure processing both keep
     * current — deliberately NOT loan_master.balance, which is only ever
     * about one specific loan case, not the member's whole book of that type.
     */
    private async getExistingOutstanding(memberNo: string, loanType?: string): Promise<number> {
        const type = (loanType || '').toString().toUpperCase();
        const balanceCol = type === 'RLN' ? 'regularloan' : 'emergency_loan_balance';
        const rows = await this.dataSource.query(
            `SELECT COALESCE(${balanceCol}::numeric, 0) AS total
               FROM member_balances WHERE mbno = $1`,
            [memberNo],
        );
        return Number(rows[0]?.total || 0);
    }

    /** Current financial year, per the real yearend table — the same
     *  April-March convention used throughout the RD system. Returns null
     *  if no financial year row currently spans today (shouldn't happen in
     *  practice, but a missing year must never crash a loan eligibility
     *  check — it just means the member's RD balance reads as 0). */
    private async getCurrentYearcode(): Promise<number | null> {
        const rows = await this.dataSource.query(
            `SELECT yearcode FROM yearend WHERE start_date <= NOW() AND end_date >= NOW() LIMIT 1`,
        );
        return rows[0] ? Number(rows[0].yearcode) : null;
    }

    private async getRdBalance(memberNo: string): Promise<number> {
        const yearcode = await this.getCurrentYearcode();
        if (!yearcode) return 0;
        // Must include this year's paid installments, not just the
        // opening-balance pot — otherwise a member who has been faithfully
        // paying their RD all year would show ₹0 for eligibility purposes
        // until their year closes. See getTotalCurrentHoldings()'s docstring.
        return this.rdBalanceEvents.getTotalCurrentHoldings(memberNo, yearcode);
    }

    private async getShareBalance(memberNo: string): Promise<number> {
        const rows = await this.dataSource.query(
            `SELECT COALESCE(shares::numeric, 0) AS shares
               FROM member_balances WHERE mbno = $1`,
            [memberNo],
        );
        return Number(rows[0]?.shares || 0);
    }

    /**
     * Hard-stop checks run when a loan application is saved.
     *
     * Only refuses the application for a genuine policy breach — exceeding the
     * maximum limit, or a shortfall while the configured mode is BLOCK. An
     * RD/Share shortfall under the default DEDUCT mode is NOT a rejection: it
     * is withheld from the disbursement later (see getDisbursementDeductions).
     */
    async enforceEligibility(memberNo: string, loanAmount: number, loanType?: string): Promise<void> {
        const eligibility = await this.checkEligibility(memberNo, loanAmount, loanType);
        if (!eligibility.isEligible) {
            throw new BadRequestException(eligibility.message || 'Loan is not eligible.');
        }
    }

    /**
     * The RD/Share amounts to withhold from a disbursement, with the GL head
     * each is credited to. Returns an empty list when the member already meets
     * both requirements, or when the loan type is exempt.
     *
     * Single source of truth for the deduction — the disbursement path calls
     * this rather than recomputing the percentages inline (a duplicated,
     * drifted copy of this rule previously caused real money to be skimmed off
     * loans it should never have applied to).
     */
    async getDisbursementDeductions(
        memberNo: string,
        loanAmount: number,
        loanType?: string,
    ): Promise<Array<{ code: string; name: string; amount: number; kind: 'RD' | 'SHARE' }>> {
        const eligibility = await this.checkEligibility(memberNo, loanAmount, loanType);
        if (!eligibility.ruleApplies || eligibility.totalShortfall <= 0) return [];

        const deductions: Array<{ code: string; name: string; amount: number; kind: 'RD' | 'SHARE' }> = [];
        if (eligibility.shareShortfall > 0) {
            deductions.push({
                code: eligibility.shareHeadCode,
                name: `SHARE VALUE (${eligibility.sharePct}% shortfall)`,
                amount: eligibility.shareShortfall,
                kind: 'SHARE',
            });
        }
        if (eligibility.rdShortfall > 0) {
            deductions.push({
                code: eligibility.rdHeadCode,
                name: `RECURRING DEPOSIT (${eligibility.rdPct}% shortfall)`,
                amount: eligibility.rdShortfall,
                kind: 'RD',
            });
        }
        return deductions;
    }

    /**
     * How much of a full loan closure's finalClosureAmount can be adjusted
     * from the member's RD and Share Value, per the user's spec: a ₹1,000
     * minimum balance must remain in each, only the amount above that may be
     * used, RD is drawn down before Share, and any remaining shortfall stays
     * payable by the member. This is the read-only calculation shared by
     * both the closure quote and the actual execution — the execution
     * re-derives these same figures immediately before writing anything, so
     * the two can never disagree with each other (same principle as
     * calculateEarlyClosure/executeEarlyClosure's own outstandingPrincipal
     * reconciliation).
     */
    async getRdShareClosureAdjustment(
        memberNo: string,
        finalClosureAmount: number,
    ): Promise<{
        currentRd: number;
        currentShare: number;
        rdMinBalance: number;
        shareMinBalance: number;
        rdAvailable: number;
        shareAvailable: number;
        appliedFromRdShare: number;
        fromRd: number;
        fromShare: number;
        payableByMember: number;
        yearcode: number | null;
        rdYearClosed: boolean;
    }> {
        const yearcode = await this.getCurrentYearcode();
        const [currentRd, currentShare, rdMinBalance, shareMinBalance, rdClosedRows] = await Promise.all([
            yearcode ? this.rdBalanceEvents.getTotalCurrentHoldings(memberNo, yearcode) : Promise.resolve(0),
            this.getShareBalance(memberNo),
            this.rdRules.getRule('RULE_RD_MIN_BALANCE_AFTER_WITHDRAWAL'),
            this.getRule('RULE_LOAN_R_SHARE_MIN_BALANCE'),
            yearcode
                ? this.dataSource.query(`SELECT closed_at FROM rd_financial_year_summary WHERE mbno = $1 AND yearcode = $2`, [memberNo, yearcode])
                : Promise.resolve([]),
        ]);
        // A closed RD year can't be withdrawn from (recordWithdrawal enforces
        // this too) — rather than let that surface as a hard failure that
        // blocks the ENTIRE loan closure over RD state the operator isn't
        // even trying to touch, this simply excludes RD from the adjustment
        // for a closed year: the member covers that portion themselves (or
        // Share alone still applies), same as if they had no RD at all.
        const rdYearClosed = !!rdClosedRows[0]?.closed_at;

        const rdAvailable = rdYearClosed ? 0 : Math.max(0, Math.round((currentRd - rdMinBalance) * 100) / 100);
        const shareAvailable = Math.max(0, Math.round((currentShare - shareMinBalance) * 100) / 100);
        const appliedFromRdShare = Math.min(finalClosureAmount, Math.round((rdAvailable + shareAvailable) * 100) / 100);
        // RD before Share, per the user's explicit instruction.
        const fromRd = Math.min(appliedFromRdShare, rdAvailable);
        const fromShare = Math.round((appliedFromRdShare - fromRd) * 100) / 100;
        const payableByMember = Math.round((finalClosureAmount - appliedFromRdShare) * 100) / 100;

        return {
            currentRd, currentShare, rdMinBalance, shareMinBalance,
            rdAvailable, shareAvailable, appliedFromRdShare, fromRd, fromShare,
            payableByMember, yearcode, rdYearClosed,
        };
    }
}
