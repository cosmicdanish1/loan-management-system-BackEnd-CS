import { DataSource } from 'typeorm';
import { LoanRepaymentService } from '../modules/loan/services-v2/loan-repayment.service';
import { LoanEligibilityService } from '../modules/loan/services-v2/loan-eligibility.service';
import { RdRulesService } from '../modules/rd/rd-rules.service';
import { RdBalanceEventsService } from '../modules/rd/services/rd-balance-events.service';

// For each target loan: check its 05-Oct-2026 quote, find the OLDEST unpaid
// installment (the earliest-due one -- always September's, per every case
// checked this session), pay off exactly its remaining principalDue +
// interestDue (nothing else -- October, if separately unpaid, is left
// untouched), then re-quote. All postings are rolled back at the end so the
// loan's persisted state matches only real, actually-migrated history --
// this is a "what if September is paid" calculation, not a permanent edit.

const AppDataSource = new DataSource({
    type: 'postgres', host: 'localhost', port: 5432, database: 'EMP_Espat_Society',
    username: 'postgres', password: 'Test@1212',
    entities: [__dirname + '/../**/*.entity{.ts,.js}'], synchronize: false, logging: false,
});

const CLOSE_DATE = new Date(2026, 9, 5);

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

    const receiptTag = 'SEPCHECK';
    const rollbackInfo: { case: string; principal: number }[] = [];
    const summary: any[] = [];

    for (const t of TARGETS) {
        const before = await svc.calculateEarlyClosure(t.case, CLOSE_DATE, 0, false);
        console.log(`\n===== ${t.member} - ${t.label} =====`);
        console.log(`  BEFORE: outstanding=${before.outstandingPrincipal} closureInt=${before.closureInterest} `
            + `penal=${before.penalInterest} final=${before.finalClosureAmount}  unpaid=${JSON.stringify(before.unpaidInstallments.map((u: any) => u.installmentNo))}`);

        if (before.unpaidInstallments.length === 0) {
            console.log('  No unpaid installments at all as of 05-Oct-2026 -- September (and October) already fully covered by real history. No action needed.');
            summary.push({ member: t.member, loan: t.label, sept: 'already clean', before: before.finalClosureAmount, after: before.finalClosureAmount });
            continue;
        }

        // Oldest unpaid = earliest due = September's installment.
        const sept = before.unpaidInstallments[0];
        const payAmount = Math.round((sept.principalDue + sept.interestDue) * 100) / 100;
        console.log(`  Paying off installment #${sept.installmentNo} (due ${sept.dueDate}): principal ${sept.principalDue} + interest ${sept.interestDue} = ${payAmount}`);

        const r = await svc.recordLoanRepayment({
            mbno: t.mbno, loancaseno: t.case, paymentAmount: payAmount,
            receiptNo: receiptTag, narration: `September installment payment (test)`, username: 'sep-check',
            asOfDate: CLOSE_DATE,
        });
        console.log('  recordLoanRepayment:', r.message);
        rollbackInfo.push({ case: t.case, principal: sept.principalDue });

        const after = await svc.calculateEarlyClosure(t.case, CLOSE_DATE, 0, false);
        console.log(`  AFTER:  outstanding=${after.outstandingPrincipal} closureInt=${after.closureInterest} `
            + `penal=${after.penalInterest} final=${after.finalClosureAmount}  unpaid=${JSON.stringify(after.unpaidInstallments.map((u: any) => u.installmentNo))}`);
        summary.push({ member: t.member, loan: t.label, sept: `#${sept.installmentNo} paid`, before: before.finalClosureAmount, after: after.finalClosureAmount });
    }

    console.log('\n\n===== SUMMARY =====');
    console.table(summary);

    console.log('\n===== Rolling back all test postings =====');
    for (const r of rollbackInfo) {
        await AppDataSource.query(`DELETE FROM loan_repayment_ledger WHERE loancaseno::text = $1 AND receipt_no = $2`, [r.case, 'SEPCHECK']);
        await AppDataSource.query(`UPDATE loan_master SET balance = balance + $1 WHERE loancaseno::text = $2`, [r.principal, r.case]);
    }
    console.log('Rolled back', rollbackInfo.length, 'postings.');

    await AppDataSource.destroy();
}
main().catch((e) => { console.error(e); process.exit(1); });
