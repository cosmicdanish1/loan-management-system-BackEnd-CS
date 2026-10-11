// Live check of the demand-master rules on a TEST member (V5_F5, case with no payments yet):
//  1. a DEMAND payment for Oct-2025 pays Oct only and leaves Sep unpaid (not pooled onto the oldest EMI),
//  2. Sep then shows the monthly (Tier 2) penalty from its real due month, Oct shows none,
//  3. demand money posted late in its own month (after the grace day) pays no same-month fee,
//  4. a CASH payment still goes oldest-first.
// Leaves its payments on that test member.
import { DataSource } from 'typeorm';
import { LoanRepaymentService } from '../modules/loan/services-v2/loan-repayment.service';
import { LoanEligibilityService } from '../modules/loan/services-v2/loan-eligibility.service';
import { RdRulesService } from '../modules/rd/rd-rules.service';
import { RdBalanceEventsService } from '../modules/rd/services/rd-balance-events.service';

const ds = new DataSource({
    type: 'postgres', host: 'localhost', port: 5432, database: 'EMP_Espat_Society',
    username: 'postgres', password: 'Test@1212', entities: [__dirname + '/../**/*.entity{.ts,.js}'], synchronize: false, logging: false,
});

async function main() {
    await ds.initialize();
    const rdRules = new RdRulesService(ds);
    const rdEvents = new RdBalanceEventsService(ds, rdRules);
    const svc = new LoanRepaymentService(ds, new LoanEligibilityService(ds, rdEvents, rdRules), rdEvents);
    const m = (await ds.query(`SELECT m.mbno::text AS mbno, lm.loancaseno::text AS c FROM member_master m JOIN loan_master lm ON lm.mbno = m.mbno WHERE m.l_name = 'V5_F5' AND lm.balance > 0`))[0];
    let failed = 0;
    const check = (label: string, ok: boolean, extra?: any) => { if (!ok) failed++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`, extra ?? ''); };
    const due = async (d: Date) => (await svc.getDueStatus(m.c, d)) as any;

    // 1) demand money for Oct-2025, posted 28-Oct-2025 (after the grace day, inside its own month)
    const asOf1 = new Date('2025-10-28T10:00:00+05:30');
    const r1: any = await svc.recordLoanRepayment({
        mbno: m.mbno, loancaseno: m.c, loantype: 'RLN', paymentAmount: 10650, asOfDate: asOf1,
        source: 'DEMAND', paymentMonth: 10, paymentYear: 2025, narration: 'Demand master Oct-2025 (test)', username: 'demand-test',
    } as any);
    const rows = await ds.query(`SELECT payment_month pm, payment_year py, principal_amount p, interest_amount i, penal_amount pen, payment_source src FROM loan_repayment_ledger WHERE mbno = $1::numeric AND loancaseno = $2 AND narration LIKE 'Demand master Oct-2025%'`, [m.mbno, m.c]);
    console.log('recorded:', r1.message, JSON.stringify(rows));
    check('demand payment landed on Oct-2025 only, tagged DEMAND, no penalty', rows.length === 1 && rows[0].pm === 10 && rows[0].py === 2025 && rows[0].src === 'DEMAND' && Number(rows[0].pen) === 0 && Number(rows[0].p) === 10000);

    const s1 = await due(new Date('2025-10-29T10:00:00+05:30'));
    const sep = s1.unpaidInstallments?.find((u: any) => String(u.dueDate).startsWith('2025-09'));
    const oct = s1.unpaidInstallments?.find((u: any) => String(u.dueDate).startsWith('2025-10'));
    check('Sep-2025 is still unpaid (not covered by the Oct demand money)', !!sep && Number(sep.principalDue) === 10000, sep && { principalDue: sep.principalDue, monthsOverdue: sep.monthsOverdue, tier: sep.tier, penalDue: sep.penalDue });
    check('Oct-2025 is paid', !oct);
    check('Sep-2025 carries the monthly penalty from its real due month (1 month, 15% -> 125)', sep && sep.tier === 2 && sep.monthsOverdue === 1 && Math.abs(Number(sep.penalDue) - 125) < 0.01);

    // 3) a Nov-2025 demand posting AFTER the grace day of Nov: no same-month fee
    const r2: any = await svc.recordLoanRepayment({
        mbno: m.mbno, loancaseno: m.c, loantype: 'RLN', paymentAmount: 10650, asOfDate: new Date('2025-11-25T10:00:00+05:30'),
        source: 'DEMAND', paymentMonth: 11, paymentYear: 2025, narration: 'Demand master Nov-2025 (test)', username: 'demand-test',
    } as any);
    const nov = (await ds.query(`SELECT principal_amount p, penal_amount pen, payment_month pm FROM loan_repayment_ledger WHERE mbno = $1::numeric AND loancaseno = $2 AND narration LIKE 'Demand master Nov-2025%'`, [m.mbno, m.c]))[0];
    console.log('recorded:', r2.message);
    check('demand money posted on 25-Nov (after grace) paid Nov only with NO same-month fee', nov && nov.pm === 11 && Number(nov.pen) === 0 && Number(nov.p) === 10000, nov);

    // 4) cash still goes oldest-first (Sep)
    const r3: any = await svc.recordLoanRepayment({
        mbno: m.mbno, loancaseno: m.c, loantype: 'RLN', paymentAmount: 10775, asOfDate: new Date('2025-11-26T10:00:00+05:30'),
        narration: 'Cash (test)', username: 'demand-test',
    } as any);
    const cash = await ds.query(`SELECT payment_month pm, principal_amount p, penal_amount pen, payment_source src FROM loan_repayment_ledger WHERE mbno = $1::numeric AND loancaseno = $2 AND narration NOT LIKE 'Demand master%' AND narration LIKE '%Cash (test)%' OR (mbno = $1::numeric AND loancaseno = $2 AND payment_source = 'CASH' AND payment_date = '2025-11-26')`, [m.mbno, m.c]);
    console.log('recorded:', r3.message, JSON.stringify(cash));
    check('cash payment went to the oldest unpaid month (Sep-2025) with its penalty', cash.length >= 1 && cash[0].pm === 9 && cash[0].src === 'CASH' && Number(cash[0].pen) > 0);

    console.log(failed === 0 ? '\nALL CHECKS PASSED' : `\n${failed} CHECK(S) FAILED`);
    await ds.destroy();
    process.exit(failed === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
