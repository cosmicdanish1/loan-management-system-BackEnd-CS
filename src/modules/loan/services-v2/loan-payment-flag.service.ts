import { Injectable } from '@nestjs/common';
import { DataSource, QueryRunner } from 'typeorm';

/**
 * "Check this" flags for a consolidated loan's first months.
 *
 * After a consolidation, payroll keeps deducting the OLD loan's EMI for one or two
 * more cycles before it switches to the NEW loan's EMI. Neither the Loan Repayment
 * screen nor an Excel/CSV demand import carries a loan case number, so when the old
 * and the new EMI are the same or nearly the same, the system cannot be sure which
 * one an amount is. This service only RAISES A FLAG for a person to look at — it
 * never changes how money is applied. The same rules are used by both paths:
 *   - Loan Repayment screen  (LoanRepaymentService.recordLoanRepayment)
 *   - Demand import          (DemandImportService preview + save)
 *
 * The old EMI to expect and the watch window are the values frozen on the new loan at
 * consolidation (loan_master.payroll_lag_*); the new EMI is instal_amt + intt_amount.
 * "Close" means within RULE_LOAN_OLD_EMI_FLAG_TOLERANCE rupees (Modify Business Rules,
 * default 10); "equal" always means within 1 rupee.
 */

export type LoanFlagCode =
    | 'IDENTICAL_EMI'
    | 'NEAR_OLD_EMI'
    | 'SECOND_OLD_EMI'
    | 'OLD_EMI_AFTER_WINDOW'
    | 'COMBINED_EMI';

export type LoanFlagContext = 'PAYMENT' | 'DEMAND';

export interface LoanPaymentFlag {
    id?: number;
    code: LoanFlagCode;
    message: string;
    loancaseno: string;
    loantype: string;
    amount: number;
    principal?: number;
    interest?: number;
}

export interface WatchedLoan {
    mbno: string;
    loancaseno: string;
    loantype: string;
    oldPrincipal: number;
    oldInterest: number;
    newPrincipal: number;
    newInterest: number;
    startDate: Date;   // consolidation (disbursement) date of the new loan
    watchUntil: Date;  // last day payroll may still deduct the old EMI
}

export interface EvaluateInput {
    watched: WatchedLoan;
    total: number;
    principal?: number;
    interest?: number;
    phase: 'IN_WINDOW' | 'AFTER_WINDOW';
    priorOldSized: number;
    tolerance: number;
}

export const DEFAULT_OLD_EMI_FLAG_TOLERANCE = 10;
const MATCH = 1;                 // rupees: "equal"
const AFTER_WINDOW_MONTHS = 2;   // how long after the window an old-EMI-sized amount is still worth a flag

