import { Injectable, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { RdRulesService } from '../rd-rules.service';
import { RdPatternEligibilityService } from './rd-pattern-eligibility.service';
import { calculateRdInstallmentInterest, RdInstallmentInterestResult } from '../rd-installment-interest-calculator';
import { calculateOpeningBalanceInterest, BalanceEventInput, OpeningBalanceInterestResult } from '../rd-opening-balance-interest';
import { loadRdCdMovements, loadRdCdOpening, localDateFromYmd, RdLedgerInputs } from '../rd-ledger-inputs';

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
 * opening-balance interest) to the member's RD/CD LEDGER for one member+financial-year
 * (ES-581: see rd-ledger-inputs.ts), and combines their totals by plain addition only.
 * Used both by a preview endpoint here and by the financial-year-closing orchestrator
 * that persists the result and posts the yearly journal.
 *
 * The inputs are the real money movements, so a deposit earns from the month it was
 * actually received (April = 12 remaining months ... March = 1), and a withdrawal lowers
 * the opening base from its own month. The pattern-eligibility verdict no longer changes
 * the amount; who should earn interest at all is an owner decision (ES-582).
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

    /** The year's first and last day as local YYYY-MM-DD strings. */
    async getFinancialYearBounds(yearcode: number): Promise<{ start: string; end: string }> {
        const rows = await this.dataSource.query(
            `SELECT to_char(start_date, 'YYYY-MM-DD') AS s, to_char(end_date, 'YYYY-MM-DD') AS e FROM yearend WHERE yearcode = $1 LIMIT 1`,
            [yearcode],
        );
        if (!rows[0]?.s || !rows[0]?.e) throw new NotFoundException(`Financial year ${yearcode} not found or has no start / end date.`);
        return { start: String(rows[0].s), end: String(rows[0].e) };
    }

    /** Opening RD/CD balance of the year, deposits and withdrawals, all from the ledger. */
    async loadLedgerInputs(mbno: string, yearcode: number): Promise<RdLedgerInputs & { fyStart: string; fyEnd: string }> {
        const { start, end } = await this.getFinancialYearBounds(yearcode);
        const [opening, moves] = await Promise.all([
            loadRdCdOpening(this.dataSource, mbno, start),
            loadRdCdMovements(this.dataSource, mbno, start, end),
        ]);
        return { opening, deposits: moves.deposits, withdrawals: moves.withdrawals, fyStart: start, fyEnd: end };
    }

    /** The member's RD/CD balance at the start of the year (for the closing summary). */
    async getLedgerOpeningBalance(mbno: string, yearcode: number): Promise<number> {
        const { start } = await this.getFinancialYearBounds(yearcode);
        return loadRdCdOpening(this.dataSource, mbno, start);
    }

    async calculateInstallmentInterest(
        mbno: string,
        yearcode: number,
        _overrideEligible?: boolean,
    ): Promise<RdInstallmentInterestResult> {
        const [inputs, rate] = await Promise.all([
            this.loadLedgerInputs(mbno, yearcode),
            this.rdRules.getRule('RULE_RD_OPENING_BALANCE_RATE'),
        ]);
        // each deposit is paid on its own date, so due date = paid date: the chart month is the month it was received
        return calculateRdInstallmentInterest(
            inputs.deposits.map((d) => ({ dueDate: localDateFromYmd(d.date), paidDate: localDateFromYmd(d.date), paidAmount: d.amount })),
            rate,
            true,
            localDateFromYmd(inputs.fyEnd),
        );
    }

    async calculateOpeningBalanceInterest(mbno: string, yearcode: number): Promise<OpeningBalanceInterestResult> {
        const [inputs, rate] = await Promise.all([
            this.loadLedgerInputs(mbno, yearcode),
            this.rdRules.getRule('RULE_RD_OPENING_BALANCE_RATE'),
        ]);
        // the opening balance, lowered by each withdrawal from the month it happens (a withdrawal takes effect at once)
        const events: BalanceEventInput[] = [];
        // ES-582 (owner decision): like the legacy, only a member with RD/CD movement during the year earns interest on the opening
        // balance. Checked against the legacy: it paid members whose only movement was a monthly debit (no deposit row), so a
        // movement of either kind counts, not only a deposit.
        if ((inputs.deposits.length > 0 || inputs.withdrawals.length > 0) && (inputs.opening > 0 || inputs.withdrawals.length > 0)) {
            events.push({ eventDate: localDateFromYmd(inputs.fyStart), eventType: 'OPENING', resultingBalance: Math.max(0, inputs.opening) });
            let running = Math.max(0, inputs.opening);
            for (const w of inputs.withdrawals) {
                running = Math.round((running - w.amount) * 100) / 100;
                events.push({ eventDate: localDateFromYmd(w.date), eventType: 'WITHDRAWAL', resultingBalance: running });
            }
        }
        const result = calculateOpeningBalanceInterest(events, rate, localDateFromYmd(inputs.fyEnd));
        // withdrawing money that was deposited this year can take the base below zero; it can only cancel interest, never pay a negative amount
        return { ...result, totalInterest: Math.max(0, result.totalInterest) };
    }

    /** Both independent figures for a member+year, combined only by simple
     *  addition — a preview of what financial-year closing would credit if
     *  run right now with no authority override. */
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
            totalInterest: Math.max(0, Math.round((installmentResult.totalInterest + openingResult.totalInterest) * 100) / 100),
        };
    }
}
