// Utilities module (43 routes): reads, validation, and writes on records this suite creates (QA heads, QA members).
// Global settings routes (business-rules, system-settings, head-opening-balance, financial-year/transfer-entries, rebuild-tree) are only READ,
// except business-rules which is round-tripped with its own current value (read -> write same -> read). Env: QA_USER / QA_PASS.
const { http, login, Suite } = require('./lib');
const { Client } = require('pg');
require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });
const mem = () => ({ prefix: 'MR', f_name: 'QATEST', m_name: '', l_name: 'U' + Date.now().toString().slice(-6), sex: 'M', desig: 'CLERK', present_address: 'QA', permanent_address: 'QA', wingno: '1', officeno: 1, age: '30', dob: '1995-05-05', dor: '2035-05-05', gross_salary: 30000, basic_pay: 20000, nominee_name: 'QA', nominee_address: 'X', nominee_relation: 'X', declare_date: '2026-10-16', memb_date: '2026-10-16', flg_incometax: 'N', flg_insured: 'N', insureamt: 0, remarks: 'QA', dept_name: 'QA', isactive: 'Y', flg_retire: 'N', phoneno: '9000000001', fathers_name: 'QA', compulsory_deposit: 0, share_amount: 0, cast_category: '' });
const d = (r) => { let x = r.json && r.json.data; while (x && x.success !== undefined && x.data !== undefined) x = x.data; return x; };

