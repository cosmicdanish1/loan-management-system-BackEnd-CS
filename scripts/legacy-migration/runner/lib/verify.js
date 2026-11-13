'use strict';
// Step 15: post-load verification suite (44.3) + the report lines from the table sections.
// Everything here READS (legacy and target). Results go into the ReviewReport as checks.
const dec = require('./dec');
const canon = require('./canon');
const d = require('./derive');
const spec = require('./spec');
const { mapColumns } = require('./colmap');
const { legacyBatches, legacySums } = require('./engine');
const { QUERIES, runQuery } = require('./reportqueries');
const { pgq } = require('./target');

// ---------------------------------------------------------------- table counts / sums / (optional) hashes
async function verifyTables(ctx, { deep = false } = {}) {
  const { legacy, target: t, report } = ctx;
  for (const s of spec.COPY_TABLES) {
    const ls = legacySums(legacy, s);
    const n = await t.count(s.id);
    let expected = ls.rows;
    if (s.id === 'busrules') expected += 1; // go-live row
    if (s.id === 'headmaster') { /* seeded heads may be present */ }
    const baseline = ctx.baseline && ctx.baseline.get(s.id);
    const okCount = s.id === 'headmaster' ? n >= ls.rows : n === expected;
    const okBase = !baseline || baseline.rows === ls.rows;
    let detail = `${n} rows (legacy ${ls.rows}${baseline ? `, baseline ${baseline.rows}` : ''}, dump reference ${s.dump})`;
    let okSum = true;
    for (const c of s.sums || []) {
      if (s.insertMissingBy) continue;
      const tv = dec.normalize(await t.scalar(`SELECT coalesce(sum(${pgq(c.toLowerCase())}),0)::text FROM ${pgq(s.id)}`) ?? '0');
      if (!dec.eq(tv, ls.sums[c])) { okSum = false; detail += `; sum ${c} ${tv} != legacy ${ls.sums[c]}`; }
    }
    report.check({ name: `${s.id}: row count and sums equal the legacy baseline`, section: s.section, ok: okCount && okBase && okSum, detail });
    if (deep && !['member_master', 'headmaster', 'busrules'].includes(s.id) && !s.constants) {
      const ok = await rehash(ctx, s);
      report.check({ name: `${s.id}: SHA-256 of all columns equals legacy`, section: s.section, ok: ok.ok, detail: ok.detail });
    }
  }
}

/** Fingerprint legacy rows and target rows with the same (target) kinds and compare. */
async function rehash(ctx, s) {
  const map = mapColumns(ctx.legacy.columns(s.legacy), await ctx.target.columns(s.id));
  const cols = map.shared.map(c => ({ name: c.name, kind: c.kind }));
  const a = new canon.MultisetFingerprint(), b = new canon.MultisetFingerprint();
  for (const batch of legacyBatches(ctx.legacy, s, map.shared)) for (const r of batch) a.add(canon.canonRow(r, cols));
  for await (const rows of ctx.target.cursor(`SELECT ${cols.map(c => pgq(c.name)).join(',')} FROM ${pgq(s.id)}`)) for (const r of rows) b.add(canon.canonRow(r, cols));
  return { ok: a.count === b.count && a.hex() === b.hex(), detail: `${b.count} rows, ${b.hex().slice(0, 16)}...` };
}

