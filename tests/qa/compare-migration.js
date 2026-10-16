// Legacy MS SQL (EMP_Espat_Society_dan) vs new Postgres (EMP_Espat_Society) comparison. READ-ONLY on both databases.
// Output: docs/final-documentation/qa/Migration_Gap_Analysis.xlsx (+ tests/qa/results/migration-compare.json)
// Run: node tests/qa/compare-migration.js   (needs sqlcmd on PATH, Windows auth to .\SQLEXPRESS, backend/.env for Postgres)
require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });
const path = require('path'), fs = require('fs'), { execFileSync } = require('child_process');
const XLSX = require(path.resolve(__dirname, '../../node_modules/xlsx'));
const { Client } = require('pg');

const LEGACY_DB = process.env.LEGACY_DB || 'EMP_Espat_Society_dan';
const sql = (q) => execFileSync('sqlcmd', ['-S', '.\\SQLEXPRESS', '-E', '-d', LEGACY_DB, '-W', '-s', '|', '-h', '-1', '-Q', 'set nocount on; ' + q],
  { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, env: { ...process.env, SQLCMDUSER: '', SQLCMDPASSWORD: '' } }).replace(/\r/g, '').split('\n').filter(Boolean);

const NUM_MS = new Set(['int', 'bigint', 'smallint', 'tinyint', 'decimal', 'numeric', 'float', 'real', 'money', 'smallmoney']);
const NUM_PG = new Set(['integer', 'bigint', 'smallint', 'numeric', 'double precision', 'real', 'money']);

// Heuristic classes for legacy tables that are scratch/backup copies and are not expected in the new system.
const SCRATCH = /(^_|^tmp|^temp|_temp$|temp_|^cry|^j\d|^p\d{5}|^r\d{5}|\d{6,8}$|_\d{2}[a-z]{3}\d{4}$|^g$|^abcd$|^main$|\$|backup|^frs|^dt_|history$|delete$)/i;

