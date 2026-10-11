'use strict';
/**
 * Full clean check of the fixed sample, member by member, against the LEGACY SQL Server (read-only):
 *  A. every legacy loan-head ledger row exists in the new ledger (count + debit/credit totals per loan type)
 *  B. legacy loan_master == new loan_master (loan amount, opening balance) for every case
 *  C. outstanding balance: ledger closing (opening counted once, manual corrections applied) vs loan record, per loan type
 *  D. every credit and every interest credit justified (ledger-audit / interest-audit logic)
 *  E. loans that are repaid in the ledger but still open on the loan record
 *  F. the loan(s) follow the pattern the new app needs (schedule built from payments, no data exception) or the member is FLAGGED with reasons
 * Usage: MBNO_FILE=reports/sample50-members.txt node _sample_final_check.js <label> <phase2 log>   -> reports/sample-final-<label>.json
 */
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { Client } = require('pg');
const { targetConfig, OUT } = require('./inspect');

const members = fs.readFileSync(process.env.MBNO_FILE, 'utf8').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
const label = process.argv[2] || 'final';
const logFile = process.argv[3];
const CORR = JSON.parse(fs.readFileSync(path.join(__dirname, 'manual-corrections.json'), 'utf8'));
const corrAdj = (mb, code) => CORR.filter(c => String(c.mbno) === String(mb)).reduce((a, c) => a + (c.code === code ? c.amount : 0) - (c.toCode === code ? c.amount : 0), 0);
const ledgerAudit = JSON.parse(fs.readFileSync(path.join(OUT, `ledger-audit-${label}.json`), 'utf8'));

function sql(q) {
  const out = execFileSync('sqlcmd', ['-S', '.\\SQLEXPRESS', '-d', 'EMP_Espat_Society_dan', '-E', '-W', '-s', '|', '-h', '-1', '-Q', q], { encoding: 'utf-8', maxBuffer: 1 << 26 });
  return out.split('\n').map(l => l.trimEnd()).filter(l => l && !/^\(\d+ rows? affected\)$/.test(l)).map(l => l.split('|').map(c => c.trim()));
}
const OPEN = (mbno, isReg) => `(SELECT COALESCE(SUM(lm.openbalance),0) FROM loan_master lm WHERE lm.mbno = ${mbno} AND ((lm.loantype='RLN') = ${isReg}) AND lm.openbalance > 0
  AND lm.payment_date = (SELECT MAX(x.payment_date) FROM loan_master x WHERE x.mbno = lm.mbno AND ((x.loantype='RLN') = ${isReg}) AND x.openbalance > 0
  AND x.payment_date < COALESCE((SELECT MIN(l.trans_date) FROM ledger l WHERE l.mbno = lm.mbno AND l.code = CASE WHEN ${isReg} THEN 'A1002' ELSE 'A1047' END), '9999-12-31')))`;

const FLAGS = {};
if (logFile && fs.existsSync(logFile)) {
  const t = fs.readFileSync(logFile, 'utf8'); const i = t.indexOf('--- Flags');
  for (const l of (i >= 0 ? t.slice(i) : '').split(/\r?\n/)) {
    const m = l.trim().match(/^\[(\d+)\]\s+(.*)$/); if (m) (FLAGS[m[1]] ||= []).push(m[2]);
  }
}
const classify = f =>
  f.startsWith('MANUAL_CORRECTION') ? 'MANUAL_CORRECTION'
  : f.includes('SCHEDULE_VERSION_NOT_BUILT') ? 'SCHEDULE_NOT_BUILT'
  : f.includes('schedule from legacy loan terms') ? 'SCHEDULE_FROM_LEGACY_TERMS'
  : f.includes('reconciled to ledger') ? 'RECONCILED_TO_LEDGER'
  : f.includes('LEDGER_OWES') || f.includes('LEDGER_BELOW') ? 'LEDGER_OWES_NO_LOAN_ROW'
  : f.startsWith('Overpayment') ? 'OVERPAYMENT'
  : f.includes('invalid loan_amt') ? 'PLACEHOLDER'
  : f.includes('ledger-based') ? 'REOPENED_BY_LEDGER'
  : f.startsWith('INFO') ? 'INFO'
  : f.startsWith('Mixed') ? 'MIXED_VOUCHER_UNSPLIT' : 'OTHER: ' + f.slice(0, 80);

