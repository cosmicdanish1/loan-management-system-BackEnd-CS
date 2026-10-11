import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { DataSource, QueryRunner } from 'typeorm';
import { SequenceGeneratorService } from '../../../shared/services';
import { SystemConfigService } from '../../../admin/services/system-config.service';
import { isDebitNormal } from '../../../shared/utils/balance-direction';
import { LoanRepaymentService } from '../loan-repayment.service';
import { RdLienService } from '../../../rd/services/rd-lien.service';
import { RdBalanceEventsService } from '../../../rd/services/rd-balance-events.service';
import { RdRulesService } from '../../../rd/rd-rules.service';
import { LOAN_INTEREST_METHOD } from '../loan-payment-model';
import { interestHeadForLoanType } from '../../loan-interest-heads';
import {
    calculateConstantEmi,
    ConstantEmiResult,
    DEFAULT_SLOT1_END_DAY,
    DEFAULT_SLOT1_START_DAY,
    firstDueMonthFromDisbursement,
    installmentDueMonth,
    LoanRoundingMode,
    persistRbSchedule,
    round2,
} from '../loan-rb-schedule.util';
import { AgreementData } from './reagreement-agreement.layout';
import { ReagreementDocumentService } from './reagreement-document.service';

// ------------------------------------------------------------------ constants
export const OPEN_STATUSES = ['APPLIED', 'SANCTIONED', 'VOUCHERED'] as const;
// ES-46: the loan-interest income head is now per loan type (children of I1002 "INTT FROM MEMBER"); see interestHeadForLoanType.
const VOUCHER_TYPE_CODE = 'RA'; // transactions.vchr_type / ledger.vchr_type (varchar(2))
export const REAGREEMENT_SOURCE_MODULE = 'LOAN_REAGREEMENT';
const MONEY_TOLERANCE = 0.01;

const LOAN_TYPE_NAMES: Record<string, string> = {
    RLN: 'REGULAR LOAN', ALN: 'EMERGENCY LOAN', ELN: 'LOAN AGAINST RD',
};

// ---------------------------------------------------------------------- types
export interface ReagreementQuoteInput {
    mbno: string;
    loancaseno: string;
    loantype?: string;
    newInstallments: number;
    newRate: number;
    /** YYYY-MM-DD; defaults to today. */
    applicationDate?: string;
}

export interface QuoteError {
    field: 'tenure' | 'rate' | 'applicationDate' | 'loan' | 'general';
    code: string;
    message: string;
}

export interface QuoteScheduleRow {
    no: number;
    dueMonth: string;
    openingBalance: number;
    principal: number;
    interest: number;
    installment: number;
    closingBalance: number;
}

export interface ReagreementQuote {
    valid: boolean;
    errors: QuoteError[];
    warnings: string[];
    loan: null | {
        mbno: string; loantype: string; loanTypeName: string; oldCaseNo: string;
        memberName: string; balance: number; oldVersionNo: number | null;
    };
    applicationDate: string;
    asOf: string;
    position: null | {
        outstandingPrincipal: number; nrPrincipal: number; nrInterest: number; penaltyDue: number;
        apInterest: number; closureInterestTotal: number; paidInstallments: number;
        unpaidInstallments: Array<{ installmentNo: number; dueDate: string; principalDue: number; interestDue: number; penalDue: number }>;
    };
    old: null | {
        rate: number; installments: number; monthlyPrincipal: number; monthlyInterest: number;
        monthlyInstallment: number; remainingInstallments: number; remainingPayable: number;
    };
    neu: null | {
        rate: number; installments: number; monthlyPrincipal: number; monthlyInterest: number; monthlyInstallment: number;
        slot: number; subSlot: string | null; interestDelayMonths: number; delayMonths: number;
        delayInterest: number; totalRbInterest: number; totalInterestForEmi: number; carriedInterest: number;
        roundingMode: LoanRoundingMode; firstDueMonth: string; totalPayable: number;
    };
    collect: { nrInterest: number; penalty: number; total: number };
    schedule: QuoteScheduleRow[];
}

export interface ReagreementContext {
    actor: string;
    ip?: string;
    requestId?: string;
}

export interface Rules {
    minInstallmentsPaid: number;
    minOutstanding: number;
    maxTenure: number;       // 0 = no limit
    minRate: number;
    maxRate: number;         // 0 = no limit
    allowRateIncrease: boolean;
    maxPerLoan: number;      // 0 = unlimited
    allowBackdate: boolean;
}

const pad2 = (n: number) => String(n).padStart(2, '0');
export const toYmd = (d: Date) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const parseYmd = (s: string): Date | null => {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s || ''));
    if (!m) return null;
    const d = new Date(parseInt(m[1], 10), parseInt(m[2], 10) - 1, parseInt(m[3], 10));
    return isNaN(d.getTime()) ? null : d;
};
const num = (v: any, d = 0) => { const n = Number(v); return Number.isFinite(n) ? n : d; };

@Injectable()
export class LoanReagreementService {
    private readonly logger = new Logger(LoanReagreementService.name);

    constructor(
        private readonly dataSource: DataSource,
        private readonly sequenceGenerator: SequenceGeneratorService,
        private readonly systemConfigService: SystemConfigService,
        private readonly loanRepaymentService: LoanRepaymentService,
        private readonly documents: ReagreementDocumentService,
    ) { }

    // Built on demand (not injected) so scripts that construct this service by hand keep working.
    private _rdLienService?: RdLienService;
    private get rdLien(): RdLienService {
        if (!this._rdLienService) {
            const rules = new RdRulesService(this.dataSource);
            this._rdLienService = new RdLienService(this.dataSource, new RdBalanceEventsService(this.dataSource, rules), rules);
        }
        return this._rdLienService;
    }

    // ======================================================================
    // Configuration (Business Rules) — every rule defaults to permissive
    // ======================================================================
    private async cfg<T>(key: string, fallback: T): Promise<T> {
        try {
            const v = await this.systemConfigService.getConfigValue(key);
            if (v === undefined || v === null || v === '') return fallback;
            if (typeof fallback === 'boolean') return (v === true || v === 'true' || v === 1 || v === '1') as unknown as T;
            if (typeof fallback === 'number') { const n = Number(v); return (Number.isFinite(n) ? n : fallback) as unknown as T; }
            return v as T;
        } catch {
            return fallback;
        }
    }

    async getRules(): Promise<Rules> {
        return {
            minInstallmentsPaid: await this.cfg('RULE_REAGREEMENT_MIN_INSTALLMENTS_PAID', 0),
            minOutstanding: await this.cfg('RULE_REAGREEMENT_MIN_OUTSTANDING', 0),
            maxTenure: await this.cfg('RULE_REAGREEMENT_MAX_TENURE', 0),
            minRate: await this.cfg('RULE_REAGREEMENT_MIN_RATE', 0),
            maxRate: await this.cfg('RULE_REAGREEMENT_MAX_RATE', 0),
            allowRateIncrease: await this.cfg('RULE_REAGREEMENT_ALLOW_RATE_INCREASE', true),
            maxPerLoan: await this.cfg('RULE_REAGREEMENT_MAX_PER_LOAN', 0),
            allowBackdate: await this.cfg('RULE_REAGREEMENT_ALLOW_BACKDATE', false),
        };
    }

    private async getSlotConfig() {
        const slot1DelayMonths = await this.cfg('RULE_LOAN_SLOT1_DELAY_MONTHS', 1);
        const slot2DelayMonths = await this.cfg('RULE_LOAN_SLOT2_DELAY_MONTHS', 2);
        const slot1StartDay = await this.cfg('RULE_LOAN_SLOT1_START_DAY', DEFAULT_SLOT1_START_DAY);
        const slot1EndDay = await this.cfg('RULE_LOAN_SLOT1_END_DAY', DEFAULT_SLOT1_END_DAY);
        let roundingMode = await this.cfg<string>('RULE_LOAN_ROUNDING_MODE', 'NEAREST');
        if (!['NONE', 'NEAREST', 'UP', 'DOWN'].includes(roundingMode)) roundingMode = 'NEAREST';
        return { slot1DelayMonths, slot2DelayMonths, slot1StartDay, slot1EndDay, roundingMode: roundingMode as LoanRoundingMode };
    }

    // ======================================================================
    // Small DB helpers
    // ======================================================================
    private async nextId(runner: QueryRunner | DataSource, table: string, col: string): Promise<number> {
        const r = await runner.query(`SELECT COALESCE(MAX(${col}), 0) + 1 AS n FROM ${table}`);
        return parseInt(r[0].n, 10);
    }

    private async increaseDirection(runner: QueryRunner, headCode: string): Promise<'DR' | 'CR'> {
        const rows = await runner.query(`SELECT pflag FROM headmaster WHERE code = $1`, [headCode]);
        return isDebitNormal(rows[0]?.pflag) ? 'DR' : 'CR';
    }

