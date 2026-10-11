import 'dotenv/config';
// End-to-end test of the Re-agreement feature on a synthetic test member (900000002), driving the REAL
// services in the REAL order: loan -> repayments -> apply -> sanction -> loan payment voucher -> pass ->
// reverse -> re-pass -> cancel / reject paths -> early-closure guard.
//   npx ts-node --transpile-only src/scripts/_test_reagreement_e2e.ts [--keep]
// Test data only (member 900000002 / surety 900000003). Cleans up after itself unless --keep.
import { DataSource } from 'typeorm';
import * as fs from 'fs';
import * as path from 'path';
import { PassTransactionService } from '../modules/transaction/services-v2/pass-transaction.service';
import { VoucherService } from '../modules/transaction/services-v2/voucher.service';
import { SystemConfigService } from '../modules/admin/services/system-config.service';
import { SystemConfig } from '../modules/admin/entities/system-config.entity';
import { InterestRate } from '../modules/admin/entities/interest-rate.entity';
import { DepositSlab } from '../modules/admin/entities/deposit-slab.entity';
import { LoanRepaymentService } from '../modules/loan/services-v2/loan-repayment.service';
import { LoanEligibilityService } from '../modules/loan/services-v2/loan-eligibility.service';
import { LoanSanctionService } from '../modules/loan/services-v2/loan-sanction.service';
import { LoanReagreementService } from '../modules/loan/services-v2/reagreement/loan-reagreement.service';
import { ReagreementDocumentService } from '../modules/loan/services-v2/reagreement/reagreement-document.service';
import { SequenceGeneratorService } from '../modules/shared/services/sequence-generator.service';
import { SequenceMaster } from '../modules/shared/entities/sequence-master.entity';
import { RdRulesService } from '../modules/rd/rd-rules.service';
import { RdBalanceEventsService } from '../modules/rd/services/rd-balance-events.service';
import { calculateConstantEmi } from '../modules/loan/services-v2/loan-rb-schedule.util';

const ds = new DataSource({
    type: 'postgres', host: 'localhost', port: 5432, database: 'EMP_Espat_Society',
    username: 'postgres', password: process.env.DB_PASSWORD, entities: [__dirname + '/../**/*.entity{.ts,.js}'], synchronize: false, logging: false,
});

