/*
 * Demand Master end-to-end test agent.
 *
 * This intentionally does NOT clean up data. The configured test database is
 * the evidence: every generated/imported demand, ledger voucher, and recovery
 * adjustment remains available for inspection after the run.
 *
 * Usage:
 *   npm run test:demand-master
 *
 * Use DEMAND_TEST_YEAR / DEMAND_TEST_GENERATE_MONTH /
 * DEMAND_TEST_IMPORT_MONTH to select a new empty period for each run.
 */
require('dotenv').config();

const assert = require('node:assert/strict');
const XLSX = require('xlsx');
const { Client } = require('pg');

const baseUrl = (process.env.DEMAND_TEST_BASE_URL || 'http://localhost:3010/api/v1').replace(/\/$/, '');
const year = Number(process.env.DEMAND_TEST_YEAR || 2099);
const generateMonth = String(process.env.DEMAND_TEST_GENERATE_MONTH || 'NOV').toUpperCase();
const importMonth = String(process.env.DEMAND_TEST_IMPORT_MONTH || 'DEC').toUpperCase();
const password = process.env.DEMAND_TEST_PASSWORD || process.env.SUPER_ADMIN_PASSWORD;
const username = process.env.DEMAND_TEST_USERNAME || 'admin';

const dbConfig = {
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  user: process.env.DB_USERNAME,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_DATABASE,
};

const results = [];
let token;

function pass(name, detail) {
  results.push({ name, status: 'PASS', detail });
  console.log(`PASS  ${name}${detail ? ` — ${detail}` : ''}`);
}

function fail(name, error) {
  results.push({ name, status: 'FAIL', detail: error.message });
  console.error(`FAIL  ${name} — ${error.message}`);
}

function unwrap(body) {
  return body && Object.prototype.hasOwnProperty.call(body, 'data') ? body.data : body;
}

async function api(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(`${baseUrl}${path}`, { ...options, headers });
  const text = await response.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  return { response, body, data: unwrap(body) };
}

function assertStatus(result, expected, label) {
  assert.equal(result.response.status, expected, `${label}: expected HTTP ${expected}, got ${result.response.status}: ${JSON.stringify(result.body)}`);
}

async function query(client, sql, params = []) {
  return (await client.query(sql, params)).rows;
}

