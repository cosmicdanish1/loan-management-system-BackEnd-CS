'use strict';
// Pre-flight of section 44.1: every check here only READS. Blockers are explicit failures, never worked around:
// duplicate member numbers, the society's busrules values (and go-live date), a template that is not empty.
const fs = require('node:fs');
const path = require('node:path');
const d = require('./derive');
const spec = require('./spec');
const { mapColumns } = require('./colmap');

const C = (name, section, ok, detail, { blocking = true, wouldRun = false } = {}) => ({ name, section, ok, detail, blocking, wouldRun });

/** Describe the checks a dry run WOULD make (no database is touched). */
function plannedChecks(opts) {
  return [
    ['legacy', '44.1(3)', 'dump date = max(ledger.trans_date), reported'],
    ['legacy', '44.1(1)', 'no other session connected to the legacy database (freeze)'],
    ['legacy', '44.1(3)', 'no duplicate member numbers in legacy member_master  [BLOCKER while any remains: 990042294, 990042301, 990042302 on the Nov dump]'],
    ['legacy', '44.1(3)', 'every ledger.code exists in headmaster'],
    ['legacy', '32.4', 'blank PFLAG: A-heads are set to A (Q57); blank on credit-normal heads (L, I, R) is left; blank on an E-head blocks (undecided)'],
    ['legacy', '35.4', 'voucher counters at or above the highest ledger number per letter (raised in step 13 if not)'],
    ['legacy', '44.1(2)', 'all 34 copy tables exist and their row counts are read (compared with the baseline and with the dump reference)'],
    ['input', '42.2 (Q75)', `society values for the 11 new busrules columns: ${opts.societyValuesFile || '(no --society-values file given)'}  [BLOCKER until complete]`],
    ['input', '42.2', `go-live date for the busrules row: ${opts.goLiveDate || '(no --go-live-date given)'}  [BLOCKER until given]`],
    ['target', '44.1(4)', 'target database is the one named by --target-db and --confirm-target'],
    ['target', '44.1(4)', 'EMPTY-TARGET GUARD: every data table has zero rows (headmaster may hold only I1013, I1014); any table outside the configuration group with rows refuses the run'],
    ['target', '44.1(3)', 'schema drift: every legacy column of every table in scope exists in the template'],
    ['target', '44.1(4)', 'configuration rows of group 4 (43.2) are present; sequence_master has LOAN_CASE, MEMBER_NO, VOUCHER_NO'],
    ['target', '44.1(4)', 'the migrations list equals the migration files shipped in src/migrations'],
    ['target', '11.4', 'trigger trg_member_master_sync_retirement exists on member_master (kept on)'],
    ['target', '42.2', 'busrules in the template has the 11 new columns'],
    ['target', '44.1(5)', 'pg_dump of the template is taken before any write (or --backup-file points to one)'],
  ];
}

