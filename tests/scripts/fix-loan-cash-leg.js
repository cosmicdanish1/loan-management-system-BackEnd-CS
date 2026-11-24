// One-off correction (ES-630): posted loan disbursements that have the loan line but no cash (A1001) credit.
//
//   node tests/scripts/fix-loan-cash-leg.js            -> DRY RUN: prints what would change, writes nothing
//   node tests/scripts/fix-loan-cash-leg.js --apply    -> does it, all in ONE transaction (all or nothing)
//
// A voucher is corrected only when ALL of these hold (so nothing is guessed):
//   - status POSTED, remarks LOAN_CASE:..., paid by CASH, not a re-agreement
//   - it has a debit line on a loan head (A1002 / A1047 / ...), and no A1001 / bank line at all
//   - (debits - credits) of its ledger rows is > 0 AND equals the voucher's net total (what was paid out)
// For those it adds ONE row: CR A1001 (CINH), the missing amount, same date / member / user as the loan line.
// It also stamps the voucher number on the voucher's own Cash Book line when exactly one unclaimed line matches
// (same head, same amount, same day), so a later Reverse can remove it.
// Everything else that is out of balance is only LISTED (needs a person to decide).
require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });
const { Client } = require('pg');
const APPLY = process.argv.includes('--apply');

(async () => {
  const db = new Client({ host: process.env.DB_HOST, port: +process.env.DB_PORT, user: process.env.DB_USERNAME, password: process.env.DB_PASSWORD, database: process.env.DB_DATABASE });
  await db.connect();
  const rows = (await db.query(`
    SELECT v."voucherNumber" vno, v."totalAmount"::numeric total, v.remarks, v."sourceModule" src,
           COALESCE(SUM(CASE WHEN l.trans_type IN ('DR','D') THEN l.trans_amt END),0)::numeric dr,
           COALESCE(SUM(CASE WHEN l.trans_type IN ('CR','C') THEN l.trans_amt END),0)::numeric cr,
           COUNT(l.*)::int n,
           BOOL_OR(TRIM(l.code) = 'A1001' OR l.acc_type = 'BANK') has_leg,
           BOOL_OR(l.trans_type IN ('DR','D') AND l.trans_amt > 0 AND TRIM(l.code) IN ('A1002','A1047','A1048','A1003')) has_loan_dr
      FROM vouchers v LEFT JOIN ledger l ON l.receipt_vchr_no = v."voucherNumber"
     WHERE v.status = 'POSTED' AND v.remarks LIKE 'LOAN_CASE:%' AND v."sourceModule" IS DISTINCT FROM 'LOAN_REAGREEMENT'
     GROUP BY 1,2,3,4
    HAVING COALESCE(SUM(CASE WHEN l.trans_type IN ('DR','D') THEN l.trans_amt END),0) <> COALESCE(SUM(CASE WHEN l.trans_type IN ('CR','C') THEN l.trans_amt END),0)
     ORDER BY 1`)).rows;

  const fix = [], review = [];
  for (const r of rows) {
    const gap = +(r.dr - r.cr).toFixed(2);
    const cash = /PAY_MODE:cash/i.test(r.remarks);
    const ok = cash && !r.has_leg && r.has_loan_dr && gap > 0 && Math.abs(gap - r.total) < 0.005;
    (ok ? fix : review).push({ ...r, gap, why: ok ? '' : !cash ? 'not cash' : r.has_leg ? 'already has a cash/bank line' : !r.has_loan_dr ? 'no loan debit line in the ledger (test / migrated data)' : gap <= 0 ? 'credits are not smaller than debits' : `gap ${gap} is not the net total ${r.total}` });
  }

  console.log(`\nWILL CORRECT (${fix.length}):`);
  for (const f of fix) console.log(`  ${f.vno}  add CR A1001 ${f.gap}  (debits ${f.dr}, credits ${f.cr}, net ${f.total})`);
  console.log(`\nLEFT ALONE, NEEDS A PERSON TO LOOK (${review.length}):`);
  const byWhy = {};
  for (const r of review) (byWhy[r.why] = byWhy[r.why] || []).push(r.vno);
  for (const [why, list] of Object.entries(byWhy)) console.log(`  ${why}: ${list.length}  [${list.slice(0, 12).join(', ')}${list.length > 12 ? ', ...' : ''}]`);

  if (!APPLY) { console.log('\nDRY RUN - nothing written. Add --apply to do it.'); await db.end(); return; }

  await db.query('BEGIN');
  try {
    await db.query("SELECT pg_advisory_xact_lock(hashtext('ledger.ledgerid'))").catch(() => {});
    let nextLedger = +(await db.query('SELECT COALESCE(MAX(ledgerid),0)+1 n FROM ledger')).rows[0].n;
    let nextTrans = +(await db.query('SELECT COALESCE(MAX(trans_no),0)+1 n FROM ledger')).rows[0].n;
    for (const f of fix) {
      const base = (await db.query(`SELECT trans_date, mbno, acc_no, username FROM ledger WHERE receipt_vchr_no=$1 AND trans_type IN ('DR','D') ORDER BY ledgerid LIMIT 1`, [f.vno])).rows[0];
      await db.query(
        `INSERT INTO ledger (trans_no, trans_date, trans_type, code, mbno, acc_no, acc_type, trans_amt, receipt_vchr_no, vchr_type, modeofpay, pl_balance, narration, username, ledgerid)
         VALUES ($1,$2,'CR','A1001',$3,$4,'CINH',$5,$6,'JV','C',0,$7,$8,$9)`,
        [nextTrans++, base.trans_date, base.mbno, base.acc_no, f.gap, f.vno, `Loan disbursement paid in cash (correction ES-630)`, base.username, nextLedger++]);
      const head = (await db.query(`SELECT TRIM(code) code FROM ledger WHERE receipt_vchr_no=$1 AND trans_type IN ('DR','D') ORDER BY ledgerid LIMIT 1`, [f.vno])).rows[0].code;
      const cb = (await db.query(
        `SELECT ctid FROM tblcashbook WHERE voucher_no IS NULL AND TRIM(headcode)=$1 AND (COALESCE(pcash,0)+COALESCE(ptransfer,0))=$2 AND trans_date::date = $3::date`,
        [head, f.gap, base.trans_date])).rows;
      if (cb.length === 1) await db.query('UPDATE tblcashbook SET voucher_no=$1 WHERE ctid=$2', [f.vno, cb[0].ctid]);
      console.log(`  done ${f.vno}: A1001 CR ${f.gap}; Cash Book lines matched: ${cb.length}${cb.length === 1 ? ' (voucher no stamped)' : ' (left as is)'}`);
    }
    await db.query('COMMIT');
    console.log('\nCOMMITTED.');
  } catch (e) { await db.query('ROLLBACK'); console.error('ROLLED BACK:', e.message); process.exitCode = 1; }
  await db.end();
})();
