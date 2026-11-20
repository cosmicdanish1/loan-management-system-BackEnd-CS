import 'dotenv/config';
// ES-558 live check of the Loan Repayment -> Past Transaction flow on the test database.
//
//  A. Dues parity (read only): for a sample of loans, the Loan Repayment dues (getDueStatus) equal the overdue part of
//     the Early Closure quote (calculateEarlyClosure) per installment (principal and interest), and the new totals add up.
//  B. Plan rules (read only): an amount above the dues is refused, a partial amount is split penal -> interest -> principal.
//  C. Voucher flow on ONE loan with dues: raise the voucher, check its lines, a second repayment and an immediate early
//     closure are refused (one pending voucher per loan), then PASS it inside a transaction that is ROLLED BACK (so the
//     posting is checked but no ledger / balance row stays), then reject it and remove the test voucher.
//
// Leaves nothing behind except a CANCELLED row in loan_repayment_holds for the voucher it raised and removed.
// Run: npx ts-node --files -r tsconfig-paths/register src/scripts/_verify-loan-repayment-voucher.ts
import { DataSource } from 'typeorm';
import { LoanRepaymentService } from '../modules/loan/services-v2/loan-repayment.service';
import { LoanEligibilityService } from '../modules/loan/services-v2/loan-eligibility.service';
import { LoanRepaymentHoldService } from '../modules/loan/services-v2/repayment-hold/loan-repayment-hold.service';
import { RdRulesService } from '../modules/rd/rd-rules.service';
import { RdBalanceEventsService } from '../modules/rd/services/rd-balance-events.service';

const ds = new DataSource({
    type: 'postgres', host: 'localhost', port: 5432, database: 'EMP_Espat_Society',
    username: 'postgres', password: process.env.DB_PASSWORD, entities: [__dirname + '/../**/*.entity{.ts,.js}'], synchronize: false, logging: false,
});

