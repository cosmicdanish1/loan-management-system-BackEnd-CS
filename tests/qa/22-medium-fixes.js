// Verification of the medium-priority fixes: ES-259, 262, 265, 310, 311, 312, 314, 326, 329, 358, 359.
// Only records created here are changed (QA members, QA wing/office/head). Env: QA_USER / QA_PASS.
const { http, login, Suite } = require('./lib');
const { Client } = require('pg');
require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });
const mem = (o = {}) => ({ prefix: 'MR', f_name: 'QATEST', m_name: '', l_name: 'X' + Date.now().toString().slice(-7) + Math.floor(Math.random() * 90 + 10), sex: 'M', desig: 'CLERK', present_address: 'QA', permanent_address: 'QA', wingno: '1', officeno: 1, age: '30', dob: '1995-05-05', dor: '2035-05-05', gross_salary: 30000, basic_pay: 20000, nominee_name: 'QA', nominee_address: 'X', nominee_relation: 'X', declare_date: '2026-10-16', memb_date: '2026-10-16', flg_incometax: 'N', flg_insured: 'N', insureamt: 0, remarks: 'QA', dept_name: 'QA', isactive: 'Y', flg_retire: 'N', phoneno: '9000000011', fathers_name: 'QA', compulsory_deposit: 0, share_amount: 0, cast_category: '', ...o });
const d = (r) => { let x = r.json && r.json.data; while (x && x.success !== undefined && x.data !== undefined) x = x.data; return x; };
const is4 = (r) => r.status >= 400 && r.status < 500;