// ---------------------------------------------------------------- ledger aggregates and trial balance
async function verifyLedger(ctx) {
  const { legacy, target: t, report } = ctx;
  const L = legacy.rows(`SELECT CONVERT(varchar(60),SUM(CASE WHEN TRANS_TYPE='DR' THEN TRANS_AMT ELSE 0 END)) AS dr, CONVERT(varchar(60),SUM(CASE WHEN TRANS_TYPE='CR' THEN TRANS_AMT ELSE 0 END)) AS cr,
      CONVERT(varchar(30),COUNT_BIG(DISTINCT UPPER(LTRIM(RTRIM(RECEIPT_VCHR_NO))))) AS vouchers, CONVERT(varchar(30),MAX(LedgerId)) AS maxid, CONVERT(varchar(30),MAX(TRANS_NO)) AS maxno FROM ledger`)[0];
  const P = (await t.read(`SELECT sum(CASE WHEN upper(btrim(trans_type))='DR' THEN trans_amt ELSE 0 END)::text AS dr, sum(CASE WHEN upper(btrim(trans_type))='CR' THEN trans_amt ELSE 0 END)::text AS cr,
      count(DISTINCT upper(btrim(receipt_vchr_no)))::text AS vouchers, max(ledgerid)::text AS maxid, max(trans_no)::text AS maxno FROM ledger`))[0];
  const ok = dec.eq(L.dr, P.dr) && dec.eq(L.cr, P.cr) && L.vouchers === P.vouchers && L.maxid === P.maxid && L.maxno === P.maxno;
  report.check({ name: 'ledger: total debits, total credits, voucher count, highest LedgerId and TRANS_NO equal legacy', section: '23.4, 44.3', ok, detail: `DR ${P.dr}, CR ${P.cr}, ${P.vouchers} vouchers, max LedgerId ${P.maxid}, max TRANS_NO ${P.maxno}` });
  const diff = dec.parse(L.cr) - dec.parse(L.dr);
  report.add({ table: 'ledger', section: '23.3', code: 'credits-exceed-debits', title: 'total credits minus total debits', note: dec.format(diff), expected: '2,42,044', severity: diff === 0n ? 'INFO' : 'WARN' });
  // per head (code) debit and credit
  const lh = legacy.rows(`SELECT UPPER(LTRIM(RTRIM(CODE))) AS code, CONVERT(varchar(60),SUM(CASE WHEN TRANS_TYPE='DR' THEN TRANS_AMT ELSE 0 END)) AS dr, CONVERT(varchar(60),SUM(CASE WHEN TRANS_TYPE='CR' THEN TRANS_AMT ELSE 0 END)) AS cr FROM ledger GROUP BY UPPER(LTRIM(RTRIM(CODE)))`);
  const ph = new Map((await t.read(`SELECT upper(btrim(code)) AS code, sum(CASE WHEN upper(btrim(trans_type))='DR' THEN trans_amt ELSE 0 END)::text AS dr, sum(CASE WHEN upper(btrim(trans_type))='CR' THEN trans_amt ELSE 0 END)::text AS cr FROM ledger GROUP BY 1`)).map(r => [r.code, r]));
  const bad = lh.filter(r => { const p = ph.get(r.code); return !p || !dec.eq(p.dr, r.dr) || !dec.eq(p.cr, r.cr); }).map(r => r.code);
  report.check({ name: 'ledger: per-head debit and credit totals equal legacy', section: '23.4', ok: bad.length === 0 && ph.size === lh.length, detail: bad.length ? `differ: ${bad.slice(0, 8).join(', ')}` : `${lh.length} heads` });
  // every ledger code exists in headmaster
  const orphan = Number(await t.scalar('SELECT count(DISTINCT upper(btrim(l.code)))::text FROM ledger l WHERE NOT EXISTS (SELECT 1 FROM headmaster h WHERE upper(btrim(h.code))=upper(btrim(l.code)))'));
  report.check({ name: 'every ledger code exists in headmaster (loaded copy)', section: '32.3', ok: orphan === 0, detail: `${orphan} missing` });

  // trial balance: per head op_bal + ledger equals the legacy computation
  const lt = new Map(legacy.rows(`SELECT UPPER(LTRIM(RTRIM(h.CODE))) AS code, CONVERT(varchar(60),h.OP_BAL) AS op,
      CONVERT(varchar(60),ISNULL(g.net,0)) AS net FROM headmaster h LEFT JOIN (SELECT UPPER(LTRIM(RTRIM(CODE))) AS c, SUM(CASE WHEN TRANS_TYPE='DR' THEN TRANS_AMT ELSE -TRANS_AMT END) AS net FROM ledger GROUP BY UPPER(LTRIM(RTRIM(CODE)))) g ON g.c = UPPER(LTRIM(RTRIM(h.CODE)))`).map(r => [r.code, r]));
  const pt = await t.read(`SELECT upper(btrim(h.code)) AS code, h.op_bal::text AS op,
      coalesce(g.net,0)::text AS net FROM headmaster h LEFT JOIN (SELECT upper(btrim(code)) AS c, sum(CASE WHEN upper(btrim(trans_type))='DR' THEN trans_amt ELSE -trans_amt END) AS net FROM ledger GROUP BY 1) g ON g.c = upper(btrim(h.code))`);
  const tbBad = [];
  for (const r of pt) { const l = lt.get(r.code); if (!l) continue; /* seeded heads */ if (!dec.eq(l.op, r.op) || !dec.eq(l.net, r.net)) tbBad.push(r.code); }
  report.check({ name: 'trial balance: per head op_bal + ledger equals the legacy computation', section: '44.3', ok: tbBad.length === 0, detail: tbBad.length ? `differ: ${tbBad.slice(0, 8).join(', ')}` : `${pt.length} heads` });

  // cash in hand A1001 on the last loaded day
  const lc = legacy.rows(`SELECT CONVERT(varchar(60),(SELECT ISNULL(SUM(OP_BAL),0) FROM headmaster WHERE CODE='A1001') + ISNULL(SUM(CASE WHEN TRANS_TYPE='DR' THEN TRANS_AMT ELSE -TRANS_AMT END),0)) AS cash FROM ledger WHERE CODE='A1001'`)[0].cash;
  const pc = (await t.read("SELECT ((SELECT coalesce(sum(op_bal),0) FROM headmaster WHERE upper(btrim(code))='A1001') + coalesce(sum(CASE WHEN upper(btrim(trans_type))='DR' THEN trans_amt ELSE -trans_amt END),0))::text AS cash FROM ledger WHERE upper(btrim(code))='A1001'"))[0].cash;
  report.check({ name: 'cash in hand (A1001) on the last loaded day equals the dump', section: '44.3', ok: dec.eq(lc, pc), detail: `${pc} (legacy ${lc})` });
  if (dec.parse(pc) < 0n) report.add({ table: 'ledger', section: '39.6', code: 'cash-negative', title: 'the legacy ledger ends with NEGATIVE cash in hand (legacy data fact, loaded as is)', note: pc, expected: 'about -65.6 lakh' });
}