const MB = '900000002';
const SURETY = '900000003';
const KEEP = process.argv.includes('--keep');
const round2 = (x: number) => Math.round(x * 100) / 100;
const checks: { label: string; ok: boolean; detail: string }[] = [];
function check(label: string, ok: boolean, detail = '') { checks.push({ label, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  -> ' + detail : ''}`); }
function near(label: string, expected: number, actual: number, tol = 0.02) { check(label, Math.abs(expected - actual) <= tol, `expected ${expected} actual ${actual}`); }
async function expectThrow(label: string, fn: () => Promise<any>, contains?: string) {
    try { await fn(); check(label, false, 'did not throw'); } catch (e: any) { check(label, !contains || String(e.message).includes(contains), String(e.message).slice(0, 140)); }
}

async function cleanup() {
    const cases = (await ds.query(`SELECT loancaseno::text AS c FROM loan_master WHERE mbno = $1 UNION SELECT loancaseno::text FROM loan_pending WHERE mbno = $1`, [MB])).map((r: any) => r.c);
    const vouchers = (await ds.query(`SELECT "voucherNumber" AS v FROM vouchers WHERE "memberId" = $1`, [MB])).map((r: any) => r.v);
    await ds.query(`DELETE FROM loan_reagreement_log WHERE reagreement_id IN (SELECT id FROM loan_reagreements WHERE mbno = $1)`, [MB]);
    await ds.query(`DELETE FROM loan_reagreement_documents WHERE reagreement_id IN (SELECT id FROM loan_reagreements WHERE mbno = $1)`, [MB]);
    await ds.query(`DELETE FROM loan_reagreements WHERE mbno = $1`, [MB]);
    if (cases.length) {
        await ds.query(`DELETE FROM loan_nominee WHERE loancaseno::text = ANY($1::text[])`, [cases]);
        await ds.query(`DELETE FROM loan_repayment_ledger WHERE mbno = $1`, [MB]);
        await ds.query(`DELETE FROM loan_rb_schedule WHERE mbno = $1`, [MB]);
        await ds.query(`DELETE FROM loan_schedule_versions WHERE mbno = $1`, [MB]);
        await ds.query(`DELETE FROM loan_master WHERE mbno = $1`, [MB]);
        await ds.query(`DELETE FROM loan_pending WHERE mbno = $1`, [MB]);
    }
    if (vouchers.length) {
        await ds.query(`DELETE FROM ledger WHERE receipt_vchr_no = ANY($1::text[])`, [vouchers]);
        await ds.query(`DELETE FROM tblcashbook WHERE voucher_no = ANY($1::text[])`, [vouchers]);
        await ds.query(`DELETE FROM transactions WHERE receipt_vchr_no = ANY($1::text[])`, [vouchers]);
        await ds.query(`DELETE FROM vouchers WHERE "voucherNumber" = ANY($1::text[])`, [vouchers]);
    }
    await ds.query(`UPDATE member_balances SET regularloan = 0, emergency_loan_balance = 0 WHERE mbno = $1`, [MB]);
}

async function main() {
    await ds.initialize();
    const sysConfig = new SystemConfigService(ds.getRepository(SystemConfig), ds.getRepository(InterestRate), ds.getRepository(DepositSlab));
    const rdRules = new RdRulesService(ds);
    const rdEvents = new RdBalanceEventsService(ds, rdRules);
    const elig = new LoanEligibilityService(ds, rdEvents, rdRules);
    const repay = new LoanRepaymentService(ds, elig, rdEvents);
    const seq = new SequenceGeneratorService(ds, ds.getRepository(SequenceMaster));
    const docs = new ReagreementDocumentService(ds);
    const ra = new LoanReagreementService(ds, seq, sysConfig, repay, docs);
    const sanctionSvc = new LoanSanctionService(ds, ra);
    const voucherSvc = new VoucherService(ds, seq, null as any, ra);
    const pass = new PassTransactionService(ds, sysConfig, elig, rdEvents, repay, ra);

    console.log('--- cleanup of any earlier test data');
    await cleanup();
    const sigRel = fs.readdirSync(path.join(process.cwd(), 'uploads/signatures')).find(f => f.endsWith('.png'));
    const oldSig = (await ds.query(`SELECT signature_image_path FROM member_master WHERE mbno = $1`, [MB]))[0]?.signature_image_path ?? null;
    if (sigRel) await ds.query(`UPDATE member_master SET signature_image_path = $2 WHERE mbno = $1`, [MB, `uploads/signatures/${sigRel}`]);

    // ------------------------------------------------------------------ 1. an old loan, 22 of 24 due installments paid
    console.log('\n=== 1. build the old loan (300000, 60 months, 12%, disbursed 2024-10-01) and 22 repayments');
    const OLD = await seq.generateNextLoanCaseNo();
    await ds.query(
        `INSERT INTO loan_pending (loancaseno, mbno, loantype, applied_amt, sanctioned_amt, app_date, sanctioned_date, no_of_instal, purpose, flg_sanctioned, flg_paid, g1mbno, g2mbno)
         VALUES ($1,$2,'RLN',300000,300000,'2024-10-01','2024-10-01',60,'e2e re-agreement test','Y','N',$3,0)`, [OLD, MB, SURETY]);
    const dv = 'T' + String(OLD).slice(-5);
    const vid = (await ds.query(`SELECT COALESCE(MAX(id),0)+1 AS n FROM vouchers`))[0].n;
    await ds.query(
        `INSERT INTO vouchers (id, "voucherNumber", "voucherDate", "voucherType", "totalAmount", description, "memberId", status, remarks, "createdAt")
         VALUES ($1,$2,NOW(),'PAYMENT',300000,'e2e disbursement',$3,'PENDING',$4,NOW())`, [vid, dv, MB, `LOAN_CASE:${OLD}|PAY_MODE:CASH`]);
    const tn = (await ds.query(`SELECT COALESCE(MAX(trans_no),0)+1 AS n FROM transactions`))[0].n;
    await ds.query(
        `INSERT INTO transactions (trans_no, trans_type, trans_date, mbno, trans_amt, receipt_vchr_no, vchr_type, modeofpay, pass_flag, cashier_flag, narration, code, cheq_amt)
         VALUES ($1,'P',NOW(),$2,300000,$3,'LD','C','N','N','Loan Disbursement','A1002',0)`, [tn, MB, dv]);
    await pass.passTransaction(dv, 'e2e');
    // backdate the loan to 2024-10-01 (first EMI Nov-2024)
    await ds.query(`UPDATE loan_master SET payment_date = '2024-10-01' WHERE loancaseno::text = $1 AND mbno = $2`, [OLD, MB]);
    await ds.query(`UPDATE loan_schedule_versions SET effective_date = '2024-10-01', first_due_month = '2024-11-01' WHERE loancaseno = $1 AND mbno = $2`, [String(OLD), MB]);
    for (let i = 0; i < 22; i++) {
        const d = new Date(2024, 10 + i, 12); // Nov-2024 .. Aug-2026, paid on the 12th
        await repay.recordLoanRepayment({ mbno: MB, loancaseno: String(OLD), loantype: 'RLN', paymentAmount: 6575, asOfDate: d, username: 'e2e' } as any);
    }
    const oldRow = (await ds.query(`SELECT balance, instal_amt, intt_amount FROM loan_master WHERE loancaseno::text = $1 AND mbno = $2`, [OLD, MB]))[0];
    console.log('old loan row', oldRow);
    near('old loan balance after 22 EMIs = 190000', 190000, parseFloat(oldRow.balance));

    // ------------------------------------------------------------------ 2. eligibility + quote (read-only)
    console.log('\n=== 2. eligibility and quote');
    const elg = await ra.eligibility(MB, String(OLD), 'RLN');
    check('eligibility: eligible', elg.eligible, JSON.stringify(elg.errors));
    const bad1 = await ra.buildQuote({ mbno: MB, loancaseno: String(OLD), loantype: 'RLN', newInstallments: 0, newRate: 12 });
    check('quote rejects tenure 0 (field=tenure)', !bad1.valid && bad1.errors.some(e => e.field === 'tenure'), JSON.stringify(bad1.errors));
    const bad2 = await ra.buildQuote({ mbno: MB, loancaseno: String(OLD), loantype: 'RLN', newInstallments: 60, newRate: -3 });
    check('quote rejects negative rate (field=rate)', !bad2.valid && bad2.errors.some(e => e.field === 'rate'));
    const bad3 = await ra.buildQuote({ mbno: MB, loancaseno: String(OLD), loantype: 'RLN', newInstallments: 60, newRate: 12, applicationDate: '2999-01-01' });
    check('quote rejects a future application date', !bad3.valid && bad3.errors.some(e => e.field === 'applicationDate'));
    const bad4 = await ra.buildQuote({ mbno: MB, loancaseno: '99999999', loantype: 'RLN', newInstallments: 60, newRate: 12 });
    check('quote rejects an unknown loan', !bad4.valid && bad4.errors.some(e => e.field === 'loan'));

    const q = await ra.buildQuote({ mbno: MB, loancaseno: String(OLD), loantype: 'RLN', newInstallments: 60, newRate: 12 });
    check('quote valid', q.valid, JSON.stringify(q.errors));
    console.log('quote:', JSON.stringify({ pos: q.position, neu: q.neu, collect: q.collect }, null, 1));
    near('principal = 190000', 190000, q.position!.outstandingPrincipal);
    near('NR interest = 2 x 1575', 3150, q.position!.nrInterest);
    near('carried AP = 23400', 23400, q.position!.apInterest);
    const exp = calculateConstantEmi(190000, 12, 60, new Date(), 1, 2, 'NEAREST', 25, 5, 23400);
    near('new EMI matches the agreed formula (principal/n + (RB + delay + AP)/n)', exp.constantEMI, q.neu!.monthlyInstallment);
    near('schedule has 60 rows, last closing 0', 0, q.schedule[59].closingBalance);
    near('schedule principal sums to 190000', 190000, round2(q.schedule.reduce((s, r) => s + r.principal, 0)), 0.05);

    // ------------------------------------------------------------------ 3. apply -> sanction -> voucher
    console.log('\n=== 3. apply -> sanction -> loan payment voucher');
    const applied = await ra.apply({ mbno: MB, loancaseno: String(OLD), loantype: 'RLN', newInstallments: 60, newRate: 12, reason: 'e2e restructure' }, { actor: 'e2e' });
    const NEW = applied.newLoanCaseNo;
    console.log('applied', applied.reagreementNo, 'new case', NEW);
    const lp = (await ds.query(`SELECT application_kind, flg_sanctioned, flg_paid, applied_amt, rate, g1mbno FROM loan_pending WHERE loancaseno::text = $1`, [NEW]))[0];
    check('new case is a PENDING loan_pending row of kind REAGREEMENT', lp.application_kind === 'REAGREEMENT' && lp.flg_sanctioned === 'N' && lp.flg_paid === 'N', JSON.stringify(lp));
    check('surety carried over', String(lp.g1mbno) === SURETY);
    check('new case is NOT in loan_master yet', (await ds.query(`SELECT 1 FROM loan_master WHERE loancaseno::text = $1`, [NEW])).length === 0);
    await expectThrow('second apply on the same old loan is refused', () => ra.apply({ mbno: MB, loancaseno: String(OLD), loantype: 'RLN', newInstallments: 36, newRate: 12 }, { actor: 'e2e' }), 'already open');
    await expectThrow('early closure of the old loan is blocked while re-agreement is open', () => repay.executeEarlyClosure(String(OLD), new Date(), 0, 'e2e', undefined, false, MB), 'open re-agreement');
    const sanctionedList = await sanctionSvc.getSanctionedLoanCases();
    check('re-agreement NOT in the Loan Payment list before sanction', !sanctionedList.some((x: any) => String(x.loanCaseNo) === NEW));

    // sanction through the SAME service the Sanction window calls (rate + term editable by the sanctioner)
    await sanctionSvc.updateLoanSanction(NEW, { sanctionedAmount: 1, noOfInstallments: 48, rate: 11, sanctionDate: '2026-10-10' }, 'e2e-sanctioner');
    const afterS = await ra.getByNewCase(NEW);
    check('sanction recalculated with tenure 48 / rate 11 and locked principal to 190000',
        afterS!.status === 'SANCTIONED' && afterS!.neu.installments === 48 && afterS!.neu.rate === 11 && Math.abs(afterS!.position.outstandingPrincipal - 190000) < 0.01,
        JSON.stringify({ s: afterS!.status, n: afterS!.neu.installments, r: afterS!.neu.rate, p: afterS!.position.outstandingPrincipal }));
    const lp2 = (await ds.query(`SELECT sanctioned_amt, no_of_instal, rate, flg_sanctioned FROM loan_pending WHERE loancaseno::text = $1`, [NEW]))[0];
    near('loan_pending.sanctioned_amt = outstanding principal (not the 1 sent)', 190000, parseFloat(lp2.sanctioned_amt));
    const sanctionedList2 = await sanctionSvc.getSanctionedLoanCases();
    check('re-agreement now appears in the Loan Payment list (kind REAGREEMENT)', sanctionedList2.some((x: any) => String(x.loanCaseNo) === NEW && x.applicationKind === 'REAGREEMENT'));
    const details = await sanctionSvc.getLoanDetailsByCaseNo(NEW);
    check('case details expose kind / rate / re-agreement', details!.applicationKind === 'REAGREEMENT' && Number(details!.rate) === 11 && !!details!.reagreement);
    // sanction again with the final terms: 60 months, 12%
    await sanctionSvc.updateLoanSanction(NEW, { sanctionedAmount: 190000, noOfInstallments: 60, rate: 12, sanctionDate: '2026-10-10' }, 'e2e-sanctioner');

    // voucher through VoucherService.generateLoanVoucher (what the Loan Payment window calls)
    const vres: any = await voucherSvc.generateLoanVoucher({ loanCaseNo: NEW, paymentMode: 'CASH', breakdown: [{ code: 'A1002', name: 'LOAN', amount: 190000 }], createdBy: 'e2e' });
    const RV = vres.voucherNo;
    console.log('re-agreement voucher', RV);
    const vh = (await ds.query(`SELECT "voucherType", status, remarks, "totalAmount", "sourceModule" FROM vouchers WHERE "voucherNumber" = $1`, [RV]))[0];
    check('voucher is a PENDING RECEIPT tagged REAGREEMENT (not LOAN_CASE)', vh.voucherType === 'RECEIPT' && vh.status === 'PENDING' && /REAGREEMENT:/.test(vh.remarks) && !/LOAN_CASE:/.test(vh.remarks) && vh.sourceModule === 'LOAN_REAGREEMENT', JSON.stringify(vh));
    const vlines = await ds.query(`SELECT code, trans_amt, vchr_type, trans_type, pass_flag FROM transactions WHERE receipt_vchr_no = $1 ORDER BY trans_no`, [RV]);
    console.log('voucher lines', vlines);
    check('voucher lines are Receipts of type RA on I1002, pass_flag N', vlines.length >= 1 && vlines.every((l: any) => l.vchr_type === 'RA' && l.trans_type === 'R' && ['I1002','I1013','I1014'].includes(l.code) && l.pass_flag === 'N'));
    const collectTotal = round2(vlines.reduce((s: number, l: any) => s + parseFloat(l.trans_amt), 0));
    near('voucher total = NR + penalty from the sanctioned quote', afterS!.collect.total >= 0 ? (await ra.getByNewCase(NEW))!.collect.total : 0, collectTotal);
    const pend = await voucherSvc.getPendingVouchers();
    const pv = pend.find((p: any) => p.voucherNo === RV);
    check('Pass list shows it as Loan Re-agreement with the re-agreement summary', !!pv && pv.kind === 'REAGREEMENT' && pv.vchrType === 'Loan Re-agreement' && !!pv.reagreement && String(pv.loanCaseNo) === NEW);
    const sanctionedList3 = await sanctionSvc.getSanctionedLoanCases();
    check('re-agreement leaves the Loan Payment list once vouchered', !sanctionedList3.some((x: any) => String(x.loanCaseNo) === NEW));

    // ------------------------------------------------------------------ 4. draft agreement (watermarked, not stored)
    const draft = await ra.renderDraft(applied.id);
    check('draft agreement renders (text + PDF + PNG)', !!draft.pdf && !!draft.png && draft.text.includes('DRAFT COPY'), `pdf ${draft.pdf?.length} png ${draft.png?.length}`);
    check('draft is not stored', (await ds.query(`SELECT 1 FROM loan_reagreement_documents WHERE reagreement_id = $1`, [applied.id])).length === 0);

    // ------------------------------------------------------------------ 5. PASS
    console.log('\n=== 5. pass transactions');
    const before = { ledger: (await ds.query(`SELECT COUNT(*)::int AS c FROM ledger WHERE receipt_vchr_no = $1`, [RV]))[0].c };
    const passed: any = await pass.passTransaction(RV, 'e2e-approver');
    console.log('pass result', JSON.stringify(passed.reagreement));
    check('pass returned a re-agreement summary', !!passed.reagreement && passed.reagreement.newLoanCaseNo === NEW);
    const newLm = (await ds.query(`SELECT loan_amt, balance, rate, no_of_instal, instal_amt, intt_amount, delay_months, payroll_lag_old_principal, payroll_lag_old_interest, payroll_lag_watch_until, consolidated_into_loancaseno FROM loan_master WHERE loancaseno::text = $1 AND mbno = $2`, [NEW, MB]))[0];
    check('NEW case is ACTIVE in loan_master', !!newLm);
    near('new loan_amt = balance = 190000', 190000, parseFloat(newLm.loan_amt)); near('new balance', 190000, parseFloat(newLm.balance));
    near('new rate 12', 12, parseFloat(newLm.rate)); check('new tenure 60', newLm.no_of_instal === 60);
    near('payroll-lag watch armed with the OLD principal EMI 5000', 5000, parseFloat(newLm.payroll_lag_old_principal));
    near('payroll-lag old interest 1575', 1575, parseFloat(newLm.payroll_lag_old_interest));
    const oldLm = (await ds.query(`SELECT balance, consolidated_into_loancaseno::text AS into_case FROM loan_master WHERE loancaseno::text = $1 AND mbno = $2`, [OLD, MB]))[0];
    check('OLD case closed as re-agreed: balance 0 and linked to new case', parseFloat(oldLm.balance) === 0 && oldLm.into_case === NEW, JSON.stringify(oldLm));
    const ver = (await ds.query(`SELECT version_no, source, source_case_no, reagreement_id, carried_interest, opening_principal, monthly_principal, installment_count, monthly_installment, effective_date::text AS eff, first_due_month::text AS fdm FROM loan_schedule_versions WHERE loancaseno = $1 AND mbno = $2`, [NEW, MB]))[0];
    check('schedule version 1 source REAGREEMENT linked to old case + carries AP', ver.version_no === 1 && ver.source === 'REAGREEMENT' && ver.source_case_no === String(OLD) && Math.abs(parseFloat(ver.carried_interest) - 23400) < 0.01, JSON.stringify(ver));
    check('RB schedule rebuilt: 60 rows', (await ds.query(`SELECT COUNT(*)::int AS c FROM loan_rb_schedule WHERE loancaseno::text = $1 AND mbno = $2`, [NEW, MB]))[0].c === 60);
    const led = await ds.query(`SELECT code, trans_type, trans_amt, acc_no, vchr_type FROM ledger WHERE receipt_vchr_no = $1`, [RV]);
    console.log('ledger rows', led);
    check('only NR/penalty receipts were posted (credits to I1002), no principal movement', led.length === before.ledger + (collectTotal > 0 ? vlines.filter((l: any) => parseFloat(l.trans_amt) > 0).length : 0) && led.every((l: any) => ['I1002','I1013','I1014'].includes(l.code) && l.trans_type === 'CR' && l.vchr_type === 'RA'));
    const oldCl = (await ds.query(`SELECT principal_amount, interest_amount, penal_amount, narration FROM loan_repayment_ledger WHERE loancaseno = $1 AND mbno = $2 AND receipt_no = $3`, [String(OLD), MB, RV]))[0];
    check('closing row on the old case explains the re-agreement', !!oldCl && Math.abs(parseFloat(oldCl.principal_amount) - 190000) < 0.01 && /Re-agreed into loan case/.test(oldCl.narration));
    const raRow = await ra.getByNewCase(NEW);
    check('re-agreement is PASSED with effective date today', raRow!.status === 'PASSED' && !!raRow!.effectiveDate, `${raRow!.status} ${raRow!.effectiveDate}`);
    const doc = (await ds.query(`SELECT issue_no, length(agreement_text) AS tl, length(pdf_bytes) AS pl, length(png_bytes) AS gl, text_sha256, voided_at, signatures_used FROM loan_reagreement_documents WHERE reagreement_id = $1`, [applied.id]))[0];
    console.log('document', doc && { ...doc, signatures_used: undefined });
    check('agreement snapshot saved with text + PDF + PNG', !!doc && doc.tl > 1000 && doc.pl > 5000 && doc.gl > 20000 && doc.voided_at === null);
    check('signature of the borrower was embedded', !!doc && (doc.signatures_used || []).some((s: any) => s.key === 'BORROWER' && s.used));
    const events = (await ra.getLog(applied.id)).map((e: any) => e.event);
    console.log('log events', events);
    check('log has APPLIED, SANCTIONED, SANCTION_CHANGED, VOUCHER_CREATED, PASSED, DOCUMENT_ISSUED', ['APPLIED', 'SANCTIONED', 'SANCTION_CHANGED', 'VOUCHER_CREATED', 'PASSED', 'DOCUMENT_ISSUED'].every(e => events.includes(e)));
    const active = await ra.activeLoans(MB);
    check('member now shows ONE active regular loan (the new case); old case is not listed', active.loans.length === 1 && active.loans[0].loanCaseNo === NEW, JSON.stringify(active.loans));

    // the new loan behaves like any loan: early-closure quote works from the new schedule
    const newClosure = await repay.calculateEarlyClosure(NEW, new Date(), 0, false, MB);
    near('new case closure principal = 190000 (nothing paid yet)', 190000, newClosure.outstandingPrincipal);
    check('new case closure uses schedule source REAGREEMENT', newClosure.effectiveSchedule?.source === 'REAGREEMENT');
    const hist = await ra.history(MB, OLD, 'RLN');
    check('history chain shows both cases and the re-agreement with a document', hist.cases.length === 2 && hist.reagreements.length === 1 && hist.reagreements[0].documents.length === 1, JSON.stringify({ c: hist.cases.map((x: any) => x.caseNo), r: hist.reagreements.length }));
    const hist2 = await ra.history(MB, NEW, 'RLN');
    check('history is the same when started from the NEW case', hist2.rootCaseNo === String(OLD) && hist2.reagreements.length === 1);

    // documents retrieval
    const dPdf = await ra.getIssuedDocument(applied.id, 'pdf', { actor: 'e2e' });
    check('saved PDF is retrievable and starts with %PDF', !!dPdf.bytes && dPdf.bytes.slice(0, 4).toString() === '%PDF');
    const dPng = await ra.getIssuedDocument(applied.id, 'png', { actor: 'e2e' });
    check('saved image is a PNG', !!dPng.bytes && dPng.bytes.slice(1, 4).toString() === 'PNG');
    fs.mkdirSync(path.join(require('os').tmpdir(), 'tmp_reagreement_out'), { recursive: true });
    fs.writeFileSync(path.join(require('os').tmpdir(), 'tmp_reagreement_out', 'issued.pdf'), dPdf.bytes!);
    fs.writeFileSync(path.join(require('os').tmpdir(), 'tmp_reagreement_out', 'issued.png'), dPng.bytes!);
    fs.writeFileSync(path.join(require('os').tmpdir(), 'tmp_reagreement_out', 'issued.txt'), dPdf.text);

    // ------------------------------------------------------------------ 6. reverse, then pass again
    console.log('\n=== 6. reverse and re-pass');
    await pass.reverseTransaction(RV, 'e2e-approver');
    const afterRev = await ra.getByNewCase(NEW);
    check('reverse: re-agreement back to VOUCHERED', afterRev!.status === 'VOUCHERED');
    check('reverse: new case removed from loan_master', (await ds.query(`SELECT 1 FROM loan_master WHERE loancaseno::text = $1 AND mbno = $2`, [NEW, MB])).length === 0);
    const oldBack = (await ds.query(`SELECT balance, consolidated_into_loancaseno FROM loan_master WHERE loancaseno::text = $1 AND mbno = $2`, [OLD, MB]))[0];
    check('reverse: old case active again with its balance', parseFloat(oldBack.balance) === 190000 && oldBack.consolidated_into_loancaseno === null, JSON.stringify(oldBack));
    check('reverse: ledger receipts removed', (await ds.query(`SELECT 1 FROM ledger WHERE receipt_vchr_no = $1`, [RV])).length === 0);
    check('reverse: issued document voided (kept)', (await ds.query(`SELECT 1 FROM loan_reagreement_documents WHERE reagreement_id = $1 AND voided_at IS NOT NULL`, [applied.id])).length === 1);
    await pass.passTransaction(RV, 'e2e-approver');
    const docs2 = await ds.query(`SELECT issue_no, voided_at FROM loan_reagreement_documents WHERE reagreement_id = $1 ORDER BY issue_no`, [applied.id]);
    check('re-pass issued a second document (copy 2); copy 1 stays voided', docs2.length === 2 && docs2[0].voided_at !== null && docs2[1].voided_at === null, JSON.stringify(docs2));
    check('re-pass: new case active again', (await ds.query(`SELECT 1 FROM loan_master WHERE loancaseno::text = $1 AND mbno = $2 AND balance > 0`, [NEW, MB])).length === 1);

    // ------------------------------------------------------------------ 7. reverse refused once repayments exist on the new case
    console.log('\n=== 7. reverse is refused after a repayment on the new case');
    await repay.recordLoanRepayment({ mbno: MB, loancaseno: NEW, loantype: 'RLN', paymentAmount: 1000, asOfDate: new Date(), username: 'e2e' } as any);
    await expectThrow('reverse refused when the new case has repayments', () => pass.reverseTransaction(RV, 'e2e-approver'), 'repayment');
    await ds.query(`DELETE FROM loan_repayment_ledger WHERE mbno = $1 AND loancaseno = $2`, [MB, NEW]); // undo test payment so later steps stay clean
    await ds.query(`UPDATE loan_master SET balance = 190000 WHERE loancaseno::text = $1 AND mbno = $2`, [NEW, MB]);

    // ------------------------------------------------------------------ 8. a SECOND re-agreement of the new case (chain), reject path, cancel path
    console.log('\n=== 8. chained re-agreement, reject and cancel paths');
    const a2 = await ra.apply({ mbno: MB, loancaseno: NEW, loantype: 'RLN', newInstallments: 36, newRate: 10, reason: 'second' }, { actor: 'e2e' });
    check('second re-agreement on the new case is allowed (chain)', a2.status === 'APPLIED');
    await sanctionSvc.updateLoanSanction(a2.newLoanCaseNo, { noOfInstallments: 36, rate: 10 }, 'e2e');
    const v2: any = await voucherSvc.generateLoanVoucher({ loanCaseNo: a2.newLoanCaseNo, paymentMode: 'CASH', createdBy: 'e2e' });
    const zeroLines = await ds.query(`SELECT trans_amt FROM transactions WHERE receipt_vchr_no = $1`, [v2.voucherNo]);
    check('voucher exists even when little/nothing is collected (zero-line marker if needed)', zeroLines.length >= 1);
    await voucherSvc.deleteVoucher(v2.voucherNo); // "reject" at Pass Transactions
    const rejected = await ra.getById(a2.id);
    check('rejecting the voucher sends the re-agreement back to SANCTIONED', rejected.status === 'SANCTIONED' && !rejected.voucherNo, rejected.status);
    const cancelled: any = await ra.cancel(a2.id, 'test cancel', { actor: 'e2e' });
    check('cancel works before pass', cancelled.success === true);
    check('cancel removed the pending case but kept the re-agreement row as CANCELLED',
        (await ds.query(`SELECT 1 FROM loan_pending WHERE loancaseno::text = $1`, [a2.newLoanCaseNo])).length === 0 && (await ra.getById(a2.id)).status === 'CANCELLED');
    const hist3 = await ra.history(MB, NEW, 'RLN');
    check('history lists passed + cancelled attempts', hist3.reagreements.length === 2);
    check('after cancel the NEW case can be re-agreed again (no open one)', (await ra.eligibility(MB, NEW, 'RLN')).eligible);

    // ------------------------------------------------------------------ 9. chained re-agreement passed with nothing to collect, BANK mode
    console.log('\n=== 9. chained re-agreement of the NEW case: nothing to collect, bank mode, passed');
    const a3 = await ra.apply({ mbno: MB, loancaseno: NEW, loantype: 'RLN', newInstallments: 36, newRate: 10, reason: 'chain' }, { actor: 'e2e' });
    const NEW2 = a3.newLoanCaseNo;
    check('chain quote: nothing due, nothing to collect', a3.quote.collect.total === 0, JSON.stringify(a3.quote.collect));
    near('chain carried interest = delay interest 3800 + earlier AP 23400 (within rounding)', 27200, a3.quote.position!.apInterest, 30);
    await sanctionSvc.updateLoanSanction(NEW2, { noOfInstallments: 36, rate: 10 }, 'e2e');
    const v3: any = await voucherSvc.generateLoanVoucher({ loanCaseNo: NEW2, paymentMode: 'BANK', bankName: 'A1001', chequeNo: 'CHQ1', chequeDate: '2026-10-10', createdBy: 'e2e' });
    const vh3 = (await ds.query(`SELECT "totalAmount", "chequeNumber", "bankName" FROM vouchers WHERE "voucherNumber" = $1`, [v3.voucherNo]))[0];
    check('zero-collect voucher has total 0 and carries bank/cheque details', parseFloat(vh3.totalAmount) === 0 && vh3.chequeNumber === 'CHQ1' && vh3.bankName === 'A1001', JSON.stringify(vh3));
    const p3: any = await pass.passTransaction(v3.voucherNo, 'e2e-approver');
    check('zero-collect re-agreement passes', !!p3.reagreement && p3.reagreement.collected === 0);
    check('zero-collect pass posted nothing to the ledger', (await ds.query(`SELECT 1 FROM ledger WHERE receipt_vchr_no = $1`, [v3.voucherNo])).length === 0);
    const lm2 = (await ds.query(`SELECT loan_amt, no_of_instal, rate, payroll_lag_old_principal FROM loan_master WHERE loancaseno::text = $1 AND mbno = $2`, [NEW2, MB]))[0];
    check('chain: third case active (36 months, 10%) with payroll-lag old EMI = previous case EMI 3166.67', !!lm2 && lm2.no_of_instal === 36 && parseFloat(lm2.rate) === 10 && Math.abs(parseFloat(lm2.payroll_lag_old_principal) - 3166.67) < 0.01, JSON.stringify(lm2));
    const into = (await ds.query(`SELECT consolidated_into_loancaseno::text AS c, balance FROM loan_master WHERE loancaseno::text = $1 AND mbno = $2`, [NEW, MB]))[0];
    check('chain: previous case closed into the third', into.c === NEW2 && parseFloat(into.balance) === 0);
    const hist4 = await ra.history(MB, OLD, 'RLN');
    check('history shows 3 cases in order', hist4.cases.map((c: any) => c.caseNo).join('>') === [OLD, NEW, NEW2].join('>'), hist4.cases.map((c: any) => c.caseNo).join('>'));
    check('active loans: exactly one (the third case)', (await ra.activeLoans(MB)).loans.length === 1);

    // ------------------------------------------------------------------ result
    const failed = checks.filter(c => !c.ok);
    console.log(`\n========== ${checks.length - failed.length}/${checks.length} checks passed ==========`);
    failed.forEach(f => console.log('FAILED:', f.label, '|', f.detail));

    if (!KEEP) {
        await cleanup();
        await ds.query(`UPDATE member_master SET signature_image_path = $2 WHERE mbno = $1`, [MB, oldSig]);
        console.log('test data cleaned up');
    }
    await ds.destroy();
    process.exit(failed.length ? 1 : 0);
}
main().catch(async (e) => { console.error(e); try { await ds.destroy(); } catch { /* ignore */ } process.exit(1); });
