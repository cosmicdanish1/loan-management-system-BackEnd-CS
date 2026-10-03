/**
 * Slot x tenure x consolidation matrix, run through the REAL application services
 * (saveLoanApplication -> updateLoanSanction -> generateLoanVoucher -> passTransaction
 * -> recordLoanRepayment) under a virtual clock, so every loan/disbursement/consolidation
 * /repayment lands on its historical date and the Member Ledger reads like a legacy
 * ledger. Repayments are mirrored into `ledger` as legacy-style "D" receipt vouchers
 * (loan head CR = principal, I1002 CR = interest), because recordLoanRepayment itself
 * only writes loan_repayment_ledger. Test data is intentionally retained.
 *
 * Usage: npx ts-node --transpile-only -r tsconfig-paths/register src/scripts/_simulate_slot_consolidation_matrix.ts [1,2,..]
 */
const RealDate = Date;
let virtualNow: number | null = null;
class FakeDate extends RealDate {
    constructor(...args: any[]) {
        if (args.length === 0 && virtualNow !== null) super(virtualNow);
        else super(...(args as [any]));
    }
    static now() { return virtualNow ?? RealDate.now(); }
}
(global as any).Date = FakeDate;

import * as fs from 'fs';
import { NestFactory } from '@nestjs/core';
import { DataSource } from 'typeorm';
import { AppModule } from '../app.module';
import { MemberCrudService } from '../modules/member/services-v2/member-crud.service';
import { LoanApplicationService } from '../modules/loan/services-v2/loan-application.service';
import { LoanSanctionService } from '../modules/loan/services-v2/loan-sanction.service';
import { LoanRepaymentService } from '../modules/loan/services-v2/loan-repayment.service';
import { VoucherService } from '../modules/transaction/services-v2/voucher.service';
import { PassTransactionService } from '../modules/transaction/services-v2/pass-transaction.service';
import { RdBalanceEventsService } from '../modules/rd/services/rd-balance-events.service';

type D = [number, number, number]; // y, m(1-12), d
interface Loan { date: D; amt: number; n: number; }
interface Step { kind: 'repay' | 'lag' | 'probe'; date: D; }
interface Plan {
    id: number; label: string; loans: Loan[];
    // events after loan index i (0-based) is disbursed, until the next loan
    after: Step[][];
}
const rep = (y: number, m: number): Step => ({ kind: 'repay', date: [y, m, 14] });
const lag = (y: number, m: number): Step => ({ kind: 'lag', date: [y, m, 14] });
const probe = (y: number, m: number): Step => ({ kind: 'probe', date: [y, m, 14] });
const reps = (y: number, m: number, count: number): Step[] => {
    const out: Step[] = [];
    for (let i = 0; i < count; i++) { out.push(rep(y + Math.floor((m - 1 + i) / 12), ((m - 1 + i) % 12) + 1)); }
    return out;
};

