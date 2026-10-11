import { Injectable, NotFoundException } from '@nestjs/common';
import { loanHeadOpeningSql } from '../loan-opening-balance';
import { DataSource } from 'typeorm';
import { LoanRepaymentService } from './loan-repayment.service';
import { LoanPaymentFlagService, WatchedLoan, EvaluateInput, LoanFlagCode } from './loan-payment-flag.service';

/**
 * "Loan Position": everything a clerk needs to judge one loan, WORKED OUT WHEN ASKED from the
 * ledger and the loan terms. Nothing here is written to the database — staff read it and, if
 * something is off, correct it themselves (e.g. with Journal/Transfer Entry). The only thing
 * that can be saved is a "checked" confirmation on a notice (see acknowledge()).
 *
 * Two views are shown side by side on purpose, with the difference explained:
 *   - Ledger view:       the member's loan account in `ledger` (manual journals, demand and cash
 *                        receipts, loans taken) — the same account the Member Ledger shows.
 *   - Loan record view:  loan_master / repayment history / member summary — what the EMI
 *                        schedule and the early-closure quote are built on.
 */

const NEAR_ZERO = 100;        // a loan account at or below this is treated as closed
const SAME_AMOUNT = 10;       // ledger vs loan record differences up to this are not worth a notice
const SILENT_DAYS = 62;       // "no payment for about two months"
const r2 = (n: number) => Math.round(n * 100) / 100;
const num = (v: any) => (v === null || v === undefined ? 0 : Number(v) || 0);
const monthIdx = (d: Date) => d.getFullYear() * 12 + d.getMonth();
const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

export type NoticeSeverity = 'check' | 'info';
export interface PositionNotice {
    code: string;
    severity: NoticeSeverity;
    source: 'PAYMENT' | 'DEMAND' | 'LEDGER' | 'SCHEDULE';
    date: string | null;          // yyyy-mm-dd the notice is about
    amount: number | null;
    message: string;
    ackable: boolean;             // only payment / demand notices can be marked checked
    acknowledged: boolean;
    acknowledgedBy?: string | null;
    acknowledgedAt?: string | null;
}

const creditKind = (vchr: string): string => {
    const v = (vchr || '').toUpperCase();
    if (v === 'D') return 'demand';
    if (v === 'R') return 'cash';
    if (v === 'J' || v === 'JV') return 'journal';
    if (v === 'P') return 'paymentVoucher';
    return 'other';
};

@Injectable()
export class LoanPositionService {
    private _flags?: LoanPaymentFlagService;
    private get flags(): LoanPaymentFlagService {
        return this._flags ??= new LoanPaymentFlagService(this.dataSource);
    }

    constructor(
        private readonly dataSource: DataSource,
        private readonly repayment: LoanRepaymentService,
    ) { }

