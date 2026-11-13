'use strict';
// Load steps 1 to 13 of migration-v1.md section 44.2. All of them run inside ONE Postgres transaction
// (see run-migration.js): if any check fails, everything rolls back and the target is still empty.
const fs = require('node:fs');
const dec = require('./dec');
const canon = require('./canon');
const d = require('./derive');
const { byId, COPY_TABLES, LOAN_HEADS } = require('./spec');
const { copyTable, planCopy, insertRows, legacyBatches } = require('./engine');
const { mapColumns } = require('./colmap');
const { msQuote } = require('./legacy');
const { pgq } = require('./target');

class StepError extends Error {}
const fail = (m) => { throw new StepError(m); };
const mbKey = v => dec.normalize(String(v));

// ------------------------------------------------------------------ hooks for the special copy tables
function headmasterHooks(ctx) {
  ctx.state.pflagFixed = []; ctx.state.pflagLeftBlank = [];
  return {
    transform(row) {
      const r = d.fixHeadPflag(row);
      if (r.undecided) fail(`headmaster: blank PFLAG on debit-normal E-head ${row.code}: the rule (Q57) only covers A-heads, decide before loading`);
      if (r.leftBlank) ctx.state.pflagLeftBlank.push(row.code);
      if (r.changed) ctx.state.pflagFixed.push(row.code);
      return r.row;
    },
  };
}

function memberMasterHooks(ctx) {
  const cats = ctx.legacy.rows('SELECT CONVERT(varchar(30),MBNO) AS mbno, CONVERT(varchar(10),CategoryCode) AS code FROM membercategory');
  const catByMbno = new Map();
  for (const c of cats) { const k = mbKey(c.mbno); (catByMbno.get(k) || catByMbno.set(k, []).get(k)).push(c.code); }
  const castMap = new Map(ctx.legacy.rows('SELECT CONVERT(varchar(10),ID) AS id, CastCategory AS name FROM castcategorymaster').map(r => [String(Number(r.id)), r.name]));
  ctx.state.categoryNotes = []; ctx.state.dorDiffs = []; ctx.state.memberMbnos = [];
  return {
    extraColumns: [{ name: 'full_name' }, { name: 'cast_category' }],
    transform(row) {
      row.full_name = d.fullName(row.f_name, row.m_name, row.l_name);
      const cc = d.deriveCastCategory(catByMbno.get(mbKey(row.mbno)) || [], castMap);
      row.cast_category = cc.value;
      if (cc.reason) ctx.state.categoryNotes.push({ mbno: row.mbno, reason: cc.reason });
      if (!d.isBlank(row.dor) && !d.isBlank(row.date_of_retirement) && canon.canonTimestamp(row.dor) !== canon.canonTimestamp(row.date_of_retirement)) ctx.state.dorDiffs.push({ mbno: row.mbno, dor: row.dor, date_of_retirement: row.date_of_retirement });
      ctx.state.memberMbnos.push(mbKey(row.mbno));
      return row;
    },
    // what the target must show after trigger trg_member_master_sync_retirement (11.4)
    expected(row) { return { ...row, ...d.expectedRetirement(row.dor, row.date_of_retirement) }; },
  };
}

// ------------------------------------------------------------------ copy steps
async function runCopyStep(ctx, step) {
  const recs = [];
  for (const id of step.tables) {
    const spec = byId[id];
    let hooks = {};
    if (id === 'headmaster') hooks = headmasterHooks(ctx);
    if (id === 'member_master') hooks = memberMasterHooks(ctx);
    ctx.log(`  ${planCopy(spec)}`);
    const rec = await copyTable(ctx, spec, hooks);
    ctx.report.step({ no: step.no, title: `${id}`, status: 'OK', rows: rec.inserted, seconds: rec.seconds });
    ctx.state.copied = ctx.state.copied || {}; ctx.state.copied[id] = rec;
    recs.push(rec);
    if (id === 'headmaster') await postHeadmaster(ctx);
    if (id === 'member_master') await postMemberMaster(ctx);
    if (id === 'busrules') await goLiveBusrules(ctx);
    if (id === 'voucher_master') await assertSingleRow(ctx, 'voucher_master', 1);
    if (id === 'getworkingdate') await postWorkingDate(ctx);
    if (id === 'yearend') await assertNoClosedYears(ctx);
  }
  return { rows: recs.reduce((n, r) => n + r.inserted, 0) };
}

async function assertSingleRow(ctx, table, n) {
  const c = await ctx.target.count(table);
  if (c !== n) fail(`${table}: expected exactly ${n} row(s), found ${c}`);
}

async function assertNoClosedYears(ctx) {
  const closed = Number(await ctx.target.scalar('SELECT count(*)::text FROM yearend WHERE closed_at IS NOT NULL'));
  if (closed) fail(`yearend: ${closed} year(s) have closed_at set; the load leaves it empty (Q59)`);
}