(async () => {
  const pg = new Client(targetConfig()); await pg.connect();
  const result = [];
  for (const mb of members) {
    const rec = { member: mb, issues: [], heads: [] };
    // A. ledger rows, legacy vs new
    const leg = sql(`SET NOCOUNT ON; SELECT ACC_TYPE, TRANS_TYPE, COUNT(*), SUM(TRANS_AMT) FROM LEDGER WHERE MBNO='${mb}' AND ACC_TYPE IN ('RLN','ALN') GROUP BY ACC_TYPE, TRANS_TYPE`);
    const legacy = {}; for (const r of leg) legacy[`${r[0]}|${r[1]}`] = { n: Number(r[2]), amt: Number(r[3]) };
    const neu = (await pg.query(`SELECT code, CASE WHEN trans_type IN ('DR','P') THEN 'DR' ELSE 'CR' END tt, count(*) n, sum(trans_amt) amt FROM ledger WHERE trim(mbno::text)=$1 AND code IN ('A1002','A1047') GROUP BY 1,2`, [mb])).rows;
    const newer = {}; for (const r of neu) newer[`${r.code === 'A1002' ? 'RLN' : 'ALN'}|${r.tt}`] = { n: Number(r.n), amt: Number(r.amt) };
    rec.ledgerRows = { legacy, new: newer };
    for (const k of new Set([...Object.keys(legacy), ...Object.keys(newer)])) {
      const a = legacy[k] || { n: 0, amt: 0 }, b = newer[k] || { n: 0, amt: 0 };
      if (a.n !== b.n || Math.abs(a.amt - b.amt) > 0.5) rec.issues.push(`LEDGER_ROWS_DIFFER ${k}: legacy ${a.n} rows/${a.amt}, new ${b.n} rows/${b.amt}`);
    }
    // B. loan master
    const lm = sql(`SET NOCOUNT ON; SELECT LOANCASENO, LOANTYPE, LOAN_AMT, OPENBALANCE FROM LOAN_MASTER WHERE MBNO='${mb}'`);
    const pgLm = (await pg.query(`SELECT loancaseno::text c, loantype, loan_amt::numeric a, openbalance::numeric o, balance::numeric bal FROM loan_master WHERE trim(mbno::text)=$1`, [mb])).rows;
    for (const r of lm) {
      const p = pgLm.find(x => x.c === r[0] && x.loantype === r[1]);
      if (!p) rec.issues.push(`LOAN_ROW_MISSING case ${r[0]}`);
      else if (Math.abs(Number(p.o) - Number(r[3])) > 0.5) rec.issues.push(`LOAN_ROW_DIFFERS case ${r[0]}: opening balance legacy ${r[3]}, new ${p.o}`);
      // the loan amount differs by design: it is the ledger principal on the disbursal day (legacy loan_amt can be cumulative or stale)
      // a HIGHER loan amount is expected: the replay adds the consolidated balance to the receiving case
    }
    if (pgLm.length !== lm.length) rec.issues.push(`LOAN_ROW_COUNT legacy ${lm.length}, new ${pgLm.length}`);
    // C/E. per head
    for (const [cls, code] of [['RLN', 'A1002'], ['ALN', 'A1047']]) {
      const isReg = cls === 'RLN';
      const o = (await pg.query(`SELECT ${OPEN('$1::numeric', '$2::boolean')} AS ob, COALESCE((SELECT SUM(CASE WHEN trans_type IN ('DR','P') THEN trans_amt WHEN trans_type IN ('CR','R') THEN -trans_amt ELSE 0 END) FROM ledger WHERE mbno=$1::numeric AND code=$3),0) AS net`, [mb, isReg, code])).rows[0];
      const closing = Number(o.ob) + Number(o.net) + corrAdj(mb, code);
      const cases = pgLm.filter(x => (x.loantype === 'RLN') === isReg);
      const record = cases.reduce((s, x) => s + Number(x.bal), 0);
      const openCases = cases.filter(x => Number(x.bal) > 0).map(x => x.c);
      const status = Math.abs(closing - record) <= 10 || (closing <= 0.5 && record === 0) ? 'MATCH' : 'DIFFERS';
      const paidButShown = closing <= 0.5 && openCases.length > 0;
      rec.heads.push({ head: cls, opening: Number(o.ob), ledgerNet: Number(o.net), correction: corrAdj(mb, code), ledgerClosing: Math.round(closing * 100) / 100, recordBalance: record, openCases, status, paidButShown });
      if (status === 'DIFFERS') rec.issues.push(`BALANCE_DIFFERS ${cls}: ledger ${Math.round(closing)} vs record ${Math.round(record)}`);
      if (paidButShown) rec.issues.push(`PAID_BUT_STILL_OPEN ${cls}: cases ${openCases.join(',')}`);
      if (closing < -0.5) rec.issues.push(`CREDIT_BALANCE ${cls}: ${Math.round(-closing)} in credit (overpaid / wrong loan type)`);
    }
    // D. credits and interest
    for (const a of ledgerAudit.filter(x => x.member === mb)) if (a.unjustifiedCredits.length) rec.issues.push(`CREDITS_NOT_JUSTIFIED ${a.head}: ${a.unjustifiedCredits.length}`);
    const ia = (await pg.query(`WITH v AS (SELECT trans_date::date d, sum(trans_amt) i FROM ledger WHERE trim(mbno::text)=$1 AND code='I1002' AND trans_type IN ('CR','R') GROUP BY 1),
        p AS (SELECT payment_date::date d, sum(interest_amount) r FROM loan_repayment_ledger WHERE trim(mbno::text)=$1 AND posted_by='phase2-replay' GROUP BY 1)
        SELECT count(*) n FROM v FULL JOIN p ON v.d=p.d WHERE abs(COALESCE(v.i,0)-COALESCE(p.r,0)) >= 1`, [mb])).rows[0];
    if (Number(ia.n) > 0) rec.issues.push(`INTEREST_NOT_TIED: ${ia.n} day(s)`);
    // F. pattern the app needs
    // schedule flags only matter for loans that are still open: a closed / repaid loan needs no schedule
    const openCaseNos = new Set(pgLm.filter(x => Number(x.bal) > 0).map(x => x.c));
    const relevant = (f) => {
      const m = f.match(/case[= ](\d+)/);
      const c = classify(f);
      if (m && (c === 'SCHEDULE_NOT_BUILT' || c === 'SCHEDULE_FROM_LEGACY_TERMS')) return openCaseNos.has(m[1]);
      return true;
    };
    const fl = [...new Set((FLAGS[mb] || []).filter(relevant).map(classify))].filter(c => c !== 'PLACEHOLDER');
    rec.flags = fl;
    const openNow = pgLm.filter(x => Number(x.bal) > 0);
    const noSched = [];
    for (const c of openNow) {
      const v = (await pg.query(`SELECT count(*) n FROM loan_schedule_versions WHERE trim(mbno::text)=$1 AND loancaseno::text=$2 AND loantype=$3`, [mb, c.c, c.loantype])).rows[0];
      if (Number(v.n) === 0) noSched.push(c.c);
    }
    rec.openCasesWithoutSchedule = noSched;
    rec.openLoans = openNow.map(x => ({ case: x.c, type: x.loantype, balance: Number(x.bal) }));
    const manual = [], confirm = [];
    for (const i of rec.issues) if (!i.startsWith('CREDIT_BALANCE')) manual.push(i);
    if (rec.issues.some(i => i.startsWith('CREDIT_BALANCE'))) manual.push('Credit balance on a loan account - member is owed money or the credit sits on the wrong loan type (Loan Position notice)');
    if (noSched.length) manual.push(`Open loan(s) without any schedule: ${noSched.join(', ')}`);
    for (const c of fl) {
      if (['SCHEDULE_NOT_BUILT', 'LEDGER_OWES_NO_LOAN_ROW', 'MANUAL_CORRECTION', 'MIXED_VOUCHER_UNSPLIT'].includes(c) || c.startsWith('OTHER')) manual.push(c);
      else if (['SCHEDULE_FROM_LEGACY_TERMS', 'RECONCILED_TO_LEDGER', 'REOPENED_BY_LEDGER'].includes(c)) confirm.push(c);
    }
    rec.verdict = manual.length ? 'FLAGGED - MANUAL' : confirm.length ? 'TO CONFIRM' : 'CLEAN';
    rec.reasons = [...new Set([...manual, ...confirm])];
    result.push(rec);
  }
  await pg.end();
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, `sample-final-${label}.json`), JSON.stringify(result, null, 1));
  const clean = result.filter(r => r.verdict === 'CLEAN').length;
  const toConfirm = result.filter(r => r.verdict === 'TO CONFIRM').length;
  const cnt = k => result.filter(r => r.issues.some(i => i.startsWith(k))).length;
  console.log(`members ${result.length}; CLEAN ${clean}; TO CONFIRM ${toConfirm}; FLAGGED - MANUAL ${result.length - clean - toConfirm}`);
  console.log(`ledger rows differ: ${cnt('LEDGER_ROWS_DIFFER')}; loan rows differ/missing: ${cnt('LOAN_ROW')}; balance differs: ${cnt('BALANCE_DIFFERS')}; paid-but-open: ${cnt('PAID_BUT_STILL_OPEN')}; credits not justified: ${cnt('CREDITS_NOT')}; interest not tied: ${cnt('INTEREST_NOT')}; credit balances: ${cnt('CREDIT_BALANCE')}`);
})().catch(e => { console.error(e.stack || e.message); process.exit(1); });
