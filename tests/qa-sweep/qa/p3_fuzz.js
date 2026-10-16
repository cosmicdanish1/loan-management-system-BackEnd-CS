const L = require('./lib'); const sw = require('../swagger.json');
const LEAK = /QueryFailedError|at \w+.*\(.*\.(ts|js):\d+|syntax error at or near|relation ".*" does not exist|column ".*" does not exist|invalid input syntax|violates|duplicate key/i;
const deref = (s, d = 0) => { if (!s || d > 4) return s; if (s.$ref) { const n = s.$ref.split('/').pop(); return deref(sw.components.schemas[n], d + 1); } return s; };
function bodySchema(o) { const c = o.op.requestBody?.content?.['application/json']; return c ? deref(c.schema) : null; }
const SQLI = "'; DROP TABLE usermaster;--", XSS = '<img src=x onerror=alert(1)>', BIG = 'A'.repeat(20000);
function sample(s, kind) { // build a body for the schema with one mutation kind
  const out = {}; const props = s?.properties || {};
  for (const [k, v0] of Object.entries(props)) { const v = deref(v0); const t = v.type;
    let val;
    switch (kind) {
      case 'null': val = null; break;
      case 'swap': val = t === 'string' ? 12345 : t === 'number' || t === 'integer' ? 'abc' : t === 'boolean' ? 'yes' : t === 'array' ? 'x' : 'x'; break;
      case 'sqli': val = t === 'string' ? SQLI : (t === 'number' || t === 'integer') ? 1 : SQLI; break;
      case 'xss': val = t === 'string' ? XSS : 1; break;
      case 'big': val = t === 'string' ? BIG : (t === 'number' || t === 'integer') ? 1e308 : BIG; break;
      case 'neg': val = (t === 'number' || t === 'integer') ? -999999999 : t === 'string' ? '' : null; break;
      case 'nan': val = t === 'string' ? '\u0000\u202e' : (t === 'number' || t === 'integer') ? 9007199254740993 : []; break;
    } out[k] = val; }
  return out;
}
(async () => {
  const { token } = await L.login(); const findings = [], acc = []; let n = 0;
  const muts = L.ops.filter(o => o.method !== 'GET');
  const jobs = [];
  for (const o of muts) {
    const danger = L.DANGER.test(o.path); const s = bodySchema(o); const p = L.fill(o, {}, '987654321');
    if (o.method === 'DELETE') { jobs.push([o, p, 'delete-missing', undefined]); jobs.push([o, L.fill(o, {}, "abc"), 'delete-badid', undefined]); continue; }
    jobs.push([o, p, 'malformed-json', { raw: '{"a":' }]);
    jobs.push([o, p, 'array-body', danger ? null : { raw: '[1,2,3]' }]);
    if (danger) continue;
    jobs.push([o, p, 'empty-body', { body: {} }]);
    jobs.push([o, p, 'unknown-prop', { body: { __x: 1 } }]);
    jobs.push([o, p, 'wrong-ctype', { raw: 'a=b', headers: { 'Content-Type': 'text/plain' } }]);
    if (s?.properties) for (const k of ['null', 'swap', 'sqli', 'xss', 'big', 'neg', 'nan']) jobs.push([o, p, k, { body: sample(s, k) }]);
  }
  await L.pool(jobs.filter(j => j[3] !== null), +(process.env.CONC||8), async ([o, p, label, opt]) => {
    n++; const r = await L.call(o.method, p, { token, ...(opt || {}) });
    const leak = r.status >= 400 && LEAK.test(r.text);
    if (r.status >= 500 || r.status === 0 || r.ms > 5000 || leak) findings.push({ op: o.method + ' ' + o.path, label, status: r.status, ms: r.ms, leak, snippet: r.text.slice(0, 220) });
    else if (r.status < 300 && ['swap', 'big', 'neg', 'nan', 'xss', 'sqli', 'wrong-ctype', 'unknown-prop', 'delete-badid'].includes(label)) acc.push({ op: o.method + ' ' + o.path, label, status: r.status, snippet: r.text.slice(0, 160) });
  });
  L.save('p3_fuzz_serial.json', { sent: n, findings, accepted: acc });
  console.log('sent', n, 'findings', findings.length, 'accepted-invalid', acc.length);
})();
