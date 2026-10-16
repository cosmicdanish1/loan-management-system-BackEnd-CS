// Phase 1: authentication enforcement — every op without a token / with a garbage token
const L = require('./lib');
(async () => {
  const bad = [], skipped = [];
  const jobs = L.ops.filter(o => !/^\/auth\/(login|refresh|forgot|reset)/.test(o.path));
  await L.pool(jobs, 10, async (o) => {
    const mut = o.method !== 'GET';
    if (mut && L.DANGER.test(o.path)) { skipped.push(o.method + ' ' + o.path); return; }
    const p = L.fill(o, {}, '1');
    for (const [label, tok] of [['no-token', undefined], ['garbage-token', 'abc.def.ghi']]) {
      const r = await L.call(o.method, p, { token: tok, body: mut ? { __probe: 1 } : undefined });
      if (r.status !== 401) bad.push({ op: o.method + ' ' + o.path, label, status: r.status, ms: r.ms, snippet: r.text.slice(0, 120) });
    }
  });
  L.save('p1_auth.json', { bad, skipped });
  console.log('ops tested', jobs.length - skipped.length, 'skipped(dangerous mutating)', skipped.length, 'NOT-401:', bad.length);
  const g = {}; bad.forEach(b => (g[b.status] = (g[b.status] || 0) + 1)); console.log(g);
})();
