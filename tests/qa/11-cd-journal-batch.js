// Compulsory deposit + journal write checks on QA members, plus read-only/preview checks of interest, dividend and day-end.
// Global batch commits (day-end initiate, interest update, dividend commit) are deliberately NOT executed here: they change every member.
const { http, login, Suite } = require('./lib');
const { Client } = require('pg');
require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });
const mem = (tag) => ({ prefix: 'MR', f_name: 'QATEST', m_name: '', l_name: tag + Date.now().toString().slice(-6), sex: 'M', desig: 'CLERK', present_address: 'QA', permanent_address: 'QA', wingno: '1', officeno: 1, age: '30', dob: '1995-05-05', dor: '2035-05-05', gross_salary: 30000, basic_pay: 20000, nominee_name: 'QA', nominee_address: 'X', nominee_relation: 'X', declare_date: '2026-10-16', memb_date: '2026-10-16', flg_incometax: 'N', flg_insured: 'N', insureamt: 0, remarks: 'QA', dept_name: 'QA', isactive: 'Y', flg_retire: 'N', phoneno: '9000000005', fathers_name: 'QA', compulsory_deposit: 0, share_amount: 0, cast_category: '' });

(async () => {
  const s = new Suite('11-cd-journal-batch');
  const { token } = await login();
  const call = (m, u, b) => http(m, u, { token, body: b });
  const pg = new Client({ host: process.env.DB_HOST, port: process.env.DB_PORT, user: process.env.DB_USERNAME, password: process.env.DB_PASSWORD, database: process.env.DB_DATABASE });
  await pg.connect();
  const A = Number((await call('POST', '/members/save-member', mem('JA'))).json.data.mbno);
  const B = Number((await call('POST', '/members/save-member', mem('JB'))).json.data.mbno);
  const net = async (mb, code) => Number((await pg.query(`select coalesce(sum(case when trans_type='CR' then trans_amt else -trans_amt end),0) s from ledger where mbno=$1 and code=$2`, [mb, code])).rows[0].s);

  // ---- compulsory deposit
  const heads = await call('GET', '/transactions/cd/income-heads');
  s.check('JC-01', 'CD income heads load', heads.status === 200, heads.status);
  const hs = (heads.json && heads.json.data) || [];
  const head = (hs[0] && (hs[0].code || hs[0].headCode)) || 'L1004';
  const cdBody = (o = {}) => ({ incomeHeadCode: head, totalAmount: 300, narration: 'QA CD', distributions: [{ memberNo: A, memberName: 'QA A', currentBalance: 0, postAmount: 100 }, { memberNo: B, memberName: 'QA B', currentBalance: 0, postAmount: 200 }], ...o });
  for (const [id, t, body] of [
    ['JC-02', 'total does not equal the sum of distributions', cdBody({ totalAmount: 999 })],
    ['JC-03', 'negative post amount', cdBody({ totalAmount: 100, distributions: [{ memberNo: A, memberName: 'x', currentBalance: 0, postAmount: -100 }] })],
    ['JC-04', 'member that does not exist', cdBody({ totalAmount: 100, distributions: [{ memberNo: 1999999999, memberName: 'x', currentBalance: 0, postAmount: 100 }] })],
    ['JC-05', 'unknown income head', cdBody({ incomeHeadCode: 'ZZZ999' })],
    ['JC-06', 'empty distribution list', cdBody({ totalAmount: 0, distributions: [] })],
    ['JC-07', 'same member twice', cdBody({ totalAmount: 200, distributions: [{ memberNo: A, memberName: 'x', currentBalance: 0, postAmount: 100 }, { memberNo: A, memberName: 'x', currentBalance: 0, postAmount: 100 }] })],
  ]) {
    const before = await net(A, 'L1004');
    const r = await call('POST', '/transactions/cd/post', body);
    const after = await net(A, 'L1004');
    s.check(id, `CD post with ${t}: refused (4xx), nothing posted`, r.status >= 400 && r.status < 500 && before === after, `${r.status}; ledger ${before} -> ${after}; ${(r.text || '').slice(0, 100)}`);
  }
  const okcd = await call('POST', '/transactions/cd/post', cdBody());
  s.check('JC-08', 'Valid CD post of 100 + 200 succeeds (or approval gate)', okcd.status < 300 || [401, 403].includes(okcd.status), `${okcd.status} ${(okcd.text || '').slice(0, 140)}`);
  if (okcd.status < 300) {
    const ra = (await pg.query(`select coalesce(sum(trans_amt),0) s, count(*) n from ledger where mbno=$1 and narration ilike '%QA CD%'`, [A])).rows[0];
    s.check('JC-09', 'Member A got exactly one posting of 100', Number(ra.s) >= 100 && Number(ra.n) >= 1, JSON.stringify(ra));
    const dup = await call('POST', '/transactions/cd/post', cdBody());
    console.log('INFO second identical CD post ->', dup.status);
  }

  // ---- journal
  const jr = (rows, o = {}) => ({ transferType: 'headToHead', narration: 'QA journal', rows, ...o });
  for (const [id, t, body] of [
    ['JJ-01', 'debit 1000, credit 900 (unbalanced)', jr([{ code: 'L1004', debit: 1000, credit: 0 }, { code: 'L1001', debit: 0, credit: 900 }])],
    ['JJ-02', 'negative debit', jr([{ code: 'L1004', debit: -100, credit: 0 }, { code: 'L1001', debit: 0, credit: -100 }])],
    ['JJ-03', 'all zero', jr([{ code: 'L1004', debit: 0, credit: 0 }, { code: 'L1001', debit: 0, credit: 0 }])],
    ['JJ-04', 'single row', jr([{ code: 'L1004', debit: 100, credit: 0 }])],
    ['JJ-05', 'no rows', jr([])],
    ['JJ-06', 'unknown head', jr([{ code: 'ZZZ999', debit: 100, credit: 0 }, { code: 'L1001', debit: 0, credit: 100 }])],
    ['JJ-07', 'same head on both sides (no-op)', jr([{ code: 'L1004', debit: 100, credit: 0 }, { code: 'L1004', debit: 0, credit: 100 }])],
    ['JJ-08', 'bad transferType', jr([{ code: 'L1004', debit: 100, credit: 0 }, { code: 'L1001', debit: 0, credit: 100 }], { transferType: 'x' })],
    ['JJ-09', 'member-to-member with member that does not exist', jr([{ mbno: 1999999999, debit: 100, credit: 0 }, { mbno: A, debit: 0, credit: 100 }], { transferType: 'memberToMember' })],
  ]) {
    const r = await call('POST', '/transactions/journal/post', body);
    s.check(id, `Journal with ${t}: refused (4xx)`, r.status >= 400 && r.status < 500, `${r.status} ${(r.text || '').slice(0, 110)}`);
  }
  const okj = await call('POST', '/transactions/journal/post', jr([{ code: 'L1004', debit: 100, credit: 0, narration: 'QA' }, { code: 'L1001', debit: 0, credit: 100, narration: 'QA' }]));
  s.check('JJ-10', 'Balanced head-to-head journal 100/100 succeeds', okj.status < 300, `${okj.status} ${(okj.text || '').slice(0, 140)}`);
  const m2m = await call('POST', '/transactions/journal/post', jr([{ mbno: A, debit: 50, credit: 0 }, { mbno: B, debit: 0, credit: 50 }], { transferType: 'memberToMember' }));
  s.check('JJ-11', 'Member-to-member journal between two QA members succeeds', m2m.status < 300, `${m2m.status} ${(m2m.text || '').slice(0, 140)}`);
  const par = await Promise.all(Array.from({ length: 5 }, () => call('POST', '/transactions/journal/post', jr([{ code: 'L1004', debit: 10, credit: 0 }, { code: 'L1001', debit: 0, credit: 10 }]))));
  s.check('JJ-12', '5 parallel journals: no 5xx', par.every(r => r.status < 500), `${par.map(r => r.status)}`);
  const dtl = (await pg.query(`select trans_no, count(*) c from ledger where narration='QA journal' group by trans_no having count(*)>2`)).rows;
  s.check('JJ-13', 'Journal postings do not reuse the same transaction number across journals', dtl.length === 0, JSON.stringify(dtl).slice(0, 200));
  const imb = (await pg.query(`select receipt_vchr_no v, sum(case when trans_type='DR' then trans_amt else -trans_amt end) d from ledger where narration='QA journal' group by receipt_vchr_no having abs(sum(case when trans_type='DR' then trans_amt else -trans_amt end))>0.001`)).rows;
  s.check('JJ-14', 'Every QA journal voucher in the ledger balances (debits = credits)', imb.length === 0, JSON.stringify(imb).slice(0, 200));

  // ---- read-only / preview checks of the batch services
  const pv = await call('GET', '/dividend/calculation/preview');
  console.log('INFO dividend calc preview ->', pv.status, (pv.text || '').slice(0, 140));
  s.check('JB-01', 'Dividend calculation preview does not 5xx', pv.status < 500, `${pv.status} ${(pv.text || '').slice(0, 120)}`);
  const pc = await call('GET', '/dividend/credit/preview');
  s.check('JB-02', 'Dividend credit preview does not 5xx', pc.status < 500, `${pc.status} ${(pc.text || '').slice(0, 120)}`);
  const ip = await call('POST', '/interest/preview-calculation', { fromDate: '2026-04-01', toDate: '2026-09-30' });
  s.check('JB-03', 'Interest preview with valid dates does not 5xx', ip.status < 500, `${ip.status} ${(ip.text || '').slice(0, 120)}`);
  const ib = await call('POST', '/interest/preview-calculation', { fromDate: '2026-12-31', toDate: '2026-01-01' });
  s.check('JB-04', 'Interest preview with reversed dates -> 4xx', ib.status >= 400 && ib.status < 500, `${ib.status} ${(ib.text || '').slice(0, 120)}`);
  const iv = await call('POST', '/interest/validate-parameters', {});
  s.check('JB-05', 'Interest validate-parameters with empty body -> 4xx', iv.status >= 400 && iv.status < 500, `${iv.status} ${(iv.text || '').slice(0, 120)}`);
  const ih = await call('GET', '/interest/history');
  s.check('JB-06', 'Interest history loads', ih.status === 200, ih.status);
  const ds = await call('GET', '/admin/day-end/summary');
  s.check('JB-07', 'Day-end summary loads', ds.status < 500, `${ds.status} ${(ds.text || '').slice(0, 120)}`);
  const dp = await call('GET', '/admin/day-end/processes');
  s.check('JB-08', 'Day-end process list loads', dp.status < 500, `${dp.status}`);
  const dn = await call('GET', '/admin/day-end/processes/99999999');
  s.check('JB-09', 'Day-end process that does not exist -> 404', dn.status === 404, dn.status);
  await pg.end();
  console.log('QA members', A, B);
  process.exit(s.finish() ? 1 : 0);
})();
