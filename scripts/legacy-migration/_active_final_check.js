'use strict';
/**
 * Post-migration check of a member list against the LEGACY SQL Server (read-only), bulk version of _sample_final_check.js:
 *   A ledger rows legacy vs new (count + debit/credit totals per loan type)      B loan master opening balances legacy vs new
 *   C closing balance (opening counted once, corrections applied) vs loan record  D every credit justified (ledger audit JSON)
 *   E interest tied (interest audit JSON)                                         F open loan has a schedule; no repaid loan still open
 * Usage: MBNO_FILE=<list> node _active_final_check.js <label>     (run _ledger_audit.js <label> and _interest_audit.js <label> first)
 * Output: reports/active-final-<label>.json  = one row per member + loan type with PERFECT / PROBLEM and details
 */
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { Client } = require('pg');
const { targetConfig, OUT } = require('./inspect');

const members = fs.readFileSync(process.env.MBNO_FILE, 'utf8').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
const mset = new Set(members);
const label = process.argv[2] || 'final';
const CORR = JSON.parse(fs.readFileSync(path.join(__dirname, 'manual-corrections.json'), 'utf8'));
const corrAdj = (mb, code) => CORR.filter(c => String(c.mbno) === String(mb)).reduce((a, c) => a + (c.code === code ? c.amount : 0) - (c.toCode === code ? c.amount : 0), 0);
const audit = JSON.parse(fs.readFileSync(path.join(OUT, `ledger-audit-${label}.json`), 'utf8'));
const interest = JSON.parse(fs.readFileSync(path.join(OUT, `interest-audit-${label}.json`), 'utf8'));

function sql(q) {
  const out = execFileSync('sqlcmd', ['-S', '.\\SQLEXPRESS', '-d', 'EMP_Espat_Society_dan', '-E', '-W', '-s', '|', '-h', '-1', '-Q', q], { encoding: 'utf-8', maxBuffer: 1 << 28 });
  return out.split('\n').map(l => l.trimEnd()).filter(l => l && !/^\(\d+ rows? affected\)$/.test(l)).map(l => l.split('|').map(c => c.trim()));
}
const OPEN = (mbno, isReg) => `(SELECT COALESCE(SUM(lm.openbalance),0) FROM loan_master lm WHERE lm.mbno = ${mbno} AND ((lm.loantype='RLN') = ${isReg}) AND lm.openbalance > 0
  AND lm.payment_date = (SELECT MAX(x.payment_date) FROM loan_master x WHERE x.mbno = lm.mbno AND ((x.loantype='RLN') = ${isReg}) AND x.openbalance > 0
  AND x.payment_date < COALESCE((SELECT MIN(l.trans_date) FROM ledger l WHERE l.mbno = lm.mbno AND l.code = CASE WHEN ${isReg} THEN 'A1002' ELSE 'A1047' END), '9999-12-31')))`;

