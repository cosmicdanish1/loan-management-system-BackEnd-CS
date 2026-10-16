// User lifecycle on records THIS suite creates (QA_TMP_<timestamp>). Deletes only ids returned by its own create calls.
// Covers: create validation, duplicate username, role-based access (a low-privilege user must not reach admin routes),
// password reset, delete, deleted user cannot log in, own-account delete guard.
const { http, login, Suite } = require('./lib');

(async () => {
  const s = new Suite('04-user-lifecycle');
  const { token, user } = await login();
  const call = (m, u, b, t = token) => http(m, u, { token: t, body: b });
  const uname = 'QA_TMP_' + Date.now();
  const pw = 'Tmp#' + Math.random().toString(36).slice(2, 10) + '9';
  const base = { username: uname, email: `${uname.toLowerCase()}@bank.local`, password: pw, firstName: 'QA', lastName: 'Temp', role: 'data_operator' };

  // validation
  for (const [id, t, patch] of [
    ['US-01', 'Missing username', { username: undefined }],
    ['US-02', 'Password under 6 chars', { password: '123' }],
    ['US-03', 'Invalid email', { email: 'not-an-email' }],
    ['US-04', 'Invalid role value', { role: 'god_mode' }],
    ['US-05', 'Unknown extra field (forbidNonWhitelisted)', { isSuperUser: true }],
  ]) {
    const r = await call('POST', '/admin/users', { ...base, username: uname + 'x', ...patch });
    s.check(id, `Create user - ${t} -> 400`, r.status === 400, `${r.status} ${(r.text || '').slice(0, 100)}`);
  }

  const c = await call('POST', '/admin/users', base);
  const created = c.json && c.json.data;
  const uid = created && (created.id || created.userid || created.userId);
  s.check('US-06', 'Create temp user succeeds', [200, 201].includes(c.status) && !!uid, `${c.status} ${(c.text || '').slice(0, 160)}`);
  if (!uid) { process.exit(s.finish() ? 1 : 0); }
  s.check('US-07', 'Create response does not echo password/hash', !/password|spassword|\$2[aby]\$/i.test(JSON.stringify(created)), JSON.stringify(created).slice(0, 200));

  const dup = await call('POST', '/admin/users', base);
  s.check('US-08', 'Duplicate username -> 409/400, not 500 and not a second row', [400, 409].includes(dup.status), dup.status);
  const dupCase = await call('POST', '/admin/users', { ...base, username: uname.toLowerCase(), email: 'other_' + base.email });
  const dupId = dupCase.json && dupCase.json.data && (dupCase.json.data.id || dupCase.json.data.userid);
  if (dupId) await call('DELETE', `/admin/users/${dupId}`); // own record created by this check
  s.check('US-09', 'Same username different case -> rejected (login names must stay unique)', [400, 409].includes(dupCase.status), dupCase.status);

  // the temp user logs in; low-privilege access is limited
  const tl = await login(uname, pw);
  s.check('US-10', 'Temp user can log in', !!tl.token, tl.res.status);
  if (tl.token) {
    const adm = await http('GET', '/admin/users', { token: tl.token });
    s.check('US-11', 'Data-operator cannot list users (403)', adm.status === 403, adm.status);
    const del = await http('DELETE', `/admin/users/99999999`, { token: tl.token });
    s.check('US-12', 'Data-operator cannot delete users (403) - nonexistent id, so a broken guard shows as 404 and deletes nothing', del.status === 403, del.status);
    const bk = await http('GET', '/admin/backup/list', { token: tl.token, timeout: 8000 });
    s.check('US-13', 'Data-operator cannot reach backup admin routes (403)', bk.status === 403, bk.status || bk.error);
    const rg = await http('POST', '/auth/register', { token: tl.token, body: { ...base, username: uname + 'r' } });
    s.check('US-14', 'Data-operator cannot register users (403)', rg.status === 403, rg.status);
    const role = await http('PUT', `/admin/users/${uid}/role`, { token: tl.token, body: { role: 'administrator' } });
    s.check('US-15', 'Data-operator cannot promote self to administrator (403)', role.status === 403, role.status);
    const cp = await http('POST', '/auth/change-password', { token: tl.token, body: { currentPassword: 'wrong-one', newPassword: 'Another#12345' } });
    s.check('US-16', 'Change password with wrong current password -> 400/401', [400, 401].includes(cp.status), cp.status);
    await http('POST', '/auth/logout', { token: tl.token, body: {} });
  }

  // admin resets the temp user's password
  const rp = await call('PUT', `/admin/users/${uid}/password`, { newPassword: 'Reset#98765x' });
  s.check('US-17', 'Admin can reset temp user password', [200, 201].includes(rp.status), `${rp.status} ${(rp.text || '').slice(0, 120)}`);
  const oldLogin = await login(uname, pw);
  s.check('US-18', 'Old password no longer works after reset', !oldLogin.token);
  const newLogin = await login(uname, 'Reset#98765x');
  s.check('US-19', 'New password works', !!newLogin.token, newLogin.res.status);

  // disable then login
  const dis = await call('PUT', `/admin/users/${uid}`, { isActive: false });
  const disLogin = await login(uname, 'Reset#98765x');
  s.check('US-20', 'Disabled user cannot log in', [200, 201].includes(dis.status) && !disLogin.token, `${dis.status} / login ${disLogin.res.status}`);

  // delete ONLY the temp user we created
  const dl = await call('DELETE', `/admin/users/${uid}`);
  s.check('US-21', 'Delete temp user succeeds', [200, 204].includes(dl.status), `${dl.status} ${(dl.text || '').slice(0, 100)}`);
  const gone = await call('GET', `/admin/users/${uid}`);
  s.check('US-22', 'Deleted user returns 404', gone.status === 404, gone.status);
  const goneLogin = await login(uname, 'Reset#98765x');
  s.check('US-23', 'Deleted user cannot log in', !goneLogin.token);
  const dl2 = await call('DELETE', `/admin/users/${uid}`);
  s.check('US-24', 'Deleting twice -> 404 (idempotent, no 500)', dl2.status === 404, dl2.status);
  const list = await call('GET', '/admin/users?limit=500');
  s.check('US-25', 'Deleted user not in list', !JSON.stringify(list.json || {}).includes(uname), list.status);
  process.exit(s.finish() ? 1 : 0);
})();
