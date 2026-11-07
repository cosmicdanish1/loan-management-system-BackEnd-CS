// Support desk suite (split from 17). Creates exactly ONE QA support query (Jira SPT + Telegram) - labelled QA.
const { http, login, Suite } = require('./lib');
(async () => {
  const s = new Suite('18-support');
  const { token } = await login();
  const call = (m, u, b, t = 120000) => http(m, u, { token, body: b, timeout: t });
  // ---------------- support desk
  const sq = (o = {}) => ({ queryType: 'QUESTION', subject: 'QA TEST - ignore this ticket', description: 'Automated QA test of the support desk. Please ignore and close.', module: 'QA', priority: 'LOW', route: '/qa', appVersion: '1.7.0', clientInfo: 'qa-suite', ...o });
  for (const [id, t, b] of [['SD-01', 'subject too short', sq({ subject: 'hey' })], ['SD-02', 'description too short', sq({ description: 'short' })], ['SD-03', 'unknown priority', sq({ priority: 'URGENT!!' })], ['SD-04', 'unknown type', sq({ queryType: 'RANT' })], ['SD-05', 'subject over 200 characters', sq({ subject: 'S'.repeat(201) })], ['SD-06', 'description over 5000 characters', sq({ description: 'D'.repeat(5001) })], ['SD-07', 'extra unknown field', { ...sq(), admin: true }]]) {
    const r = await call('POST', '/support-queries', b);
    s.check(id, `Support query with ${t}: 400`, r.status === 400, `${r.status} ${(r.text || '').slice(0, 100)}`);
  }
  const ok = await call('POST', '/support-queries', sq());
  const q = ok.json && ok.json.data;
  s.check('SD-08', 'Valid support query is saved (one QA ticket)', [200, 201].includes(ok.status) && !!(q && (q.id || q.queryId || q.ticketNo)), `${ok.status} ${(ok.text || '').slice(0, 260)}`);
  const id = q && (q.id || q.queryId);
  console.log('INFO support query', JSON.stringify(q).slice(0, 300));
  const mine = await call('GET', '/support-queries/mine');
  s.check('SD-09', 'My queries list shows it', mine.status === 200 && JSON.stringify(mine.json).includes('QA TEST'), mine.status);
  if (id) {
    const one = await call('GET', `/support-queries/${id}`);
    s.check('SD-10', 'Query detail loads', one.status === 200, one.status);
    s.check('SD-11', 'Jira/Telegram delivery is recorded on the query (jira key or status)', /jira|SPT-|SENT|telegram|status/i.test(JSON.stringify(one.json)), JSON.stringify(one.json && one.json.data).slice(0, 300));
    const other = await call('GET', '/support-queries/99999999');
    s.check('SD-12', 'Unknown query id -> 404', other.status === 404, other.status);
  }
  const all = await call('GET', '/support-queries/admin/all');
  s.check('SD-14', 'Admin list loads', all.status === 200, all.status);
  process.exit(s.finish() ? 1 : 0);
})();
