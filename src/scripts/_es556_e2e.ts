import 'dotenv/config';
// ES-556 end-to-end through the REAL services on the test DB:
//   hold (next-month closure) -> Pass refused while the EMI is missing -> EMI arrives -> Pass -> loan closed + GL posted.
// Also covers: duplicate hold refused, delete cancels the hold, auto-pass ON passes by itself on the EMI.
// Usage: npx ts-node --transpile-only src/scripts/_es556_e2e.ts <mbno> <loancaseno>
import { DataSource } from 'typeorm';
import { PassTransactionService } from '../modules/transaction/services-v2/pass-transaction.service';
import { SystemConfigService } from '../modules/admin/services/system-config.service';
import { SystemConfig } from '../modules/admin/entities/system-config.entity';
import { InterestRate } from '../modules/admin/entities/interest-rate.entity';
import { DepositSlab } from '../modules/admin/entities/deposit-slab.entity';
import { SequenceMaster } from '../modules/shared/entities/sequence-master.entity';
import { SequenceGeneratorService } from '../modules/shared/services';
import { LoanRepaymentService } from '../modules/loan/services-v2/loan-repayment.service';
import { LoanEligibilityService } from '../modules/loan/services-v2/loan-eligibility.service';
import { LoanEarlyClosureHoldService } from '../modules/loan/services-v2/early-closure/loan-early-closure-hold.service';
import { RdRulesService } from '../modules/rd/rd-rules.service';
import { RdBalanceEventsService } from '../modules/rd/services/rd-balance-events.service';
import { VoucherService } from '../modules/transaction/services-v2/voucher.service';
import { detectEarlyClosureNotices } from '../modules/loan/services-v2/early-closure/early-closure-notifications';

