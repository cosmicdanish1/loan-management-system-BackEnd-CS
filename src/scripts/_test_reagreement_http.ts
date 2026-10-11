// Live HTTP test of the Re-agreement feature against the RUNNING backend (real controllers, JWT guard, response
// envelope, global exception filter). Builds one old loan on test member 900000002 directly in the database
// (22 of 24 EMIs paid), then drives every step over HTTP exactly as the screens do.
//   npx ts-node --transpile-only -r tsconfig-paths/register src/scripts/_test_reagreement_http.ts [--keep]
import { DataSource } from 'typeorm';
import * as fs from 'fs';
import * as path from 'path';
import { PassTransactionService } from '../modules/transaction/services-v2/pass-transaction.service';
import { SystemConfigService } from '../modules/admin/services/system-config.service';
import { SystemConfig } from '../modules/admin/entities/system-config.entity';
import { InterestRate } from '../modules/admin/entities/interest-rate.entity';
import { DepositSlab } from '../modules/admin/entities/deposit-slab.entity';
import { LoanRepaymentService } from '../modules/loan/services-v2/loan-repayment.service';
import { LoanEligibilityService } from '../modules/loan/services-v2/loan-eligibility.service';
import { LoanReagreementService } from '../modules/loan/services-v2/reagreement/loan-reagreement.service';
import { ReagreementDocumentService } from '../modules/loan/services-v2/reagreement/reagreement-document.service';
import { SequenceGeneratorService } from '../modules/shared/services/sequence-generator.service';
import { SequenceMaster } from '../modules/shared/entities/sequence-master.entity';
import { RdRulesService } from '../modules/rd/rd-rules.service';
import { RdBalanceEventsService } from '../modules/rd/services/rd-balance-events.service';

