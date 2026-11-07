// Role-by-role rights check. Creates one temporary user per role (QA_ROLE_*), calls admin-only and rights-gated routes with harmless
// input (read calls, or writes that cannot change anything: unchanged business rules, unknown ids), prints the matrix, deletes only
// the users it created. The risky routes (day-end initiate, backup create, restore) are deliberately not called.
const { http, login, Suite } = require('./lib');
const fs = require('fs'), path = require('path');

(async () => {
  const s = new Suite('25-roles');
  const { token } = await login();
  const adm = (m, u, b) => http(m, u, { token, body: b, timeout: 60000 });
  const roles = ['manager', 'branch_manager', 'officer', 'passing_officer', 'clerk', 'auditor', 'cashier', 'accountant', 'loan_officer', 'data_operator', 'user'];
  const stamp = Date.now().toString().slice(-6);
  const pw = 'Tmp#Role' + stamp + 'x';
  const users = [];
  for (const r of roles) {
    const name = `QA_ROLE_${r}_${stamp}`.slice(0, 40);
    const c = await adm('POST', '/admin/users', { username: name, email: `${name.toLowerCase()}@bank.local`, password: pw, firstName: 'QA', lastName: r, role: r });
    const id = c.json && c.json.data && (c.json.data.id || c.json.data.userid);
    if (id) users.push({ role: r, name, id });
    else console.log('could not create role user', r, c.status, (c.text || '').slice(0, 100));
  }
  s.check('RL-00', `Created ${users.length} of ${roles.length} role users`, users.length === roles.length, users.map(u => u.role).join(','));

  const rules = (await adm('GET', '/utilities/business-rules')).json.data;
  const flat = (x) => { while (x && x.success !== undefined && x.data !== undefined) x = x.data; return x; };
  const rules0 = flat({ data: rules });
  // route table: [id, method, url, body, who must be refused (403) : 'nonadmin' = every role except administrator/system]
  const probes = [
    ['users-list', 'GET', '/admin/users', undefined],
    ['users-delete', 'DELETE', '/admin/users/99999999', undefined],
    ['register', 'POST', '/auth/register', {}],
    ['2fa-users', 'GET', '/auth/2fa/admin/users', undefined],
    ['alert-settings', 'GET', '/alert-settings', undefined],
    ['alert-write', 'PUT', '/alert-settings/no_such_key_zz', { enabled: true }],
    ['license-list', 'GET', '/license/list', undefined],
    ['day-end-summary', 'GET', '/admin/day-end/summary', undefined],
    ['backup-list', 'GET', '/backup/list', undefined],
    ['business-rules-write', 'POST', '/utilities/business-rules', rules0],
    ['role-rights', 'GET', '/admin/roles', undefined],
    ['pass-voucher', 'POST', '/transactions/pass/NOPE-VCH', {}],
    ['reverse-voucher', 'POST', '/transactions/reverse/NOPE-VCH', {}],
    ['early-closure', 'POST', '/loans/early-closure/execute/99999999', { mbno: '1' }],
  ];
  const adminSt = {};
  for (const [pid, m, url, body] of probes) adminSt[pid] = (await http(m, url, { token, body, timeout: 60000 })).status;
  console.log('administrator baseline', JSON.stringify(adminSt));
  const matrix = {};
  for (const u of users) {
    const lg = await login(u.name, pw);
    if (!lg.token) { s.check('RL-login-' + u.role, `Role user ${u.role} can log in`, false, lg.res.status); continue; }
    matrix[u.role] = {};
    for (const [pid, m, url, body] of probes) {
      const r = await http(m, url, { token: lg.token, body, timeout: 60000 });
      matrix[u.role][pid] = r.status;
    }
    const lv = await http('GET', '/auth/me', { token: lg.token });
    matrix[u.role]['_me'] = lv.status;
    await http('POST', '/auth/logout', { token: lg.token, body: {} });
  }
  console.log('\nROLE x ROUTE status matrix');
  console.log(['role'.padEnd(16), ...probes.map(p => p[0].slice(0, 9).padEnd(10))].join(''));
  for (const r of roles) if (matrix[r]) console.log([r.padEnd(16), ...probes.map(p => String(matrix[r][p[0]]).padEnd(10))].join(''));

  // admin-only expectations: a non-admin role must get 403 (not 2xx, not a validation/404 that proves the route ran)
  const adminOnly = ['users-list', 'users-delete', 'register', '2fa-users', 'alert-settings', 'alert-write', 'license-list', 'day-end-summary', 'backup-list', 'business-rules-write', 'role-rights'].filter(p => adminSt[p] !== 404);
  const gaps = [];
  for (const r of roles) for (const p of adminOnly) {
    const st = matrix[r] && matrix[r][p];
    if (st !== undefined && st !== 403) gaps.push(`${r}:${p}=${st}`);
  }
  s.check('RL-01', 'Administrator-only routes answer 403 for every non-administrator role', gaps.length === 0, `${gaps.length} open: ${gaps.slice(0, 30).join(' ')}`);
  const lowRoles = ['clerk', 'data_operator', 'user', 'cashier', 'auditor'];
  const passGap = lowRoles.filter(r => matrix[r] && matrix[r]['pass-voucher'] !== 403).map(r => `${r}=${matrix[r]['pass-voucher']}`);
  s.check('RL-02', 'Pass-voucher right: clerk, data operator, user, cashier and auditor get 403', passGap.length === 0, passGap.join(' '));
  const revGap = lowRoles.filter(r => matrix[r] && matrix[r]['reverse-voucher'] !== 403).map(r => `${r}=${matrix[r]['reverse-voucher']}`);
  s.check('RL-03', 'Reverse-voucher right: the same roles get 403', revGap.length === 0, revGap.join(' '));
  const ecGap = lowRoles.filter(r => matrix[r] && matrix[r]['early-closure'] !== 403).map(r => `${r}=${matrix[r]['early-closure']}`);
  s.check('RL-04', 'Early-closure right: the same roles get 403', ecGap.length === 0, ecGap.join(' '));
  const rulesNow = flat({ data: (await adm('GET', '/utilities/business-rules')).json.data });
  s.check('RL-05', 'Business rules are unchanged after the role probes (round-trip writes kept values)', Object.keys(rules0).every(k => String(rules0[k]) === String(rulesNow[k])), 'compared all keys');
  fs.mkdirSync(path.join(__dirname, 'results'), { recursive: true });
  fs.writeFileSync(path.join(__dirname, 'results', '25-roles-matrix.json'), JSON.stringify(matrix, null, 1));
  for (const u of users) await adm('DELETE', `/admin/users/${u.id}`);
  const left = (await adm('GET', '/admin/users?limit=500')).text || '';
  s.check('RL-CLEAN', 'Role users created by this suite were removed', !left.includes(`QA_ROLE_`) || !new RegExp(`QA_ROLE_[a-z_]+_${stamp}`).test(left), 'checked list');
  process.exit(s.finish() ? 1 : 0);
})();
