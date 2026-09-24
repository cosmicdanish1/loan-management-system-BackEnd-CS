// Exercises the REAL application code end to end (LoanApplicationService ->
// LoanSanctionService -> VoucherService -> PassTransactionService ->
// LoanRepaymentService) — not raw SQL fixtures — to prove the "one active
// loan per type" consolidation invariant holds through the actual app logic.
//
// For member 900000003: disburses 3 Emergency (ALN) loans and 2 Regular
// (RLN) loans, one after another. Per the consolidation logic added this
// session, disbursing a 2nd/3rd same-type loan must automatically merge it
// into the existing active case rather than creating a new independent one.
// End state MUST be exactly 2 active loan_master rows for this member (one
// ALN, one RLN) — matching what Loan Early Closure / Loan Repayment should
// show when this member is looked up.
//
// To exercise real NR (due-but-unpaid) + AP + penal in the oldClosureInterest
// math (not just the clean AP-only case already covered by
// _verify-worked-example-500k.ts), the first loan of each type has its
// loan_master.payment_date backdated immediately after disbursement (the one
// deliberate "time travel" step — passTransaction() itself has no test-clock
// override, unlike recordLoanRepayment's asOfDate), then real repayments are
// recorded through the actual recordLoanRepayment() service, leaving some
// installments genuinely paid, some genuinely overdue-and-unpaid.
import { NestFactory } from '@nestjs/core';
import { DataSource } from 'typeorm';
import { AppModule } from '../app.module';
import { LoanApplicationService } from '../modules/loan/services-v2/loan-application.service';
import { LoanSanctionService } from '../modules/loan/services-v2/loan-sanction.service';
import { LoanRepaymentService } from '../modules/loan/services-v2/loan-repayment.service';
import { VoucherService } from '../modules/transaction/services-v2/voucher.service';
import { PassTransactionService } from '../modules/transaction/services-v2/pass-transaction.service';

const MBNO = '900000003';

