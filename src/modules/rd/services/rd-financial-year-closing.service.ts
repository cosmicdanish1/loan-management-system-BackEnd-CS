import { Injectable, BadRequestException, NotFoundException, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { RdRulesService } from '../rd-rules.service';
import { RdMemberConfigService } from './rd-member-config.service';
import { RdBalanceEventsService } from './rd-balance-events.service';
import { RdPatternEligibilityService } from './rd-pattern-eligibility.service';
import { RdInterestCalculationService } from './rd-interest-calculation.service';
import { PatternEvaluation } from '../rd-pattern-engine';
import { RdInstallmentInterestResult } from '../rd-installment-interest-calculator';
import { OpeningBalanceInterestResult } from '../rd-opening-balance-interest';

export interface AuthorityOverride {
    eligible: boolean;
    reason: string;
    by: string;
}

export interface MemberYearClosingResult {
    mbno: string;
    yearcode: number;
    openingBalance: number;
    monthlyRdAmount: number;
    totalInstallmentsDue: number;
    totalInstallmentsPaid: number;
    totalMissed: number;
    paymentPatternDetected: string;
    autoEligibleFullInterest: boolean;
    authorityOverride: boolean | null;
    authorityOverrideReason: string | null;
    finalEligibleFullInterest: boolean;
    rdInstallmentInterest: number;
    openingBalanceInterest: number;
    openingBalanceInterestRate: number;
    totalInterestCredited: number;
    closingBalance: number;
    nextYearcode: number | null;
    rolledForward: boolean;
    rolloverNote: string | null;
}

export interface MemberYearClosingPreview {
    mbno: string;
    patternEvaluation: PatternEvaluation;
    installmentInterest: RdInstallmentInterestResult;
    openingBalanceInterest: OpeningBalanceInterestResult;
    totalInterestIfClosedNow: number;
    currentBalance: number;
}

/**
 * Financial-year closing — the orchestrator that runs the Step 7 pattern
 * engine and both Step 8 interest calculators for one member+year, then
 * persists the result. Per the user's spec:
 *   - No arrears are carried forward: an unpaid rd_installment_ledger row
 *     for the closed year is simply left as-is (never touched here) — next
 *     year's collection starts fresh at the configured monthly amount.
 *   - The interest RATE actually used is frozen onto rd_financial_year_summary
 *     at closing time, so a later rate change never alters an already-closed
 *     year's figures.
 *   - Authority override is exception-only: closing defaults to the pattern
 *     engine's automatic verdict, and only deviates when the caller
 *     explicitly supplies one (surfaced from the bulk-review screen).
 *   - The member's RD money itself (opening balance + both interests) DOES
 *     roll forward into next year's opening balance — only the DUES don't.
 */
@Injectable()
export class RdFinancialYearClosingService {
    private readonly logger = new Logger(RdFinancialYearClosingService.name);

    constructor(
        private readonly dataSource: DataSource,
        private readonly rdRules: RdRulesService,
        private readonly memberConfig: RdMemberConfigService,
        private readonly balanceEvents: RdBalanceEventsService,
        private readonly patternEligibility: RdPatternEligibilityService,
        private readonly interestCalculation: RdInterestCalculationService,
    ) { }

    /** Every member with any RD footprint this year — configured an amount,
     *  has a balance-event timeline, or has installment ledger rows. Members
     *  who never touched RD this year are simply not in this list, so they
     *  never get a (meaningless) closing record. */
    async listMembersWithActivity(yearcode: number): Promise<string[]> {
        const rows = await this.dataSource.query(
            `SELECT DISTINCT mbno::text AS mbno FROM (
                SELECT mbno FROM rd_member_config WHERE yearcode = $1
                UNION SELECT mbno FROM rd_balance_events WHERE yearcode = $1
                UNION SELECT mbno FROM rd_installment_ledger WHERE yearcode = $1
             ) x ORDER BY mbno`,
            [yearcode],
        );
        return rows.map((r: any) => r.mbno);
    }

    /** Read-only look at what closing THIS year would produce right now —
     *  no writes, safe to call for every member on the bulk-review screen
     *  before anyone commits to closing anything. */
    async previewMemberClosing(mbno: string, yearcode: number, overrideEligible?: boolean): Promise<MemberYearClosingPreview> {
        const [patternEvaluation, totalPreview, currentBalance] = await Promise.all([
            this.patternEligibility.evaluateMember(mbno, yearcode),
            this.interestCalculation.previewTotalInterest(mbno, yearcode, overrideEligible),
            this.balanceEvents.getCurrentBalance(mbno, yearcode),
        ]);
        return {
            mbno,
            patternEvaluation,
            installmentInterest: totalPreview.installmentInterest,
            openingBalanceInterest: totalPreview.openingBalanceInterest,
            totalInterestIfClosedNow: totalPreview.totalInterest,
            currentBalance,
        };
    }

    async previewFinancialYearClosing(
        yearcode: number,
        limit = 200,
        offset = 0,
    ): Promise<{ total: number; members: MemberYearClosingPreview[] }> {
        const allMbnos = await this.listMembersWithActivity(yearcode);
        const page = allMbnos.slice(offset, offset + limit);
        const members = await Promise.all(page.map((mbno) => this.previewMemberClosing(mbno, yearcode)));
        return { total: allMbnos.length, members };
    }

    /** Closes one member's financial year: computes both independent
     *  interest figures, credits them, upserts the audit summary row, and
     *  rolls the resulting balance forward into next year's opening balance
     *  — all inside one transaction, so a failure partway through leaves
     *  nothing half-applied. */
    async closeMemberYear(
        mbno: string,
        yearcode: number,
        closedBy: string,
        override?: AuthorityOverride,
    ): Promise<MemberYearClosingResult> {
        const existing = await this.dataSource.query(
            `SELECT closed_at FROM rd_financial_year_summary WHERE mbno = $1 AND yearcode = $2`,
            [mbno, yearcode],
        );
        if (existing[0]?.closed_at) {
            throw new BadRequestException(
                `RD financial year ${yearcode} is already closed for member ${mbno} (closed at ${existing[0].closed_at}).`,
            );
        }

        const fyRows = await this.dataSource.query(`SELECT end_date FROM yearend WHERE yearcode = $1`, [yearcode]);
        if (!fyRows[0]?.end_date) throw new NotFoundException(`Financial year ${yearcode} not found.`);
        const fyEndDate: Date = new Date(fyRows[0].end_date);

        const patternEvaluation = await this.patternEligibility.evaluateMember(mbno, yearcode);
        const finalEligible = override?.eligible ?? patternEvaluation.autoEligibleFullInterest;

        const [installmentResult, openingResult, rate, monthlyRdAmount, openingBalanceRow] = await Promise.all([
            this.interestCalculation.calculateInstallmentInterest(mbno, yearcode, finalEligible),
            this.interestCalculation.calculateOpeningBalanceInterest(mbno, yearcode),
            this.rdRules.getRule('RULE_RD_OPENING_BALANCE_RATE'),
            this.memberConfig.getCurrentAmount(mbno, yearcode, fyEndDate),
            this.dataSource.query(
                `SELECT amount FROM rd_balance_events WHERE mbno = $1 AND yearcode = $2 AND event_type = 'OPENING' ORDER BY event_date ASC LIMIT 1`,
                [mbno, yearcode],
            ),
        ]);
        const openingBalance = openingBalanceRow[0] ? Number(openingBalanceRow[0].amount) : 0;
        const totalInterestCredited = Math.round((installmentResult.totalInterest + openingResult.totalInterest) * 100) / 100;

        const queryRunner = this.dataSource.createQueryRunner();
        await queryRunner.connect();
        await queryRunner.startTransaction();
        try {
            if (installmentResult.totalInterest > 0) {
                await this.balanceEvents.recordInterestCredit(
                    mbno, yearcode, installmentResult.totalInterest, 'INSTALLMENT_INTEREST_CREDIT', fyEndDate, closedBy, queryRunner,
                );
            }
            if (openingResult.totalInterest > 0) {
                await this.balanceEvents.recordInterestCredit(
                    mbno, yearcode, openingResult.totalInterest, 'OPENING_INTEREST_CREDIT', fyEndDate, closedBy, queryRunner,
                );
            }

            const [closingBalanceRows, paidInstallmentsRows] = await Promise.all([
                queryRunner.query(
                    `SELECT resulting_balance FROM rd_balance_events
                     WHERE mbno = $1 AND yearcode = $2 ORDER BY event_date DESC, id DESC LIMIT 1`,
                    [mbno, yearcode],
                ),
                queryRunner.query(
                    `SELECT COALESCE(SUM(paid_amount - withdrawn_amount), 0) AS total FROM rd_installment_ledger WHERE mbno = $1 AND yearcode = $2`,
                    [mbno, yearcode],
                ),
            ]);
            const balanceEventsClosing = closingBalanceRows[0] ? Number(closingBalanceRows[0].resulting_balance) : 0;
            const remainingInstallmentMoney = Number(paidInstallmentsRows[0]?.total || 0);
            // The two "pots" (section 3 of the RD explanation) are kept
            // separate ONLY for interest calculation — the money itself is
            // one real balance. Without adding this year's actual paid
            // installments here, a member who only ever paid monthly
            // installments (no opening balance, no withdrawal, no loan
            // addition — the single most common real case) would roll
            // forward ₹0 into next year, silently losing their own savings
            // from the balance the moment the year closed. paid_amount minus
            // withdrawn_amount so any installment money already withdrawn
            // this year (Step 9's withdrawal path) correctly doesn't roll
            // forward a second time.
            const closingBalance = Math.round((balanceEventsClosing + remainingInstallmentMoney) * 100) / 100;

            await queryRunner.query(
                `INSERT INTO rd_financial_year_summary (
                    mbno, yearcode, opening_balance, monthly_rd_amount,
                    total_installments_due, total_installments_paid, total_missed, arrears_cleared,
                    payment_pattern_detected, auto_eligible_full_interest,
                    authority_override, authority_override_by, authority_override_at, authority_override_reason,
                    final_eligible_full_interest, rd_installment_interest, opening_balance_interest,
                    opening_balance_interest_rate, total_interest_credited, closing_balance, closed_at, closed_by
                ) VALUES (
                    $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, NOW(), $21
                )
                ON CONFLICT (mbno, yearcode) DO UPDATE SET
                    opening_balance = EXCLUDED.opening_balance,
                    monthly_rd_amount = EXCLUDED.monthly_rd_amount,
                    total_installments_due = EXCLUDED.total_installments_due,
                    total_installments_paid = EXCLUDED.total_installments_paid,
                    total_missed = EXCLUDED.total_missed,
                    arrears_cleared = EXCLUDED.arrears_cleared,
                    payment_pattern_detected = EXCLUDED.payment_pattern_detected,
                    auto_eligible_full_interest = EXCLUDED.auto_eligible_full_interest,
                    authority_override = EXCLUDED.authority_override,
                    authority_override_by = EXCLUDED.authority_override_by,
                    authority_override_at = EXCLUDED.authority_override_at,
                    authority_override_reason = EXCLUDED.authority_override_reason,
                    final_eligible_full_interest = EXCLUDED.final_eligible_full_interest,
                    rd_installment_interest = EXCLUDED.rd_installment_interest,
                    opening_balance_interest = EXCLUDED.opening_balance_interest,
                    opening_balance_interest_rate = EXCLUDED.opening_balance_interest_rate,
                    total_interest_credited = EXCLUDED.total_interest_credited,
                    closing_balance = EXCLUDED.closing_balance,
                    closed_at = NOW(),
                    closed_by = EXCLUDED.closed_by`,
                [
                    mbno, yearcode, openingBalance, monthlyRdAmount,
                    patternEvaluation.totalDue, patternEvaluation.totalPaidOnTime + patternEvaluation.totalPaidLate,
                    patternEvaluation.totalStillMissing, patternEvaluation.totalStillMissing === 0,
                    patternEvaluation.detectedPattern, patternEvaluation.autoEligibleFullInterest,
                    override ? true : null, override?.by ?? null, override ? new Date() : null, override?.reason ?? null,
                    finalEligible, installmentResult.totalInterest, openingResult.totalInterest,
                    rate, totalInterestCredited, closingBalance, closedBy,
                ],
            );

            // ── Roll forward: the member's actual RD money continues into
            // next year's opening balance. No arrears are carried — we never
            // touch this year's rd_installment_ledger rows here, on purpose.
            const nextYearRows = await queryRunner.query(
                `SELECT yearcode, start_date FROM yearend WHERE start_date > $1 ORDER BY start_date ASC LIMIT 1`,
                [fyEndDate],
            );
            let nextYearcode: number | null = null;
            let rolledForward = false;
            let rolloverNote: string | null = null;

            if (nextYearRows[0]) {
                nextYearcode = Number(nextYearRows[0].yearcode);
                const alreadyRolled = await queryRunner.query(
                    `SELECT id FROM rd_balance_events WHERE mbno = $1 AND yearcode = $2 AND event_type = 'OPENING' LIMIT 1`,
                    [mbno, nextYearcode],
                );
                if (alreadyRolled.length === 0) {
                    if (closingBalance > 0) {
                        await this.balanceEvents.recordOpeningBalance(
                            mbno, nextYearcode, closingBalance, new Date(nextYearRows[0].start_date), closedBy, queryRunner,
                        );
                    }
                    rolledForward = true;
                } else {
                    rolloverNote = `Next year (${nextYearcode}) already has an opening balance event for this member — not overwritten.`;
                }
            } else {
                rolloverNote = `No financial year found starting after ${fyEndDate.toISOString().slice(0, 10)} — closing balance was NOT rolled forward. Create next year first, then re-run closing for this member.`;
            }

            await queryRunner.commitTransaction();

            return {
                mbno,
                yearcode,
                openingBalance,
                monthlyRdAmount,
                totalInstallmentsDue: patternEvaluation.totalDue,
                totalInstallmentsPaid: patternEvaluation.totalPaidOnTime + patternEvaluation.totalPaidLate,
                totalMissed: patternEvaluation.totalStillMissing,
                paymentPatternDetected: patternEvaluation.detectedPattern,
                autoEligibleFullInterest: patternEvaluation.autoEligibleFullInterest,
                authorityOverride: override ? true : null,
                authorityOverrideReason: override?.reason ?? null,
                finalEligibleFullInterest: finalEligible,
                rdInstallmentInterest: installmentResult.totalInterest,
                openingBalanceInterest: openingResult.totalInterest,
                openingBalanceInterestRate: rate,
                totalInterestCredited,
                closingBalance,
                nextYearcode,
                rolledForward,
                rolloverNote,
            };
        } catch (error) {
            await queryRunner.rollbackTransaction();
            throw error;
        } finally {
            await queryRunner.release();
        }
    }

    /** Bulk closing for every member with RD activity this year. One
     *  member's failure never aborts the batch — each closing runs in its
     *  own transaction (see closeMemberYear), and failures are collected for
     *  the operator to review and retry individually. */
    async closeFinancialYear(
        yearcode: number,
        closedBy: string,
        overrides?: Record<string, AuthorityOverride>,
    ): Promise<{ succeeded: MemberYearClosingResult[]; failed: Array<{ mbno: string; error: string }> }> {
        const mbnos = await this.listMembersWithActivity(yearcode);
        const succeeded: MemberYearClosingResult[] = [];
        const failed: Array<{ mbno: string; error: string }> = [];

        for (const mbno of mbnos) {
            try {
                const result = await this.closeMemberYear(mbno, yearcode, closedBy, overrides?.[mbno]);
                succeeded.push(result);
            } catch (error: any) {
                this.logger.warn(`RD FY closing failed for member ${mbno}, year ${yearcode}: ${error.message}`);
                failed.push({ mbno, error: error.message || 'Unknown error' });
            }
        }

        return { succeeded, failed };
    }
}
