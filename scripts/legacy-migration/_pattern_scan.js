'use strict';
/**
 * Read-only scan of every real loan account (member + loan type) that is active in the ledger or on the loan record.
 * For each account it records (a) which repayment PATTERNS it shows (P01..P12, see the Excel register) and
 * (b) which MIGRATION ISSUES it carries (I1..I7). Output: reports/pattern-scan-<label>.json
 *
 * Usage: node _pattern_scan.js <label>      e.g. before / after-demand-only
 */
const fs = require('node:fs');
const path = require('node:path');
const { Client } = require('pg');
const { targetConfig, OUT } = require('./inspect');

// Opening balance of a loan head, counted once (copy of backend/src/modules/loan/loan-opening-balance.ts - keep in step).
const OPEN = (mbno, isReg) => `(
  SELECT COALESCE(SUM(lm.openbalance), 0) FROM loan_master lm
   WHERE lm.mbno = ${mbno} AND ((lm.loantype = 'RLN') = ${isReg}) AND lm.openbalance > 0
     AND lm.payment_date = (SELECT MAX(x.payment_date) FROM loan_master x
        WHERE x.mbno = lm.mbno AND ((x.loantype = 'RLN') = ${isReg}) AND x.openbalance > 0
          AND x.payment_date < COALESCE((SELECT MIN(l.trans_date) FROM ledger l WHERE l.mbno = lm.mbno AND l.code = CASE WHEN ${isReg} THEN 'A1002' ELSE 'A1047' END), '9999-12-31')))`;