const ds = new DataSource({
    type: 'postgres', host: 'localhost', port: 5432, database: 'EMP_Espat_Society',
    username: 'postgres', password: process.env.DB_PASSWORD,
    entities: [__dirname + '/../**/*.entity{.ts,.js}'], synchronize: false, logging: false,
});

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = '') => { (ok ? pass++ : fail++); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -> ' + detail : ''}`); };

async function main() {
    const [mbno, caseNo] = process.argv.slice(2);
    if (!mbno || !caseNo) throw new Error('usage: <mbno> <loancaseno>');
    await ds.initialize();
    const sysConfig = new SystemConfigService(ds.getRepository(SystemConfig), ds.getRepository(InterestRate), ds.getRepository(DepositSlab));
    const rdRules = new RdRulesService(ds);
    const rdEvents = new RdBalanceEventsService(ds, rdRules);
    const elig = new LoanEligibilityService(ds, rdEvents, rdRules);
    const repay = new LoanRepaymentService(ds, elig, rdEvents);
    const seq = new SequenceGeneratorService(ds, ds.getRepository(SequenceMaster));
    const hold = new LoanEarlyClosureHoldService(ds, seq, sysConfig, repay);
    const passSvc = new PassTransactionService(ds, sysConfig, elig, rdEvents, repay, undefined, undefined, hold);

    const bal = async () => parseFloat((await ds.query(`SELECT balance FROM loan_master WHERE loancaseno::text=$1 AND mbno=$2`, [caseNo, mbno]))[0].balance);
    const setAuto = async (on: boolean) => {
        await ds.query(`INSERT INTO system_configs (key, value, "dataType", "isActive") VALUES ('RULE_EARLY_CLOSURE_AUTO_PASS', $1, 'boolean', true)
                        ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, "isActive" = true`, [on ? 'true' : 'false']);
    };

    // clean up a PENDING hold left by an earlier aborted run of this script (this script's own rows only)
    await hold.ensureTable();
    const stale = await ds.query(`SELECT voucher_no FROM loan_early_closure_holds WHERE mbno=$1 AND loancaseno=$2 AND status='PENDING' AND created_by='es556-test'`, [mbno, caseNo]);
    for (const s of stale) {
        await ds.query(`UPDATE loan_early_closure_holds SET status='CANCELLED' WHERE voucher_no=$1`, [s.voucher_no]);
        await ds.query(`DELETE FROM transactions WHERE receipt_vchr_no=$1 AND pass_flag='N'`, [s.voucher_no]);
        await ds.query(`DELETE FROM vouchers WHERE "voucherNumber"=$1 AND status='PENDING'`, [s.voucher_no]);
        console.log('cleaned stale pending hold', s.voucher_no);
    }
    const b0 = await bal();
    console.log(`loan ${mbno}/${caseNo} balance ${b0}`);
    await setAuto(false);

    // 1. hold
    const h = await hold.create({ mbno, loancaseno: caseNo, nextMonth: true, applyRdShare: false }, 'es556-test');
    console.log('HOLD', JSON.stringify(h));
    check('hold created with a voucher number', !!h.voucherNo);
    check('loan balance unchanged by the hold', (await bal()) === b0, `${await bal()}`);
    const trows = await ds.query(`SELECT trans_type, code, trans_amt::float amt FROM transactions WHERE receipt_vchr_no=$1 ORDER BY trans_no`, [h.voucherNo]);
    console.log('LINES', JSON.stringify(trows));
    const credits = trows.filter((r: any) => r.trans_type === 'R').reduce((s: number, r: any) => s + r.amt, 0);
    const debit = trows.filter((r: any) => r.trans_type === 'DR').reduce((s: number, r: any) => s + r.amt, 0);
    check('voucher lines balance (credits = cash debit)', Math.abs(credits - debit) < 0.01, `${credits} vs ${debit}`);
    const noLedger = await ds.query(`SELECT count(*)::int n FROM ledger WHERE receipt_vchr_no=$1`, [h.voucherNo]);
    check('nothing in the ledger yet', noLedger[0].n === 0);

    // 2. duplicate hold refused
    let dup = '';
    try { await hold.create({ mbno, loancaseno: caseNo, nextMonth: true, applyRdShare: false }, 'es556-test'); } catch (e: any) { dup = e.message; }
    check('second pending closure on the same loan is refused', /already has a pending/i.test(dup), dup);

    // 3. re-agreement blocked
    const { LoanReagreementService } = await import('../modules/loan/services-v2/reagreement/loan-reagreement.service');
    const ra: any = new (LoanReagreementService as any)(ds, seq, sysConfig, repay, {});
    const elg = await ra.eligibility(mbno, caseNo);
    check('re-agreement is blocked while the closure is pending', elg.errors.some((e: any) => e.code === 'PENDING_EARLY_CLOSURE'), JSON.stringify(elg.errors.map((e: any) => e.code)));

    // 4. Pass before the EMI -> refused
    let early = '';
    try { await passSvc.passTransaction(h.voucherNo, 'es556-test'); } catch (e: any) { early = e.message; }
    check('Pass is refused while the awaited EMI is missing', /not been received/i.test(early), early);
    check('loan still open and hold still pending', (await bal()) === b0 && (await ds.query(`SELECT status FROM loan_early_closure_holds WHERE voucher_no=$1`, [h.voucherNo]))[0].status === 'PENDING');

    // 5. notices while waiting (today is not past the 15th of the expected month, so none expected)
    const n1 = await detectEarlyClosureNotices(ds);
    check('no premature notice while waiting', !n1.some(n => n.dedupe_key.includes(h.voucherNo)), JSON.stringify(n1.filter(n => n.dedupe_key.includes(h.voucherNo)).map(n => n.dedupe_key)));

    // 6. the awaited EMI arrives (auto-pass OFF): loan stays pending, "ready to pass" notice appears
    const loan = (await ds.query(`SELECT instal_amt::float emi FROM loan_master WHERE loancaseno::text=$1 AND mbno=$2`, [caseNo, mbno]))[0];
    const r = await repay.recordLoanRepayment({ mbno, loancaseno: caseNo, paymentAmount: loan.emi, username: 'es556-test', narration: 'ES-556 test EMI' });
    console.log('EMI', r.message);
    const b1 = await bal();
    check('EMI reduced the loan to the quoted expected balance', Math.abs(b1 - (JSON.parse(JSON.stringify((await ds.query(`SELECT plan FROM loan_early_closure_holds WHERE voucher_no=$1`, [h.voucherNo]))[0].plan)).expectedLoanBalance)) < 4.01, `${b1}`);
    check('auto-pass OFF: still pending after the EMI', (await ds.query(`SELECT status FROM loan_early_closure_holds WHERE voucher_no=$1`, [h.voucherNo]))[0].status === 'PENDING');
    const n2 = await detectEarlyClosureNotices(ds);
    check('"ready to pass" notice appears (auto-pass off)', n2.some(n => n.dedupe_key === `ec-ready:${h.voucherNo}`));

    // 7. manual Pass
    const p = await passSvc.passTransaction(h.voucherNo, 'es556-test');
    console.log('PASS', JSON.stringify(p));
    check('Pass succeeded', p.success === true);
    check('loan balance is zero', (await bal()) === 0, `${await bal()}`);
    const hs = (await ds.query(`SELECT status FROM loan_early_closure_holds WHERE voucher_no=$1`, [h.voucherNo]))[0].status;
    check('hold is POSTED', hs === 'POSTED', hs);
    const led = await ds.query(`SELECT trans_type, code, trans_amt::float amt FROM ledger WHERE receipt_vchr_no=$1 ORDER BY trans_no`, [h.voucherNo]);
    console.log('LEDGER', JSON.stringify(led));
    const dr = led.filter((l: any) => l.trans_type === 'DR').reduce((s: number, l: any) => s + l.amt, 0);
    const cr = led.filter((l: any) => l.trans_type === 'CR').reduce((s: number, l: any) => s + l.amt, 0);
    check('ledger DR = CR for the voucher', Math.abs(dr - cr) < 0.01, `DR ${dr} CR ${cr}`);
    const sub = await ds.query(`SELECT COALESCE(sum(principal_amount),0)::float p, COALESCE(sum(interest_amount),0)::float i FROM loan_repayment_ledger WHERE receipt_no=$1`, [h.voucherNo]);
    check('loan sub-ledger carries the closure rows', sub[0].p > 0, JSON.stringify(sub[0]));
    const n3 = await detectEarlyClosureNotices(ds);
    check('notice resolved after Pass', !n3.some(n => n.dedupe_key.includes(h.voucherNo)));
    let again = '';
    try { await passSvc.passTransaction(h.voucherNo, 'es556-test'); } catch (e: any) { again = e.message; }
    check('second Pass of the same voucher is refused', /already posted|not found/i.test(again), again);
    let rev = '';
    try { await passSvc.reverseTransaction(h.voucherNo, 'es556-test'); } catch (e: any) { rev = e.message; }
    check('reversing a posted closure is refused with a clear message', /cannot be reversed/i.test(rev), rev);

    await ds.destroy();
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error('ERR', e); process.exit(1); });