    async getPosition(mbno: string, loancaseno: string, loantype?: string, asOfDate?: Date) {
        const asOf = asOfDate && !isNaN(asOfDate.getTime()) ? asOfDate : new Date();
        const loanRows = await this.dataSource.query(
            `SELECT mbno::text AS mbno, loancaseno::text AS loancaseno, loantype, loan_amt, balance, rate, no_of_instal, instal_amt,
                    intt_amount, delay_months, payment_date, payroll_lag_watch_until, payroll_lag_old_principal, payroll_lag_old_interest,
                    consolidated_into_loancaseno::text AS into_case
               FROM loan_master WHERE mbno = $1::numeric AND loancaseno::text = $2 AND ($3::text IS NULL OR loantype = $3)
              ORDER BY payment_date DESC LIMIT 1`,
            [mbno, loancaseno, loantype || null],
        );
        const loan = loanRows[0];
        if (!loan) throw new NotFoundException(`Loan case ${loancaseno} not found for member ${mbno}`);
        const isRegular = loan.loantype === 'RLN';
        const head = isRegular ? 'A1002' : 'A1047';

        // ── terms ──
        const sv = (await this.dataSource.query(
            `SELECT version_no, source, effective_date, first_due_month, opening_principal, monthly_principal,
                    installment_count, monthly_installment, annual_rate, delay_months
               FROM loan_schedule_versions WHERE mbno = $1::numeric AND loancaseno::text = $2 ORDER BY version_no DESC LIMIT 1`,
            [mbno, loancaseno],
        ))[0];
        const n = sv ? Number(sv.installment_count) : Number(loan.no_of_instal) || 0;
        const loanAmount = sv ? num(sv.opening_principal) : num(loan.loan_amt);
        const monthlyPrincipal = sv ? num(sv.monthly_principal) : (n > 0 ? r2(loanAmount / n) : 0);
        const instalAmt = sv ? num(sv.monthly_installment) : num(loan.instal_amt);
        const monthlyInterest = sv
            ? r2(Math.max(0, instalAmt - monthlyPrincipal))
            : (instalAmt > monthlyPrincipal + 1 ? r2(instalAmt - monthlyPrincipal) : num(loan.intt_amount));
        const startDate = sv ? new Date(sv.effective_date) : new Date(loan.payment_date);
        const delay = sv ? Number(sv.delay_months) || 0 : Number(loan.delay_months) || 0;
        const firstDue = sv ? new Date(sv.first_due_month) : new Date(startDate.getFullYear(), startDate.getMonth() + 1 + delay, 1);

        const absorbedRaw = await this.dataSource.query(
            `SELECT loancaseno::text AS loancaseno, loantype, loan_amt, to_char(payment_date + interval '5 hours 30 minutes','YYYY-MM-DD') AS started
               FROM loan_master WHERE mbno = $1::numeric AND consolidated_into_loancaseno::text = $2`,
            [mbno, loancaseno],
        );
        const absorbed: any[] = [];
        for (const a of absorbedRaw) {
            const row = (await this.dataSource.query(
                `SELECT to_char(payment_date,'YYYY-MM-DD') AS d, principal_amount, interest_amount, penal_amount
                   FROM loan_repayment_ledger WHERE mbno = $1::numeric AND loancaseno = $2 AND narration LIKE 'Consolidated into%'
                  ORDER BY id DESC LIMIT 1`,
                [mbno, a.loancaseno],
            ))[0];
            absorbed.push({
                loancaseno: a.loancaseno, originalAmount: num(a.loan_amt),
                closedBalance: row ? num(row.principal_amount) : null,
                closureInterest: row ? r2(num(row.interest_amount) + num(row.penal_amount)) : null,
                date: row?.d ?? null,
            });
        }

        // ── ledger view ──
        const opening = num((await this.dataSource.query(
            `SELECT ${loanHeadOpeningSql('$1::numeric', '$2::boolean')} AS ob`,
            [mbno, isRegular],
        ))[0]?.ob);
        const ledgerRows = await this.dataSource.query(
            `SELECT to_char(trans_date + interval '5 hours 30 minutes','YYYY-MM-DD') AS d, ledgerid, trans_type, trans_amt, vchr_type, receipt_vchr_no AS rv, narration
               FROM ledger WHERE mbno = $1::numeric AND code = $2 ORDER BY trans_date, ledgerid`,
            [mbno, head],
        );
        let bal = opening;
        let runStart = 0;
        const signed: Array<{ row: any; dir: 'DR' | 'CR'; amt: number; bal: number }> = [];
        for (const row of ledgerRows) {
            const t = String(row.trans_type || '').toUpperCase();
            const dir = (t === 'CR' || t === 'R') ? 'CR' : (t === 'DR' || t === 'P') ? 'DR' : null;
            if (!dir) continue;
            const amt = num(row.trans_amt);
            bal = r2(bal + (dir === 'DR' ? amt : -amt));
            signed.push({ row, dir, amt, bal });
            if (bal <= NEAR_ZERO) runStart = signed.length; // loan run restarts after the last time the account reached ~zero
        }
        // Only the current loan and the loan(s) folded into it are looked at (earlier history of the same account is ignored).
        const windowStart = [ymd(startDate), ...absorbedRaw.map((a: any) => a.started).filter(Boolean)].sort()[0] as string;
        const runAll = signed.slice(runStart);
        const run = runAll.filter((s) => s.row.d >= windowStart);
        const firstIdx = run.length ? signed.indexOf(run[0]) : -1;
        const carriedIn = run.length ? (firstIdx > 0 ? signed[firstIdx - 1].bal : opening) : (signed.length ? signed[signed.length - 1].bal : opening);
        const ledgerBalance = signed.length ? signed[signed.length - 1].bal : opening;
        const byChannel: Record<string, number> = { demand: 0, cash: 0, journal: 0, paymentVoucher: 0, other: 0 };
        const added: any[] = [];
        const adjustments: any[] = [];
        let creditTotal = 0, addedTotal = 0;
        let lastLedgerCredit: string | null = null;
        for (const s of run) {
            const v = String(s.row.vchr_type || '').toUpperCase();
            if (s.dir === 'CR') {
                const kind = creditKind(v);
                byChannel[kind] = r2(byChannel[kind] + s.amt);
                creditTotal = r2(creditTotal + s.amt);
                lastLedgerCredit = s.row.d;
                if (kind === 'journal') adjustments.push({ date: s.row.d, voucher: s.row.rv, direction: 'Credit', amount: s.amt, narration: s.row.narration || '' });
            } else if (v === 'J') {
                adjustments.push({ date: s.row.d, voucher: s.row.rv, direction: 'Debit', amount: s.amt, narration: s.row.narration || '' });
                addedTotal = r2(addedTotal + s.amt);
                added.push({ date: s.row.d, voucher: s.row.rv, amount: s.amt, kind: 'Journal transfer in' });
            } else {
                addedTotal = r2(addedTotal + s.amt);
                added.push({ date: s.row.d, voucher: s.row.rv, amount: s.amt, kind: 'Loan taken / added' });
            }
        }

        // ── loan record view ──
        const pay = await this.dataSource.query(
            `SELECT to_char(payment_date,'YYYY-MM-DD') AS d, principal_amount, interest_amount, penal_amount, is_payroll_lag_credit AS lag
               FROM loan_repayment_ledger
              WHERE mbno = $1::numeric AND loancaseno = $2 AND loantype = $3 AND COALESCE(narration,'') NOT LIKE 'Consolidated into%'
              ORDER BY id`,
            [mbno, loancaseno, loan.loantype],
        );
        let principalPaid = 0, interestPaid = 0, penalPaid = 0, lagPrincipal = 0, lagInterest = 0, lagCount = 0;
        for (const p of pay) {
            if (p.lag) { lagPrincipal += num(p.principal_amount); lagInterest += num(p.interest_amount); lagCount++; }
            else { principalPaid += num(p.principal_amount); interestPaid += num(p.interest_amount); penalPaid += num(p.penal_amount); }
        }
        const summaryRow = (await this.dataSource.query(
            `SELECT regularloan, emergency_loan_balance FROM member_balances WHERE mbno = $1::numeric LIMIT 1`, [mbno],
        ))[0];
        const recordBalance = num(loan.balance);
        const summaryBalance = summaryRow ? num(isRegular ? summaryRow.regularloan : summaryRow.emergency_loan_balance) : null;

        // ── schedule position ──
        const monthsStarted = monthIdx(asOf) - monthIdx(firstDue) + 1;
        const dueCount = Math.max(0, Math.min(n, monthsStarted));
        const dueSoFarPrincipal = r2(dueCount * monthlyPrincipal);
        const aheadByRecord = r2(principalPaid - dueSoFarPrincipal);
        const remaining = Math.max(0, ledgerBalance);
        const monthsLeft = monthlyPrincipal > 0 ? Math.ceil(remaining / monthlyPrincipal) : null;
        const finish = monthsLeft === null ? null : new Date(asOf.getFullYear(), asOf.getMonth() + monthsLeft, 1);

        // ── early-closure quote (the same calculation the Early Closure window uses) ──
        let closure: any = null;
        try {
            const q = await this.repayment.calculateEarlyClosure(loancaseno, asOf, 0, true, mbno);
            closure = {
                outstandingPrincipal: q.outstandingPrincipal, payrollLagPrincipalOffset: q.payrollLagPrincipalOffset,
                nrInterest: q.nrInterest, apInterest: q.apInterest, penalInterest: q.penalInterest,
                futureInstallmentCount: q.futureInstallmentCount, averageRemainingPrincipal: q.averageRemainingPrincipal,
                averageRbInterest: q.averageRbInterest, finalClosureAmount: q.finalClosureAmount, payableByMember: q.payableByMember,
            };
        } catch (e: any) {
            closure = { error: e?.message || 'Closure could not be calculated' };
        }

        // ── notices (worked out now; never stored) ──
        const notices: PositionNotice[] = [];
        const tolerance = await this.flags.getTolerance();
        const watchUntil = loan.payroll_lag_watch_until ? new Date(loan.payroll_lag_watch_until) : null;
        const oldP = num(loan.payroll_lag_old_principal);
        const oldI = num(loan.payroll_lag_old_interest);
        const acks = await this.dataSource.query(
            `SELECT flag_code, to_char(event_date,'YYYY-MM-DD') AS d, amount, checked_by, checked_at FROM loan_payment_flags
              WHERE mbno = $1::numeric AND loancaseno = $2 AND source = 'ACK' AND status = 'CHECKED'`,
            [mbno, loancaseno],
        );
        const ackFor = (code: string, d: string | null, amount: number | null) =>
            acks.find((a: any) => a.flag_code === code && a.d === d && Math.abs(num(a.amount) - num(amount)) < 0.005);

        if (watchUntil && !isNaN(watchUntil.getTime()) && oldP + oldI > 0) {
            const watched: WatchedLoan = {
                mbno, loancaseno, loantype: loan.loantype, oldPrincipal: oldP, oldInterest: oldI,
                newPrincipal: num(loan.instal_amt), newInterest: num(loan.intt_amount), startDate, watchUntil,
            };
            // payments, one per day
            const byDay = new Map<string, { total: number; lag: boolean }>();
            for (const p of pay) {
                const cur = byDay.get(p.d) || { total: 0, lag: false };
                cur.total = r2(cur.total + num(p.principal_amount) + num(p.interest_amount) + num(p.penal_amount));
                cur.lag = cur.lag || !!p.lag;
                byDay.set(p.d, cur);
            }
            let priorOld = 0;
            const lateOld: Array<{ d: string; total: number }> = [];
            const oldTotal = r2(oldP + oldI);
            const newTotal = r2(num(loan.instal_amt) + num(loan.intt_amount));
            for (const d of [...byDay.keys()].sort()) {
                const g = byDay.get(d)!;
                const when = new Date(`${d}T12:00:00`);
                const phase = LoanPaymentFlagService.phaseFor(when, watchUntil);
                if (!phase && when > watchUntil && Math.abs(g.total - oldTotal) <= 1 && Math.abs(g.total - newTotal) > 1) lateOld.push({ d, total: g.total });
                if (phase) {
                    const input: EvaluateInput = { watched, total: g.total, phase, priorOldSized: priorOld, tolerance };
                    const code = LoanPaymentFlagService.evaluate(input);
                    if (code) {
                        const ack = ackFor(code, d, g.total);
                        notices.push({
                            code, severity: 'check', source: 'PAYMENT', date: d, amount: g.total,
                            message: LoanPaymentFlagService.describe(code, 'PAYMENT', input, g.lag),
                            ackable: true, acknowledged: !!ack, acknowledgedBy: ack?.checked_by ?? null, acknowledgedAt: ack?.checked_at ?? null,
                        });
                    }
                }
                if (g.lag) priorOld++;
            }
            if (lateOld.length > 0) {
                const sum = r2(lateOld.reduce((t, x) => t + x.total, 0));
                notices.push({
                    code: 'OLD_EMI_CONTINUES', severity: 'check', source: 'PAYMENT', date: lateOld[0].d, amount: sum,
                    message: `₹${oldTotal.toLocaleString('en-IN')} (the old loan's EMI) has arrived ${lateOld.length} more time${lateOld.length === 1 ? '' : 's'} later still `
                        + `(${lateOld[0].d} to ${lateOld[lateOld.length - 1].d}, ₹${sum.toLocaleString('en-IN')} in all). `
                        + 'These were recorded as normal payments. Please check whether payroll is still deducting the old EMI.',
                    ackable: true, acknowledged: !!ackFor('OLD_EMI_CONTINUES', lateOld[0].d, sum),
                    acknowledgedBy: ackFor('OLD_EMI_CONTINUES', lateOld[0].d, sum)?.checked_by ?? null,
                    acknowledgedAt: ackFor('OLD_EMI_CONTINUES', lateOld[0].d, sum)?.checked_at ?? null,
                });
            }
            // demand-file months
            const fromIdx = monthIdx(startDate);
            const toIdx = monthIdx(watchUntil) + 2;
            const demand = await this.dataSource.query(
                `SELECT demand_for_month AS m, demand_for_year AS y, rln_installment_amount, rln_interest, aln_installment_amount, aln_interest
                   FROM demand_master
                  WHERE mbno = $1::numeric AND (demand_for_year * 12 + demand_for_month - 1) BETWEEN $2 AND $3
                  ORDER BY demand_for_year, demand_for_month`,
                [mbno, fromIdx, toIdx],
            );
            for (const dm of demand) {
                const rln = num(dm.rln_installment_amount), aln = num(dm.aln_installment_amount);
                const item = isRegular
                    ? (rln > 0 ? { mbno, loantype: 'RLN' as const, principal: rln, interest: num(dm.rln_interest) } : null)
                    : (aln > 0 && rln <= 0 ? { mbno, loantype: 'ALN' as const, principal: aln, interest: num(dm.aln_interest) } : null);
                if (!item) continue;
                const map = await this.flags.checkDemandRows(this.dataSource, [item], Number(dm.m), Number(dm.y));
                const f = map.get(`${mbno}|${item.loantype}`);
                if (!f || f.loancaseno !== loancaseno) continue;
                const d = `${Number(dm.y)}-${String(Number(dm.m)).padStart(2, '0')}-01`;
                const ack = ackFor(f.code, d, f.amount);
                notices.push({
                    code: f.code, severity: 'check', source: 'DEMAND', date: d, amount: f.amount, message: f.message,
                    ackable: true, acknowledged: !!ack, acknowledgedBy: ack?.checked_by ?? null, acknowledgedAt: ack?.checked_at ?? null,
                });
            }
        }

        // Overpayment and refund: payroll can keep deducting after the loan is fully repaid; the ledger then runs into a
        // credit balance, and a payment voucher hands the money back. Worked out from the ledger, never stored.
        const refunds: Array<{ date: string; voucher: string | null; refunded: number; overpaid: number }> = [];
        {
            let prev = opening;
            let overpaidSince: Array<{ d: string; amt: number }> = [];
            for (const sr of signed) {
                if (sr.dir === 'CR' && sr.bal < -0.5) {
                    overpaidSince.push({ d: sr.row.d, amt: r2(Math.min(sr.amt, -sr.bal)) });
                } else if (sr.dir === 'DR' && prev < -0.5 && String(sr.row.vchr_type || '').toUpperCase() === 'P') {
                    const back = r2(Math.min(sr.amt, -prev));
                    refunds.push({ date: sr.row.d, voucher: sr.row.rv ?? null, refunded: back, overpaid: r2(overpaidSince.reduce((t, x) => t + x.amt, 0)) });
                    overpaidSince = [];
                } else if (sr.bal >= -0.5) overpaidSince = [];
                prev = sr.bal;
            }
            for (const rf of refunds) {
                notices.push({
                    code: 'OVERPAID_REFUNDED', severity: 'info', source: 'LEDGER', date: rf.date, amount: rf.refunded,
                    message: `The member paid ₹${rf.overpaid.toLocaleString('en-IN')} more than this loan needed (payroll kept deducting after it was fully repaid). `
                        + `₹${rf.refunded.toLocaleString('en-IN')} was handed back on ${rf.date}${rf.voucher ? ` (voucher ${rf.voucher})` : ''}. `
                        + 'The loan is repaid; nothing is owed.',
                    ackable: false, acknowledged: false,
                });
            }
        }

        // Credit balance on this loan account (money taken after the loan was repaid, or posted to the wrong loan type).
        if (ledgerBalance < -0.5) {
            const otherCode = isRegular ? 'A1047' : 'A1002';
            const otherRow = (await this.dataSource.query(
                `SELECT ${loanHeadOpeningSql('$1::numeric', '$2::boolean')}
                        + COALESCE((SELECT SUM(CASE WHEN trans_type IN ('DR','P') THEN trans_amt WHEN trans_type IN ('CR','R') THEN -trans_amt ELSE 0 END)
                                      FROM ledger WHERE mbno = $1::numeric AND code = $3), 0) AS closing`,
                [mbno, !isRegular, otherCode],
            ))[0];
            const otherOwes = num(otherRow?.closing);
            const credit = r2(-ledgerBalance);
            const otherName = isRegular ? 'emergency' : 'regular';
            if (otherOwes > 0.5) {
                notices.push({
                    code: 'POSSIBLE_WRONG_LOAN_TYPE', severity: 'check', source: 'LEDGER', date: null, amount: credit,
                    message: `This ${isRegular ? 'regular' : 'emergency'} loan account is ₹${credit.toLocaleString('en-IN')} in credit, but the member's ${otherName} loan account owes `
                        + `₹${r2(otherOwes).toLocaleString('en-IN')}. The credit looks like it was posted to the wrong loan type, so together the member owes `
                        + `₹${r2(Math.max(0, otherOwes - credit)).toLocaleString('en-IN')}. Flagged for manual correction.`,
                    ackable: false, acknowledged: false,
                });
            } else {
                notices.push({
                    code: 'OVERPAID_NOT_REFUNDED', severity: 'info', source: 'LEDGER', date: null, amount: credit,
                    message: `The member paid ₹${credit.toLocaleString('en-IN')} more than this loan needed (payroll kept deducting after it was repaid) and the ledger shows no refund. `
                        + 'The member is owed this amount.',
                    ackable: false, acknowledged: false,
                });
            }
        }
        // Manual corrections applied to this loan by the migration (e.g. a credit posted to the wrong loan type in legacy).
        const corrected = await this.dataSource.query(
            `SELECT DISTINCT narration, to_char(payment_date,'YYYY-MM-DD') AS d, principal_amount FROM loan_repayment_ledger
              WHERE mbno = $1::numeric AND loancaseno = $2 AND loantype = $3 AND narration LIKE 'Manual correction%' ORDER BY d`,
            [mbno, loancaseno, loan.loantype],
        );
        for (const cr of corrected) {
            notices.push({
                code: 'MANUAL_CORRECTION', severity: 'info', source: 'LEDGER', date: cr.d, amount: num(cr.principal_amount),
                message: `${cr.narration}. The ledger itself is unchanged (it shows the legacy posting).`,
                ackable: false, acknowledged: false,
            });
        }

        // ledger vs loan record
        // A credit moved onto this loan by a manual correction is not in the ledger rows of this account, so it is taken off here.
        const correctedIn = r2(corrected.reduce((t: number, cr: any) => t + num(cr.principal_amount), 0));
        const diff = r2(ledgerBalance - correctedIn - recordBalance);
        if (Math.abs(diff) > SAME_AMOUNT) {
            const parts: string[] = [];
            if (lagPrincipal > 0) parts.push(`₹${lagPrincipal.toLocaleString('en-IN')} is old-loan EMI deductions the loan record keeps aside`);
            if (adjustments.length > 0) parts.push(`${adjustments.length} journal entr${adjustments.length === 1 ? 'y' : 'ies'} are in the ledger`);
            notices.push({
                code: 'LEDGER_DIFFERS', severity: 'info', source: 'LEDGER', date: null, amount: Math.abs(diff),
                message: `The ledger shows ₹${r2(ledgerBalance - correctedIn).toLocaleString('en-IN')} owed but the loan record shows ₹${recordBalance.toLocaleString('en-IN')} `
                    + `(difference ₹${Math.abs(diff).toLocaleString('en-IN')}).${parts.length ? ' ' + parts.join('; ') + '.' : ''} `
                    + 'Please check which one is right; correct the wrong side with Journal/Transfer Entry or a repayment.',
                ackable: false, acknowledged: false,
            });
        }
        // silent loan
        if (ledgerBalance > NEAR_ZERO || recordBalance > NEAR_ZERO) {
            const candidates = [lastLedgerCredit, ...pay.map((p: any) => p.d)].filter(Boolean) as string[];
            const last = candidates.sort().pop() || null;
            const refDate = last ? new Date(`${last}T12:00:00`) : startDate;
            const days = Math.floor((asOf.getTime() - refDate.getTime()) / 86400000);
            if (days > SILENT_DAYS) {
                notices.push({
                    code: 'NO_RECENT_PAYMENT', severity: 'info', source: 'SCHEDULE', date: last, amount: null,
                    message: last
                        ? `No payment for about ${Math.round(days / 30)} months (last one on ${last}).`
                        : `No payment since this loan was taken on ${ymd(startDate)}.`,
                    ackable: false, acknowledged: false,
                });
            }
        }

        return {
            asOf: ymd(asOf),
            loan: {
                mbno, loancaseno, loantype: loan.loantype, loanAmount, noOfInstalments: n, monthlyPrincipal, monthlyInterest,
                annualRate: sv ? num(sv.annual_rate) : num(loan.rate), startDate: ymd(startDate), firstDueMonth: ymd(firstDue),
                source: sv?.source ?? 'LEGACY / MIGRATED', absorbedCases: absorbed, consolidatedIntoCase: loan.into_case || null,
            },
            ledger: {
                account: isRegular ? 'Regular loan account' : 'Emergency loan account', headCode: head,
                runStartedOn: windowStart,
                carriedIn, balance: ledgerBalance, loansAdded: added, loansAddedTotal: addedTotal,
                paidByChannel: { ...byChannel, total: creditTotal }, adjustments, refunds,
            },
            record: {
                balance: recordBalance, summaryBalance, principalPaid: r2(principalPaid), interestPaid: r2(interestPaid), penalPaid: r2(penalPaid),
                oldEmiDeductions: { count: lagCount, principal: r2(lagPrincipal), interest: r2(lagInterest) },
                paymentsRecorded: pay.length,
            },
            difference: { ledgerMinusRecord: diff },
            schedule: {
                instalmentsDueSoFar: dueCount, principalDueSoFar: dueSoFarPrincipal, principalPaidOnRecord: r2(principalPaid),
                aheadOrBehind: aheadByRecord, aheadOrBehindInEmis: monthlyPrincipal > 0 ? r2(aheadByRecord / monthlyPrincipal) : null,
                projectedFinish: finish ? ymd(finish) : null, monthsLeftAtScheduledPace: monthsLeft,
            },
            closure,
            notices,
        };
    }