(async () => {
  // legacy, whole table once
  const legLedger = {};
  for (const r of sql(`SET NOCOUNT ON; SELECT MBNO, ACC_TYPE, TRANS_TYPE, COUNT(*), SUM(TRANS_AMT) FROM LEDGER WHERE ACC_TYPE IN ('RLN','ALN') GROUP BY MBNO, ACC_TYPE, TRANS_TYPE`)) {
    if (!mset.has(r[0])) continue;
    legLedger[`${r[0]}|${r[1]}|${r[2]}`] = { n: Number(r[3]), amt: Number(r[4]) };
  }
  const legLoans = {};
  for (const r of sql(`SET NOCOUNT ON; SELECT MBNO, LOANCASENO, LOANTYPE, OPENBALANCE FROM LOAN_MASTER`)) {
    if (!mset.has(r[0])) continue;
    (legLoans[r[0]] ||= []).push({ c: r[1], t: r[2], ob: Number(r[3]) });
  }
  const pg = new Client(targetConfig()); await pg.connect();
  const newLedger = {};
  for (const r of (await pg.query(`SELECT trim(mbno::text) mb, code, CASE WHEN trans_type IN ('DR','P') THEN 'DR' ELSE 'CR' END tt, count(*) n, sum(trans_amt) amt FROM ledger
        WHERE trim(mbno::text) = ANY($1) AND code IN ('A1002','A1047') GROUP BY 1,2,3`, [members])).rows)
    newLedger[`${r.mb}|${r.code === 'A1002' ? 'RLN' : 'ALN'}|${r.tt}`] = { n: Number(r.n), amt: Number(r.amt) };
  const newLoans = {};
  for (const r of (await pg.query(`SELECT trim(mbno::text) mb, loancaseno::text c, loantype t, openbalance::numeric ob, balance::numeric bal,
        EXISTS (SELECT 1 FROM loan_schedule_versions s WHERE s.mbno = lm.mbno AND s.loancaseno::text = lm.loancaseno::text AND s.loantype = lm.loantype) has_sched
        FROM loan_master lm WHERE trim(mbno::text) = ANY($1)`, [members])).rows)
    (newLoans[r.mb] ||= []).push({ c: r.c, t: r.t, ob: Number(r.ob), bal: Number(r.bal), sched: r.has_sched });

  const result = [];
  for (const mb of members) {
    for (const [cls, code] of [['RLN', 'A1002'], ['ALN', 'A1047']]) {
      const isReg = cls === 'RLN';
      const issues = [];
      // A
      for (const tt of ['DR', 'CR']) {
        const a = legLedger[`${mb}|${cls}|${tt}`] || { n: 0, amt: 0 }, b = newLedger[`${mb}|${cls}|${tt}`] || { n: 0, amt: 0 };
        if (a.n !== b.n || Math.abs(a.amt - b.amt) > 0.5) issues.push(`Ledger ${tt} rows differ: legacy ${a.n}/${a.amt}, new ${b.n}/${b.amt}`);
      }
      // B
      const ll = (legLoans[mb] || []).filter(x => (x.t === 'RLN') === isReg), nl = newLoans[mb] || [];
      if (ll.length !== nl.filter(x => (x.t === 'RLN') === isReg).length) issues.push(`Loan rows: legacy ${ll.length}, new ${nl.filter(x => (x.t === 'RLN') === isReg).length}`);
      for (const x of ll) { const p = nl.find(y => y.c === x.c && y.t === x.t); if (!p) issues.push(`Loan case ${x.c} missing`); else if (Math.abs(p.ob - x.ob) > 0.5) issues.push(`Loan case ${x.c} opening balance differs`); }
      // C
      const o = (await pg.query(`SELECT ${OPEN('$1::numeric', '$2::boolean')} AS ob, COALESCE((SELECT SUM(CASE WHEN trans_type IN ('DR','P') THEN trans_amt WHEN trans_type IN ('CR','R') THEN -trans_amt ELSE 0 END) FROM ledger WHERE mbno=$1::numeric AND code=$3),0) AS net`, [mb, isReg, code])).rows[0];
      const closing = Number(o.ob) + Number(o.net) + corrAdj(mb, code);
      const mine = nl.filter(x => (x.t === 'RLN') === isReg);
      const record = mine.reduce((s, x) => s + x.bal, 0);
      const openCases = mine.filter(x => x.bal > 0);
      if (!(Math.abs(closing - record) <= 10 || (closing <= 0.5 && record === 0))) issues.push(`Balance differs: ledger ${Math.round(closing)}, loan record ${Math.round(record)}`);
      // F
      if (closing <= 0.5 && openCases.length) issues.push(`Repaid in the ledger but still open: ${openCases.map(x => x.c).join(',')}`);
      for (const x of openCases) if (!x.sched) issues.push(`Open loan ${x.c} has no schedule`);
      // D / E
      const au = audit.find(a => a.member === mb && a.head === cls);
      if (au && au.unjustifiedCredits.length) issues.push(`Credits not accounted for: ${au.unjustifiedCredits.length}`);
      if (interest.members && interest.members[mb] !== undefined && cls === 'ALN') issues.push(`Interest not tied on ${interest.members[mb]} day(s) (member level)`);
      const active = closing > 100 || record > 0;
      if (!active && !(Math.abs(closing) > 0.5)) continue;
      result.push({ member: mb, head: cls, ledgerClosing: Math.round(closing * 100) / 100, recordBalance: Math.round(record * 100) / 100,
                    openCases: openCases.map(x => x.c), status: issues.length ? 'PROBLEM' : 'PERFECT', issues });
    }
  }
  await pg.end();
  fs.writeFileSync(path.join(OUT, `active-final-${label}.json`), JSON.stringify(result, null, 1));
  const act = result.filter(r => r.ledgerClosing > 100);
  console.log(`accounts checked ${result.length}; active ${act.length}: PERFECT ${act.filter(r => r.status === 'PERFECT').length}, PROBLEM ${act.filter(r => r.status === 'PROBLEM').length}`);
  const kinds = {};
  for (const r of act) for (const i of r.issues) { const k = i.replace(/[\d.,]+/g, '#').slice(0, 60); kinds[k] = (kinds[k] || 0) + 1; }
  console.log(Object.entries(kinds).sort((a, b) => b[1] - a[1]).map(([k, n]) => `  ${n}  ${k}`).join('\n'));
})().catch(e => { console.error(e.stack || e.message); process.exit(1); });