const r2 = (n: number) => Math.round(n * 100) / 100;
const inr = (n: number) => `₹${n.toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
const near = (a: number, b: number, t: number) => Math.abs(a - b) <= t + 0.005;
const monthIndex = (d: Date) => d.getFullYear() * 12 + d.getMonth();

@Injectable()
export class LoanPaymentFlagService {
    constructor(private readonly dataSource: DataSource) { }

    // ───────────────────────── pure rule ─────────────────────────

    /** The decision itself, free of any database access (also what the tests exercise). */
    static evaluate(i: EvaluateInput): LoanFlagCode | null {
        const w = i.watched;
        const oldTotal = r2(w.oldPrincipal + w.oldInterest);
        const newTotal = r2(w.newPrincipal + w.newInterest);
        if (oldTotal <= 0 || newTotal <= 0 || i.total <= 0) return null;

        const eqOld = near(i.total, oldTotal, MATCH);
        const eqNew = near(i.total, newTotal, MATCH);

        if (!eqOld && !eqNew && near(i.total, oldTotal + newTotal, MATCH)) return 'COMBINED_EMI';

        // Same total but the principal / interest split is known (demand file): the split
        // tells the two loans apart, so nothing needs checking.
        if (eqOld && eqNew && i.principal !== undefined && i.interest !== undefined) {
            const splitOld = near(i.principal, w.oldPrincipal, MATCH) && near(i.interest, w.oldInterest, MATCH);
            const splitNew = near(i.principal, w.newPrincipal, MATCH) && near(i.interest, w.newInterest, MATCH);
            if (splitOld !== splitNew) return null;
        }

        if (i.phase === 'IN_WINDOW') {
            if (eqOld && i.priorOldSized >= 1) return 'SECOND_OLD_EMI';
            if (eqOld && eqNew) return 'IDENTICAL_EMI';
            if (!eqOld && !eqNew && near(i.total, oldTotal, i.tolerance)) return 'NEAR_OLD_EMI';
            return null;
        }
        if (eqOld && !eqNew) return 'OLD_EMI_AFTER_WINDOW';
        return null;
    }

    /** Whether a payment date is inside the old-EMI period, shortly after it, or too far past it to matter. */
    static phaseFor(when: Date, watchUntil: Date): EvaluateInput['phase'] | null {
        if (when <= watchUntil) return 'IN_WINDOW';
        if (monthIndex(when) <= monthIndex(watchUntil) + AFTER_WINDOW_MONTHS) return 'AFTER_WINDOW';
        return null;
    }

    static describe(code: LoanFlagCode, ctx: LoanFlagContext, i: EvaluateInput, recordedAsOldEmi: boolean = false): string {
        const w = i.watched;
        const oldTotal = r2(w.oldPrincipal + w.oldInterest);
        const newTotal = r2(w.newPrincipal + w.newInterest);
        const total = inr(i.total);
        const old = inr(oldTotal);
        const nw = inr(newTotal);
        const applied = ctx === 'PAYMENT'
            ? (recordedAsOldEmi ? 'It was recorded as an old EMI deduction' : 'It was recorded as a normal payment')
            : 'It will be applied as a normal payment';
        let body: string;
        switch (code) {
            case 'IDENTICAL_EMI':
                body = `${total} equals both the old loan EMI (${old}) and the new loan EMI (${nw}). `
                    + (ctx === 'PAYMENT'
                        ? 'It was recorded as the old EMI deduction (old first), so the new loan\'s EMI #1 is still unpaid. '
                        : 'If applied as it stands it is taken as the old EMI deduction first, so the new loan\'s EMI #1 stays unpaid. ')
                    + 'Please check which one it really is.';
                break;
            case 'NEAR_OLD_EMI':
                body = `${total} is within ${inr(i.tolerance)} of the old loan EMI (${old}) but not equal to it. ${applied}. `
                    + 'Please check whether it was meant to be the old EMI deduction.';
                break;
            case 'SECOND_OLD_EMI':
                body = `${total} equals the old loan EMI (${old}) again. An old EMI deduction was already counted for this loan, `
                    + `so this one is not counted as another. ${applied}. Please check.`;
                break;
            case 'OLD_EMI_AFTER_WINDOW':
                body = `${total} equals the old loan EMI (${old}) but the old-EMI period of this loan has ended. ${applied}. `
                    + 'Please check whether payroll is still deducting the old EMI.';
                break;
            default:
                body = `${total} equals the old loan EMI (${old}) plus the new loan EMI (${nw}) together. ${applied}; `
                    + 'the old EMI part is not marked separately. Please check.';
        }
        return `${body} To correct it use Journal/Transfer Entry — that changes the ledger and the member balance only, not the loan record or the EMI schedule.`;
    }

    // ───────────────────────── configuration ─────────────────────────

    async getTolerance(runner: DataSource | QueryRunner = this.dataSource): Promise<number> {
        const rows = await runner.query(
            `SELECT value FROM system_configs WHERE key = 'RULE_LOAN_OLD_EMI_FLAG_TOLERANCE' AND "isActive" = true LIMIT 1`,
        );
        const v = Number(rows[0]?.value);
        return Number.isFinite(v) && v >= 0 ? v : DEFAULT_OLD_EMI_FLAG_TOLERANCE;
    }

    // ───────────────────────── Loan Repayment screen ─────────────────────────

    private async countLagCredits(runner: DataSource | QueryRunner, mbno: string, loancaseno: string, loantype: string): Promise<number> {
        const rows = await runner.query(
            `SELECT COUNT(*)::int AS c FROM loan_repayment_ledger
              WHERE loancaseno::text = $1 AND mbno::text = $2 AND loantype = $3 AND is_payroll_lag_credit = true`,
            [loancaseno, mbno, loantype],
        );
        return Number(rows[0]?.c) || 0;
    }

    /**
     * `loan` is the loan_master row read by recordLoanRepayment (needs mbno, loantype,
     * instal_amt, intt_amount, payment_date, payroll_lag_*). Returns null when the loan
     * has no consolidation watch or the payment is nothing to check.
     */
    async checkPayment(
        runner: DataSource | QueryRunner, loan: any, loancaseno: string, amount: number, asOf: Date,
    ): Promise<LoanPaymentFlag | null> {
        const watchUntil = loan.payroll_lag_watch_until ? new Date(loan.payroll_lag_watch_until) : null;
        const oldP = parseFloat(loan.payroll_lag_old_principal) || 0;
        const oldI = parseFloat(loan.payroll_lag_old_interest) || 0;
        if (!watchUntil || isNaN(watchUntil.getTime()) || oldP + oldI <= 0) return null;

        const watched: WatchedLoan = {
            mbno: String(loan.mbno), loancaseno: String(loancaseno), loantype: String(loan.loantype),
            oldPrincipal: oldP, oldInterest: oldI,
            newPrincipal: parseFloat(loan.instal_amt) || 0, newInterest: parseFloat(loan.intt_amount) || 0,
            startDate: new Date(loan.payment_date), watchUntil,
        };
        const phase = LoanPaymentFlagService.phaseFor(asOf, watchUntil);
        if (!phase) return null;

        const input: EvaluateInput = {
            watched, total: r2(amount), phase,
            priorOldSized: await this.countLagCredits(runner, watched.mbno, watched.loancaseno, watched.loantype),
            tolerance: await this.getTolerance(runner),
        };
        const code = LoanPaymentFlagService.evaluate(input);
        if (!code) return null;
        return {
            code, message: LoanPaymentFlagService.describe(code, 'PAYMENT', input),
            loancaseno: watched.loancaseno, loantype: watched.loantype, amount: input.total,
        };
    }

    // ───────────────────────── Demand import ─────────────────────────

    private async loadWatchedLoans(runner: DataSource | QueryRunner, mbnos: string[]): Promise<Map<string, WatchedLoan>> {
        const map = new Map<string, WatchedLoan>();
        if (mbnos.length === 0) return map;
        const rows = await runner.query(
            `SELECT mbno, loancaseno, loantype, payment_date, instal_amt, intt_amount,
                    payroll_lag_watch_until, payroll_lag_old_principal, payroll_lag_old_interest
               FROM loan_master
              WHERE mbno::text = ANY($1) AND balance > 0 AND payroll_lag_watch_until IS NOT NULL
                AND COALESCE(payroll_lag_old_principal, 0) + COALESCE(payroll_lag_old_interest, 0) > 0
              ORDER BY payment_date DESC`,
            [mbnos],
        );
        for (const r of rows) {
            const key = `${r.mbno}|${r.loantype}`;
            if (map.has(key)) continue; // newest case wins
            map.set(key, {
                mbno: String(r.mbno), loancaseno: String(r.loancaseno), loantype: String(r.loantype),
                oldPrincipal: parseFloat(r.payroll_lag_old_principal) || 0, oldInterest: parseFloat(r.payroll_lag_old_interest) || 0,
                newPrincipal: parseFloat(r.instal_amt) || 0, newInterest: parseFloat(r.intt_amount) || 0,
                startDate: new Date(r.payment_date), watchUntil: new Date(r.payroll_lag_watch_until),
            });
        }
        return map;
    }

    /**
     * One demand-file row per item. `loantype` is 'RLN' (R/LOAN + INTT) or 'ALN' (E/LOAN + INTT).
     * Returns flags keyed by `${mbno}|${loantype}`. Whole demand month counts as inside the
     * old-EMI period if any part of it is.
     */
    async checkDemandRows(
        runner: DataSource | QueryRunner,
        items: Array<{ mbno: string; loantype: 'RLN' | 'ALN'; principal: number; interest: number }>,
        month: number, year: number,
    ): Promise<Map<string, LoanPaymentFlag>> {
        const out = new Map<string, LoanPaymentFlag>();
        const candidates = items.filter((x) => x.principal > 0);
        const watchedMap = await this.loadWatchedLoans(runner, [...new Set(candidates.map((x) => x.mbno))]);
        if (watchedMap.size === 0) return out;
        const tolerance = await this.getTolerance(runner);
        const idx = year * 12 + (month - 1);

        for (const item of candidates) {
            const watched = watchedMap.get(`${item.mbno}|${item.loantype}`);
            if (!watched) continue;
            const startIdx = monthIndex(watched.startDate);
            const watchIdx = monthIndex(watched.watchUntil);
            if (idx < startIdx || idx > watchIdx + AFTER_WINDOW_MONTHS) continue;
            const phase: EvaluateInput['phase'] = idx <= watchIdx ? 'IN_WINDOW' : 'AFTER_WINDOW';

            const oldTotal = r2(watched.oldPrincipal + watched.oldInterest);
            const prior = await runner.query(
                `SELECT COALESCE(${item.loantype === 'RLN' ? 'rln_installment_amount' : 'aln_installment_amount'}, 0)
                      + COALESCE(${item.loantype === 'RLN' ? 'rln_interest' : 'aln_interest'}, 0) AS total
                   FROM demand_master
                  WHERE mbno::text = $1 AND (demand_for_year * 12 + demand_for_month - 1) >= $2 AND (demand_for_year * 12 + demand_for_month - 1) < $3`,
                [item.mbno, startIdx, idx],
            );
            const priorDemandRows = prior.filter((p: any) => near(Number(p.total) || 0, oldTotal, MATCH)).length;
            const priorOldSized = priorDemandRows + await this.countLagCredits(runner, watched.mbno, watched.loancaseno, watched.loantype);

            const input: EvaluateInput = {
                watched, total: r2(item.principal + item.interest), principal: item.principal, interest: item.interest,
                phase, priorOldSized, tolerance,
            };
            const code = LoanPaymentFlagService.evaluate(input);
            if (!code) continue;
            out.set(`${item.mbno}|${item.loantype}`, {
                code, message: LoanPaymentFlagService.describe(code, 'DEMAND', input),
                loancaseno: watched.loancaseno, loantype: watched.loantype, amount: input.total,
                principal: item.principal, interest: item.interest,
            });
        }
        return out;
    }
}