    /** Saves only a "checked" confirmation for a notice — the notice itself is always worked out fresh. */
    async acknowledge(body: {
        mbno: string; loancaseno: string; loantype?: string; code: string; date: string; amount: number; message?: string; username?: string; note?: string;
    }): Promise<{ success: boolean; message: string }> {
        const existing = await this.dataSource.query(
            `SELECT id FROM loan_payment_flags WHERE source = 'ACK' AND mbno = $1::numeric AND loancaseno = $2 AND flag_code = $3
                AND event_date = $4::date AND ABS(amount - $5) < 0.005 AND status = 'CHECKED' LIMIT 1`,
            [body.mbno, body.loancaseno, body.code, body.date, body.amount],
        );
        if (existing.length > 0) return { success: true, message: 'Already marked as checked.' };
        await this.dataSource.query(
            `INSERT INTO loan_payment_flags (source, mbno, loantype, loancaseno, flag_code, message, amount, event_date, status, created_by, checked_at, checked_by, checked_note)
             VALUES ('ACK', $1::numeric, $2, $3, $4, $5, $6, $7::date, 'CHECKED', $8, NOW(), $8, $9)`,
            [body.mbno, body.loantype || null, body.loancaseno, body.code, body.message || body.code, body.amount, body.date, body.username || 'system', body.note || null],
        );
        return { success: true, message: 'Marked as checked.' };
    }
}

export type { LoanFlagCode };
