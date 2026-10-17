// Savings (SB) write-flow suite on an SB account created here for a QA member. Checks balances against the ledger,
// overdraft, bad input and concurrency. Never touches an existing account. Env: QA_USER / QA_PASS.
const { http, login, Suite } = require('./lib');
const { Client } = require('pg');
require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });

(async () => {
  const s = new Suite('08-savings');
  const { token } = await login();
  const call = (m, u, b) => http(m, u, { token, body: b });
  const pg = new Client({ host: process.env.DB_HOST, port: process.env.DB_PORT, user: process.env.DB_USERNAME, password: process.env.DB_PASSWORD, database: process.env.DB_DATABASE });
  await pg.connect();
  const bal = async (acc) => Number((await pg.query('select balance from sbmaster where acc_no::text=$1', [String(acc)])).rows[0]?.balance);
  const ledgerNet = async (acc) => Number((await pg.query(`select coalesce(sum(case when trans_type='CR' then trans_amt else -trans_amt end),0) s from ledger where acc_type='SB' and acc_no::text=$1`, [String(acc)])).rows[0].s);

  const mk = await call('POST', '/members/save-member', { prefix: 'MR', f_name: 'QATEST', m_name: '', l_name: 'S' + Date.now().toString().slice(-6), sex: 'M', desig: 'CLERK', present_address: 'QA', permanent_address: 'QA', wingno: '1', officeno: 1, age: '30', dob: '1995-05-05', dor: '2035-05-05', gross_salary: 30000, basic_pay: 20000, nominee_name: 'QA', nominee_address: 'X', nominee_relation: 'X', declare_date: '2026-10-16', memb_date: '2026-10-16', flg_incometax: 'N', flg_insured: 'N', insureamt: 0, remarks: 'QA', dept_name: 'QA', isactive: 'Y', flg_retire: 'N', phoneno: '9000000008', fathers_name: 'QA', compulsory_deposit: 0, share_amount: 0, cast_category: '' });
  const mb = mk.json && mk.json.data && mk.json.data.mbno;
  s.check('SB-00', 'QA member created', !!mb, mk.status);
  const nx = await call('GET', '/admin/sb-accounts/next-number');
  const accNo = String((nx.json && nx.json.data && (nx.json.data.nextAccountNumber || nx.json.data)) || '');
  s.check('SB-01', 'Next SB account number is numeric', /^\d+$/.test(accNo), accNo);
  if (!mb || !/^\d+$/.test(accNo)) process.exit(s.finish() ? 1 : 0);

  // account creation validation
  const bad = [
    ['SB-02', 'non-numeric account number', { accountNo: 'AB12', memberNo: mb }],
    ['SB-03', 'negative opening balance', { accountNo: '9' + accNo, memberNo: mb, openingBalance: -100 }],
    ['SB-04', 'member that does not exist', { accountNo: '8' + accNo, memberNo: '1999999999' }],
    ['SB-05', 'missing member', { accountNo: '7' + accNo }],
  ];
  for (const [id, t, body] of bad) {
    const r = await call('POST', '/admin/sb-accounts', body);
    s.check(id, `Create SB account with ${t} -> 4xx (no 5xx, not accepted)`, r.status >= 400 && r.status < 500, `${r.status} ${(r.text || '').slice(0, 110)}`);
  }
  const cr = await call('POST', '/admin/sb-accounts', { accountNo: accNo, memberNo: mb, openingBalance: 1000, openingDate: '2026-10-16' });
  s.check('SB-06', 'Create SB account with opening balance 1000', [200, 201].includes(cr.status), `${cr.status} ${(cr.text || '').slice(0, 140)}`);
  const dup = await call('POST', '/admin/sb-accounts', { accountNo: accNo, memberNo: mb });
  s.check('SB-07', 'Duplicate account number -> 409/400, not 500', [400, 409].includes(dup.status), `${dup.status} ${(dup.text || '').slice(0, 100)}`);
  s.check('SB-08', 'Opening balance 1000 stored in sbmaster and equals the ledger', (await bal(accNo)) === 1000 && (await ledgerNet(accNo)) === 1000, `sb=${await bal(accNo)} ledger=${await ledgerNet(accNo)}`);

  const tx = (type, amount, extra = {}) => call('POST', '/utilities/saving/transaction', { accountNo: accNo, transDate: '2026-10-16', transactionType: type, amount, paymentMode: 'cash', narration: 'QA ' + type, ...extra });
  const d1 = await tx('deposit', 500);
  s.check('SB-09', 'Deposit 500 succeeds', [200, 201].includes(d1.status), `${d1.status} ${(d1.text || '').slice(0, 140)}`);
  const b1 = await bal(accNo);
  s.check('SB-10', 'Balance after deposit = 1500 (number, not string concatenation)', b1 === 1500, `balance=${b1}`);
  const w1 = await tx('withdrawal', 200);
  s.check('SB-11', 'Withdraw 200 -> balance 1300', [200, 201].includes(w1.status) && (await bal(accNo)) === 1300, `${w1.status} bal=${await bal(accNo)}`);
  s.check('SB-12', 'sbmaster balance equals ledger sum after 3 postings', (await bal(accNo)) === (await ledgerNet(accNo)), `sb=${await bal(accNo)} ledger=${await ledgerNet(accNo)}`);

  const od = await tx('withdrawal', 5000);
  s.check('SB-13', 'Withdraw more than the balance (overdraft) is refused', od.status >= 400 && (await bal(accNo)) === 1300, `${od.status}; balance now ${await bal(accNo)}`);
  for (const [id, t, type, amount] of [['SB-14', 'zero deposit', 'deposit', 0], ['SB-15', 'negative deposit', 'deposit', -100], ['SB-16', 'negative withdrawal', 'withdrawal', -100], ['SB-17', 'text amount', 'deposit', 'abc'], ['SB-18', 'unknown type', 'transfer', 10], ['SB-19', 'amount with 5 decimals', 'deposit', 1.23456], ['SB-20', 'absurd amount 1e15', 'deposit', 1e15]]) {
    const before = await bal(accNo);
    const r = await tx(type, amount);
    const after = await bal(accNo);
    s.check(id, `${t}: rejected (4xx) and balance unchanged`, r.status >= 400 && r.status < 500 && before === after, `${r.status}; balance ${before} -> ${after}; ${(r.text || '').slice(0, 90)}`);
  }
  const noacc = await call('POST', '/utilities/saving/transaction', { accountNo: '999999999999', transDate: '2026-10-16', transactionType: 'deposit', amount: 10, paymentMode: 'cash', narration: 'x' });
  s.check('SB-21', 'Deposit to an account that does not exist -> 404/400', [400, 404].includes(noacc.status), `${noacc.status} ${(noacc.text || '').slice(0, 90)}`);

  // concurrency: 10 parallel deposits of 10 -> exactly +100, unique transaction numbers
  const b0 = await bal(accNo);
  const par = await Promise.all(Array.from({ length: 10 }, () => tx('deposit', 10)));
  const okc = par.filter(r => r.status < 300).length;
  const b2 = await bal(accNo);
  const dupTr = (await pg.query(`select trans_no, count(*) c from ledger where acc_type='SB' and acc_no::text=$1 group by trans_no having count(*)>1`, [accNo])).rows;
  s.check('SB-22', `10 parallel deposits of 10: balance rises by exactly 10 x successes (ok=${okc})`, b2 === b0 + okc * 10, `before ${b0} after ${b2} ok=${okc} statuses=${[...new Set(par.map(r => r.status))]}`);
  s.check('SB-23', 'Parallel postings do not create duplicate transaction numbers', dupTr.length === 0, JSON.stringify(dupTr).slice(0, 200));
  s.check('SB-24', 'After the parallel run, sbmaster balance still equals the ledger', (await bal(accNo)) === (await ledgerNet(accNo)), `sb=${await bal(accNo)} ledger=${await ledgerNet(accNo)}`);
  // parallel withdrawals that together exceed the balance
  const cur = await bal(accNo);
  const wp = await Promise.all(Array.from({ length: 5 }, () => tx('withdrawal', Math.ceil(cur * 0.6))));
  s.check('SB-25', 'Parallel withdrawals of 60% of balance: balance never negative', (await bal(accNo)) >= 0, `balance ${await bal(accNo)} (started ${cur}); ok=${wp.filter(r => r.status < 300).length}`);

  const det = await call('GET', `/utilities/saving/account/${accNo}`);
  s.check('SB-26', 'Account details and history load', det.status === 200, det.status);
  const st = await call('GET', `/admin/sb-accounts/${accNo}`);
  console.log('INFO get account ->', st.status);
  await pg.end();
  console.log('QA member', mb, 'SB account', accNo);
  process.exit(s.finish() ? 1 : 0);
})();
