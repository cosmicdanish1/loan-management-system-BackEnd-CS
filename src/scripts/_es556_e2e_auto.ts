import 'dotenv/config';
// ES-556: auto-pass ON passes the held closure by itself when the awaited EMI is recorded; deleting a pending voucher
// cancels the hold; RD / Share are applied at Pass. Usage: <mbno> <loancaseno>
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
const ds = new DataSource({ type: 'postgres', host: 'localhost', port: 5432, database: 'EMP_Espat_Society', username: 'postgres', password: process.env.DB_PASSWORD, entities: [__dirname + '/../**/*.entity{.ts,.js}'], synchronize: false, logging: false });
let pass = 0, fail = 0;
const check = (n: string, ok: boolean, d = '') => { (ok ? pass++ : fail++); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  -> ' + d : ''}`); };
(async () => {
  const [mbno, caseNo] = process.argv.slice(2);
  await ds.initialize();
  const sys = new SystemConfigService(ds.getRepository(SystemConfig), ds.getRepository(InterestRate), ds.getRepository(DepositSlab));
  const rd = new RdRulesService(ds); const ev = new RdBalanceEventsService(ds, rd);
  const elig = new LoanEligibilityService(ds, ev, rd); const repay = new LoanRepaymentService(ds, elig, ev);
  const hold = new LoanEarlyClosureHoldService(ds, new SequenceGeneratorService(ds, ds.getRepository(SequenceMaster)), sys, repay);
  const passSvc = new PassTransactionService(ds, sys, elig, ev, repay, undefined, undefined, hold);
  const bal = async () => parseFloat((await ds.query(`SELECT balance FROM loan_master WHERE loancaseno::text=$1 AND mbno=$2`, [caseNo, mbno]))[0].balance);
  const setAuto = (on: boolean) => ds.query(`INSERT INTO system_configs (key, value, "dataType", "isActive") VALUES ('RULE_EARLY_CLOSURE_AUTO_PASS', $1, 'boolean', true) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, "isActive" = true`, [on ? 'true' : 'false']);
  await hold.ensureTable();
  for (const s of await ds.query(`SELECT voucher_no FROM loan_early_closure_holds WHERE mbno=$1 AND loancaseno=$2 AND status='PENDING' AND created_by='es556-test'`, [mbno, caseNo])) {
    await ds.query(`UPDATE loan_early_closure_holds SET status='CANCELLED' WHERE voucher_no=$1`, [s.voucher_no]);
    await ds.query(`DELETE FROM transactions WHERE receipt_vchr_no=$1`, [s.voucher_no]); await ds.query(`DELETE FROM vouchers WHERE "voucherNumber"=$1`, [s.voucher_no]);
  }
  // A. delete cancels
  const h1 = await hold.create({ mbno, loancaseno: caseNo, nextMonth: true, applyRdShare: false }, 'es556-test');
  const { VoucherService } = await import('../modules/transaction/services-v2/voucher.service');
  const vs: any = new (VoucherService as any)(ds, undefined, undefined, undefined);
  let del = '';
  try { await vs.deleteVoucher(h1.voucherNo); } catch (e: any) { del = e.message; }
  const st = (await ds.query(`SELECT status FROM loan_early_closure_holds WHERE voucher_no=$1`, [h1.voucherNo]))[0]?.status;
  check('deleting the pending voucher cancels the hold', st === 'CANCELLED', `${st} ${del}`);
  check('loan untouched by the cancelled hold', (await bal()) > 0);
  // B. auto-pass on EMI
  await setAuto(true);
  const h2 = await hold.create({ mbno, loancaseno: caseNo, nextMonth: true, applyRdShare: true }, 'es556-test');
  console.log('HOLD', JSON.stringify(h2));
  const emi = (await ds.query(`SELECT instal_amt::float e FROM loan_master WHERE loancaseno::text=$1 AND mbno=$2`, [caseNo, mbno]))[0].e;
  const rdBefore = (await ds.query(`SELECT COALESCE(sum(compulsory_deposit),0)::float rd, COALESCE(sum(shares),0)::float sh FROM member_balances WHERE mbno::text=$1`, [mbno]))[0];
  await repay.recordLoanRepayment({ mbno, loancaseno: caseNo, paymentAmount: emi, username: 'es556-test', narration: 'ES-556 auto test EMI' });
  const status = (await ds.query(`SELECT status FROM loan_early_closure_holds WHERE voucher_no=$1`, [h2.voucherNo]))[0].status;
  check('auto-pass ON: the EMI payment passed the closure by itself', status === 'POSTED', status);
  check('loan balance is zero', (await bal()) === 0);
  const led = await ds.query(`SELECT trans_type, code, trans_amt::float amt FROM ledger WHERE receipt_vchr_no=$1 ORDER BY trans_no`, [h2.voucherNo]);
  console.log('LEDGER', JSON.stringify(led));
  const dr = led.filter((l: any) => l.trans_type === 'DR').reduce((s: number, l: any) => s + l.amt, 0);
  const cr = led.filter((l: any) => l.trans_type === 'CR').reduce((s: number, l: any) => s + l.amt, 0);
  check('ledger balanced', led.length > 0 && Math.abs(dr - cr) < 0.01, `DR ${dr} CR ${cr}`);
  console.log('member RD/share before', JSON.stringify(rdBefore));
  await setAuto(false);
  await ds.destroy();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('ERR', e); process.exit(1); });
