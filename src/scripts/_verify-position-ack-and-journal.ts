import 'dotenv/config';
// Live check of (1) "Mark as checked" on a Loan Position notice and (2) a manual journal on a loan head showing up in
// the position. Uses test members only. Leaves a ₹500 journal credit on V5_F2 and one checked notice on V5_F1.
import { DataSource } from 'typeorm';
import { LoanRepaymentService } from '../modules/loan/services-v2/loan-repayment.service';
import { LoanEligibilityService } from '../modules/loan/services-v2/loan-eligibility.service';
import { LoanPositionService } from '../modules/loan/services-v2/loan-position.service';
import { JournalTransferService } from '../modules/transaction/services-v2/journal-transfer.service';
import { RdRulesService } from '../modules/rd/rd-rules.service';
import { RdBalanceEventsService } from '../modules/rd/services/rd-balance-events.service';

const ds = new DataSource({
    type: 'postgres', host: 'localhost', port: 5432, database: 'EMP_Espat_Society',
    username: 'postgres', password: process.env.DB_PASSWORD,
    entities: [__dirname + '/../**/*.entity{.ts,.js}'], synchronize: false, logging: false,
});

async function main() {
    await ds.initialize();
    const rdRules = new RdRulesService(ds);
    const rdEvents = new RdBalanceEventsService(ds, rdRules);
    const repay = new LoanRepaymentService(ds, new LoanEligibilityService(ds, rdEvents, rdRules), rdEvents);
    const pos = new LoanPositionService(ds, repay);
    const journal = new JournalTransferService(ds);
    let failed = 0;
    const check = (label: string, ok: boolean, extra?: any) => { if (!ok) failed++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`, extra ?? ''); };

    // 1) mark as checked
    const f1 = (await ds.query(`SELECT m.mbno::text AS mbno, lm.loancaseno::text AS c FROM member_master m JOIN loan_master lm ON lm.mbno = m.mbno WHERE m.l_name = 'V5_F1' AND lm.balance > 0`))[0];
    const before: any = await pos.getPosition(f1.mbno, f1.c);
    const target = before.notices.find((n: any) => n.code === 'SECOND_OLD_EMI');
    check('notice exists and is not checked yet', !!target && target.acknowledged === false);
    const ack1 = await pos.acknowledge({ mbno: f1.mbno, loancaseno: f1.c, loantype: 'RLN', code: target.code, date: target.date, amount: target.amount, message: target.message, username: 'tester', note: 'verified' });
    const ack2 = await pos.acknowledge({ mbno: f1.mbno, loancaseno: f1.c, loantype: 'RLN', code: target.code, date: target.date, amount: target.amount, username: 'tester' });
    const after: any = await pos.getPosition(f1.mbno, f1.c);
    const t2 = after.notices.find((n: any) => n.code === 'SECOND_OLD_EMI');
    const rowsStored = (await ds.query(`SELECT COUNT(*)::int c FROM loan_payment_flags WHERE source='ACK' AND mbno = $1::numeric AND loancaseno = $2 AND flag_code = 'SECOND_OLD_EMI'`, [f1.mbno, f1.c]))[0].c;
    check('mark as checked saved, repeat is harmless (one row)', ack1.success && ack2.success && rowsStored === 1, { rowsStored });
    check('same notice now shows as checked, other notices untouched', t2?.acknowledged === true && t2?.acknowledgedBy === 'tester'
        && after.notices.filter((n: any) => !n.acknowledged).length === before.notices.length - 1);

    // 2) manual journal on the loan head
    const f2 = (await ds.query(`SELECT m.mbno::text AS mbno, lm.loancaseno::text AS c FROM member_master m JOIN loan_master lm ON lm.mbno = m.mbno WHERE m.l_name = 'V5_F2' AND lm.balance > 0`))[0];
    const p0: any = await pos.getPosition(f2.mbno, f2.c);
    const res = await journal.postJournalEntry({
        transferType: 'headToHead', narration: 'Position test: manual adjustment on loan head',
        rows: [{ mbno: Number(f2.mbno), code: 'A1002', debit: 0, credit: 500, narration: 'Manual adjustment (test)' }, { code: 'A1001', debit: 500, credit: 0, narration: 'Manual adjustment (test)' }],
    } as any, 'tester');
    const led = (await ds.query(`SELECT acc_type, code, trans_type, trans_amt FROM ledger WHERE receipt_vchr_no = $1 AND mbno = $2::numeric`, [res.voucherNo, f2.mbno]))[0];
    const p1: any = await pos.getPosition(f2.mbno, f2.c);
    check('journal row carries the loan account type', led?.acc_type === 'RLN', led);
    check('ledger balance fell by the journal credit', Math.abs((p0.ledger.balance - p1.ledger.balance) - 500) < 0.01, { before: p0.ledger.balance, after: p1.ledger.balance });
    check('journal appears under adjustments', p1.ledger.adjustments.length === p0.ledger.adjustments.length + 1 && p1.ledger.paidByChannel.journal === p0.ledger.paidByChannel.journal + 500, p1.ledger.adjustments.slice(-1));
    check('loan record untouched by the journal', p1.record.balance === p0.record.balance);

    console.log(failed === 0 ? '\nALL CHECKS PASSED' : `\n${failed} CHECK(S) FAILED`);
    await ds.destroy();
    process.exit(failed === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