// ------------------------------------------------------------------ legacy side
function legacyPreflight(ctx) {
  const L = ctx.legacy, out = [];
  const dumpDate = L.scalar('SELECT CONVERT(varchar(10),MAX(TRANS_DATE),126) AS d FROM ledger');
  ctx.state.dumpDate = dumpDate;
  out.push(C('dump date (max ledger.trans_date)', '44.1(3)', !ctx.opts.expectDumpDate || ctx.opts.expectDumpDate === dumpDate, `${dumpDate}${ctx.opts.expectDumpDate ? `, expected ${ctx.opts.expectDumpDate}` : ''}`, { blocking: !!ctx.opts.expectDumpDate }));

  let sessions = null;
  try { sessions = Number(L.scalar('SELECT COUNT(*) AS n FROM sys.dm_exec_sessions WHERE database_id=DB_ID() AND session_id<>@@SPID AND is_user_process=1')); } catch (e) { sessions = null; }
  out.push(C('no other session on the legacy database (freeze)', '44.1(1)', sessions === 0, sessions === null ? 'could not read sessions (no permission)' : `${sessions} other session(s) connected`, { blocking: !!ctx.execute }));

  const dups = L.rows('SELECT CONVERT(varchar(30),MBNO) AS mbno, COUNT_BIG(*) AS n FROM member_master GROUP BY MBNO HAVING COUNT_BIG(*) > 1');
  out.push(C('no duplicate member numbers in legacy member_master', '44.1(3), Q21', dups.length === 0, dups.length ? `BLOCKER: ${dups.map(x => x.mbno + ' x' + x.n).join(', ')} (the society renumbers in legacy first)` : 'none'));

  const noHead = Number(L.scalar('SELECT CONVERT(varchar(30),COUNT_BIG(DISTINCT l.CODE)) AS n FROM ledger l WHERE NOT EXISTS (SELECT 1 FROM headmaster h WHERE h.CODE=l.CODE)'));
  out.push(C('every ledger.code exists in headmaster', '44.1(3)', noHead === 0, `${noHead} missing`));

  const blank = L.rows("SELECT CODE AS code FROM headmaster WHERE PFLAG IS NULL OR LTRIM(RTRIM(PFLAG))=''").map(x => x.code);
  const undecided = blank.filter(c => String(c).trim().toUpperCase().startsWith('E'));
  out.push(C('blank PFLAG: A-heads are set to A, credit-normal heads stay blank, E-heads are undecided', '32.4 (Q57)', undecided.length === 0, undecided.length ? `BLOCKER, undecided E-heads: ${undecided.join(', ')}` : `${blank.filter(c => /^A/i.test(c)).length} A-heads to fix, ${blank.filter(c => !/^[AE]/i.test(c)).length} credit-normal heads left blank (${blank.filter(c => !/^[AE]/i.test(c)).join(', ') || 'none'})`));

  const vm = L.rows('SELECT P_VCHR_NO AS p, R_VCHR_NO AS r, J_VCHR_NO AS j, D_VCHR_NO AS d FROM voucher_master')[0];
  const vouchers = L.rows("SELECT DISTINCT LTRIM(RTRIM(RECEIPT_VCHR_NO)) AS v FROM ledger WHERE RECEIPT_VCHR_NO LIKE '[A-Za-z]%[0-9]'").map(r => r.v);
  const maxBy = d.maxVoucherByLetter(vouchers);
  const low = [];
  for (const [col, letter] of [['p', 'P'], ['r', 'R'], ['j', 'J'], ['d', 'D']]) { const r = d.raiseVoucherCounter(vm[col], maxBy, letter); if (r.raised) low.push(`${letter}: counter ${vm[col]} below ledger ${letter}${maxBy[letter]}`); }
  out.push(C('voucher counters at or above the ledger', '35.4 (Q63)', low.length === 0, low.length ? `${low.join('; ')} (step 13 raises them, never lowers)` : `P${maxBy.P} R${maxBy.R} J${maxBy.J} D${maxBy.D} within the counters`, { blocking: false }));

  const missing = [];
  for (const t of spec.COPY_TABLES) {
    const cols = L.columns(t.legacy);
    if (!cols.length) { missing.push(t.legacy); continue; }
  }
  out.push(C('all copy tables exist in the legacy database', '44.1(2)', missing.length === 0, missing.length ? `missing: ${missing.join(', ')}` : `${spec.COPY_TABLES.length} tables`));
  out.push(...inputChecks(ctx));
  return out;
}

function inputChecks(ctx) {
  const out = [];
  const o = ctx.opts;
  let problems;
  if (!o.societyValuesFile) problems = ['no --society-values file given'];
  else if (!fs.existsSync(o.societyValuesFile)) problems = [`file not found: ${o.societyValuesFile}`];
  else { try { problems = d.validateSocietyBusrules(JSON.parse(fs.readFileSync(o.societyValuesFile, 'utf8').replace(/^﻿/, ''))); } catch (e) { problems = ['file is not valid JSON']; } }
  out.push(C("society's values for the 11 new busrules columns", '42.2 (Q75)', problems.length === 0, problems.length ? `BLOCKER: ${problems.join('; ')}` : 'complete'));
  const okDate = /^\d{4}-\d{2}-\d{2}$/.test(o.goLiveDate || '');
  out.push(C('go-live date for the busrules row', '42.2', okDate, okDate ? o.goLiveDate : 'BLOCKER: --go-live-date YYYY-MM-DD is required'));
  return out;
}

// ------------------------------------------------------------------ target side
async function migrationFilesCheck(ctx) {
  const dir = ctx.opts.migrationsDir || path.resolve(__dirname, '../../../../src/migrations');
  if (!fs.existsSync(dir)) return C('migrations list equals the shipped code', '44.1(4)', false, `migrations directory not found: ${dir} (use --migrations-dir)`);
  const shipped = new Set(fs.readdirSync(dir).filter(f => /^\d+-.+\.(ts|js)$/.test(f) && !f.endsWith('.d.ts')).map(f => f.split('-')[0]));
  const rows = await ctx.target.read('SELECT "timestamp"::text AS t FROM migrations');
  const applied = new Set(rows.map(r => String(r.t)));
  const notApplied = [...shipped].filter(x => !applied.has(x)), unknown = [...applied].filter(x => !shipped.has(x));
  return C('migrations list equals the shipped code', '44.1(4)', !notApplied.length && !unknown.length, notApplied.length || unknown.length ? `${notApplied.length} shipped but not applied, ${unknown.length} applied but not shipped (e.g. ${[...notApplied, ...unknown].slice(0, 4).join(', ')})` : `${shipped.size} migrations`);
}

