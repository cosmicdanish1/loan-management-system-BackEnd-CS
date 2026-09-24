import { DataSource } from 'typeorm';
import { LoanRepaymentService } from '../modules/loan/services-v2/loan-repayment.service';
import { LoanEligibilityService } from '../modules/loan/services-v2/loan-eligibility.service';
import { RdRulesService } from '../modules/rd/rd-rules.service';
import { RdBalanceEventsService } from '../modules/rd/services/rd-balance-events.service';

// v2 fix: "oldest unpaid installment" is NOT always September -- some loans
// have a tiny pre-existing rounding-drift residual sitting in an EARLIER
// month's installment (e.g. ALN 20327's #3 is August, RLN 15555's #25 is
// August), and one loan (ALN 20289) already has September fully clean with
// only October outstanding. The correct rule is: pay off every unpaid
// installment whose DUE DATE is September 2026 or earlier (clearing any
// stale drift as a side effect, exactly as real money would via the code's
// own oldest-first pooling), and leave anything due October or later
// untouched. All postings rolled back at the end.

const AppDataSource = new DataSource({
    type: 'postgres', host: 'localhost', port: 5432, database: 'EMP_Espat_Society',
    username: 'postgres', password: 'Test@1212',
    entities: [__dirname + '/../**/*.entity{.ts,.js}'], synchronize: false, logging: false,
});

const CLOSE_DATE = new Date(); // today, real system clock
const SEPTEMBER_CUTOFF = new Date(2026, 8, 30); // installments due on/before this count as "September or earlier"

const TARGETS: { member: string; mbno: string; case: string; label: string }[] = [
    { member: '610026861', mbno: '900000861', case: '20289', label: 'ALN 20289' },
    { member: '610026122', mbno: '900000122', case: '18234', label: 'RLN 18234' },
    { member: '610026122', mbno: '900000122', case: '19743', label: 'ALN 19743' },
    { member: '610033146', mbno: '900000146', case: '19603', label: 'ALN 19603' },
    { member: '610033146', mbno: '900000146', case: '18094', label: 'RLN 18094' },
    { member: '610032638', mbno: '900000638', case: '20327', label: 'ALN 20327' },
    { member: '610033022', mbno: '900000022', case: '18445', label: 'ALN 18445' },
    { member: '610033022', mbno: '900000022', case: '15555', label: 'RLN 15555' },
];

async function main() {
    await AppDataSource.initialize();
    const rdRules = new RdRulesService(AppDataSource);
    const rdBal = new RdBalanceEventsService(AppDataSource, rdRules);
    const elig = new LoanEligibilityService(AppDataSource, rdBal, rdRules);
    const svc = new LoanRepaymentService(AppDataSource, elig, rdBal);

    const rollbackInfo: { case: string; principal: number }[] = [];
    const summary: any[] = [];

    for (const t of TARGETS) {
        const before = await svc.calculateEarlyClosure(t.case, CLOSE_DATE, 0, false);
        console.log(`\n===== ${t.member} - ${t.label} =====`);
        console.log(`  BEFORE: outstanding=${before.outstandingPrincipal} closureInt=${before.closureInterest} `
            + `penal=${before.penalInterest} final=${before.finalClosureAmount}`);
        console.log(`  unpaid due dates: ${before.unpaidInstallments.map((u: any) => `#${u.installmentNo}=${u.dueDate}`).join(', ') || '(none)'}`);

        const throughSept = before.unpaidInstallments.filter((u: any) => new Date(u.dueDate) <= SEPTEMBER_CUTOFF);
        if (throughSept.length === 0) {
            console.log('  Nothing due September or earlier is unpaid -- already clean through September. No action.');
            summary.push({ member: t.member, loan: t.label, sept: 'already clean', before: before.finalClosureAmount, after: before.finalClosureAmount });
            continue;
        }

        const payAmount = Math.round(throughSept.reduce((s: number, u: any) => s + u.principalDue + u.interestDue + u.penalDue, 0) * 100) / 100;
        const totalPrincipal = Math.round(throughSept.reduce((s: number, u: any) => s + u.principalDue, 0) * 100) / 100;
        console.log(`  Paying off installment(s) ${throughSept.map((u: any) => `#${u.installmentNo}`).join('+')} (through September): total ${payAmount}`);

        const r = await svc.recordLoanRepayment({
            mbno: t.mbno, loancaseno: t.case, paymentAmount: payAmount,
            receiptNo: 'SEPCHECKTODAY', narration: 'Through-September installments (test)', username: 'sep-check',
            asOfDate: CLOSE_DATE,
        });
        console.log('  recordLoanRepayment:', r.message);
        rollbackInfo.push({ case: t.case, principal: totalPrincipal });

        const after = await svc.calculateEarlyClosure(t.case, CLOSE_DATE, 0, false);
        console.log(`  AFTER:  outstanding=${after.outstandingPrincipal} closureInt=${after.closureInterest} `
            + `penal=${after.penalInterest} final=${after.finalClosureAmount}`);
        console.log(`  remaining unpaid: ${after.unpaidInstallments.map((u: any) => `#${u.installmentNo}=${u.dueDate}`).join(', ') || '(none)'}`);
        summary.push({
            member: t.member, loan: t.label,
            sept: throughSept.map((u: any) => `#${u.installmentNo}`).join('+') + ' paid',
            before: before.finalClosureAmount, after: after.finalClosureAmount,
        });
    }

    console.log('\n\n===== SUMMARY =====');
    console.table(summary);

    console.log('\n===== Rolling back all test postings =====');
    for (const r of rollbackInfo) {
        await AppDataSource.query(`DELETE FROM loan_repayment_ledger WHERE loancaseno::text = $1 AND receipt_no = 'SEPCHECKTODAY'`, [r.case]);
        await AppDataSource.query(`UPDATE loan_master SET balance = balance + $1 WHERE loancaseno::text = $2`, [r.principal, r.case]);
    }
    console.log('Rolled back', rollbackInfo.length, 'postings.');

    await AppDataSource.destroy();
}
main().catch((e) => { console.error(e); process.exit(1); });
