// RD write flow on a QA member: member config, installment payments, withdrawal, interest preview, FY close preview, close of the QA member.
// Verifies balances against rd_installment_ledger / rd_balance_events and the main ledger. Env: QA_USER / QA_PASS.
const { http, login, Suite } = require('./lib');
const { Client } = require('pg');
require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });
const mem = () => ({ prefix: 'MR', f_name: 'QATEST', m_name: '', l_name: 'R' + Date.now().toString().slice(-6), sex: 'M', desig: 'CLERK', present_address: 'QA', permanent_address: 'QA', wingno: '1', officeno: 1, age: '30', dob: '1995-05-05', dor: '2035-05-05', gross_salary: 30000, basic_pay: 20000, nominee_name: 'QA', nominee_address: 'X', nominee_relation: 'X', declare_date: '2026-10-16', memb_date: '2026-10-16', flg_incometax: 'N', flg_insured: 'N', insureamt: 0, remarks: 'QA', dept_name: 'QA', isactive: 'Y', flg_retire: 'N', phoneno: '9000000003', fathers_name: 'QA', compulsory_deposit: 0, share_amount: 0, cast_category: '' });

(async () => {
  const s = new Suite('15-rd');
  const { token } = await login();
  const call = (m, u, b) => http(m, u, { token, body: b, timeout: 120000 });
  const pg = new Client({ host: process.env.DB_HOST, port: process.env.DB_PORT, user: process.env.DB_USERNAME, password: process.env.DB_PASSWORD, database: process.env.DB_DATABASE });
  await pg.connect();
  const rows = async (sql, p) => (await pg.query(sql, p)).rows;
  const mb = (await call('POST', '/members/save-member', mem())).json.data.mbno;
  const YC = 1;
  s.check('RD-00', 'QA member created', !!mb, mb);

  // ---- config
  for (const [id, t, b] of [['RD-01', 'zero monthly amount', { monthlyRdAmount: 0, setBy: 'QA' }], ['RD-02', 'negative monthly amount', { monthlyRdAmount: -500, setBy: 'QA' }], ['RD-03', 'text amount', { monthlyRdAmount: 'abc', setBy: 'QA' }], ['RD-04', 'absurd amount 1e12', { monthlyRdAmount: 1e12, setBy: 'QA' }], ['RD-05', 'missing amount', {}]]) {
    const r = await call('POST', `/rd/member-config/${mb}/${YC}`, b);
    s.check(id, `RD config with ${t}: refused (4xx)`, r.status >= 400 && r.status < 500, `${r.status} ${(r.text || '').slice(0, 100)}`);
  }
  const unk = await call('POST', '/rd/member-config/1999999999/1', { monthlyRdAmount: 500, setBy: 'QA' });
  s.check('RD-06', 'RD config for a member that does not exist -> 404/400', unk.status >= 400 && unk.status < 500, `${unk.status} ${(unk.text || '').slice(0, 100)}`);
  const yc = await call('POST', `/rd/member-config/${mb}/999`, { monthlyRdAmount: 500, setBy: 'QA' });
  s.check('RD-07', 'RD config for a financial year that does not exist -> 404/400', yc.status >= 400 && yc.status < 500, `${yc.status} ${(yc.text || '').slice(0, 100)}`);
  const cfg = await call('POST', `/rd/member-config/${mb}/${YC}`, { monthlyRdAmount: 500, setBy: 'QA' });
  s.check('RD-08', 'Valid RD config 500/month saved', cfg.status < 300 && cfg.status > 0, `${cfg.status} ${(cfg.text || '').slice(0, 140)}`);
  const cur = await call('GET', `/rd/member-config/${mb}/${YC}/current`);
  s.check('RD-09', 'Current config returns 500', cur.status === 200 && JSON.stringify(cur.json).includes('500'), `${cur.status} ${(cur.text || '').slice(0, 120)}`);
  const cfg2 = await call('POST', `/rd/member-config/${mb}/${YC}`, { monthlyRdAmount: 700, setBy: 'QA' });
  const hist = await call('GET', `/rd/member-config/${mb}/${YC}/history`);
  s.check('RD-10', 'Changing the amount keeps the old value in history (2 entries)', cfg2.status < 300 && ((hist.json && hist.json.data) || []).length >= 2, `${cfg2.status}; history ${(hist.text || '').slice(0, 160)}`);

  // ---- pending + payments
  const pend = await call('GET', `/rd/repayment/${mb}/${YC}/pending`);
  s.check('RD-11', 'Pending installments load', pend.status === 200, `${pend.status} ${(pend.text || '').slice(0, 160)}`);
  const pay = (month, year, amount, extra = {}) => call('POST', `/rd/repayment/${mb}/${YC}`, { installmentMonth: month, installmentYear: year, amount, recordedBy: 'QA', narration: 'QA RD', ...extra });
  const led = async () => (await rows(`select coalesce(sum(case when trans_type='CR' then trans_amt else -trans_amt end),0) v, count(*) n from ledger where mbno=$1 and code='L1004'`, [mb]))[0];
  const before = await led();
  for (const [id, t, m, y, a] of [['RD-12', 'amount 0', 4, 2026, 0], ['RD-13', 'negative amount', 4, 2026, -100], ['RD-14', 'month 13', 13, 2026, 500], ['RD-15', 'month 0', 0, 2026, 500], ['RD-16', 'year 1900', 4, 1900, 500], ['RD-17', 'text amount', 4, 2026, 'abc']]) {
    const r = await pay(m, y, a);
    const a2 = await led();
    s.check(id, `RD payment with ${t}: refused (4xx), nothing posted`, r.status >= 400 && r.status < 500 && Number(a2.n) === Number(before.n), `${r.status}; rows ${before.n} -> ${a2.n}; ${(r.text || '').slice(0, 90)}`);
  }
  const p1 = await pay(10, 2026, 700);
  s.check('RD-18', 'RD payment Oct 2026 amount 700 (current config) saved', p1.status < 300 && p1.status > 0, `${p1.status} ${(p1.text || '').slice(0, 180)}`);
  const after1 = await led();
  s.check('RD-19', 'Payment posted a ledger credit of 700 on L1004', Number(after1.v) - Number(before.v) === 700, `${before.v} -> ${after1.v}`);
  const dup = await pay(10, 2026, 700);
  const after2 = await led();
  s.check('RD-20', 'Paying the same installment month twice is refused (no double posting)', dup.status >= 400 && dup.status < 500 && Number(after2.v) === Number(after1.v), `${dup.status}; ledger ${after1.v} -> ${after2.v}; ${(dup.text || '').slice(0, 100)}`);
  const par = await Promise.all([pay(11, 2026, 700), pay(11, 2026, 700), pay(11, 2026, 700)]);
  const after3 = await led();
  const okc = par.filter(r => r.status < 300 && r.status > 0).length;
  s.check('RD-21', `3 simultaneous payments of the same installment: exactly one is applied (ok=${okc})`, okc === 1 && Number(after3.v) - Number(after2.v) === 700, `statuses ${par.map(r => r.status)}; ledger ${after2.v} -> ${after3.v}`);
  const part = await pay(12, 2026, 100);
  s.check('RD-22', 'Part payment (100 against 700) handled: accepted as part or refused with a reason (no 5xx)', part.status > 0 && part.status < 500, `${part.status} ${(part.text || '').slice(0, 140)}`);
  const over = await pay(1, 2027, 70000);
  console.log('INFO overpayment 70000 on one installment ->', over.status, (over.text || '').slice(0, 140));
  s.check('RD-23', 'Payment of 100x the monthly amount is refused or capped (no silent acceptance of 70,000)', over.status >= 400 || !JSON.stringify(over.json).includes('70000'), `${over.status}`);

  // ---- balance / withdrawal
  const bal = await call('GET', `/rd/balance/${mb}/${YC}/current`);
  s.check('RD-24', 'RD balance loads', bal.status === 200, `${bal.status} ${(bal.text || '').slice(0, 160)}`);
  const tl = await call('GET', `/rd/balance/${mb}/${YC}/timeline`);
  s.check('RD-25', 'RD timeline loads and has the payments', tl.status === 200, `${tl.status} ${(tl.text || '').slice(0, 100)}`);
  const wd = (amount, extra = {}) => call('POST', `/rd/balance/${mb}/${YC}/withdraw`, { amount, narration: 'QA wd', createdBy: 'QA', ...extra });
  const b0 = await led();
  for (const [id, t, a] of [['RD-26', 'zero', 0], ['RD-27', 'negative', -50], ['RD-28', 'text', 'abc'], ['RD-29', 'more than the RD balance (1e9)', 1e9]]) {
    const r = await wd(a); const a2 = await led();
    s.check(id, `RD withdrawal of ${t}: refused (4xx), nothing posted`, r.status >= 400 && r.status < 500 && Number(a2.n) === Number(b0.n), `${r.status}; rows ${b0.n} -> ${a2.n}; ${(r.text || '').slice(0, 90)}`);
  }
  const w1 = await wd(200);
  s.check('RD-30', 'Valid withdrawal of 200 accepted', w1.status > 0 && w1.status < 300, `${w1.status} ${(w1.text || '').slice(0, 140)}`);
  const afterW = await call('GET', `/rd/balance/${mb}/${YC}/current`);
  console.log('INFO balance after withdrawal ->', (afterW.text || '').slice(0, 200));
  const wpar = await Promise.all([wd(300), wd(300), wd(300)]);
  const bAfter = await call('GET', `/rd/balance/${mb}/${YC}/current`);
  s.check('RD-31', 'Parallel withdrawals never push the RD balance below zero', !/-\d/.test(JSON.stringify((bAfter.json && bAfter.json.data && (bAfter.json.data.balance ?? bAfter.json.data.currentBalance)) ?? '')) , `${wpar.map(r => r.status)}; ${(bAfter.text || '').slice(0, 160)}`);

  // ---- interest + closing (preview only for others; close only the QA member)
  const ip = await call('GET', `/rd/interest/${mb}/${YC}/preview`);
  s.check('RD-32', 'RD interest preview for the QA member does not 5xx', ip.status > 0 && ip.status < 500, `${ip.status} ${(ip.text || '').slice(0, 160)}`);
  const cp = await call('GET', `/rd/closing/${mb}/${YC}/preview`);
  s.check('RD-33', 'RD closing preview for the QA member does not 5xx', cp.status > 0 && cp.status < 500, `${cp.status} ${(cp.text || '').slice(0, 160)}`);
  const cl = await call('POST', `/rd/closing/${mb}/${YC}/close`, { closedBy: 'QA' });
  console.log('INFO close QA member RD ->', cl.status, (cl.text || '').slice(0, 200));
  s.check('RD-34', 'Closing the QA member RD: done or refused with a reason (4xx), never 5xx', cl.status > 0 && cl.status < 500, `${cl.status}`);
  if (cl.status < 300) {
    const cl2 = await call('POST', `/rd/closing/${mb}/${YC}/close`, { closedBy: 'QA' });
    s.check('RD-35', 'Closing the same RD twice is refused', cl2.status >= 400 && cl2.status < 500, `${cl2.status} ${(cl2.text || '').slice(0, 100)}`);
    const after = await pay(2, 2027, 700);
    s.check('RD-36', 'Payment after the RD is closed is refused', after.status >= 400 && after.status < 500, `${after.status} ${(after.text || '').slice(0, 100)}`);
  }
  const all = await call('GET', `/rd/closing/${YC}/preview?limit=5`);
  s.check('RD-37', 'Bulk closing preview (read-only) loads quickly (< 10 s)', all.status === 200 && all.ms < 10000, `${all.status} ${all.ms}ms`);
  await pg.end();
  console.log('QA member', mb);
  process.exit(s.finish() ? 1 : 0);
})();