// ---------------------------------------------------------------- loans after Phase 2 (44.2 step 14, 44.3)
async function verifyLoans(ctx) {
  const { target: t, report } = ctx;
  if (!(await t.tableExists('legacy_replay_batch_log')) || !(await t.hasRows('legacy_replay_batch_log'))) {
    report.add({ table: 'loan_master', section: '31', code: 'phase2-not-run', title: 'Phase 2 has not run yet: loan balances are not yet verified', severity: 'INFO' });
    return;
  }
  const failed = Number(await t.scalar("SELECT count(*)::text FROM legacy_replay_batch_log WHERE status='failed'"));
  report.check({ name: 'Phase 2: members with status failed', section: '31 (Q55)', ok: failed === 0, detail: `${failed} failed` });
  for (const flag of spec.PHASE2_BLOCKING_FLAGS) {
    const n = Number(await t.scalar('SELECT count(*)::text FROM legacy_replay_batch_log WHERE flags::text ILIKE $1', ['%' + flag + '%']));
    report.check({ name: `Phase 2: members flagged ${flag}`, section: '31 (Q55)', ok: n === 0, detail: `${n} members` });
  }
  const tol = '50';
  const rows = await t.read(`WITH lm AS (SELECT mbno, sum(CASE WHEN loantype='RLN' THEN balance ELSE 0 END) AS rln, sum(CASE WHEN loantype<>'RLN' THEN balance ELSE 0 END) AS aln FROM loan_master GROUP BY mbno),
      lg AS (SELECT mbno, sum(CASE WHEN upper(btrim(code))='A1002' THEN CASE WHEN upper(btrim(trans_type))='DR' THEN trans_amt ELSE -trans_amt END ELSE 0 END) AS rln,
                         sum(CASE WHEN upper(btrim(code))='A1047' THEN CASE WHEN upper(btrim(trans_type))='DR' THEN trans_amt ELSE -trans_amt END ELSE 0 END) AS aln
             FROM ledger WHERE upper(btrim(code)) IN ('A1002','A1047') GROUP BY mbno)
    SELECT coalesce(lm.mbno, lg.mbno)::text AS mbno, coalesce(lm.rln,0)::text AS lm_rln, coalesce(lg.rln,0)::text AS lg_rln, coalesce(lm.aln,0)::text AS lm_aln, coalesce(lg.aln,0)::text AS lg_aln
    FROM lm FULL JOIN lg ON lg.mbno = lm.mbno`);
  let sumLm = 0n, sumLg = 0n; const off = [];
  for (const r of rows) {
    sumLm += dec.parse(r.lm_rln) + dec.parse(r.lm_aln); sumLg += dec.parse(r.lg_rln) + dec.parse(r.lg_aln);
    if (!dec.within(r.lm_rln, r.lg_rln, tol) || !dec.within(r.lm_aln, r.lg_aln, tol)) off.push(r.mbno);
  }
  report.check({ name: 'loan balances: loan_master per member equals the ledger loan heads (A1002, A1047), tolerance 50', section: '44.3', ok: off.length === 0, detail: `${rows.length} members, ${off.length} outside tolerance; totals loan_master ${dec.format(sumLm)} vs ledger ${dec.format(sumLg)}`, blocking: false });
  if (off.length) report.add({ table: 'loan_master', section: '31.4', code: 'loan-balance-mismatch', title: 'members whose loan_master balance differs from the ledger loan heads (flagged for the society)', count: off.length, samples: off.slice(0, 50) });
  const withBal = Number(await t.scalar('SELECT count(*)::text FROM loan_master WHERE balance > 0'));
  report.add({ table: 'loan_master', section: '44.3', code: 'loans-with-balance', title: 'number of loans with a balance after Phase 2', count: withBal, note: 'compare with the Phase 2 result printed by the replay (test run: 4,550)', severity: 'INFO' });
  const flagged = await t.read("SELECT count(*)::int AS n FROM legacy_replay_batch_log WHERE flags IS NOT NULL AND flags::text NOT IN ('[]','{}','')");
  report.add({ table: 'legacy_replay_batch_log', section: '31.2', code: 'flagged-members', title: 'members the replay finished with at least one flag (reviewed by the society)', count: flagged[0].n, severity: 'INFO' });
}