    private async writeLog(
        runner: QueryRunner | DataSource, reagreementId: number | string, event: string,
        oldStatus: string | null, newStatus: string | null, ctx: ReagreementContext, details?: any, remarks?: string,
    ) {
        await runner.query(
            `INSERT INTO loan_reagreement_log (reagreement_id, event, old_status, new_status, actor, request_id, details, ip, remarks)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
            [reagreementId, event, oldStatus, newStatus, ctx.actor || 'system', ctx.requestId || null,
                details === undefined ? null : JSON.stringify(details), ctx.ip || null, remarks || null],
        );
    }

    private async loadOldLoan(runner: QueryRunner | DataSource, mbno: string, caseNo: string, loantype?: string, lock = false) {
        const rows = await runner.query(
            `SELECT *, payment_date::date::text AS payment_date_str FROM loan_master
             WHERE loancaseno::text = $1 AND mbno = $2 ${loantype ? 'AND loantype = $3' : ''} ${lock ? 'FOR UPDATE' : ''}`,
            loantype ? [String(caseNo), mbno, loantype] : [String(caseNo), mbno],
        );
        if (rows.length > 1) throw new BadRequestException(`Loan case ${caseNo} exists for more than one loan type of member ${mbno}; specify the loan type`);
        return rows[0] || null;
    }

    private async countPassedChain(mbno: string, loantype: string, caseNo: string): Promise<number> {
        let count = 0;
        let cur = String(caseNo);
        for (let i = 0; i < 50; i++) {
            const r = await this.dataSource.query(
                `SELECT old_loancaseno::text AS old FROM loan_reagreements
                 WHERE mbno = $1 AND loantype = $2 AND new_loancaseno::text = $3 AND status = 'PASSED'`,
                [mbno, loantype, cur],
            );
            if (!r.length) break;
            count++;
            cur = r[0].old;
        }
        return count;
    }

    // ======================================================================
    // Quote (read-only; the ONE calculation used by apply / sanction / voucher / pass)
    // ======================================================================
    async getEligibilityErrors(loan: any, excludeReagreementId?: number | string): Promise<QuoteError[]> {
        const errors: QuoteError[] = [];
        if (!loan) { errors.push({ field: 'loan', code: 'NOT_FOUND', message: 'Loan case not found for this member' }); return errors; }
        if (num(loan.balance) <= 0) errors.push({ field: 'loan', code: 'NOT_ACTIVE', message: 'This loan has no outstanding balance, so it cannot be re-agreed' });
        if (loan.consolidated_into_loancaseno !== null && loan.consolidated_into_loancaseno !== undefined) {
            errors.push({ field: 'loan', code: 'ALREADY_CLOSED', message: `This loan case was already closed into loan case ${loan.consolidated_into_loancaseno}` });
        }
        const open = await this.dataSource.query(
            `SELECT reagreement_no, status FROM loan_reagreements
             WHERE mbno = $1 AND loantype = $2 AND old_loancaseno::text = $3 AND status IN ('APPLIED','SANCTIONED','VOUCHERED')
               ${excludeReagreementId ? 'AND id <> $4' : ''}`,
            excludeReagreementId ? [loan.mbno, loan.loantype, String(loan.loancaseno), excludeReagreementId] : [loan.mbno, loan.loantype, String(loan.loancaseno)],
        );
        if (open.length) errors.push({ field: 'loan', code: 'OPEN_REAGREEMENT', message: `Re-agreement ${open[0].reagreement_no} is already open (${open[0].status}) on this loan` });
        return errors;
    }

    /** Eligibility only (no calculation) — hard checks plus the loan-level business rules. */
    async eligibility(mbno: string, caseNo: string, loantype?: string) {
        let loan: any = null;
        const errors: QuoteError[] = [];
        try { loan = await this.loadOldLoan(this.dataSource, mbno, caseNo, loantype); } catch (e: any) { errors.push({ field: 'loan', code: 'AMBIGUOUS', message: e.message }); }
        if (!errors.length) errors.push(...await this.getEligibilityErrors(loan));
        return { eligible: errors.length === 0, errors, rules: await this.getRules() };
    }

    /** Pure-ish quote. Never writes. Returns the internal calc too (for pass-time use). */
    async computeQuote(input: ReagreementQuoteInput, opts: { excludeReagreementId?: number | string; asOf?: Date } = {}):
        Promise<{ quote: ReagreementQuote; calc: ConstantEmiResult | null; oldLoan: any; closure: any }> {
        const errors: QuoteError[] = [];
        const warnings: string[] = [];
        const today = opts.asOf ?? new Date();
        const todayStr = toYmd(today);
        const empty = (): ReagreementQuote => ({
            valid: false, errors, warnings, loan: null, applicationDate: input.applicationDate || todayStr, asOf: todayStr,
            position: null, old: null, neu: null, collect: { nrInterest: 0, penalty: 0, total: 0 }, schedule: [],
        });

        const rules = await this.getRules();

        // ---- input validation (field-level) ----
        const n = Number(input.newInstallments);
        if (!Number.isInteger(n) || n < 1) errors.push({ field: 'tenure', code: 'INVALID', message: 'Number of installments must be a whole number of at least 1' });
        else if (n > 600) errors.push({ field: 'tenure', code: 'ABOVE_MAX', message: 'Number of installments cannot exceed 600' });
        else if (rules.maxTenure > 0 && n > rules.maxTenure) errors.push({ field: 'tenure', code: 'ABOVE_MAX', message: `Maximum tenure is ${rules.maxTenure} months` });

        const rate = Number(input.newRate);
        if (!Number.isFinite(rate) || rate < 0) errors.push({ field: 'rate', code: 'INVALID', message: 'Interest rate must be a number, zero or more' });
        else if (rate > 100) errors.push({ field: 'rate', code: 'ABOVE_MAX', message: 'Interest rate cannot exceed 100%' });
        else {
            if (rules.minRate > 0 && rate < rules.minRate) errors.push({ field: 'rate', code: 'BELOW_MIN', message: `Minimum rate is ${rules.minRate}%` });
            if (rules.maxRate > 0 && rate > rules.maxRate) errors.push({ field: 'rate', code: 'ABOVE_MAX', message: `Maximum rate is ${rules.maxRate}%` });
        }

        const appDateStr = input.applicationDate || todayStr;
        const appDate = parseYmd(appDateStr);
        if (!appDate) errors.push({ field: 'applicationDate', code: 'INVALID', message: 'Application date is not a valid date' });
        else if (appDateStr > todayStr) errors.push({ field: 'applicationDate', code: 'FUTURE', message: 'Application date cannot be in the future' });
        else if (appDateStr < todayStr && !rules.allowBackdate) errors.push({ field: 'applicationDate', code: 'BACKDATED', message: 'Back-dated applications are not allowed; use today\'s date' });

        // ---- loan + eligibility ----
        let oldLoan: any = null;
        try {
            oldLoan = await this.loadOldLoan(this.dataSource, input.mbno, input.loancaseno, input.loantype);
        } catch (e: any) {
            errors.push({ field: 'loan', code: 'AMBIGUOUS', message: e.message });
            return { quote: empty(), calc: null, oldLoan: null, closure: null };
        }
        errors.push(...await this.getEligibilityErrors(oldLoan, opts.excludeReagreementId));
        if (!oldLoan || errors.some(e => e.field === 'loan')) return { quote: empty(), calc: null, oldLoan, closure: null };

        // ---- position of the old loan (read-only early-closure quote) ----
        let closure: any;
        try {
            closure = await this.loanRepaymentService.calculateEarlyClosure(String(oldLoan.loancaseno), today, 0, false, input.mbno);
        } catch (e: any) {
            errors.push({ field: 'loan', code: 'LEDGER', message: `The loan's position could not be worked out: ${e.message}` });
            return { quote: empty(), calc: null, oldLoan, closure: null };
        }
        const outstanding = round2(num(closure.outstandingPrincipal));
        if (outstanding <= 0) errors.push({ field: 'loan', code: 'NO_PRINCIPAL', message: 'Outstanding principal is zero; nothing to re-agree' });
        if (rules.minOutstanding > 0 && outstanding < rules.minOutstanding) errors.push({ field: 'loan', code: 'BELOW_MIN_OUTSTANDING', message: `Outstanding principal is below the minimum of Rs. ${rules.minOutstanding}` });
        const paidInstallments = Math.max(0, Math.trunc(num(closure.paidInstallments)));
        if (rules.minInstallmentsPaid > 0 && paidInstallments < rules.minInstallmentsPaid) errors.push({ field: 'loan', code: 'TOO_EARLY', message: `At least ${rules.minInstallmentsPaid} installments must be paid before a re-agreement (paid: ${paidInstallments})` });
        if (rules.maxPerLoan > 0) {
            const done = await this.countPassedChain(String(oldLoan.mbno), oldLoan.loantype, String(oldLoan.loancaseno));
            if (done >= rules.maxPerLoan) errors.push({ field: 'loan', code: 'MAX_REAGREEMENTS', message: `This loan has already been re-agreed ${done} time(s); the maximum is ${rules.maxPerLoan}` });
        }

        // old agreement terms
        const eff = closure.effectiveSchedule;
        const oldCount = Math.trunc(num(closure.noOfInstal));
        const oldInstalAmt = num(closure.instalAmt);
        let oldMonthlyPrincipal: number;
        let oldMonthlyInterest: number;
        let oldRate: number;
        if (eff) {
            oldMonthlyPrincipal = round2(num(eff.monthlyPrincipal));
            oldMonthlyInterest = round2(Math.max(0, oldInstalAmt - oldMonthlyPrincipal));
        } else {
            const mp = oldCount > 0 ? round2(num(oldLoan.loan_amt) / oldCount) : 0;
            oldMonthlyPrincipal = mp;
            const constInt = num(oldLoan.intt_amount);
            oldMonthlyInterest = constInt > 0 ? round2(constInt) : round2(Math.max(0, num(oldLoan.instal_amt) - mp));
        }
        const verRows = await this.dataSource.query(
            `SELECT annual_rate FROM loan_schedule_versions WHERE mbno = $1 AND loantype = $2 AND loancaseno::text = $3 ORDER BY version_no DESC LIMIT 1`,
            [oldLoan.mbno, oldLoan.loantype, String(oldLoan.loancaseno)],
        );
        oldRate = verRows[0] ? num(verRows[0].annual_rate) : num(oldLoan.rate);
        if (Number.isFinite(rate) && !rules.allowRateIncrease && rate > oldRate + 1e-9) {
            errors.push({ field: 'rate', code: 'RATE_INCREASE', message: `The rate cannot be higher than the current ${oldRate}%` });
        }

        const nrInterest = round2(num(closure.nrInterest));
        const penalty = round2(num(closure.penalInterest));
        const ap = round2(Math.max(0, num(closure.apInterest)));

        // ---- identity bits for the response ----
        const mrows = await this.dataSource.query(
            `SELECT TRIM(COALESCE(f_name,'') || ' ' || COALESCE(m_name,'') || ' ' || COALESCE(l_name,'')) AS name FROM member_master WHERE mbno = $1`, [oldLoan.mbno]);

        const loanInfo = {
            mbno: String(oldLoan.mbno), loantype: oldLoan.loantype, loanTypeName: LOAN_TYPE_NAMES[oldLoan.loantype] || oldLoan.loantype,
            oldCaseNo: String(oldLoan.loancaseno), memberName: mrows[0]?.name || '', balance: round2(num(oldLoan.balance)),
            oldVersionNo: eff ? Math.trunc(num(eff.versionNo)) : null,
        };
        const position = {
            outstandingPrincipal: outstanding, nrPrincipal: round2(num(closure.nrPrincipal)), nrInterest, penaltyDue: penalty,
            apInterest: ap, closureInterestTotal: round2(nrInterest + ap + penalty), paidInstallments,
            unpaidInstallments: (closure.unpaidInstallments || []).map((u: any) => ({
                installmentNo: u.installmentNo, dueDate: u.dueDate, principalDue: round2(num(u.principalDue)),
                interestDue: round2(num(u.interestDue)), penalDue: round2(num(u.penalDue)),
            })),
        };
        const remaining = Math.max(0, oldCount - paidInstallments);
        const oldBlock = {
            rate: oldRate, installments: oldCount, monthlyPrincipal: oldMonthlyPrincipal, monthlyInterest: oldMonthlyInterest,
            monthlyInstallment: round2(oldMonthlyPrincipal + oldMonthlyInterest), remainingInstallments: remaining,
            remainingPayable: round2(remaining * (oldMonthlyPrincipal + oldMonthlyInterest)),
        };

        if (errors.length > 0 || !appDate) {
            const q = empty();
            q.loan = loanInfo; q.position = position; q.old = oldBlock;
            q.collect = { nrInterest, penalty, total: round2(nrInterest + penalty) };
            return { quote: q, calc: null, oldLoan, closure };
        }

        // ---- the new agreement: priced exactly like a new loan (+ carried AP) ----
        const sc = await this.getSlotConfig();
        const calc = calculateConstantEmi(outstanding, rate, n, appDate, sc.slot1DelayMonths, sc.slot2DelayMonths,
            sc.roundingMode, sc.slot1StartDay, sc.slot1EndDay, ap);
        const firstDue = firstDueMonthFromDisbursement(today, calc.firstDueDelayMonths);
        const emi = calc.constantEMI;
        const schedule: QuoteScheduleRow[] = calc.rbSchedule.map((r, i) => {
            const last = i === calc.rbSchedule.length - 1;
            const principal = last ? round2(r.openingBalance) : round2(r.principal);
            return {
                no: r.installmentNo, dueMonth: toYmd(installmentDueMonth(firstDue, r.installmentNo)),
                openingBalance: r.openingBalance, principal, interest: round2(calc.monthlyInterestForEMI),
                installment: round2(principal + calc.monthlyInterestForEMI), closingBalance: r.closingBalance,
            };
        });
        const quote: ReagreementQuote = {
            valid: true, errors: [], warnings, loan: loanInfo, applicationDate: appDateStr, asOf: todayStr,
            position, old: oldBlock,
            neu: {
                rate, installments: n, monthlyPrincipal: round2(calc.monthlyPrincipal), monthlyInterest: round2(calc.monthlyInterestForEMI),
                monthlyInstallment: emi, slot: calc.slot, subSlot: calc.subSlot, interestDelayMonths: calc.interestDelayMonths,
                delayMonths: calc.delayMonths, delayInterest: calc.delayInterest, totalRbInterest: calc.totalRBInterest,
                totalInterestForEmi: calc.totalInterestForEMI, carriedInterest: calc.carriedInterest, roundingMode: sc.roundingMode,
                firstDueMonth: toYmd(firstDue), totalPayable: round2(emi * n),
            },
            collect: { nrInterest, penalty, total: round2(nrInterest + penalty) },
            schedule,
        };
        return { quote, calc, oldLoan, closure };
    }