async function main() {
  assert(Number.isInteger(year) && year >= 2000, 'DEMAND_TEST_YEAR must be a valid integer year');

  const db = new Client(dbConfig);
  await db.connect();
  try {
    console.log(`Demand Master test agent: ${baseUrl}`);
    console.log(`Database: ${dbConfig.database} | retained test periods: ${generateMonth}/${year}, ${importMonth}/${year}`);

    // Prove the test run is scoped to a few real members with active loans.
    const candidates = await query(db, `
      SELECT mm.mbno::text AS "memberNo", mm.officeno::text AS "officeNo"
      FROM member_master mm
      JOIN loan_master lm ON lm.mbno = mm.mbno
      WHERE COALESCE(mm.isactive, 'Y') <> 'N'
        AND COALESCE(lm.balance, 0) > 0
      GROUP BY mm.mbno, mm.officeno
      ORDER BY mm.mbno
      LIMIT 3`);
    assert(candidates.length >= 1, 'No active member with an outstanding loan is available for the test');
    const primary = candidates[0];
    const selected = candidates.map((m) => m.memberNo);
    const otherBranch = (await query(db, `
      SELECT mbno::text AS "memberNo", officeno::text AS "officeNo"
      FROM member_master
      WHERE COALESCE(isactive, 'Y') <> 'N' AND officeno::text <> $1
      ORDER BY mbno LIMIT 1`, [primary.officeNo]))[0];
    assert(otherBranch, 'No member from another branch is available for branch validation');
    pass('select controlled members', `${selected.join(', ')} in branch ${primary.officeNo}; wrong-branch member ${otherBranch.memberNo}`);

    // Never overwrite an existing test run. The retained rows are the audit
    // trail and the operator can choose another period through environment vars.
    for (const month of [generateMonth, importMonth]) {
      const existing = await query(db, `
        SELECT COUNT(*)::int AS count FROM demand_master
        WHERE demand_for_year = $1 AND demand_for_month = EXTRACT(MONTH FROM TO_DATE($2, 'MON'))`, [year, month]);
      assert.equal(existing[0].count, 0, `Period ${month}/${year} already contains ${existing[0].count} demand rows; choose a new DEMAND_TEST_YEAR or month`);
    }
    pass('period isolation preflight', 'both retained test periods are empty');

    // Authentication and guard behavior.
    const unauthenticated = await api(`/transactions/ledger-posting/summary?month=${generateMonth}&year=${year}&branch=${primary.officeNo}`);
    assertStatus(unauthenticated, 401, 'unauthenticated ledger route');
    pass('JWT route protection');

    assert(password, 'Set DEMAND_TEST_PASSWORD or SUPER_ADMIN_PASSWORD before running the harness');
    const login = await api('/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    assertStatus(login, 200, 'login');
    token = login.data.accessToken;
    assert(token, 'Login response did not contain accessToken');
    pass('authenticate test operator');

    // Generation is constrained to the selected members, not the whole branch.
    const generated = await api('/transactions/demand-generation/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ month: generateMonth, year: String(year), divisionRO: primary.officeNo, memberNos: selected }),
    });
    assertStatus(generated, 201, 'demand generation');
    assert.equal(generated.data.success, true, 'demand generation did not return success');
    const generatedRows = await query(db, `
      SELECT mbno::text AS "memberNo", officeno::text AS "officeNo", totaldemand, demand_posted
      FROM demand_master
      WHERE demand_for_year = $1 AND demand_for_month = EXTRACT(MONTH FROM TO_DATE($2, 'MON'))
      ORDER BY mbno`, [year, generateMonth]);
    assert(generatedRows.length >= 1 && generatedRows.length <= selected.length, 'generation escaped the selected member scope');
    assert(generatedRows.every((r) => selected.includes(r.memberNo)), 'generation inserted an unselected member');
    pass('generate demand for selected members', `${generatedRows.length} rows retained in demand_master`);

    // Report, ledger summary, and short recovery must all see the generated rows.
    const report = await api('/transactions/reports/demand-list/generate', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ month: generateMonth, year, branch: primary.officeNo, sortBy: 'Name' }),
    });
    assertStatus(report, 201, 'demand report');
    assert(report.data.some((r) => selected.includes(String(r.memberNo))), 'report did not return generated demand');
    pass('demand report');

    const summary = await api(`/transactions/ledger-posting/summary?month=${generateMonth}&year=${year}&branch=${primary.officeNo}`);
    assertStatus(summary, 200, 'ledger summary');
    const totalSend = summary.data.reduce((sum, row) => sum + Number(row.totalSend || 0), 0);
    assert(totalSend > 0, 'ledger summary total is zero');
    pass('ledger summary', `${summary.data.length} member groups, total ₹${totalSend.toFixed(2)}`);

    const recovery = await api(`/transactions/short-recovery?month=${generateMonth}&year=${year}`);
    assertStatus(recovery, 200, 'short recovery');
    assert(recovery.data.some((r) => selected.includes(String(r.memberNo))), 'short recovery did not return generated demand');
    pass('short recovery listing');

    // Post the generated period and verify both the GL rows and demand flags.
    const posted = await api('/transactions/ledger-posting/post', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ month: generateMonth, year, branch: primary.officeNo, modeOfReceipt: 'CASH', totalOfficeAmount: totalSend }),
    });
    assertStatus(posted, 201, 'ledger posting');
    const voucher = posted.data.voucherNo;
    assert(voucher, 'ledger posting did not return voucher number');
    const ledgerRows = await query(db, 'SELECT trans_type, trans_amt FROM ledger WHERE receipt_vchr_no = $1 ORDER BY trans_type', [voucher]);
    assert.equal(ledgerRows.length, 2, 'ledger posting did not create exactly one DR and one CR row');
    assert.equal(ledgerRows[0].trans_amt, ledgerRows[1].trans_amt, 'DR/CR ledger amounts do not balance');
    const postedDemand = await query(db, `
      SELECT COUNT(*)::int AS count FROM demand_master
      WHERE demand_for_year = $1 AND demand_for_month = EXTRACT(MONTH FROM TO_DATE($2, 'MON')) AND demand_posted = 'Y'`, [year, generateMonth]);
    assert(postedDemand[0].count >= 1, 'demand rows were not marked posted');
    pass('post ledger and mark demand', `${voucher}; DR/CR balanced; ${postedDemand[0].count} demand rows marked Y`);

    // Build a real uploaded workbook with a valid row and a wrong-branch row.
    const workbook = XLSX.utils.book_new();
    const sheetRows = [
      ['S.NO.', 'YYMM', 'CODE', 'MS.NO.', 'PS.NO.', 'NAME', 'TOTAL', 'R/D', 'R/LOAN', 'E/LOAN', 'INTT'],
      [1, `${String(year).slice(-2)}12`, 'TEST', primary.memberNo, 'P', '', 110, 10, 100, 0, 0],
      [2, `${String(year).slice(-2)}12`, 'TEST', otherBranch.memberNo, 'P', '', 100, 0, 100, 0, 0],
    ];
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(sheetRows), `Branch ${primary.officeNo}`);
    const file = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
    const form = new FormData();
    form.append('file', new Blob([file]), 'demand-master-agent.xlsx');
    form.append('branch', primary.officeNo);
    const preview = await api('/transactions/demand-generation/import-preview', { method: 'POST', body: form });
    assertStatus(preview, 201, 'import preview');
    assert.equal(preview.data.summary.total, 2);
    assert.equal(preview.data.summary.valid, 1);
    assert.equal(preview.data.summary.errors, 1);
    assert(preview.data.rows.some((r) => r.remarks.includes('not ' + primary.officeNo)), 'wrong-branch row was not rejected');
    pass('import preview validation', 'valid member accepted; wrong branch rejected');

    const validRow = preview.data.rows.find((r) => r.status === 'Valid');
    const imported = await api('/transactions/demand-generation/import-process', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ month: importMonth, year: String(year), branch: primary.officeNo, data: [validRow] }),
    });
    assertStatus(imported, 201, 'import save');
    assert.equal(imported.data.recordCount, 1);
    const importedRows = await query(db, `
      SELECT mbno::text AS "memberNo", officeno::text AS "officeNo", totaldemand, rd_amount, demand_posted
      FROM demand_master
      WHERE demand_for_year = $1 AND demand_for_month = EXTRACT(MONTH FROM TO_DATE($2, 'MON')) AND mbno = $3`, [year, importMonth, primary.memberNo]);
    assert.equal(importedRows.length, 1);
    assert.equal(importedRows[0].officeNo, primary.officeNo);
    assert.equal(Number(importedRows[0].totaldemand), 110);
    assert.equal(Number(importedRows[0].rd_amount), 10);
    pass('persist imported demand and RD amount', 'row retained in demand_master for inspection');

    const importedSummary = await api(`/transactions/ledger-posting/summary?month=${importMonth}&year=${year}&branch=${primary.officeNo}`);
    assertStatus(importedSummary, 200, 'imported ledger summary');
    assert(importedSummary.data.some((r) => String(r.memberNo) === primary.memberNo), 'imported demand missing from ledger summary');
    const importedRecovery = await api(`/transactions/short-recovery?month=${importMonth}&year=${year}`);
    assertStatus(importedRecovery, 200, 'imported short recovery');
    const shortfall = importedRecovery.data.find((r) => String(r.memberNo) === primary.memberNo);
    assert(shortfall && Number(shortfall.shortfallAmount) > 0, 'imported short recovery missing');
    pass('import flows into summary and short recovery', `shortfall ₹${shortfall.shortfallAmount}`);

    console.log('\nRetained test artifacts:');
    console.log(JSON.stringify({ year, generateMonth, importMonth, selectedMembers: selected, branch: primary.officeNo, postedVoucher: voucher }, null, 2));
  } finally {
    await db.end();
  }
}

main()
  .then(() => {
    const failed = results.filter((r) => r.status === 'FAIL');
    console.log(`\nDemand Master result: ${results.length - failed.length}/${results.length} checks passed.`);
    process.exitCode = failed.length ? 1 : 0;
  })
  .catch((error) => {
    fail('harness', error);
    console.error(error.stack || error);
    process.exitCode = 1;
  });
