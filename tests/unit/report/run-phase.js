/*
 * Runs one phase of the backend unit tests and updates the single Excel report.
 *   node tests/unit/report/run-phase.js <phaseNo>     run that phase, store results, rebuild the Excel
 *   node tests/unit/report/run-phase.js --rebuild     rebuild the Excel from stored results only
 * Phases are defined in phases.json (folders under tests/unit). Jira links live in jira-map.json:
 *   [{ "match": "<text contained in the full test name>", "key": "ES-123", "note": "..." }]
 * Output: tests/unit/report/Backend_Unit_Test_Report.xlsx  (+ results.json, the stored data)
 */
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const XLSX = require('xlsx');

const HERE = __dirname;
const BACKEND = path.resolve(HERE, '..', '..', '..');
const phases = JSON.parse(fs.readFileSync(path.join(HERE, 'phases.json'), 'utf8'));
const resultsFile = path.join(HERE, 'results.json');
const jiraFile = path.join(HERE, 'jira-map.json');
const stored = fs.existsSync(resultsFile) ? JSON.parse(fs.readFileSync(resultsFile, 'utf8')) : { phases: {} };
const jiraMap = fs.existsSync(jiraFile) ? JSON.parse(fs.readFileSync(jiraFile, 'utf8')) : [];

function runPhase(no) {
  const ph = phases.find((p) => p.no === no);
  if (!ph) throw new Error(`No phase ${no}`);
  const out = path.join(HERE, `.phase-${no}.json`);
  const args = ['--unhandled-rejections=warn', 'node_modules/jest/bin/jest.js', '--config', 'tests/jest.json', '--runInBand', '--forceExit', '--json', `--outputFile=tests/unit/report/.phase-${no}.json`, '--silent', ...ph.folders.map((f) => `tests/unit/${f}`)];
  cp.spawnSync('node', args, { cwd: BACKEND, shell: true, stdio: 'inherit' });
  const j = JSON.parse(fs.readFileSync(out, 'utf8'));
  fs.unlinkSync(out);
  const rows = [];
  for (const suite of j.testResults) {
    const file = path.relative(path.join(BACKEND, 'tests', 'unit'), suite.name).split(path.sep).join('/');
    if (suite.assertionResults.length === 0 && suite.status === 'failed') {
      rows.push({ file, module: file.split('/')[0], suite: '(suite did not run)', test: file, status: 'failed', error: (suite.message || '').replace(/\u001b\[[0-9;]*m/g, '').slice(0, 600) });
    }
    for (const a of suite.assertionResults) {
      rows.push({
        file, module: file.split('/')[0], suite: a.ancestorTitles.join(' > '), test: a.title,
        status: a.status === 'passed' ? 'passed' : a.status === 'failed' ? 'failed' : 'skipped',
        error: (a.failureMessages || []).join('\n').replace(/\u001b\[[0-9;]*m/g, '').split('\n').filter((l) => !/^\s+at /.test(l)).join('\n').slice(0, 600),
      });
    }
  }
  stored.phases[no] = { name: ph.name, ranAt: new Date().toISOString(), rows };
  fs.writeFileSync(resultsFile, JSON.stringify(stored, null, 1));
}

function jiraFor(r) {
  const full = `${r.suite} ${r.test}`;
  const hits = jiraMap.filter((m) => full.includes(m.match));
  return hits;
}

function build() {
  const all = [];
  const summary = [['Phase', 'Name', 'Scope (folders)', 'Run?', 'Total', 'Passed', 'Failed', 'Skipped', 'Pass %', 'Last run']];
  for (const ph of phases) {
    const s = stored.phases[ph.no];
    if (!s) { summary.push([ph.no, ph.name, ph.folders.join(', '), 'not yet', '', '', '', '', '', '']); continue; }
    const p = s.rows.filter((r) => r.status === 'passed').length;
    const f = s.rows.filter((r) => r.status === 'failed').length;
    const k = s.rows.filter((r) => r.status === 'skipped').length;
    summary.push([ph.no, ph.name, ph.folders.join(', '), 'yes', s.rows.length, p, f, k, s.rows.length ? Math.round((p / s.rows.length) * 1000) / 10 : 0, s.ranAt]);
    s.rows.forEach((r, i) => all.push({ ...r, phase: ph.no, id: `P${ph.no}-${String(i + 1).padStart(4, '0')}` }));
  }
  const ran = all.length;
  const tp = all.filter((r) => r.status === 'passed').length;
  const tf = all.filter((r) => r.status === 'failed').length;
  summary.push([]);
  summary.push(['', 'TOTAL (phases run so far)', '', '', ran, tp, tf, all.filter((r) => r.status === 'skipped').length, ran ? Math.round((tp / ran) * 1000) / 10 : 0, '']);

  const results = [['Test ID', 'Phase', 'Module', 'File', 'Suite', 'Test', 'Result', 'Jira', 'Error (first lines)']];
  const fails = [['Test ID', 'Phase', 'Module', 'Test', 'Jira', 'Jira action', 'Note', 'Error']];
  for (const r of all) {
    const hits = jiraFor(r);
    const keys = [...new Set(hits.map((h) => h.key))].join(', ');
    results.push([r.id, r.phase, r.module, r.file, r.suite, r.test, r.status.toUpperCase(), keys, r.error]);
    if (r.status === 'failed') {
      fails.push([r.id, r.phase, r.module, `${r.suite} > ${r.test}`, keys || '(not filed yet)', hits[0]?.action || '', hits[0]?.note || '', r.error]);
    }
  }
  const wb = XLSX.utils.book_new();
  const add = (name, rows, widths) => {
    const ws = XLSX.utils.aoa_to_sheet(rows);
    ws['!cols'] = widths.map((w) => ({ wch: w }));
    ws['!autofilter'] = { ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: Math.max(rows.length - 1, 0), c: widths.length - 1 } }) };
    XLSX.utils.book_append_sheet(wb, ws, name);
  };
  add('Summary', summary, [7, 38, 60, 9, 8, 8, 8, 9, 8, 26]);
  add('Results', results, [11, 7, 16, 40, 44, 70, 9, 14, 80]);
  add('Failures', fails, [11, 7, 16, 90, 18, 14, 50, 80]);
  const jr = [['Jira key', 'Action', 'Match text', 'Note']].concat(jiraMap.map((m) => [m.key, m.action || '', m.match, m.note || '']));
  add('Jira links', jr, [12, 16, 70, 80]);
  const fixFile = path.join(HERE, 'fixes.json');
  if (fs.existsSync(fixFile)) {
    const fx = JSON.parse(fs.readFileSync(fixFile, 'utf8'));
    add('Fixed', [['Jira key', 'Fixed on', 'Files changed', 'What changed', 'Tests', 'Retest result']].concat(fx.map((f) => [f.key, f.fixedOn, f.files, f.change, f.tests, f.result])), [10, 12, 40, 80, 70, 60]);
  }
  XLSX.writeFile(wb, path.join(HERE, 'Backend_Unit_Test_Report.xlsx'));
  return { summary, ran, tp, tf };
}

const arg = process.argv[2];
if (arg && arg !== '--rebuild') runPhase(Number(arg));
const r = build();
console.log(`\nReport rebuilt. Phases run so far: ${r.ran} tests, ${r.tp} passed, ${r.tf} failed.`);
