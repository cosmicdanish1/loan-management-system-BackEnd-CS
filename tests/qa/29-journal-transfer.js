// Journal / Transfer Entry window: create-PENDING-voucher validation, data integrity, concurrency, Pass + Reverse effect.
// Creates PENDING vouchers tagged "QA JT" (test data); the ones that get passed are reversed again; leftovers are rejected at the end.
// Login: QA_USER / QA_PASS env (see lib.js).
const { http, login, Suite } = require('./lib');
const { Client } = require('pg');
require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });

(async () => {
  const s = new Suite('29-journal-transfer');
  const { token } = await login();
  if (!token) { console.log('login failed'); process.exit(2); }
  const call = (m, u, b) => http(m, u, { token, body: b });
  const pg = new Client({ host: process.env.DB_HOST, port: process.env.DB_PORT, user: process.env.DB_USERNAME, password: process.env.DB_PASSWORD, database: process.env.DB_DATABASE });
  await pg.connect();
  const created = [];
  const post = async (body) => {
    const r = await call('POST', '/transactions/journal/post', body);
    const v = (r.json && r.json.data && r.json.data.voucherNo) || (r.json && r.json.voucherNo);
    if (v) created.push(v);
    return { r, v };
  };
  const count = async () => Number((await pg.query('select count(*) n from vouchers where "voucherType"=\'JOURNAL\'')).rows[0].n);

  // fixtures: plain heads (not loan heads) and two test members
  const heads = (await pg.query("select trim(code) code from headmaster where trim(code) not in ('A1002','A1047') and trim(code) ~ '^[A-Z][0-9]{4}$' order by code limit 3")).rows.map(r => r.code);
  const mem = (await pg.query('select mbno from member_master where mbno between 900000001 and 900016999 order by mbno limit 2')).rows.map(r => Number(r.mbno));
  const [H1, H2] = heads;
  const [M1, M2] = mem;
  console.log('fixtures', heads.join(','), mem.join(','));
  const ok = (o = {}) => ({ transferType: 'headToHead', narration: 'QA JT', rows: [{ code: H1, debit: 100, credit: 0 }, { code: H2, debit: 0, credit: 100 }], ...o });

  // ---- 1. validation: each of these must be refused with 4xx and create nothing
  const bad = [
    ['JT-01', 'no rows', ok({ rows: [] })],
    ['JT-02', 'unbalanced', ok({ rows: [{ code: H1, debit: 100, credit: 0 }, { code: H2, debit: 0, credit: 90 }] })],
    ['JT-03', 'negative amounts', ok({ rows: [{ code: H1, debit: -100, credit: 0 }, { code: H2, debit: 0, credit: -100 }] })],
    ['JT-04', 'row with both debit and credit', ok({ rows: [{ code: H1, debit: 100, credit: 100 }, { code: H2, debit: 0, credit: 0 }] })],
    ['JT-05', 'unknown head code', ok({ rows: [{ code: 'ZZ999', debit: 100, credit: 0 }, { code: H2, debit: 0, credit: 100 }] })],
    ['JT-06', 'unknown member', ok({ transferType: 'memberToMember', rows: [{ mbno: 1999999999, code: H1, debit: 100, credit: 0 }, { mbno: M1, code: H2, debit: 0, credit: 100 }] })],
    ['JT-07', 'same head and same member on both sides', ok({ rows: [{ code: H1, debit: 100, credit: 0 }, { code: H1, debit: 0, credit: 100 }] })],
    ['JT-08', 'only one posting row', ok({ rows: [{ code: H1, debit: 100, credit: 0 }, { code: H2, debit: 0, credit: 0 }] })],
    ['JT-09', 'zero total', ok({ rows: [{ code: H1, debit: 0, credit: 0 }, { code: H2, debit: 0, credit: 0 }] })],
    ['JT-10', 'invalid transferType', ok({ transferType: 'cashToCash' })],
    ['JT-11', 'amounts that are not numbers (abc)', ok({ rows: [{ code: H1, debit: 'abc', credit: 0 }, { code: H2, debit: 0, credit: 100 }] })],
    ['JT-12', 'row without head code', ok({ rows: [{ debit: 100, credit: 0 }, { code: H2, debit: 0, credit: 100 }] })],
    ['JT-13', 'memberToMember where no row has a member', ok({ transferType: 'memberToMember', rows: [{ code: H1, debit: 100, credit: 0 }, { code: H2, debit: 0, credit: 100 }] })],
    ['JT-14', 'debit and credit differ by 0.009 (must not stage an unbalanced entry)', ok({ rows: [{ code: H1, debit: 100, credit: 0 }, { code: H2, debit: 0, credit: 99.991 }] })],
    ['JT-15', 'amount with more than 2 decimals (100.005)', ok({ rows: [{ code: H1, debit: 100.005, credit: 0 }, { code: H2, debit: 0, credit: 100.005 }] })],
    ['JT-16', 'narration longer than the 100-char column (clean 4xx, not 500)', ok({ narration: 'N'.repeat(150) })],
    ['JT-17', 'cheque number longer than the 10-char column (clean 4xx, not 500)', ok({ chequeNo: '123456789012345' })],
    ['JT-18', 'row narration longer than 100 chars', ok({ rows: [{ code: H1, debit: 100, credit: 0, narration: 'R'.repeat(150) }, { code: H2, debit: 0, credit: 100 }] })],
    ['JT-19', 'absurd amount (1e15)', ok({ rows: [{ code: H1, debit: 1e15, credit: 0 }, { code: H2, debit: 0, credit: 1e15 }] })],
    ['JT-20', 'non-numeric RD/SD reference (refused, not silently dropped to 0)', ok({ rows: [{ code: H1, debit: 100, credit: 0, rdSdSrNo: 'RD-ABC' }, { code: H2, debit: 0, credit: 100 }] })],
    ['JT-21', 'non-integer member number', ok({ transferType: 'memberToMember', rows: [{ mbno: 1.5, code: H1, debit: 100, credit: 0 }, { mbno: M1, code: H2, debit: 0, credit: 100 }] })],
    ['JT-22', 'missing narration', (() => { const b = ok(); delete b.narration; return b; })()],
  ];
  for (const [id, title, body] of bad) {
    const before = await count();
    const { r } = await post(body);
    const after = await count();
    s.check(id, `${title}: refused with 4xx and nothing created`, r.status >= 400 && r.status < 500 && before === after, `${r.status}; vouchers ${before}->${after}; ${(r.text || '').slice(0, 120)}`);
  }

  // ---- 2. a valid entry is staged PENDING and moves nothing
  const ledBefore = Number((await pg.query('select count(*) n from ledger')).rows[0].n);
  const good = await post(ok({ narration: 'QA JT valid', chequeNo: 'CHQ123' }));
  s.check('JT-30', 'valid head-to-head entry -> 2xx with a J voucher number', good.r.status < 300 && /^J/.test(good.v || ''), `${good.r.status} ${(good.r.text || '').slice(0, 120)}`);
  const hdr = (await pg.query('select "status","voucherType","totalAmount" from vouchers where "voucherNumber"=$1', [good.v])).rows[0] || {};
  const lines = (await pg.query('select trans_type, trans_amt, pass_flag, code, mbno from transactions where receipt_vchr_no=$1 order by trans_no', [good.v])).rows;
  const ledAfter = Number((await pg.query('select count(*) n from ledger')).rows[0].n);
  s.check('JT-31', 'staged as PENDING, 2 lines pass_flag N, ledger untouched', hdr.status === 'PENDING' && lines.length === 2 && lines.every(l => l.pass_flag === 'N') && ledBefore === ledAfter, JSON.stringify({ hdr, lines: lines.length, ledBefore, ledAfter }));

  // ---- 3. member-to-member stores each row's own member
  const m2m = await post(ok({ transferType: 'memberToMember', rows: [{ mbno: M1, code: H1, debit: 100, credit: 0 }, { mbno: M2, code: H2, debit: 0, credit: 100 }] }));
  const ml = (await pg.query('select mbno from transactions where receipt_vchr_no=$1 order by trans_no', [m2m.v])).rows.map(l => Number(l.mbno));
  s.check('JT-32', "member-to-member entry stores each row's own member", !!m2m.v && ml[0] === M1 && ml[1] === M2, JSON.stringify(ml));

  // ---- 4. voucher detail for the dropdown
  const det = (await call('GET', '/transactions/voucher/' + good.v)).json;
  const d = det && det.data;
  s.check('JT-33', 'voucher detail returns the 2 staged lines (breakdown)', !!d && Array.isArray(d.breakdown) && d.breakdown.length === 2, JSON.stringify((d && d.breakdown) || []).slice(0, 200));
  s.check('JT-34', 'breakdown lines carry the member number so the grid can be refilled', !!d && !!d.breakdown && d.breakdown.every(b => 'mbno' in b || 'memberNo' in b), Object.keys((d && d.breakdown && d.breakdown[0]) || {}).join(','));

  // ---- 5. concurrency: 6 parallel saves get 6 distinct voucher numbers
  const par = await Promise.all(Array.from({ length: 6 }, () => post(ok({ narration: 'QA JT parallel' }))));
  const nums = par.map(p => p.v).filter(Boolean);
  s.check('JT-35', '6 parallel saves -> 6 distinct voucher numbers', nums.length === 6 && new Set(nums).size === 6, nums.join(','));

  // ---- 6. pass -> ledger balanced, reverse -> undone
  const pass = await call('POST', '/transactions/pass/' + good.v, {});
  if (pass.status === 0) console.log('PASS CALL FAILED:', pass.error);
  const lg = (await pg.query('select trans_type, trans_amt from ledger where receipt_vchr_no=$1', [good.v])).rows;
  const dr = lg.filter(l => l.trans_type === 'DR').reduce((a, l) => a + Number(l.trans_amt), 0);
  const cr = lg.filter(l => l.trans_type === 'CR').reduce((a, l) => a + Number(l.trans_amt), 0);
  s.check('JT-36', 'Pass Transactions posts 2 ledger rows with debit = credit', pass.status > 0 && pass.status < 300 && lg.length === 2 && dr === cr && dr === 100, `${pass.status} rows ${lg.length} dr ${dr} cr ${cr} ${(pass.text || '').slice(0, 100)}`);
  const rev = await call('POST', '/transactions/reverse/' + good.v, {});
  const lg2 = (await pg.query('select trans_type, trans_amt from ledger where receipt_vchr_no=$1', [good.v])).rows;
  const net = lg2.reduce((a, l) => a + (l.trans_type === 'CR' ? 1 : -1) * Number(l.trans_amt), 0);
  const st = (await pg.query('select status from vouchers where "voucherNumber"=$1', [good.v])).rows[0];
  s.check('JT-37', 'Reverse removes the ledger rows and puts the voucher back to PENDING', rev.status > 0 && rev.status < 300 && lg2.length === 0 && net === 0 && st && st.status === 'PENDING', `${rev.status} net ${net} rows ${lg2.length} ${(rev.text || '').slice(0, 100)}`);

  // ---- 6b. loan head: pass moves the member's regular-loan balance, reverse restores it
  const bal = async () => { const r = (await pg.query('select regularloan from member_balances where mbno=$1', [M1])).rows[0]; return r ? Number(r.regularloan || 0) : null; };
  const b0 = await bal();
  if (b0 === null) {
    s.check('JT-38', 'loan-head journal moves member_balances.regularloan (skipped: test member has no member_balances row)', true, 'skipped');
  } else {
    const lj = await post(ok({ transferType: 'memberToMember', narration: 'QA JT loan head', rows: [{ mbno: M1, code: 'A1002', debit: 100, credit: 0 }, { mbno: M1, code: H1, debit: 0, credit: 100 }] }));
    const p = await call('POST', '/transactions/pass/' + lj.v, {});
    const b1 = await bal();
    const rv = await call('POST', '/transactions/reverse/' + lj.v, {});
    const b2 = await bal();
    s.check('JT-38', 'loan-head journal: Pass raises regularloan by 100, Reverse restores it', p.status > 0 && p.status < 300 && rv.status > 0 && rv.status < 300 && b1 === b0 + 100 && b2 === b0, `before ${b0} passed ${b1} reversed ${b2}; pass ${p.status} reverse ${rv.status}`);
  }

  // ---- 6c. business case: refund of excess principal. Member + emergency-loan head on one row, Cash in Hand (no member) on the other.
  const ebal = async () => { const r = (await pg.query('select emergency_loan_balance e from member_balances where mbno=$1', [M2])).rows[0]; return r ? Number(r.e || 0) : null; };
  const e0 = await ebal();
  const refund = await post({ transferType: 'memberToMember', narration: 'QA JT excess principal refund', rows: [{ mbno: M2, code: 'A1047', debit: 5000, credit: 0 }, { code: 'A1001', debit: 0, credit: 5000 }] });
  s.check('JT-39', 'excess-principal refund (member on loan-head row, Cash in Hand row without member) is accepted', refund.r.status < 300 && !!refund.v, `${refund.r.status} ${(refund.r.text || '').slice(0, 120)}`);
  if (refund.v && e0 !== null) {
    const rl = (await pg.query('select code, mbno, acc_type, trans_type from transactions where receipt_vchr_no=$1 order by trans_no', [refund.v])).rows;
    const p2 = await call('POST', '/transactions/pass/' + refund.v, {});
    const e1 = await ebal();
    const lgr = (await pg.query('select code, mbno, trans_type, trans_amt from ledger where receipt_vchr_no=$1 order by trans_no', [refund.v])).rows;
    const r2 = await call('POST', '/transactions/reverse/' + refund.v, {});
    const e2 = await ebal();
    s.check('JT-40', 'refund: staged loan row is ALN with the member, cash row has none; Pass posts DR A1047 / CR A1001 and moves the emergency-loan balance by 5000; Reverse restores it',
      rl[0].acc_type === 'ALN' && Number(rl[0].mbno) === M2 && rl[1].mbno === null && p2.status > 0 && p2.status < 300 && lgr.length === 2 && e1 === e0 + 5000 && r2.status > 0 && r2.status < 300 && e2 === e0,
      JSON.stringify({ rl, lgr, e0, e1, e2, pass: p2.status, rev: r2.status }));
  }

  // ---- 6d. legacy patterns (ES-567 / ES-568): loan settled from shares + CD, and a head-to-head transfer
  const today = new Date().toISOString().slice(0, 10);
  const snap = async () => {
    const b = (await pg.query('select shares, compulsory_deposit cd, emergency_loan_balance e from member_balances where mbno=$1', [M1])).rows[0];
    const l = (await call('GET', `/member-ledger/detail-columnar?memberNumber=${M1}&fromDate=2026-01-01&toDate=${today}`)).json;
    const cl = (l && (l.closing || (l.data && l.data.closing))) || {};
    return { shares: Number(b.shares), cd: Number(b.cd), e: Number(b.e), ledShare: Number(cl.share), ledCd: Number(cl.cd) };
  };
  const s0 = await snap();
  const stl = await post({ transferType: 'memberToMember', narration: 'QA JT legacy settlement', rows: [
    { mbno: M1, code: 'L1001', debit: 1000, credit: 0 }, { mbno: M1, code: 'A1047', debit: 0, credit: 700 }, { mbno: M1, code: 'L1004', debit: 0, credit: 300 }] });
  const pst = await call('POST', '/transactions/pass/' + stl.v, {});
  const s1 = await snap();
  const types = (await pg.query('select code, acc_type, mbno, modeofpay from ledger where receipt_vchr_no=$1 order by trans_no', [stl.v])).rows;
  const rst = await call('POST', '/transactions/reverse/' + stl.v, {});
  const s2 = await snap();
  const near = (a, b) => Math.abs(a - b) < 0.005;
  s.check('JT-41', 'settlement posts SHR / ALN / CD ledger rows (mode J) and moves shares -1000, emergency loan -700, CD +300',
    pst.status > 0 && pst.status < 300 && types.map(t => t.acc_type).join() === 'SHR,ALN,CD' && types.every(t => t.modeofpay === 'J') && near(s1.shares, s0.shares - 1000) && near(s1.e, s0.e - 700) && near(s1.cd, s0.cd + 300),
    JSON.stringify({ s0, s1, types }));
  s.check('JT-42', 'Member Ledger CD and share closing figures include the journal (share -1000, CD +300)',
    near(s1.ledShare, s0.ledShare - 1000) && near(s1.ledCd, s0.ledCd + 300), JSON.stringify({ s0, s1 }));
  s.check('JT-43', 'Reverse restores member balances and Member Ledger figures exactly',
    rst.status > 0 && rst.status < 300 && near(s2.shares, s0.shares) && near(s2.e, s0.e) && near(s2.cd, s0.cd) && near(s2.ledShare, s0.ledShare) && near(s2.ledCd, s0.ledCd), JSON.stringify({ s0, s2 }));

  const hh = await post(ok({ narration: 'QA JT legacy head transfer', rows: [{ code: H1, debit: 100, credit: 0 }, { code: H2, debit: 100 === 0 ? 0 : 0, credit: 100 }] }));
  const phh = await call('POST', '/transactions/pass/' + hh.v, {});
  const hrows = (await pg.query('select mbno, acc_no, modeofpay, vchr_type from ledger where receipt_vchr_no=$1', [hh.v])).rows;
  await call('POST', '/transactions/reverse/' + hh.v, {});
  s.check('JT-44', 'head-to-head posts member 0, acc_no 0, mode J (not cash)',
    phh.status > 0 && phh.status < 300 && hrows.length === 2 && hrows.every(r => Number(r.mbno) === 0 && r.mbno !== null && Number(r.acc_no) === 0 && r.modeofpay === 'J'), JSON.stringify(hrows));

  // ---- 7. cleanup: reject every still-pending QA JT voucher we created
  for (const v of created) await call('DELETE', '/transactions/voucher/' + v);
  await pg.end();
  console.log('created', created.length, 'vouchers');
  process.exit(s.finish() ? 1 : 0);
})();
