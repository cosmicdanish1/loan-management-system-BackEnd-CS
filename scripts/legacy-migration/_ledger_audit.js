'use strict';
/**
 * Invariant audit (read-only) for a member list:
 *  1. CLOSING BALANCE: per member + loan head, ledger closing balance == sum of loan-record balances (+ lag principal kept aside, reported separately).
 *  2. EVERY CREDIT JUSTIFIED: every CR/R row on the loan head must be a replayed repayment row (same date, same principal) or a
 *     consolidation close row; anything else is listed as UNJUSTIFIED with the date/amount/voucher.
 * Usage: MBNO_FILE=reports/sample50-members.txt node _ledger_audit.js [label]   -> reports/ledger-audit-<label>.json
 */
const fs = require('node:fs');
const path = require('node:path');
const { Client } = require('pg');
// Opening balance of a loan head, counted once (copy of backend/src/modules/loan/loan-opening-balance.ts - keep in step).
const OPEN = (mbno, isReg) => `(
  SELECT COALESCE(SUM(lm.openbalance), 0) FROM loan_master lm
   WHERE lm.mbno = ${mbno} AND ((lm.loantype = 'RLN') = ${isReg}) AND lm.openbalance > 0
     AND lm.payment_date = (SELECT MAX(x.payment_date) FROM loan_master x
        WHERE x.mbno = lm.mbno AND ((x.loantype = 'RLN') = ${isReg}) AND x.openbalance > 0
          AND x.payment_date < COALESCE((SELECT MIN(l.trans_date) FROM ledger l WHERE l.mbno = lm.mbno AND l.code = CASE WHEN ${isReg} THEN 'A1002' ELSE 'A1047' END), '9999-12-31')))`;