const SQL = `
WITH loans AS MATERIALIZED (
  SELECT lm.mbno, CASE WHEN lm.loantype = 'RLN' THEN 'RLN' ELSE 'ALN' END AS acc,
         (array_agg(lm.loancaseno::text ORDER BY lm.payment_date DESC) FILTER (WHERE lm.balance > 0))[1] AS caseno,
         (array_agg(lm.loancaseno::text ORDER BY lm.payment_date DESC))[1] AS latest_case,
         max(lm.payment_date) FILTER (WHERE lm.balance > 0) AS started,
         max(lm.payment_date) AS any_started,
         sum(lm.balance) AS rec_bal, sum(lm.openbalance) AS ob,
         bool_or(lm.payroll_lag_watch_until IS NOT NULL AND lm.balance > 0) AS watched,
         count(*) FILTER (WHERE lm.balance > 0) AS open_cases
    FROM loan_master lm WHERE (lm.mbno < 900000000 OR (lm.mbno >= 900017000 AND lm.mbno < 9000000000)) GROUP BY 1, 2),
led AS MATERIALIZED (
  SELECT a.mbno, a.acc,
         sum(CASE WHEN l.trans_type IN ('DR','P') THEN l.trans_amt WHEN l.trans_type IN ('CR','R') THEN -l.trans_amt ELSE 0 END) AS net
    FROM loans a JOIN ledger l ON l.mbno = a.mbno AND l.code = CASE WHEN a.acc = 'RLN' THEN 'A1002' ELSE 'A1047' END
   GROUP BY 1, 2),
scope AS MATERIALIZED (
  SELECT a.*, ${OPEN('a.mbno', "(a.acc = 'RLN')")} + COALESCE(l.net, 0) AS led_bal,
         COALESCE(a.started, a.any_started) - interval '1 day' AS win_start
    FROM loans a LEFT JOIN led l ON l.mbno = a.mbno AND l.acc = a.acc
   WHERE ${OPEN('a.mbno', "(a.acc = 'RLN')")} + COALESCE(l.net, 0) > 100 OR COALESCE(a.rec_bal, 0) > 0),
rws AS MATERIALIZED (
  SELECT s.mbno, s.acc, l.trans_date AS t, l.vchr_type AS v, l.trans_type AS tt, l.trans_amt AS amt, l.receipt_vchr_no AS rv,
         row_number() OVER (PARTITION BY s.mbno, s.acc ORDER BY l.trans_date, l.ledgerid) AS rn
    FROM scope s JOIN ledger l ON l.mbno = s.mbno AND l.code = CASE WHEN s.acc = 'RLN' THEN 'A1002' ELSE 'A1047' END
   WHERE l.trans_date >= s.win_start),
feat AS (
  SELECT s.mbno, s.acc,
         count(*) FILTER (WHERE r.tt = 'CR' AND r.v = 'D') AS nd,
         count(*) FILTER (WHERE r.tt = 'CR' AND r.v = 'R') AS nr,
         count(distinct r.amt) FILTER (WHERE r.tt = 'CR' AND r.v = 'D') AS da,
         count(*) FILTER (WHERE r.tt = 'DR' AND r.v = 'P' AND r.t > s.win_start + interval '3 days') AS topups,
         count(*) FILTER (WHERE r.v = 'J') AS nj,
         max(r.t) FILTER (WHERE r.tt = 'CR') AS last_cr,
         count(*) FILTER (WHERE r.tt = 'CR') AS ncr
    FROM scope s LEFT JOIN rws r ON r.mbno = s.mbno AND r.acc = s.acc GROUP BY 1, 2),
both_m AS (
  SELECT mbno, acc FROM (SELECT mbno, acc, date_trunc('month', t) m, bool_or(v = 'D') d, bool_or(v = 'R') r FROM rws WHERE tt = 'CR' GROUP BY 1, 2, 3) q
   WHERE d AND r GROUP BY 1, 2 HAVING count(*) >= 2),
usual AS (SELECT mbno, acc, mode() WITHIN GROUP (ORDER BY amt) AS emi FROM rws WHERE tt = 'CR' AND v = 'D' GROUP BY 1, 2 HAVING count(*) >= 3),
lump AS (SELECT DISTINCT r.mbno, r.acc FROM rws r JOIN usual u USING (mbno, acc) WHERE r.tt = 'CR' AND r.v = 'R' AND r.amt >= u.emi * 6),
gaps AS (
  SELECT mbno, acc FROM (SELECT mbno, acc, t - lag(t) OVER (PARTITION BY mbno, acc ORDER BY rn) AS g FROM rws WHERE tt = 'CR' AND v = 'D') q
   WHERE g > interval '45 days' GROUP BY 1, 2),
cash_ni AS (
  SELECT DISTINCT r.mbno, r.acc FROM rws r
   WHERE r.tt = 'CR' AND r.v = 'R'
     AND NOT EXISTS (SELECT 1 FROM ledger i WHERE i.receipt_vchr_no = r.rv AND i.mbno = r.mbno AND i.code = 'I1002' AND i.trans_type = 'CR' AND i.trans_amt > 0)),
ver AS (
  SELECT sv.mbno, sv.loancaseno::text AS c, sv.source, sv.first_due_month::date AS fd,
         (date_trunc('month', sv.effective_date + interval '5.5 hours') + (sv.delay_months || ' months')::interval)::date AS rule_fd
    FROM loan_schedule_versions sv
   WHERE sv.version_no = (SELECT max(s2.version_no) FROM loan_schedule_versions s2 WHERE s2.mbno = sv.mbno AND s2.loancaseno = sv.loancaseno)),
lagfd AS (
  SELECT r.mbno, r.loancaseno AS c, count(*) AS n
    FROM loan_repayment_ledger r JOIN ver v ON v.mbno = r.mbno AND v.c = r.loancaseno
   WHERE r.is_payroll_lag_credit AND v.source = 'ORIGINATION' AND to_char(r.payment_date, 'YYYY-MM') = to_char(v.rule_fd, 'YYYY-MM')
   GROUP BY 1, 2),
anylag AS (SELECT r.mbno, r.loancaseno AS c, count(*) AS n FROM loan_repayment_ledger r WHERE r.is_payroll_lag_credit GROUP BY 1, 2),
lagoff AS (
  SELECT lm.mbno, lm.loancaseno::text AS c, COALESCE(sum(r.principal_amount), 0) AS lag_principal
    FROM loan_master lm
    JOIN loan_repayment_ledger r ON r.mbno = lm.mbno AND r.loancaseno::text = lm.loancaseno::text AND r.loantype = lm.loantype
         AND r.is_payroll_lag_credit AND r.payment_date >= COALESCE((SELECT max(effective_date) FROM loan_schedule_versions s3 WHERE s3.mbno = lm.mbno AND s3.loancaseno::text = lm.loancaseno::text), lm.payment_date)
   WHERE lm.balance > 0 GROUP BY 1, 2),
failed AS (SELECT DISTINCT trim(mbno::text) AS m FROM legacy_replay_batch_log WHERE status = 'failed')
SELECT s.mbno::text AS member_no,
       trim(coalesce(m.f_name, '') || ' ' || coalesce(m.l_name, '')) AS member_name,
       s.acc AS loan_type, s.caseno AS loan_case, s.open_cases,
       lm.loan_amt, lm.no_of_instal, lm.instal_amt, to_char(lm.payment_date, 'YYYY-MM-DD') AS case_date,
       round(s.led_bal) AS ledger_balance, round(coalesce(s.rec_bal, 0)) AS record_balance,
       round(s.led_bal - coalesce(s.rec_bal, 0)) AS difference,
       f.nd AS demand_payments, f.nr AS cash_payments, f.topups, f.nj AS journals, to_char(f.last_cr, 'YYYY-MM-DD') AS last_payment,
       (f.nd >= 6 AND f.nr = 0) AS p01_demand_only,
       (f.nr >= 3 AND f.nd = 0) AS p02_cash_only,
       (bm.mbno IS NOT NULL) AS p03_demand_and_cash_same_month,
       (f.topups >= 1) AS p04_topups_while_paying,
       (f.nd >= 6 AND f.da >= 4) AS p05_emi_amount_changes,
       (lp.mbno IS NOT NULL) AS p06_cash_lump_sum,
       (f.last_cr IS NULL OR f.last_cr < now() - interval '12 months') AS p07_silent_12_months,
       (f.nj > 0) AS p08_journal_entries,
       (s.watched OR coalesce(v.source, '') = 'CONSOLIDATION' OR exists (SELECT 1 FROM loan_master x WHERE x.mbno = s.mbno AND x.consolidated_into_loancaseno IS NOT NULL)) AS p09_consolidated_loan,
       (f.ncr = 0 AND s.any_started < now() - interval '60 days') AS p10_never_paid,
       (gp.mbno IS NOT NULL) AS p11_gap_in_demand_payments,
       (cn.mbno IS NOT NULL) AS p12_cash_receipt_without_interest,
       (v.c IS NOT NULL) AS has_schedule,
       to_char(v.fd, 'YYYY-MM') AS first_due_stored, to_char(v.rule_fd, 'YYYY-MM') AS first_due_by_rule,
       (v.c IS NOT NULL AND v.fd > v.rule_fd) AS i1_first_due_month_late,
       (coalesce(lf.n, 0) > 0) AS i2_first_emi_marked_old_loan,
       (s.caseno IS NOT NULL AND v.c IS NULL) AS i3_no_schedule_version,
       (fl.m IS NOT NULL) AS i4_replay_failed_for_member,
       (coalesce(s.rec_bal, 0) > 0 AND s.led_bal <= 100) AS i5_record_open_ledger_closed,
       (s.led_bal > 100 AND coalesce(s.rec_bal, 0) > 0 AND abs(s.led_bal - s.rec_bal) > 10) AS i6_ledger_record_differ,
       (s.led_bal > 100 AND coalesce(s.rec_bal, 0) <= 0) AS i7_ledger_open_record_closed,
       coalesce(al.n, 0) AS old_emi_rows,
       round(coalesce(lo.lag_principal, 0)) AS lag_principal
  FROM scope s
  JOIN member_master m ON m.mbno = s.mbno
  JOIN feat f ON f.mbno = s.mbno AND f.acc = s.acc
  LEFT JOIN loan_master lm ON lm.mbno = s.mbno AND lm.loancaseno::text = coalesce(s.caseno, s.latest_case)
  LEFT JOIN both_m bm ON bm.mbno = s.mbno AND bm.acc = s.acc
  LEFT JOIN lump lp ON lp.mbno = s.mbno AND lp.acc = s.acc
  LEFT JOIN gaps gp ON gp.mbno = s.mbno AND gp.acc = s.acc
  LEFT JOIN cash_ni cn ON cn.mbno = s.mbno AND cn.acc = s.acc
  LEFT JOIN ver v ON v.mbno = s.mbno AND v.c = coalesce(s.caseno, s.latest_case)
  LEFT JOIN lagfd lf ON lf.mbno = s.mbno AND lf.c = coalesce(s.caseno, s.latest_case)
  LEFT JOIN anylag al ON al.mbno = s.mbno AND al.c = coalesce(s.caseno, s.latest_case)
  LEFT JOIN lagoff lo ON lo.mbno = s.mbno AND lo.c = coalesce(s.caseno, s.latest_case)
  LEFT JOIN failed fl ON fl.m = s.mbno::text
 ORDER BY s.mbno, s.acc`;

(async () => {
  const label = process.argv[2] || 'scan';
  const pg = new Client(targetConfig());
  await pg.connect();
  await pg.query("SET statement_timeout = '15min'");
  const t0 = Date.now();
  const rows = (await pg.query(SQL)).rows;
  await pg.end();
  fs.mkdirSync(OUT, { recursive: true });
  const file = path.join(OUT, `pattern-scan-${label}.json`);
  fs.writeFileSync(file, JSON.stringify(rows));
  console.log(`accounts: ${rows.length}, seconds: ${Math.round((Date.now() - t0) / 1000)}, file: ${file}`);
})().catch((e) => { console.error(e.stack || e.message); process.exit(1); });
