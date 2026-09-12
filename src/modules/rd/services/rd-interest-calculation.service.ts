import { Injectable, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { RdRulesService } from '../rd-rules.service';
import { RdPatternEligibilityService } from './rd-pattern-eligibility.service';
import { calculateRdInstallmentInterest, RdInstallmentInterestResult } from '../rd-installment-interest-calculator';
import { calculateOpeningBalanceInterest, OpeningBalanceInterestResult } from '../rd-opening-balance-interest';

export interface RdInterestPreview {
    fullInterestEligible: boolean;
    installmentInterest: RdInstallmentInterestResult;
    openingBalanceInterest: OpeningBalanceInterestResult;
    /** Simple addition of the two independent totals — never a blended
     *  formula, per the user's explicit instruction that these stay
     *  independent calculators. */
    totalInterest: number;
}

/**
 * Wires the two independent pure calculators (installment interest,
 * opening-balance interest) to the database for one member+financial-year,
 * and combines their totals by plain addition only. Used both by a preview
 * endpoint here and by the financial-year-closing orchestrator (a later
 * step) that actually persists the result to rd_financial_year_summary.
 */
@Injectable()
export class RdInterestCalculationService {
    constructor(
        private readonly dataSource: DataSource,
        private readonly rdRules: RdRulesService,
        private readonly patternEligibility: RdPatternEligibilityService,
    ) { }

    async getFinancialYearEndDate(yearcode: number): Promise<Date> {
        const rows = await this.dataSource.query(
            `SELECT end_date FROM yearend WHERE yearcode = $1 LIMIT 1`,
            [yearcode],
        );
        if (!rows[0]?.end_date) throw new NotFoundException(`Financial year ${yearcode} not found or has no end date.`);
        return new Date(rows[0].end_date);
    }

    async calculateInstallmentInterest(
        mbno: string,
        yearcode: number,
        overrideEligible?: boolean,
    ): Promise<RdInstallmentInterestResult> {
        const [paidRows, rate, fyEndDate, patternEvaluation] = await Promise.all([
            this.dataSource.query(
                `SELECT due_date, paid_date, paid_amount FROM rd_installment_ledger
                 WHERE mbno = $1 AND yearcode = $2 AND paid_amount >= expected_amount AND paid_date IS NOT NULL
                 ORDER BY due_date ASC`,
                [mbno, yearcode],
            ),
            this.rdRules.getRule('RULE_RD_OPENING_BALANCE_RATE'),
            this.getFinancialYearEndDate(yearcode),
            this.patternEligibility.evaluateMember(mbno, yearcode),
        ]);

        const fullInterestEligible = overrideEligible ?? patternEvaluation.autoEligibleFullInterest;

        return calculateRdInstallmentInterest(
            paidRows.map((r: any) => ({ dueDate: r.due_date, paidDate: r.paid_date, paidAmount: Number(r.paid_amount) })),
            rate,
            fullInterestEligible,
            fyEndDate,
        );
    }

    async calculateOpeningBalanceInterest(mbno: string, yearcode: number): Promise<OpeningBalanceInterestResult> {
        const [events, rate, fyEndDate] = await Promise.all([
            this.dataSource.query(
                `SELECT event_date, event_type, resulting_balance FROM rd_balance_events
                 WHERE mbno = $1 AND yearcode = $2 ORDER BY event_date ASC, id ASC`,
                [mbno, yearcode],
            ),
            this.rdRules.getRule('RULE_RD_OPENING_BALANCE_RATE'),
            this.getFinancialYearEndDate(yearcode),
        ]);

        return calculateOpeningBalanceInterest(
            events.map((e: any) => ({ eventDate: e.event_date, eventType: e.event_type, resultingBalance: Number(e.resulting_balance) })),
            rate,
            fyEndDate,
        );
    }

    /** Both independent figures for a member+year, combined only by simple
     *  addition — a preview of what financial-year closing (a later step)
     *  would credit if run right now with no authority override. */
    async previewTotalInterest(mbno: string, yearcode: number, overrideEligible?: boolean): Promise<RdInterestPreview> {
        const [installmentResult, openingResult, patternEvaluation] = await Promise.all([
            this.calculateInstallmentInterest(mbno, yearcode, overrideEligible),
            this.calculateOpeningBalanceInterest(mbno, yearcode),
            this.patternEligibility.evaluateMember(mbno, yearcode),
        ]);

        return {
            fullInterestEligible: overrideEligible ?? patternEvaluation.autoEligibleFullInterest,
            installmentInterest: installmentResult,
            openingBalanceInterest: openingResult,
            totalInterest: Math.round((installmentResult.totalInterest + openingResult.totalInterest) * 100) / 100,
        };
    }
}