const { targetConfig, OUT } = require('./inspect');
const CORR = (() => { try { return JSON.parse(fs.readFileSync(path.join(__dirname, 'manual-corrections.json'), 'utf8')); } catch (e) { return []; } })();
const corrAdj = (mb, code) => CORR.filter(c => String(c.mbno) === String(mb)).reduce((a, c) => a + (c.code === code ? c.amount : 0) - (c.toCode === code ? c.amount : 0), 0);
(async () => {
  const members = fs.readFileSync(process.env.MBNO_FILE, 'utf8').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  const label = process.argv[2] || 'audit';
  const pg = new Client(targetConfig()); await pg.connect();
  const out = [];
  for (const head of [['RLN', 'A1002'], ['ALN', 'A1047']]) {
    const [cls, code] = head;
    const rows = (await pg.query(`
      WITH m AS (SELECT unnest($1::text[]) AS mb),
      led AS (SELECT l.mbno::text mb, l.trans_date::date d, l.trans_type t, l.vchr_type v, l.trans_amt amt, l.receipt_vchr_no rv, l.ledgerid id
                FROM ledger l JOIN m ON trim(l.mbno::text) = m.mb WHERE l.code = $2),
      ob AS (SELECT m.mb, ${OPEN('m.mb::numeric', "($3 = 'RLN')")} ob,
                    (SELECT COALESCE(sum(lm2.balance), 0) FROM loan_master lm2 WHERE trim(lm2.mbno::text) = m.mb AND (lm2.loantype = 'RLN') = ($3 = 'RLN')) rec
               FROM m),
      lag AS (SELECT r.mbno::text mb, sum(r.principal_amount) lagp
                FROM loan_repayment_ledger r JOIN m ON trim(r.mbno::text) = m.mb
               WHERE r.is_payroll_lag_credit AND (r.loantype = 'RLN') = ($3 = 'RLN') GROUP BY 1)
      SELECT m.mb, COALESCE(ob.ob,0) AS opening, COALESCE(ob.rec,0) AS record, COALESCE(lag.lagp,0) AS lag,
             COALESCE(ob.ob,0) + COALESCE((SELECT sum(CASE WHEN t IN ('DR','P') THEN amt ELSE -amt END) FROM led WHERE led.mb = m.mb),0) AS ledger
        FROM m LEFT JOIN ob ON ob.mb = m.mb LEFT JOIN lag ON lag.mb = m.mb`, [members, code, cls])).rows;
    for (const r of rows) {
      const hasLedger = Number(r.ledger) !== Number(r.opening) || Number(r.record) > 0 || Number(r.opening) > 0;
      if (!hasLedger) continue;
      // every credit must be justified: matched to a replayed repayment row (same date + principal), or a consolidation close row on that
      // date, or be an overpayment (the head was already repaid when it arrived), or a zero-amount row.
      const led = (await pg.query(`SELECT trans_date::date d, trans_type t, vchr_type v, trans_amt amt, receipt_vchr_no rv FROM ledger
                                    WHERE trim(mbno::text) = $1 AND code = $2 ORDER BY trans_date, ledgerid`, [r.mb, code])).rows;
      const rep = (await pg.query(`SELECT payment_date::date d, principal_amount p, narration n FROM loan_repayment_ledger
                                    WHERE trim(mbno::text) = $1 AND (loantype = 'RLN') = ($2 = 'RLN')`, [r.mb, cls])).rows
        .map(x => ({ d: x.d.toISOString().slice(0, 10), p: Number(x.p), close: String(x.n || '').startsWith('Legacy consolidation replay'), used: false }));
      // Credits are compared per DAY: a payment may be split over two cases (one used up inside the same payment), so the replayed
      // principal of that day must add up to the credits of that day.
      const repByDay = new Map(); for (const y of rep) repByDay.set(y.d, (repByDay.get(y.d) || 0) + y.p);
      const closeDays = new Set(rep.filter(y => y.close).map(y => y.d));
      let run = Number(r.opening);
      const cr = []; const overpaid = []; const dayCr = new Map();
      for (const x of led) {
        const d = x.d.toISOString().slice(0, 10); const amt = Number(x.amt);
        if (x.t === 'DR' || x.t === 'P') { run += amt; continue; }
        const before = run; run -= amt;
        if (amt < 0.5) continue;
        if (closeDays.has(d)) continue;
        if (CORR.some(c => String(c.mbno) === String(r.mb) && c.code === code && c.date === d && Math.abs(c.amount - amt) < 0.5)) continue;   // moved by a manual correction
        const e = dayCr.get(d) || { total: 0, rows: [], before };
        e.total += amt; e.rows.push({ vchr: x.v, amount: amt, voucher: x.rv }); dayCr.set(d, e);
      }
      for (const [d, e] of dayCr) {
        const got = repByDay.get(d) || 0;
        if (got + 0.5 >= e.total) continue;                     // fully replayed (possibly split over cases)
        const missing = Math.round((e.total - got) * 100) / 100;
        const excess = Math.max(0, e.total - Math.max(0, e.before));   // credit above what was owed = overpayment
        if (missing <= excess + 0.5) overpaid.push({ date: d, amount: missing });
        else cr.push({ date: d, vchr: e.rows.map(z => z.vchr).join(''), amount: missing, voucher: e.rows[0].voucher, headBalanceBefore: Math.round(e.before) });
      }
      out.push({ member: r.mb, head: cls, ledgerClosing: Number(r.ledger) + corrAdj(r.mb, code), recordBalance: Number(r.record), lagKeptAside: Number(r.lag),
                 closingMatches: Math.abs(Number(r.ledger) + corrAdj(r.mb, code) - Number(r.record)) <= 10 || (Number(r.ledger) + corrAdj(r.mb, code) <= 0.5 && Number(r.record) === 0), matchesAfterLag: Math.abs(Number(r.ledger) - (Number(r.record) - Number(r.lag))) <= 10,
                 unjustifiedCredits: cr, overpayments: overpaid });
    }
  }
  await pg.end();
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, `ledger-audit-${label}.json`), JSON.stringify(out, null, 1));
  const active = out.filter(o => o.ledgerClosing > 100 || o.recordBalance > 0);
  console.log(`head accounts ${out.length}, active ${active.length}; closing matches ${active.filter(o => o.closingMatches).length}; `
    + `match after lag ${active.filter(o => !o.closingMatches && o.matchesAfterLag).length}; with unjustified credits ${active.filter(o => o.unjustifiedCredits.length).length} `
    + `(${active.reduce((s, o) => s + o.unjustifiedCredits.length, 0)} rows)`);
})().catch(e => { console.error(e.stack || e.message); process.exit(1); });
