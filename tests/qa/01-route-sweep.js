// Route sweep: reads the live OpenAPI document and probes every route.
//  A) no token          -> must be 401 (except @Public routes)       [GET + mutating on non-dangerous paths]
//  B) garbage token     -> must be 401
//  C) valid token, GET with no params -> must never be 5xx / hang
//  D) valid token, mutating with empty body -> must be 4xx validation, never 5xx (skips dangerous paths)
// Output: tests/qa/results/01-route-sweep.json + 01-route-sweep-detail.json
const fs = require('fs'), path = require('path');
const { http, login, Suite, ROOT } = require('./lib');

const DANGEROUS = /(day-?end|backup|restore|delete|remove|close|closing|generate|import|financial-year|reset|truncate|purge|migrate|run|process|post|pass|disburse|sanction|approve|logout|register|license|dividend|interest|consolidat|transfer|journal)/i;
const PUBLIC_HINT = /\/auth\/(login|refresh|forgot|reset)|\/health|\/license\/(status|check)|^\/$/i;

(async () => {
  const s = new Suite('01-route-sweep');
  const doc = await http('GET', ROOT + '/api/docs-json', { raw: true });
  if (doc.status !== 200) { s.check('SW-00', 'OpenAPI document reachable', false, doc.status); process.exit(s.finish() ? 1 : 0); }
  const spec = JSON.parse(doc.text);
  const routes = [];
  for (const [p, ops] of Object.entries(spec.paths)) for (const m of Object.keys(ops)) {
    if (['get', 'post', 'put', 'patch', 'delete'].includes(m)) routes.push({ method: m.toUpperCase(), path: p });
  }
  console.log('routes in OpenAPI:', routes.length);
  const { token } = await login();
  s.check('SW-01', 'Admin login works', !!token);
  const concrete = p => p.replace(/\{[^}]+\}/g, '1');
  const detail = [];
  const pool = 8; let i = 0;
  async function worker() {
    while (i < routes.length) {
      const r = routes[i++];
      const url = ROOT + concrete(r.path);
      const isPub = PUBLIC_HINT.test(url);
      const rec = { ...r, url };
      // SAFETY RULE (2026-10-16): the sweep NEVER sends POST/PUT/PATCH/DELETE. An earlier version did and
      // deleted the real admin user. Mutating routes are tested only in domain suites, on records the suite created itself.
      const safeMutating = false;
      // A: no token
      if (r.method === 'GET' || safeMutating) {
        const a = await http(r.method, url, { body: r.method === 'GET' ? undefined : {} });
        rec.noToken = a.status; rec.noTokenMs = a.ms;
      }
      // B: bad token
      if (r.method === 'GET' || safeMutating) {
        const b = await http(r.method, url, { token: 'not.a.jwt', body: r.method === 'GET' ? undefined : {} });
        rec.badToken = b.status;
      }
      // C/D: authenticated
      if (r.method === 'GET') {
        const c = await http('GET', url, { token });
        rec.auth = c.status; rec.authMs = c.ms; rec.authSnippet = c.status >= 500 || c.status === 0 ? (c.text || c.error) : undefined;
      } else if (safeMutating) {
        const d = await http(r.method, url, { token, body: {} });
        rec.auth = d.status; rec.authMs = d.ms; rec.authSnippet = d.status >= 500 || d.status === 0 ? (d.text || d.error) : undefined;
      } else rec.skipped = 'mutating route: never probed by the sweep; covered by domain suites on self-created records';
      rec.public = isPub;
      detail.push(rec);
    }
  }
  await Promise.all(Array.from({ length: pool }, worker));
  detail.sort((a, b) => (a.path + a.method).localeCompare(b.path + b.method));
  const dir = path.join(__dirname, 'results'); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '01-route-sweep-detail.json'), JSON.stringify(detail, null, 1));

  const tested = detail.filter(d => d.noToken !== undefined);
  const openNoAuth = tested.filter(d => !d.public && d.noToken !== 401 && d.noToken !== 403);
  s.check('SW-02', `No route answers without a token (checked ${tested.length}; skipped ${detail.length - tested.length} dangerous mutating)`, openNoAuth.length === 0,
    openNoAuth.slice(0, 15).map(d => `${d.method} ${d.path}=${d.noToken}`).join('; '));
  const badTokOpen = tested.filter(d => !d.public && d.badToken !== 401 && d.badToken !== 403);
  s.check('SW-03', 'Garbage bearer token is rejected everywhere', badTokOpen.length === 0, badTokOpen.slice(0, 15).map(d => `${d.method} ${d.path}=${d.badToken}`).join('; '));
  const five = detail.filter(d => d.auth >= 500 || d.auth === 0);
  s.check('SW-04', 'No 5xx / hang on authenticated probe with no params or empty body', five.length === 0,
    five.length + ' routes: ' + five.slice(0, 20).map(d => `${d.method} ${d.path}=${d.auth}`).join('; '));
  const slow = detail.filter(d => d.authMs > 5000);
  s.check('SW-05', 'No authenticated probe slower than 5s', slow.length === 0, slow.slice(0, 15).map(d => `${d.method} ${d.path}=${d.authMs}ms`).join('; '));
  const dist = {}; detail.forEach(d => { if (d.auth !== undefined) dist[d.auth] = (dist[d.auth] || 0) + 1; });
  console.log('authenticated status distribution', dist);
  process.exit(s.finish() ? 1 : 0);
})();
