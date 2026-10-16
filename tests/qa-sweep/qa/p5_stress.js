const L = require('./lib');
const P = '/api/v1';
const out = {};
const pct = (a, p) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * p))]; };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function load(label, fn, conc, secs) {
  const lat = [], st = {}; const end = Date.now() + secs * 1000; let n = 0;
  await Promise.all(Array.from({ length: conc }, async () => { while (Date.now() < end) { const r = await fn(); n++; lat.push(r.ms); st[r.status] = (st[r.status] || 0) + 1; } }));
  const res = { conc, secs, requests: n, rps: +(n / secs).toFixed(1), p50: pct(lat, .5), p95: pct(lat, .95), p99: pct(lat, .99), max: Math.max(...lat), status: st };
  console.log(label, JSON.stringify(res)); out[label] = res; return res;
}
(async () => {
  const { token } = await L.login();
  const g = (p) => () => L.call('GET', P + p, { token, timeout: 60000 });
  // a. serial latency baseline
  const base = {};
  for (const p of ['/health', '/utilities/system-settings/x', '/dashboard-notices', '/members?limit=10', '/utilities/preferences', '/auth/me', '/utilities/head-master', '/reports/balance-sheet?asOnDate=2026-10-15', '/admin/day-end/status']) {
    const ls = []; let s; for (let i = 0; i < 5; i++) { const r = await L.call('GET', P + p, { token, timeout: 60000 }); ls.push(r.ms); s = r.status; }
    base[p] = { status: s, p50: pct(ls, .5), max: Math.max(...ls) };
  }
  console.log('baseline', JSON.stringify(base)); out.baseline = base;
  // b. ramps on a light endpoint
  for (const c of [10, 50, 100, 200]) await load('light_ramp_c' + c, g('/dashboard-notices'), c, 8);
  // c. pool starvation: slow report concurrent with health
  const slow = P + '/reports/balance-sheet?asOnDate=2026-10-15';
  const slowPromises = Array.from({ length: 30 }, () => L.call('GET', slow, { token, timeout: 90000 }));
  await sleep(1500);
  const probes = [];
  for (let i = 0; i < 10; i++) { probes.push(await L.call('GET', P + '/dashboard-notices', { token, timeout: 40000 })); await sleep(400); }
  const slowRes = await Promise.all(slowPromises);
  out.pool_starvation = { slow_status: slowRes.reduce((a, r) => (a[r.status] = (a[r.status] || 0) + 1, a), {}), slow_max_ms: Math.max(...slowRes.map(r => r.ms)), unrelated_probe_status: probes.map(r => r.status), unrelated_probe_ms: probes.map(r => r.ms), probe_errors: probes.filter(r => r.status >= 500 || r.status === 0).map(r => r.text.slice(0, 100)).slice(0, 2) };
  console.log('pool_starvation', JSON.stringify(out.pool_starvation));
  await sleep(15000);
  // d. payload abuse
  const big = (n) => ({ raw: JSON.stringify({ title: 'x'.repeat(n), message: 'm', type: 'info', postedBy: 'qa' }) });
  const pay = {};
  for (const [k, n] of [['1MB', 1e6], ['4.9MB', 4.9e6], ['6MB', 6e6], ['50MB', 5e7]]) { const r = await L.call('POST', P + '/client-logs', { token, ...big(n), timeout: 60000 }); pay[k] = { status: r.status, ms: r.ms, msg: r.text.slice(0, 90) }; }
  let nest = '{"a":'.repeat(5000) + '1' + '}'.repeat(5000); const rn = await L.call('POST', P + '/utilities/business-rules', { token, raw: nest }); pay.nested5000 = { status: rn.status, msg: rn.text.slice(0, 90) };
  const rq = await L.call('GET', P + '/dashboard-notices?' + 'a=1&'.repeat(20000), { token }); pay.hugeQuery = { status: rq.status, msg: rq.text.slice(0, 90) };
  const rh = await L.call('GET', P + '/health', { token, headers: { 'X-Big': 'y'.repeat(70000) } }); pay.hugeHeader = { status: rh.status, msg: rh.text.slice(0, 90) };
  out.payload = pay; console.log('payload', JSON.stringify(pay));
  // e. unauthenticated client-logs flood (public endpoint)
  const fl = await load('client_logs_unauth_flood', () => L.call('POST', P + '/client-logs', { body: { logs: [{ level: 'error', message: 'qa flood' }] } }), 30, 6);
  // f. rate limit: rapid health
  const rl = await load('rapid_health_c20', () => L.call('GET', P + '/health'), 20, 5);
  // g. login brute force on a fake user
  const mk = await L.call('POST', P + '/admin/users', { token, body: { username: 'qa_lock_' + (Date.now() % 100000), email: 'lock' + Date.now() + '@example.test', password: 'QaLock@12345', firstName: 'QA', lastName: 'Lock', role: 'clerk', isActive: true } });
  const uname = mk.json?.data?.username || mk.json?.data?.data?.username; const uid = mk.json?.data?.id || mk.json?.data?.data?.id;
  const bf = [];
  if (uname) { for (let i = 0; i < 40; i++) { const r = await L.call('POST', P + '/auth/login', { body: { username: uname, password: 'wrong' + i } }); bf.push(r.status); }
    const good = await L.call('POST', P + '/auth/login', { body: { username: uname, password: 'QaLock@12345' } }); out.bruteforce = { created: uname, statuses_summary: bf.reduce((a, s) => (a[s] = (a[s] || 0) + 1, a), {}), correct_pw_after_40_failures: good.status };
    if (uid) await L.call('DELETE', P + '/admin/users/' + uid, { token }); } else out.bruteforce = { error: 'user create failed ' + mk.status + ' ' + mk.text.slice(0, 150) };
  console.log('bruteforce', JSON.stringify(out.bruteforce));
  const sq = []; for (const u of ["admin' --", "' OR '1'='1", '"; DROP TABLE usermaster; --']) { const r = await L.call('POST', P + '/auth/login', { body: { username: u, password: u } }); sq.push(r.status); } out.login_sqli_statuses = sq; console.log('login_sqli', sq);
  // h. final health
  const h = await L.call('GET', P + '/health'); out.final_health = h.status; console.log('final health', h.status);
  L.save('p5_stress.json', out);
})();
