// Stress / concurrency suite. READ-ONLY traffic (GET + pure calculation POST) so no data can change.
// Ramp: 10 -> 50 -> 150 concurrent virtual users per endpoint set; reports p50/p95/max, error and 429 rates, then checks recovery.
const { http, login, Suite } = require('./lib');

function pct(a, p) { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(s.length * p))] : 0; }

async function load(name, fn, conc, total) {
  let i = 0; const lat = []; const codes = {};
  async function w() { while (i++ < total) { const r = await fn(); lat.push(r.ms); codes[r.status] = (codes[r.status] || 0) + 1; } }
  const t0 = Date.now();
  await Promise.all(Array.from({ length: conc }, w));
  const secs = (Date.now() - t0) / 1000;
  const row = { name, conc, total, rps: +(total / secs).toFixed(1), p50: pct(lat, .5), p95: pct(lat, .95), max: Math.max(...lat), codes };
  console.log(JSON.stringify(row));
  return row;
}

(async () => {
  const s = new Suite('05-stress');
  const { token } = await login();
  const g = (u) => () => http('GET', u, { token, timeout: 30000 });
  const rows = [];
  const targets = [
    ['health', () => http('GET', '/health', { timeout: 30000 })],
    ['auth/me', g('/auth/me')],
    ['loans/cases', g('/loans/cases?limit=20')],
    ['members/lookup', g('/members/lookup')],
    ['calc-emi', () => http('POST', '/loans/calculate-emi', { token, body: { principal: 100000, annualRate: 12, tenureMonths: 36 }, timeout: 30000 })],
    ['reports/balance-sheet', g('/reports/balance-sheet')],
  ];
  for (const conc of [10, 50, 150]) {
    for (const [n, fn] of targets) rows.push(await load(n, fn, conc, Math.max(60, conc * 3)));
  }
  const sx = rows.filter(r => Object.keys(r.codes).some(c => +c >= 500 || +c === 0));
  s.check('ST-01', 'No 5xx / connection failure at 10, 50, 150 concurrent users', sx.length === 0, sx.map(r => `${r.name}@${r.conc} ${JSON.stringify(r.codes)}`).join('; '));
  const slow = rows.filter(r => r.p95 > 3000);
  s.check('ST-02', 'p95 latency under 3 s for every endpoint set', slow.length === 0, slow.map(r => `${r.name}@${r.conc} p95=${r.p95}ms`).join('; '));
  const throttled = rows.filter(r => r.codes['429']);
  s.check('ST-03', 'Rate limiter engages under heavy load (429 seen)', throttled.length > 0, throttled.map(r => `${r.name}@${r.conc}: ${r.codes['429']}x429`).join('; ') || 'never throttled');

  // Login burst (bcrypt CPU): 25 concurrent valid logins
  const lb = await Promise.all(Array.from({ length: 25 }, () => login()));
  const lbOk = lb.filter(x => x.token).length;
  s.check('ST-04', '25 concurrent logins complete without 5xx', lb.every(x => x.res.status > 0 && x.res.status < 500), `ok=${lbOk}/25 statuses=${[...new Set(lb.map(x => x.res.status))]}`);

  // Payload abuse
  const big = await http('POST', '/loans/calculate-emi', { token, body: { principal: 1, annualRate: 1, tenureMonths: 1, junk: 'x'.repeat(4 * 1024 * 1024) } });
  s.check('ST-05', '4MB body accepted/rejected cleanly (no crash)', big.status > 0 && big.status < 500, big.status);
  const deep = await http('POST', '/loans/calculate-emi', { token, body: '{"a":'.repeat(5000) + '1' + '}'.repeat(5000), headers: { 'Content-Type': 'application/json' } });
  s.check('ST-06', 'Deeply nested (valid) JSON handled without crash', deep.status > 0 && deep.status < 500, deep.status);
  const slowloris = await Promise.all(Array.from({ length: 200 }, () => http('GET', '/health', { timeout: 20000 })));
  s.check('ST-07', '200 simultaneous /health calls all answered', slowloris.every(r => r.status === 200 || r.status === 429), `${[...new Set(slowloris.map(r => r.status))]}`);

  // Recovery
  const rec = await http('GET', '/health');
  const me = await http('GET', '/auth/me', { token });
  s.check('ST-08', 'Backend healthy and responsive after the full run', rec.status === 200 && me.status === 200 && rec.ms < 1000, `${rec.status}/${me.status} ${rec.ms}ms`);
  require('fs').writeFileSync(require('path').join(__dirname, 'results', '05-stress-load.json'), JSON.stringify(rows, null, 1));
  process.exit(s.finish() ? 1 : 0);
})();