const BASE = 'http://localhost:3001/api/v1';
const MB = '900000002', SURETY = '900000003';
const KEEP = process.argv.includes('--keep');
const ds = new DataSource({ type: 'postgres', host: 'localhost', port: 5432, database: 'EMP_Espat_Society', username: 'postgres', password: 'Test@1212', entities: [__dirname + '/../**/*.entity{.ts,.js}'], synchronize: false, logging: false });
const checks: { label: string; ok: boolean; detail: string }[] = [];
const check = (label: string, ok: boolean, detail = '') => { checks.push({ label, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  -> ' + detail : ''}`); };
const near = (label: string, e: number, a: number, tol = 0.02) => check(label, Math.abs(e - a) <= tol, `expected ${e} actual ${a}`);
let token = '';

async function http(method: string, url: string, body?: any, opts: { raw?: boolean; noAuth?: boolean } = {}): Promise<any> {
    const res = await fetch(`${BASE}${url}`, {
        method, headers: { 'Content-Type': 'application/json', ...(token && !opts.noAuth ? { Authorization: `Bearer ${token}` } : {}), 'X-Request-Id': 'live-test' },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (opts.raw) return res;
    let j: any = null; try { j = await res.json(); } catch { /* none */ }
    return { status: res.status, body: j, data: j && typeof j === 'object' && 'data' in j ? j.data : j };
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
    const rdRules = new RdRulesService(ds), rdEvents = new RdBalanceEventsService(ds, rdRules);
    const elig = new LoanEligibilityService(ds, rdEvents, rdRules), repay = new LoanRepaymentService(ds, elig, rdEvents);
    const seq = new SequenceGeneratorService(ds, ds.getRepository(SequenceMaster));
    const ra = new LoanReagreementService(ds, seq, sysConfig, repay, new ReagreementDocumentService(ds));
    const pass = new PassTransactionService(ds, sysConfig, elig, rdEvents, repay, ra);

    await cleanup();
    const sigRel = fs.readdirSync(path.join(process.cwd(), 'uploads/signatures')).find(f => f.endsWith('.png'));
    const oldSig = (await ds.query(`SELECT signature_image_path FROM member_master WHERE mbno = $1`, [MB]))[0]?.signature_image_path ?? null;
    if (sigRel) await ds.query(`UPDATE member_master SET signature_image_path = $2 WHERE mbno = $1`, [MB, `uploads/signatures/${sigRel}`]);

    // ---- build the old loan (direct DB + real disbursement pass + real repayments) ----
    const OLD = await seq.generateNextLoanCaseNo();
    await ds.query(`INSERT INTO loan_pending (loancaseno, mbno, loantype, applied_amt, sanctioned_amt, app_date, sanctioned_date, no_of_instal, purpose, flg_sanctioned, flg_paid, g1mbno, g2mbno) VALUES ($1,$2,'RLN',300000,300000,'2024-10-01','2024-10-01',60,'live http test','Y','N',$3,0)`, [OLD, MB, SURETY]);
    const dv = 'T' + String(OLD).slice(-5);
    const vid = (await ds.query(`SELECT COALESCE(MAX(id),0)+1 AS n FROM vouchers`))[0].n;
    await ds.query(`INSERT INTO vouchers (id, "voucherNumber", "voucherDate", "voucherType", "totalAmount", description, "memberId", status, remarks, "createdAt") VALUES ($1,$2,NOW(),'PAYMENT',300000,'live test disbursement',$3,'PENDING',$4,NOW())`, [vid, dv, MB, `LOAN_CASE:${OLD}|PAY_MODE:CASH`]);
    const tn = (await ds.query(`SELECT COALESCE(MAX(trans_no),0)+1 AS n FROM transactions`))[0].n;
    await ds.query(`INSERT INTO transactions (trans_no, trans_type, trans_date, mbno, trans_amt, receipt_vchr_no, vchr_type, modeofpay, pass_flag, cashier_flag, narration, code, cheq_amt) VALUES ($1,'P',NOW(),$2,300000,$3,'LD','C','N','N','Loan Disbursement','A1002',0)`, [tn, MB, dv]);
    await pass.passTransaction(dv, 'live');
    await ds.query(`UPDATE loan_master SET payment_date = '2024-10-01' WHERE loancaseno::text = $1 AND mbno = $2`, [OLD, MB]);
    await ds.query(`UPDATE loan_schedule_versions SET effective_date = '2024-10-01', first_due_month = '2024-11-01' WHERE loancaseno = $1 AND mbno = $2`, [String(OLD), MB]);
    for (let i = 0; i < 22; i++) await repay.recordLoanRepayment({ mbno: MB, loancaseno: String(OLD), loantype: 'RLN', paymentAmount: 6575, asOfDate: new Date(2024, 10 + i, 12), username: 'live' } as any);
    console.log(`old loan ${OLD} ready (balance 190000, 2 EMIs unpaid)`);
    if (process.argv.includes('--setup-only')) { console.log('SETUP ONLY: member', MB, 'old case', String(OLD), '(left in place for manual / UI testing; run without flags later to clean up)'); await ds.destroy(); process.exit(0); }

    // ---------------- auth ----------------
    console.log('\n=== A. authentication and guard');
    const noTok = await http('GET', '/loans/reagreement/open', undefined, { noAuth: true });
    check('re-agreement endpoints reject a request without a token (401)', noTok.status === 401);
    const login = await http('POST', '/auth/login', { username: 'admin', password: 'SuperAdmin@2025' }, { noAuth: true });
    token = login.data?.accessToken || login.body?.accessToken || '';
    check('login as admin returns a token', !!token, `status ${login.status}`);

    // ---------------- picker + eligibility ----------------
    console.log('\n=== B. Loan Re-agreement window: loans, eligibility, quote');
    const al = await http('GET', `/loans/reagreement/member/${MB}/loans`);
    check('active loans lists the old case with balance 190000 and no open re-agreement', al.status === 200 && al.data.loans.length === 1 && al.data.loans[0].loanCaseNo === String(OLD) && al.data.loans[0].balance === 190000 && al.data.loans[0].openReagreement === null, JSON.stringify(al.data?.loans));
    check('member name returned', !!al.data.memberName, al.data.memberName);
    const el = await http('GET', `/loans/reagreement/eligibility/${OLD}?mbno=${MB}&loantype=RLN`);
    check('eligibility: eligible, rules returned', el.data.eligible === true && el.data.rules && el.data.rules.maxTenure === 0, JSON.stringify(el.data.rules));
    const elBad = await http('GET', `/loans/reagreement/eligibility/99999999?mbno=${MB}`);
    check('eligibility of an unknown case: not eligible with reason', elBad.data.eligible === false && elBad.data.errors[0].field === 'loan');
    const elNoMb = await http('GET', `/loans/reagreement/eligibility/${OLD}`);
    check('eligibility without mbno is a 400', elNoMb.status === 400);

    const Q = (o: any) => http('POST', '/loans/reagreement/quote', { mbno: MB, loancaseno: String(OLD), loantype: 'RLN', ...o });
    const f = async (label: string, o: any, field: string, code?: string) => { const r = await Q(o); check(label, r.status === 200 && r.data.valid === false && r.data.errors.some((e: any) => e.field === field && (!code || e.code === code)), JSON.stringify(r.data?.errors?.map((e: any) => `${e.field}:${e.code}`))); };
    await f('field check: tenure 0', { newInstallments: 0, newRate: 12 }, 'tenure', 'INVALID');
    await f('field check: tenure 601', { newInstallments: 601, newRate: 12 }, 'tenure', 'ABOVE_MAX');
    await f('field check: tenure 12.5 (not whole)', { newInstallments: 12.5, newRate: 12 }, 'tenure', 'INVALID');
    await f('field check: rate -1', { newInstallments: 60, newRate: -1 }, 'rate', 'INVALID');
    await f('field check: rate 101', { newInstallments: 60, newRate: 101 }, 'rate', 'ABOVE_MAX');
    await f('field check: application date in the future', { newInstallments: 60, newRate: 12, applicationDate: '2999-01-01' }, 'applicationDate', 'FUTURE');
    await f('field check: back-dated application (rule off)', { newInstallments: 60, newRate: 12, applicationDate: '2026-01-01' }, 'applicationDate', 'BACKDATED');
    await f('field check: bad date text', { newInstallments: 60, newRate: 12, applicationDate: 'abc' }, 'applicationDate', 'INVALID');
    await f('field check: unknown loan', { loancaseno: '99999999', newInstallments: 60, newRate: 12 }, 'loan');

    const q = await Q({ newInstallments: 60, newRate: 12 });
    const d = q.data;
    check('quote valid (HTTP 200)', q.status === 200 && d.valid === true, JSON.stringify(d.errors));
    near('quote: principal', 190000, d.position.outstandingPrincipal); near('quote: NR interest', 3150, d.position.nrInterest);
    near('quote: carried AP', 23400, d.position.apInterest);
    check('quote: penalty > 0 and equals collect.penalty', d.position.penaltyDue > 0 && d.position.penaltyDue === d.collect.penalty, String(d.position.penaltyDue));
    near('quote: collect total = NR + penalty', d.position.nrInterest + d.position.penaltyDue, d.collect.total);
    near('quote: old EMI 6575', 6575, d.old.monthlyInstallment); near('quote: old monthly principal 5000', 5000, d.old.monthlyPrincipal); near('quote: old monthly interest 1575', 1575, d.old.monthlyInterest);
    check('quote: old terms (12%, 60, 22 paid)', d.old.rate === 12 && d.old.installments === 60 && d.position.paidInstallments === 22);
    check('quote: slot, delay months and first due month present', d.neu.slot === 2 && d.neu.delayMonths === 2 && /^\d{4}-\d{2}-01$/.test(d.neu.firstDueMonth), `${d.neu.slot} ${d.neu.delayMonths} ${d.neu.firstDueMonth}`);
    near('quote: monthly principal 190000/60', 3166.67, d.neu.monthlyPrincipal); near('quote: EMI = principal + interest', d.neu.monthlyPrincipal + d.neu.monthlyInterest, d.neu.monthlyInstallment);
    near('quote: total payable = EMI x 60', d.neu.monthlyInstallment * 60, d.neu.totalPayable, 0.1);
    check('quote: schedule 60 rows, dues in consecutive months', d.schedule.length === 60 && d.schedule[1].dueMonth > d.schedule[0].dueMonth);
    check('quote: unpaid installments listed (2)', d.position.unpaidInstallments.length === 2);
    const q36 = await Q({ newInstallments: 36, newRate: 9 });
    check('changing tenure/rate changes EMI the right way (36m @9% > 60m @12%)', q36.data.valid && q36.data.neu.monthlyInstallment > d.neu.monthlyInstallment, `${q36.data.neu?.monthlyInstallment} vs ${d.neu.monthlyInstallment}`);
    const qd = await Q({ newInstallments: 60, newRate: 12, applicationDate: new Date().toISOString().slice(0, 10) });
    check('explicit application date today accepted', qd.data.valid === true);

    // ---------------- Business Rules: save, effect, restore ----------------
    console.log('\n=== C. Business Rules limits take effect');
    const rulesBefore = (await http('GET', '/utilities/business-rules')).data;
    check('business rules response carries the RULE_REAGREEMENT_* keys with permissive defaults', rulesBefore.RULE_REAGREEMENT_MAX_TENURE === 0 && rulesBefore.RULE_REAGREEMENT_ALLOW_RATE_INCREASE === true && rulesBefore.RULE_REAGREEMENT_ALLOW_BACKDATE === false, JSON.stringify(Object.keys(rulesBefore).filter(k => k.startsWith('RULE_REAGREEMENT'))));
    const saveRules = (patch: any) => http('POST', '/utilities/business-rules', { ...rulesBefore, ...patch });
    const putTry = await saveRules({ RULE_REAGREEMENT_MAX_TENURE: 48 });
    console.log('business rules save status', putTry.status);
    if (putTry.status === 200 || putTry.status === 201) {
        const r1 = await Q({ newInstallments: 60, newRate: 12 });
        check('max tenure rule 48 blocks tenure 60 with a message', r1.data.valid === false && r1.data.errors.some((e: any) => e.field === 'tenure' && /48/.test(e.message)), JSON.stringify(r1.data.errors));
        await saveRules({ RULE_REAGREEMENT_MAX_TENURE: 0, RULE_REAGREEMENT_ALLOW_RATE_INCREASE: false });
        const r2 = await Q({ newInstallments: 60, newRate: 13 });
        check('"no rate increase" rule blocks 13% (current 12%)', r2.data.valid === false && r2.data.errors.some((e: any) => e.code === 'RATE_INCREASE'));
        await saveRules({ RULE_REAGREEMENT_ALLOW_RATE_INCREASE: true, RULE_REAGREEMENT_MIN_INSTALLMENTS_PAID: 30 });
        const r3 = await Q({ newInstallments: 60, newRate: 12 });
        check('min installments paid 30 blocks (22 paid)', r3.data.valid === false && r3.data.errors.some((e: any) => e.code === 'TOO_EARLY'));
        await saveRules({ RULE_REAGREEMENT_MIN_INSTALLMENTS_PAID: 0, RULE_REAGREEMENT_MIN_OUTSTANDING: 500000 });
        const r4 = await Q({ newInstallments: 60, newRate: 12 });
        check('min outstanding 5,00,000 blocks (190000)', r4.data.valid === false && r4.data.errors.some((e: any) => e.code === 'BELOW_MIN_OUTSTANDING'));
        await saveRules({ RULE_REAGREEMENT_MIN_OUTSTANDING: 0, RULE_REAGREEMENT_MAX_RATE: 10, RULE_REAGREEMENT_MIN_RATE: 5 });
        const r5 = await Q({ newInstallments: 60, newRate: 12 }); const r6 = await Q({ newInstallments: 60, newRate: 4 });
        check('rate bounds 5..10 block 12% and 4%', r5.data.errors.some((e: any) => e.code === 'ABOVE_MAX') && r6.data.errors.some((e: any) => e.code === 'BELOW_MIN'));
        await saveRules({ RULE_REAGREEMENT_MAX_RATE: 0, RULE_REAGREEMENT_MIN_RATE: 0, RULE_REAGREEMENT_ALLOW_BACKDATE: true });
        const r7 = await Q({ newInstallments: 60, newRate: 12, applicationDate: new Date(Date.now() - 3 * 86400000).toISOString().slice(0, 10) });
        check('allow back-dating rule lets a past date through', r7.data.valid === true, JSON.stringify(r7.data.errors));
        await saveRules({ RULE_REAGREEMENT_ALLOW_BACKDATE: false, RULE_REAGREEMENT_MAX_PER_LOAN: 0 });
        const back = (await http('GET', '/utilities/business-rules')).data;
        check('rules restored to permissive defaults', back.RULE_REAGREEMENT_MAX_TENURE === 0 && back.RULE_REAGREEMENT_MIN_OUTSTANDING === 0 && back.RULE_REAGREEMENT_ALLOW_RATE_INCREASE === true && back.RULE_REAGREEMENT_ALLOW_BACKDATE === false && back.RULE_REAGREEMENT_MIN_INSTALLMENTS_PAID === 0 && back.RULE_REAGREEMENT_MAX_RATE === 0);
    } else check('business rules save endpoint reachable', false, JSON.stringify(putTry.body).slice(0, 200));

    // ---------------- apply ----------------
    console.log('\n=== D. apply');
    const ap = await http('POST', '/loans/reagreement/apply', { mbno: MB, loancaseno: String(OLD), loantype: 'RLN', newInstallments: 60, newRate: 12, reason: 'live http test' });
    check('apply returns id, number, new case', ap.status === 201 || ap.status === 200, `${ap.status} ${JSON.stringify(ap.data).slice(0, 120)}`);
    const RID = ap.data.id, NEW = ap.data.newLoanCaseNo;
    check('re-agreement number format RA#####', /^RA\d{5}$/.test(ap.data.reagreementNo), ap.data.reagreementNo);
    const apBad = await http('POST', '/loans/reagreement/apply', { mbno: MB, loancaseno: String(OLD), loantype: 'RLN', newInstallments: 0, newRate: 12 });
    check('apply with invalid tenure is refused with a readable message (400)', apBad.status === 400 && /installments/i.test(apBad.body?.message || ''), `${apBad.status} ${apBad.body?.message}`);
    const apDup = await http('POST', '/loans/reagreement/apply', { mbno: MB, loancaseno: String(OLD), loantype: 'RLN', newInstallments: 36, newRate: 12 });
    check('second apply on the same loan refused (400, already open)', apDup.status === 400 && /already open/.test(apDup.body?.message || ''));
    const al2 = await http('GET', `/loans/reagreement/member/${MB}/loans`);
    check('picker now shows the open re-agreement on the loan', /RA\d+ \(APPLIED\)/.test(al2.data.loans[0].openReagreement || ''), al2.data.loans[0].openReagreement);
    const open = await http('GET', `/loans/reagreement/open?mbno=${MB}`);
    check('open list has it with status APPLIED and member name', open.data.length === 1 && open.data[0].status === 'APPLIED' && !!open.data[0].memberName);
    const one = await http('GET', `/loans/reagreement/${RID}`);
    check('GET :id returns terms, position and collect', one.data.neu.installments === 60 && one.data.old.installments === 60 && one.data.collect.total > 0);
    const byCase = await http('GET', `/loans/reagreement/by-case/${NEW}?mbno=${MB}`);
    check('by-case lookup works', byCase.data?.id === RID);
    const inv = await http('GET', `/loans/reagreement/999999`);
    check('unknown id is a 404', inv.status === 404);

    // draft agreement before sanction
    for (const [fmt, ct, magic] of [['pdf', 'application/pdf', '%PDF'], ['png', 'image/png', '\x89PNG'], ['text', 'text/plain', 'Espat']] as const) {
        const r = await http('GET', `/loans/reagreement/${RID}/draft?format=${fmt}`, undefined, { raw: true }) as Response;
        const buf = Buffer.from(await r.arrayBuffer());
        check(`draft ${fmt}: 200, ${ct}, starts correctly`, r.status === 200 && (r.headers.get('content-type') || '').startsWith(ct) && buf.toString('latin1').includes(magic.replace('\x89', '')), `${r.status} ${r.headers.get('content-type')} ${buf.length}B`);
        if (fmt === 'text') check('draft text is marked DRAFT COPY and names both cases', buf.toString().includes('DRAFT COPY') && buf.toString().includes(String(OLD)) && buf.toString().includes(String(NEW)));
    }
    const noDoc = await http('GET', `/loans/reagreement/${RID}/document?format=pdf`, undefined, { raw: true }) as Response;
    check('saved document does not exist before pass (404)', noDoc.status === 404);

    // early closure guard over HTTP
    const ecOpen = await http('POST', `/loans/early-closure/execute/${OLD}`, { mbno: MB, applyRdShare: false });
    check('early closure of the old loan is refused while the re-agreement is open', ecOpen.status === 400 && /open re-agreement/.test(ecOpen.body?.message || ''), `${ecOpen.status} ${ecOpen.body?.message}`);

    // ---------------- Loan Sanction window ----------------
    console.log('\n=== E. Loan Sanction window');
    const cases = await http('GET', '/loans/cases');
    const cRow = (cases.data || []).find((c: any) => String(c.loanCaseNo) === NEW);
    check('sanction list (/loans/cases) contains it with kind REAGREEMENT, unsanctioned', !!cRow && cRow.applicationKind === 'REAGREEMENT' && cRow.sanctioned === false, JSON.stringify(cRow));
    const nCases = await http('GET', `/loans/member/${MB}/cases`);
    check('Loan Application editor does NOT list the re-agreement case', !(nCases.data || []).some((c: any) => String(c.loanCaseNo) === NEW));
    const det = await http('GET', `/loans/case/${NEW}`);
    check('case details: kind, rate 12, applied amount 190000, member, surety, reagreement block',
        det.data.applicationKind === 'REAGREEMENT' && Number(det.data.rate) === 12 && Number(det.data.appliedAmount) === 190000 && String(det.data.memberNo) === MB && String(det.data.surety1) === SURETY && det.data.reagreement?.id === RID,
        JSON.stringify({ k: det.data.applicationKind, r: det.data.rate, a: det.data.appliedAmount, s: det.data.surety1 }));
    check('case details carry the member name and loan type', !!det.data.memberName && det.data.loanType === 'RLN');
    const qSelf = await http('POST', '/loans/reagreement/quote', { mbno: MB, loancaseno: String(OLD), loantype: 'RLN', newInstallments: 48, newRate: 11, applicationDate: det.data.reagreement.applicationDate, reagreementId: RID });
    check('sanction-window live quote (excluding itself) is valid', qSelf.data.valid === true, JSON.stringify(qSelf.data.errors));
    const qNoSelf = await Q({ newInstallments: 48, newRate: 11 });
    check('same quote WITHOUT excluding itself reports the open re-agreement', qNoSelf.data.valid === false && qNoSelf.data.errors.some((e: any) => e.code === 'OPEN_REAGREEMENT'));
    const sOne = await http('PATCH', `/loans/sanction/${NEW}`, { sanctionedAmount: 1, sanctionDate: new Date().toISOString().slice(0, 10), noOfInstallments: 48, rate: 11, penalRate: 2, installmentAmount: 1, sanctionedBy: 'live-sanctioner' });
    check('sanction with tenure 48 / rate 11 succeeds', sOne.status === 200, `${sOne.status} ${JSON.stringify(sOne.body).slice(0, 100)}`);
    const afterS = await http('GET', `/loans/case/${NEW}`);
    near('sanctioned amount forced to the outstanding principal (not the 1 typed)', 190000, Number(afterS.data.sanctionedAmount));
    check('details now show 48 installments, rate 11', Number(afterS.data.noOfInstallments) === 48 && Number(afterS.data.rate) === 11 && afterS.data.reagreement.status === 'SANCTIONED');
    const sBad = await http('PATCH', `/loans/sanction/${NEW}`, { noOfInstallments: 0, rate: 12 });
    check('sanction with tenure 0 is refused (400)', sBad.status === 400, `${sBad.status} ${sBad.body?.message}`);
    const sTwo = await http('PATCH', `/loans/sanction/${NEW}`, { noOfInstallments: 60, rate: 12, sanctionDate: new Date().toISOString().slice(0, 10), sanctionedBy: 'live-sanctioner' });
    check('re-sanction to 60 / 12% allowed before the voucher', sTwo.status === 200);
    const sanctioned = await http('GET', '/loans/sanctioned');
    const sRow = (sanctioned.data || []).find((c: any) => String(c.loanCaseNo) === NEW);
    check('Loan Payment list (/loans/sanctioned) shows it as REAGREEMENT', !!sRow && sRow.applicationKind === 'REAGREEMENT', JSON.stringify(sRow));
    const logAfterSanction = (await http('GET', `/loans/reagreement/${RID}/log`)).data.map((e: any) => e.event);
    check('log has APPLIED, SANCTIONED, SANCTION_CHANGED', ['APPLIED', 'SANCTIONED', 'SANCTION_CHANGED'].every(e => logAfterSanction.includes(e)), logAfterSanction.join(','));
    const actors = (await http('GET', `/loans/reagreement/${RID}/log`)).data.map((e: any) => e.actor);
    check('log records the real user names (admin for apply, live-sanctioner for sanction)', actors.includes('admin') && actors.includes('live-sanctioner'), actors.join(','));

    // ---------------- Loan Payment window ----------------
    console.log('\n=== F. Loan Payment window');
    const sq = (await http('GET', `/loans/reagreement/${RID}`)).data;
    const v = await http('POST', '/transactions/loan-voucher', { loanCaseNo: NEW, paymentMode: 'CASH', breakdown: [{ code: 'A1002', name: 'LOAN', amount: 190000 }], createdBy: 'live-cashier' });
    const VNO = v.data.voucherNo || v.body.voucherNo;
    check('loan-voucher returns a voucher number', !!VNO, `${v.status} ${VNO}`);
    const lines = await ds.query(`SELECT code, trans_amt, vchr_type, trans_type, pass_flag FROM transactions WHERE receipt_vchr_no = $1 ORDER BY trans_no`, [VNO]);
    near('voucher lines total = NR + penalty from the sanctioned quote', sq.collect.total, lines.reduce((s: number, l: any) => s + parseFloat(l.trans_amt), 0));
    check('lines are RA receipts on I1002, pass_flag N, one for NR and one for penalty', lines.length === 2 && lines.every((l: any) => l.vchr_type === 'RA' && l.trans_type === 'R' && l.code === 'I1002' && l.pass_flag === 'N'));
    const vDup = await http('POST', '/transactions/loan-voucher', { loanCaseNo: NEW, paymentMode: 'CASH' });
    check('a second voucher for the same re-agreement is refused', vDup.status >= 400, `${vDup.status}`);
    const sanctioned2 = await http('GET', '/loans/sanctioned');
    check('re-agreement leaves the Loan Payment list once vouchered', !(sanctioned2.data || []).some((c: any) => String(c.loanCaseNo) === NEW));
    const sCases = await http('GET', '/loans/cases');
    check('and leaves the Sanction list (cannot be re-sanctioned while vouchered)', !(sCases.data || []).some((c: any) => String(c.loanCaseNo) === NEW));
    const sFrozen = await http('PATCH', `/loans/sanction/${NEW}`, { noOfInstallments: 36, rate: 12 });
    check('sanction after voucher is refused with a clear message', sFrozen.status >= 400 && /VOUCHERED/.test(sFrozen.body?.message || ''), `${sFrozen.status} ${sFrozen.body?.message}`);
    const cancelV = await http('POST', `/loans/reagreement/${RID}/cancel`, { reason: 'x' });
    check('cancel is refused from the re-agreement API while a pending voucher exists? (voucher status PENDING -> allowed and removes it)', cancelV.status === 200 || cancelV.status === 201, `${cancelV.status} ${cancelV.body?.message}`);
    // that cancel removed everything: rebuild a fresh re-agreement for the real pass test
    check('cancel removed the pending voucher and the pending case', (await ds.query(`SELECT 1 FROM vouchers WHERE "voucherNumber" = $1`, [VNO])).length === 0 && (await ds.query(`SELECT 1 FROM loan_pending WHERE loancaseno::text = $1`, [NEW])).length === 0);
    const ap2 = await http('POST', '/loans/reagreement/apply', { mbno: MB, loancaseno: String(OLD), loantype: 'RLN', newInstallments: 60, newRate: 12, reason: 'live http test 2' });
    const RID2 = ap2.data.id, NEW2 = ap2.data.newLoanCaseNo;
    await http('PATCH', `/loans/sanction/${NEW2}`, { noOfInstallments: 60, rate: 12, sanctionDate: new Date().toISOString().slice(0, 10), sanctionedBy: 'live-sanctioner' });
    const v2 = await http('POST', '/transactions/loan-voucher', { loanCaseNo: NEW2, paymentMode: 'BANK', bankName: 'A1001', chequeNo: 'CHQ77', chequeDate: new Date().toISOString().slice(0, 10), createdBy: 'live-cashier' });
    const VNO2 = v2.data.voucherNo || v2.body.voucherNo;
    const vh = (await ds.query(`SELECT "chequeNumber", "bankName", "voucherType", remarks FROM vouchers WHERE "voucherNumber" = $1`, [VNO2]))[0];
    check('bank mode: cheque number and bank stored on the voucher (so Pass posts a transfer)', vh.chequeNumber === 'CHQ77' && vh.bankName === 'A1001' && /PAY_MODE:BANK/.test(vh.remarks), JSON.stringify(vh));

    // ---------------- Pass Transactions window ----------------
    console.log('\n=== G. Pass Transactions window');
    const pend = await http('GET', '/transactions/vouchers/pending');
    const pv = (pend.data || []).find((p: any) => p.voucherNo === VNO2);
    check('pending list shows kind REAGREEMENT, type "Loan Re-agreement", loan type RLN, new case', !!pv && pv.kind === 'REAGREEMENT' && pv.vchrType === 'Loan Re-agreement' && pv.loanType === 'RLN' && String(pv.loanCaseNo) === NEW2, JSON.stringify(pv && { k: pv.kind, t: pv.vchrType, l: pv.loanType, c: pv.loanCaseNo }));
    check('pending row has member no/name, amount, narration, breakdown rows as receipts, bank mode', pv.memberNo == MB && !!pv.memberName && pv.amount > 0 && /Re-agreement/.test(pv.narration) && pv.breakdown.length === 2 && pv.breakdown.every((b: any) => b.rp === 'R') && pv.paymentMode === 'bank' && pv.chequeNo === 'CHQ77', JSON.stringify({ a: pv.amount, n: pv.narration, m: pv.paymentMode }));
    check('pending row carries the full re-agreement summary used by the Details dialog', pv.reagreement?.old?.installments === 60 && pv.reagreement?.neu?.monthlyInstallment > 0 && pv.reagreement?.position?.outstandingPrincipal === 190000 && pv.reagreement?.collect?.total > 0 && pv.reagreement?.reagreementNo === ap2.data.reagreementNo);
    // a repayment between voucher and pass changes the figures -> pass must refuse
    await repay.recordLoanRepayment({ mbno: MB, loancaseno: String(OLD), loantype: 'RLN', paymentAmount: 7000, asOfDate: new Date(), username: 'live' } as any);
    const pBlocked = await http('POST', `/transactions/pass/${VNO2}`, { postedBy: 'live-approver' });
    check('pass is REFUSED when the loan changed after the voucher (a repayment was recorded)', pBlocked.status >= 400 && /changed since/.test(pBlocked.body?.message || ''), `${pBlocked.status} ${(pBlocked.body?.message || '').slice(0, 120)}`);
    check('refused pass changed nothing (voucher still pending, new case still absent)', (await ds.query(`SELECT status FROM vouchers WHERE "voucherNumber" = $1`, [VNO2]))[0].status === 'PENDING' && (await ds.query(`SELECT 1 FROM loan_master WHERE loancaseno::text = $1`, [NEW2])).length === 0);
    const rej = await http('DELETE', `/transactions/voucher/${VNO2}`);
    check('reject (delete voucher) works and returns the re-agreement to SANCTIONED', rej.status === 200 && (await http('GET', `/loans/reagreement/${RID2}`)).data.status === 'SANCTIONED');
    const sBack = await http('GET', '/loans/sanctioned');
    check('after reject it is back in the Loan Payment list', (sBack.data || []).some((c: any) => String(c.loanCaseNo) === NEW2));
    // re-sanction (figures refresh) -> voucher again -> pass
    const reS = await http('PATCH', `/loans/sanction/${NEW2}`, { noOfInstallments: 60, rate: 12, sanctionDate: new Date().toISOString().slice(0, 10), sanctionedBy: 'live-sanctioner' });
    check('re-sanction after the change refreshes the figures', reS.status === 200);
    const v3 = await http('POST', '/transactions/loan-voucher', { loanCaseNo: NEW2, paymentMode: 'CASH', createdBy: 'live-cashier' });
    const VNO3 = v3.data.voucherNo || v3.body.voucherNo;
    const sq3 = (await http('GET', `/loans/reagreement/${RID2}`)).data;
    console.log('figures after the 7000 payment:', JSON.stringify({ principal: sq3.position.outstandingPrincipal, nr: sq3.position.nrInterest, pen: sq3.position.penaltyDue, ap: sq3.position.apInterest, emi: sq3.neu.monthlyInstallment }));
    const pOk = await http('POST', `/transactions/pass/${VNO3}`, { postedBy: 'live-approver' });
    check('pass succeeds and returns the re-agreement summary', pOk.status === 201 || pOk.status === 200, `${pOk.status} ${JSON.stringify(pOk.body).slice(0, 160)}`);
    const pr = pOk.data?.reagreement;
    check('summary carries id, numbers, cases, term, EMI, first installment, document flag', !!pr && pr.reagreementId === RID2 && pr.newLoanCaseNo === NEW2 && pr.oldLoanCaseNo === String(OLD) && pr.neu.installments === 60 && pr.neu.monthlyInstallment === sq3.neu.monthlyInstallment && !!pr.neu.firstDueMonth && pr.documentIssued === true, JSON.stringify(pr).slice(0, 200));
    const pAgain = await http('POST', `/transactions/pass/${VNO3}`, {});
    check('passing the same voucher twice is refused', pAgain.status >= 400);

    // ---------------- after pass ----------------
    console.log('\n=== H. after pass: loans, early closure, history, documents');
    const master = await http('GET', `/loans/member/${MB}/master`);
    const mOld = (master.data || []).find((l: any) => String(l.loancaseno) === String(OLD)), mNew = (master.data || []).find((l: any) => String(l.loancaseno) === NEW2);
    check('member master list: old case closed (balance 0, folded into new), new case open', !!mOld && parseFloat(mOld.balance) === 0 && String(mOld.consolidatedIntoLoancaseno) === NEW2 && !!mNew && parseFloat(mNew.balance) > 0, JSON.stringify({ o: mOld?.balance, i: mOld?.consolidatedIntoLoancaseno, n: mNew?.balance }));
    const al3 = await http('GET', `/loans/reagreement/member/${MB}/loans`);
    check('re-agreement picker lists only the new case', al3.data.loans.length === 1 && al3.data.loans[0].loanCaseNo === NEW2);
    const ecOld = await http('POST', `/loans/early-closure/quote/${OLD}`, { mbno: MB, applyRdShare: false });
    check('closure quote of the closed old case is refused / zero (not an active loan)', ecOld.status >= 400 || Number(ecOld.data?.outstandingPrincipal || 0) === 0, `${ecOld.status} ${ecOld.body?.message || ''}`);
    const ecNew = await http('POST', `/loans/early-closure/quote/${NEW2}`, { mbno: MB, applyRdShare: false });
    near('early-closure quote on the new case: principal = sq3 principal', sq3.position.outstandingPrincipal, ecNew.data.outstandingPrincipal);
    check('closure quote reads the new schedule (REAGREEMENT) with the new EMI', ecNew.data.effectiveSchedule?.source === 'REAGREEMENT' && ecNew.data.instalAmt === sq3.neu.monthlyInstallment && ecNew.data.noOfInstal === 60);
    const due = await http('GET', `/loans/due-status/${NEW2}`);
    check('due-status of the new case works (nothing due yet)', due.status === 200, `${due.status}`);
    const emi = await http('GET', `/loans/master/${NEW2}/emi-schedule`);
    check('EMI schedule endpoint answers for the new case', emi.status === 200, `${emi.status}`);
    const chain = await http('GET', `/loans/case/${OLD}/consolidation-chain?mbno=${MB}&loantype=RLN`);
    check('existing consolidation-chain report also shows old -> new', chain.status === 200 && JSON.stringify(chain.data).includes(NEW2), JSON.stringify(chain.data).slice(0, 120));
    const pos = await http('GET', `/loans/position/${MB}/${NEW2}`);
    check('Loan Position endpoint works for the new case', pos.status === 200, `${pos.status}`);

    const hist = await http('GET', `/loans/reagreement/history/${MB}/${OLD}?loantype=RLN`);
    const hr = hist.data.reagreements;
    check('history: 2 cases in order, 2 re-agreements (cancelled #1, passed #2) with documents on the passed one',
        hist.data.cases.map((c: any) => c.caseNo).join('>') === `${OLD}>${NEW2}` && hr.length === 2 && hr.some((r: any) => r.status === 'CANCELLED') && hr.some((r: any) => r.status === 'PASSED' && r.documents.length === 1 && r.documents[0].hasPdf && r.documents[0].hasImage), JSON.stringify(hist.data.cases.map((c: any) => [c.caseNo, c.balance, c.closedIntoCaseNo])));
    const histNew = await http('GET', `/loans/reagreement/history/${MB}/${NEW2}`);
    check('history works when started from the NEW case without loan type', histNew.data.rootCaseNo === String(OLD) && histNew.data.reagreements.length === 2);
    const passed = hr.find((r: any) => r.status === 'PASSED');
    check('passed row: voucher, passed by (live-approver), effective date, first due month, old & new terms',
        passed.voucherNo === VNO3 && passed.passedBy === 'live-approver' && !!passed.effectiveDate && !!passed.firstDueMonth && passed.old.monthlyInstallment === 6575 && passed.neu.monthlyInstallment === sq3.neu.monthlyInstallment, JSON.stringify({ v: passed.voucherNo, b: passed.passedBy, e: passed.effectiveDate }));
    for (const [fmt, ct] of [['pdf', 'application/pdf'], ['png', 'image/png'], ['text', 'text/plain']] as const) {
        const r = await http('GET', `/loans/reagreement/${RID2}/document?format=${fmt}`, undefined, { raw: true }) as Response;
        const buf = Buffer.from(await r.arrayBuffer());
        check(`saved ${fmt}: 200 ${ct} (${buf.length} bytes)`, r.status === 200 && (r.headers.get('content-type') || '').startsWith(ct) && buf.length > 1000);
        if (fmt === 'text') {
            const txt = buf.toString();
            const must = [ap2.data.reagreementNo, String(OLD), NEW2, 'LOAN RE-AGREEMENT', 'Old Agreement', 'New Agreement', '6,575.00', sq3.neu.monthlyInstallment.toLocaleString('en-IN', { minimumFractionDigits: 2 }), 'Espat Karmchari', 'Borrower', 'Surety 1', 'For the Society', VNO3];
            const missing = must.filter(m => !txt.includes(m));
            check('saved text contains every field (numbers, cases, voucher, society, signature blocks)', missing.length === 0, `missing: ${missing.join(' | ')}`);
            check('saved text is the FINAL copy (not a draft)', !txt.includes('DRAFT COPY') && txt.includes('Copy of record'));
        }
        if (fmt === 'png') fs.writeFileSync(path.join(require('os').tmpdir(), 'live_issued.png'), buf);
        if (fmt === 'pdf') fs.writeFileSync(path.join(require('os').tmpdir(), 'live_issued.pdf'), buf);
    }
    const noIssue = await http('GET', `/loans/reagreement/${RID2}/document?format=pdf&issue=9`, undefined, { raw: true }) as Response;
    check('asking for a non-existent copy number is a 404', noIssue.status === 404);
    const lg = (await http('GET', `/loans/reagreement/${RID2}/log`)).data.map((e: any) => e.event);
    check('log shows PASSED, DOCUMENT_ISSUED and the downloads', ['APPLIED', 'SANCTIONED', 'VOUCHER_CREATED', 'VOUCHER_REJECTED', 'PASSED', 'DOCUMENT_ISSUED', 'PDF_DOWNLOADED', 'IMAGE_DOWNLOADED', 'DOCUMENT_VIEWED'].every(e => lg.includes(e)), lg.join(','));
    const ledgerRows = await ds.query(`SELECT code, trans_type, trans_amt, vchr_type FROM ledger WHERE receipt_vchr_no = $1`, [VNO3]);
    const cash = await ds.query(`SELECT rcash, rtransfer FROM tblcashbook WHERE voucher_no = $1`, [VNO3]);
    check('money posted: credits to I1002 vchr_type RA and cashbook receipts tagged with the voucher', ledgerRows.length >= 1 && ledgerRows.every((l: any) => l.code === 'I1002' && l.trans_type === 'CR' && l.vchr_type === 'RA') && cash.length === ledgerRows.length, JSON.stringify(ledgerRows));

    // ---------------- reverse ----------------
    console.log('\n=== I. reverse from the History window');
    const rev = await http('POST', `/transactions/reverse/${VNO3}`, { reversedBy: 'live-approver' });
    check('reverse succeeds', rev.status === 200 || rev.status === 201, `${rev.status} ${rev.body?.message}`);
    const hist2 = await http('GET', `/loans/reagreement/history/${MB}/${OLD}?loantype=RLN`);
    const p2 = hist2.data.reagreements.find((r: any) => r.id === RID2);
    check('after reverse: status VOUCHERED, reversed by/at filled, copy 1 voided', p2.status === 'VOUCHERED' && p2.reversedBy === 'live-approver' && !!p2.reversedAt && p2.documents[0].voided === true, JSON.stringify({ s: p2.status, d: p2.documents }));
    check('after reverse: old case active again, new case gone', (await http('GET', `/loans/reagreement/member/${MB}/loans`)).data.loans[0].loanCaseNo === String(OLD));
    const voided = await http('GET', `/loans/reagreement/${RID2}/document?format=pdf&issue=1`, undefined, { raw: true }) as Response;
    check('the voided copy can still be opened by copy number (history is kept)', voided.status === 200);
    const cur = await http('GET', `/loans/reagreement/${RID2}/document?format=pdf`, undefined, { raw: true }) as Response;
    check('but there is no current copy until it is passed again (404)', cur.status === 404);

    const failed = checks.filter(c => !c.ok);
    console.log(`\n========== ${checks.length - failed.length}/${checks.length} checks passed ==========`);
    failed.forEach(x => console.log('FAILED:', x.label, '|', x.detail));
    if (!KEEP) { await cleanup(); await ds.query(`UPDATE member_master SET signature_image_path = $2 WHERE mbno = $1`, [MB, oldSig]); console.log('test data cleaned up'); }
    await ds.destroy();
    process.exit(failed.length ? 1 : 0);
}
main().catch(async e => { console.error(e); try { await ds.destroy(); } catch { /* ignore */ } process.exit(1); });
