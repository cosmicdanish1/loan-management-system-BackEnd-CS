// READ-ONLY early-closure quote for one real (non-test) active loan, using the real
// LoanRepaymentService.calculateEarlyClosure. Nothing is closed or written.
// Usage: npx ts-node --transpile-only src/scripts/_quote_real_loan_closure.ts <mbno> <loancaseno> [yyyy-mm-dd]
import { DataSource } from 'typeorm';
import { LoanRepaymentService } from '../modules/loan/services-v2/loan-repayment.service';
import { LoanEligibilityService } from '../modules/loan/services-v2/loan-eligibility.service';
import { RdRulesService } from '../modules/rd/rd-rules.service';
import { RdBalanceEventsService } from '../modules/rd/services/rd-balance-events.service';

const ds = new DataSource({
    type: 'postgres', host: 'localhost', port: 5432, database: 'EMP_Espat_Society',
    username: 'postgres', password: 'Test@1212',
    entities: [__dirname + '/../**/*.entity{.ts,.js}'], synchronize: false, logging: false,
});

async function main() {
    const [mbno, caseNo, dateArg] = process.argv.slice(2);
    await ds.initialize();
    const rdRules = new RdRulesService(ds);
    const rdEvents = new RdBalanceEventsService(ds, rdRules);
    const svc = new LoanRepaymentService(ds, new LoanEligibilityService(ds, rdEvents, rdRules), rdEvents);
    const asOf = dateArg ? new Date(`${dateArg}T10:00:00+05:30`) : new Date();

    const loan = (await ds.query(
        `SELECT mbno::text mbno, loancaseno, loantype, loan_amt, balance, rate, no_of_instal, instal_amt, intt_amount, delay_months, payment_date
           FROM loan_master WHERE mbno::text = $1 AND loancaseno::text = $2`, [mbno, caseNo]))[0];
    console.log('LOAN', JSON.stringify(loan));
    const hist = await ds.query(
        `SELECT payment_date::date d, principal_amount p, interest_amount i, penal_amount pen, is_payroll_lag_credit lag
           FROM loan_repayment_ledger WHERE mbno::text = $1 AND loancaseno = $2 ORDER BY id`, [mbno, caseNo]);
    console.log('REPAYMENTS', hist.length, 'principal paid', hist.reduce((s: number, r: any) => s + Number(r.p), 0),
        'interest paid', hist.reduce((s: number, r: any) => s + Number(r.i), 0));
    console.log('FIRST/LAST', JSON.stringify(hist[0]), JSON.stringify(hist[hist.length - 1]));
    const quote = await svc.calculateEarlyClosure(caseNo, asOf, 0, true, mbno);
    console.log('QUOTE', JSON.stringify(quote, null, 2));
    await ds.destroy();
}
main().catch((e) => { console.error('ERR', e.message); process.exit(1); });