async function postWorkingDate(ctx) {
  const open = await ctx.target.read("SELECT working_date::text AS d FROM getworkingdate WHERE upper(btrim(dayend_flag)) <> 'Y' ORDER BY working_date");
  const maxLedger = await ctx.legacy.scalar('SELECT CONVERT(varchar(10),MAX(TRANS_DATE),126) AS d FROM ledger');
  if (open.length !== 1) fail(`getworkingdate: expected exactly one open working day, found ${open.length}`);
  ctx.state.openDay = open[0].d.slice(0, 10);
  if (ctx.state.openDay <= maxLedger) fail(`getworkingdate: the open day ${ctx.state.openDay} is not after the last ledger date ${maxLedger}`);
  ctx.report.check({ name: 'first open working day follows the dump\'s last day', section: '34', ok: true, detail: `open ${ctx.state.openDay}, last ledger date ${maxLedger}` });
}

async function postHeadmaster(ctx) {
  const t = ctx.target;
  const blank = Number(await t.scalar("SELECT count(*)::text FROM headmaster WHERE (pflag IS NULL OR btrim(pflag)='') AND upper(left(btrim(code),1)) IN ('A','E')"));
  ctx.report.check({ name: 'no blank PFLAG remains on an A-head or E-head', section: '32.4', ok: blank === 0, detail: `${blank} left` });
  if (blank) fail(`headmaster: ${blank} debit-normal head(s) still have a blank PFLAG`);
  if (ctx.state.pflagLeftBlank.length) ctx.report.add({ table: 'headmaster', section: '32.4', code: 'pflag-blank-credit-normal', title: 'blank PFLAG kept on credit-normal heads (blank already means credit-normal in the app; the spec counted only the 6 A-heads)', count: ctx.state.pflagLeftBlank.length, samples: ctx.state.pflagLeftBlank, severity: 'INFO' });
  const sums = Object.fromEntries((await t.read("SELECT upper(btrim(pflag)) AS f, sum(abs(op_bal))::text AS s FROM headmaster GROUP BY 1")).map(r => [r.f, r.s]));
  const a = sums.A || '0', l = sums.L || '0', e = sums.E || '0', i = sums.I || '0';
  ctx.report.check({ name: 'opening balances: assets = liabilities (within 1 rupee)', section: '32.4', ok: dec.within(a, l, '1'), detail: `A ${a}, L ${l}` });
  ctx.report.check({ name: 'opening balances: expenses = income (within 1 rupee)', section: '32.4', ok: dec.within(e, i, '1'), detail: `E ${e}, I ${i}` });
  if (!dec.within(a, l, '1') || !dec.within(e, i, '1')) fail(`headmaster: opening balances do not balance (A ${a} / L ${l}, E ${e} / I ${i})`);
  if (!dec.eq(a, l)) ctx.report.add({ table: 'headmaster', section: '32.5 (Q58)', code: 'opening-rounding', title: 'opening assets and liabilities differ by a rounding amount (kept as in legacy)', note: `assets ${a}, liabilities ${l}`, severity: 'INFO' });
  if (ctx.state.pflagFixed.length) ctx.report.add({ table: 'headmaster', section: '32.4', code: 'pflag-corrections', title: 'blank PFLAG set to A (the only change made to a legacy head)', count: ctx.state.pflagFixed.length, samples: ctx.state.pflagFixed, expected: 6, severity: 'INFO' });
  const present = Number(await t.scalar('SELECT count(*)::text FROM headmaster'));
  const legacyN = ctx.state.copied.headmaster.legacyRows;
  const seeded = present - legacyN;
  ctx.report.check({ name: 'headmaster rows = legacy heads + app-seeded heads', section: '32.4', ok: seeded >= 0, detail: `${present} rows = ${legacyN} legacy + ${seeded} seeded (dump: 153 = 151 + I1013 + I1014)` });
}

async function postMemberMaster(ctx) {
  const t = ctx.target;
  const dups = d.findDuplicates(ctx.state.memberMbnos);
  if (dups.length) fail(`member_master: duplicate member numbers loaded: ${dups.map(x => x.value).join(', ')}`);
  const empty = Number(await t.scalar("SELECT count(*)::text FROM member_master WHERE full_name IS NULL OR btrim(full_name)=''"));
  ctx.report.check({ name: 'every member has a full_name', section: '13.2', ok: empty === 0, detail: `${empty} without`, blocking: false });
  if (ctx.state.dorDiffs.length) ctx.report.add({ table: 'member_master', section: '11.4, Q16', code: 'dor-differs', title: 'legacy dor differs from date_of_retirement (date_of_retirement kept, dor follows it)', count: ctx.state.dorDiffs.length, samples: ctx.state.dorDiffs.map(x => `${x.mbno} dor=${String(x.dor).slice(0, 10)} retirement=${String(x.date_of_retirement).slice(0, 10)}`), expected: 18 });
  const notes = ctx.state.categoryNotes;
  if (notes.length) ctx.report.add({ table: 'member_master', section: '13.2, Q25', code: 'cast-category-empty', title: 'cast_category left empty (no or conflicting category)', count: notes.length, samples: notes.map(n => `${n.mbno} ${n.reason}`), expected: 4 });
}

