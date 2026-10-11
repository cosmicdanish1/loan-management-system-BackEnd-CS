'use strict';
// Read-only acceptance test: every interest credit (I1002) in the ledger must be carried by replayed repayments, compared per member + DAY
// (several vouchers can fall on one day; one payment can be split over two cases).
const fs = require('node:fs');
const { Client } = require('pg');
const { targetConfig } = require('./inspect');
(async () => {
  const members = fs.readFileSync(process.env.MBNO_FILE, 'utf8').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  const pg = new Client(targetConfig()); await pg.connect();
  const rows = (await pg.query(`
    WITH v AS (SELECT trim(mbno::text) mb, trans_date::date d, string_agg(DISTINCT receipt_vchr_no, ',') rvs, sum(trans_amt) i
                 FROM ledger WHERE trim(mbno::text) = ANY($1) AND code = 'I1002' AND trans_type IN ('CR','R') GROUP BY 1, 2),
         p AS (SELECT trim(mbno::text) mb, payment_date::date d, sum(interest_amount) rep
                 FROM loan_repayment_ledger WHERE trim(mbno::text) = ANY($1) AND posted_by = 'phase2-replay' GROUP BY 1, 2)
    SELECT COALESCE(v.mb, p.mb) mb, COALESCE(v.d, p.d) d, v.rvs, COALESCE(v.i, 0) i, COALESCE(p.rep, 0) rep
      FROM v FULL JOIN p ON v.mb = p.mb AND v.d = p.d WHERE abs(COALESCE(v.i, 0) - COALESCE(p.rep, 0)) >= 1 ORDER BY 1, 2`, [members])).rows;
  await pg.end();
  const by = new Map(); for (const r of rows) by.set(r.mb, (by.get(r.mb) || 0) + Number(r.i) - Number(r.rep));
  const cnt = {}; for (const r of rows) cnt[r.mb] = (cnt[r.mb] || 0) + 1;
  require('node:fs').writeFileSync(require('node:path').join(__dirname, 'reports', `interest-audit-${process.argv[2] || 'final'}.json`), JSON.stringify({ members: cnt }));
  console.log(`members ${members.length}; interest ties on ${members.length - by.size}; differs on ${by.size}; days differing ${rows.length}`);
  for (const r of rows.slice(0, 12)) console.log(r.mb, r.d.toISOString().slice(0, 10), r.rvs, 'ledger', Number(r.i), 'replayed', Number(r.rep));
})().catch(e => { console.error(e.message); process.exit(1); });
