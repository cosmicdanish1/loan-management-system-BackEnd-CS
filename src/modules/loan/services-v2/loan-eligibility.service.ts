import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { DataSource } from 'typeorm';

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
    /** False for ALN/ELN — those types are exempt from all of these rules. */
    isRegularLoan: boolean;

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

    constructor(private readonly dataSource: DataSource) { }

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

    /** Loan types the Regular Loan rules apply to. ALN/ELN are exempt. */
    private isRegularLoanType(loanType?: string): boolean {
        return (loanType || '').toString().toUpperCase() === 'RLN';
    }

    private exemptResult(loanAmount: number, message: string): EligibilityStatus {
        return {
            isRegularLoan: false,
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
     * Evaluate the Regular Loan business rules for a member.
     *
     * Applies to Regular Loans (RLN) only — Emergency Loan (ALN) and Loan
     * Against Recovery (ELN) are exempt and always come back eligible.
     *
     * Rules, in order:
     *   1. Total exposure (existing regular outstanding + new loan) must not
     *      exceed the configured maximum limit.
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
        if (!this.isRegularLoanType(loanType)) {
            return this.exemptResult(
                loanAmount,
                'Loan type is exempt from the Regular Loan eligibility rules (they apply to Regular Loans only).',
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
        const existingOutstanding = await this.getRegularLoanOutstanding(memberNo);
        const totalExposure =
            limitCalc === 'NEW_ONLY' ? loanAmount : existingOutstanding + loanAmount;
        const withinMaxLimit = totalExposure <= maxLimit;

        // ── Rules 2 & 3: RD and Share requirements, both on TOTAL EXPOSURE ──
        // (not on the new loan amount alone — a top-up must satisfy the
        // requirement for the member's whole regular-loan book.)
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
            message =
                `RD shortfall ₹${rdShortfall.toLocaleString('en-IN')}, ` +
                `Share shortfall ₹${shareShortfall.toLocaleString('en-IN')}. ` +
                (blockedByShortfall
                    ? 'Loan blocked by the configured shortfall policy.'
                    : `₹${totalShortfall.toLocaleString('en-IN')} will be withheld from the disbursement ` +
                      `(net payable ₹${netDisbursement.toLocaleString('en-IN')}).`);
        } else {
            message = 'Member meets the RD and Share Value requirements in full.';
        }

        return {
            isRegularLoan: true,
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
     * Member's existing regular-loan outstanding.
     *
     * Reads member_balances.regularloan, which repayment processing keeps
     * current — deliberately NOT loan_master.balance, which is written once at
     * disbursement and never reduced.
     */
    private async getRegularLoanOutstanding(memberNo: string): Promise<number> {
        const rows = await this.dataSource.query(
            `SELECT COALESCE(regularloan::numeric, 0) AS total
               FROM member_balances WHERE mbno = $1`,
            [memberNo],
        );
        return Number(rows[0]?.total || 0);
    }

    /**
     * Member's current RD balance.
     *
     * fdmaster holds both FD and RD accounts, distinguished by fdrdflag
     * ('F' = Fixed Deposit, 'R' = Recurring Deposit). This rule is about RD, so
     * it filters on 'R' — the previous implementation summed 'F' (Fixed
     * Deposit) here, which meant a member's actual RD balance was ignored
     * entirely and their FD was checked against an "RD requirement".
     */
    private async getRdBalance(memberNo: string): Promise<number> {
        const rows = await this.dataSource.query(
            `SELECT COALESCE(SUM(fdamount::numeric), 0) AS rd_total
               FROM fdmaster
              WHERE mbno = $1 AND status = '0' AND fdrdflag = 'R'`,
            [memberNo],
        );
        return Number(rows[0]?.rd_total || 0);
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
    ): Promise<Array<{ code: string; name: string; amount: number }>> {
        const eligibility = await this.checkEligibility(memberNo, loanAmount, loanType);
        if (!eligibility.isRegularLoan || eligibility.totalShortfall <= 0) return [];

        const deductions: Array<{ code: string; name: string; amount: number }> = [];
        if (eligibility.shareShortfall > 0) {
            deductions.push({
                code: eligibility.shareHeadCode,
                name: `SHARE VALUE (${eligibility.sharePct}% shortfall)`,
                amount: eligibility.shareShortfall,
            });
        }
        if (eligibility.rdShortfall > 0) {
            deductions.push({
                code: eligibility.rdHeadCode,
                name: `RECURRING DEPOSIT (${eligibility.rdPct}% shortfall)`,
                amount: eligibility.rdShortfall,
            });
        }
        return deductions;
    }
}
