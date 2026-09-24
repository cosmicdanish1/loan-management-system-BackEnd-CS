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

// Migrates member 610029276 (Mr. GANESH Z) — the messiest legacy history
// found this session. loan_master/loan_pending claim 8 ALN cases
// (Rs.4,93,665) but real LEDGER money movement only shows 7 disbursements
// (Rs.3,68,540) -- two cases (14881 Rs.77,000, 14882 Rs.70,000, both dated
// 16-Aug-2021) have NO matching transaction anywhere and are treated as
// phantom records. RLN separately shows an undocumented rate change
// (Rs.4,375 -> Rs.3,008/month, 16-Nov-2022) with no loan case, voucher, or
// disbursement behind it at all.
//
// Per the user's explicit decision, this migrates the TRUE CURRENT BALANCE
// (real total disbursed minus real total recovered, from LEDGER) rather than
// attempting to reconstruct the undocumented middle eras. Each loan is
// anchored at the date its CURRENT flat recovery rate actually began (the
// last real rate change with an identifiable date), and replayed forward
// with only the clean, real, flat-rate history from that point — the
// chaotic pre-anchor eras are collapsed into a single opening balance,
// exactly like every other member's "old loan folded into new" balance this
// session, just without a loan_master case number to anchor it to.
//
// Interest is COMBINED in the legacy ledger (I1002, ACC_TYPE=OTH, one row
// covering both RLN and ALN together) — there is no way to recover the true
// historical per-loan split. Both loans' frozen interest is estimated by
// splitting the current combined interest (Rs.3,929) in proportion to each
// loan's own current outstanding balance. This is an explicit approximation,
// documented here and flagged non-conforming on both loans.

const AppDataSource = new DataSource({
    type: 'postgres', host: 'localhost', port: 5432, database: 'EMP_Espat_Society',
    username: 'postgres', password: 'Test@1212',
    entities: [__dirname + '/../**/*.entity{.ts,.js}'], synchronize: false, logging: false,
});

const MBNO = '900029276';
const REAL_MBNO = '610029276';

const r2 = (x: number) => Math.round(x * 100) / 100;

// ---- Interest allocation (proportional to current outstanding balance) ----
const RLN_TRUE_CURRENT = 320992; // 658,636 total ever advanced - 337,644 total ever recovered
const ALN_TRUE_CURRENT = 185656; // 368,540 total ever advanced -  182,884 total ever recovered
const COMBINED_INTEREST = 3929;  // real, currently observed (I1002), combined both loans
const totalBal = RLN_TRUE_CURRENT + ALN_TRUE_CURRENT;
const RLN_INTEREST_SHARE = Math.round(COMBINED_INTEREST * (RLN_TRUE_CURRENT / totalBal));
const ALN_INTEREST_SHARE = COMBINED_INTEREST - RLN_INTEREST_SHARE; // remainder, so they sum exactly

// ---- RLN 18179: anchored 01-May-2024, when the current Rs.4,500/mo rate began ----
const RLN_MONTHLY_PRINCIPAL = 4500;
const RLN_PAID_DATES = [
    '2024-05-14', '2024-06-12', '2024-07-15', '2024-08-17', '2024-09-17', '2024-10-11', '2024-11-14', '2024-12-16',
    '2025-01-16', '2025-02-13', '2025-03-18', '2025-04-11', '2025-05-08', '2025-06-10', '2025-07-08', '2025-08-14',
    '2025-09-15', '2025-10-16', '2025-11-13', '2025-12-16',
    '2026-01-14', '2026-02-12', '2026-03-18', '2026-04-13', '2026-05-12', '2026-06-10', '2026-07-14', '2026-08-11',
];
const RLN_OPENING = RLN_TRUE_CURRENT + RLN_PAID_DATES.length * RLN_MONTHLY_PRINCIPAL; // 446,992
const RLN_N = 100; // 446,992 / 4,500 = 99.33 -> 100 keeps the final residual < one installment (1,492), the correct direction

