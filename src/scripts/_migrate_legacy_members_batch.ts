import { DataSource } from 'typeorm';
import { PassTransactionService } from '../modules/transaction/services-v2/pass-transaction.service';
import { LoanRepaymentService } from '../modules/loan/services-v2/loan-repayment.service';
import { SystemConfigService } from '../modules/admin/services/system-config.service';
import { SystemConfig } from '../modules/admin/entities/system-config.entity';
import { InterestRate } from '../modules/admin/entities/interest-rate.entity';
import { DepositSlab } from '../modules/admin/entities/deposit-slab.entity';
import { LoanEligibilityService } from '../modules/loan/services-v2/loan-eligibility.service';
import { RdRulesService } from '../modules/rd/rd-rules.service';
import { RdBalanceEventsService } from '../modules/rd/services/rd-balance-events.service';

// Migrates five REAL legacy members' active loans into our schema through the
// REAL disbursement pipeline (PassTransactionService.passTransaction), replays
// their REAL recovery history from EMP_Espat_Society_dan.LEDGER, then calls the
// REAL calculateEarlyClosure(). Synthetic mbnos (900000xxx) so no real member
// record is ever touched — same convention as _migrate_610032638_real_test.ts.
//
// Where the legacy loan's frozen EMI does NOT reproduce under our own formula
// (slot-boundary mismatch, or a mid-life restructure that legacy priced by its
// own arithmetic), the legacy frozen values are restored onto loan_master after
// disbursement — see `freeze` on each loan. That is restoring a real legacy
// fact, exactly like correcting payment_date, not inventing a number.

const AppDataSource = new DataSource({
    type: 'postgres', host: 'localhost', port: 5432, database: 'EMP_Espat_Society',
    username: 'postgres', password: 'Test@1212',
    entities: [__dirname + '/../**/*.entity{.ts,.js}'], synchronize: false, logging: false,
});

const CLOSURE_DATE = new Date(2026, 9, 5); // 05-Oct-2026

interface Recovery { d: string; p: number; i: number; note?: string }
interface LoanSpec {
    caseNo: string; type: 'RLN' | 'ALN'; amt: number; n: number; disb: string;
    /** Legacy frozen values to restore if our formula derives something different. */
    freeze?: { delayMonths?: number; monthlyInterest?: number };
    conforming: boolean;
    note?: string;
    recoveries: Recovery[];
}
interface MemberSpec { realMbno: string; mbno: string; name: string; loans: LoanSpec[] }

const mk = (dates: string[], p: number, i: number): Recovery[] => dates.map(d => ({ d, p, i }));