async function goLiveBusrules(ctx) {
  const o = ctx.opts;
  const legacyRows = ctx.legacy.rows(`SELECT CONVERT(varchar(30),SRNO) AS srno, CONVERT(varchar(30),APPDATE,126) AS appdate FROM busrules`);
  const full = [];
  const srcCols = ctx.legacy.columns('busrules');
  const tgtCols = await ctx.target.columns('busrules');
  const map = mapColumns(srcCols, tgtCols);
  for (const b of legacyBatches(ctx.legacy, byId.busrules, map.shared, 1000)) full.push(...b);
  const societyValues = readSocietyValues(o.societyValuesFile);
  const { row, source, tiedOnLatestDate } = d.buildBusrulesGoLiveRow(full, societyValues, o.goLiveDate);
  const names = tgtCols.map(c => c.name).filter(n => row[n] !== undefined);
  for (const k of d.SOCIETY_BUSRULES_COLUMNS) if (!tgtCols.some(c => c.name === k)) fail(`busrules: template lacks the new column ${k}`);
  await insertRows(ctx.target, 'busrules', names, [row]);
  const latest = (await ctx.target.read('SELECT srno::text AS srno, appdate::text AS appdate FROM busrules ORDER BY appdate DESC, srno DESC LIMIT 1'))[0];
  const total = await ctx.target.count('busrules');
  const ok = dec.eq(latest.srno, row.srno) && total === legacyRows.length + 1;
  ctx.report.check({ name: 'busrules: go-live row is the unambiguous latest row', section: '42.2', ok, detail: `latest SRNO ${latest.srno} dated ${latest.appdate}; ${total} rows = ${legacyRows.length} legacy + 1` });
  if (!ok) fail('busrules: go-live row is not the latest row');
  const sameDay = o.goLiveDate === ctx.state.openDay;
  ctx.report.check({ name: 'go-live date equals the open working day of the dump (cut-over rule)', section: '34.4 (Q62)', ok: sameDay, detail: `go-live ${o.goLiveDate}, open working day ${ctx.state.openDay}${sameDay ? '' : ': the cut-over rule is final dump, load and go live the same day'}`, blocking: false });
  ctx.report.add({ table: 'busrules', section: '42.2', code: 'go-live-row', title: `go-live row added (copy of SRNO ${source.srno}, dated ${o.goLiveDate}) with the society's values for the 11 new columns`, severity: 'INFO' });
  if (tiedOnLatestDate) ctx.report.add({ table: 'busrules', section: '42.2', code: 'latest-date-tie', title: 'legacy had more than one row on its latest date (the new row removes the tie)', severity: 'INFO' });
}

function readSocietyValues(file) {
  if (!file || !fs.existsSync(file)) fail(`busrules society values file not found (${file || 'no --society-values given'})`);
  return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
}

// ------------------------------------------------------------------ step 4: office / wing masters
async function runDeriveMasters(ctx) {
  const t = ctx.target;
  const divisions = (await t.read('SELECT officeno, divno, name, address, city FROM division_master ORDER BY officeno, divno'));
  const wings = (await t.read('SELECT wingno, wname, winstate FROM wingmast ORDER BY wingno'));
  const offices = d.deriveOfficeMaster(divisions), wingRows = d.deriveWingMaster(wings);
  await insertRows(t, 'office_master', ['officeno', 'office_name', 'division', 'address', 'city'], offices);
  await insertRows(t, 'wing_master', ['wingno', 'wingname', 'status_state'], wingRows);
  const [o, w, des] = [await t.count('office_master'), await t.count('wing_master'), await t.count('designation_master')];
  const ok = o === divisions.length && w === wings.length && des === 0;
  ctx.report.check({ name: 'office_master / wing_master derived, designation_master empty', section: '43.3', ok, detail: `${o} offices (dump 6), ${w} wings (dump 1), ${des} designations` });
  if (!ok) fail(`office/wing masters: ${o}/${divisions.length}, ${w}/${wings.length}, designation ${des}`);
  ctx.report.step({ no: 4, title: 'office_master, wing_master', status: 'OK', rows: o + w });
  return { rows: o + w };
}