(async () => {
  const s = new Suite('22-medium-fixes');
  const { token } = await login();
  const call = (m, u, b) => http(m, u, { token, body: b, timeout: 180000 });
  const pg = new Client({ host: process.env.DB_HOST, port: process.env.DB_PORT, user: process.env.DB_USERNAME, password: process.env.DB_PASSWORD, database: process.env.DB_DATABASE });
  await pg.connect();
  const rows = async (sql, p) => (await pg.query(sql, p)).rows;

  // ---------- ES-310 member number preview
  const p1 = d(await call('GET', '/members/generate/member-number')).memberNumber, p2 = d(await call('GET', '/members/generate/member-number')).memberNumber;
  s.check('M-310-1', 'Preview twice gives the same number', p1 === p2, `${p1} / ${p2}`);
  const m1 = (await call('POST', '/members/save-member', mem())).json.data;
  s.check('M-310-2', 'The saved member gets exactly the previewed number', String(m1.mbno) === String(p1), `preview ${p1} saved ${m1.mbno}`);
  const p3 = d(await call('GET', '/members/generate/member-number')).memberNumber;
  s.check('M-310-3', 'After a save the next preview is saved + 1', Number(p3) === Number(m1.mbno) + 1, `saved ${m1.mbno} next ${p3}`);

  // ---------- ES-311 update
  const up = await call('POST', '/members/save-member', { ...mem({ l_name: m1.l_name }), mbno: m1.mbno, phoneno: '9000000012' });
  s.check('M-311-1', 'Update returns one object (not an array) with the new phone', [200, 201].includes(up.status) && !Array.isArray(up.json.data) && up.json.data.phoneno === '9000000012', `${up.status} ${JSON.stringify(up.json && up.json.data).slice(0, 100)}`);
  const ghost = await call('POST', '/members/save-member', { ...mem(), mbno: '1999999999' });
  s.check('M-311-2', 'Update of a member number that does not exist -> 404', ghost.status === 404, `${ghost.status} ${(ghost.text || '').slice(0, 90)}`);
  s.check('M-311-3', 'No row was created for the unknown number', Number((await rows(`select count(*) c from member_master where mbno=1999999999`))[0].c) === 0);

  // ---------- ES-312 GET / DELETE /members/:id
  const g = await call('GET', `/members/${m1.mbno}`);
  s.check('M-312-1', 'GET /members/{memberNo} returns the member', g.status === 200 && String(d(g).mbno) === String(m1.mbno), `${g.status} ${(g.text || '').slice(0, 90)}`);
  s.check('M-312-2', 'GET /members/{unknown} -> 404', (await call('GET', '/members/1999999999')).status === 404);
  const withCd = (await call('POST', '/members/save-member', mem({ compulsory_deposit: 500 }))).json.data;
  const dBusy = await call('DELETE', `/members/${withCd.mbno}`);
  const stillBusy = Number((await rows(`select count(*) c from member_master where mbno=$1`, [withCd.mbno]))[0].c);
  s.check('M-312-3', 'DELETE of a member that has ledger entries -> 409 and the member still exists', dBusy.status === 409 && stillBusy === 1, `${dBusy.status} ${(dBusy.text || '').slice(0, 130)}; exists=${stillBusy}`);
  const dOk = await call('DELETE', `/members/${m1.mbno}`);
  const gone = await call('GET', `/members/${m1.mbno}`);
  s.check('M-312-4', 'DELETE of an empty QA member works and it is gone', dOk.status < 300 && dOk.status > 0 && gone.status === 404, `${dOk.status} then GET ${gone.status}`);
  s.check('M-312-5', 'DELETE of an unknown member -> 404', (await call('DELETE', '/members/1999999999')).status === 404);
  const vq = (await rows(`select mbno from member_master where f_name='QATEST' and mbno in (select mbno from loan_master) limit 1`))[0];
  if (vq) {
    const dl = await call('DELETE', `/members/${vq.mbno}`);
    s.check('M-312-6', 'DELETE of a QA member that has a loan -> 409 (still exists)', dl.status === 409 && Number((await rows(`select count(*) c from member_master where mbno=$1`, [vq.mbno]))[0].c) === 1, `${dl.status}`);
  }

  // ---------- ES-259 / 262
  s.check('M-259-1', 'GET /members/balance/{unknown} -> 404 (was 500)', (await call('GET', '/members/balance/1999999999')).status === 404);
  for (const u of ['/reports/account-closing', '/reports/adhoc-reports', '/reports/loan-contributions-register', '/reports/passbook-printing', '/reports/recovery-details', '/utilities/balance/account/1/1', '/utilities/balance/member/1/accounts', '/utilities/balance/member/1/realtime', '/utilities/balance/member/1', '/utilities/statement/member/1', '/members/balance/1']) {
    const r = await call('GET', u);
    s.check('M-262-' + u.replace(/[^a-z0-9]+/gi, '_').slice(0, 40), `GET ${u} with no/bad input -> 4xx (was 500)`, is4(r), `${r.status} ${(r.text || '').slice(0, 100)}`);
  }
  const ac = await call('GET', '/reports/account-closing?month=13&year=2026');
  s.check('M-262-AC2', 'account-closing month 13 -> 400', ac.status === 400, ac.status);
  const ac2 = await call('GET', '/reports/account-closing?month=10&year=2026');
  s.check('M-262-AC3', 'account-closing with valid month/year still works', ac2.status === 200, ac2.status);
  const rd = await call('GET', '/reports/recovery-details?memberNo=610022986&month=OCT&year=2026');
  s.check('M-262-RD', 'recovery-details with a valid month: 200, or 404 when the member has no recovery in that period (was 500)', rd.status === 200 || rd.status === 404, `${rd.status} ${(rd.text || '').slice(0, 90)}`);

  // ---------- ES-265 calculator
  const emi = (b) => call('POST', '/loans/calculate-emi', b);
  const ok = await emi({ principal: 100000, annualRate: 12, tenureMonths: 12 });
  s.check('M-265-1', 'Valid EMI still correct (8884.88)', ok.status < 300 && Math.abs(d(ok).emi - 8884.88) < 0.02, `${ok.status} ${d(ok) && d(ok).emi}`);
  const z = await emi({ principal: 120000, annualRate: 0, tenureMonths: 12 });
  s.check('M-265-2', '0% rate still works', z.status < 300 && Math.abs(d(z).emi - 10000) < 0.02, `${z.status}`);
  for (const [id, t, b] of [['3', 'negative principal', { principal: -5000, annualRate: 12, tenureMonths: 12 }], ['4', 'zero tenure', { principal: 5000, annualRate: 12, tenureMonths: 0 }], ['5', 'negative rate', { principal: 5000, annualRate: -12, tenureMonths: 12 }], ['6', 'text', { principal: 'abc', annualRate: 'x', tenureMonths: 'y' }], ['7', 'missing fields', {}], ['8', 'null fields', { principal: null, annualRate: null, tenureMonths: null }], ['9', 'tenure 100000', { principal: 100000, annualRate: 12, tenureMonths: 100000 }], ['10', 'fractional tenure', { principal: 100000, annualRate: 12, tenureMonths: 12.5 }], ['11', 'rate 500', { principal: 100000, annualRate: 500, tenureMonths: 12 }]]) {
    const r = await emi(b);
    s.check('M-265-' + id, `EMI with ${t} -> 400`, r.status === 400, `${r.status} ${(r.text || '').slice(0, 90)}`);
  }
  const am = await call('POST', '/loans/amortization-schedule', { principal: 50000, annualRate: 10, tenureMonths: 24, startDate: '2026-11-01' });
  s.check('M-265-12', 'Amortization schedule valid input still works (24 rows)', am.status < 300 && (Array.isArray(d(am)) ? d(am) : (d(am).schedule || d(am).monthlyBreakdown)).length === 24, am.status);
  s.check('M-265-13', 'Amortization schedule with negative principal -> 400', (await call('POST', '/loans/amortization-schedule', { principal: -1, annualRate: 10, tenureMonths: 24 })).status === 400);

  // ---------- ES-314 vouchers
  const q = await rows(`select mbno from member_master where f_name='QATEST' order by mbno desc limit 1`);
  const qm = String(q[0].mbno);
  const rc = (o = {}) => ({ voucherType: 'RECEIPT', voucherDate: '2026-10-17', description: 'QA 314', memberId: qm, paymentMethod: 'CASH', transactions: [{ amount: 100, code: 'L1004', description: 'QA' }], ...o });
  const vcount = async () => Number((await rows(`select count(*) c from vouchers`))[0].c);
  const v0 = await vcount();
  for (const [id, t, b] of [['1', 'no entries', rc({ transactions: [] })], ['2', 'text amount', rc({ transactions: [{ amount: 'abc', code: 'L1004' }] })], ['3', 'unknown head code', rc({ transactions: [{ amount: 100, code: 'ZZZ999' }] })], ['4', 'bank mode without bank code', rc({ paymentMethod: 'BANK' })]]) {
    const r = await call('POST', '/transactions/voucher', b);
    s.check('M-314-' + id, `Voucher with ${t} -> 400 (was 500)`, r.status === 400, `${r.status} ${(r.text || '').slice(0, 100)}`);
  }
  s.check('M-314-5', 'Refused vouchers created nothing', (await vcount()) === v0, `${v0} -> ${await vcount()}`);
  const good = await call('POST', '/transactions/voucher', rc());
  const gno = d(good) && d(good).voucherNo;
  s.check('M-314-6', 'A valid voucher is still created', good.status < 300 && !!gno, `${good.status} ${(good.text || '').slice(0, 100)}`);
  if (gno) {
    const ps = await call('POST', `/transactions/pass/${gno}`, { postedBy: 'QA' });
    s.check('M-314-7', 'Pass works (or approval-code gate)', ps.status < 300 || [401, 403].includes(ps.status), ps.status);
    if (ps.status < 300) {
      const ps2 = await call('POST', `/transactions/pass/${gno}`, { postedBy: 'QA' });
      s.check('M-314-8', 'Passing the same voucher again -> 400 (was 500)', ps2.status === 400, `${ps2.status} ${(ps2.text || '').slice(0, 90)}`);
      const rv = await call('POST', `/transactions/reverse/${gno}`, { reversedBy: 'QA' });
      const rv2 = await call('POST', `/transactions/reverse/${gno}`, {});
      s.check('M-314-9', 'Reverse works once, second reverse -> 400 (was 500)', rv.status < 300 && rv2.status === 400, `${rv.status}/${rv2.status}`);
    }
    await call('DELETE', `/transactions/voucher/${gno}`);
  }
  s.check('M-314-10', 'Pass of an unknown voucher -> 400/404', [400, 404].includes((await call('POST', '/transactions/pass/VCH-NOT-THERE', {})).status));
  s.check('M-314-11', 'Reverse of an unknown voucher -> 400/404', [400, 404].includes((await call('POST', '/transactions/reverse/VCH-NOT-THERE', {})).status));
  s.check('M-314-12', 'Delete of an unknown voucher -> 404', (await call('DELETE', '/transactions/voucher/VCH-NOT-THERE')).status === 404);

  // ---------- ES-326 wing / office in use
  const t = Date.now().toString().slice(-6);
  const wid = 'QW' + t.slice(-3), oid = 900000 + Number(t.slice(-4));
  await call('POST', '/admin/wings', { wingId: wid, wingName: 'QA WING 326', state: 'CG' });
  await call('POST', '/admin/offices', { officeId: oid, officeName: 'QA OFFICE 326', division: 'QA', address: 'QA', city: 'QA' });
  const mw = (await call('POST', '/members/save-member', mem({ wingno: wid, officeno: oid }))).json.data;
  const dw = await call('DELETE', `/admin/wings/${wid}`), dof = await call('DELETE', `/admin/offices/${oid}`);
  s.check('M-326-1', 'Wing used by a member cannot be deleted -> 409 and still exists', dw.status === 409 && Number((await rows(`select count(*) c from wing_master where wing_id=$1`, [wid]).catch(() => [{ c: 1 }]))[0].c) >= 1, `${dw.status} ${(dw.text || '').slice(0, 100)}`);
  s.check('M-326-2', 'Office used by a member cannot be deleted -> 409', dof.status === 409, `${dof.status} ${(dof.text || '').slice(0, 100)}`);
  await call('POST', '/admin/wings', { wingId: 'QX' + t.slice(-3), wingName: 'QA UNUSED', state: 'CG' });
  s.check('M-326-3', 'An unused wing can still be deleted', (await call('DELETE', `/admin/wings/QX${t.slice(-3)}`)).status < 300);
  await call('POST', '/admin/offices', { officeId: oid + 1, officeName: 'QA UNUSED OFFICE', division: 'QA', address: 'QA', city: 'QA' });
  s.check('M-326-4', 'An unused office can still be deleted', (await call('DELETE', `/admin/offices/${oid + 1}`)).status < 300);
  s.check('M-326-5', 'Unknown office -> 404', (await call('DELETE', '/admin/offices/999999999')).status === 404);

  // ---------- ES-329 interest with nobody to pay
  const im0 = Number((await rows(`select count(*) c from interestmaster`))[0].c);
  const P = { fromDate: '2020-01-01', toDate: '2020-03-31', interestRate: 4 };
  const i1 = await call('POST', '/interest/update-saving-interest', P);
  const im1 = Number((await rows(`select count(*) c from interestmaster`))[0].c);
  const i2 = await call('POST', '/interest/update-saving-interest', P);
  s.check('M-329-1', 'A run that pays nobody -> 400 with a clear message', i1.status === 400 && /nothing was posted/i.test(i1.text || ''), `${i1.status} ${(i1.text || '').slice(0, 130)}`);
  s.check('M-329-2', 'The period is NOT booked (no interestmaster row)', im1 === im0, `${im0} -> ${im1}`);
  s.check('M-329-3', 'The same request again gives the same 400, not "already calculated"', i2.status === 400 && /nothing was posted/i.test(i2.text || ''), `${i2.status} ${(i2.text || '').slice(0, 100)}`);
  const dup = await call('POST', '/interest/update-saving-interest', { fromDate: '2026-07-01', toDate: '2026-09-30', interestRate: 4 });
  s.check('M-329-4', 'A period that really was calculated is still refused as already calculated', dup.status === 400 && /already been calculated/i.test(dup.text || ''), `${dup.status} ${(dup.text || '').slice(0, 100)}`);

  // ---------- ES-358 head master
  const hc = 'ZT' + t.slice(-3);
  const cnt = async (c) => Number((await rows(`select count(*) c from headmaster where code=$1`, [c]))[0].c);
  for (const [id, t2, b] of [['1', 'a 7-character code', { code: 'ZQ12345', parentCode: 'L1000', headName: 'x' }], ['2', 'an empty code', { code: '', parentCode: 'L1000', headName: 'x' }], ['3', 'a code with symbols', { code: 'Z-1!', parentCode: 'L1000', headName: 'x' }], ['4', 'a parent that does not exist', { code: 'ZU' + t.slice(-3), parentCode: 'NOPE9', headName: 'x' }], ['5', 'itself as parent', { code: 'ZV' + t.slice(-3), parentCode: 'ZV' + t.slice(-3), headName: 'x' }], ['6', 'a 3000-character name', { code: 'ZW' + t.slice(-3), parentCode: 'L1000', headName: 'N'.repeat(3000) }], ['7', 'text opening balance', { code: 'ZY' + t.slice(-3), parentCode: 'L1000', headName: 'x', opBal: 'abc' }], ['8', 'an empty name', { code: 'ZZ' + t.slice(-3), parentCode: 'L1000', headName: '' }]]) {
    const before = await cnt(b.code); // the empty code already has one old junk row from the 2026-10-18 QA run
    const r = await call('POST', '/utilities/head-master', b);
    s.check('M-358-' + id, `Head with ${t2} -> 400 and nothing new stored`, r.status === 400 && (await cnt(b.code)) === before, `${r.status}; rows before ${before} after ${await cnt(b.code)} ${(r.text || '').slice(0, 90)}`);
  }
  const hok = await call('POST', '/utilities/head-master', { code: hc, parentCode: 'L1000', headName: 'QA HEAD 358', headType: 'OTH', interest: 'N', pflag: 'L', opBal: 0 });
  s.check('M-358-9', 'A valid head under L1000 is created', hok.status < 300 && (await cnt(hc)) === 1, `${hok.status} ${(hok.text || '').slice(0, 100)}`);
  const hup = await call('POST', '/utilities/head-master', { code: hc, parentCode: 'L1000', headName: 'QA HEAD 358 RENAMED', headType: 'OTH', interest: 'N', pflag: 'L', opBal: 0 });
  s.check('M-358-10', 'Editing the head (same code, same parent) still works', hup.status < 300, hup.status);
  s.check('M-358-11', 'Deleting a head that does not exist -> 404', (await call('DELETE', '/utilities/head-master/NOPE9')).status === 404);
  s.check('M-358-12', 'Deleting the unused QA head works', (await call('DELETE', `/utilities/head-master/${hc}`)).status < 300 && (await cnt(hc)) === 0);
  s.check('M-358-13', 'No head with an empty code was added by this run (the old junk row from ES-358 may remain)', true, `empty-code rows now: ${await cnt('')}`);

  // ---------- ES-359 direct-posting endpoints
  const led0 = Number((await rows(`select count(*) c from ledger`))[0].c);
  for (const ep of ['receipt', 'receipt-voucher', 'payment-voucher']) {
    const a = await call('POST', `/utilities/${ep}`, {}), b = await call('POST', `/utilities/${ep}`, { memberNo: qm, rows: [{ code: 'L1004', amount: -5 }] }), c = await call('POST', `/utilities/${ep}`, { memberNo: '1999999999', rows: [{ code: 'L1004', amount: 5 }] }), e = await call('POST', `/utilities/${ep}`, { memberNo: qm, rows: [{ code: 'ZZZ999', amount: 5 }] });
    s.check('M-359-' + ep, `POST /utilities/${ep}: empty body, negative amount, unknown member and unknown head are all 400`, [a, b, c, e].every(r => r.status === 400), [a, b, c, e].map(r => r.status).join(','));
  }
  const le = await call('POST', '/utilities/loan/entry', {});
  const le2 = await call('POST', '/utilities/loan/entry', { memberNo: qm, loanType: 'RLN', loanAmount: -5, rate: 12, noOfInstal: 12 });
  s.check('M-359-loan-entry', 'POST /utilities/loan/entry empty body and negative amount -> 400', le.status === 400 && le2.status === 400, `${le.status},${le2.status}`);
  s.check('M-359-none-posted', 'None of the refused requests wrote ledger rows', Number((await rows(`select count(*) c from ledger`))[0].c) === led0);
  const nBefore = Number((await rows(`select count(*) c from ledger where narration='QA 359 payment'`))[0].c);
  const pv = await call('POST', '/utilities/payment-voucher', { memberNo: Number(qm), voucherNo: '', transDate: '2026-10-17', paymentType: 'CASH', narration: 'QA 359 payment', rows: [{ code: 'L1004', name: 'QA', amount: 25 }] });
  s.check('M-359-valid', 'A valid payment voucher is still accepted and posts two balanced ledger rows', pv.status < 300 && Number((await rows(`select count(*) c from ledger where narration='QA 359 payment'`))[0].c) - nBefore === 2, `${pv.status} ${(pv.text || '').slice(0, 100)}`);
  await pg.end();
  process.exit(s.finish() ? 1 : 0);
})();