const ONLY = process.env.ONLY_MBNO;
const ALL_MEMBERS: MemberSpec[] = [
    {
        realMbno: '610026821', mbno: '900000821', name: 'K.SHRINIVAS Z',
        loans: [{
            caseNo: '19578', type: 'ALN', amt: 300000, n: 40, disb: '2025-06-27',
            // App would derive Slot 1 (app-date day 27 >= 25) -> delay 1 -> Rs.1,613.
            // Legacy actually billed Rs.1,688 = Slot 2 / delay 2. Restore legacy.
            freeze: { delayMonths: 2, monthlyInterest: 1688 }, conforming: true,
            note: 'Consolidated 27-Jun-2025 (204,643 old balance + 95,357 fresh). Slot boundary restored to legacy.',
            recoveries: [
                { d: '2025-07-08', p: 6000, i: 1650, note: 'old-rate payroll lag' },
                ...mk(['2025-08-14', '2025-09-15', '2025-10-16', '2025-11-13', '2025-12-16',
                    '2026-01-14', '2026-02-12', '2026-03-18', '2026-04-13'], 7500, 1688),
            ],
        }],
    },
    {
        realMbno: '610026861', mbno: '900000861', name: 'SALIM KHAN',
        loans: [{
            caseNo: '20289', type: 'ALN', amt: 300000, n: 10, disb: '2026-02-19',
            conforming: true,
            recoveries: mk(['2026-04-13', '2026-05-12', '2026-06-10', '2026-07-14', '2026-08-11'], 30000, 2250),
        }],
    },
    {
        realMbno: '610026122', mbno: '900000122', name: 'Shatrughan Surendra',
        loans: [
            {
                caseNo: '18234', type: 'RLN', amt: 1000000, n: 48, disb: '2024-04-20', conforming: true,
                recoveries: mk([
                    '2024-06-12', '2024-07-15', '2024-08-17', '2024-09-17', '2024-10-11', '2024-11-14', '2024-12-16',
                    '2025-01-16', '2025-02-13', '2025-03-18', '2025-04-11', '2025-05-08', '2025-06-10',
                    '2025-07-08', '2025-08-14', '2025-09-15', '2025-10-16', '2025-11-13', '2025-12-16',
                    '2026-01-14', '2026-02-12', '2026-03-18', '2026-04-13', '2026-05-12', '2026-06-10',
                    '2026-07-14', '2026-08-11'], 20833, 5521),
            },
            {
                caseNo: '19743', type: 'ALN', amt: 300000, n: 30, disb: '2025-08-30', conforming: true,
                recoveries: mk([
                    '2025-10-16', '2025-11-13', '2025-12-16',
                    '2026-01-14', '2026-02-12', '2026-03-18', '2026-04-13', '2026-05-12', '2026-06-10',
                    '2026-07-14', '2026-08-11'], 10000, 1650),
            },
        ],
    },
    {
        realMbno: '610033146', mbno: '900000146', name: 'ANAND SHUKLA',
        loans: [
            {
                caseNo: '19603', type: 'ALN', amt: 300000, n: 40, disb: '2025-07-07', conforming: true,
                note: 'Consolidated 07-Jul-2025; old ALN balance transferred into the RLN same day.',
                recoveries: [
                    { d: '2025-07-08', p: 7317, i: 1706, note: 'old-rate payroll lag' },
                    ...mk(['2025-08-14', '2025-09-15', '2025-10-16', '2025-11-13', '2025-12-16',
                        '2026-01-14', '2026-02-12', '2026-03-18', '2026-04-13', '2026-05-12',
                        '2026-06-10', '2026-07-14', '2026-08-11'], 7500, 1688),
                ],
            },
            {
                caseNo: '18094', type: 'RLN', amt: 874792, n: 45, disb: '2025-07-07',
                // 950,000 original - 316,672 recovered (incl. the 08-Jul-2025 payment)
                // + 241,464 transferred in from the old ALN = 874,792, re-amortised
                // over 45 at a flat 19,440/month. Legacy billed Rs.6,677 interest,
                // which our formula does not reproduce for this principal/tenure.
                freeze: { monthlyInterest: 6677 }, conforming: false,
                note: 'Restructured: old ALN balance transferred in. Frozen interest does not reproduce under our EMI formula.',
                recoveries: mk(['2025-08-14', '2025-09-15', '2025-10-16', '2025-11-13', '2025-12-16',
                    '2026-01-14', '2026-02-12', '2026-03-18', '2026-04-13', '2026-05-12',
                    '2026-06-10', '2026-07-14', '2026-08-11'], 19440, 6677),
            },
        ],
    },
    {
        realMbno: '610033022', mbno: '900000022', name: 'SRI KANTH RAMARAJU',
        loans: [
            {
                caseNo: '18445', type: 'ALN', amt: 300000, n: 40, disb: '2024-06-28', conforming: true,
                recoveries: [
                    { d: '2024-07-15', p: 6667, i: 1895, note: 'old-rate payroll lag' },
                    ...mk(['2024-08-17', '2024-09-17', '2024-10-11', '2024-11-14', '2024-12-16',
                        '2025-01-16', '2025-02-13', '2025-03-18', '2025-04-11', '2025-05-08', '2025-06-10',
                        '2025-07-08', '2025-08-14', '2025-09-15', '2025-10-16', '2025-11-13', '2025-12-06',
                        '2026-01-08', '2026-02-05', '2026-03-11', '2026-04-13', '2026-05-12', '2026-06-10',
                        '2026-07-14', '2026-08-11'], 7500, 1613),
                ],
            },
            {
                caseNo: '15555', type: 'RLN', amt: 781654, n: 40, disb: '2024-06-28',
                freeze: { monthlyInterest: 6922 }, conforming: false,
                note: 'Restructured: 566,658 old RLN balance + 214,996 transferred in from the old ALN. Frozen interest does not reproduce under our EMI formula.',
                recoveries: [
                    { d: '2024-07-15', p: 16667, i: 5417, note: 'old-rate payroll lag' },
                    ...mk(['2024-08-17', '2024-09-17', '2024-10-11', '2024-11-14', '2024-12-16',
                        '2025-01-16', '2025-02-13', '2025-03-18', '2025-04-11', '2025-05-08', '2025-06-10',
                        '2025-07-08', '2025-08-14', '2025-09-15', '2025-10-16', '2025-11-13', '2025-12-06',
                        '2026-01-08', '2026-02-05', '2026-03-11', '2026-04-13', '2026-05-12', '2026-06-10',
                        '2026-07-14', '2026-08-11'], 19541, 6922),
                ],
            },
        ],
    },
];