// ------------------------------------------------------------------ step 10: member_balances
async function runMemberBalances(ctx) {
  const { legacy, target: t } = ctx;
  const tol = ctx.opts.glTolerance || '500000';
  const members = (await t.read('SELECT mbno::text AS mbno, pfno::text AS pfno, officeno AS officeno, full_name AS name FROM member_master')).map(r => ({ ...r, mbno: mbKey(r.mbno) }));
  // legacy snapshot rows (copied columns), keyed by canonical member number
  const srcCols = legacy.columns('member_balances');
  const tgtCols = await t.columns('member_balances');
  const map = mapColumns(srcCols, tgtCols);
  if (map.missingInTarget.length) fail(`member_balances: schema drift, ${map.missingInTarget.join(', ')}`);
  const legacyRows = new Map(); const dupLegacy = [];
  for (const b of legacyBatches(legacy, { legacy: 'member_balances', order: 'physloc' }, map.shared)) for (const r of b) { const k = mbKey(r.mbno); if (legacyRows.has(k)) dupLegacy.push(k); else legacyRows.set(k, r); }
  const fundsRows = await t.read('SELECT mbno::text AS mbno, shareopbal::text AS shareopbal, cdopbal::text AS cdopbal, mdopbal::text AS mdopbal, md1_opbal::text AS md1_opbal FROM fundsmaster');
  const fundsByMbno = new Map(fundsRows.map(r => [mbKey(r.mbno), r]));
  const netRows = await t.read(`SELECT mbno::text AS mbno, upper(btrim(code)) AS code,
      sum(CASE upper(btrim(trans_type)) WHEN 'CR' THEN trans_amt WHEN 'DR' THEN -trans_amt ELSE 0 END)::text AS net
    FROM ledger WHERE upper(btrim(code)) IN ('L1001','L1004','L1002','L1045') GROUP BY 1,2`);
  const netsByMbno = new Map();
  for (const r of netRows) { const k = mbKey(r.mbno); (netsByMbno.get(k) || netsByMbno.set(k, {}).get(k))[r.code] = dec.parse(r.net); }

  const built = d.buildMemberBalanceRows({ members, legacyRows, fundsByMbno, netsByMbno });
  await insertRows(t, 'member_balances', tgtCols.map(c => c.name), built.rows);
  ctx.state.mbPopulation = built.rows.map(r => r.mbno);
  ctx.state.mbRows = built.rows.length;

  // ---- checks (19.5)
  const expectedRows = members.length + built.orphanRows.length;
  const total = await t.count('member_balances');
  if (total !== expectedRows) fail(`member_balances: ${total} rows loaded, expected ${expectedRows} (${members.length} members + ${built.orphanRows.length} legacy rows without a member)`);
  // independent recompute from the LEGACY ledger and fundsmaster (not from the loaded copies)
  const lg = legacy.rows(`SELECT CONVERT(varchar(30),MBNO) AS mbno, UPPER(LTRIM(RTRIM(CODE))) AS code,
      CONVERT(varchar(60),SUM(CASE WHEN TRANS_TYPE='CR' THEN TRANS_AMT WHEN TRANS_TYPE='DR' THEN -TRANS_AMT ELSE 0 END)) AS net
    FROM ledger WHERE CODE IN ('L1001','L1004','L1002','L1045') GROUP BY MBNO, UPPER(LTRIM(RTRIM(CODE)))`);
  const lf = legacy.rows(`SELECT CONVERT(varchar(30),MBNO) AS mbno, CONVERT(varchar(60),SHAREOPBAL) AS shareopbal, CONVERT(varchar(60),CDOPBAL) AS cdopbal, CONVERT(varchar(60),MDOPBAL) AS mdopbal, CONVERT(varchar(60),MD1_OPBAL) AS md1_opbal FROM fundsmaster`);
  const lNets = new Map(); for (const r of lg) { const k = mbKey(r.mbno); (lNets.get(k) || lNets.set(k, {}).get(k))[r.code] = dec.parse(r.net); }
  const lFunds = new Map(lf.map(r => [mbKey(r.mbno), r]));
  const loaded = new Map((await t.read('SELECT mbno::text AS mbno, shares::text AS shares, compulsory_deposit::text AS cd, frsbalance::text AS frs FROM member_balances')).map(r => [mbKey(r.mbno), r]));
  const bad = [];
  let sumShares = 0n, sumCd = 0n, sumFrs1 = 0n, sumFrs2 = 0n;
  for (const [k, r] of loaded) {
    const exp = d.deriveMemberBalance(lFunds.get(k), lNets.get(k) || {});
    if (dec.parse(r.shares) !== exp.shares || dec.parse(r.cd) !== exp.compulsory_deposit || dec.parse(r.frs) !== exp.frsbalance) bad.push(k);
    sumShares += dec.parse(r.shares); sumCd += dec.parse(r.cd);
  }
  ctx.report.check({ name: 'member_balances: every member recomputed from the legacy ledger equals the loaded row', section: '19.5', ok: bad.length === 0, detail: bad.length ? `${bad.length} differ, e.g. ${bad.slice(0, 5).join(', ')}` : `${loaded.size} rows equal` });
  if (bad.length) fail(`member_balances: ${bad.length} members differ from the independent recompute`);
  // totals against the GL heads
  const head = async code => {
    const h = (await t.read("SELECT op_bal::text AS op FROM headmaster WHERE upper(btrim(code))=$1", [code]))[0];
    const n = (await t.read("SELECT coalesce(sum(CASE upper(btrim(trans_type)) WHEN 'CR' THEN trans_amt WHEN 'DR' THEN -trans_amt ELSE 0 END),0)::text AS n FROM ledger WHERE upper(btrim(code))=$1", [code]))[0];
    return { op: h ? h.op : '0', net: dec.parse(n.n) };
  };
  const popSet = new Set(ctx.state.mbPopulation);
  const popOpening = (col) => { let s = 0n; for (const [k, f] of fundsByMbno) if (popSet.has(k)) s += dec.parse(f[col]); return s; };
  const allOpening = (col) => { let s = 0n; for (const f of fundsByMbno.values()) s += dec.parse(f[col]); return s; };
  const popNet = (code) => { let s = 0n; for (const [k, n] of netsByMbno) if (popSet.has(k)) s += n[code] || 0n; return s; };
  for (const [name, code, derivedTotal, openCol] of [['Shares', 'L1001', sumShares, 'shareopbal'], ['Compulsory deposit', 'L1004', sumCd, 'cdopbal']]) {
    const h = await head(code);
    const r = d.reconcileToGl({ derivedTotal: dec.format(derivedTotal), headOpBal: h.op, headNet: h.net, populationOpeningTotal: popOpening(openCol), populationNetTotal: popNet(code), allOpeningTotal: allOpening(openCol) });
    const ok = dec.abs(r.residual) <= dec.parse('1') && dec.abs(r.openingGapAll) <= dec.parse(tol);
    const mbno0 = (netsByMbno.get('0') || {})[code] || 0n;
    ctx.report.check({ name: `member_balances ${name} total vs GL head ${code}`, section: '19.5', ok, detail: `derived ${dec.format(derivedTotal)}, head closing ${dec.format(r.headClosing)}, gap ${dec.format(r.gap)} = opening gap ${dec.format(r.openingGap)} + movement in no member row ${dec.format(r.uncoveredMovement)} (residual ${dec.format(r.residual)}); opening gap of all fundsmaster rows ${dec.format(r.openingGapAll)}, tolerance ${tol}` });
    if (!ok) fail(`member_balances ${name}: residual ${dec.format(r.residual)} or opening gap ${dec.format(r.openingGapAll)} (tolerance ${tol}) against GL head ${code}`);
    if (r.uncoveredMovement !== 0n) ctx.report.add({ table: 'member_balances', section: '19.3', code: `gl-movement-without-member-${code}`, title: `ledger movement of head ${code} that belongs to no member_balances row (posted under MBNO 0 or to a member with no record): GL totals include it, member balances cannot`, note: `${dec.format(r.uncoveredMovement)} (of which MBNO 0: ${dec.format(mbno0)})`, severity: 'WARN' });
  }
  // FRS heads: reported, not blocking (Q38)
  let f1 = 0n, f2 = 0n;
  const nn = (k, c) => (netsByMbno.get(k) || {})[c] || 0n;
  for (const [k, f] of fundsByMbno) { if (!popSet.has(k)) continue; f1 += dec.parse(f.mdopbal) + nn(k, 'L1002'); f2 += dec.parse(f.md1_opbal) + nn(k, 'L1045'); }
  for (const [code, tot] of [['L1002', f1], ['L1045', f2]]) {
    const h = await head(code); const closing = dec.parse(h.op) + h.net;
    ctx.report.add({ table: 'member_balances', section: '19.10 (Q38)', code: `frs-${code}-gl`, title: `FRS head ${code}: derived member total vs GL head closing`, note: `derived ${dec.format(tot)}, head ${dec.format(closing)}, difference ${dec.format(tot - closing)}`, severity: dec.parse('1') >= dec.abs(tot - closing) ? 'INFO' : 'WARN' });
  }
  const neg = built.rows.filter(r => dec.parse(r.shares) < 0n || dec.parse(r.compulsory_deposit) < 0n || dec.parse(r.frsbalance) < 0n).map(r => r.mbno);
  if (neg.length) ctx.report.add({ table: 'member_balances', section: '19.5', code: 'negative-balances', title: 'members with a negative derived balance (shares, compulsory deposit or FRS)', count: neg.length, samples: neg });
  if (built.noLegacyRow.length) ctx.report.add({ table: 'member_balances', section: '19.4', code: 'no-legacy-row', title: 'members without a legacy balance row (row built from member_master and the ledger)', count: built.noLegacyRow.length, samples: built.noLegacyRow.slice(0, 50), expected: 914, severity: 'INFO' });
  if (built.orphanRows.length) ctx.report.add({ table: 'member_balances', section: '19.1', code: 'orphan-rows', title: 'legacy balance rows with no member (loaded and derived, no member record created)', count: built.orphanRows.length, samples: built.orphanRows.slice(0, 50), expected: 107 });
  if (dupLegacy.length) ctx.report.add({ table: 'member_balances', section: '19.1', code: 'legacy-duplicate-rows', title: 'legacy member_balances has more than one row for a member (first kept)', count: dupLegacy.length, samples: dupLegacy.slice(0, 50) });
  ctx.state.fundsByMbno = fundsByMbno;
  ctx.report.step({ no: 10, title: 'member_balances', status: 'OK', rows: total });
  return { rows: total };
}