// ---------------------------------------------------------------- report lines from the table sections
function legacyReportLines(ctx, { only } = {}) {
  const out = [];
  for (const q of QUERIES) {
    if (only && !only.includes(q.id)) continue;
    const r = runQuery(ctx.legacy, q);
    out.push({ id: q.id, count: r.count, expected: q.expected });
    if (r.count > 0) ctx.report.add({ table: q.table, section: q.section, code: q.id, title: q.title, count: r.count, samples: r.samples, expected: q.expected, severity: q.severity || 'WARN' });
  }
  return out;
}

function manualSmokeTest(ctx) {
  ctx.report.add({ table: '(go-live)', section: '44.3', code: 'smoke-test', title: 'Manual smoke test through the app (not automated): login of the first administrator, a member search, a member ledger, a loan position, Cash Book 2 and a balance sheet for the last loaded date', severity: 'INFO' });
  ctx.report.add({ table: '(go-live)', section: '44.4', code: 'go-live-checklist', title: 'Go-live checklist: cut-over the same day as the final dump; first administrator, then users with ids above 55; issue the production licence; confirm the busrules go-live row; do NOT run the Year-End screens (B25); hand the owner the section 25 register and this report', severity: 'INFO' });
}

module.exports = { verifyTables, verifyLedger, verifyLoans, legacyReportLines, manualSmokeTest, rehash };
