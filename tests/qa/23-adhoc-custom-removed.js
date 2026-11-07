// ES-361: the 'custom' ad-hoc SQL report type must be gone; the other ad-hoc report types must still answer.
const { http, login, Suite } = require('./lib');
(async () => {
  const s = new Suite('23-adhoc-custom-removed');
  const { token } = await login();
  const get = (u) => http('GET', u, { token, timeout: 120000 });
  const q = (sql) => encodeURIComponent(sql);
  for (const [id, t, sql] of [
    ['AH-1', 'a count on usermaster', 'SELECT count(*) AS n FROM usermaster'],
    ['AH-2', 'credential columns', 'SELECT susername, spassword FROM usermaster LIMIT 1'],
    ['AH-3', 'a harmless SELECT 1', 'SELECT 1'],
    ['AH-4', 'a query in lower case', 'select * from member_master limit 1'],
    ['AH-5', 'a stacked statement', 'SELECT 1; SELECT 2'],
    ['AH-6', 'a comment trick', 'SELECT/**/1'],
  ]) {
    const r = await get(`/reports/adhoc-reports?reportType=custom&customQuery=${q(sql)}`);
    s.check(id, `custom report with ${t} -> 400 'not supported' and no data returned`, r.status === 400 && /not supported/i.test(r.text || '') && !(r.json && r.json.data && Array.isArray(r.json.data.data)), `${r.status} ${(r.text || '').slice(0, 120)}`);
  }
  const none = await get('/reports/adhoc-reports?reportType=custom');
  s.check('AH-7', 'custom report with no query -> 400', none.status === 400, none.status);
  const bad = await get('/reports/adhoc-reports?reportType=nonsense');
  s.check('AH-8', 'An unknown report type is still 400', bad.status === 400 && /Unsupported report type/.test(bad.text || ''), `${bad.status} ${(bad.text || '').slice(0, 90)}`);
  for (const t of ['member_wise', 'loan_summary', 'deposit_summary', 'transaction_summary', 'monthly_collection']) {
    const r = await get(`/reports/adhoc-reports?reportType=${t}&fromDate=2026-09-01&toDate=2026-09-30`);
    console.log('INFO', t, r.status, (r.text || '').slice(0, 70));
  }
  const known = await get('/reports/adhoc-reports?reportType=member_wise&fromDate=2026-09-01&toDate=2026-09-30');
  s.check('AH-9', 'A built-in report type (member_wise) is not affected: 200 or a clear 4xx, never 500 from this change', known.status === 200 || (known.status >= 400 && known.status < 500), `${known.status} ${(known.text || '').slice(0, 90)}`);
  process.exit(s.finish() ? 1 : 0);
})();