// ---- ALN 16316: anchored 17-Sep-2024, when the current Rs.2,443/mo rate began ----
const ALN_MONTHLY_PRINCIPAL = 2443;
const ALN_PAID_DATES = [
    '2024-09-17', '2024-10-11', '2024-11-14', '2024-12-16',
    '2025-01-16', '2025-02-13', '2025-03-18', '2025-04-11', '2025-05-08', '2025-06-10', '2025-07-08', '2025-08-14',
    '2025-09-15', '2025-10-16', '2025-11-13', '2025-12-16',
    '2026-01-14', '2026-02-12', '2026-03-18', '2026-04-13', '2026-05-12', '2026-06-10', '2026-07-14', '2026-08-11',
];
const ALN_OPENING = ALN_TRUE_CURRENT + ALN_PAID_DATES.length * ALN_MONTHLY_PRINCIPAL; // 244,288
const ALN_N = 100; // 244,288 / 2,443 = 100.0 -- lands almost exactly clean

interface LoanSpec {
    caseNo: string; type: 'RLN' | 'ALN'; amt: number; n: number; disb: string;
    monthlyPrincipal: number; monthlyInterest: number; paidDates: string[];
}

const LOANS: LoanSpec[] = [
    {
        caseNo: '18179', type: 'RLN', amt: r2(RLN_OPENING), n: RLN_N, disb: '2024-05-01',
        monthlyPrincipal: RLN_MONTHLY_PRINCIPAL, monthlyInterest: RLN_INTEREST_SHARE, paidDates: RLN_PAID_DATES,
    },
    {
        caseNo: '16316', type: 'ALN', amt: r2(ALN_OPENING), n: ALN_N, disb: '2024-09-17',
        monthlyPrincipal: ALN_MONTHLY_PRINCIPAL, monthlyInterest: ALN_INTEREST_SHARE, paidDates: ALN_PAID_DATES,
    },
];

async function wipe() {
    for (const t of ['loan_rb_schedule', 'loan_repayment_ledger', 'loan_master', 'loan_pending', 'member_balances', 'ledger']) {
        await AppDataSource.query(`DELETE FROM ${t} WHERE mbno::text = $1`, [MBNO]);
    }
    for (const l of LOANS) {
        await AppDataSource.query(`DELETE FROM vouchers WHERE "voucherNumber" = $1`, [`T${l.caseNo}`]);
        await AppDataSource.query(`DELETE FROM transactions WHERE receipt_vchr_no = $1`, [`T${l.caseNo}`]);
    }
    await AppDataSource.query(`DELETE FROM member_master WHERE mbno::text = $1`, [MBNO]);
}

async function disburse(passSvc: PassTransactionService, l: LoanSpec) {
    await AppDataSource.query(
        `INSERT INTO loan_pending (loancaseno, mbno, loantype, applied_amt, sanctioned_amt, app_date, sanctioned_date, no_of_instal, purpose, flg_sanctioned, flg_paid)
         VALUES ($1,$2,$3,$4,$4,$5,$5,$6,'Migration 610029276','Y','N')`,
        [l.caseNo, MBNO, l.type, l.amt, new Date(l.disb + 'T00:00:00'), l.n]
    );
    const voucherNo = `T${l.caseNo}`;
    const maxId = (await AppDataSource.query(`SELECT COALESCE(MAX(id),0)+1 as n FROM vouchers`))[0].n;
    await AppDataSource.query(
        `INSERT INTO vouchers (id, "voucherNumber", "voucherDate", "voucherType", "totalAmount", description, "memberId", status, remarks, "createdAt")
         VALUES ($1,$2,NOW(),'PAYMENT',$3,'Migration test',$4,'PENDING',$5,NOW())`,
        [maxId, voucherNo, l.amt, MBNO, `LOAN_CASE:${l.caseNo}|PAY_MODE:CASH`]
    );
    const transNo = (await AppDataSource.query(`SELECT COALESCE(MAX(trans_no),0)+1 as n FROM transactions`))[0].n;
    await AppDataSource.query(
        `INSERT INTO transactions (trans_no, trans_type, trans_date, mbno, trans_amt, receipt_vchr_no, vchr_type, modeofpay, pass_flag, cashier_flag, narration, code, cheq_amt)
         VALUES ($1,'P',NOW(),$2,$3,$4,'LD','C','N','N','Disbursement (migration)',$5,0)`,
        [transNo, MBNO, l.amt, voucherNo, l.type === 'ALN' ? 'A1047' : 'A1002']
    );
    await passSvc.passTransaction(voucherNo, 'migration-610029276');

    const disbDate = new Date(l.disb + 'T00:00:00');
    await AppDataSource.query(`UPDATE loan_master SET payment_date = $1 WHERE loancaseno::text = $2`, [disbDate, l.caseNo]);

    // Freeze the real observed rate — this loan is non-conforming (the
    // combined/estimated interest split, and the undocumented rate history
    // behind it, doesn't reproduce under our own EMI formula).
    const instalAmt = r2(l.monthlyPrincipal + l.monthlyInterest);
    await AppDataSource.query(
        `UPDATE loan_master SET instal_amt = $1, intt_amount = $2 WHERE loancaseno::text = $3`,
        [instalAmt, l.monthlyInterest, l.caseNo]
    );
}