(async () => {
  const s = new Suite('19-utilities');
  const { token } = await login();
  const call = (m, u, b) => http(m, u, { token, body: b, timeout: 120000 });
  const pg = new Client({ host: process.env.DB_HOST, port: process.env.DB_PORT, user: process.env.DB_USERNAME, password: process.env.DB_PASSWORD, database: process.env.DB_DATABASE });
  await pg.connect();
  const rows = async (sql, p) => (await pg.query(sql, p)).rows;

  // ---------------- reads: status, time, shape
  const reads = [['UT-01', '/utilities/calculator/loan-rates'], ['UT-02', '/utilities/sb-accounts/holders'], ['UT-03', '/utilities/rd-accounts/holders'], ['UT-04', '/utilities/head-master'], ['UT-05', '/utilities/divisions'], ['UT-06', '/utilities/financial-years'], ['UT-07', '/utilities/deposit-loan-slabs?type=RLN'], ['UT-08', '/utilities/demand-print-order'], ['UT-09', '/utilities/business-rules'], ['UT-10', '/utilities/head-opening-balance?yearcode=1'], ['UT-11', '/utilities/preferences'], ['UT-12', '/utilities/financial-year/current']];
  for (const [id, u] of reads) {
    const r = await call('GET', u);
    s.check(id, `GET ${u} -> 200 in under 3 s with data`, r.status === 200 && r.ms < 3000 && d(r) !== undefined && d(r) !== null, `${r.status} ${r.ms}ms`);
  }
  const lr = d(await call('GET', '/utilities/calculator/loan-rates')) || [];
  const rbBusrules = (await rows(`select rlnrate, alnrate, elnrate from busrules order by srno desc limit 1`).catch(() => []))[0];
  s.check('UT-13', 'Loan-rates calculator shows RLN, ALN and ELN with positive rates and limits', ['RLN', 'ALN', 'ELN'].every(c => lr.some(x => x.code === c && x.rate > 0 && x.maxAmount > 0)), JSON.stringify(lr.map(x => [x.code, x.rate, x.maxAmount])));
  const cur = d(await call('GET', '/utilities/financial-year/current'));
  const fys = d(await call('GET', '/utilities/financial-years')) || [];
  const today = new Date().toISOString().slice(0, 10);
  const real = (await rows(`select yearcode from yearend where start_date <= $1::date and end_date >= $1::date order by yearcode limit 1`, [today]))[0];
  s.check('UT-14', `'Current financial year' is the year that contains today (${today}), not just the highest yearcode`, cur && real && Number(cur.yearcode) === Number(real.yearcode), `API says yearcode ${cur && cur.yearcode}; the year containing today is ${real && real.yearcode}; years: ${fys.map(f => f.yearcode + '=' + f.label).join(' | ')}`);
  const sl = await call('GET', '/utilities/deposit-loan-slabs?type=RLN');
  const dpo = await call('GET', '/utilities/demand-print-order');
  s.check('UT-15', 'Deposit/Loan Slab and Demand Print Order screens have data (legacy had DEMANDPRINTORDER 6 rows)', (d(sl) || []).length > 0 && (d(dpo) || []).length > 0, `slabs ${(d(sl) || []).length}, print order ${(d(dpo) || []).length}`);

  // ---------------- member-based reads with bad input
  const memberReads = ['/utilities/calculator/member-eligibility?memberNo=', '/utilities/member/balance?memberNo=', '/utilities/fd-accounts/member?memberNo=', '/utilities/dividend/pending?memberNo='];
  for (const [i, base] of memberReads.entries()) {
    for (const [tag, v] of [['unknown member', '1999999999'], ['text', 'abc'], ['SQL text', "1' OR '1'='1"], ['empty', ''], ['huge number', '9'.repeat(40)]]) {
      const r = await call('GET', base + encodeURIComponent(v));
      s.check(`UT-16-${i}-${tag.replace(/ /g, '')}`, `GET ${base.split('?')[0].replace('/utilities/', '')} with ${tag}: 4xx or empty result (no 5xx)`, r.status > 0 && r.status < 500, `${r.status} ${(r.text || '').slice(0, 100)}`);
    }
  }
  for (const [id, u] of [['UT-17', '/utilities/head-balance/ZZZ999'], ['UT-18', "/utilities/head-balance/L1004'%20OR%201=1"], ['UT-19', '/utilities/head-opening-balance?yearcode=999'], ['UT-20', '/utilities/head-opening-balance?yearcode=abc'], ['UT-21', '/utilities/deposit-loan-slabs?type=ZZZ'], ['UT-22', '/utilities/system-settings/nonexistent_key']]) {
    const r = await call('GET', u);
    s.check(id, `GET ${u}: handled without 5xx`, r.status > 0 && r.status < 500, `${r.status} ${(r.text || '').slice(0, 100)}`);
  }
  const hb = d(await call('GET', '/utilities/head-balance/L1004'));
  const gl = (await rows(`select coalesce(sum(case when trans_type='CR' then trans_amt else -trans_amt end),0) v from ledger where code='L1004'`))[0].v;
  s.check('UT-23', 'Head balance L1004 equals the ledger net for that head', hb && Math.abs(Math.abs(hb.balance) - Math.abs(gl)) < 1, `API ${hb && hb.balance} vs ledger CR-DR ${gl}`);

  // ---------------- preferences (own)
  const pf = d(await call('GET', '/utilities/preferences'));
  const p1 = await call('PATCH', '/utilities/preferences', { fontScale: 1.1 });
  const p2 = await call('PATCH', '/utilities/preferences', { fontScale: 99 });
  const p3 = await call('PATCH', '/utilities/preferences', { interfaceMode: 'purple-banana' });
  const p4 = await call('PATCH', '/utilities/preferences', { unknownField: 1 });
  await call('PATCH', '/utilities/preferences', { fontScale: pf && pf.fontScale });
  s.check('UT-24', 'Preferences: valid change saved', p1.status < 300 && p1.status > 0, p1.status);
  s.check('UT-25', 'Preferences: fontScale 99 refused', p2.status === 400, `${p2.status} ${(p2.text || '').slice(0, 80)}`);
  s.check('UT-26', 'Preferences: invalid interfaceMode refused', p3.status === 400, `${p3.status}`);
  s.check('UT-27', 'Preferences: unknown field refused', p4.status === 400, `${p4.status}`);

  // ---------------- business rules: read -> write same -> read
  const br0 = await call('GET', '/utilities/business-rules');
  const rules0 = d(br0);
  if (rules0 && typeof rules0 === 'object') {
    const save = await call('POST', '/utilities/business-rules', rules0);
    const rules1 = d(await call('GET', '/utilities/business-rules'));
    const diff = Object.keys(rules0).filter(k => String(rules0[k]) !== String(rules1 && rules1[k]));
    s.check('UT-28', 'Business rules: saving the unchanged rules does not change any value (round trip)', save.status < 300 && diff.length === 0, `${save.status}; changed: ${diff.slice(0, 6).map(k => `${k}: ${rules0[k]} -> ${rules1 && rules1[k]}`).join('; ')}`);
    const bad = await call('POST', '/utilities/business-rules', { ...rules0, RULE_LOAN_R_RATE: '-5' });
    const chk = d(await call('GET', '/utilities/business-rules'));
    const accepted = chk && Number(chk.RULE_LOAN_R_RATE) === -5;
    if (accepted) await call('POST', '/utilities/business-rules', rules0); // restore immediately
    s.check('UT-29', 'Business rules: a NEGATIVE loan rate is refused (restored if it was accepted)', bad.status >= 400 && !accepted, `${bad.status}; stored value was ${chk && chk.RULE_LOAN_R_RATE}`);
    const bad2 = await call('POST', '/utilities/business-rules', { ...rules0, RULE_LOAN_R_RATE: 'abc' });
    const chk2 = d(await call('GET', '/utilities/business-rules'));
    const acc2 = chk2 && (String(chk2.RULE_LOAN_R_RATE) === 'abc' || !Number.isFinite(Number(chk2.RULE_LOAN_R_RATE)));
    if (acc2) await call('POST', '/utilities/business-rules', rules0);
    s.check('UT-30', 'Business rules: a TEXT loan rate is refused (restored if it was accepted)', bad2.status >= 400 && !acc2, `${bad2.status}; stored ${chk2 && chk2.RULE_LOAN_R_RATE}`);
    const restored = d(await call('GET', '/utilities/business-rules'));
    s.check('UT-31', 'Business rules end this suite exactly as they started', Object.keys(rules0).every(k => String(rules0[k]) === String(restored && restored[k])), 'compared all keys');
  } else s.check('UT-28', 'Business rules readable', false, br0.status);

  // ---------------- head master (QA heads)
  const code = 'ZQ' + Date.now().toString().slice(-5), code2 = 'ZR' + Date.now().toString().slice(-5);
  const hm = await call('POST', '/utilities/head-master', { code, parentCode: 'L1000', headName: 'QA HEAD ONE', headType: 'OTH', interest: 'N', pflag: 'L', opBal: 0 });
  s.check('UT-32', 'Create QA head under an existing parent', hm.status < 300 && hm.status > 0, `${hm.status} ${(hm.text || '').slice(0, 120)}`);
  const hbad = [['UT-33', 'parent that does not exist', { code: code2, parentCode: 'NOPE999', headName: 'QA HEAD TWO' }], ['UT-34', 'empty code', { code: '', parentCode: 'L1000', headName: 'x' }], ['UT-35', 'head name of 3000 characters', { code: code2, parentCode: 'L1000', headName: 'N'.repeat(3000) }], ['UT-36', 'a head that is its own parent', { code: code2, parentCode: code2, headName: 'loop' }], ['UT-37', 'text opening balance', { code: code2, parentCode: 'L1000', headName: 'QA HEAD TWO', opBal: 'abc' }]];
  for (const [id, t, b] of hbad) {
    const r = await call('POST', '/utilities/head-master', b);
    const made = (await rows(`select count(*) c from headmaster where code=$1`, [b.code]))[0].c;
    if (Number(made) > 0 && b.code) await call('DELETE', `/utilities/head-master/${b.code}`); // own QA code only
    s.check(id, `Head with ${t}: refused (4xx) and not stored`, r.status >= 400 && r.status < 500 && Number(made) === 0, `${r.status}; stored=${made}; ${(r.text || '').slice(0, 90)}`);
  }
  const dupe = await call('POST', '/utilities/head-master', { code, parentCode: 'L1000', headName: 'QA HEAD ONE RENAMED' });
  console.log('INFO second POST of the same code is an update (by design: Add or update) ->', dupe.status);
  // protect: delete head with a ledger posting
  const m = (await call('POST', '/members/save-member', mem())).json.data.mbno;
  const j = await call('POST', '/transactions/journal/post', { transferType: 'headToHead', narration: 'QA head use', rows: [{ code, debit: 10, credit: 0 }, { code: 'L1004', debit: 0, credit: 10 }] });
  const del1 = await call('DELETE', `/utilities/head-master/${code}`);
  s.check('UT-38', 'Deleting a head that has ledger postings is refused (409)', j.status < 300 ? (del1.status === 409 || del1.status === 400) : true, `journal ${j.status}; delete ${del1.status} ${(del1.text || '').slice(0, 100)}`);
  const del2 = await call('DELETE', '/utilities/head-master/L1004');
  const stillThere = (await rows(`select count(*) c from headmaster where code='L1004'`))[0].c;
  s.check('UT-39', 'Deleting a real head with children/postings (L1004) is refused and the head still exists', del2.status >= 400 && Number(stillThere) === 1, `${del2.status}; exists=${stillThere}`);
  const del3 = await call('DELETE', '/utilities/head-master/NOPE_NOT_THERE');
  s.check('UT-40', 'Deleting a head that does not exist -> 404', del3.status === 404, `${del3.status}`);
  const code3 = 'ZS' + Date.now().toString().slice(-5);
  await call('POST', '/utilities/head-master', { code: code3, parentCode: 'L1000', headName: 'QA DELETE ME', headType: 'OTH', interest: 'N', pflag: 'L', opBal: 0 });
  const del4 = await call('DELETE', `/utilities/head-master/${code3}`);
  s.check('UT-41', 'Deleting an unused own QA head works', del4.status < 300, `${del4.status}`);

  // ---------------- balance transfer between two QA members
  const a = (await call('POST', '/members/save-member', mem())).json.data.mbno, b = (await call('POST', '/members/save-member', mem())).json.data.mbno;
  const bt = (o = {}) => call('POST', '/utilities/balance-transfer', { fromAccount: a, toAccount: b, amount: 100, transferDate: '2026-10-17', description: 'QA transfer', ...o });
  for (const [id, t, o] of [['UT-42', 'amount 0', { amount: 0 }], ['UT-43', 'negative amount', { amount: -100 }], ['UT-44', 'text amount', { amount: 'abc' }], ['UT-45', 'same from and to', { toAccount: a }], ['UT-46', 'unknown to-account', { toAccount: '1999999999' }], ['UT-47', 'invalid date', { transferDate: 'xx' }], ['UT-48', 'amount 1e12', { amount: 1e12 }]]) {
    const before = (await rows(`select count(*) c from ledger where mbno in ($1,$2)`, [a, b]))[0].c;
    const r = await bt(o);
    const after = (await rows(`select count(*) c from ledger where mbno in ($1,$2)`, [a, b]))[0].c;
    s.check(id, `Balance transfer with ${t}: refused (4xx), nothing posted`, r.status >= 400 && r.status < 500 && before === after, `${r.status}; ledger rows ${before} -> ${after}; ${(r.text || '').slice(0, 80)}`);
  }
  const ok = await bt();
  const legs = await rows(`select trans_type, trans_amt, mbno from ledger where narration='QA transfer' and mbno in ($1,$2) order by ledgerid`, [a, b]);
  s.check('UT-49', 'Valid transfer of 100 posts one DR on the sender and one CR on the receiver', ok.status < 300 && legs.length === 2 && legs.some(l => l.trans_type === 'DR' && String(l.mbno) === String(a)) && legs.some(l => l.trans_type === 'CR' && String(l.mbno) === String(b)), `${ok.status} ${JSON.stringify(legs)}`);

  // ---------------- receipt / payment endpoints: empty and bad bodies
  for (const ep of ['receipt', 'receipt-voucher', 'payment-voucher', 'loan/entry']) {
    const r = await call('POST', `/utilities/${ep}`, {});
    const r2 = await call('POST', `/utilities/${ep}`, { amount: -5, memberNo: 'abc' });
    s.check(`UT-50-${ep}`, `POST /utilities/${ep} with empty and junk bodies: 4xx, never 5xx`, r.status >= 400 && r.status < 500 && r2.status >= 400 && r2.status < 500, `empty ${r.status} ${(r.text || '').slice(0, 70)} | junk ${r2.status}`);
  }
  await pg.end();
  console.log('QA leftovers: head', code, '(has a QA journal posting), members', m, a, b);
  process.exit(s.finish() ? 1 : 0);
})();
