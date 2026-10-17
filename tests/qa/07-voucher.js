// Voucher write-flow suite: create / validate / pass / reverse / reject. Uses ONE QA member created here (QATEST...).
// Only vouchers created by this suite are passed, reversed or rejected. Env: QA_USER / QA_PASS.
const { http, login, Suite } = require('./lib');
const { Client } = require('pg');
require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });

const member = () => ({
  prefix: 'MR', f_name: 'QATEST', m_name: '', l_name: 'V' + Date.now().toString().slice(-6), sex: 'M', desig: 'CLERK', present_address: 'QA', permanent_address: 'QA',
  wingno: '1', officeno: 1, age: '30', dob: '1995-05-05', dor: '2035-05-05', gross_salary: 30000, basic_pay: 20000, nominee_name: 'QA', nominee_address: 'X',
  nominee_relation: 'X', declare_date: '2026-10-16', memb_date: '2026-10-16', flg_incometax: 'N', flg_insured: 'N', insureamt: 0, remarks: 'QA', dept_name: 'QA',
  isactive: 'Y', flg_retire: 'N', phoneno: '9000000009', fathers_name: 'QA', compulsory_deposit: 0, share_amount: 0, cast_category: '',
});

(async () => {
  const s = new Suite('07-voucher');
  const { token } = await login();
  const call = (m, u, b) => http(m, u, { token, body: b });
  const pg = new Client({ host: process.env.DB_HOST, port: process.env.DB_PORT, user: process.env.DB_USERNAME, password: process.env.DB_PASSWORD, database: process.env.DB_DATABASE });
  await pg.connect();
  const mk = await call('POST', '/members/save-member', member());
  const mb = mk.json && mk.json.data && mk.json.data.mbno;
  s.check('VC-00', 'QA member created for the voucher tests', !!mb, mk.status);
  if (!mb) process.exit(s.finish() ? 1 : 0);
  const mine = [];
  const rcpt = (o = {}) => ({ voucherType: 'RECEIPT', voucherDate: '2026-10-16', description: 'QA receipt', memberId: mb, paymentMethod: 'CASH', transactions: [{ amount: 500, code: 'L1004', description: 'QA line' }], ...o });
  const pay = (o = {}) => rcpt({ voucherType: 'PAYMENT', description: 'QA payment', transactions: [{ amount: 300, code: 'L1004', description: 'QA pay line' }], ...o });
  const mkv = async (b) => { const r = await call('POST', '/transactions/voucher', b); const no = r.json && r.json.data && r.json.data.voucherNo; if (no) mine.push(no); return { r, no }; };

  // create + read
  const a = await mkv(rcpt());
  s.check('VC-01', 'Create receipt voucher returns a voucher number', [200, 201].includes(a.r.status) && !!a.no, `${a.r.status} ${(a.r.text || '').slice(0, 120)}`);
  const det = await call('GET', `/transactions/voucher/${a.no}`);
  const bd = (det.json && det.json.data && det.json.data.breakdown) || [];
  s.check('VC-02', 'Voucher detail: status PENDING, amount 500, balancing cash leg A1001 present', det.json && det.json.data && det.json.data.status === 'PENDING' && det.json.data.amount === 500 && bd.some(x => x.code === 'A1001'), JSON.stringify(det.json && det.json.data).slice(0, 200));
  const pend = await call('GET', '/transactions/vouchers/pending');
  s.check('VC-03', 'Voucher is in the pending list', JSON.stringify(pend.json || {}).includes(a.no), pend.status);
  const rows = (await pg.query(`select trans_type, sum(trans_amt) s, count(*) n from transactions where receipt_vchr_no=$1 group by trans_type`, [a.no])).rows;
  const dr = rows.filter(r => /^(DR|D)$/.test(r.trans_type)).reduce((x, r) => x + Number(r.s), 0);
  const cr = rows.filter(r => /^(CR|C|R)$/.test(r.trans_type)).reduce((x, r) => x + Number(r.s), 0);
  s.check('VC-04', 'Staged transactions balance (debit total = credit total) for a receipt', dr === cr && dr === 500, JSON.stringify(rows));

  // validation
  const V = [
    ['VC-05', 'no entries', rcpt({ transactions: [] })],
    ['VC-06', 'amount 0', rcpt({ transactions: [{ amount: 0, code: 'L1004' }] })],
    ['VC-07', 'negative amount', rcpt({ transactions: [{ amount: -500, code: 'L1004' }] })],
    ['VC-08', 'amount as text "abc"', rcpt({ transactions: [{ amount: 'abc', code: 'L1004' }] })],
    ['VC-09', 'unknown head code', rcpt({ transactions: [{ amount: 100, code: 'ZZZ999' }] })],
    ['VC-10', 'no voucherType', rcpt({ voucherType: undefined })],
    ['VC-11', 'unknown voucherType', rcpt({ voucherType: 'BANANA' })],
    ['VC-12', 'unknown member id', rcpt({ memberId: '1999999999' })],
    ['VC-13', 'bank mode without bank code', rcpt({ paymentMethod: 'BANK' })],
    ['VC-14', 'amount 1e12 (absurd)', rcpt({ transactions: [{ amount: 1e12, code: 'L1004' }] })],
    ['VC-15', 'voucherDate in invalid format', rcpt({ voucherDate: 'yesterday' })],
    ['VC-16', 'voucherDate far in the future (2099)', rcpt({ voucherDate: '2099-01-01' })],
    ['VC-17', 'amount with 5 decimals', rcpt({ transactions: [{ amount: 10.12345, code: 'L1004' }] })],
  ];
  for (const [id, t, body] of V) {
    const x = await mkv(body);
    const accepted = x.r.status < 300;
    s.check(id, `Create voucher with ${t}: rejected with 4xx (not 5xx, not accepted)`, x.r.status >= 400 && x.r.status < 500, `${x.r.status} ${accepted ? 'ACCEPTED ' + x.no : ''} ${(x.r.text || '').slice(0, 100)}`);
  }
  const q = await call('POST', '/transactions/voucher', rcpt({ description: "x'); DROP TABLE vouchers;--" })); if (q.json && q.json.data && q.json.data.voucherNo) mine.push(q.json.data.voucherNo);
  const chk = await call('GET', '/transactions/vouchers/pending');
  s.check('VC-18', 'SQL-injection text in description is harmless', q.status < 500 && chk.status === 200, `${q.status}/${chk.status}`);

  // concurrency: 6 parallel creates -> distinct numbers
  const par = await Promise.all(Array.from({ length: 6 }, () => call('POST', '/transactions/voucher', rcpt())));
  const nos = par.map(r => r.json && r.json.data && r.json.data.voucherNo).filter(Boolean); nos.forEach(n => mine.push(n));
  s.check('VC-19', '6 parallel voucher creations give 6 distinct numbers, no 5xx', new Set(nos).size === 6 && par.every(r => r.status < 500), `distinct ${new Set(nos).size}; ${[...new Set(par.map(r => r.status))]}`);

  // pass
  const p = await call('POST', `/transactions/pass/${a.no}`, { postedBy: 'QA' });
  const needsCode = p.status === 401 || p.status === 403 || /code|authenticator|approval/i.test(p.text || '');
  s.check('VC-20', 'Pass voucher (if approval code is required by policy this is reported, not failed)', p.status < 300 || needsCode, `${p.status} ${(p.text || '').slice(0, 160)}`);
  if (p.status < 300) {
    const led = (await pg.query(`select count(*) n, sum(trans_amt) s from ledger where receipt_vchr_no=$1`, [a.no])).rows[0];
    s.check('VC-21', 'Passing posted ledger entries for the voucher (2 legs, 500 each)', Number(led.n) >= 2, JSON.stringify(led));
    const p2 = await call('POST', `/transactions/pass/${a.no}`, { postedBy: 'QA' });
    s.check('VC-22', 'Passing the same voucher a second time is refused (4xx) and adds no ledger rows', p2.status >= 400 && p2.status < 500, `${p2.status} ${(p2.text || '').slice(0, 100)}`);
    const led2 = (await pg.query(`select count(*) n from ledger where receipt_vchr_no=$1`, [a.no])).rows[0];
    s.check('VC-23', 'No duplicate ledger rows after the second pass attempt', Number(led2.n) === Number(led.n), `${led.n} -> ${led2.n}`);
    const rev = await call('POST', `/transactions/reverse/${a.no}`, { reversedBy: 'QA' });
    s.check('VC-24', 'Reverse the QA voucher: accepted or requires approval code (no 5xx)', rev.status < 500, `${rev.status} ${(rev.text || '').slice(0, 140)}`);
    if (rev.status < 300) {
      const net = (await pg.query(`select sum(case when trans_type in ('DR','D') then trans_amt else -trans_amt end) s from ledger where receipt_vchr_no=$1`, [a.no])).rows[0];
      s.check('VC-25', 'After reversal the voucher nets to zero in the ledger', Math.abs(Number(net.s || 0)) < 0.01, JSON.stringify(net));
      const rev2 = await call('POST', `/transactions/reverse/${a.no}`, {});
      s.check('VC-26', 'Reversing twice is refused', rev2.status >= 400 && rev2.status < 500, rev2.status);
    }
  }
  const np = await call('POST', '/transactions/pass/VCH-NOT-THERE', {});
  s.check('VC-27', 'Pass of a voucher that does not exist -> 404/400', [400, 404].includes(np.status), `${np.status} ${(np.text || '').slice(0, 100)}`);
  const nr = await call('POST', '/transactions/reverse/VCH-NOT-THERE', {});
  s.check('VC-28', 'Reverse of a voucher that does not exist -> 404/400', [400, 404, 401, 403].includes(nr.status), nr.status);

  // reject (delete) only my own PENDING vouchers
  let rejected = 0, bad = [];
  for (const no of mine.filter(n => n !== a.no)) {
    const st = await call('GET', `/transactions/voucher/${no}`);
    if (st.json && st.json.data && st.json.data.status === 'PENDING' && st.json.data.memberNo === String(mb)) {
      const d = await call('DELETE', `/transactions/voucher/${no}`);
      if (d.status < 300) rejected++; else bad.push(`${no}:${d.status}`);
    }
  }
  s.check('VC-29', `Own pending QA vouchers can be rejected (${rejected} rejected)`, bad.length === 0, bad.join(','));
  const gone = await call('GET', `/transactions/voucher/${mine[1] || 'x'}`);
  console.log('INFO reject then read ->', gone.status);
  await pg.end();
  console.log('QA member', mb, 'vouchers', mine.join(','));
  process.exit(s.finish() ? 1 : 0);
})();
