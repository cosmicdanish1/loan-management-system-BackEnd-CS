const L = require('./lib');
const VALS = { memberNo: '130031157', mbno: '130031157', memberNumber: '130031157', mbNo: '130031157', loanCaseNo: '73785', loanType: 'ALN', accountNumber: '10002', accNo: '10002', acc_no: '10002', id: '1' };
const HOSTILE = ["abc", "-1", "0", "99999999999999999999999", "' OR '1'='1", "1;DROP TABLE x;--", "%00", "../../etc/passwd", "<script>alert(1)</script>", "1".repeat(3000)];
const LEAK = /QueryFailedError|at \w+.*\(.*\.(ts|js):\d+|syntax error at or near|relation ".*" does not exist|column ".*" does not exist|invalid input syntax|stack/i;
(async () => {
  const { token } = await L.login();
  const gets = L.ops.filter(o => o.method === 'GET');
  const findings = [], summary = { total: 0, byStatus: {} };
  const rec = (o, label, p, r) => {
    summary.total++; summary.byStatus[r.status] = (summary.byStatus[r.status] || 0) + 1;
    const leak = LEAK.test(r.text) && r.status >= 400;
    if (r.status >= 500 || r.status === 0 || r.ms > 3000 || leak) findings.push({ op: 'GET ' + o.path, label, url: p.slice(0, 160), status: r.status, ms: r.ms, leak, snippet: r.text.slice(0, 220) });
  };
  await L.pool(gets, 8, async (o) => {
    const p = L.fill(o, VALS, '1'); rec(o, 'valid', p, await L.call('GET', p, { token }));
  });
  console.log('valid pass done', JSON.stringify(summary));
  const hjobs = [];
  for (const o of gets) { if (!/\{\w+\}/.test(o.path) && !o.params.some(x => x.in === 'query')) continue; for (const h of HOSTILE) hjobs.push([o, h]); }
  await L.pool(hjobs, 8, async ([o, h]) => {
    const vals = {}; for (const prm of o.params) vals[prm.name] = h;
    for (const m of o.path.matchAll(/\{(\w+)\}/g)) vals[m[1]] = h;
    const p = L.fill(o, vals, h); rec(o, 'hostile:' + h.slice(0, 20), p, await L.call('GET', p, { token }));
  });
  L.save('p2_get.json', { summary, findings });
  console.log(JSON.stringify(summary)); console.log('findings', findings.length);
})();
