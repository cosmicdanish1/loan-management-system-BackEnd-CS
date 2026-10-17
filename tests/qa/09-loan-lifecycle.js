// Loan lifecycle write-flow on QA data only: application -> sanction -> disbursement voucher -> pass -> repayments -> early closure.
// Verifies money invariants against the database after every step. Env: QA_USER / QA_PASS.
const { http, login, Suite } = require('./lib');
const { Client } = require('pg');
require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });

const mem = (tag) => ({ prefix: 'MR', f_name: 'QATEST', m_name: '', l_name: tag + Date.now().toString().slice(-6), sex: 'M', desig: 'CLERK', present_address: 'QA', permanent_address: 'QA', wingno: '1', officeno: 1, age: '30', dob: '1995-05-05', dor: '2035-05-05', gross_salary: 30000, basic_pay: 20000, nominee_name: 'QA', nominee_address: 'X', nominee_relation: 'X', declare_date: '2026-10-16', memb_date: '2026-10-16', flg_incometax: 'N', flg_insured: 'N', insureamt: 0, remarks: 'QA', dept_name: 'QA', isactive: 'Y', flg_retire: 'N', phoneno: '9000000007', fathers_name: 'QA', compulsory_deposit: 0, share_amount: 0, cast_category: '' });

(async () => {
  const s = new Suite('09-loan-lifecycle');
  const { token } = await login();
  const call = (m, u, b) => http(m, u, { token, body: b });
  const pg = new Client({ host: process.env.DB_HOST, port: process.env.DB_PORT, user: process.env.DB_USERNAME, password: process.env.DB_PASSWORD, database: process.env.DB_DATABASE });
  await pg.connect();
  const q = async (sql, p) => (await pg.query(sql, p)).rows;

  const A = (await call('POST', '/members/save-member', mem('LA'))).json.data.mbno;
  const B = (await call('POST', '/members/save-member', mem('LB'))).json.data.mbno;
  s.check('LF-00', 'Two QA members created', !!A && !!B, `${A} ${B}`);
  const app = (o = {}) => ({ memberNo: A, loanType: 'RLN', loanAmount: 50000, noOfInstallments: 24, reason: 'QA test', applDate: '2026-10-16', ...o });

  // ---- application validation
  for (const [id, t, body] of [
    ['LF-01', 'amount 0', app({ loanAmount: 0 })], ['LF-02', 'negative amount', app({ loanAmount: -5000 })], ['LF-03', 'text amount', app({ loanAmount: 'abc' })],
    ['LF-04', 'unknown member', app({ memberNo: '1999999999' })], ['LF-05', 'installments 0', app({ noOfInstallments: 0 })],
    ['LF-06', 'installments -5', app({ noOfInstallments: -5 })], ['LF-07', 'installments 100000', app({ noOfInstallments: 100000 })],
    ['LF-08', 'member as own surety', app({ surety1: A })], ['LF-09', 'surety that does not exist', app({ surety1: '1999999998' })],
    ['LF-10', 'unknown loan type "ZZZ"', app({ loanType: 'ZZZ' })], ['LF-11', 'application date 2099', app({ applDate: '2099-01-01' })],
    ['LF-12', 'amount above the member limit (1e10)', app({ loanAmount: 1e10 })],
  ]) {
    const r = await call('POST', '/loans/loan-application', body);
    const no = r.json && r.json.data && r.json.data.loanCaseNo;
    s.check(id, `Loan application with ${t}: rejected 4xx (${no ? 'ACCEPTED case ' + no : 'ok'})`, r.status >= 400 && r.status < 500, `${r.status} ${(r.text || '').slice(0, 110)}`);
  }

  // ---- valid application
  const r1 = await call('POST', '/loans/loan-application', app());
  const caseNo = r1.json && r1.json.data && r1.json.data.loanCaseNo;
  s.check('LF-13', 'Valid application saved with a case number', [200, 201].includes(r1.status) && !!caseNo, `${r1.status} ${(r1.text || '').slice(0, 100)}`);
  if (!caseNo) process.exit(s.finish() ? 1 : 0);
  const dbp = (await q('select mbno, applied_amt, flg_sanctioned, flg_paid from loan_pending where loancaseno::text=$1', [String(caseNo)]))[0];
  s.check('LF-14', 'loan_pending row matches input (member, amount 50000, not sanctioned)', dbp && String(dbp.mbno) === String(A) && Number(dbp.applied_amt) === 50000 && dbp.flg_sanctioned !== 'Y', JSON.stringify(dbp));

  // another member must NOT be able to overwrite this case by sending its number
  const hijack = await call('POST', '/loans/loan-application', app({ memberNo: B, loanCaseNo: caseNo, loanAmount: 12345 }));
  const after = (await q('select mbno, applied_amt from loan_pending where loancaseno::text=$1', [String(caseNo)]))[0];
  s.check('LF-15', "Application sent with ANOTHER member's existing case number is refused and does not overwrite that case", hijack.status >= 400 && String(after.mbno) === String(A) && Number(after.applied_amt) === 50000, `${hijack.status}; row now mbno=${after.mbno} amt=${after.applied_amt}`);
  const dupAll = (await q('select count(*) c from loan_pending where loancaseno::text=$1', [String(caseNo)]))[0].c;
  s.check('LF-16', 'Case number is unique in loan_pending', Number(dupAll) === 1, dupAll);
  const dbl = await Promise.all([call('POST', '/loans/loan-application', app({ memberNo: B })), call('POST', '/loans/loan-application', app({ memberNo: B }))]);
  const caseNos = dbl.map(r => r.json && r.json.data && r.json.data.loanCaseNo).filter(Boolean);
  s.check('LF-17', 'Two simultaneous applications get two different case numbers', new Set(caseNos).size === caseNos.length && dbl.every(r => r.status < 500), `${caseNos} ${dbl.map(r => r.status)}`);

  // ---- sanction validation
  for (const [id, t, body] of [
    ['LF-18', 'negative sanctioned amount', { sanctionedAmount: -100, noOfInstallments: 24, sanctionDate: '2026-10-16' }],
    ['LF-19', 'sanctioned amount above applied (10x)', { sanctionedAmount: 500000, noOfInstallments: 24, sanctionDate: '2026-10-16' }],
    ['LF-20', 'installments 0', { sanctionedAmount: 50000, noOfInstallments: 0, sanctionDate: '2026-10-16' }],
    ['LF-21', 'text amount', { sanctionedAmount: 'x', noOfInstallments: 24, sanctionDate: '2026-10-16' }],
  ]) {
    const r = await call('PATCH', `/loans/sanction/${caseNo}`, body);
    const row = (await q('select flg_sanctioned, sanctioned_amt, no_of_instal from loan_pending where loancaseno::text=$1', [String(caseNo)]))[0];
    s.check(id, `Sanction with ${t}: refused (4xx); case stays unsanctioned`, r.status >= 400 && r.status < 500 && row.flg_sanctioned !== 'Y', `${r.status}; row ${JSON.stringify(row)}`);
    if (row.flg_sanctioned === 'Y') await call('PATCH', `/loans/sanction/${caseNo}`, { sanctionedAmount: 50000, noOfInstallments: 24, sanctionDate: '2026-10-16' });
  }
  const sn = await call('PATCH', `/loans/sanction/${caseNo}`, { sanctionedAmount: 50000, noOfInstallments: 24, sanctionDate: '2026-10-16', sanctionedBy: 'QA' });
  s.check('LF-22', 'Valid sanction 50000 / 24 succeeds', [200, 201].includes(sn.status), `${sn.status} ${(sn.text || '').slice(0, 100)}`);

  // ---- disbursement voucher
  const lv = await call('POST', '/transactions/loan-voucher', { loanCaseNo: caseNo, paymentMode: 'cash', narration: 'QA disbursement' });
  const vno = lv.json && lv.json.data && (lv.json.data.voucherNo || lv.json.data.voucherNumber);
  s.check('LF-23', 'Loan disbursement voucher generated', [200, 201].includes(lv.status) && !!vno, `${lv.status} ${(lv.text || '').slice(0, 160)}`);
  const lv2 = await call('POST', '/transactions/loan-voucher', { loanCaseNo: caseNo, paymentMode: 'cash', narration: 'QA dup' });
  s.check('LF-24', 'Second disbursement voucher for the same case is refused (no double payout)', lv2.status >= 400, `${lv2.status} ${(lv2.text || '').slice(0, 100)}`);
  if (vno) {
    const det = await call('GET', `/transactions/voucher/${vno}`);
    const d = det.json && det.json.data;
    s.check('LF-25', 'Disbursement voucher amount = sanctioned 50000 less shortfall deductions (5000) = 45000, or 50000 if no deduction', d && [45000, 50000].includes(Number(d.amount)), JSON.stringify(d && { amount: d.amount, breakdown: d.breakdown }).slice(0, 300));
    const ps = await call('POST', `/transactions/pass/${vno}`, { postedBy: 'QA' });
    const gate = [401, 403].includes(ps.status) || /code|authenticator|approval/i.test(ps.text || '');
    s.check('LF-26', 'Pass disbursement (or approval-code gate reported)', ps.status < 300 || gate, `${ps.status} ${(ps.text || '').slice(0, 140)}`);
    if (ps.status < 300) {
      const lm = (await q('select loan_amt, balance, instal_amt, no_of_instal, rate from loan_master where loancaseno::text=$1 and mbno::text=$2', [String(caseNo), String(A)]))[0];
      s.check('LF-27', 'loan_master row created: amount 50000, balance 50000, installments 24', lm && Number(lm.loan_amt) === 50000 && Number(lm.balance) === 50000 && Number(lm.no_of_instal) === 24, JSON.stringify(lm));
      const emi = lm ? Number(lm.instal_amt) : 0;
      // legit EMI close to standard formula?
      const std = (await call('POST', '/loans/calculate-emi', { principal: 50000, annualRate: Number(lm.rate), tenureMonths: 24 })).json.data.emi;
      s.check('LF-28', `Stored EMI (${emi}) equals calculator EMI (${std}) at the stored rate (${lm && lm.rate})`, Math.abs(emi - std) <= 2, `${emi} vs ${std}`);
      const flg = (await q('select flg_paid from loan_pending where loancaseno::text=$1', [String(caseNo)]))[0];
      s.check('LF-29', 'Pending case marked paid after disbursement', flg && flg.flg_paid === 'Y', JSON.stringify(flg));
      const p2 = await call('POST', `/transactions/pass/${vno}`, { postedBy: 'QA' });
      const n = (await q('select count(*) c from loan_master where loancaseno::text=$1', [String(caseNo)]))[0].c;
      s.check('LF-30', 'Passing the disbursement twice does not create a second loan row', Number(n) === 1 && p2.status >= 400, `${p2.status}; loan rows=${n}`);

      // ---- repayments
      const bal = async () => Number((await q('select balance from loan_master where loancaseno::text=$1 and mbno::text=$2', [String(caseNo), String(A)]))[0].balance);
      const pay = (amt, extra = {}) => call('POST', '/loans/repayment', { mbno: A, loancaseno: String(caseNo), paymentAmount: amt, narration: 'QA repay', username: 'QA', ...extra });
      const b0 = await bal();
      const rp = await pay(emi);
      const b1 = await bal();
      s.check('LF-31', 'Repay exactly one EMI: accepted', [200, 201].includes(rp.status), `${rp.status} ${(rp.text || '').slice(0, 160)}`);
      s.check('LF-32', 'Balance falls by the principal part only (less than the EMI, more than 0)', b1 < b0 && b0 - b1 < emi, `balance ${b0} -> ${b1} (emi ${emi})`);
      const led = (await q('select coalesce(sum(payment_amount),0) pa, coalesce(sum(principal_amount),0) pr, coalesce(sum(interest_amount),0) it, coalesce(sum(penal_amount),0) pn from loan_repayment_ledger where loancaseno::text=$1 and mbno::text=$2', [String(caseNo), String(A)]))[0];
      s.check('LF-33', 'Repayment ledger: principal + interest + penal = payment amount', Math.abs(Number(led.pr) + Number(led.it) + Number(led.pn) - Number(led.pa)) < 0.05, JSON.stringify(led));
      s.check('LF-34', 'Principal recorded in ledger equals the fall in balance', Math.abs(Number(led.pr) - (b0 - b1)) < 0.05, `ledger principal ${led.pr} vs balance fall ${b0 - b1}`);
      for (const [id, t, amt] of [['LF-35', 'zero', 0], ['LF-36', 'negative', -500], ['LF-37', 'text', 'abc'], ['LF-38', 'absurd 1e12', 1e12]]) {
        const bb = await bal(); const r = await pay(amt); const ba = await bal();
        s.check(id, `Repayment of ${t} amount refused (4xx) and balance unchanged`, r.status >= 400 && r.status < 500 && bb === ba, `${r.status}; ${bb} -> ${ba}; ${(r.text || '').slice(0, 80)}`);
      }
      const wrong = await call('POST', '/loans/repayment', { mbno: B, loancaseno: String(caseNo), paymentAmount: 100 });
      s.check('LF-39', "Repayment with another member's number for this case is refused", wrong.status >= 400, `${wrong.status} ${(wrong.text || '').slice(0, 100)}`);
      const nocase = await call('POST', '/loans/repayment', { mbno: A, loancaseno: '99999999', paymentAmount: 100 });
      s.check('LF-40', 'Repayment on a case that does not exist -> 404/400', [400, 404].includes(nocase.status), `${nocase.status}`);
      // concurrency: same EMI twice at the same moment
      const bpar = await bal();
      const two = await Promise.all([pay(emi), pay(emi)]);
      const bparA = await bal();
      const okn = two.filter(r => r.status < 300).length;
      const ledN = (await q('select count(*) c from loan_repayment_ledger where loancaseno::text=$1 and mbno::text=$2', [String(caseNo), String(A)]))[0].c;
      s.check('LF-41', `Two simultaneous EMI payments: both applied or one refused, balance consistent (ok=${okn})`, two.every(r => r.status < 500) && bparA < bpar, `${bpar} -> ${bparA}; statuses ${two.map(r => r.status)}; ledger rows ${ledN}`);
      const ov = await pay(await bal() + 100000);
      const bo = await bal();
      s.check('LF-42', 'Overpaying far above the outstanding never leaves a negative balance', bo >= 0, `balance ${bo}; status ${ov.status} ${(ov.text || '').slice(0, 80)}`);
      const future = await pay(100, { asOfDate: '2099-01-01' });
      console.log('INFO repayment asOfDate 2099 ->', future.status, (future.text || '').slice(0, 100));

      // ---- early closure
      if ((await bal()) > 0) {
        const quote = await call('POST', `/loans/early-closure/quote/${caseNo}`, { mbno: A });
        s.check('LF-43', 'Early-closure quote on the running QA loan works', quote.status < 300, `${quote.status} ${(quote.text || '').slice(0, 160)}`);
        const exNoConf = await call('POST', `/loans/early-closure/execute/${caseNo}`, { mbno: A });
        const stillOpen = (await bal()) > 0;
        s.check('LF-44', 'Execute early closure without confirmation/body is refused and the loan stays open', exNoConf.status >= 400 && stillOpen, `${exNoConf.status} ${(exNoConf.text || '').slice(0, 120)}`);
      }
    }
  }
  await pg.end();
  console.log('QA members', A, B, 'case', caseNo, 'voucher', vno);
  process.exit(s.finish() ? 1 : 0);
})();