const MEMBERS: MemberSpec[] = ONLY ? ALL_MEMBERS.filter(m => m.realMbno === ONLY) : ALL_MEMBERS;

const r2 = (x: number) => Math.round(x * 100) / 100;

async function wipe(m: MemberSpec) {
    for (const t of ['loan_rb_schedule', 'loan_repayment_ledger', 'loan_master', 'loan_pending', 'member_balances', 'ledger']) {
        await AppDataSource.query(`DELETE FROM ${t} WHERE mbno = $1`, [m.mbno]);
    }
    for (const l of m.loans) {
        await AppDataSource.query(`DELETE FROM transactions WHERE receipt_vchr_no = $1`, [`T${l.caseNo}`]);
        await AppDataSource.query(`DELETE FROM vouchers WHERE remarks LIKE $1`, [`%LOAN_CASE:${l.caseNo}|%`]);
    }
    await AppDataSource.query(`DELETE FROM member_master WHERE mbno::text = $1`, [m.mbno]);
}

async function disburse(passSvc: PassTransactionService, m: MemberSpec, l: LoanSpec) {
    const appDate = new Date(l.disb + 'T00:00:00');
    await AppDataSource.query(
        `INSERT INTO loan_pending (loancaseno, mbno, loantype, applied_amt, sanctioned_amt, app_date, sanctioned_date, no_of_instal, purpose, flg_sanctioned, flg_paid)
         VALUES ($1,$2,$3,$4,$4,$5,$5,$6,$7,'Y','N')`,
        [l.caseNo, m.mbno, l.type, l.amt, appDate, l.n, `Migration ${m.realMbno}`]
    );
    const voucherNo = `T${l.caseNo}`;
    const maxId = (await AppDataSource.query(`SELECT COALESCE(MAX(id),0)+1 as n FROM vouchers`))[0].n;
    await AppDataSource.query(
        `INSERT INTO vouchers (id, "voucherNumber", "voucherDate", "voucherType", "totalAmount", description, "memberId", status, remarks, "createdAt")
         VALUES ($1,$2,NOW(),'PAYMENT',$3,'Migration test',$4,'PENDING',$5,NOW())`,
        [maxId, voucherNo, l.amt, m.mbno, `LOAN_CASE:${l.caseNo}|PAY_MODE:CASH`]
    );
    const transNo = (await AppDataSource.query(`SELECT COALESCE(MAX(trans_no),0)+1 as n FROM transactions`))[0].n;
    await AppDataSource.query(
        `INSERT INTO transactions (trans_no, trans_type, trans_date, mbno, trans_amt, receipt_vchr_no, vchr_type, modeofpay, pass_flag, cashier_flag, narration, code, cheq_amt)
         VALUES ($1,'P',NOW(),$2,$3,$4,'LD','C','N','N','Loan Disbursement (migration)',$5,0)`,
        [transNo, m.mbno, l.amt, voucherNo, l.type === 'ALN' ? 'A1047' : 'A1002']
    );
    await passSvc.passTransaction(voucherNo, `migration-${m.realMbno}`);

    // Real disbursement stamps payment_date = now; this is a replay of a past
    // disbursement, so anchor the schedule to the real date.
    await AppDataSource.query(`UPDATE loan_master SET payment_date = $1 WHERE loancaseno::text = $2`, [appDate, l.caseNo]);

    // Restore legacy frozen values our formula does not reproduce.
    if (l.freeze) {
        const mp = r2(l.amt / l.n);
        if (l.freeze.monthlyInterest !== undefined) {
            await AppDataSource.query(
                `UPDATE loan_master SET instal_amt = $1, intt_amount = $2 WHERE loancaseno::text = $3`,
                [r2(mp + l.freeze.monthlyInterest), l.freeze.monthlyInterest, l.caseNo]
            );
        }
        if (l.freeze.delayMonths !== undefined) {
            await AppDataSource.query(`UPDATE loan_master SET delay_months = $1 WHERE loancaseno::text = $2`, [l.freeze.delayMonths, l.caseNo]);
        }
    }
}

