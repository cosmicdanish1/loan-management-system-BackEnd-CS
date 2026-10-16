const fs = require('fs'), path = require('path');
const BASE = 'http://localhost:3001';
const OUT = __dirname;
const swagger = require(path.join(OUT, '..', 'swagger.json'));
const ops = [];
for (const [p, o] of Object.entries(swagger.paths)) for (const [m, d] of Object.entries(o))
  ops.push({ method: m.toUpperCase(), path: p, tag: (d.tags || ['-'])[0], params: d.parameters || [], hasBody: !!d.requestBody, summary: d.summary || '', op: d });
// routes that run real business jobs / destroy state: never fire mutating probes at these
const DANGER = /data-correction|trigger|send|notif|alert|heartbeat|onboarding|remove-dup|initialize|fix-|recalc|health.alerts|day-?end|restore|backup|clos(e|ing)|wipe|reset|truncate|migrat|generate|license|financial-year|dividend|disburs|approve|pass|reject|payment|post-|ledger-posting|import|sync|build-tree|consolidat|calculate|accrue|apply|run|execute|logout|2fa|password|users|roles|rights/i;
async function call(method, p, { token, body, headers = {}, raw, timeout = 30000 } = {}) {
  const t0 = Date.now();
  const h = { ...headers };
  if (token) h.Authorization = 'Bearer ' + token;
  let b;
  if (raw !== undefined) { b = raw; h['Content-Type'] = h['Content-Type'] || 'application/json'; }
  else if (body !== undefined) { b = JSON.stringify(body); h['Content-Type'] = 'application/json'; }
  try {
    const r = await fetch(BASE + p, { method, headers: h, body: b, signal: AbortSignal.timeout(timeout) });
    const txt = await r.text(); let j; try { j = JSON.parse(txt); } catch {}
    return { status: r.status, ms: Date.now() - t0, text: txt, json: j, headers: r.headers };
  } catch (e) { return { status: 0, ms: Date.now() - t0, text: String(e), error: e.name }; }
}
async function login(u = 'qa_admin', pw = 'QaAdmin@2026') {
  const r = await call('POST', '/api/v1/auth/login', { body: { username: u, password: pw } });
  const d = r.json?.data || r.json;
  return { token: d?.accessToken, refresh: d?.refreshToken, raw: r };
}
async function pool(items, n, fn) {
  const res = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const k = i++; res[k] = await fn(items[k], k); } }));
  return res;
}
const QDEF = { page: 1, limit: 10, pageSize: 10, fromDate: '2026-04-01', toDate: '2026-10-15', asOnDate: '2026-10-15', date: '2026-10-15', month: 10, year: 2026, financialYear: '2026-27', search: 'a', q: 'a', query: 'a' };
function fill(opx, vals, dflt) {
  let p = opx.path.replace(/\{(\w+)\}/g, (_, n) => encodeURIComponent(vals[n] ?? dflt));
  const q = [];
  for (const prm of opx.params) if (prm.in === 'query' && (prm.required || QDEF[prm.name] !== undefined)) q.push(prm.name + '=' + encodeURIComponent(vals[prm.name] ?? QDEF[prm.name] ?? 1));
  return p + (q.length ? '?' + q.join('&') : '');
}
const save = (name, data) => fs.writeFileSync(path.join(OUT, name), JSON.stringify(data, null, 1));
module.exports = { BASE, ops, DANGER, call, login, pool, fill, save, OUT };
