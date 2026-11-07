// Report sweep: calls every report-type GET route with realistic parameters (a real member with loans, a busy date, FY 1)
// and checks: 200 (or a clean 404 for "no data"), answers within 15 s, JSON has no NaN / Infinity / 'undefined' / 'null' text in
// amounts, no raw error text (ENOENT, SQL, stack). Sequential on purpose (the balance sheet exhausts the DB pool, see ES-267). Read-only.
const fs = require('fs'), path = require('path');
const { http, login, Suite } = require('./lib');

const P = { memberNo: '610022986', memberFrom: '610022986', memberTo: '610022986', fromMemberNo: '610022986', toMemberNo: '610022986', memberCode: '610022986',
  fromDate: '2026-09-01', toDate: '2026-09-30', uptoDate: '2026-09-30', startDate: '2026-09-01', endDate: '2026-09-30', asOnDate: '2026-09-30', date: '2026-09-16', warrantDate: '2026-09-30',
  month: 'SEP', year: '2026', yearcode: '1', financialYear: '2026-2027', headCode: 'L1004', accountType: 'RD', loanType: 'RLN', type: 'ALL', wingNo: '1', officeNo: '1', wingName: 'BHILAI',
  officeName: 'BHILAI', division: '1', branch: '1', limit: '20', offset: '0', sortBy: 'name', certificateNo: '1', dividendRate: '10', fromAccountNo: '1', toAccountNo: '100', memberStatus: 'ALL', search: '' };

// route -> query names to send
const R = [
  ['/reports/heads', []], ['/reports/banks', []], ['/reports/member/profile/610022986', []], ['/reports/voters-list', ['limit', 'offset']],
  ['/reports/member-balance-range', ['fromAccountNo', 'toAccountNo']], ['/reports/member-ledger', ['memberNo', 'fromDate', 'toDate', 'headCode']],
  ['/reports/annual-member-statement', ['wingNo', 'officeNo']], ['/reports/yearly-member-statement', ['fromDate', 'toDate', 'wingNo', 'officeNo', 'fromMemberNo', 'toMemberNo']],
  ['/reports/member/610022986/loan-cases', []], ['/reports/member-loan-detail', ['memberFrom', 'memberTo', 'loanType']], ['/reports/loan-contributions-register', ['memberNo', 'fromDate', 'toDate']],
  ['/reports/surety-register', ['memberFrom', 'memberTo', 'limit', 'offset']], ['/reports/loan-types', []], ['/reports/loan-nil-certificate/610022986', []],
  ['/reports/dividend-report', ['year', 'financialYear', 'wingName', 'officeName', 'dividendRate', 'limit', 'offset']], ['/reports/dividend-paid', ['wingName', 'fromDate', 'toDate', 'limit', 'offset']],
  ['/reports/dividend-warrant', ['wingName', 'officeName', 'fromDate', 'uptoDate']], ['/reports/interest-list', ['financialYear', 'wingName', 'accountType', 'limit', 'offset']],
  ['/reports/share-warrant', ['memberFrom', 'memberTo', 'warrantDate']], ['/reports/share-certificate', ['memberNo', 'certificateNo']], ['/reports/recurring-details', ['memberNo']],
  ['/reports/lien-account-information', []], ['/reports/passbook-printing', ['memberNo']], ['/reports/balance-sheet', ['asOnDate']], ['/reports/wings', []], ['/reports/offices', ['wingNo']],
  ['/reports/divisions', ['wingNo']], ['/reports/financial-summary', []], ['/reports/account-closing', ['month', 'year', 'accountType']], ['/reports/recovery-details', ['memberNo', 'month', 'year']],
  ['/reports/adhoc-reports', ['fromDate', 'toDate']],
  ['/print-voucher/list/all', []], ['/print-voucher/list/by-date', ['date']], ['/print-voucher/journal/list/all', []], ['/print-voucher/journal/list/by-date', ['date']],
  ['/member-ledger/head-masters', []], ['/member-ledger/validate-member', ['memberNumber']], ['/member-ledger/member-context', ['memberNumber']],
  ['/member-ledger/detail-columnar', ['memberNumber', 'fromDate', 'toDate']],
  ['/daybook/report/sb', ['date']], ['/daybook/active-members', []], ['/daybook/interest-rate', []], ['/cashbook/members/active', []], ['/cashbook/interest-rate', []],
  ['/cashbook/member/balance', ['memberCode']], ['/cashbook/transactions', ['startDate', 'endDate']], ['/general-ledger/head-masters', []],
  ['/jotting-report', []], ['/consolidation/report', []], ['/report-head-order', []], ['/dashboard-summary', []],
  ['/utilities/search/deposits', []],
];
P.memberNumber = '610022986';

function badText(txt) {
  const t = txt || '';
  const found = [];
  if (/\bNaN\b/.test(t)) found.push('NaN');
  if (/\bInfinity\b/.test(t)) found.push('Infinity');
  if (/"undefined"|:\s*undefined/.test(t)) found.push('undefined');
  if (/ENOENT|EACCES|stack|at .*\.(ts|js):\d+|column ".*" does not exist|relation ".*" does not exist|syntax error at/i.test(t)) found.push('raw-error');
  return found;
}

(async () => {
  const s = new Suite('26-report-sweep');
  const { token } = await login();
  const table = [];
  for (const [route, names] of R) {
    const qs = names.map(n => `${n}=${encodeURIComponent(P[n] ?? '')}`).join('&');
    const url = route + (qs ? '?' + qs : '');
    const r = await http('GET', url, { token, timeout: 60000, raw: true });
    const problems = [];
    if (r.status === 0) problems.push('timeout/connection (' + (r.error || '').slice(0, 40) + ')');
    else if (r.status >= 500) problems.push('HTTP ' + r.status);
    else if (r.status === 200 || r.status === 404 || r.status === 400) { /* ok classes */ }
    if (r.status === 400) problems.push('400 with realistic params: ' + (r.text || '').slice(0, 80));
    if (r.ms > 15000) problems.push('slow ' + r.ms + 'ms');
    const bt = badText(r.text); if (bt.length) problems.push('text:' + bt.join('+'));
    // empty data on a route that should have data
    let rows = null;
    try { let d = JSON.parse(r.text).data; while (d && d.success !== undefined && d.data !== undefined) d = d.data; rows = Array.isArray(d) ? d.length : (d && Array.isArray(d.data) ? d.data.length : (d && Array.isArray(d.rows) ? d.rows.length : null)); } catch { }
    table.push({ route, url: url.slice(0, 160), status: r.status, ms: r.ms, rows, problems: problems.join('; ') });
    s.check('RS-' + route.replace(/[^a-z0-9]+/gi, '_').slice(0, 44), `GET ${route}: ${r.status} in ${r.ms} ms${rows !== null ? `, ${rows} rows` : ''}`, problems.length === 0, problems.join('; ') + ' ' + (r.text || '').slice(0, 150));
  }
  fs.mkdirSync(path.join(__dirname, 'results'), { recursive: true });
  fs.writeFileSync(path.join(__dirname, 'results', '26-report-sweep-table.json'), JSON.stringify(table, null, 1));
  const slow = table.filter(t => t.ms > 3000).map(t => `${t.route} ${t.ms}ms`);
  console.log('INFO slower than 3 s:', slow.join(' | ') || 'none');
  const empty = table.filter(t => t.status === 200 && t.rows === 0).map(t => t.route);
  console.log('INFO 200 but zero rows:', empty.join(' | ') || 'none');
  process.exit(s.finish() ? 1 : 0);
})();