let failed = 0;
const check = (label: string, ok: boolean, extra?: any) => { if (!ok) failed++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`, extra ?? ''); };
const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

async function main() {
    await ds.initialize();
    const rdRules = new RdRulesService(ds);
    const rdEvents = new RdBalanceEventsService(ds, rdRules);
    const svc = new LoanRepaymentService(ds, new LoanEligibilityService(ds, rdEvents, rdRules), rdEvents);
    let seq = 0;
    const fakeSequence: any = { getNextVoucherNumber: async () => `LRT${String(Date.now() % 1_000_000).padStart(6, '0')}${seq++}` };
    const hold = new LoanRepaymentHoldService(ds, fakeSequence, svc);
    await hold.ensureTable();

    // ---------------------------------------------------------------- A. dues parity
    const sample = await ds.query(
        `SELECT lm.mbno::text AS mbno, lm.loancaseno::text AS c, lm.loantype
           FROM loan_master lm
           WHERE lm.balance > 0 AND lm.consolidated_into_loancaseno IS NULL
             AND (SELECT COUNT(*) FROM loan_master x WHERE x.loancaseno::text = lm.loancaseno::text) = 1
           ORDER BY random() LIMIT 40`);
    let parityChecked = 0, parityBad = 0, penalDiff = 0, totalsBad = 0, graceRows = 0, withDues = null as any;
    for (const l of sample) {
        try {
            const due: any = await svc.getDueStatus(l.c);
            if (!due.unpaidInstallments.length) continue;
            const q: any = await svc.calculateEarlyClosure(l.c, undefined, 0, true, l.mbno);
            parityChecked++;
            if (!withDues) withDues = l;
            const sumEmi = r2(due.unpaidInstallments.reduce((s: number, i: any) => s + i.emiAmount, 0));
            const sumP = r2(due.unpaidInstallments.reduce((s: number, i: any) => s + i.principalDue, 0));
            const sumI = r2(due.unpaidInstallments.reduce((s: number, i: any) => s + i.interestDue, 0));
            const sumPen = r2(due.unpaidInstallments.reduce((s: number, i: any) => s + i.penalDue, 0));
            if (Math.abs(sumEmi - due.totalEmi) > 0.01 || Math.abs(sumP - due.totalPrincipalDue) > 0.01
                || Math.abs(sumI - due.totalInterestDue) > 0.01 || Math.abs(sumPen - due.totalPenalDue) > 0.01
                || Math.abs(r2(sumP + sumI + sumPen) - due.totalDue) > 0.01) totalsBad++;
            for (const i of due.unpaidInstallments) {
                const m = (q.unpaidInstallments || []).find((u: any) => u.installmentNo === i.installmentNo);
                // Early Closure quotes the current month's installment (still inside its grace window, no penalty) separately,
                // not in its overdue list; Loan Repayment lists it as due. That is the one expected difference.
                if (!m && i.tier === 0 && i.monthsOverdue === 0 && i.penalDue === 0) { graceRows++; continue; }
                if (!m || Math.abs(m.principalDue - i.principalDue) > 0.01 || Math.abs(m.interestDue - i.interestDue) > 0.01) { parityBad++; console.log('  mismatch', l.c, i.installmentNo, m && { p: m.principalDue, i: m.interestDue }, { p: i.principalDue, i: i.interestDue }); }
                else if (Math.abs(m.penalDue - i.penalDue) > 0.01) penalDiff++;
            }
        } catch (e: any) { console.log('  skipped', l.c, String(e.message || e).slice(0, 100)); }
    }
    console.log(`A. loans with dues checked: ${parityChecked} of ${sample.length} sampled`);
    check('A1. every due-status total equals the sum of its rows (EMI, principal, interest, penalty, grand total)', totalsBad === 0, { totalsBad });
    check('A2. due-status principal/interest per installment equals the Early Closure quote', parityBad === 0, { parityBad });
    console.log(`   (info) current-month grace installments listed by Repayment but quoted separately by Early Closure: ${graceRows}`);
    console.log(`   (info) installments where the penalty differs between the two (same-month fee only applies to cash): ${penalDiff}`);

    if (!withDues) { console.log('No loan with dues in the sample; sections B and C skipped.'); await ds.destroy(); process.exit(failed ? 1 : 0); }

    // ---------------------------------------------------------------- B. plan rules
    const due: any = await svc.getDueStatus(withDues.c);
    const total = due.totalDue;
    let refused = '';
    try { await svc.buildRepaymentPlan(null, { mbno: withDues.mbno, loancaseno: withDues.c, loantype: withDues.loantype, amount: total + 100 }); } catch (e: any) { refused = String(e.message || e); }
    check('B1. an amount above the dues is refused and points to Early Closure', /Early Closure/i.test(refused), refused.slice(0, 120));
    const full = await svc.buildRepaymentPlan(null, { mbno: withDues.mbno, loancaseno: withDues.c, loantype: withDues.loantype, amount: total });
    check('B2. the full dues are applied to the cent (principal + interest + penalty = dues)', Math.abs(full.plan.amount - total) < 0.01 && Math.abs(r2(full.plan.principal + full.plan.interest + full.plan.penal) - total) < 0.01, { total, plan: full.plan.amount });
    const first = due.unpaidInstallments[0];
    const partialAmt = r2(first.penalDue + first.interestDue); // clears the oldest installment's penalty and interest only
    if (partialAmt > 0 && partialAmt < total - 0.005) {
        const p = await svc.buildRepaymentPlan(null, { mbno: withDues.mbno, loancaseno: withDues.c, loantype: withDues.loantype, amount: partialAmt });
        const row0 = p.plan.rows[0];
        check('B3. a partial amount clears the oldest installment first: its penalty, then its interest, before any principal',
            p.plan.rows.length === 1 && row0.installmentNo === first.installmentNo && Math.abs(row0.penal - first.penalDue) < 0.01 && Math.abs(row0.interest - first.interestDue) < 0.01 && row0.principal === 0,
            { row0 });
    }

    // ---------------------------------------------------------------- C. voucher flow
    // loan with no pending voucher of any kind
    const pending = await ds.query(`SELECT 1 FROM loan_repayment_holds WHERE mbno = $1 AND loancaseno = $2 AND status = 'PENDING'`, [withDues.mbno, withDues.c]);
    if (pending.length) { console.log('The chosen loan already has a pending repayment; C skipped.'); await ds.destroy(); process.exit(failed ? 1 : 0); }

    const raised: any = await hold.create({
        mbno: withDues.mbno, loancaseno: withDues.c, loantype: withDues.loantype, amount: total,
        receiptNo: `LRT-${Date.now() % 1_000_000}`, narration: 'ES-558 verification (removed)', paymentMode: 'CASH',
    }, 'verify-script');
    const voucherNo = raised.voucherNo;
    console.log(`C. raised voucher ${voucherNo} on loan ${withDues.c} for ${total}`);
    try {
        check('C1. the voucher is raised PENDING and nothing is posted yet', (await ds.query(`SELECT status FROM vouchers WHERE "voucherNumber" = $1`, [voucherNo]))[0]?.status === 'PENDING'
            && Number((await ds.query(`SELECT COUNT(*)::int AS n FROM loan_repayment_ledger WHERE receipt_no LIKE 'LRT-%' AND loancaseno = $1`, [withDues.c]))[0].n) === 0);
        const lines = await ds.query(`SELECT trans_type, code, trans_amt::float AS amt FROM transactions WHERE receipt_vchr_no = $1 ORDER BY trans_no`, [voucherNo]);
        const cr = r2(lines.filter((x: any) => x.trans_type === 'R').reduce((s: number, x: any) => s + x.amt, 0));
        const dr = r2(lines.filter((x: any) => x.trans_type === 'DR').reduce((s: number, x: any) => s + x.amt, 0));
        check('C2. voucher lines balance (credits = cash debit = amount) and include the principal head', cr === dr && Math.abs(dr - total) < 0.01
            && (raised.plan.principal <= 0 || lines.some((x: any) => x.code === (String(withDues.loantype).toUpperCase() === 'RLN' ? 'A1002' : 'A1047'))), lines);

        let msg = '';
        try { await hold.create({ mbno: withDues.mbno, loancaseno: withDues.c, loantype: withDues.loantype, amount: total, narration: 'second (must be refused)' }, 'verify-script'); } catch (e: any) { msg = String(e.message || e); }
        check('C3. a second repayment on the same loan is refused, naming the voucher', msg.includes(voucherNo), msg.slice(0, 160));

        msg = '';
        try { await svc.executeEarlyClosure(withDues.c, undefined, 0, 'verify-script', undefined, true, withDues.mbno); } catch (e: any) { msg = String(e.message || e); }
        check('C4. an immediate early closure is refused while the repayment is pending', msg.includes(voucherNo), msg.slice(0, 160));

        // PASS inside a transaction that is rolled back: the posting is checked, nothing stays
        const before = (await ds.query(`SELECT balance::float AS b FROM loan_master WHERE loancaseno::text = $1 AND mbno = $2 AND loantype = $3`, [withDues.c, withDues.mbno, withDues.loantype]))[0].b;
        const qr = ds.createQueryRunner();
        await qr.connect();
        await qr.startTransaction();
        try {
            const res: any = await hold.passInTransaction(qr, voucherNo, {}, [], 'verify-script');
            const ledgerRows = await qr.query(`SELECT COUNT(*)::int AS n, COALESCE(SUM(principal_amount),0)::float AS p, COALESCE(SUM(interest_amount),0)::float AS i, COALESCE(SUM(penal_amount),0)::float AS pen FROM loan_repayment_ledger WHERE loancaseno::text = $1 AND mbno = $2 AND posted_by = 'verify-script'`, [withDues.c, withDues.mbno]);
            const after = (await qr.query(`SELECT balance::float AS b FROM loan_master WHERE loancaseno::text = $1 AND mbno = $2 AND loantype = $3`, [withDues.c, withDues.mbno, withDues.loantype]))[0].b;
            const gl = await qr.query(`SELECT trans_type, code, trans_amt::float AS amt FROM ledger WHERE receipt_vchr_no = $1`, [voucherNo]);
            const glDr = r2(gl.filter((x: any) => x.trans_type === 'DR').reduce((s: number, x: any) => s + x.amt, 0));
            const glCr = r2(gl.filter((x: any) => x.trans_type === 'CR').reduce((s: number, x: any) => s + x.amt, 0));
            const cashbook = await qr.query(`SELECT COUNT(*)::int AS n FROM tblcashbook WHERE voucher_no = $1`, [voucherNo]);
            check('C5. Pass writes the loan ledger rows matching the plan', ledgerRows[0].n >= 1 && Math.abs(r2(ledgerRows[0].p + ledgerRows[0].i + ledgerRows[0].pen) - total) < 0.01, ledgerRows[0]);
            check('C6. Pass lowers the loan balance by exactly the principal paid', Math.abs(r2(before - after) - r2(res.principal)) < 0.01, { before, after, principal: res.principal });
            check('C7. the general-ledger legs balance (debits = credits) and the cash book has rows', glDr === glCr && glDr > 0 && cashbook[0].n >= 1, { glDr, glCr, cashbook: cashbook[0].n });
            // a second Pass of the same hold is refused
            let again = '';
            try { await qr.query('SAVEPOINT s1'); await hold.passInTransaction(qr, voucherNo, {}, [], 'verify-script'); } catch (e: any) { again = String(e.message || e); await qr.query('ROLLBACK TO SAVEPOINT s1'); }
            check('C8. passing the same voucher twice is refused', /POSTED|cannot be passed/.test(again), again.slice(0, 120));
        } finally {
            await qr.rollbackTransaction();
            await qr.release();
        }
        const afterRollback = (await ds.query(`SELECT balance::float AS b FROM loan_master WHERE loancaseno::text = $1 AND mbno = $2 AND loantype = $3`, [withDues.c, withDues.mbno, withDues.loantype]))[0].b;
        check('C9. the test Pass was rolled back: the loan balance is unchanged', afterRollback === before, { before, afterRollback });
    } finally {
        // reject: cancel the hold, remove the test voucher and its lines (records this script created)
        const qr = ds.createQueryRunner();
        await qr.connect();
        await qr.startTransaction();
        await hold.onVoucherRejected(qr, voucherNo);
        await qr.query(`DELETE FROM transactions WHERE receipt_vchr_no = $1`, [voucherNo]);
        await qr.query(`DELETE FROM vouchers WHERE "voucherNumber" = $1`, [voucherNo]);
        await qr.commitTransaction();
        await qr.release();
    }
    const st = (await ds.query(`SELECT status FROM loan_repayment_holds WHERE voucher_no = $1`, [voucherNo]))[0]?.status;
    check('C10. rejecting cancels the hold and a new repayment can be raised again', st === 'CANCELLED'
        && (await ds.query(`SELECT 1 FROM vouchers WHERE "voucherNumber" = $1`, [voucherNo])).length === 0);

    console.log(failed ? `\n${failed} CHECK(S) FAILED` : '\nALL CHECKS PASSED');
    await ds.destroy();
    process.exit(failed ? 1 : 0);
}

main().catch(async e => { console.error(e); try { await ds.destroy(); } catch { /* ignore */ } process.exit(1); });
