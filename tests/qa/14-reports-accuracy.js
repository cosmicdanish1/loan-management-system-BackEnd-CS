// Report accuracy: every figure is recomputed from the ledger table and compared with what the report endpoints return.
// Read-only (GET + SQL SELECT). Env: QA_USER / QA_PASS.
const { http, login, Suite } = require('./lib');
const { Client } = require('pg');
require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });
const near = (a, b, t = 0.05) => Math.abs(Number(a) - Number(b)) <= t;
const unwrap = (r) => { let d = r.json && r.json.data; while (d && d.success !== undefined && d.data !== undefined) d = d.data; return d; };

(async () => {
  const s = new Suite('14-reports-accuracy');
  const { token } = await login();
  const get = (u) => http('GET', u, { token, timeout: 180000 });
  const pg = new Client({ host: process.env.DB_HOST, port: process.env.DB_PORT, user: process.env.DB_USERNAME, password: process.env.DB_PASSWORD, database: process.env.DB_DATABASE });
  await pg.connect();
  const rows = async (sql, p) => (await pg.query(sql, p)).rows;
  const D = (d) => `(trans_date at time zone 'Asia/Kolkata')::date`;

  // busiest ordinary dates + the QA day
  const dates = (await rows(`select to_char(${D()},'YYYY-MM-DD') d, count(*) c from ledger where trans_date >= '2026-08-01' and trans_date < '2026-12-31' group by 1 order by c desc limit 3`)).map(r => r.d);
  if (!dates.includes('2026-10-16')) dates.push('2026-10-16');
  console.log('dates under test', dates.join(', '));

  // ---------------- Daybook + Cashbook
  const prevClose = {};
  for (const d of dates.sort()) {
    const db = unwrap(await get(`/daybook/report?date=${d}`));
    const cb = unwrap(await get(`/cashbook/report?date=${d}`));
    s.check(`RA-DB-${d}-1`, `Daybook ${d}: opening + receipts - payments = closing`, db && near(db.openingBalance + db.totalReceipts - db.totalPayments, db.closingBalance), db && JSON.stringify({ o: db.openingBalance, r: db.totalReceipts, p: db.totalPayments, c: db.closingBalance }));
    const cashBefore = Number((await rows(`select coalesce(sum(case when trans_type='DR' then trans_amt else -trans_amt end),0) v from ledger where code='A1001' and ${D()} < $1::date`, [d]))[0].v);
    s.check(`RA-DB-${d}-2`, `Daybook ${d}: opening balance equals cash-in-hand (A1001) from the ledger before the date`, db && near(db.openingBalance, cashBefore, 1), `report ${db && db.openingBalance} vs ledger ${cashBefore}`);
    const cashRec = Number((await rows(`select coalesce(sum(trans_amt),0) v from ledger where code='A1001' and trans_type='DR' and ${D()} = $1::date`, [d]))[0].v);
    const cashPay = Number((await rows(`select coalesce(sum(trans_amt),0) v from ledger where code='A1001' and trans_type='CR' and ${D()} = $1::date`, [d]))[0].v);
    s.check(`RA-DB-${d}-3`, `Daybook ${d}: total receipts / payments equal cash DR / CR in the ledger`, db && near(db.totalReceipts, cashRec, 1) && near(db.totalPayments, cashPay, 1), `report ${db && db.totalReceipts}/${db && db.totalPayments} vs ledger ${cashRec}/${cashPay}`);
    const grp = (g) => (g || []).reduce((a, x) => a + Number(x.total), 0);
    s.check(`RA-DB-${d}-4`, `Daybook ${d}: sum of receipt groups = headline total receipts (and payments)`, db && near(grp(db.receiptGroups), db.totalReceipts, 1) && near(grp(db.paymentGroups), db.totalPayments, 1), db && `groups ${grp(db.receiptGroups)}/${grp(db.paymentGroups)} vs headline ${db.totalReceipts}/${db.totalPayments}`);
    const entSum = (db && db.receiptGroups || []).every(g => near(g.entries.reduce((a, e) => a + Number(e.amount), 0), g.total, 0.05));
    s.check(`RA-DB-${d}-5`, `Daybook ${d}: each group total equals the sum of its entries`, entSum);
    // cashbook
    s.check(`RA-CB-${d}-1`, `Cashbook ${d}: opening + receipts - payments = closing`, cb && near(cb.openingBalance + cb.totalReceipts - cb.totalPayments, cb.closingBalance), cb && JSON.stringify({ o: cb.openingBalance, r: cb.totalReceipts, p: cb.totalPayments, c: cb.closingBalance }));
    const sums = (await rows(`select coalesce(sum(trans_amt) filter (where trans_type='CR'),0) cr, coalesce(sum(trans_amt) filter (where trans_type='DR'),0) dr from ledger where ${D()} = $1::date`, [d]))[0];
    s.check(`RA-CB-${d}-2`, `Cashbook ${d}: total receipts / payments equal ledger CR / DR for the day`, cb && near(cb.totalReceipts, sums.cr, 1) && near(cb.totalPayments, sums.dr, 1), `report ${cb && cb.totalReceipts}/${cb && cb.totalPayments} vs ledger ${sums.cr}/${sums.dr}`);
    s.check(`RA-CB-${d}-3`, `Cashbook ${d}: sum of head lines equals the totals`, cb && near(cb.entries.reduce((a, e) => a + Number(e.receipt), 0), cb.totalReceipts, 1) && near(cb.entries.reduce((a, e) => a + Number(e.payment), 0), cb.totalPayments, 1));
    s.check(`RA-X-${d}`, `Daybook and Cashbook agree on the opening balance for ${d} (both are 'cash')`, db && cb && near(db.openingBalance, cb.openingBalance, 1), `daybook ${db && db.openingBalance} vs cashbook ${cb && cb.openingBalance}`);
    prevClose[d] = { db: db && db.closingBalance, cb: cb && cb.closingBalance };
  }
  // day-to-day continuity (consecutive calendar days)
  const t1 = '2026-10-15', t2 = '2026-10-16';
  const a = unwrap(await get(`/daybook/report?date=${t1}`)), b = unwrap(await get(`/daybook/report?date=${t2}`));
  s.check('RA-DB-CONT', `Daybook: closing of ${t1} equals opening of ${t2}`, a && b && near(a.closingBalance, b.openingBalance, 1), `${a && a.closingBalance} vs ${b && b.openingBalance}`);
  const ca = unwrap(await get(`/cashbook/report?date=${t1}`)), cbb = unwrap(await get(`/cashbook/report?date=${t2}`));
  s.check('RA-CB-CONT', `Cashbook: closing of ${t1} equals opening of ${t2}`, ca && cbb && near(ca.closingBalance, cbb.openingBalance, 1), `${ca && ca.closingBalance} vs ${cbb && cbb.openingBalance}`);

  // ---------------- General ledger
  for (const head of ['L1004', 'L1001', 'A1001']) {
    const from = '2026-10-01', to = '2026-10-16';
    const gl = unwrap(await get(`/general-ledger/report?headCode=${head}&fromDate=${from}&toDate=${to}`));
    const t = (await rows(`select coalesce(sum(trans_amt) filter (where trans_type='DR'),0) dr, coalesce(sum(trans_amt) filter (where trans_type='CR'),0) cr, count(*) n from ledger where code=$1 and ${D()} between $2::date and $3::date`, [head, from, to]))[0];
    s.check(`RA-GL-${head}-1`, `GL ${head}: total debits/credits equal the ledger for ${from}..${to}`, gl && near(gl.totalDebits, t.dr, 1) && near(gl.totalCredits, t.cr, 1), `report ${gl && gl.totalDebits}/${gl && gl.totalCredits} vs ledger ${t.dr}/${t.cr}`);
    s.check(`RA-GL-${head}-2`, `GL ${head}: number of entries equals ledger row count`, gl && Number(gl.totalTransactions) === Number(t.n) && gl.entries.length === Number(t.n), `report ${gl && gl.totalTransactions}/${gl && gl.entries.length} vs ledger ${t.n}`);
    const openCum = Number((await rows(`select coalesce(sum(case when trans_type='CR' then trans_amt else -trans_amt end),0) v from ledger where code=$1 and ${D()} < $2::date`, [head, from]))[0].v);
    s.check(`RA-GL-${head}-3`, `GL ${head}: opening balance equals ledger cumulative before ${from} (either sign convention)`, gl && (near(gl.openingBalance, openCum, 1) || near(gl.openingBalance, -openCum, 1)), `report ${gl && gl.openingBalance} vs ledger CR-DR ${openCum}`);
    s.check(`RA-GL-${head}-4`, `GL ${head}: opening + movement = closing`, gl && (near(gl.openingBalance + gl.totalCredits - gl.totalDebits, gl.closingBalance, 1) || near(gl.openingBalance - gl.totalCredits + gl.totalDebits, gl.closingBalance, 1)), gl && JSON.stringify({ o: gl.openingBalance, d: gl.totalDebits, c: gl.totalCredits, cl: gl.closingBalance }));
    let run = true; let last = gl && gl.openingBalance;
    (gl && gl.entries || []).forEach(e => { const exp1 = last + e.credit - e.debit, exp2 = last - e.credit + e.debit; if (!(near(e.balance, exp1, 0.05) || near(e.balance, exp2, 0.05))) run = false; last = e.balance; });
    s.check(`RA-GL-${head}-5`, `GL ${head}: running balance on every line follows the previous balance`, run);
  }
  const glRev = await get('/general-ledger/report?headCode=L1004&fromDate=2026-12-31&toDate=2026-01-01');
  s.check('RA-GL-EDGE1', 'GL with from-date after to-date -> 4xx', glRev.status >= 400 && glRev.status < 500, glRev.status);
  const glBad = await get('/general-ledger/report?headCode=ZZZ999&fromDate=2026-10-01&toDate=2026-10-16');
  s.check('RA-GL-EDGE2', 'GL with unknown head -> 404/400 (not 500, not an empty success)', glBad.status >= 400 && glBad.status < 500, glBad.status);

  // ---------------- Member ledger (real members with most ledger rows)
  const mems = (await rows(`select mbno, count(*) c from ledger where code='L1004' and mbno > 600000000 and mbno < 700000000 group by mbno order by c desc limit 4`)).map(r => String(r.mbno));
  for (const m of mems) {
    const from = '2025-01-01', to = '2026-12-31';
    const ml = unwrap(await get(`/member-ledger/report?memberNumber=${m}&headCode=L1004&fromDate=${from}&toDate=${to}`));
    const t = (await rows(`select coalesce(sum(trans_amt) filter (where trans_type='DR'),0) dr, coalesce(sum(trans_amt) filter (where trans_type='CR'),0) cr, count(*) n from ledger where mbno=$1 and code='L1004' and ${D()} between $2::date and $3::date`, [m, from, to]))[0];
    s.check(`RA-ML-${m}-1`, `Member ledger ${m} L1004: debits/credits equal ledger`, ml && near(ml.totalDebits, t.dr, 1) && near(ml.totalCredits, t.cr, 1), `report ${ml && ml.totalDebits}/${ml && ml.totalCredits} vs ledger ${t.dr}/${t.cr}`);
    s.check(`RA-ML-${m}-2`, `Member ledger ${m}: row count equals ledger`, ml && ml.entries.length === Number(t.n), `${ml && ml.entries.length} vs ${t.n}`);
    s.check(`RA-ML-${m}-3`, `Member ledger ${m}: opening + credits - debits = closing`, ml && near(ml.openingBalance + ml.totalCredits - ml.totalDebits, ml.closingBalance, 1), ml && JSON.stringify({ o: ml.openingBalance, d: ml.totalDebits, c: ml.totalCredits, cl: ml.closingBalance }));
    const fm = (await rows(`select cdamt from fundsmaster where mbno=$1`, [m]))[0];
    const closeAll = unwrap(await get(`/member-ledger/report?memberNumber=${m}&headCode=L1004&fromDate=2000-01-01&toDate=2030-12-31`));
    s.check(`RA-ML-${m}-4`, `Member ledger ${m}: lifetime CD closing equals fundsmaster.cdamt`, closeAll && fm && near(closeAll.closingBalance, fm.cdamt, 1), `ledger report ${closeAll && closeAll.closingBalance} vs fundsmaster ${fm && fm.cdamt}`);
    const dl = unwrap(await get(`/member-ledger/detail-report?memberNumber=${m}&fromDate=${from}&toDate=${to}`));
    const all = (await rows(`select coalesce(sum(trans_amt) filter (where trans_type='DR'),0) dr, coalesce(sum(trans_amt) filter (where trans_type='CR'),0) cr from ledger where mbno=$1 and ${D()} between $2::date and $3::date`, [m, from, to]))[0];
    s.check(`RA-ML-${m}-5`, `Member detail ledger ${m}: totals equal ledger for all heads`, dl && near(dl.totalDebits, all.dr, 1) && near(dl.totalCredits, all.cr, 1), `report ${dl && dl.totalDebits}/${dl && dl.totalCredits} vs ledger ${all.dr}/${all.cr}`);
  }
  const mlNo = await get('/member-ledger/report?memberNumber=1999999999&headCode=L1004&fromDate=2026-01-01&toDate=2026-12-31');
  s.check('RA-ML-EDGE1', 'Member ledger for a member that does not exist -> 404/400', mlNo.status >= 400 && mlNo.status < 500, `${mlNo.status}`);

  // ---------------- Balance sheet
  const bsr = await get('/reports/balance-sheet?asOnDate=2026-10-16');
  const bs = unwrap(bsr);
  if (bs) {
    const liab = bs.liabilities || [], ass = bs.assets || [];
    const L = liab.reduce((a, x) => a + Number(x.closingBalance), 0), A = ass.reduce((a, x) => a + Number(x.closingBalance), 0);
    console.log('INFO balance sheet totals liabilities', L, 'assets', A, 'keys', Object.keys(bs).join(','));
    s.check('RA-BS-1', 'Balance sheet balances: total liabilities = total assets (within 1)', near(L, A, 1), `liabilities ${L} vs assets ${A} (difference ${L - A})`);
    const bad = liab.concat(ass).filter(x => !near(Number(x.openingBalance) + Number(x.credit) - Number(x.debit), Number(x.closingBalance), 1) && !near(Number(x.openingBalance) - Number(x.credit) + Number(x.debit), Number(x.closingBalance), 1));
    s.check('RA-BS-2', 'Each head: opening +/- movement = closing', bad.length === 0, `${bad.length} heads, e.g. ${bad.slice(0, 3).map(x => x.headCode + ':' + x.openingBalance + '/' + x.debit + '/' + x.credit + '/' + x.closingBalance).join('; ')}`);
    for (const code of ['L1004', 'L1001']) {
      const h = liab.concat(ass).find(x => x.headCode === code);
      const cum = (await rows(`select coalesce(sum(case when trans_type='CR' then trans_amt else -trans_amt end),0) v from ledger where code=$1 and ${D()} <= '2026-10-16'::date`, [code]))[0].v;
      s.check(`RA-BS-${code}`, `Balance sheet ${code}: closing equals ledger cumulative (CR-DR, either sign)`, h && (near(h.closingBalance, cum, 1) || near(h.closingBalance, -cum, 1)), `report ${h && h.closingBalance} vs ledger CR-DR ${cum}`);
      const gl = unwrap(await get(`/general-ledger/report?headCode=${code}&fromDate=2026-10-16&toDate=2026-10-16`));
      s.check(`RA-BSGL-${code}`, `Balance sheet ${code} closing equals General Ledger closing on the same date (abs value)`, h && gl && near(Math.abs(h.closingBalance), Math.abs(gl.closingBalance), 1), `BS ${h && h.closingBalance} vs GL ${gl && gl.closingBalance}`);
    }
    const again = unwrap(await get('/reports/balance-sheet?asOnDate=2026-10-16'));
    s.check('RA-BS-3', 'Balance sheet is repeatable (same figures on a second call)', JSON.stringify(again) === JSON.stringify(bs));
  } else s.check('RA-BS-0', 'Balance sheet loads', false, `${bsr.status} ${(bsr.text || '').slice(0, 120)}`);
  const bsFuture = await get('/reports/balance-sheet?asOnDate=2099-01-01');
  s.check('RA-BS-EDGE1', 'Balance sheet for a future date does not 5xx', bsFuture.status < 500 && bsFuture.status > 0, bsFuture.status);
  const bsBad = await get('/reports/balance-sheet?asOnDate=not-a-date');
  s.check('RA-BS-EDGE2', 'Balance sheet with an invalid date -> 4xx', bsBad.status >= 400 && bsBad.status < 500, `${bsBad.status} ${(bsBad.text || '').slice(0, 80)}`);
  // ---------------- cross-report: ledger balance
  const imb = (await rows(`select coalesce(sum(case when trans_type='CR' then trans_amt else -trans_amt end),0) v from ledger`))[0].v;
  s.check('RA-LED-1', 'Whole ledger: total credits equal total debits (double-entry integrity)', near(imb, 0, 1), `CR - DR = ${imb} (legacy at 2026-09-25 was 242,044)`);
  await pg.end();
  process.exit(s.finish() ? 1 : 0);
})();
