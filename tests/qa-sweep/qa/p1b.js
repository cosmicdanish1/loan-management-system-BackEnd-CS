const L = require('./lib');
(async () => {
  const sk = require('./p1_auth.json').skipped; const bad = [];
  await L.pool(sk, 8, async (s) => {
    const [m, ...pp] = s.split(' '); const o = L.ops.find(x => x.method === m && x.path === pp.join(' '));
    const r = await L.call(m, L.fill(o, {}, '1'), { token: undefined, body: { __probe: 1 } });
    if (r.status !== 401) bad.push({ op: s, status: r.status, snippet: r.text.slice(0, 100) });
  });
  console.log('non-401 among dangerous-skipped:', bad.length); console.log(bad);
})();
