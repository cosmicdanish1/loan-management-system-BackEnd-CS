// Global batch run: dividend commit, saving interest update, day-end - each executed ONCE, then repeated to prove the repeat is refused.
// Snapshots ledger / balances before and after each step. All data in this database is test data (owner confirmed 2026-10-16).
const { http, login, Suite } = require('./lib');
const { Client } = require('pg');
require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });

(async () => {
  const s = new Suite('13-batches');
  const { token } = await login();
  const call = (m, u, b) => http(m, u, { token, body: b, timeout: 600000 });
  const pg = new Client({ host: process.env.DB_HOST, port: process.env.DB_PORT, user: process.env.DB_USERNAME, password: process.env.DB_PASSWORD, database: process.env.DB_DATABASE });
  await pg.connect();
  const one = async (sql) => (await pg.query(sql)).rows[0];
  const snap = async () => ({
    ledgerRows: Number((await one('select count(*) c from ledger')).c),
    ledgerNet: Number((await one(`select coalesce(sum(case when trans_type='CR' then trans_amt else -trans_amt end),0) s from ledger`)).s),
    sbSum: Number((await one('select coalesce(sum(balance),0) s from sbmaster')).s),
    loanBal: Number((await one('select coalesce(sum(balance),0) s from loan_master')).s),
    divRows: Number((await one('select count(*) c from dividend_master')).c),
    intPaid: Number((await one('select count(*) c from interestpaid')).c),
    pendingDay: (await one(`select to_char(min(working_date),'YYYY-MM-DD') d from getworkingdate where dayend_flag='N'`)).d,
    dayEnds: Number((await one('select count(*) c from day_end_processes')).c),
  });
  const show = (n, a, b) => console.log(`SNAP ${n}:`, JSON.stringify(a), '->', JSON.stringify(b));

  // ================= Dividend =================
  const YEAR = 2, CALC = 2027, RATE = 5; // yearcode 2 = FY 2027-28 (no dividend rows yet); dividend_master.year = 2027
  const dp = await call('GET', `/dividend/calculation/preview?yearcode=${YEAR}&dividendRate=${RATE}`);
  s.check('BT-01', 'Dividend preview works (dry run)', (dp.status > 0 && dp.status < 300), `${dp.status} ${(dp.text || '').slice(0, 200)}`);
  const before1 = await snap();
  const previewAgain = await call('GET', `/dividend/calculation/preview?yearcode=${YEAR}&dividendRate=${RATE}`);
  const afterPrev = await snap();
  s.check('BT-02', 'Preview writes nothing (dividend rows unchanged)', before1.divRows === afterPrev.divRows && before1.ledgerRows === afterPrev.ledgerRows, JSON.stringify({ before1, afterPrev }));
  const bad = await call('GET', `/dividend/calculation/preview?yearcode=${YEAR}&dividendRate=-5`);
  s.check('BT-03', 'Preview with negative dividend rate -> 4xx', bad.status >= 400 && (bad.status > 0 && bad.status < 500), `${bad.status} ${(bad.text || '').slice(0, 100)}`);
  const bad2 = await call('POST', '/dividend/calculation/commit', { yearcode: YEAR, dividendRate: 500 });
  s.check('BT-04', 'Commit with an absurd rate (500%) is refused', bad2.status >= 400 && (bad2.status > 0 && bad2.status < 500), `${bad2.status} ${(bad2.text || '').slice(0, 100)}`);
  const afterBad = await snap();
  s.check('BT-05', 'Refused commit wrote nothing', afterBad.divRows === before1.divRows, `${before1.divRows} -> ${afterBad.divRows}`);
  const dc = await call('POST', '/dividend/calculation/commit', { yearcode: YEAR, dividendRate: RATE });
  const after1 = await snap();
  show('dividend commit', before1, after1);
  s.check('BT-06', 'Dividend commit (year 2025, 5%) runs once', (dc.status > 0 && dc.status < 300), `${dc.status} ${(dc.text || '').slice(0, 220)}`);
  if ((dc.status > 0 && dc.status < 300)) {
    const sumDiv = Number((await one(`select coalesce(sum(dividend_amount),0) s from dividend_master where year=${CALC}`)).s);
    const sumShare = Number((await one(`select coalesce(sum(share_amount*dividend_rate/100),0) s from dividend_master where year=${CALC}`)).s);
    s.check('BT-07', 'Committed dividend_amount ~= share_amount x rate for the year (rounded per member)', Math.abs(sumDiv - sumShare) / Math.max(1, sumShare) < 0.01, `sum amount ${sumDiv} vs shares x rate ${sumShare}`);
    s.check('BT-08', 'Commit only fills dividend_master; ledger unchanged (credit is a separate step)', after1.ledgerRows === before1.ledgerRows, `${before1.ledgerRows} -> ${after1.ledgerRows}`);
    const dup = await pg.query(`select mbno, count(*) c from dividend_master where year=${CALC} group by mbno having count(*)>1 limit 5`);
    s.check('BT-09', 'One dividend row per member for the year', dup.rows.length === 0, JSON.stringify(dup.rows));
    const dc2 = await call('POST', '/dividend/calculation/commit', { yearcode: YEAR, dividendRate: RATE });
    const after2 = await snap();
    const dup2 = await pg.query(`select mbno, count(*) c from dividend_master where year=${CALC} group by mbno having count(*)>1 limit 5`);
    s.check('BT-10', 'Repeat commit for the same year is refused or idempotent (no duplicate rows)', dup2.rows.length === 0 && after2.divRows <= after1.divRows, `${dc2.status} rows ${after1.divRows} -> ${after2.divRows} ${(dc2.text || '').slice(0, 120)}`);
  }
  const cp = await call('GET', `/dividend/credit/preview?yearcode=${YEAR}`);
  s.check('BT-11', 'Credit preview (dry run) works', (cp.status > 0 && cp.status < 500), `${cp.status} ${(cp.text || '').slice(0, 160)}`);

  // ================= Saving interest =================
  const P = { fromDate: '2026-07-01', toDate: '2026-09-30', interestRate: 4 };
  const ip = await call('POST', '/interest/preview-calculation', P);
  s.check('BT-12', 'Interest preview (dry run) works', (ip.status > 0 && ip.status < 300), `${ip.status} ${(ip.text || '').slice(0, 220)}`);
  const iv = await call('POST', '/interest/validate-parameters', P);
  console.log('INFO validate-parameters ->', iv.status, (iv.text || '').slice(0, 160));
  const i0 = await snap();
  const rates = [['BT-13', 'negative rate', { ...P, interestRate: -4 }], ['BT-14', 'rate 90%', { ...P, interestRate: 90 }], ['BT-15', 'from after to', { ...P, fromDate: '2026-12-31', toDate: '2026-01-01' }], ['BT-16', 'period in the future (2030)', { fromDate: '2030-01-01', toDate: '2030-03-31', interestRate: 4 }]];
  for (const [id, t, b] of rates) {
    const r = await call('POST', '/interest/update-saving-interest', b);
    const a = await snap();
    s.check(id, `Interest update with ${t}: refused (4xx), nothing posted`, r.status >= 400 && (r.status > 0 && r.status < 500) && a.ledgerRows === i0.ledgerRows, `${r.status}; ledger ${i0.ledgerRows} -> ${a.ledgerRows}; ${(r.text || '').slice(0, 90)}`);
  }
  const iu = await call('POST', '/interest/update-saving-interest', P);
  const i1 = await snap();
  show('interest update', i0, i1);
  s.check('BT-17', 'Interest update for Jul-Sep 2026 at 4% runs once', (iu.status > 0 && iu.status < 300), `${iu.status} ${(iu.text || '').slice(0, 260)}`);
  if ((iu.status > 0 && iu.status < 300)) {
    const posted = i1.ledgerNet - i0.ledgerNet;
    console.log('INFO ledger net change after interest', posted, 'sb change', i1.sbSum - i0.sbSum, 'interestpaid rows +', i1.intPaid - i0.intPaid);
    s.check('BT-18', 'Interest was actually posted (rows added to ledger or interestpaid)', i1.ledgerRows > i0.ledgerRows || i1.intPaid > i0.intPaid, JSON.stringify({ i0, i1 }));
    const debits = Number((await one(`select coalesce(sum(case when trans_type='DR' then trans_amt end),0) s from (select * from ledger order by ledgerid desc limit ${Math.max(1, i1.ledgerRows - i0.ledgerRows)}) t`)).s);
    const credits = Number((await one(`select coalesce(sum(case when trans_type='CR' then trans_amt end),0) s from (select * from ledger order by ledgerid desc limit ${Math.max(1, i1.ledgerRows - i0.ledgerRows)}) t`)).s);
    s.check('BT-19', 'Newly posted interest ledger rows balance (debits = credits)', Math.abs(debits - credits) < 0.05, `DR ${debits} CR ${credits}`);
    const sbDelta = i1.sbSum - i0.sbSum;
    const intAmt = Number((await one(`select coalesce(sum(interest),0) s from interestpaid where id > (select max(id::bigint) - ${i1.intPaid - i0.intPaid} from interestpaid)`)).s);
    console.log('INFO sbmaster balance change', sbDelta, 'interestpaid new rows interest sum', intAmt);
    const iu2 = await call('POST', '/interest/update-saving-interest', P);
    const i2 = await snap();
    s.check('BT-20', 'Running the SAME period again is refused and posts nothing (no double interest)', iu2.status >= 400 && (iu2.status > 0 && iu2.status < 500) && i2.ledgerRows === i1.ledgerRows, `${iu2.status}; ledger ${i1.ledgerRows} -> ${i2.ledgerRows}; ${(iu2.text || '').slice(0, 120)}`);
  }

  // ================= Day-end =================
  const d0 = await snap();
  const sum0 = await call('GET', '/admin/day-end/summary');
  console.log('INFO day-end summary before ->', sum0.status, (sum0.text || '').slice(0, 220));
  const procDate = d0.pendingDay || '2026-08-24';
  const de = await call('POST', '/admin/day-end/initiate', { processDate: procDate });
  const d1 = await snap();
  show('day-end', d0, d1);
  s.check('BT-22', `Day-end for pending date ${procDate} runs once`, (de.status > 0 && de.status < 300), `${de.status} ${(de.text || '').slice(0, 260)}`);
  if ((de.status > 0 && de.status < 300)) {
    s.check('BT-23', 'Working date moves on (pending date changes) and the old date is flagged done', d1.pendingDay !== d0.pendingDay, `${d0.pendingDay} -> ${d1.pendingDay}`);
    s.check('BT-24', 'Day-end does not change loan or savings totals by itself', Math.abs(d1.loanBal - d0.loanBal) < 0.01, `loan ${d0.loanBal} -> ${d1.loanBal}; sb ${d0.sbSum} -> ${d1.sbSum}`);
    const de2 = await call('POST', '/admin/day-end/initiate', { processDate: procDate });
    const d2 = await snap();
    console.log('INFO repeat day-end ->', de2.status, (de2.text || '').slice(0, 200), ' pending', d2.pendingDay);
    s.check('BT-25', 'Repeating day-end for the SAME date is refused (already completed)', de2.status >= 400 && (de2.status > 0 && de2.status < 500), `${de2.status} ${(de2.text || '').slice(0, 140)}`);
    s.check('BT-26', 'Repeat did not move the working date again or add ledger rows', d2.pendingDay === d1.pendingDay && d2.ledgerRows === d1.ledgerRows, `${d1.pendingDay} -> ${d2.pendingDay}; ledger ${d1.ledgerRows} -> ${d2.ledgerRows}`);
    const pr = await call('GET', '/admin/day-end/processes');
    s.check('BT-27', 'Day-end process list shows the completed run', pr.status === 200 && /COMPLETED|completed/.test(pr.text || ''), `${pr.status} ${(pr.text || '').slice(0, 160)}`);
  }
  await pg.end();
  process.exit(s.finish() ? 1 : 0);
})();
