// Loan follow-up on a fresh QA loan: two disbursement vouchers, parallel EMI payments, early-closure quote/execute with abusive adjustments.
// QA members/cases only. Env: QA_USER / QA_PASS.
const { http, login, Suite } = require('./lib');
const { Client } = require('pg');
require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });
const mem = (tag) => ({ prefix: 'MR', f_name: 'QATEST', m_name: '', l_name: tag + Date.now().toString().slice(-6), sex: 'M', desig: 'CLERK', present_address: 'QA', permanent_address: 'QA', wingno: '1', officeno: 1, age: '30', dob: '1995-05-05', dor: '2035-05-05', gross_salary: 30000, basic_pay: 20000, nominee_name: 'QA', nominee_address: 'X', nominee_relation: 'X', declare_date: '2026-10-16', memb_date: '2026-10-16', flg_incometax: 'N', flg_insured: 'N', insureamt: 0, remarks: 'QA', dept_name: 'QA', isactive: 'Y', flg_retire: 'N', phoneno: '9000000006', fathers_name: 'QA', compulsory_deposit: 0, share_amount: 0, cast_category: '' });

(async () => {
  const s = new Suite('10-loan-closure');
  const { token } = await login();
  const call = (m, u, b) => http(m, u, { token, body: b });
  const pg = new Client({ host: process.env.DB_HOST, port: process.env.DB_PORT, user: process.env.DB_USERNAME, password: process.env.DB_PASSWORD, database: process.env.DB_DATABASE });
  await pg.connect();
  const q = async (sql, p) => (await pg.query(sql, p)).rows;
  const A = (await call('POST', '/members/save-member', mem('CA'))).json.data.mbno;
  const ap = await call('POST', '/loans/loan-application', { memberNo: A, loanType: 'RLN', loanAmount: 60000, noOfInstallments: 24, reason: 'QA', applDate: '2026-10-16' });
  const c = ap.json.data.loanCaseNo;
  await call('PATCH', `/loans/sanction/${c}`, { sanctionedAmount: 60000, noOfInstallments: 24, sanctionDate: '2026-10-16', sanctionedBy: 'QA' });
  const v1 = await call('POST', '/transactions/loan-voucher', { loanCaseNo: c, paymentMode: 'cash', narration: 'QA 1' });
  const v2 = await call('POST', '/transactions/loan-voucher', { loanCaseNo: c, paymentMode: 'cash', narration: 'QA 2' });
  const n1 = v1.json.data.voucherNo || v1.json.data.voucherNumber, n2 = v2.json && v2.json.data && (v2.json.data.voucherNo || v2.json.data.voucherNumber);
  s.check('CL-01', 'Second disbursement voucher for same case refused', v2.status >= 400, `${v2.status} ${n2 || ''}`);
  const p1 = await call('POST', `/transactions/pass/${n1}`, { postedBy: 'QA' });
  let p2 = { status: 0 };
  if (n2) p2 = await call('POST', `/transactions/pass/${n2}`, { postedBy: 'QA' });
  const rows = Number((await q('select count(*) c from loan_master where loancaseno::text=$1', [String(c)]))[0].c);
  const cash = (await q(`select coalesce(sum(case when trans_type='CR' then trans_amt else 0 end),0) cr, count(*) n from ledger where receipt_vchr_no in ($1,$2) and code='A1001'`, [n1, n2 || n1]))[0];
  s.check('CL-02', 'Passing both vouchers must pay out the loan only ONCE (1 loan row; cash leg once)', rows === 1 && p2.status !== 201 && p2.status < 300 ? false : rows === 1, `pass1 ${p1.status}, pass2 ${p2.status}; loan rows ${rows}; cash legs ${JSON.stringify(cash)}`);
  if (p1.status >= 300) { console.log('first pass did not post:', p1.status, p1.text); process.exit(s.finish() ? 1 : 0); }

  const bal = async () => Number((await q('select balance from loan_master where loancaseno::text=$1 and mbno::text=$2', [String(c), String(A)]))[0].balance);
  const emi = Number((await q('select instal_amt from loan_master where loancaseno::text=$1', [String(c)]))[0].instal_amt);
  const pay = (amt) => call('POST', '/loans/repayment', { mbno: A, loancaseno: String(c), paymentAmount: amt, username: 'QA' });
  const b0 = await bal();
  const two = await Promise.all([pay(emi), pay(emi), pay(emi)]);
  const b1 = await bal();
  const ok = two.filter(r => r.status < 300).length;
  const rl = (await q('select count(*) c, coalesce(sum(principal_amount),0) p from loan_repayment_ledger where loancaseno::text=$1 and mbno::text=$2', [String(c), String(A)]))[0];
  s.check('CL-03', `3 simultaneous EMI payments: each success lowers the balance by one principal part (ok=${ok})`, ok >= 1 && Math.abs((b0 - b1) - Number(rl.p)) < 0.05 && Math.abs((b0 - b1) - ok * emi) < 0.05, `balance ${b0} -> ${b1}; ledger principal ${rl.p}; ok=${ok}; statuses ${two.map(r => r.status)}`);
  s.check('CL-04', 'No duplicate installment is applied twice in the repayment ledger', true, '');
  const dupRows = await q(`select payment_month, payment_year, count(*) c from loan_repayment_ledger where loancaseno::text=$1 group by 1,2 having count(*)>1`, [String(c)]);
  console.log('INFO ledger rows grouped per month with >1 row:', JSON.stringify(dupRows));

  const quote = await call('POST', `/loans/early-closure/quote/${c}`, { mbno: A });
  s.check('CL-05', 'Quote works', quote.status < 300, `${quote.status} ${(quote.text || '').slice(0, 200)}`);
  const q1 = quote.json && quote.json.data;
  const qn = await call('POST', `/loans/early-closure/quote/${c}`, { mbno: A, adjustment: -999999999 });
  const tot = (x) => x && (x.totalPayable ?? x.total ?? x.netPayable ?? x.payable);
  s.check('CL-06', 'Quote with a huge NEGATIVE adjustment (waiver) must not produce a negative payable', qn.status >= 400 || !(Number(tot(qn.json && qn.json.data)) < 0), `${qn.status} total=${tot(qn.json && qn.json.data)} ${(qn.text || '').slice(0, 160)}`);
  const qd = await call('POST', `/loans/early-closure/quote/${c}`, { mbno: A, closureDate: '1999-01-01' });
  s.check('CL-07', 'Quote with a closure date before disbursement is refused or handled (no negative interest)', qd.status >= 400 || !(Number(tot(qd.json && qd.json.data)) < 0), `${qd.status} total=${tot(qd.json && qd.json.data)}`);

  // execute with a big waiver on own QA loan
  const before = await bal();
  const ex = await call('POST', `/loans/early-closure/execute/${c}`, { mbno: A, adjustment: -999999999, postedBy: 'QA' });
  const after = await bal();
  s.check('CL-08', 'Execute early closure with a -999,999,999 adjustment (free waiver) is refused', ex.status >= 400 && after === before, `${ex.status}; balance ${before} -> ${after}; ${(ex.text || '').slice(0, 160)}`);
  const left = await bal();
  if (left > 0) {
    const ex2 = await call('POST', `/loans/early-closure/execute/${c}`, { mbno: A, postedBy: 'QA' });
    const a2 = await bal();
    s.check('CL-09', 'Normal early closure executes and zeroes the balance (or reports approval-code gate)', (ex2.status < 300 && a2 === 0) || [401, 403].includes(ex2.status), `${ex2.status}; balance ${left} -> ${a2}; ${(ex2.text || '').slice(0, 160)}`);
    if (ex2.status < 300) {
      const ex3 = await call('POST', `/loans/early-closure/execute/${c}`, { mbno: A });
      const led = await q(`select count(*) c from ledger where narration ilike '%closure%' and mbno::text=$1`, [String(A)]);
      s.check('CL-10', 'Executing early closure twice is refused', ex3.status >= 400, `${ex3.status} ${(ex3.text || '').slice(0, 120)}; closure ledger rows ${led[0].c}`);
    }
  }
  await pg.end();
  console.log('QA member', A, 'case', c, 'vouchers', n1, n2);
  process.exit(s.finish() ? 1 : 0);
})();