async function targetPreflight(ctx) {
  const t = ctx.target, out = [];
  const db = await t.scalar('SELECT current_database()');
  out.push(C('target database is the one named on the command line', '44.1(4)', db === ctx.opts.targetDb, `connected to ${db}`));

  // ---- the empty-target guard
  const tables = (await t.read("SELECT table_name AS n FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE' ORDER BY 1")).map(r => r.n);
  const nonEmpty = [];
  for (const n of tables) {
    if (spec.CONFIG_TABLES.includes(n)) continue;
    if (!(await t.hasRows(n))) continue;
    const allowed = spec.SEEDED_ALLOWED[n];
    if (allowed) {
      const others = await t.read(`SELECT count(*)::int AS c FROM "${n}" WHERE NOT (btrim(${allowed.column}) = ANY($1::text[]))`, [allowed.values]);
      if (others[0].c === 0) continue;
    }
    nonEmpty.push(n);
  }
  out.push(C('EMPTY-TARGET GUARD: no data table has rows', '44.1(4)', nonEmpty.length === 0, nonEmpty.length ? `REFUSING: ${nonEmpty.length} table(s) with rows: ${nonEmpty.slice(0, 12).join(', ')}${nonEmpty.length > 12 ? ', ...' : ''}. No delete step exists: restore the template.` : `${tables.length} tables scanned, all data tables empty`));
  ctx.state.nonEmptyTables = nonEmpty;

  const missingScope = [...spec.COPY_TABLES.map(x => x.id), ...spec.GROUP_DERIVED].filter(n => !tables.includes(n));
  out.push(C('every table the load fills exists in the template', '43.2', missingScope.length === 0, missingScope.length ? `missing: ${missingScope.join(', ')}` : 'all present'));

  // ---- schema drift: every legacy column of every table in scope exists in the template
  const drift = [];
  for (const s of spec.COPY_TABLES) {
    if (!tables.includes(s.id)) continue;
    const m = mapColumns(ctx.legacy.columns(s.legacy), await t.columns(s.id));
    if (m.missingInTarget.length) drift.push(`${s.id}: ${m.missingInTarget.join(', ')}`);
  }
  out.push(C('no schema drift (every legacy column exists in the template)', '44.1(3)', drift.length === 0, drift.length ? drift.join(' | ') : 'none'));

  // ---- configuration rows of group 4
  const emptyConfig = [];
  for (const n of spec.CONFIG_TABLES) if (tables.includes(n) && !(await t.hasRows(n))) emptyConfig.push(n);
  const absentConfig = spec.CONFIG_TABLES.filter(n => !tables.includes(n));
  out.push(C('configuration rows of group 4 are present', '43.2', emptyConfig.length === 0, emptyConfig.length ? `empty: ${emptyConfig.join(', ')}` : `${spec.CONFIG_TABLES.length - absentConfig.length} configuration tables filled${absentConfig.length ? `; not in this template: ${absentConfig.join(', ')}` : ''}`, { blocking: emptyConfig.length > 0 }));
  if (tables.includes('sequence_master')) {
    const keys = (await t.read('SELECT sequence_key AS k FROM sequence_master')).map(r => r.k);
    const need = ['LOAN_CASE', 'MEMBER_NO', 'VOUCHER_NO'].filter(k => !keys.includes(k));
    out.push(C('sequence_master has the counter keys the load raises', '44.2 step 13', need.length === 0, need.length ? `missing: ${need.join(', ')}` : keys.join(', ')));
  }
  out.push(await migrationFilesCheck(ctx));
  const trg = await t.read("SELECT 1 FROM pg_trigger tg JOIN pg_class c ON c.oid=tg.tgrelid WHERE c.relname='member_master' AND tg.tgname='trg_member_master_sync_retirement' AND NOT tg.tgisinternal AND tg.tgenabled <> 'D'");
  out.push(C('retirement trigger on member_master is present and enabled', '11.4', trg.length > 0, trg.length ? 'present' : 'missing: dor would not follow date_of_retirement'));
  if (tables.includes('busrules')) {
    const cols = (await t.columns('busrules')).map(c => c.name);
    const lack = d.SOCIETY_BUSRULES_COLUMNS.filter(c => !cols.includes(c));
    out.push(C('busrules has the 11 new columns', '42.2', lack.length === 0, lack.length ? `missing: ${lack.join(', ')}` : 'all 11'));
  }
  return out;
}

module.exports = { plannedChecks, legacyPreflight, inputChecks, targetPreflight, migrationFilesCheck };