    async buildQuote(input: ReagreementQuoteInput, opts: { excludeReagreementId?: number | string } = {}): Promise<ReagreementQuote> {
        return (await this.computeQuote(input, opts)).quote;
    }

    private assertValid(q: ReagreementQuote) {
        if (!q.valid) throw new BadRequestException(q.errors.map(e => e.message).join('; ') || 'Re-agreement is not possible');
    }

    // ======================================================================
    // Apply  (Loan Re-agreement window) -> loan_pending (PENDING) + loan_reagreements APPLIED
    // ======================================================================
    async apply(input: ReagreementQuoteInput & { reason?: string }, ctx: ReagreementContext) {
        const quote = await this.buildQuote(input);
        this.assertValid(quote);
        const q = quote;
        const neu = q.neu!, old = q.old!, pos = q.position!, loan = q.loan!;
        const newCase = await this.sequenceGenerator.generateNextLoanCaseNo();
        const reNo = await this.sequenceGenerator.generateSequence('REAGREEMENT_NO', 'RA', 5);

        const qr = this.dataSource.createQueryRunner();
        await qr.connect();
        await qr.startTransaction();
        try {
            // sureties / form number carry over from the old case
            const lp = await qr.query(
                `SELECT g1mbno, g2mbno, g3mbno, form_number, penalrate FROM loan_pending WHERE loancaseno::text = $1 AND mbno = $2 LIMIT 1`,
                [loan.oldCaseNo, loan.mbno]);
            let g1 = lp[0]?.g1mbno ?? 0, g2 = lp[0]?.g2mbno ?? 0;
            const g3 = lp[0]?.g3mbno ?? 0;
            if (!lp.length) {
                const sm = await qr.query(`SELECT g1mbno, g2mbno FROM suretymaster WHERE mbno = $1 LIMIT 1`, [loan.mbno]);
                g1 = sm[0]?.g1mbno ?? 0; g2 = sm[0]?.g2mbno ?? 0;
            }
            const oldLoanRow = await this.loadOldLoan(qr, loan.mbno, loan.oldCaseNo, loan.loantype);

            const ins = await qr.query(
                `INSERT INTO loan_reagreements (
                    reagreement_no, mbno, loantype, old_loancaseno, new_loancaseno, status, old_version_no,
                    application_date, old_rate, old_installment_count, old_monthly_principal, old_monthly_interest, old_monthly_installment,
                    installments_paid, outstanding_principal, nr_principal, nr_interest, penalty_due, ap_interest_carried, closure_interest_total,
                    new_rate, new_installment_count, new_monthly_principal, new_monthly_interest, new_monthly_installment,
                    slot, sub_slot, interest_delay_months, delay_months, first_due_month,
                    total_rb_interest, delay_interest, total_interest_for_emi, rounding_mode, calc_snapshot, reason, created_by)
                 VALUES ($1,$2,$3,$4,$5,'APPLIED',$6,$7::date,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,
                         $25,$26,$27,$28,$29::date,$30,$31,$32,$33,$34,$35,$36)
                 RETURNING id`,
                [reNo, loan.mbno, loan.loantype, loan.oldCaseNo, newCase, loan.oldVersionNo, q.applicationDate,
                    old.rate, old.installments, old.monthlyPrincipal, old.monthlyInterest, old.monthlyInstallment,
                    pos.paidInstallments, pos.outstandingPrincipal, pos.nrPrincipal, pos.nrInterest, pos.penaltyDue, pos.apInterest, pos.closureInterestTotal,
                    neu.rate, neu.installments, neu.monthlyPrincipal, neu.monthlyInterest, neu.monthlyInstallment,
                    neu.slot, neu.subSlot, neu.interestDelayMonths, neu.delayMonths, neu.firstDueMonth,
                    neu.totalRbInterest, neu.delayInterest, neu.totalInterestForEmi, neu.roundingMode, JSON.stringify(q),
                    (input.reason || '').slice(0, 500), ctx.actor || 'system'],
            );
            const id = ins[0].id;

            await qr.query(
                `INSERT INTO loan_pending (mbno, loantype, loancaseno, applied_amt, sanctioned_amt, app_date, no_of_instal, purpose,
                                           flg_sanctioned, flg_paid, form_number, g1mbno, g2mbno, g3mbno, rate, penalrate,
                                           application_kind, reagreement_id)
                 VALUES ($1,$2,$3,$4,0,$5::date,$6,$7,'N','N',$8,$9,$10,$11,$12,$13,'REAGREEMENT',$14)`,
                [loan.mbno, loan.loantype, newCase, pos.outstandingPrincipal, q.applicationDate, neu.installments,
                    `RE-AGREEMENT OF CASE ${loan.oldCaseNo}`.slice(0, 50), (lp[0]?.form_number || '0').slice(0, 10),
                    g1 || 0, g2 || 0, g3 || 0, neu.rate, lp[0]?.penalrate ?? oldLoanRow?.penalrate ?? null, id],
            );
            await qr.query(
                `INSERT INTO loan_nominee (srno, loancaseno, name, address, age, relation)
                 SELECT srno, $1::numeric, name, address, age, relation FROM loan_nominee WHERE loancaseno::text = $2`,
                [newCase, loan.oldCaseNo]);

            await this.writeLog(qr, id, 'APPLIED', null, 'APPLIED', ctx,
                { newCaseNo: newCase, quote: { principal: pos.outstandingPrincipal, emi: neu.monthlyInstallment, tenure: neu.installments, rate: neu.rate } });
            await qr.commitTransaction();
            return { id: Number(id), reagreementNo: reNo, newLoanCaseNo: String(newCase), oldLoanCaseNo: loan.oldCaseNo, status: 'APPLIED', quote };
        } catch (e) {
            await qr.rollbackTransaction();
            throw e;
        } finally {
            await qr.release();
        }
    }