(async () => {
  const pg = new Client({ host: process.env.DB_HOST, port: process.env.DB_PORT, user: process.env.DB_USERNAME, password: process.env.DB_PASSWORD, database: process.env.DB_DATABASE });
  await pg.connect();
  const ltabs = {}; sql(`select t.name, sum(p.rows) from sys.tables t join sys.partitions p on p.object_id=t.object_id and p.index_id in (0,1) group by t.name order by t.name`)
    .forEach(l => { const [n, c] = l.split('|'); ltabs[n] = +c; });
  const lcols = {}; sql(`select t.name, c.name, ty.name from sys.tables t join sys.columns c on c.object_id=t.object_id join sys.types ty on ty.user_type_id=c.user_type_id order by t.name, c.column_id`)
    .forEach(l => { const [t, c, ty] = l.split('|'); (lcols[t] = lcols[t] || []).push({ c, ty }); });
  const ptabs = {};
  for (const r of (await pg.query(`select table_name from information_schema.tables where table_schema='public' and table_type='BASE TABLE'`)).rows) {
    ptabs[r.table_name] = +(await pg.query(`select count(*)::bigint n from "${r.table_name}"`)).rows[0].n;
  }
  const pcols = {}; (await pg.query(`select table_name,column_name,data_type from information_schema.columns where table_schema='public' order by table_name, ordinal_position`))
    .rows.forEach(r => { (pcols[r.table_name] = pcols[r.table_name] || []).push({ c: r.column_name, ty: r.data_type }); });
  const pmap = {}; Object.keys(ptabs).forEach(n => { pmap[n.toLowerCase().replace(/_/g, '')] = n; });

  const tableRows = [], colRows = [], sumRows = [];
  const matchedLegacy = new Set();
  for (const [lt, lc] of Object.entries(ltabs)) {
    const key = lt.toLowerCase().replace(/_/g, '');
    const pt = ptabs[lt.toLowerCase()] !== undefined ? lt.toLowerCase() : (/[_$]$|d$/.test(lt) ? undefined : pmap[key]);
    if (pt && !(SCRATCH.test(lt) && lt.toLowerCase() !== pt)) {
      matchedLegacy.add(pt);
      const pc = ptabs[pt];
      const delta = pc - lc;
      let status = delta === 0 ? 'MIGRATED - row count equal' : (lc === 0 ? 'Empty in legacy; new has rows' : (pc === 0 ? 'NOT MIGRATED - new table is empty' : (delta > 0 ? 'DIFFERS - new has MORE rows' : 'DIFFERS - new has FEWER rows')));
      tableRows.push({ 'Legacy table': lt, 'New (Postgres) table': pt, 'Legacy rows': lc, 'New rows': pc, 'Difference (new - legacy)': delta, 'Difference %': lc ? +(100 * delta / lc).toFixed(2) : '', Status: status });
      // columns
      const nc = new Set((pcols[pt] || []).map(c => c.c.toLowerCase()));
      const lcl = lcols[lt] || [];
      const missing = lcl.filter(c => !nc.has(c.c.toLowerCase().replace(/ /g, '_')) && !nc.has(c.c.toLowerCase()));
      const extra = (pcols[pt] || []).filter(c => !lcl.some(l => l.c.toLowerCase() === c.c.toLowerCase()));
      colRows.push({ 'Legacy table': lt, 'New table': pt, 'Legacy columns': lcl.length, 'New columns': (pcols[pt] || []).length, 'Legacy columns missing in new': missing.map(m => m.c).join(', '), 'New-only columns': extra.map(m => m.c).join(', ') });
      // numeric sums on common numeric columns (cap 12 per table)
      if (lc > 0 && pc > 0) {
        const common = lcl.filter(c => NUM_MS.has(c.ty) && (pcols[pt] || []).some(p => p.c.toLowerCase() === c.c.toLowerCase() && NUM_PG.has(p.ty))).slice(0, 12);
        if (common.length) {
          try {
            const ms = sql(`select ${common.map(c => `cast(sum(cast([${c.c}] as float)) as decimal(38,4))`).join(',')} from [${lt}]`)[0].split('|');
            const pr = (await pg.query(`select ${common.map((c, i) => `sum("${(pcols[pt].find(p => p.c.toLowerCase() === c.c.toLowerCase())).c}")::numeric(38,4) as s${i}`).join(',')} from "${pt}"`)).rows[0];
            common.forEach((c, i) => {
              const a = Number(ms[i]), b = Number(pr['s' + i]);
              const same = Math.abs((a || 0) - (b || 0)) < 1;
              sumRows.push({ 'Legacy table': lt, 'New table': pt, Column: c.c, 'Legacy SUM': a, 'New SUM': b, 'Difference': +(b - a).toFixed(2), Result: same ? 'match' : (lc !== pc ? 'differs (row counts also differ)' : 'DIFFERS with equal row count') });
            });
          } catch (e) { sumRows.push({ 'Legacy table': lt, 'New table': pt, Column: '(sum failed)', Result: String(e.message).slice(0, 120) }); }
        }
      }
    } else {
      const scratch = SCRATCH.test(lt);
      tableRows.push({ 'Legacy table': lt, 'New (Postgres) table': '', 'Legacy rows': lc, 'New rows': '', 'Difference (new - legacy)': '', 'Difference %': '',
        Status: lc === 0 ? 'Legacy table is EMPTY - nothing to migrate' : (scratch ? 'NOT MIGRATED - scratch/backup/report-temp copy (migration not needed, confirm)' : 'NOT MIGRATED - no matching table in new system (review)') });
    }
  }
  const newOnly = Object.entries(ptabs).filter(([t]) => !matchedLegacy.has(t)).map(([t, c]) => ({ 'New table': t, Rows: c, Note: 'Exists only in the new system (new feature, log, 2FA, RD, notifications, etc.)' }));

  // Business-level checks
  const biz = [];
  const q1 = async (q) => (await pg.query(q)).rows[0];
  const m = (q) => sql(q)[0];
  const add = (check, legacy, news, note = '') => biz.push({ Check: check, Legacy: legacy, New: news, Difference: (isNaN(Number(legacy)) || isNaN(Number(news))) ? '' : +(Number(news) - Number(legacy)).toFixed(2), Note: note });
  const safe = async (name, f) => { try { await f(); } catch (e) { biz.push({ Check: name, Legacy: 'error', New: '', Difference: '', Note: String(e.message).slice(0, 150) }); } };
  await safe('Members', async () => add('Members (member_master rows)', m('select count(*) from member_master'), (await q1('select count(*) c from member_master')).c));
  await safe('Loans', async () => add('Loans (loan_master rows)', m('select count(*) from LOAN_MASTER'), (await q1('select count(*) c from loan_master')).c));
  await safe('Ledger rows', async () => add('Ledger rows', m('select count(*) from LEDGER'), (await q1('select count(*) c from ledger')).c));
  await safe('Ledger sums', async () => {
    const lc = (await pg.query(`select column_name from information_schema.columns where table_name='ledger'`)).rows.map(r => r.column_name);
    const amt = lc.find(c => /^(amount|amt)$/i.test(c));
    if (amt) add('Ledger SUM(amount)', m(`select cast(sum(cast([${amt}] as float)) as decimal(38,2)) from LEDGER`), (await q1(`select sum("${amt}")::numeric(38,2) s from ledger`)).s);
  });

  // ---- keyed row-level comparison of the core tables
  const keyed = [];
  const lrows = (q) => sql(q).map(l => l.split('|'));
  const prows = async (q) => (await pg.query({ text: q, rowMode: 'array' })).rows.map(r => r.map(v => v === null ? 'NULL' : String(v)));
  const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
  async function cmp(name, lq, pq, keyCols, valCols, tol = 0.005) {
    const L = new Map(), P = new Map();
    lrows(lq).forEach(r => L.set(r.slice(0, keyCols).join('~'), r.slice(keyCols)));
    (await prows(pq)).forEach(r => P.set(r.slice(0, keyCols).join('~'), r.slice(keyCols)));
    let onlyL = [], onlyP = [], diff = [], same = 0;
    for (const [k, v] of L) { const p = P.get(k); if (!p) onlyL.push(k); else { const bad = valCols.map((c, i) => Math.abs(num(v[i]) - num(p[i])) > tol ? c + ': legacy ' + v[i] + ' vs new ' + p[i] : null).filter(Boolean); if (bad.length) diff.push(k + ' -> ' + bad.join('; ')); else same++; } }
    for (const k of P.keys()) if (!L.has(k)) onlyP.push(k);
    keyed.push({ Table: name, 'Legacy keys': L.size, 'New keys': P.size, 'Identical': same, 'Only in legacy (missing in new)': onlyL.length, 'Only in new': onlyP.length, 'Same key, different values': diff.length,
      'Sample only-legacy': onlyL.slice(0, 15).join(', '), 'Sample only-new': onlyP.slice(0, 15).join(', '), 'Sample differences': diff.slice(0, 8).join(' | ') });
    return { onlyL, onlyP, diff };
  }
  const R = {};
  await safe('keyed member_master', async () => { R.mem = await cmp('member_master (by MBNO)', 'select cast(MBNO as bigint), cast(isnull(GROSS_SALARY,0) as float), cast(isnull(BASIC_PAY,0) as float) from member_master', 'select mbno::bigint, coalesce(gross_salary,0), coalesce(basic_pay,0) from member_master', 1, ['GROSS_SALARY', 'BASIC_PAY']); });
  await safe('keyed fundsmaster', async () => { R.fund = await cmp('FUNDSMASTER (by MBNO)', 'select cast(MBNO as bigint), cast(isnull(MDAMT,0) as float), cast(isnull(CDAMT,0) as float), cast(isnull(SHAREAMT,0) as float), cast(isnull(SUSPBAL,0) as float) from FUNDSMASTER', 'select mbno::bigint, coalesce(mdamt,0), coalesce(cdamt,0), coalesce(shareamt,0), coalesce(suspbal,0) from fundsmaster', 1, ['MDAMT', 'CDAMT', 'SHAREAMT', 'SUSPBAL']); });
  await safe('keyed loan_master', async () => { R.loan = await cmp('LOAN_MASTER (by MBNO+LOANCASENO)', 'select cast(MBNO as bigint), cast(LOANCASENO as bigint), cast(isnull(LOAN_AMT,0) as float), cast(isnull(BALANCE,0) as float), cast(isnull(INSTAL_AMT,0) as float), cast(isnull(RATE,0) as float), cast(isnull(NO_OF_INSTAL,0) as float) from LOAN_MASTER', 'select mbno::bigint, loancaseno::bigint, coalesce(loan_amt,0), coalesce(balance,0), coalesce(instal_amt,0), coalesce(rate,0), coalesce(no_of_instal,0) from loan_master', 2, ['LOAN_AMT', 'BALANCE', 'INSTAL_AMT', 'RATE', 'NO_OF_INSTAL']); });
  await safe('keyed ledger', async () => { R.led = await cmp('LEDGER (by LedgerId)', 'select LedgerId, cast(isnull(TRANS_AMT,0) as float), cast(MBNO as bigint) from LEDGER', 'select ledgerid, coalesce(trans_amt,0), mbno::bigint from ledger', 1, ['TRANS_AMT', 'MBNO']); });
  await pg.end();

  const out = path.resolve(__dirname, '../../../docs/final-documentation/qa');
  fs.mkdirSync(out, { recursive: true });
  const cls = (s) => s.startsWith('MIGRATED') ? 'Migrated, equal' : s.startsWith('DIFFERS') ? 'Migrated, differs' : s.startsWith('Empty') ? 'Empty in legacy' : s.includes('EMPTY') ? 'Nothing to migrate' : s.includes('scratch') ? 'Not migrated (scratch/backup)' : 'Not migrated (review)';
  const summary = {}; tableRows.forEach(r => { const k = cls(r.Status); summary[k] = (summary[k] || 0) + 1; });
  const sheetSummary = [['Migration gap analysis', 'Legacy ' + LEGACY_DB + ' (MS SQL) vs new Postgres ' + process.env.DB_DATABASE], ['Generated', new Date().toISOString()], ['Legacy tables', Object.keys(ltabs).length], ['New tables', Object.keys(ptabs).length], [''], ['Classification', 'Tables'], ...Object.entries(summary), ['New-only tables', newOnly.length], [''],
    ['How to read', 'Row-count status is per table. "Migrated, differs" needs a look: new has fewer rows = rows lost or intentionally skipped; more rows = new-system activity or extra imports (test data). Column sums compare numeric totals for tables with the same column names.']];
  const wb = XLSX.utils.book_new();
  const A = (n, d, w, aoa) => { const ws = aoa ? XLSX.utils.aoa_to_sheet(d) : XLSX.utils.json_to_sheet(d); ws['!cols'] = w.map(x => ({ wch: x })); XLSX.utils.book_append_sheet(wb, ws, n); };
  A('Summary', sheetSummary, [36, 90], true);
  A('Tables', tableRows, [34, 30, 14, 14, 16, 12, 70]);
  A('Columns', colRows, [34, 30, 12, 12, 60, 60]);
  A('Numeric Totals', sumRows, [34, 30, 24, 22, 22, 16, 34]);
  A('Business Checks', biz, [40, 22, 22, 16, 60]);
  A('Keyed Row Comparison', keyed, [34, 12, 12, 12, 16, 12, 16, 60, 60, 100]);
  A('New-only Tables', newOnly, [34, 12, 80]);
  XLSX.writeFile(wb, path.join(out, 'Migration_Gap_Analysis.xlsx'));
  fs.mkdirSync(path.join(__dirname, 'results'), { recursive: true });
  fs.writeFileSync(path.join(__dirname, 'results', 'migration-compare.json'), JSON.stringify({ summary, tableRows, sumRows, biz, keyed }, null, 1));
  console.log(summary); console.log('sum mismatches:', sumRows.filter(r => /DIFFERS with equal/.test(r.Result)).length, 'of', sumRows.length);
})().catch(e => { console.error(e); process.exit(1); });
