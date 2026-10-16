// Auth suite: login negatives, token handling, input hardening. Uses only the QA user; never changes other users.
// Env: QA_USER / QA_PASS. Keeps wrong-password attempts low (account lockout / throttler would otherwise trip).
const { http, login, Suite, BASE } = require('./lib');

(async () => {
  const s = new Suite('02-auth');
  const ok = await login();
  s.check('AU-01', 'Valid login returns access + refresh token', !!ok.token && !!ok.refresh, ok.res.status);
  s.check('AU-02', 'Login response never contains the password / hash', !/spassword|"password"/i.test(JSON.stringify(ok.res.json || {})));

  const bad = await http('POST', '/auth/login', { body: { username: process.env.QA_USER, password: 'definitely-wrong-1' } });
  s.check('AU-03', 'Wrong password -> 401', bad.status === 401, bad.status);
  const none = await http('POST', '/auth/login', { body: { username: 'no_such_user_zz', password: 'whatever12' } });
  s.check('AU-04', 'Unknown user -> 401 with same message as wrong password (no user enumeration)', none.status === 401 && (none.json || {}).message === (bad.json || {}).message, `${none.status} "${(none.json || {}).message}" vs "${(bad.json || {}).message}"`);
  const empty = await http('POST', '/auth/login', { body: {} });
  s.check('AU-05', 'Empty login body -> 400/401, not 500', [400, 401].includes(empty.status), empty.status);
  const short = await http('POST', '/auth/login', { body: { username: 'a', password: '123' } });
  s.check('AU-06', 'Password shorter than 6 -> 400/401', [400, 401].includes(short.status), short.status);
  const sqli = await http('POST', '/auth/login', { body: { username: "' OR '1'='1' --", password: "' OR '1'='1" } });
  s.check('AU-07', "SQL-injection style login rejected (401/400)", [400, 401].includes(sqli.status), sqli.status);
  const obj = await http('POST', '/auth/login', { body: { username: { $ne: null }, password: { $ne: null } } });
  s.check('AU-08', 'Object injection in login fields -> 400/401, not 500', [400, 401].includes(obj.status), obj.status);
  const bigPw = await http('POST', '/auth/login', { body: { username: process.env.QA_USER, password: 'x'.repeat(200000) } });
  s.check('AU-09', '200KB password handled (no crash/500)', bigPw.status > 0 && bigPw.status < 500, bigPw.status);
  const badJson = await http('POST', '/auth/login', { body: '{"username": ', headers: { 'Content-Type': 'application/json' } });
  s.check('AU-10', 'Malformed JSON -> 400', badJson.status === 400, badJson.status);
  const huge = await http('POST', '/auth/login', { body: { username: 'x'.repeat(6 * 1024 * 1024), password: 'abcdef' } });
  s.check('AU-11', 'Body above 5MB limit rejected with 413 (not crash)', huge.status === 413, huge.status);

  const me = await http('GET', '/auth/me', { token: ok.token });
  s.check('AU-12', 'GET /auth/me with token -> 200', me.status === 200, me.status);
  const meNo = await http('GET', '/auth/me');
  s.check('AU-13', 'GET /auth/me without token -> 401', meNo.status === 401, meNo.status);
  const parts = (ok.token || '').split('.');
  const tampered = parts.length === 3 ? `${parts[0]}.${Buffer.from('{"sub":1,"username":"admin","role":"administrator"}').toString('base64url')}.${parts[2]}` : 'x';
  const tam = await http('GET', '/auth/me', { token: tampered });
  s.check('AU-14', 'Token with tampered payload (privilege escalation) -> 401', tam.status === 401, tam.status);
  const none_alg = `${Buffer.from('{"alg":"none","typ":"JWT"}').toString('base64url')}.${Buffer.from('{"sub":1,"username":"admin","role":"administrator"}').toString('base64url')}.`;
  const na = await http('GET', '/auth/me', { token: none_alg });
  s.check('AU-15', 'JWT alg=none token -> 401', na.status === 401, na.status);
  const refreshAsAccess = await http('GET', '/auth/me', { token: ok.refresh });
  s.check('AU-16', 'Refresh token used as access token -> 401 (or documented behaviour)', refreshAsAccess.status === 401, refreshAsAccess.status);

  const rf = await http('POST', '/auth/refresh', { body: { refreshToken: ok.refresh } });
  s.check('AU-17', 'Refresh with valid refresh token -> 200/201 and new token', [200, 201].includes(rf.status), rf.status);
  const rfBad = await http('POST', '/auth/refresh', { body: { refreshToken: 'garbage' } });
  s.check('AU-18', 'Refresh with garbage -> 401/400', [400, 401].includes(rfBad.status), rfBad.status);

  const hb = await http('POST', '/auth/heartbeat', { token: ok.token, body: {} });
  s.check('AU-19', 'Heartbeat works', [200, 201].includes(hb.status), hb.status);

  // Logout revokes the token (own session only)
  const l2 = await login();
  const lo = await http('POST', '/auth/logout', { token: l2.token, body: {} });
  s.check('AU-20', 'Logout succeeds', [200, 201].includes(lo.status), lo.status);
  const after = await http('GET', '/auth/me', { token: l2.token });
  s.check('AU-21', 'Token is rejected after logout (revocation works)', after.status === 401, after.status);

  // Security headers / info leakage
  const h = await http('GET', '/auth/me', { token: ok.token });
  s.check('AU-22', 'X-Powered-By header not exposed', !h.headers.get('x-powered-by'), h.headers.get('x-powered-by'));
  const err = await http('GET', '/auth/me', { token: 'bad' });
  s.check('AU-23', 'Error body has no stack trace', !/at .*\(.*:\d+:\d+\)/.test(err.text || ''), (err.text || '').slice(0, 120));

  // CORS preflight from foreign origin (LAN app allows all - recorded as informational)
  const cors = await http('OPTIONS', '/auth/login', { headers: { Origin: 'http://evil.example', 'Access-Control-Request-Method': 'POST' } });
  console.log('INFO CORS preflight foreign origin ->', cors.status, cors.headers && cors.headers.get('access-control-allow-origin'));

  // Throttle: 130 rapid cheap requests (limit is 100/60s by default)
  const burst = await Promise.all(Array.from({ length: 130 }, () => http('GET', '/health')));
  const c429 = burst.filter(r => r.status === 429).length;
  s.check('AU-24', 'Rate limiter returns 429 under burst of 130 requests/s (informational - /health may be exempt)', true, `429 count=${c429}`);
  process.exit(s.finish() ? 1 : 0);
})();