    // ======================================================================
    // Row access
    // ======================================================================
    private rowSelect = `r.*, r.application_date::text AS application_date_s, r.sanction_date::text AS sanction_date_s,
        r.effective_date::text AS effective_date_s, r.first_due_month::text AS first_due_month_s,
        r.payroll_lag_watch_until::text AS payroll_lag_watch_until_s`;

    async getRowById(runner: QueryRunner | DataSource, id: number | string, lock = false) {
        const rows = await runner.query(`SELECT ${this.rowSelect} FROM loan_reagreements r WHERE r.id = $1 ${lock ? 'FOR UPDATE OF r' : ''}`, [id]);
        return rows[0] || null;
    }

    async getRowByNewCase(runner: QueryRunner | DataSource, caseNo: string | number, mbno?: string, lock = false) {
        const rows = await runner.query(
            `SELECT ${this.rowSelect} FROM loan_reagreements r WHERE r.new_loancaseno::text = $1 ${mbno ? 'AND r.mbno = $2' : ''} ${lock ? 'FOR UPDATE OF r' : ''}`,
            mbno ? [String(caseNo), mbno] : [String(caseNo)]);
        return rows[0] || null;
    }

    async getRowByVoucher(runner: QueryRunner | DataSource, voucherNo: string, lock = false) {
        const rows = await runner.query(
            `SELECT ${this.rowSelect} FROM loan_reagreements r WHERE r.voucher_no = $1 ${lock ? 'FOR UPDATE OF r' : ''}`, [voucherNo]);
        return rows[0] || null;
    }

    /** Is this loan_pending case a re-agreement? (used by Sanction / Loan Payment hooks) */
    async isReagreementCase(runner: QueryRunner | DataSource, caseNo: string | number): Promise<boolean> {
        const r = await runner.query(`SELECT 1 FROM loan_pending WHERE loancaseno::text = $1 AND application_kind = 'REAGREEMENT' LIMIT 1`, [String(caseNo)]);
        return r.length > 0;
    }

    /** Open re-agreement against an OLD case (used to block early closure). */
    async getOpenForOldCase(mbno: string, caseNo: string | number, runner: QueryRunner | DataSource = this.dataSource) {
        const rows = await runner.query(
            `SELECT reagreement_no, status FROM loan_reagreements
             WHERE mbno = $1 AND old_loancaseno::text = $2 AND status IN ('APPLIED','SANCTIONED','VOUCHERED') LIMIT 1`,
            [mbno, String(caseNo)]);
        return rows[0] || null;
    }

    private toDto(r: any) {
        if (!r) return null;
        return {
            id: Number(r.id), reagreementNo: r.reagreement_no, mbno: String(r.mbno), loantype: r.loantype,
            oldLoanCaseNo: String(r.old_loancaseno), newLoanCaseNo: String(r.new_loancaseno), status: r.status,
            voucherNo: r.voucher_no, applicationDate: r.application_date_s, sanctionDate: r.sanction_date_s,
            effectiveDate: r.effective_date_s, firstDueMonth: r.first_due_month_s,
            slot: r.slot, delayMonths: r.delay_months,
            old: { rate: num(r.old_rate), installments: r.old_installment_count, monthlyPrincipal: num(r.old_monthly_principal),
                monthlyInterest: num(r.old_monthly_interest), monthlyInstallment: num(r.old_monthly_installment), paidInstallments: r.installments_paid },
            position: { outstandingPrincipal: num(r.outstanding_principal), nrPrincipal: num(r.nr_principal), nrInterest: num(r.nr_interest),
                penaltyDue: num(r.penalty_due), apInterest: num(r.ap_interest_carried), closureInterestTotal: num(r.closure_interest_total) },
            neu: { rate: num(r.new_rate), installments: r.new_installment_count, monthlyPrincipal: num(r.new_monthly_principal),
                monthlyInterest: num(r.new_monthly_interest), monthlyInstallment: num(r.new_monthly_installment),
                delayInterest: num(r.delay_interest), totalRbInterest: num(r.total_rb_interest), totalInterestForEmi: num(r.total_interest_for_emi) },
            collect: { nrInterest: num(r.nr_interest), penalty: num(r.penalty_due), total: round2(num(r.nr_interest) + num(r.penalty_due)) },
            reason: r.reason, createdBy: r.created_by, createdAt: r.created_at, sanctionedBy: r.sanctioned_by,
            passedBy: r.passed_by, passedAt: r.passed_at, cancelledBy: r.cancelled_by, cancelledAt: r.cancelled_at,
            reversedBy: r.reversed_by, reversedAt: r.reversed_at, reversalReason: r.reversal_reason,
        };
    }

    async getById(id: number | string) {
        const r = await this.getRowById(this.dataSource, id);
        if (!r) throw new NotFoundException('Re-agreement not found');
        return this.toDto(r);
    }

    async getByNewCase(caseNo: string, mbno?: string) {
        const r = await this.getRowByNewCase(this.dataSource, caseNo, mbno);
        return this.toDto(r);
    }

    // ======================================================================
    // Sanction  (called from LoanSanctionService.updateLoanSanction for re-agreement cases)
    // ======================================================================
    async sanction(caseNo: string, data: { noOfInstallments: number; rate: number; sanctionDate?: any; sanctionedAmount?: any }, ctx: ReagreementContext) {
        const ra = await this.getRowByNewCase(this.dataSource, caseNo);
        if (!ra) throw new NotFoundException(`Re-agreement for case ${caseNo} not found`);
        if (!['APPLIED', 'SANCTIONED'].includes(ra.status)) {
            throw new BadRequestException(`Re-agreement ${ra.reagreement_no} is ${ra.status}; it can no longer be sanctioned`);
        }
        const quote = await this.buildQuote({
            mbno: String(ra.mbno), loancaseno: String(ra.old_loancaseno), loantype: ra.loantype,
            newInstallments: Number(data.noOfInstallments), newRate: Number(data.rate), applicationDate: ra.application_date_s,
        }, { excludeReagreementId: ra.id });
        this.assertValid(quote);
        const neu = quote.neu!, pos = quote.position!, old = quote.old!;
        const sanctionDate = data.sanctionDate ? (parseYmd(String(data.sanctionDate)) ? String(data.sanctionDate).slice(0, 10) : toYmd(new Date())) : toYmd(new Date());

        const qr = this.dataSource.createQueryRunner();
        await qr.connect();
        await qr.startTransaction();
        try {
            await qr.query(
                `UPDATE loan_reagreements SET status = 'SANCTIONED', sanction_date = $2::date, sanctioned_by = $3, sanctioned_at = NOW(),
                    old_rate=$4, old_installment_count=$5, old_monthly_principal=$6, old_monthly_interest=$7, old_monthly_installment=$8,
                    installments_paid=$9, outstanding_principal=$10, nr_principal=$11, nr_interest=$12, penalty_due=$13,
                    ap_interest_carried=$14, closure_interest_total=$15, new_rate=$16, new_installment_count=$17,
                    new_monthly_principal=$18, new_monthly_interest=$19, new_monthly_installment=$20, slot=$21, sub_slot=$22,
                    interest_delay_months=$23, delay_months=$24, first_due_month=$25::date, total_rb_interest=$26, delay_interest=$27,
                    total_interest_for_emi=$28, rounding_mode=$29, calc_snapshot=$30
                 WHERE id = $1`,
                [ra.id, sanctionDate, ctx.actor || 'system',
                    old.rate, old.installments, old.monthlyPrincipal, old.monthlyInterest, old.monthlyInstallment,
                    pos.paidInstallments, pos.outstandingPrincipal, pos.nrPrincipal, pos.nrInterest, pos.penaltyDue,
                    pos.apInterest, pos.closureInterestTotal, neu.rate, neu.installments,
                    neu.monthlyPrincipal, neu.monthlyInterest, neu.monthlyInstallment, neu.slot, neu.subSlot,
                    neu.interestDelayMonths, neu.delayMonths, neu.firstDueMonth, neu.totalRbInterest, neu.delayInterest,
                    neu.totalInterestForEmi, neu.roundingMode, JSON.stringify(quote)],
            );
            await qr.query(
                `UPDATE loan_pending SET sanctioned_amt = $2, applied_amt = $2, sanctioned_date = $3::date, no_of_instal = $4, rate = $5, flg_sanctioned = 'Y'
                 WHERE loancaseno::text = $1 AND application_kind = 'REAGREEMENT'`,
                [String(caseNo), pos.outstandingPrincipal, sanctionDate, neu.installments, neu.rate]);
            await this.writeLog(qr, ra.id, ra.status === 'SANCTIONED' ? 'SANCTION_CHANGED' : 'SANCTIONED', ra.status, 'SANCTIONED', ctx, {
                before: { tenure: ra.new_installment_count, rate: num(ra.new_rate), emi: num(ra.new_monthly_installment) },
                after: { tenure: neu.installments, rate: neu.rate, emi: neu.monthlyInstallment },
            });
            await qr.commitTransaction();
        } catch (e) {
            await qr.rollbackTransaction();
            throw e;
        } finally {
            await qr.release();
        }
        return { success: true, message: 'Re-agreement sanctioned successfully', data: { loancaseno: caseNo, quote } };
    }