async function applyRecoveries(m: MemberSpec, l: LoanSpec) {
    for (const p of l.recoveries) {
        const d = new Date(p.d + 'T00:00:00');
        await AppDataSource.query(`UPDATE loan_master SET balance = balance - $1 WHERE loancaseno::text = $2`, [p.p, l.caseNo]);
        await AppDataSource.query(
            `INSERT INTO loan_repayment_ledger
                (mbno, loancaseno, loantype, payment_date, payment_month, payment_year, payment_amount,
                 principal_amount, interest_amount, penal_amount, months_overdue, receipt_no, narration, posted_by)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,0,0,$10,$11,$12)`,
            [m.mbno, l.caseNo, l.type, d, d.getMonth() + 1, d.getFullYear(), p.p + p.i, p.p, p.i,
                null, `Legacy recovery replay${p.note ? ' (' + p.note + ')' : ''}`, `migration-${m.realMbno}`]
        );
    }
}

async function main() {
    await AppDataSource.initialize();
    const sysConfig = new SystemConfigService(
        AppDataSource.getRepository(SystemConfig), AppDataSource.getRepository(InterestRate), AppDataSource.getRepository(DepositSlab),
    );
    const rdRules = new RdRulesService(AppDataSource);
    const rdBalanceEvents = new RdBalanceEventsService(AppDataSource, rdRules);
    const loanEligibility = new LoanEligibilityService(AppDataSource, rdBalanceEvents, rdRules);
        const repaymentSvc = new LoanRepaymentService(AppDataSource, loanEligibility, rdBalanceEvents);
    const passSvc = new PassTransactionService(AppDataSource, sysConfig, loanEligibility, rdBalanceEvents, repaymentSvc);

    const summary: any[] = [];

    for (const m of MEMBERS) {
        console.log(`\n${'='.repeat(90)}\n${m.realMbno} — ${m.name}  →  synthetic mbno ${m.mbno}\n${'='.repeat(90)}`);
        await wipe(m);
        await AppDataSource.query(
            `INSERT INTO member_master (mbno, prefix, f_name, m_name, l_name, full_name, officeno, isactive, remarks)
             VALUES ($1,'Mr','TEST MIGRATED',$2,$3,$4,1,'Y','Synthetic migration test member')`,
            [m.mbno, m.realMbno, m.name, `TEST MIGRATED ${m.realMbno} ${m.name}`]
        );

        for (const l of m.loans) {
            await disburse(passSvc, m, l);
            await applyRecoveries(m, l);
            const row = (await AppDataSource.query(
                `SELECT loan_amt, balance, no_of_instal, instal_amt, rate, gracedays, penalrate, delay_months, payment_date
                 FROM loan_master WHERE loancaseno::text = $1`, [l.caseNo]
            ))[0];
            console.log(`\n  ${l.type} ${l.caseNo}${l.conforming ? '' : '   *** NON-CONFORMING ***'}`);
            if (l.note) console.log(`    note: ${l.note}`);
            console.log(`    frozen: amt=${row.loan_amt} n=${row.no_of_instal} instal=${row.instal_amt} delay=${row.delay_months} grace=${row.gracedays} penal=${row.penalrate}`);
            console.log(`    balance after ${l.recoveries.length} replayed recoveries: ${row.balance}`);

            const q = await repaymentSvc.calculateEarlyClosure(l.caseNo, CLOSURE_DATE, 0, false);
            console.log(`    closure @05-Oct-2026: outstanding=${q.outstandingPrincipal} NRint=${q.nrInterest} `
                + `AP=${q.apInterest} (${q.futureInstallmentCount} future) closureInt=${q.closureInterest} penal=${q.penalInterest}`);
            console.log(`    >>> FINAL CLOSURE AMOUNT: ${q.finalClosureAmount.toLocaleString('en-IN')}`);
            summary.push({
                member: m.realMbno, mbno: m.mbno, loan: `${l.type} ${l.caseNo}`,
                conforming: l.conforming, final: q.finalClosureAmount,
            });
        }
    }

    console.log(`\n\n${'='.repeat(90)}\nSUMMARY — all closures as at 05-Oct-2026 (applyRdShare=false)\n${'='.repeat(90)}`);
    console.table(summary);
    const byMember: Record<string, number> = {};
    for (const s of summary) byMember[s.member] = (byMember[s.member] || 0) + s.final;
    console.log('\nPer-member totals:');
    for (const [k, v] of Object.entries(byMember)) console.log(`  ${k}: ${v.toLocaleString('en-IN')}`);

    await AppDataSource.destroy();
}
main().catch((e) => { console.error(e); process.exit(1); });