// ------------------------------------------------------------------ step 11: share_monthly_balance
async function runShareMonthly(ctx) {
  const t = ctx.target;
  const start = { year: 2019, month: 11 };
  const last = (await t.read('SELECT max(trans_date)::text AS d FROM ledger'))[0].d;
  const end = { year: Number(last.slice(0, 4)), month: Number(last.slice(5, 7)) };
  const nets = (await t.read(`SELECT mbno::text AS mbno, extract(year FROM trans_date)::int AS y, extract(month FROM trans_date)::int AS m,
      sum(CASE upper(btrim(trans_type)) WHEN 'CR' THEN trans_amt WHEN 'DR' THEN -trans_amt ELSE 0 END)::text AS net
    FROM ledger WHERE upper(btrim(code))='L1001' GROUP BY 1,2,3`)).map(r => ({ mbno: mbKey(r.mbno), year: r.y, month: r.m, net: dec.parse(r.net) }));
  const openings = new Map([...ctx.state.fundsByMbno].map(([k, f]) => [k, f.shareopbal]));
  const rows = d.buildShareMonthlyRows({ population: ctx.state.mbPopulation, openings, monthlyNets: nets, start, end });
  await insertRows(t, 'share_monthly_balance', ['mbno', 'snapshot_month', 'snapshot_year', 'share_balance', 'snapshot_date'], rows);
  const n = await t.count('share_monthly_balance');
  const lastSum = (await t.read('SELECT coalesce(sum(share_balance),0)::text AS s FROM share_monthly_balance WHERE snapshot_year=$1 AND snapshot_month=$2', [end.year, end.month]))[0].s;
  const mbSum = (await t.read('SELECT coalesce(sum(shares),0)::text AS s FROM member_balances'))[0].s;
  const ok = n === rows.length && dec.eq(lastSum, mbSum);
  ctx.report.check({ name: 'share_monthly_balance: last month total equals member_balances Shares total', section: '43.3', ok, detail: `${n} rows, ${end.year}-${String(end.month).padStart(2, '0')} total ${lastSum} vs Shares ${mbSum}` });
  if (!ok) fail(`share_monthly_balance: last month ${lastSum} != member_balances.shares ${mbSum} (rows ${n}/${rows.length})`);
  ctx.report.step({ no: 11, title: 'share_monthly_balance', status: 'OK', rows: n });
  return { rows: n };
}