    // ======================================================================
    // Loan Payment step -> voucher PENDING with the NR / penalty receipt lines
    // ======================================================================
    async createVoucher(caseNo: string, dto: { paymentMode?: string; bankName?: string; chequeNo?: string; chequeDate?: string; narration?: string },
        ctx: ReagreementContext) {
        const ra = await this.getRowByNewCase(this.dataSource, caseNo);
        if (!ra) throw new NotFoundException(`Re-agreement for case ${caseNo} not found`);
        if (ra.status !== 'SANCTIONED') throw new BadRequestException(`Re-agreement ${ra.reagreement_no} is ${ra.status}; only a sanctioned re-agreement can be taken to Pass Transactions`);

        const quote = await this.buildQuote({
            mbno: String(ra.mbno), loancaseno: String(ra.old_loancaseno), loantype: ra.loantype,
            newInstallments: ra.new_installment_count, newRate: num(ra.new_rate), applicationDate: ra.application_date_s,
        }, { excludeReagreementId: ra.id });
        this.assertValid(quote);
        this.assertSameFigures(ra, quote, 'sanction');

        const mode = String(dto.paymentMode || 'CASH').toUpperCase() === 'BANK' ? 'BANK' : 'CASH';
        const lines: Array<{ code: string; name: string; amount: number }> = [];
        const INTEREST_HEAD = interestHeadForLoanType(ra.loantype);
        if (quote.collect.nrInterest > 0) lines.push({ code: INTEREST_HEAD, name: `NR interest recovered - re-agreement of case ${ra.old_loancaseno}`, amount: quote.collect.nrInterest });
        if (quote.collect.penalty > 0) lines.push({ code: INTEREST_HEAD, name: `Penalty recovered - re-agreement of case ${ra.old_loancaseno}`, amount: quote.collect.penalty });
        const total = round2(quote.collect.total);

        const qr = this.dataSource.createQueryRunner();
        await qr.connect();
        await qr.startTransaction();
        try {
            await qr.query(`SELECT pg_advisory_xact_lock(hashtext('ledger'))`);
            const voucherNumber = await this.sequenceGenerator.getNextVoucherNumber();
            const vid = await this.nextId(qr, 'vouchers', 'id');
            await qr.query(
                `INSERT INTO vouchers ("id","voucherNumber","voucherDate","voucherType","totalAmount","description","memberId","payeeName",
                                       "status","remarks","chequeNumber","chequeDate","bankName","createdAt","businessEvent","sourceModule","sourceId")
                 VALUES ($1,$2,NOW()::date,'RECEIPT',$3,$4,$5,'','PENDING',$6,$7,$8::date,$9,NOW(),$10,$11,$12)`,
                [vid, voucherNumber, total,
                    `Loan Re-agreement - case ${ra.old_loancaseno} to ${ra.new_loancaseno}`, ra.mbno,
                    `REAGREEMENT:${ra.id}|OLD_CASE:${ra.old_loancaseno}|NEW_CASE:${ra.new_loancaseno}|PAY_MODE:${mode}`,
                    dto.chequeNo || null, dto.chequeDate || null, dto.bankName || null,
                    'LOAN_REAGREEMENT', REAGREEMENT_SOURCE_MODULE, String(ra.id)],
            );
            const rows = lines.length ? lines : [{ code: INTEREST_HEAD, name: `Re-agreement of case ${ra.old_loancaseno} - nothing to collect`, amount: 0 }];
            let transNo = await this.nextId(qr, 'transactions', 'trans_no');
            for (const l of rows) {
                await qr.query(
                    `INSERT INTO transactions (trans_no, trans_type, trans_date, mbno, trans_amt, receipt_vchr_no, vchr_type, modeofpay,
                                               pass_flag, cashier_flag, narration, code, cheq_amt)
                     VALUES ($1,'R',NOW(),$2,$3,$4,$5,$6,'N','N',$7,$8,0)`,
                    [transNo++, ra.mbno, l.amount, voucherNumber, VOUCHER_TYPE_CODE, mode === 'CASH' ? 'C' : 'B', l.name.slice(0, 250), l.code]);
            }
            await qr.query(`UPDATE loan_reagreements SET status = 'VOUCHERED', voucher_no = $2 WHERE id = $1`, [ra.id, voucherNumber]);
            await this.writeLog(qr, ra.id, 'VOUCHER_CREATED', 'SANCTIONED', 'VOUCHERED', ctx, { voucherNo: voucherNumber, collect: quote.collect, mode });
            await qr.commitTransaction();
            return { success: true, message: 'Re-agreement voucher generated and staged successfully', voucherNo: voucherNumber };
        } catch (e) {
            await qr.rollbackTransaction();
            throw e;
        } finally {
            await qr.release();
        }
    }

    /** Figures stored at sanction must still hold (principal, NR, penalty, AP, EMI). */
    private assertSameFigures(ra: any, q: ReagreementQuote, since: string) {
        const diffs: string[] = [];
        const chk = (label: string, stored: any, now: number) => { if (Math.abs(num(stored) - now) > MONEY_TOLERANCE) diffs.push(`${label} ${num(stored)} -> ${now}`); };
        chk('outstanding principal', ra.outstanding_principal, q.position!.outstandingPrincipal);
        chk('NR interest', ra.nr_interest, q.position!.nrInterest);
        chk('penalty', ra.penalty_due, q.position!.penaltyDue);
        chk('carried interest', ra.ap_interest_carried, q.position!.apInterest);
        chk('monthly installment', ra.new_monthly_installment, q.neu!.monthlyInstallment);
        if (diffs.length) {
            throw new BadRequestException(
                `The loan's figures changed since ${since} (${diffs.join('; ')}). Sanction the re-agreement again to refresh them.`);
        }
    }

    // ======================================================================
    // Pass Transactions hooks (run INSIDE the caller's transaction)
    // ======================================================================
    /** Voucher rejected at Pass Transactions: the re-agreement goes back to SANCTIONED (like a rejected disbursement voucher). */
    async onVoucherRejected(qr: QueryRunner, voucherNo: string, ctx: ReagreementContext) {
        const ra = await this.getRowByVoucher(qr, voucherNo, true);
        if (!ra) return;
        await qr.query(`UPDATE loan_reagreements SET status = 'SANCTIONED', voucher_no = NULL WHERE id = $1`, [ra.id]);
        await this.writeLog(qr, ra.id, 'VOUCHER_REJECTED', ra.status, 'SANCTIONED', ctx, { voucherNo });
    }

