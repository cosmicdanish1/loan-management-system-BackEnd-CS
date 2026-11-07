// Communication Hub (/notifications) and Notification Centre (/notification-centre). No messaging channel is configured on this server
// (channel-status all false), so nothing can be delivered; recipients used are invalid on purpose (.invalid / 0000000000).
// Cancels only messages this suite queued. Env: QA_USER / QA_PASS.
const { http, login, Suite } = require('./lib');
const { Client } = require('pg');
require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });
const d = (r) => { let x = r.json && r.json.data; while (x && x.success !== undefined && x.data !== undefined) x = x.data; return x; };

(async () => {
  const s = new Suite('20-notifications');
  const { token } = await login();
  const call = (m, u, b) => http(m, u, { token, body: b, timeout: 120000 });
  const pg = new Client({ host: process.env.DB_HOST, port: process.env.DB_PORT, user: process.env.DB_USERNAME, password: process.env.DB_PASSWORD, database: process.env.DB_DATABASE });
  await pg.connect();
  const rows = async (sql, p) => (await pg.query(sql, p)).rows;
  const qa = (await rows(`select mbno from member_master where f_name='QATEST' order by mbno desc limit 1`))[0].mbno;
  const cnt = async () => Number((await rows(`select count(*) c from notification_logs`))[0].c);

  const cs = d(await call('GET', '/notifications/channel-status'));
  s.check('NT-01', 'Channel status reports email/sms/whatsapp flags', cs && ['email', 'sms', 'whatsapp'].every(k => typeof cs[k] === 'boolean'), JSON.stringify(cs));
  const st = d(await call('GET', '/notifications/stats'));
  const dbPending = Number((await rows(`select count(*) c from notification_logs where status='PENDING'`))[0].c);
  s.check('NT-02', 'Stats pending count equals the notification_logs table', st && Number(st.totalPending) === dbPending, `API ${st && st.totalPending} vs DB ${dbPending}`);
  for (const [id, u] of [['NT-03', '/notifications/history?limit=5'], ['NT-04', '/notifications/history?limit=-5'], ['NT-05', '/notifications/history?limit=abc'], ['NT-06', '/notifications/history?limit=99999999']]) {
    const r = await call('GET', u);
    s.check(id, `GET ${u} handled (no 5xx, answers < 5 s)`, r.status > 0 && r.status < 500 && r.ms < 5000, `${r.status} ${r.ms}ms ${(r.text || '').slice(0, 80)}`);
  }

  // ---- manual messages
  const mk = (o = {}) => ({ memberNo: String(qa), channel: 'EMAIL', message: 'QA test message - ignore', recipient: 'qa-test@example.invalid', ...o });
  const c0 = await cnt();
  for (const [id, t, o] of [['NT-07', 'channel PIGEON', { channel: 'PIGEON' }], ['NT-08', 'empty message', { message: '' }], ['NT-09', 'message of 100,000 characters', { message: 'M'.repeat(100000) }], ['NT-10', 'invalid e-mail address', { recipient: 'not-an-email' }], ['NT-11', 'SMS to a phone with letters', { channel: 'SMS', recipient: 'abc' }], ['NT-12', 'member that does not exist', { memberNo: '1999999999' }], ['NT-13', 'missing recipient', { recipient: undefined }], ['NT-14', 'text member number', { memberNo: 'abc' }]]) {
    const r = await call('POST', '/notifications/send-manual', mk(o));
    s.check(id, `Send manual with ${t}: refused 4xx (no 5xx)`, r.status >= 400 && r.status < 500, `${r.status} ${(r.text || '').slice(0, 100)}`);
  }
  const c1 = await cnt();
  s.check('NT-15', 'Refused sends left no rows in notification_logs', c1 === c0, `${c0} -> ${c1}`);
  const ok = await call('POST', '/notifications/send-manual', mk());
  const okRow = (await rows(`select id,status,"errorMessage" from notification_logs where mbno::text=$1 and message like 'QA test message%' order by id desc limit 1`, [String(qa)]).catch(() => rows(`select * from notification_logs order by id desc limit 1`)))[0];
  s.check('NT-16', 'Valid manual e-mail with no channel configured ends FAILED/PENDING with a clear reason (no 5xx, no false SENT)', ok.status < 500 && ok.status > 0 && okRow && okRow.status !== 'SENT', `${ok.status} ${(ok.text || '').slice(0, 140)} | row ${JSON.stringify(okRow)}`);
  const q = await call('POST', '/notifications/queue-manual', mk({ message: 'QA queue-only test - ignore' }));
  const qRow = (await rows(`select * from notification_logs order by id desc limit 1`))[0];
  s.check('NT-17', "'queue-manual' only queues; it must not attempt to send (same code path as send-manual?)", q.status < 500 && qRow && qRow.status === 'PENDING', `${q.status}; newest row status ${qRow && qRow.status} error ${qRow && qRow.errorMessage}`);
  const mine = (await rows(`select id from notification_logs where message like 'QA %test%' order by id desc limit 5`)).map(r => Number(r.id));
  const one = await call('POST', `/notifications/send-one/${mine[0] || 0}`, {});
  s.check('NT-18', 'send-one on a QA message ends without 5xx', one.status > 0 && one.status < 500, `${one.status} ${(one.text || '').slice(0, 120)}`);
  const none = await call('POST', '/notifications/send-one/99999999', {});
  s.check('NT-19', 'send-one for an id that does not exist -> 404', none.status === 404, `${none.status}`);
  const txt = await call('POST', '/notifications/send-one/abc', {});
  s.check('NT-20', 'send-one with a text id -> 400', txt.status === 400, `${txt.status}`);
  for (const [id, b] of [['NT-21', {}], ['NT-22', { ids: [] }], ['NT-23', { ids: ['a', 'b'] }], ['NT-24', { ids: [99999999] }]]) {
    const r = await call('POST', '/notifications/send-batch', b);
    s.check(id, `send-batch with ${JSON.stringify(b)}: 4xx or a clear per-id result (no 5xx)`, r.status > 0 && r.status < 500, `${r.status} ${(r.text || '').slice(0, 100)}`);
  }
  const cb = await call('POST', '/notifications/cancel-batch', { ids: mine });
  s.check('NT-25', 'cancel-batch cancels the QA messages this suite queued', cb.status > 0 && cb.status < 300, `${cb.status} ${(cb.text || '').slice(0, 120)}`);
  const cb2 = await call('POST', '/notifications/cancel-batch', { ids: [99999999] });
  s.check('NT-26', 'cancel-batch of ids that do not exist is harmless', cb2.status > 0 && cb2.status < 500, cb2.status);

  // ---- transaction alerts
  for (const [id, b] of [['NT-27', {}], ['NT-28', { memberNo: String(qa), transactionType: 'RECEIPT', amount: 'abc' }], ['NT-29', { memberNo: String(qa), transactionType: 'RECEIPT', amount: -500 }], ['NT-30', { memberNo: '1999999999', transactionType: 'RECEIPT', amount: 500 }]]) {
    const before = await cnt();
    const r = await call('POST', '/notifications/queue-transaction-alert', b);
    const after = await cnt();
    s.check(id, `Transaction alert with ${JSON.stringify(b).slice(0, 60)}: refused 4xx and nothing queued`, r.status >= 400 && r.status < 500 && before === after, `${r.status}; rows ${before} -> ${after}`);
  }
  const noRec = Number((await rows(`select count(*) c from notification_logs where status='PENDING' and (recipient is null or recipient='')`))[0].c);
  s.check('NT-31', 'No PENDING message is queued without a recipient (it can never be delivered)', noRec === 0, `${noRec} pending messages have an empty recipient (e.g. automatic transaction alerts for QA vouchers)`);

  // ---- bulk triggers: run once, run again, check for duplicates (queue only, nothing is sent)
  const pb = await cnt();
  const e1 = await call('POST', '/notifications/trigger-emi-check', {});
  const p1 = await cnt();
  const e2 = await call('POST', '/notifications/trigger-emi-check', {});
  const p2 = await cnt();
  s.check('NT-32', `EMI alert trigger works (queued ${p1 - pb})`, e1.status > 0 && e1.status < 300, `${e1.status} ${(e1.text || '').slice(0, 100)}`);
  s.check('NT-33', 'Running the EMI alert trigger a second time does not queue the same alerts again', p2 === p1, `rows ${pb} -> ${p1} -> ${p2}`);
  const m1 = await call('POST', '/notifications/trigger-maturity-check', {});
  s.check('NT-34', 'Maturity alert trigger works without 5xx', m1.status > 0 && m1.status < 500, `${m1.status} ${(m1.text || '').slice(0, 100)}`);
  const dupMsgs = await rows(`select mbno, message, count(*) c from notification_logs where status='PENDING' group by 1,2 having count(*)>1 limit 5`);
  s.check('NT-35', 'No identical PENDING message is queued twice for the same member', dupMsgs.length === 0, JSON.stringify(dupMsgs).slice(0, 200));

  // ---- notification centre
  for (const [id, u] of [['NT-36', '/notification-centre/list?limit=5&offset=0'], ['NT-37', '/notification-centre/list?limit=-1'], ['NT-38', '/notification-centre/list?limit=100000'], ['NT-39', '/notification-centre/list?offset=-10'], ['NT-40', '/notification-centre/list?severity=bogus'], ['NT-41', '/notification-centre/list?kind=%27%3B%20DROP%20TABLE%20x%3B--']]) {
    const r = await call('GET', u);
    s.check(id, `GET ${u}: handled (no 5xx, < 5 s)`, r.status > 0 && r.status < 500 && r.ms < 5000, `${r.status} ${r.ms}ms ${(r.text || '').slice(0, 80)}`);
  }
  const sum = d(await call('GET', '/notification-centre/summary'));
  const tot = Number((await rows(`select count(*) c from system_notifications where status is distinct from 'RESOLVED'`).catch(() => [{ c: NaN }]))[0].c);
  console.log('INFO summary open', sum && sum.open, 'db open-ish', tot);
  const lst = d(await call('GET', '/notification-centre/list?limit=3'));
  const first = lst && lst.rows && lst.rows[0];
  if (first) {
    const rd = await call('POST', `/notification-centre/${first.id}/read`, {});
    const un = await call('POST', `/notification-centre/${first.id}/unread`, {});
    s.check('NT-42', 'Mark one notification read, then unread (own user only)', rd.status < 300 && un.status < 300, `${rd.status}/${un.status}`);
  }
  const bad = await call('POST', '/notification-centre/99999999/read', {});
  s.check('NT-43', 'Mark a notification that does not exist as read -> 404', bad.status === 404, bad.status);
  const bad2 = await call('POST', '/notification-centre/abc/read', {});
  s.check('NT-44', 'Mark a notification with a text id as read -> 400', bad2.status === 400, bad2.status);
  const sy1 = await call('POST', '/notification-centre/sync', {});
  const n1 = Number((await rows(`select count(*) c from system_notifications`))[0].c);
  const sy2 = await call('POST', '/notification-centre/sync', {});
  const n2 = Number((await rows(`select count(*) c from system_notifications`))[0].c);
  s.check('NT-45', `Notification sync is repeatable: second run adds no duplicates (${n1} -> ${n2})`, sy1.status < 300 && sy2.status < 300 && n2 === n1, `${sy1.status}/${sy2.status}`);
  const t0 = Date.now(); const par = await Promise.all([call('POST', '/notification-centre/sync', {}), call('POST', '/notification-centre/sync', {}), call('POST', '/notification-centre/sync', {})]);
  const n3 = Number((await rows(`select count(*) c from system_notifications`))[0].c);
  s.check('NT-46', 'Three simultaneous syncs do not create duplicate notifications or 5xx', par.every(r => r.status < 500) && n3 === n2, `${par.map(r => r.status)}; ${n2} -> ${n3}`);
  await pg.end();
  process.exit(s.finish() ? 1 : 0);
})();