const PLANS: Plan[] = [
    { id: 1, label: 'S1-LATE 6m -> consolidate EARLY 10m', loans: [{ date: [2025, 1, 28], amt: 60000, n: 6 }, { date: [2025, 6, 3], amt: 40000, n: 10 }],
        after: [reps(2025, 3, 3), [lag(2025, 6), ...reps(2025, 7, 4)]] },
    { id: 2, label: 'S1-EARLY 10m -> consolidate LATE 12m', loans: [{ date: [2025, 2, 3], amt: 100000, n: 10 }, { date: [2025, 8, 27], amt: 50000, n: 12 }],
        after: [reps(2025, 3, 5), [lag(2025, 9), ...reps(2025, 10, 4)]] },
    { id: 3, label: 'S2 12m -> consolidate S2 12m (+probe 2nd old-EMI)', loans: [{ date: [2025, 1, 10], amt: 120000, n: 12 }, { date: [2025, 9, 12], amt: 80000, n: 12 }],
        after: [reps(2025, 3, 6), [lag(2025, 9), probe(2025, 10), ...reps(2025, 11, 4)]] },
    { id: 4, label: 'S1-EARLY 6m -> consolidate LATE 6m', loans: [{ date: [2025, 3, 4], amt: 60000, n: 6 }, { date: [2025, 6, 26], amt: 50000, n: 6 }],
        after: [reps(2025, 4, 2), [lag(2025, 7), ...reps(2025, 8, 4)]] },
    { id: 5, label: 'S1-LATE 10m -> consolidate S2 10m', loans: [{ date: [2025, 3, 27], amt: 100000, n: 10 }, { date: [2025, 9, 8], amt: 60000, n: 10 }],
        after: [reps(2025, 5, 4), [lag(2025, 9), ...reps(2025, 11, 4)]] },
    { id: 6, label: 'S1-LATE 12m -> consolidate EARLY 6m', loans: [{ date: [2025, 4, 29], amt: 120000, n: 12 }, { date: [2025, 11, 4], amt: 40000, n: 6 }],
        after: [reps(2025, 6, 5), [lag(2025, 11), ...reps(2025, 12, 4)]] },
    { id: 7, label: 'S2 6m (2 missed EMIs -> NR+penal) -> consolidate S2 12m', loans: [{ date: [2025, 4, 15], amt: 60000, n: 6 }, { date: [2025, 10, 20], amt: 60000, n: 12 }],
        after: [reps(2025, 6, 3), [lag(2025, 11), ...reps(2025, 12, 4)]] },
    { id: 8, label: 'S2 10m (4 missed EMIs -> NR+penal) -> consolidate EARLY 12m', loans: [{ date: [2025, 5, 20], amt: 100000, n: 10 }, { date: [2026, 1, 2], amt: 70000, n: 12 }],
        after: [reps(2025, 7, 3), [lag(2026, 1), ...reps(2026, 2, 4)]] },
    { id: 9, label: 'EARLY 12m -> LATE 10m -> S2 6m (chained, WITH payroll-lag payments)', loans: [{ date: [2025, 6, 2], amt: 120000, n: 12 }, { date: [2026, 2, 27], amt: 90000, n: 10 }, { date: [2026, 7, 22], amt: 50000, n: 6 }],
        after: [reps(2025, 7, 6), [lag(2026, 3), ...reps(2026, 4, 4)], [lag(2026, 8), ...reps(2026, 9, 1)]] },
    { id: 10, label: 'S2 12m -> LATE 10m -> EARLY 6m (chained, no payroll-lag payments)', loans: [{ date: [2025, 3, 12], amt: 120000, n: 12 }, { date: [2025, 8, 26], amt: 60000, n: 10 }, { date: [2026, 1, 3], amt: 40000, n: 6 }],
        after: [reps(2025, 5, 3), reps(2025, 10, 3), reps(2026, 2, 3)] },
];

const MBNO_OFFICE = { officeno: 2, branchmsno: '1-POWERHOUSE-POWERHOUSE-94' };
const setNow = ([y, m, d]: D) => { virtualNow = RealDate.UTC(y, m - 1, d, 4, 30); }; // 10:00 IST
const istMidnight = ([y, m, d]: D) => new RealDate(RealDate.UTC(y, m - 1, d) - 5.5 * 3600 * 1000);
const fmt = (d: D) => `${String(d[2]).padStart(2, '0')}-${String(d[1]).padStart(2, '0')}-${d[0]}`;

const RESUME_MBNO = process.env.RESUME_MBNO;            // existing member to continue
const RESUME_FROM = Number(process.env.RESUME_FROM ?? 0);   // 0-based loan index to resume at
const RESUME_CASE = process.env.RESUME_CASE;            // already-sanctioned pending case for that loan