// ------------------------------------------------------------------ step 12: tblcashbook
async function runCashbook(ctx) {
  const { legacy, target: t } = ctx;
  const agg = (await t.read(`SELECT trans_date::date::text AS date, btrim(code) AS code, upper(btrim(trans_type)) AS tt,
      CASE WHEN upper(btrim(coalesce(modeofpay,'')))='C' THEN 'C' ELSE 'O' END AS mode, sum(trans_amt)::text AS amt
    FROM ledger WHERE upper(btrim(code)) <> 'A1001' AND trans_date >= DATE '2019-11-01' GROUP BY 1,2,3,4`));
  const headNames = new Map((await t.read('SELECT btrim(code) AS code, head_name FROM headmaster')).map(r => [r.code, r.head_name]));
  const rows = d.buildCashbookRows(agg, headNames);
  const lastDay = (await t.read('SELECT max(trans_date)::date::text AS d FROM ledger'))[0].d;
  // ledger cash in hand (A1001) through the last loaded day, computed on the LEGACY ledger (independent of the load)
  const cash = legacy.rows(`SELECT CONVERT(varchar(60),(SELECT ISNULL(SUM(OP_BAL),0) FROM headmaster WHERE CODE='A1001')) AS op,
      CONVERT(varchar(60),ISNULL(SUM(CASE WHEN TRANS_TYPE='DR' THEN TRANS_AMT ELSE 0 END),0)) AS dr,
      CONVERT(varchar(60),ISNULL(SUM(CASE WHEN TRANS_TYPE='CR' THEN TRANS_AMT ELSE 0 END),0)) AS cr FROM ledger WHERE CODE='A1001'`)[0];
  const cih = d.cashInHand(cash.op, cash.dr, cash.cr);
  const opening = d.buildOpeningCashbookRow(rows, cih);
  const all = [opening, ...rows];
  await insertRows(t, 'tblcashbook', ['trans_date', 'headcode', 'headname', 'rcash', 'rtransfer', 'pcash', 'ptransfer'], all);
  const n = await t.count('tblcashbook');
  // 1. row count and per-date totals equal the rule applied to the legacy ledger
  const legacyDates = legacy.rows(`SELECT CONVERT(varchar(10),TRANS_DATE,126) AS d,
      CONVERT(varchar(60),SUM(CASE WHEN TRANS_TYPE='CR' AND MODEOFPAY='C' THEN TRANS_AMT ELSE 0 END)) AS rcash,
      CONVERT(varchar(60),SUM(CASE WHEN TRANS_TYPE='CR' AND ISNULL(MODEOFPAY,'')<>'C' THEN TRANS_AMT ELSE 0 END)) AS rtransfer,
      CONVERT(varchar(60),SUM(CASE WHEN TRANS_TYPE='DR' AND MODEOFPAY='C' THEN TRANS_AMT ELSE 0 END)) AS pcash,
      CONVERT(varchar(60),SUM(CASE WHEN TRANS_TYPE='DR' AND ISNULL(MODEOFPAY,'')<>'C' THEN TRANS_AMT ELSE 0 END)) AS ptransfer,
      CONVERT(varchar(30),COUNT_BIG(DISTINCT CODE)) AS heads
    FROM ledger WHERE CODE<>'A1001' AND TRANS_DATE >= CONVERT(datetime,'2019-11-01',126) GROUP BY CONVERT(varchar(10),TRANS_DATE,126)`);
  const loadedByDate = new Map((await t.read(`SELECT trans_date::text AS d, sum(rcash)::text AS rcash, sum(rtransfer)::text AS rtransfer, sum(pcash)::text AS pcash, sum(ptransfer)::text AS ptransfer, count(*)::int AS heads
    FROM tblcashbook WHERE trans_date >= DATE '2019-11-01' GROUP BY 1`)).map(r => [r.d.slice(0, 10), r]));
  const badDates = [];
  for (const l of legacyDates) {
    const g = loadedByDate.get(l.d);
    if (!g || ['rcash', 'rtransfer', 'pcash', 'ptransfer'].some(k => !dec.eq(l[k], g[k]))) badDates.push(l.d);
  }
  const rowsExpected = rows.length;
  const ok1 = badDates.length === 0 && loadedByDate.size === legacyDates.length && n === rowsExpected + 1;
  ctx.report.check({ name: 'tblcashbook: totals per date equal the Cash Book rule on the legacy ledger', section: '39.7', ok: ok1, detail: `${legacyDates.length} dates, ${rowsExpected} rows + 1 opening row (dump: 23,632 rows)${badDates.length ? `; differing dates: ${badDates.slice(0, 5).join(', ')}` : ''}` });
  // 2. the three printed dates equal the printouts
  const { CASHBOOK_PROOF } = require('./spec');
  const proofBad = [];
  for (const [date, p] of Object.entries(CASHBOOK_PROOF)) {
    const g = loadedByDate.get(date);
    if (!g || ['rcash', 'rtransfer', 'pcash', 'ptransfer'].some(k => !dec.eq(p[k], g[k]))) proofBad.push(date);
  }
  const ok2 = proofBad.length === 0;
  ctx.report.check({ name: 'tblcashbook: the three printed dates equal the old Cash Book printouts', section: '39.7 (Q69)', ok: ok2, detail: ok2 ? Object.keys(CASHBOOK_PROOF).join(', ') : `differ: ${proofBad.join(', ')}` });
  // 3. the first live day opens at the ledger cash in hand (cash) and zero transfer
  const sums = (await t.read('SELECT coalesce(sum(rcash-pcash),0)::text AS cash, coalesce(sum(rtransfer-ptransfer),0)::text AS transfer FROM tblcashbook'))[0];
  const ok3 = dec.parse(sums.cash) === cih && dec.parse(sums.transfer) === 0n;
  ctx.report.check({ name: 'tblcashbook: the first live day opens at the ledger cash in hand (A1001)', section: '39.7 (Q70)', ok: ok3, detail: `cash ${sums.cash} vs A1001 ${dec.format(cih)} through ${lastDay}; transfer ${sums.transfer}` });
  if (!(ok1 && ok2 && ok3)) fail('tblcashbook: verification failed (see the check lines)');
  ctx.state.cashInHand = dec.format(cih);
  ctx.report.add({ table: 'tblcashbook', section: '39.6', code: 'cash-in-hand', title: 'the legacy ledger\'s own cash in hand (A1001) at the last loaded day', note: dec.format(cih), severity: cih < 0n ? 'WARN' : 'INFO' });
  ctx.report.add({ table: 'tblcashbook', section: '39.7 (B33)', code: 'old-dates-opening', title: 'opening and closing balances of old dates follow the new report formula and will differ from the old printouts (owner item B33)', severity: 'INFO' });
  ctx.report.step({ no: 12, title: 'tblcashbook', status: 'OK', rows: n });
  return { rows: n };
}