    async passInTransaction(qr: QueryRunner, voucherNo: string, header: any, details: any[], postedBy: string) {
        const ctx: ReagreementContext = { actor: postedBy };
        const marker = /REAGREEMENT:(\d+)/.exec(header.remarks || '');
        const ra = marker ? await this.getRowById(qr, marker[1], true) : await this.getRowByVoucher(qr, voucherNo, true);
        if (!ra) throw new Error('Re-agreement record not found for this voucher');
        if (ra.status !== 'VOUCHERED' || ra.voucher_no !== voucherNo) {
            throw new Error(`Re-agreement ${ra.reagreement_no} is ${ra.status}; this voucher cannot be passed`);
        }

        // lock the old loan and make sure it is still the same active loan
        const oldLoan = await this.loadOldLoan(qr, String(ra.mbno), String(ra.old_loancaseno), ra.loantype, true);
        if (!oldLoan || num(oldLoan.balance) <= 0 || oldLoan.consolidated_into_loancaseno !== null) {
            throw new Error(`Old loan case ${ra.old_loancaseno} is no longer active; reject this voucher`);
        }

        // recompute everything as of today; refuse if anything moved since the voucher was made
        const { quote, calc } = await this.computeQuote({
            mbno: String(ra.mbno), loancaseno: String(ra.old_loancaseno), loantype: ra.loantype,
            newInstallments: ra.new_installment_count, newRate: num(ra.new_rate), applicationDate: ra.application_date_s,
        }, { excludeReagreementId: ra.id });
        if (!quote.valid || !calc) throw new Error(quote.errors.map(e => e.message).join('; ') || 'Re-agreement is no longer valid');
        try {
            this.assertSameFigures(ra, quote, 'the voucher was created');
        } catch (e: any) {
            throw new Error(String(e.message).replace('Sanction the re-agreement again to refresh them.', 'Reject this voucher, sanction the re-agreement again and create a new voucher.'));
        }
        const pos = quote.position!, neu = quote.neu!, old = quote.old!;
        const balDiff = Math.abs(round2(num(oldLoan.balance)) - pos.outstandingPrincipal);
        if (balDiff > 10) {
            throw new Error(`Old loan case ${ra.old_loancaseno}: loan_master.balance Rs. ${round2(num(oldLoan.balance))} and the ledger-derived principal Rs. ${pos.outstandingPrincipal} disagree by Rs. ${round2(balDiff)}; reconcile before re-agreeing`);
        }

        // receipt lines on the voucher must equal what the quote says to collect
        const lineTotal = round2(details.reduce((s: number, d: any) => s + num(d.trans_amt), 0));
        if (Math.abs(lineTotal - quote.collect.total) > MONEY_TOLERANCE) {
            throw new Error(`Voucher lines total Rs. ${lineTotal} but Rs. ${quote.collect.total} must be collected (NR interest + penalty)`);
        }

        const today = new Date();
        const todayStr = toYmd(today);
        const mode = (header.bankName || header.chequeNumber) ? 'T' : 'C';
        const newCase = String(ra.new_loancaseno);
        const oldCase = String(ra.old_loancaseno);
        const mbno = String(ra.mbno);

        // ---------- 1. post the money received (NR interest, penalty) ----------
        await qr.query(`SELECT pg_advisory_xact_lock(hashtext('ledger'))`);
        let nextLedgerId = await this.nextId(qr, 'ledger', 'ledgerid');
        let nextTransNo = await this.nextId(qr, 'ledger', 'trans_no');
        for (const d of details) {
            const amt = round2(num(d.trans_amt));
            if (amt <= 0) continue;
            const code = d.code || interestHeadForLoanType(ra.loantype);
            const dir = await this.increaseDirection(qr, code);
            await qr.query(
                `INSERT INTO ledger (trans_no, trans_date, trans_type, code, mbno, acc_no, acc_type, trans_amt, receipt_vchr_no, vchr_type,
                                     modeofpay, pl_balance, narration, username, ledgerid)
                 VALUES ($1,$2,$3,$4,$5,$6,'OTH',$7,$8,$9,$10,0,$11,$12,$13)`,
                [nextTransNo++, today, dir, code, mbno, oldCase, amt, voucherNo, VOUCHER_TYPE_CODE, mode, (d.narration || '').slice(0, 250), postedBy, nextLedgerId++]);
            await qr.query(
                `INSERT INTO tblcashbook (headcode, headname, rcash, rtransfer, pcash, ptransfer, trans_date, voucher_no, username)
                 VALUES ($1,$2,$3,$4,0,0,$5,$6,$7)`,
                [code, (d.narration || 'Loan re-agreement receipt').slice(0, 100), mode === 'C' ? amt : 0, mode === 'C' ? 0 : amt, today, voucherNo, postedBy]);
        }

        // ---------- 2. the NEW loan (active) ----------
        const firstDue = parseYmd(neu.firstDueMonth)!;
        await qr.query(
            `INSERT INTO loan_master (mbno, loantype, loancaseno, loan_amt, payment_date, rate, no_of_instal, instal_amt, balance, openbalance,
                                      purpose, intt_amount, penalrate, gracedays, smpenalpct, smpenaldiv, delay_months, loan_payment_model, loan_interest_method)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,0,$10,$11,$12,$13,$14,$15,$16,'SEPARATE_INTEREST',$17)`,
            [mbno, ra.loantype, newCase, pos.outstandingPrincipal, today, neu.rate, neu.installments, neu.monthlyPrincipal, pos.outstandingPrincipal,
                `RE-AGREEMENT OF CASE ${oldCase}`.slice(0, 50), neu.monthlyInterest, oldLoan.penalrate, oldLoan.gracedays, oldLoan.smpenalpct,
                oldLoan.smpenaldiv, neu.delayMonths, LOAN_INTEREST_METHOD]);
        await qr.query(
            `INSERT INTO loan_schedule_versions (mbno, loantype, loancaseno, version_no, source, effective_date, first_due_month, opening_principal,
                                                 monthly_principal, installment_count, monthly_installment, annual_rate, delay_months, source_case_no,
                                                 reagreement_id, carried_interest)
             VALUES ($1,$2,$3,1,'REAGREEMENT',$4::date,$5::date,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
            [mbno, ra.loantype, newCase, todayStr, neu.firstDueMonth, pos.outstandingPrincipal, neu.monthlyPrincipal, neu.installments,
                neu.monthlyInstallment, neu.rate, neu.delayMonths, oldCase, ra.id, neu.carriedInterest]);
        await persistRbSchedule(qr, newCase, mbno, ra.loantype, calc.rbSchedule);

        // old EMI may still be deducted from salary for the delay months -> reuse the payroll-lag mechanism
        const watchUntil = new Date(today);
        watchUntil.setMonth(watchUntil.getMonth() + neu.delayMonths);
        await qr.query(
            `UPDATE loan_master SET payroll_lag_watch_until = $1, payroll_lag_old_principal = $2, payroll_lag_old_interest = $3
             WHERE loancaseno::text = $4 AND mbno = $5 AND loantype = $6`,
            [watchUntil, old.monthlyPrincipal, old.monthlyInterest, newCase, mbno, ra.loantype]);

        // ---------- 3. close the OLD loan (re-agreed, not repaid) ----------
        const oldBalanceBefore = round2(num(oldLoan.balance));
        await qr.query(
            `UPDATE loan_master SET balance = 0, consolidated_into_loancaseno = $1 WHERE loancaseno::text = $2 AND mbno = $3 AND loantype = $4`,
            [newCase, oldCase, mbno, ra.loantype]);
        await qr.query(
            `INSERT INTO loan_repayment_ledger (mbno, loancaseno, loantype, payment_date, payment_month, payment_year, payment_amount,
                                                principal_amount, interest_amount, penal_amount, months_overdue, receipt_no, narration, posted_by)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,0,$11,$12,$13)`,
            [mbno, oldCase, ra.loantype, today, today.getMonth() + 1, today.getFullYear(),
                round2(pos.outstandingPrincipal + pos.nrInterest + pos.penaltyDue), pos.outstandingPrincipal, pos.nrInterest, pos.penaltyDue,
                voucherNo,
                `Re-agreed into loan case ${newCase} (principal Rs. ${pos.outstandingPrincipal} carried; NR Rs. ${pos.nrInterest} + penalty Rs. ${pos.penaltyDue} recovered; closure interest Rs. ${pos.apInterest} carried into the new installments) - ${ra.reagreement_no}`,
                postedBy]);

        // Loan Against RD (ELN): the RD lock follows the loan to the new case.
        // (A loan that never had a lock — legacy — is left as it is.)
        if ((ra.loantype || '').toUpperCase() === 'ELN') {
            await this.rdLien.transfer(
                { mbno, oldCaseNo: oldCase, newCaseNo: newCase, amount: pos.outstandingPrincipal, by: postedBy }, qr,
            );
        }

        await qr.query(`UPDATE loan_pending SET flg_paid = 'Y' WHERE loancaseno::text = $1 AND application_kind = 'REAGREEMENT'`, [newCase]);

        // ---------- 4. header row final numbers ----------
        const snapshot = { quote, pass: { voucherNo, oldBalanceBefore, passedAt: today.toISOString() } };
        await qr.query(
            `UPDATE loan_reagreements SET status = 'PASSED', effective_date = $2::date, first_due_month = $3::date, passed_by = $4, passed_at = NOW(),
                reversed_by = NULL, reversed_at = NULL,
                old_rate=$5, old_installment_count=$6, old_monthly_principal=$7, old_monthly_interest=$8, old_monthly_installment=$9, installments_paid=$10,
                outstanding_principal=$11, nr_principal=$12, nr_interest=$13, penalty_due=$14, ap_interest_carried=$15, closure_interest_total=$16,
                new_monthly_principal=$17, new_monthly_interest=$18, new_monthly_installment=$19, slot=$20, sub_slot=$21, interest_delay_months=$22,
                delay_months=$23, total_rb_interest=$24, delay_interest=$25, total_interest_for_emi=$26, rounding_mode=$27, calc_snapshot=$28,
                payroll_lag_old_principal=$29, payroll_lag_old_interest=$30, payroll_lag_watch_until=$31::date
             WHERE id = $1`,
            [ra.id, todayStr, neu.firstDueMonth, postedBy,
                old.rate, old.installments, old.monthlyPrincipal, old.monthlyInterest, old.monthlyInstallment, pos.paidInstallments,
                pos.outstandingPrincipal, pos.nrPrincipal, pos.nrInterest, pos.penaltyDue, pos.apInterest, pos.closureInterestTotal,
                neu.monthlyPrincipal, neu.monthlyInterest, neu.monthlyInstallment, neu.slot, neu.subSlot, neu.interestDelayMonths,
                neu.delayMonths, neu.totalRbInterest, neu.delayInterest, neu.totalInterestForEmi, neu.roundingMode, JSON.stringify(snapshot),
                old.monthlyPrincipal, old.monthlyInterest, toYmd(watchUntil)]);
        await this.writeLog(qr, ra.id, 'PASSED', 'VOUCHERED', 'PASSED', ctx, {
            voucherNo, oldCase, newCase, outstandingPrincipal: pos.outstandingPrincipal, collected: quote.collect.total,
            newEmi: neu.monthlyInstallment, tenure: neu.installments, rate: neu.rate,
        });

        // ---------- 5. issue the agreement document ----------
        const issued = await this.issueDocument(qr, ra.id, postedBy);

        return {
            reagreementId: Number(ra.id), reagreementNo: ra.reagreement_no, oldLoanCaseNo: oldCase, newLoanCaseNo: newCase,
            outstandingPrincipal: pos.outstandingPrincipal, collected: quote.collect.total, carriedInterest: neu.carriedInterest,
            old, neu: { rate: neu.rate, installments: neu.installments, monthlyPrincipal: neu.monthlyPrincipal, monthlyInterest: neu.monthlyInterest, monthlyInstallment: neu.monthlyInstallment, firstDueMonth: neu.firstDueMonth },
            documentIssued: issued.documentId !== null, documentError: issued.renderError,
        };
    }

    async reverseInTransaction(qr: QueryRunner, voucherNo: string, reversedBy: string, reason?: string) {
        const ctx: ReagreementContext = { actor: reversedBy };
        const ra = await this.getRowByVoucher(qr, voucherNo, true);
        if (!ra || ra.status !== 'PASSED') throw new Error('Re-agreement is not in PASSED status; nothing to reverse');
        const mbno = String(ra.mbno), newCase = String(ra.new_loancaseno), oldCase = String(ra.old_loancaseno);

        const reps = await qr.query(
            `SELECT COUNT(*)::int AS c FROM loan_repayment_ledger WHERE mbno = $1 AND loancaseno = $2 AND loantype = $3`, [mbno, newCase, ra.loantype]);
        if (reps[0].c > 0) throw new Error(`Loan case ${newCase} already has ${reps[0].c} repayment(s) recorded; a re-agreement cannot be reversed once repayments exist`);
        const nl = await qr.query(`SELECT consolidated_into_loancaseno FROM loan_master WHERE loancaseno::text = $1 AND mbno = $2 AND loantype = $3`, [newCase, mbno, ra.loantype]);
        if (nl[0] && nl[0].consolidated_into_loancaseno !== null) throw new Error(`Loan case ${newCase} was already closed into case ${nl[0].consolidated_into_loancaseno}; cannot reverse`);
        const oldBalanceBefore = num(ra.calc_snapshot?.pass?.oldBalanceBefore, num(ra.outstanding_principal));

        // new loan out
        await qr.query(`DELETE FROM loan_schedule_versions WHERE mbno = $1 AND loantype = $2 AND loancaseno::text = $3`, [mbno, ra.loantype, newCase]);
        await qr.query(`DELETE FROM loan_rb_schedule WHERE mbno = $1 AND loantype = $2 AND loancaseno::text = $3`, [mbno, ra.loantype, newCase]);
        await qr.query(`DELETE FROM loan_master WHERE loancaseno::text = $1 AND mbno = $2 AND loantype = $3`, [newCase, mbno, ra.loantype]);
        // old loan back
        await qr.query(
            `UPDATE loan_master SET balance = $4, consolidated_into_loancaseno = NULL WHERE loancaseno::text = $1 AND mbno = $2 AND loantype = $3`,
            [oldCase, mbno, ra.loantype, oldBalanceBefore]);
        await qr.query(`DELETE FROM loan_repayment_ledger WHERE mbno = $1 AND loancaseno = $2 AND loantype = $3 AND receipt_no = $4`, [mbno, oldCase, ra.loantype, voucherNo]);
        // Loan Against RD (ELN): the lock goes back from the new case to the old one.
        if ((ra.loantype || '').toUpperCase() === 'ELN') {
            await this.rdLien.reinstate({ oldCaseNo: oldCase, newCaseNo: newCase, by: reversedBy }, qr);
        }
        // money postings out
        await qr.query(`DELETE FROM ledger WHERE receipt_vchr_no = $1`, [voucherNo]);
        await qr.query(`DELETE FROM tblcashbook WHERE voucher_no = $1`, [voucherNo]);
        await qr.query(`UPDATE loan_pending SET flg_paid = 'N' WHERE loancaseno::text = $1 AND application_kind = 'REAGREEMENT'`, [newCase]);
        // the issued agreement is voided (kept for the record), never deleted
        await qr.query(
            `UPDATE loan_reagreement_documents SET voided_at = NOW(), void_reason = $2 WHERE reagreement_id = $1 AND voided_at IS NULL`,
            [ra.id, reason || 'Re-agreement reversed in Pass Transactions']);
        await qr.query(
            `UPDATE loan_reagreements SET status = 'VOUCHERED', passed_by = NULL, passed_at = NULL, effective_date = NULL,
                reversed_by = $2, reversed_at = NOW(), reversal_reason = $3 WHERE id = $1`,
            [ra.id, reversedBy, reason || null]);
        await this.writeLog(qr, ra.id, 'REVERSED', 'PASSED', 'VOUCHERED', ctx, { voucherNo, oldCase, newCase, restoredOldBalance: oldBalanceBefore }, reason);
        return { reagreementNo: ra.reagreement_no, oldLoanCaseNo: oldCase, newLoanCaseNo: newCase };
    }

    // ======================================================================
    // Cancel (before pass)
    // ======================================================================
    async cancel(id: number | string, reason: string, ctx: ReagreementContext) {
        const qr = this.dataSource.createQueryRunner();
        await qr.connect();
        await qr.startTransaction();
        try {
            const ra = await this.getRowById(qr, id, true);
            if (!ra) throw new NotFoundException('Re-agreement not found');
            if (!['APPLIED', 'SANCTIONED', 'VOUCHERED'].includes(ra.status)) {
                throw new BadRequestException(`Re-agreement ${ra.reagreement_no} is ${ra.status} and cannot be cancelled`);
            }
            if (ra.status === 'VOUCHERED' && ra.voucher_no) {
                const v = await qr.query(`SELECT status FROM vouchers WHERE "voucherNumber" = $1`, [ra.voucher_no]);
                if (v[0] && v[0].status !== 'PENDING') throw new BadRequestException(`Voucher ${ra.voucher_no} is ${v[0].status}; reverse it in Pass Transactions first`);
                await qr.query(`DELETE FROM transactions WHERE receipt_vchr_no = $1`, [ra.voucher_no]);
                await qr.query(`DELETE FROM vouchers WHERE "voucherNumber" = $1`, [ra.voucher_no]);
            }
            await qr.query(`DELETE FROM loan_nominee WHERE loancaseno::text = $1`, [String(ra.new_loancaseno)]);
            await qr.query(`DELETE FROM loan_pending WHERE loancaseno::text = $1 AND application_kind = 'REAGREEMENT' AND flg_paid = 'N'`, [String(ra.new_loancaseno)]);
            await qr.query(`UPDATE loan_reagreements SET status = 'CANCELLED', cancelled_by = $2, cancelled_at = NOW() WHERE id = $1`, [ra.id, ctx.actor || 'system']);
            await this.writeLog(qr, ra.id, 'CANCELLED', ra.status, 'CANCELLED', ctx, { voucherNo: ra.voucher_no }, reason);
            await qr.commitTransaction();
            return { success: true, message: `Re-agreement ${ra.reagreement_no} cancelled` };
        } catch (e) {
            await qr.rollbackTransaction();
            throw e;
        } finally {
            await qr.release();
        }
    }

    // ======================================================================
    // Documents
    // ======================================================================
    private async buildAgreementData(runner: QueryRunner | DataSource, ra: any, status: 'FINAL' | 'DRAFT', issueNo: number, issuedAt: Date): Promise<AgreementData> {
        const person = async (mbno: any) => {
            if (!mbno || Number(mbno) === 0) return null;
            const r = await runner.query(
                `SELECT TRIM(COALESCE(m.f_name,'') || ' ' || COALESCE(m.m_name,'') || ' ' || COALESCE(m.l_name,'')) AS name,
                        COALESCE(d.name, '') AS office
                 FROM member_master m LEFT JOIN division_master d ON m.officeno = d.officeno AND m.wingno = d.wingno WHERE m.mbno = $1`, [mbno]);
            return { mbno: String(mbno), name: r[0]?.name || '', office: r[0]?.office || '' };
        };
        const member = (await person(ra.mbno)) || { mbno: String(ra.mbno), name: '', office: '' };
        const lp = await runner.query(`SELECT g1mbno, g2mbno FROM loan_pending WHERE loancaseno::text = $1 LIMIT 1`, [String(ra.new_loancaseno)]);
        const sureties: Array<{ mbno: string; name: string; office?: string }> = [];
        for (const g of [lp[0]?.g1mbno, lp[0]?.g2mbno]) {
            const p = await person(g);
            if (p) sureties.push(p);
        }
        const collected = round2(num(ra.nr_interest) + num(ra.penalty_due));
        const oldRemaining = Math.max(0, num(ra.old_installment_count) - num(ra.installments_paid));
        return {
            status, reagreementNo: ra.reagreement_no, issueNo, issuedAt: issuedAt.toISOString(),
            applicationDate: ra.application_date_s, effectiveDate: ra.effective_date_s || null, firstDueMonth: ra.first_due_month_s || null,
            voucherNo: ra.voucher_no || null, reason: ra.reason || '',
            member, sureties, loanType: ra.loantype, loanTypeName: LOAN_TYPE_NAMES[ra.loantype] || ra.loantype,
            oldCaseNo: String(ra.old_loancaseno), newCaseNo: String(ra.new_loancaseno),
            old: { rate: num(ra.old_rate), installments: num(ra.old_installment_count), monthlyPrincipal: num(ra.old_monthly_principal),
                monthlyInterest: num(ra.old_monthly_interest), monthlyInstallment: num(ra.old_monthly_installment), paidInstallments: num(ra.installments_paid) },
            neu: { rate: num(ra.new_rate), installments: num(ra.new_installment_count), monthlyPrincipal: num(ra.new_monthly_principal),
                monthlyInterest: num(ra.new_monthly_interest), monthlyInstallment: num(ra.new_monthly_installment), slot: ra.slot ?? null,
                delayMonths: ra.delay_months ?? null, delayInterest: num(ra.delay_interest), totalRbInterest: num(ra.total_rb_interest),
                totalInterestForEmi: num(ra.total_interest_for_emi) },
            outstandingPrincipal: num(ra.outstanding_principal), nrInterest: num(ra.nr_interest), penaltyCollected: num(ra.penalty_due),
            carriedInterest: num(ra.ap_interest_carried), collectedNow: collected,
            oldRemainingPayable: round2(oldRemaining * num(ra.old_monthly_installment)),
            newTotalPayable: round2(num(ra.new_monthly_installment) * num(ra.new_installment_count)),
        };
    }

    /** Writes the (insert-only) issued agreement. Text is mandatory; PDF/PNG failures are reported, never fatal. */
    async issueDocument(runner: QueryRunner, reagreementId: number | string, actor: string) {
        const ra = await this.getRowById(runner, reagreementId);
        const next = await runner.query(`SELECT COALESCE(MAX(issue_no), 0) + 1 AS n FROM loan_reagreement_documents WHERE reagreement_id = $1`, [reagreementId]);
        const issueNo = parseInt(next[0].n, 10);
        const now = new Date();
        const data = await this.buildAgreementData(runner, ra, 'FINAL', issueNo, now);
        const r = await this.documents.renderAll(data, runner);
        const ins = await runner.query(
            `INSERT INTO loan_reagreement_documents (reagreement_id, issue_no, mbno, old_loancaseno, new_loancaseno, agreement_text, agreement_json,
                pdf_bytes, png_bytes, text_sha256, pdf_sha256, png_sha256, signatures_used, issued_by)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id`,
            [reagreementId, issueNo, ra.mbno, ra.old_loancaseno, ra.new_loancaseno, r.text, JSON.stringify(data), r.pdf, r.png,
                r.textSha256, r.pdfSha256, r.pngSha256, JSON.stringify(r.signaturesUsed), actor]);
        await this.writeLog(runner, reagreementId, r.renderError ? 'DOCUMENT_RENDER_FAILED' : 'DOCUMENT_ISSUED', null, null, { actor },
            { documentId: Number(ins[0].id), issueNo, textSha256: r.textSha256, pdfSha256: r.pdfSha256, pngSha256: r.pngSha256, renderError: r.renderError });
        return { documentId: Number(ins[0].id), issueNo, renderError: r.renderError };
    }

    /** DRAFT (watermarked) copy for signing before pass — generated on the fly, never stored. */
    async renderDraft(id: number | string) {
        const ra = await this.getRowById(this.dataSource, id);
        if (!ra) throw new NotFoundException('Re-agreement not found');
        if (!['APPLIED', 'SANCTIONED', 'VOUCHERED'].includes(ra.status)) throw new BadRequestException('Only an open re-agreement has a draft copy');
        const data = await this.buildAgreementData(this.dataSource, ra, 'DRAFT', 0, new Date());
        const r = await this.documents.renderAll(data, this.dataSource);
        return { text: r.text, pdf: r.pdf, png: r.png };
    }

    async getIssuedDocument(id: number | string, kind: 'text' | 'pdf' | 'png', ctx: ReagreementContext, issueNo?: number) {
        const rows = await this.dataSource.query(
            `SELECT id, issue_no, agreement_text, agreement_json, pdf_bytes, png_bytes, voided_at
             FROM loan_reagreement_documents WHERE reagreement_id = $1 ${issueNo ? 'AND issue_no = $2' : 'AND voided_at IS NULL'}
             ORDER BY issue_no DESC LIMIT 1`, issueNo ? [id, issueNo] : [id]);
        const d = rows[0];
        if (!d) throw new NotFoundException('No issued agreement document for this re-agreement');
        let bytes: Buffer | null = null;
        if (kind === 'pdf' || kind === 'png') {
            bytes = kind === 'pdf' ? d.pdf_bytes : d.png_bytes;
            if (!bytes) {
                // rendering failed at issue time: rebuild from the stored JSON (same layout, same fonts) and keep the result
                const r = await this.documents.renderAll(d.agreement_json, this.dataSource);
                await this.dataSource.query(
                    `UPDATE loan_reagreement_documents SET pdf_bytes = COALESCE(pdf_bytes, $2), png_bytes = COALESCE(png_bytes, $3),
                        pdf_sha256 = COALESCE(pdf_sha256, $4), png_sha256 = COALESCE(png_sha256, $5) WHERE id = $1`,
                    [d.id, r.pdf, r.png, r.pdfSha256, r.pngSha256]);
                bytes = kind === 'pdf' ? r.pdf : r.png;
                if (!bytes) throw new BadRequestException(`The ${kind.toUpperCase()} copy could not be generated: ${r.renderError}`);
            }
        }
        await this.writeLog(this.dataSource, id, kind === 'pdf' ? 'PDF_DOWNLOADED' : kind === 'png' ? 'IMAGE_DOWNLOADED' : 'DOCUMENT_VIEWED',
            null, null, ctx, { documentId: Number(d.id), issueNo: d.issue_no });
        return { issueNo: d.issue_no, voided: !!d.voided_at, text: d.agreement_text as string, bytes };
    }

    // ======================================================================
    // Read APIs for the windows
    // ======================================================================
    /** Active loans of a member that can be re-agreed (picker of the Loan Re-agreement window). */
    async activeLoans(mbno: string) {
        const rows = await this.dataSource.query(
            `SELECT lm.loancaseno::text AS case_no, lm.loantype, lm.balance, lm.rate, lm.no_of_instal, lm.instal_amt, lm.intt_amount,
                    lm.payment_date::date::text AS payment_date,
                    (SELECT r.reagreement_no || ' (' || r.status || ')' FROM loan_reagreements r
                      WHERE r.mbno = lm.mbno AND r.loantype = lm.loantype AND r.old_loancaseno = lm.loancaseno
                        AND r.status IN ('APPLIED','SANCTIONED','VOUCHERED') LIMIT 1) AS open_reagreement
             FROM loan_master lm
             WHERE lm.mbno = $1 AND lm.balance > 0 AND lm.consolidated_into_loancaseno IS NULL
             ORDER BY lm.payment_date DESC`, [mbno]);
        const mem = await this.dataSource.query(
            `SELECT TRIM(COALESCE(f_name,'') || ' ' || COALESCE(m_name,'') || ' ' || COALESCE(l_name,'')) AS name FROM member_master WHERE mbno = $1`, [mbno]);
        return {
            mbno, memberName: mem[0]?.name || '',
            loans: rows.map((r: any) => ({
                loanCaseNo: r.case_no, loanType: r.loantype, loanTypeName: LOAN_TYPE_NAMES[r.loantype] || r.loantype,
                balance: round2(num(r.balance)), rate: num(r.rate), installments: r.no_of_instal, paymentDate: r.payment_date,
                openReagreement: r.open_reagreement || null,
            })),
        };
    }

    /** Open (not yet passed / cancelled) re-agreements, optionally for one member. */
    async listOpen(mbno?: string) {
        const rows = await this.dataSource.query(
            `SELECT ${this.rowSelect}, TRIM(COALESCE(m.f_name,'') || ' ' || COALESCE(m.l_name,'')) AS member_name
             FROM loan_reagreements r JOIN member_master m ON m.mbno = r.mbno
             WHERE r.status IN ('APPLIED','SANCTIONED','VOUCHERED') ${mbno ? 'AND r.mbno = $1' : ''} ORDER BY r.created_at DESC`,
            mbno ? [mbno] : []);
        return rows.map((r: any) => ({ ...this.toDto(r), memberName: r.member_name }));
    }

    /** Chain of cases and re-agreements around any case number of a loan. */
    async history(mbno: string, caseNo: string, loantype?: string) {
        const all = await this.dataSource.query(
            `SELECT ${this.rowSelect} FROM loan_reagreements r WHERE r.mbno = $1 ${loantype ? 'AND r.loantype = $2' : ''} ORDER BY r.created_at`,
            loantype ? [mbno, loantype] : [mbno]);
        const byNew = new Map<string, any>(), byOld = new Map<string, any[]>();
        for (const r of all) {
            byNew.set(String(r.new_loancaseno), r);
            const k = String(r.old_loancaseno);
            byOld.set(k, [...(byOld.get(k) || []), r]);
        }
        // walk back to the original case, then forward through every re-agreement
        let root = String(caseNo);
        for (let i = 0; i < 100; i++) {
            const p = byNew.get(root);
            if (!p || p.status === 'CANCELLED') break;
            root = String(p.old_loancaseno);
        }
        const chain: any[] = [];
        const cases: string[] = [root];
        let cur = root;
        for (let i = 0; i < 100; i++) {
            const nexts = byOld.get(cur) || [];
            if (!nexts.length) break;
            let advanced = false;
            for (const r of nexts) {
                chain.push(r);
                if (r.status === 'PASSED') { cur = String(r.new_loancaseno); cases.push(cur); advanced = true; }
            }
            if (!advanced) break;
        }
        const caseInfo = await this.dataSource.query(
            `SELECT lm.loancaseno::text AS case_no, lm.loantype, lm.loan_amt, lm.balance, lm.rate, lm.no_of_instal, lm.instal_amt,
                    lm.payment_date::date::text AS payment_date, lm.consolidated_into_loancaseno::text AS into_case
             FROM loan_master lm WHERE lm.mbno = $1 AND lm.loancaseno::text = ANY($2::text[])`, [mbno, cases]);
        const docs = await this.dataSource.query(
            `SELECT reagreement_id, issue_no, issued_at, voided_at, (pdf_bytes IS NOT NULL) AS has_pdf, (png_bytes IS NOT NULL) AS has_png, (signed_scan_bytes IS NOT NULL) AS has_scan
             FROM loan_reagreement_documents WHERE reagreement_id = ANY($1::bigint[]) ORDER BY issue_no`, [chain.map(r => r.id)]);
        return {
            mbno, rootCaseNo: root,
            cases: cases.map(c => {
                const i = caseInfo.find((x: any) => x.case_no === c);
                return i ? { caseNo: c, loanType: i.loantype, loanAmount: num(i.loan_amt), balance: num(i.balance), rate: num(i.rate), installments: i.no_of_instal,
                    startDate: i.payment_date, closedIntoCaseNo: i.into_case } : { caseNo: c };
            }),
            reagreements: chain.map(r => ({
                ...this.toDto(r),
                documents: docs.filter((d: any) => String(d.reagreement_id) === String(r.id)).map((d: any) => ({
                    issueNo: d.issue_no, issuedAt: d.issued_at, voided: !!d.voided_at, hasPdf: d.has_pdf, hasImage: d.has_png, hasSignedScan: d.has_scan,
                })),
            })),
        };
    }

    async getLog(id: number | string) {
        return this.dataSource.query(
            `SELECT id, event, old_status, new_status, actor, at, details, remarks FROM loan_reagreement_log WHERE reagreement_id = $1 ORDER BY at, id`, [id]);
    }
}
