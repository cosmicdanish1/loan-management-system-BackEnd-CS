const L = require('./lib'); const fs = require('fs');
const P = '/api/v1'; const out = {};
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
(async () => {
  const { token, refresh, raw } = await L.login();
  const [h, p, s] = token.split('.'); const pay = JSON.parse(Buffer.from(p, 'base64url').toString());
  out.jwt_claims = Object.keys(pay); out.jwt_ttl_hours = (pay.exp - pay.iat) / 3600;
  const probe = '/auth/me';
  const t = async (label, tok) => { const r = await L.call('GET', P + probe, { token: tok }); out['jwt_' + label] = r.status; };
  await t('valid', token);
  await t('tampered_role', h + '.' + b64({ ...pay, role: 'system', sub: 1 }) + '.' + s);
  await t('alg_none', b64({ alg: 'none', typ: 'JWT' }) + '.' + b64({ ...pay, sub: 1 }) + '.');
  await t('stripped_sig', h + '.' + p + '.');
  await t('expired_claim', h + '.' + b64({ ...pay, exp: 1 }) + '.' + s);
  // logout invalidates?
  const l2 = await L.login(); const lo = await L.call('POST', P + '/auth/logout', { token: l2.token, body: {} });
  const after = await L.call('GET', P + probe, { token: l2.token }); out.logout = { status: lo.status, token_after_logout: after.status };
  const rf = await L.call('POST', P + '/auth/refresh', { body: { refreshToken: l2.refresh } }); out.refresh_after_logout = rf.status;
  // refresh token reuse
  const l3 = await L.login(); const r1 = await L.call('POST', P + '/auth/refresh', { body: { refreshToken: l3.refresh } }); const r2 = await L.call('POST', P + '/auth/refresh', { body: { refreshToken: l3.refresh } }); out.refresh_reuse = [r1.status, r2.status];
  // access token used as refresh token
  const r3 = await L.call('POST', P + '/auth/refresh', { body: { refreshToken: token } }); out.access_as_refresh = r3.status;
  // privilege escalation: low-privilege user
  const uname = 'qa_clerk_' + (Date.now() % 100000); const pw = 'QaClerk@12345';
  const mk = await L.call('POST', P + '/admin/users', { token, body: { username: uname, email: uname + '@example.test', password: pw, firstName: 'QA', lastName: 'Clerk', role: 'clerk', isActive: true, permissions: [] } });
  const uid = mk.json?.data?.id ?? mk.json?.data?.data?.id; out.clerk_created = mk.status;
  if (uid) {
    const lg = await L.login(uname, pw); out.clerk_login = lg.raw.status;
    if (lg.token) {
      const tk = lg.token; const res = {};
      for (const [m, pth, b] of [['GET', '/admin/users'], ['POST', '/admin/users', { username: 'qa_esc', email: 'e@example.test', password: 'QaEsc@12345', firstName: 'a', lastName: 'b', role: 'administrator', isActive: true }], ['GET', '/admin/backup/list'], ['GET', '/admin/config/system'], ['GET', '/admin/roles'], ['PATCH', '/utilities/system-settings/qa_probe_key', { value: 'x' }], ['POST', '/admin/designations', { code: 'QAESC', name: 'esc', level: 1 }], ['GET', '/reports/balance-sheet?asOnDate=2026-10-15'], ['POST', '/utilities/business-rules', null], ['GET', '/admin/day-end/status']]) {
        if (b === null) { res[m + ' ' + pth] = 'skipped(destructive)'; continue; }
        const r = await L.call(m, P + pth, { token: tk, body: b }); res[m + ' ' + pth] = r.status;
        if (r.status < 300 && m === 'POST' && pth === '/admin/users') { const nid = r.json?.data?.id ?? r.json?.data?.data?.id; if (nid) await L.call('DELETE', P + '/admin/users/' + nid, { token }); }
        if (r.status < 300 && pth === '/admin/designations') await L.call('DELETE', P + '/admin/designations/QAESC', { token });
      }
      out.clerk_access = res;
    }
    await L.call('DELETE', P + '/admin/users/' + uid, { token });
  }
  // CORS + headers
  const cr = await fetch(L.BASE + P + '/health', { headers: { Origin: 'https://evil.example' } });
  out.cors_evil_origin = { acao: cr.headers.get('access-control-allow-origin'), acac: cr.headers.get('access-control-allow-credentials') };
  out.headers = Object.fromEntries(['x-powered-by', 'x-content-type-options', 'x-frame-options', 'strict-transport-security', 'content-security-policy', 'server'].map(k => [k, cr.headers.get(k)]));
  const pf = await fetch(L.BASE + P + '/auth/login', { method: 'OPTIONS', headers: { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'POST' } }); out.cors_preflight_evil = { status: pf.status, acao: pf.headers.get('access-control-allow-origin') };
  const sw = await fetch(L.BASE + '/api/docs'); out.swagger_ui_unauth = sw.status;
  // path traversal arbitrary file delete via backup delete (own harmless file)
  const target = 'F:/company/main project/backend/uploads/qa_traversal_probe.txt'; fs.writeFileSync(target, 'qa probe');
  const dt = await L.call('DELETE', P + '/admin/backup/' + encodeURIComponent('../uploads/qa_traversal_probe.txt'), { token });
  out.backup_delete_traversal = { status: dt.status, file_deleted: !fs.existsSync(target), msg: dt.text.slice(0, 120) };
  if (fs.existsSync(target)) fs.unlinkSync(target);
  // backup download/restore traversal (read-only probe)
  const dl = await L.call('GET', P + '/admin/backup/download/' + encodeURIComponent('../.env'), { token }); out.backup_download_traversal = { status: dl.status, leaked: /DB_PASSWORD|JWT_SECRET/.test(dl.text), msg: dl.text.slice(0, 100) };
  L.save('p6_sec.json', out); console.log(JSON.stringify(out, null, 1));
})();