// ------------------------------------------------------------------ step 13: counters
async function runCounters(ctx) {
  const t = ctx.target;
  const vouchers = (await t.read("SELECT DISTINCT btrim(receipt_vchr_no) AS v FROM ledger WHERE btrim(receipt_vchr_no) ~ '^[A-Za-z]+[0-9]+$'")).map(r => r.v);
  const maxBy = d.maxVoucherByLetter(vouchers);
  const vm = (await t.read('SELECT p_vchr_no, r_vchr_no, j_vchr_no, d_vchr_no FROM voucher_master'));
  if (vm.length !== 1) fail(`voucher_master must have exactly one row, found ${vm.length}`);
  const sets = [], notes = [];
  for (const [col, letter] of [['p_vchr_no', 'P'], ['r_vchr_no', 'R'], ['j_vchr_no', 'J'], ['d_vchr_no', 'D']]) {
    const r = d.raiseVoucherCounter(vm[0][col], maxBy, letter);
    if (r.raised) { sets.push(`${col}='${r.value}'`); notes.push(`${col}: ${vm[0][col]} -> ${r.value}`); }
  }
  if (sets.length) await t.write(`UPDATE voucher_master SET ${sets.join(', ')}`);
  const seqRows = new Map((await t.read('SELECT sequence_key, last_value::text AS v FROM sequence_master')).map(r => [r.sequence_key, Number(r.v)]));
  const maxCase = Number(await t.scalar('SELECT greatest(coalesce((SELECT max(loancaseno) FROM loan_master),0), coalesce((SELECT max(loancaseno) FROM loan_pending),0))::text'));
  const maxMember = Number(await t.scalar('SELECT coalesce(max(mbno),0)::text FROM member_master'));
  const vch = (await t.read("SELECT btrim(receipt_vchr_no) AS v FROM ledger WHERE btrim(receipt_vchr_no) ~ '^VCH[0-9]+$'")).map(r => Number(r.v.slice(3)));
  const maxVch = vch.reduce((m, x) => Math.max(m, x), 0);
  const targets = { LOAN_CASE: maxCase, MEMBER_NO: maxMember, VOUCHER_NO: maxVch };
  for (const [key, need] of Object.entries(targets)) {
    if (!seqRows.has(key)) fail(`sequence_master: the template has no key ${key}`);
    const r = d.raiseSequence(seqRows.get(key), need);
    if (r.raised) { await t.write('UPDATE sequence_master SET last_value=$1, updated_at=now() WHERE sequence_key=$2', [r.value, key]); notes.push(`${key}: ${seqRows.get(key)} -> ${r.value}`); }
  }
  // check: no counter below any used number
  const after = new Map((await t.read('SELECT sequence_key, last_value::text AS v FROM sequence_master')).map(r => [r.sequence_key, Number(r.v)]));
  const vmAfter = (await t.read('SELECT p_vchr_no, r_vchr_no, j_vchr_no, d_vchr_no FROM voucher_master'))[0];
  const low = [];
  for (const [key, need] of Object.entries(targets)) if (after.get(key) < need) low.push(`${key} ${after.get(key)} < ${need}`);
  for (const [col, letter] of [['p_vchr_no', 'P'], ['r_vchr_no', 'R'], ['j_vchr_no', 'J'], ['d_vchr_no', 'D']]) { const p = d.parseVoucherNo(vmAfter[col]); if (!p || (maxBy[letter] !== undefined && p.number < maxBy[letter])) low.push(`${col} ${vmAfter[col]} < ${letter}${maxBy[letter]}`); }
  ctx.report.check({ name: 'counters: no counter below any used number', section: '44.2 step 13', ok: low.length === 0, detail: low.length ? low.join('; ') : `LOAN_CASE>=${maxCase}, MEMBER_NO>=${maxMember}, vouchers P${maxBy.P} R${maxBy.R} J${maxBy.J} D${maxBy.D}${notes.length ? '; raised: ' + notes.join(', ') : ''}` });
  if (low.length) fail('counters below used numbers: ' + low.join('; '));
  if (notes.length) ctx.report.add({ table: 'sequence_master', section: '35.4, B20', code: 'counters-raised', title: 'counters raised to the highest used number', samples: notes, severity: 'INFO' });
  ctx.report.add({ table: 'sequence_master', section: 'B20', code: 'two-numbering-schemes', title: 'the app mixes the voucher_master letters and the VOUCHER_NO "VCH" scheme (owner decision, nothing changed)', severity: 'INFO' });
  ctx.report.step({ no: 13, title: 'counters', status: 'OK', rows: 0 });
  return { rows: 0 };
}

// ------------------------------------------------------------------ dispatcher
const RUNNERS = {
  'copy': runCopyStep, 'copy+busrules': runCopyStep, 'derive-masters': runDeriveMasters, 'derive-member-balances': runMemberBalances,
  'derive-share-monthly': runShareMonthly, 'derive-cashbook': runCashbook, 'counters': runCounters,
};

async function runLoadStep(ctx, step) {
  const run = RUNNERS[step.kind];
  if (!run) fail(`no runner for step ${step.no} (${step.kind})`);
  return run(ctx, step);
}

module.exports = { runLoadStep, StepError, readSocietyValues };