async function main() {
    const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
    try {
        const loanApp = app.get(LoanApplicationService);
        const loanSanction = app.get(LoanSanctionService);
        const loanRepayment = app.get(LoanRepaymentService);
        const voucherSvc = app.get(VoucherService);
        const passSvc = app.get(PassTransactionService);
        const dataSource = app.get(DataSource);

        // Reset the member to a clean slate for this scenario (this member
        // has been reused across many verify scripts this session).
        await dataSource.query(`UPDATE loan_master SET balance = 0 WHERE mbno = $1`, [MBNO]);
        await dataSource.query(`UPDATE member_balances SET regularloan = 0, emergency_loan_balance = 0 WHERE mbno = $1`, [MBNO]);

        async function applySanctionDisburse(loanType: 'EMERGENCY' | 'REGULAR', amount: number, n: number, headCode: string, label: string) {
            console.log(`\n=== ${label}: applying ${loanType} ₹${amount} / ${n}mo ===`);
            const application = await loanApp.saveLoanApplication({
                memberNo: MBNO,
                loanAmount: amount,
                noOfInstallments: n,
                loanType,
                reason: `Consolidation scenario test - ${label}`,
                applDate: new Date(),
            });
            const caseNo = String(application.loanCaseNo ?? application.data?.loancaseno);
            console.log(`  applied: case ${caseNo}`);

            await loanSanction.updateLoanSanction(caseNo, {
                sanctionedAmount: amount,
                sanctionDate: new Date(),
                noOfInstallments: n,
            });
            console.log(`  sanctioned`);

            const voucherResult = await voucherSvc.generateLoanVoucher({
                loanCaseNo: caseNo,
                paymentMode: 'CASH',
                breakdown: [{ srNo: 1, code: headCode, name: `${label} Disbursement`, rp: 'Payment', amount }],
            });
            console.log(`  voucher: ${voucherResult.voucherNo}`);

            const passResult: any = await passSvc.passTransaction(voucherResult.voucherNo, 'scenario-test');
            console.log(`  passed:`, passResult.consolidation ? `CONSOLIDATED into ${passResult.consolidation.newLoanCaseNo} (oldClosureInterest ₹${passResult.consolidation.oldClosureInterestTotal})` : 'fresh disbursement, no consolidation');

            return caseNo;
        }

        // ── 3 Emergency (ALN) loans, sequential — 2nd and 3rd must consolidate ──
        const aln1 = await applySanctionDisburse('EMERGENCY', 60000, 12, 'A1047', 'ALN #1');

        // Backdate ALN #1's disbursement 7 months into the past so real
        // installments become due, then replay real on-time payments through
        // the actual recordLoanRepayment() service for the first 4 months —
        // leaving the rest genuinely overdue-and-unpaid (NR) when ALN #2
        // consolidates into it.
        const sevenMonthsAgo = new Date();
        sevenMonthsAgo.setMonth(sevenMonthsAgo.getMonth() - 7);
        await dataSource.query(`UPDATE loan_master SET payment_date = $1 WHERE loancaseno::text = $2`, [sevenMonthsAgo, aln1]);
        console.log(`  [time-travel] ALN #1 (case ${aln1}) backdated to ${sevenMonthsAgo.toDateString()}`);

        for (let i = 1; i <= 4; i++) {
            const asOf = new Date(sevenMonthsAgo);
            asOf.setMonth(asOf.getMonth() + i + 1); // matches Slot delayMonths=1/2 due-date offset closely enough
            const dueStatus = await loanRepayment.getDueStatus(aln1, asOf as any);
            const payAmt = dueStatus?.totalDue || 0;
            if (payAmt <= 0) { console.log(`  [ALN#1 EMI ${i}] nothing due as of ${asOf.toDateString()}, skipping`); continue; }
            await loanRepayment.recordLoanRepayment({
                mbno: MBNO, loancaseno: aln1, paymentAmount: payAmt,
                narration: `On-time EMI ${i} - consolidation scenario`, username: 'scenario-test',
                asOfDate: asOf,
            } as any);
            console.log(`  [ALN#1 EMI ${i}] paid ₹${payAmt} as of ${asOf.toDateString()}`);
        }

        const aln2 = await applySanctionDisburse('EMERGENCY', 40000, 10, 'A1047', 'ALN #2 (should consolidate into ALN #1)');
        const aln3 = await applySanctionDisburse('EMERGENCY', 20000, 8, 'A1047', 'ALN #3 (should consolidate into the ALN #1+#2 combined case)');

        // ── 2 Regular (RLN) loans, sequential — 2nd must consolidate ──
        const rln1 = await applySanctionDisburse('REGULAR', 100000, 24, 'A1002', 'RLN #1');

        const fiveMonthsAgo = new Date();
        fiveMonthsAgo.setMonth(fiveMonthsAgo.getMonth() - 5);
        await dataSource.query(`UPDATE loan_master SET payment_date = $1 WHERE loancaseno::text = $2`, [fiveMonthsAgo, rln1]);
        console.log(`  [time-travel] RLN #1 (case ${rln1}) backdated to ${fiveMonthsAgo.toDateString()}`);

        for (let i = 1; i <= 3; i++) {
            const asOf = new Date(fiveMonthsAgo);
            asOf.setMonth(asOf.getMonth() + i + 1);
            const dueStatus = await loanRepayment.getDueStatus(rln1, asOf as any);
            const payAmt = dueStatus?.totalDue || 0;
            if (payAmt <= 0) { console.log(`  [RLN#1 EMI ${i}] nothing due as of ${asOf.toDateString()}, skipping`); continue; }
            await loanRepayment.recordLoanRepayment({
                mbno: MBNO, loancaseno: rln1, paymentAmount: payAmt,
                narration: `On-time EMI ${i} - consolidation scenario`, username: 'scenario-test',
                asOfDate: asOf,
            } as any);
            console.log(`  [RLN#1 EMI ${i}] paid ₹${payAmt} as of ${asOf.toDateString()}`);
        }

        const rln2 = await applySanctionDisburse('REGULAR', 50000, 12, 'A1002', 'RLN #2 (should consolidate into RLN #1)');

        // ── Verify end state: exactly 2 active loans for this member ──
        console.log('\n=== FINAL STATE CHECK ===');
        const activeLoans = await dataSource.query(
            `SELECT loancaseno, loantype, loan_amt, balance, consolidated_into_loancaseno FROM loan_master WHERE mbno = $1 ORDER BY loantype, loancaseno`,
            [MBNO]
        );
        console.table(activeLoans);

        const activeOnly = activeLoans.filter((l: any) => parseFloat(l.balance) > 0);
        console.log(`\nActive (balance>0) loans: ${activeOnly.length} (expect 2 — one ALN, one RLN)`);
        const alnActive = activeOnly.filter((l: any) => l.loantype === 'ALN');
        const rlnActive = activeOnly.filter((l: any) => l.loantype === 'RLN');
        console.log(`  ALN active: ${alnActive.length} (expect 1), case(s): ${alnActive.map((l: any) => l.loancaseno).join(', ')}`);
        console.log(`  RLN active: ${rlnActive.length} (expect 1), case(s): ${rlnActive.map((l: any) => l.loancaseno).join(', ')}`);

        const allPass = activeOnly.length === 2 && alnActive.length === 1 && rlnActive.length === 1;
        console.log(allPass ? '\nPASS — exactly one active loan per type, as the consolidation invariant requires' : '\nFAIL — unexpected active loan count');

        console.log(`\nOpen Loan Early Closure or Loan Repayment for member ${MBNO} in the browser now to confirm the UI shows exactly these 2 entries.`);
    } finally {
        await app.close();
    }
}
main().catch((e) => { console.error(e); process.exit(1); });