async function applyRecoveries(l: LoanSpec) {
    for (const dateStr of l.paidDates) {
        const d = new Date(dateStr + 'T00:00:00');
        await AppDataSource.query(`UPDATE loan_master SET balance = balance - $1 WHERE loancaseno::text = $2`, [l.monthlyPrincipal, l.caseNo]);
        await AppDataSource.query(
            `INSERT INTO loan_repayment_ledger
                (mbno, loancaseno, loantype, payment_date, payment_month, payment_year, payment_amount,
                 principal_amount, interest_amount, penal_amount, months_overdue, receipt_no, narration, posted_by)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,0,0,NULL,$10,$11)`,
            [MBNO, l.caseNo, l.type, d, d.getMonth() + 1, d.getFullYear(),
                r2(l.monthlyPrincipal + l.monthlyInterest), l.monthlyPrincipal, l.monthlyInterest,
                'Legacy recovery replay (current-era flat rate)', 'migration-610029276']
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

    console.log(`=== Migrating 610029276 (Mr. GANESH Z) -> synthetic mbno ${MBNO} ===`);
    console.log(`RLN interest share: ${RLN_INTEREST_SHARE}, ALN interest share: ${ALN_INTEREST_SHARE} (sum=${RLN_INTEREST_SHARE + ALN_INTEREST_SHARE}, real combined=${COMBINED_INTEREST})\n`);

    await wipe();
    await AppDataSource.query(
        `INSERT INTO member_master (mbno, prefix, f_name, m_name, l_name, full_name, officeno, isactive, remarks)
         VALUES ($1,'Mr','TEST MIGRATED',$2,'GANESH Z',$3,1,'Y','Synthetic migration test member')`,
        [MBNO, REAL_MBNO, `TEST MIGRATED ${REAL_MBNO} GANESH Z`]
    );

    for (const l of LOANS) {
        await disburse(passSvc, l);
        await applyRecoveries(l);
        const row = (await AppDataSource.query(
            `SELECT loan_amt, balance, no_of_instal, instal_amt, delay_months, payment_date FROM loan_master WHERE loancaseno::text = $1`, [l.caseNo]
        ))[0];
        console.log(`  ${l.type} ${l.caseNo}: amt=${row.loan_amt} n=${row.no_of_instal} instal=${row.instal_amt} balance=${row.balance} (expect ${l.type === 'RLN' ? RLN_TRUE_CURRENT : ALN_TRUE_CURRENT})`);

        const q = await repaymentSvc.calculateEarlyClosure(l.caseNo, new Date(2026, 9, 5), 0, false);
        console.log(`    closure@05-Oct-2026: outstanding=${q.outstandingPrincipal} closureInt=${q.closureInterest} penal=${q.penalInterest} suggestedAdj=${q.suggestedAdjustment} FINAL=${q.finalClosureAmount}`);
    }

    await AppDataSource.destroy();
}
main().catch((e) => { console.error(e); process.exit(1); });