async function main() {
    const only = process.argv[2] ? process.argv[2].split(',').map(Number) : PLANS.map(p => p.id);
    const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
    const report: any[] = [];
    try {
        const memberCrud = app.get(MemberCrudService);
        const loanApp = app.get(LoanApplicationService);
        const loanSanction = app.get(LoanSanctionService);
        const loanRepay = app.get(LoanRepaymentService);
        const voucherSvc = app.get(VoucherService);
        const passSvc = app.get(PassTransactionService);
        const rdEvents = app.get(RdBalanceEventsService);
        const ds = app.get(DataSource);
        // Make sure the voucher counter is never behind the highest existing voucher.
        await ds.query(`UPDATE sequence_master SET last_value = GREATEST(last_value, (SELECT COALESCE(MAX(substring("voucherNumber" from 4)::int),0) FROM vouchers WHERE "voucherNumber" ~ '^VCH[0-9]+$')) WHERE sequence_key = 'VOUCHER_NO'`);

        async function mirrorToLedger(mbno: string, caseNo: string, rows: any[], payDate: D) {
            for (const r of rows) {
                const principal = Number(r.principal_amount), interest = Number(r.interest_amount) + Number(r.penal_amount);
                const mx = await ds.query(`SELECT COALESCE(MAX(substring(receipt_vchr_no from 2)::int),0) v FROM ledger WHERE vchr_type='D' AND receipt_vchr_no ~ '^D[0-9]+$'`);
                const vno = 'D' + String(Number(mx[0].v) + 1).padStart(5, '0');
                const legs: Array<[string, string, number]> = [];
                if (principal > 0) legs.push(['A1002', 'RLN', principal]);
                if (interest > 0) legs.push(['I1002', 'OTH', interest]);
                for (const [code, accType, amt] of legs) {
                    const ids = await ds.query(`SELECT COALESCE(MAX(ledgerid),0)+1 l, COALESCE(MAX(trans_no),0)+1 t FROM ledger`);
                    await ds.query(
                        `INSERT INTO ledger (trans_no, trans_date, trans_type, code, mbno, acc_no, acc_type, trans_amt, receipt_vchr_no, vchr_type, modeofpay, pl_balance, narration, username, ledgerid)
                         VALUES ($1,$2,'CR',$3,$4,$5,$6,$7,$8,'D','B',0,$9,'sim-matrix',$10)`,
                        [ids[0].t, istMidnight(payDate), code, mbno, caseNo, accType, amt, vno,
                            r.is_payroll_lag_credit ? 'Demand Receipt (old EMI - payroll lag)' : 'Demand Receipt', ids[0].l]);
                }
            }
        }

        async function disburse(mbno: string, loan: Loan, label: string, existingCase?: string) {
            setNow(loan.date);
            let caseNo: string;
            if (existingCase) caseNo = existingCase;
            else {
                const application = await loanApp.saveLoanApplication({
                    memberNo: mbno, loanAmount: loan.amt, noOfInstallments: loan.n, loanType: 'REGULAR',
                    reason: `Matrix test - ${label}`, applDate: istMidnight(loan.date),
                });
                caseNo = String(application.loanCaseNo ?? application.data?.loancaseno);
                await loanSanction.updateLoanSanction(caseNo, { sanctionedAmount: loan.amt, sanctionDate: new Date(), noOfInstallments: loan.n });
            }
            // The voucher sequence resets yearly off new Date(); under a virtual clock that
            // would reset/collide, so pin last_year high for the duration of the call.
            await ds.query(`UPDATE sequence_master SET last_year = 9999 WHERE sequence_key = 'VOUCHER_NO'`);
            const v = await voucherSvc.generateLoanVoucher({
                loanCaseNo: caseNo, paymentMode: 'CASH',
                breakdown: [{ srNo: 1, code: 'A1002', name: 'Regular Loan Disbursement', rp: 'Payment', amount: loan.amt }],
            });
            await ds.query(`UPDATE sequence_master SET last_year = 9999 WHERE sequence_key = 'VOUCHER_NO'`);
            const res: any = await passSvc.passTransaction(v.voucherNo, 'sim-matrix');
            const lm = (await ds.query(`SELECT loancaseno, loan_amt, instal_amt, no_of_instal, delay_months, intt_amount FROM loan_master WHERE loancaseno::text=$1 AND mbno=$2`, [caseNo, mbno]))[0];
            const sv = (await ds.query(`SELECT first_due_month FROM loan_schedule_versions WHERE loancaseno::text=$1 AND mbno=$2 ORDER BY version_no DESC LIMIT 1`, [caseNo, mbno]))[0];
            return { caseNo, voucher: v.voucherNo, consolidation: res.consolidation ?? null, lm, firstDue: sv?.first_due_month };
        }

        await ds.query(`UPDATE member_master SET l_name='M1_ABORTED_DEBUG_RUN' WHERE mbno::text='9999962385' AND l_name='M1'`);
        // Members built under the earlier declining-interest billing model are kept, just relabelled.
        await ds.query(`UPDATE member_master SET l_name = l_name || '_OLD_DECLINING_INTEREST' WHERE f_name='SLOTMATRIX' AND l_name ~ '^M[0-9]+$'`);
        await ds.query(`UPDATE member_master SET l_name = l_name || '_OLD_NETTED_LEDGER' WHERE f_name='SLOTMATRIX' AND l_name ~ '^V2_M[0-9]+$'`);
        await ds.query(`UPDATE member_master SET l_name = l_name || '_OLD_PRE_LAG_INTEREST' WHERE f_name='SLOTMATRIX' AND l_name ~ '^V3_M[0-9]+$'`);
        for (const plan of PLANS.filter(p => only.includes(p.id))) {
            console.log(`\n######## MEMBER ${plan.id}: ${plan.label}`);
            virtualNow = null;
            if (RESUME_MBNO) { /* continue existing member, skip creation + seeding */ }
            const member = RESUME_MBNO ? { mbno: RESUME_MBNO } : await memberCrud.saveMemberMaster({
                mbno: 'auto', f_name: 'SLOTMATRIX', l_name: `V4_M${plan.id}`, ...MBNO_OFFICE, isactive: 'Y', memb_date: new RealDate(2024, 0, 1),
            });
            const mbno = String(member.mbno);
            const mrep: any = { plan: plan.id, label: plan.label, mbno, events: [] };
            report.push(mrep);
            if (!RESUME_MBNO) {
            // Realistic RD / Share holdings so the 5% rule never withholds from disbursement.
            await rdEvents.recordLoanAddition(mbno, 1, 100000, new RealDate(), 'sim-matrix seed RD', 'sim-matrix');
            const skipBalRow = (process.env.NO_ROW_MEMBERS || '').split(',').map(Number).includes(plan.id);
            const hasBal = skipBalRow ? [{}] : await ds.query(`SELECT 1 FROM member_balances WHERE mbno = $1`, [mbno]);
            if (hasBal.length === 0) await ds.query(`INSERT INTO member_balances (mbno, shares, regularloan, emergency_loan_balance) VALUES ($1, 100000, 0, 0)`, [mbno]);
            else if (!skipBalRow) await ds.query(`UPDATE member_balances SET shares = 100000 WHERE mbno = $1`, [mbno]);
            }

            try {
                for (let i = 0; i < plan.loans.length; i++) {
                    const loan = plan.loans[i];
                    if (RESUME_MBNO && i < RESUME_FROM) continue;
                    const out = await disburse(mbno, loan, `${plan.label} #${i + 1}`, RESUME_MBNO && i === RESUME_FROM ? RESUME_CASE : undefined);
                    console.log(`  loan#${i + 1} ${fmt(loan.date)} case ${out.caseNo}: amt ${out.lm.loan_amt} n=${out.lm.no_of_instal} EMI ${out.lm.instal_amt} delay ${out.lm.delay_months} firstDue ${out.firstDue}`
                        + (out.consolidation ? ` | CONSOLIDATED closureInt=${out.consolidation.oldClosureInterestTotal} combined=${out.consolidation.combinedPrincipal} net=${out.consolidation.netDisbursement}` : ''));
                    mrep.events.push({ type: 'disburse', date: fmt(loan.date), ...out });
                    let caseNo = out.caseNo;
                    for (const s of plan.after[i] ?? []) {
                        setNow(s.date);
                        const asOf = new Date();
                        let amount = 0;
                        if (s.kind === 'repay') {
                            const due: any = await loanRepay.getDueStatus(caseNo, asOf as any);
                            amount = Number(due?.totalDue || 0);
                        } else {
                            // old-loan EMI = previous loan's frozen EMI split, as the watch window expects
                            const lmx = (await ds.query(`SELECT payroll_lag_old_principal p, payroll_lag_old_interest i FROM loan_master WHERE loancaseno::text=$1 AND mbno=$2`, [caseNo, mbno]))[0];
                            amount = Math.round((Number(lmx.p) + Number(lmx.i)) * 100) / 100;
                        }
                        if (amount <= 0) { console.log(`    ${fmt(s.date)} ${s.kind}: nothing due, skipped`); mrep.events.push({ type: s.kind, date: fmt(s.date), skipped: true }); continue; }
                        const before = (await ds.query(`SELECT COALESCE(MAX(id),0) m FROM loan_repayment_ledger`))[0].m;
                        try {
                            const r = await loanRepay.recordLoanRepayment({
                                mbno, loancaseno: caseNo, loantype: 'RLN', paymentAmount: amount, asOfDate: asOf,
                                narration: `Matrix ${s.kind}`, username: 'sim-matrix',
                            } as any);
                            const rows = await ds.query(`SELECT * FROM loan_repayment_ledger WHERE id > $1 AND mbno=$2 ORDER BY id`, [before, mbno]);
                            await mirrorToLedger(mbno, caseNo, rows, s.date);
                            console.log(`    ${fmt(s.date)} ${s.kind} ₹${amount}: ${r.message}`);
                            mrep.events.push({ type: s.kind, date: fmt(s.date), amount, message: r.message });
                        } catch (e: any) {
                            console.log(`    ${fmt(s.date)} ${s.kind} ₹${amount}: REJECTED -> ${e.message}`);
                            mrep.events.push({ type: s.kind, date: fmt(s.date), amount, rejected: e.message });
                        }
                    }
                }
            } catch (e: any) {
                console.error(`  !! member ${plan.id} aborted: ${e.message}`);
                mrep.error = e.message;
            }
        }
    } finally {
        virtualNow = null;
        try {
            const dsx = app.get(DataSource);
            await dsx.query(`UPDATE sequence_master SET last_year = EXTRACT(YEAR FROM NOW())::int,
                last_value = GREATEST(last_value, (SELECT COALESCE(MAX(substring("voucherNumber" from 4)::int),0) FROM vouchers WHERE "voucherNumber" ~ '^VCH[0-9]+$'))
              WHERE sequence_key = 'VOUCHER_NO'`);
        } catch (e) { console.error('sequence repair failed', e); }
        fs.writeFileSync(process.env.REPORT_OUT || 'matrix_report.json', JSON.stringify(report, null, 2));
        try { await app.close(); } catch { /* known shutdown-hook noise */ }
    }
}
main().catch(e => { console.error(e); process.exit(1); });
